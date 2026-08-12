/**
 * BaileysAdapter — the ONLY file that imports Baileys.
 *
 * IMPORTANT: This uses WhatsApp Web's QR auth (via Baileys), NOT the official
 * Meta WhatsApp Business API. WhatsApp can change behavior or block accounts
 * that exhibit spammy patterns. We mitigate this with:
 *   - per-account FIFO send queue (concurrency=1)
 *   - randomized human-like delays between sends
 *   - typing presence before text
 *   - daily send caps
 *   - cold-start ignore window
 *   - never reply to status/broadcast or (by default) groups
 */
import {
  default as makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  type WASocket,
  type proto,
} from '@whiskeysockets/baileys';
import { decryptPollVote } from '@whiskeysockets/baileys/lib/Utils/process-message.js';
import QRCode from 'qrcode';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { EventEmitter } from 'node:events';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { prisma } from '../../lib/prisma.js';
import { AudioTranscodeService } from '../../services/AudioTranscodeService.js';
import {
  isBroadcastJid,
  isGroupJid,
  isUserJid,
  phoneFromJid,
} from '../../lib/jid.js';
import { pickBrowser, parseStored, stringify, type BrowserTuple } from '../../lib/browserPool.js';
import type {
  AccountStatus,
  IncomingMessage,
  OutgoingMedia,
} from './types.js';

type Session = {
  accountId: string;
  sessionPath: string;
  socket?: WASocket;
  status: AccountStatus;
  reconnectAttempts: number;
  reconnectTimer?: NodeJS.Timeout;
  /** Timestamps of the last N close events — used by the circuit breaker
   *  to detect rapid disconnect storms (which look "spammy" to WhatsApp). */
  recentDisconnects: number[];
  /** When set, we pause reconnects until this time (ms epoch). */
  circuitOpenUntil?: number;
  startedAt: number;
  destroyed: boolean;
  browser: BrowserTuple;
  proxyUrl: string | null;
};

/**
 * WA protocol version resolver.
 *
 * IMPORTANT: WhatsApp's noise handshake expects Baileys' protocol-version
 * format `[2, 3000, X]`. WhatsApp keeps bumping `X`, so any hardcoded build
 * goes stale fast. We fetch the latest from the Baileys repo directly via
 * GitHub raw (bypasses Baileys' built-in fetcher, which is unreliable from
 * many networks / has a deep timeout we can't tune).
 *
 *   1. GitHub raw `baileys-version.json` (3 s budget) — authoritative, fresh.
 *   2. Baileys' own `fetchLatestBaileysVersion` (3 s) — bonus path.
 *   3. Hardcoded fallback (only if both above fail). Updated whenever we
 *      observe a newer one in production.
 */
const HARDCODED_FALLBACK_VERSION: [number, number, number] = [2, 3000, 1035194821];

const BAILEYS_VERSION_URL =
  'https://raw.githubusercontent.com/WhiskeySockets/Baileys/master/src/Defaults/baileys-version.json';

async function fetchVersionFromGithub(timeoutMs: number): Promise<[number, number, number]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(BAILEYS_VERSION_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`http_${res.status}`);
    const data = (await res.json()) as { version?: [number, number, number] };
    if (!Array.isArray(data.version) || data.version.length !== 3) {
      throw new Error('bad_payload');
    }
    return data.version;
  } finally {
    clearTimeout(t);
  }
}

async function getBaileysBundledVersion(timeoutMs: number): Promise<[number, number, number]> {
  const fetched = await Promise.race([
    fetchLatestBaileysVersion(),
    new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error('baileys-fetch-timeout')), timeoutMs)
    ),
  ]);
  return (fetched as { version: [number, number, number] }).version;
}

/** Compare WA versions [major, minor, patch] — returns true if `a` is newer. */
function isNewer(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

async function resolveWaVersion(accountId: string): Promise<[number, number, number]> {
  // Tier 1 — GitHub raw (fastest, freshest). When networks block this (DNS
  // NXDOMAIN, captive portals, ISP rate-limit) we silently move on.
  try {
    const v = await fetchVersionFromGithub(3000);
    logger.info({ accountId, version: v, source: 'github-raw' }, 'baileys: version resolved');
    return v;
  } catch (e) {
    logger.warn({ accountId, err: (e as Error).message }, 'baileys: tier-1 (github-raw) failed, trying Baileys bundled');
  }
  // Tier 2 — Baileys' OWN bundled `fetchLatestBaileysVersion`. CAUTION: this
  // can return a version frozen at the time the npm package was installed,
  // which WhatsApp may now reject. Only accept it if it's NEWER than our
  // hardcoded fallback; otherwise prefer the hardcoded value.
  try {
    const v = await getBaileysBundledVersion(3000);
    if (isNewer(v, HARDCODED_FALLBACK_VERSION)) {
      logger.info({ accountId, version: v, source: 'baileys-bundled' }, 'baileys: version resolved');
      return v;
    }
    logger.warn(
      { accountId, bundled: v, hardcoded: HARDCODED_FALLBACK_VERSION },
      'baileys: bundled version is older than hardcoded fallback — using hardcoded'
    );
  } catch (e) {
    logger.warn(
      { accountId, err: (e as Error).message },
      'baileys: tier-2 (bundled) failed'
    );
  }
  // Tier 3 — hardcoded (newest version we know to work)
  logger.info({ accountId, version: HARDCODED_FALLBACK_VERSION, source: 'hardcoded' }, 'baileys: version resolved');
  return HARDCODED_FALLBACK_VERSION;
}

class WhatsAppAdapter extends EventEmitter {
  private sessions = new Map<string, Session>();
  private silentLogger = pino({ level: process.env.BAILEYS_LOG_LEVEL ?? 'silent' });

  /** Start a session. Idempotent: if already running, no-op. */
  async start(accountId: string): Promise<void> {
    let s = this.sessions.get(accountId);
    if (s && !s.destroyed && s.socket) return;

    const sessionPath = path.join(env.SESSIONS_DIR, accountId);
    fs.mkdirSync(sessionPath, { recursive: true });

    // Resolve persisted browser identity (or assign one and persist)
    const account = await prisma.whatsAppAccount.findUnique({ where: { id: accountId } });
    let browser = parseStored(account?.browserIdentity);
    if (!browser) {
      browser = pickBrowser();
      await prisma.whatsAppAccount.update({
        where: { id: accountId },
        data: { browserIdentity: stringify(browser) },
      }).catch(() => {});
    }
    const proxyUrl = account?.proxyUrl ?? null;

    s = {
      accountId,
      sessionPath,
      status: 'connecting',
      reconnectAttempts: 0,
      recentDisconnects: [],
      startedAt: Date.now(),
      destroyed: false,
      browser,
      proxyUrl,
    };
    this.sessions.set(accountId, s);
    this.emitStatus(s, 'connecting');

    logger.info({ accountId, sessionPath, browser, proxy: !!proxyUrl }, 'starting WA session');

    // Diagnostic: warn if neither QR nor connected fires within 8s of start
    const sStart = s;
    setTimeout(() => {
      const cur = this.sessions.get(accountId);
      if (!cur || cur !== sStart) return;
      if (cur.status === 'connecting') {
        logger.warn({ accountId }, 'WA session: 8s without QR or connected — likely stale creds or WA rejection');
      }
    }, 8200);

    await this.connect(s);
  }

  private async connect(s: Session): Promise<void> {
    if (s.destroyed) return;
    try {
      logger.info({ accountId: s.accountId }, 'baileys: loading auth state');
      const { state, saveCreds } = await useMultiFileAuthState(s.sessionPath);

      // Three-tier version resolution. WhatsApp REJECTS old versions, so we must
      // ship something current. The Baileys-bundled fetch is unreliable from this
      // network (frequent timeouts), so we prefer the official WA Web check-update
      // endpoint and treat Baileys as a bonus.
      const version = await resolveWaVersion(s.accountId);

      // Optional per-account proxy (anti-ban / IP isolation)
      const agent = s.proxyUrl ? new HttpsProxyAgent(s.proxyUrl) : undefined;

      const sock = makeWASocket({
        ...(version ? { version } : {}),
        auth: state,
        logger: this.silentLogger as any,
        printQRInTerminal: false,
        browser: s.browser,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        // Signal retransmit callback. When a recipient's WhatsApp can't decrypt
        // one of our messages (missing session, out-of-order delivery, @lid
        // bootstrap timing), it shows «En attente…» and asks us to retransmit.
        // Baileys calls this to fetch the original plaintext.
        getMessage: (key: any) => this.lookupSentMessage(key),
        ...(agent ? { agent: agent as any, fetchAgent: agent as any } : {}),
      });

      s.socket = sock;

      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('connection.update', async (u) => {
        try {
        const { connection, lastDisconnect, qr } = u;

        if (qr) {
          try {
            const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
            logger.info({ accountId: s.accountId }, 'QR generated, awaiting scan');
            this.emit('qr', s.accountId, dataUrl);
            this.emitStatus(s, 'qr_required');
          } catch (e) {
            logger.error({ err: e }, 'qr render failed');
          }
        }

        if (connection === 'open') {
          s.reconnectAttempts = 0;
          const phone = sock.user?.id ? phoneFromJid(sock.user.id) : null;
          this.emitStatus(s, 'connected', { phoneNumber: phone });
          // Best-effort platform detection — Baileys sets this from the device
          // pairing handshake. 'smbi'/'smba' = WhatsApp Business (iOS/Android),
          // 'iphone'/'android' = Personal. Surfaces in the UI so operators know
          // why chat labels may not appear on the phone (Business-only feature).
          const platform: string | null = (sock.authState as any)?.creds?.platform ?? null;
          const isBusiness = !!platform && /^smb/i.test(platform);
          logger.info({ accountId: s.accountId, platform, isBusiness }, 'baileys: platform detected on connect');
          await prisma.whatsAppAccount.update({
            where: { id: s.accountId },
            data: { platform, isBusiness },
          }).catch((e) => logger.warn({ err: e, accountId: s.accountId }, 'persisting platform failed'));
        }

        if (connection === 'close') {
          const errAny = lastDisconnect?.error as any;
          const code = errAny?.output?.statusCode ?? errAny?.statusCode;
          const loggedOut = code === DisconnectReason.loggedOut;
          const rawMsg = (lastDisconnect?.error as Error | undefined)?.message ?? null;
          const errMsg = rawMsg === 'Connection Failure'
            ? 'Connection Failure (likely WhatsApp IP rate-limit — wait 30-60min, or set a proxy URL in Advanced settings)'
            : rawMsg;

          // detach all listeners on the dead socket
          try { sock.ev.removeAllListeners('messages.upsert'); } catch {}
          try { sock.ev.removeAllListeners('connection.update'); } catch {}
          try { sock.ev.removeAllListeners('creds.update'); } catch {}
          try { sock.ev.removeAllListeners('call'); } catch {}
          s.socket = undefined;

          // Always clear any pending reconnect timer — we'll decide below.
          if (s.reconnectTimer) { clearTimeout(s.reconnectTimer); s.reconnectTimer = undefined; }

          if (loggedOut || s.destroyed) {
            this.emitStatus(s, 'disconnected', { lastError: errMsg });
            this.sessions.delete(s.accountId);
            return;
          }

          // ─── Circuit breaker ────────────────────────────────────────────
          // WhatsApp interprets rapid disconnect→reconnect storms as spammy
          // bot behaviour and may block the account. If we see 5 closes in
          // the last 60 s, pause reconnection for 5 minutes. This is the
          // single most-important anti-ban guard for this surface.
          const now = Date.now();
          s.recentDisconnects.push(now);
          s.recentDisconnects = s.recentDisconnects.filter((t) => now - t < 60_000);

          let delay: number;
          if (s.recentDisconnects.length >= 5) {
            const cooldown = 5 * 60_000;
            s.circuitOpenUntil = now + cooldown;
            delay = cooldown + Math.floor(Math.random() * 10_000); // 5-5:10 min
            s.recentDisconnects = []; // reset so we don't immediately re-trip
            logger.warn({ accountId: s.accountId, delayMs: delay },
                        'circuit breaker tripped — pausing reconnects for 5 min to avoid WA ban');
          } else {
            // Exponential backoff with jitter (full-jitter algorithm).
            s.reconnectAttempts++;
            const base = Math.min(60_000, 2_000 * 2 ** Math.min(s.reconnectAttempts, 5));
            delay = Math.floor(base / 2 + Math.random() * (base / 2));
          }

          this.emitStatus(s, 'connecting', { lastError: errMsg });
          s.reconnectTimer = setTimeout(() => this.connect(s).catch((e) => {
            logger.error({ err: e, accountId: s.accountId }, 'reconnect failed');
          }), delay);
        }
        } catch (e: any) {
          // Any error inside the handler is swallowed here so that a bad WA
          // event never poisons future events (Baileys emits many per second).
          logger.error(
            { err: e?.message ?? e, stack: e?.stack, accountId: s.accountId },
            'connection.update handler threw — event dropped, session continues',
          );
        }
      });

      // Incoming voice/video calls. We only react to the initial offer; later
      // status changes (ringing/timeout/terminate) are ignored.
      sock.ev.on('call', (calls) => {
        for (const c of calls) {
          if (c.status !== 'offer') continue;
          logger.info({
            accountId: s.accountId,
            from: c.from,
            isVideo: !!c.isVideo,
            callId: c.id,
          }, 'baileys: incoming call offer');
          this.emit('call', {
            accountId: s.accountId,
            callId: c.id,
            from: c.from,
            isVideo: !!c.isVideo,
            isGroup: !!c.isGroup,
          });
        }
      });

      sock.ev.on('messages.upsert', async ({ messages, type }) => {
        logger.info({ accountId: s.accountId, type, count: messages.length },
                    'baileys: messages.upsert received');
        if (type !== 'notify') return;
        for (const m of messages) {
          try {
            // Poll vote? Decrypt with our stored mapping and synthesize a
            // text="opt_<number>" incoming so existing matchOption picks it up.
            const pollUpdate = m.message?.pollUpdateMessage;
            if (pollUpdate?.pollCreationMessageKey?.id) {
              const synth = await this.handlePollVote(s.accountId, m, pollUpdate);
              if (synth) {
                logger.info({ accountId: s.accountId, optId: synth.text }, 'baileys: poll vote decoded');
                this.emit('message', synth);
                continue;
              }
            }

            const norm = this.normalizeIncoming(s.accountId, m);
            if (!norm) {
              logger.info({
                accountId: s.accountId,
                remoteJid: m.key?.remoteJid,
                fromMe: m.key?.fromMe,
                isBroadcast: !!m.key?.remoteJid?.endsWith('@broadcast'),
              }, 'baileys: incoming dropped by normalizeIncoming');
              continue;
            }
            this.emit('message', norm);
          } catch (e) {
            logger.error({ err: e }, 'normalize incoming failed');
          }
        }
      });
    } catch (e) {
      logger.error({ err: e, accountId: s.accountId }, 'connect failed');
      this.emitStatus(s, 'error', { lastError: (e as Error).message });
    }
  }

  /**
   * Decode a pollUpdateMessage. Looks up the encKey + option list we stored
   * when we sent the poll, decrypts the vote, then matches the SHA256 of the
   * chosen option text back to one of our options. Returns a synthetic
   * IncomingMessage with text=`opt_<number>` so the engine's matchOption
   * routes it as a button tap.
   */
  private async handlePollVote(
    accountId: string,
    m: proto.IWebMessageInfo,
    pollUpdate: proto.Message.IPollUpdateMessage,
  ): Promise<IncomingMessage | null> {
    if (!m.key?.id || !m.key.remoteJid) return null;
    if (m.key.fromMe) return null;
    const pollMsgId = pollUpdate.pollCreationMessageKey?.id;
    const vote = pollUpdate.vote;
    if (!pollMsgId || !vote?.encPayload || !vote?.encIv) return null;

    const mapping = await prisma.pollMapping.findUnique({ where: { pollMsgId } });
    if (!mapping || mapping.accountId !== accountId) return null;

    const voterJid = m.key.participant ?? m.key.remoteJid;
    let voteMsg: any;
    try {
      voteMsg = decryptPollVote(
        { encPayload: vote.encPayload, encIv: vote.encIv },
        {
          pollCreatorJid: mapping.creatorJid,
          pollMsgId,
          pollEncKey: mapping.encKey,
          voterJid,
        },
      );
    } catch (e) {
      logger.warn({ err: e, pollMsgId }, 'poll vote decrypt failed');
      return null;
    }

    const selectedHashes: Buffer[] = (voteMsg?.selectedOptions ?? []).map((b: Uint8Array) => Buffer.from(b));
    if (!selectedHashes.length) return null;

    const options: { number: string; label: string }[] = JSON.parse(mapping.optionsJson);
    // The vote payload contains SHA256 hashes of the original poll-value strings.
    // We rebuild each hash from our saved options and match.
    let chosen: { number: string; label: string } | undefined;
    for (const o of options) {
      const value = `${o.number} - ${o.label}`.slice(0, 100);
      const h = crypto.createHash('sha256').update(value).digest();
      if (selectedHashes.some((s) => s.equals(h))) { chosen = o; break; }
    }
    if (!chosen) return null;

    return {
      accountId,
      waMessageId: m.key.id,
      fromJid: m.key.remoteJid,
      fromMe: false,
      isGroup: m.key.remoteJid.endsWith('@g.us'),
      pushName: m.pushName ?? undefined,
      text: `opt_${chosen.number}`,
      timestamp: Number(m.messageTimestamp ?? Date.now() / 1000),
      rawKey: {
        id: m.key.id,
        remoteJid: m.key.remoteJid,
        fromMe: false,
        participant: m.key.participant ?? undefined,
      },
    };
  }

  private normalizeIncoming(accountId: string, m: proto.IWebMessageInfo): IncomingMessage | null {
    if (!m.key?.id || !m.key.remoteJid) return null;
    const jid = m.key.remoteJid;
    if (isBroadcastJid(jid)) return null;
    const isGroup = isGroupJid(jid);
    if (!isGroup && !isUserJid(jid)) return null;

    const text =
      m.message?.conversation ??
      m.message?.extendedTextMessage?.text ??
      m.message?.imageMessage?.caption ??
      m.message?.videoMessage?.caption ??
      m.message?.buttonsResponseMessage?.selectedButtonId ??
      m.message?.listResponseMessage?.singleSelectReply?.selectedRowId ??
      undefined;

    // Detect the original media kind so the engine can mirror voice→voice and
    // persist the right Message.type. Audio detection is the load-bearing
    // case (replyMode='auto' relies on it).
    const kind: IncomingMessage['kind'] =
      m.message?.audioMessage    ? 'audio'    :
      m.message?.imageMessage    ? 'image'    :
      m.message?.videoMessage    ? 'video'    :
      m.message?.documentMessage ? 'document' :
      m.message?.stickerMessage  ? 'sticker'  :
                                   'text';

    // Baileys extends WAMessageKey with senderPn / participantPn — the
    // phone-number-bearing JID that stands behind a privacy `@lid` routing jid.
    // Only meaningful when `remoteJid` is an @lid; otherwise the routing jid
    // already carries the real phone and we leave phoneJid undefined.
    const rawKey = m.key as any;
    const senderPn: string | undefined = rawKey?.senderPn ?? rawKey?.participantPn ?? undefined;
    const phoneJid = jid.endsWith('@lid') && senderPn && senderPn.endsWith('@s.whatsapp.net')
      ? senderPn
      : undefined;

    return {
      accountId,
      waMessageId: m.key.id,
      fromJid: jid,
      phoneJid,
      fromMe: !!m.key.fromMe,
      isGroup,
      pushName: m.pushName ?? undefined,
      text: text ?? undefined,
      timestamp: Number(m.messageTimestamp ?? Date.now() / 1000),
      rawKey: {
        id: m.key.id,
        remoteJid: jid,
        fromMe: !!m.key.fromMe,
        participant: m.key.participant ?? undefined,
      },
      kind,
      // Attach the raw proto only when we'll need to download bytes downstream
      // (audio for STT, image/video/document for future media intake). Text
      // messages don't need it — keep the payload light.
      rawMsg: kind === 'text' ? undefined : m,
    };
  }

  /**
   * Wraps every `sock.sendMessage` so transient WA errors surface with a
   * normalized message that MessageQueueService can pattern-match on (e.g.
   * "rate-limit" → set 1h cooldown). Without this, raw error strings like
   * "Connection Closed" leak into status fields.
   */
  private async safeSend<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e: any) {
      const msg = (e?.message ?? '').toLowerCase();
      // Mark socket dead so the next call re-issues requireSock fail-fast.
      if (/connection closed|connection lost|stream errored/i.test(msg)) {
        const s = this.sessions.get(accountId);
        if (s) s.socket = undefined;
      }
      throw e;
    }
  }

  /** Send a plain text message. Returns the WA message id. */
  async sendText(accountId: string, jid: string, text: string): Promise<string | undefined> {
    const sock = this.requireSock(accountId);
    const res = await this.safeSend(accountId, () => sock.sendMessage(jid, { text }));
    return res?.key?.id ?? undefined;
  }

  /**
   * Send a buttons message (max 3 quick-reply buttons). Each tapped button
   * arrives as a buttonsResponseMessage with selectedButtonId — we use ids of
   * the form `opt_<number>` so the matcher can route directly.
   *
   * NOTE: WhatsApp officially deprecated buttonsMessage for non-Business-API
   * senders in 2023. Modern WhatsApp clients (esp. iOS) may render this as
   * plain text instead of buttons. Caller is expected to fall back to
   * numbered text when interactive rendering isn't desired.
   */
  async sendButtons(
    accountId: string,
    jid: string,
    text: string,
    options: { number: string; label: string }[],
  ): Promise<string | undefined> {
    const sock = this.requireSock(accountId);
    const buttons = options.slice(0, 3).map((o) => ({
      buttonId: `opt_${o.number}`,
      buttonText: { displayText: `${o.number} - ${o.label}`.slice(0, 30) },
      type: 1,
    }));
    const res = await this.safeSend(accountId, () => sock.sendMessage(jid, {
      text,
      buttons,
      headerType: 1,
    } as any));
    return res?.key?.id ?? undefined;
  }

  /**
   * Send a list message (sections of selectable rows). Same rendering caveat
   * as sendButtons — modern WhatsApp may downgrade to plain text. List can
   * fit more than 3 options (no hard cap).
   */
  async sendList(
    accountId: string,
    jid: string,
    text: string,
    options: { number: string; label: string }[],
  ): Promise<string | undefined> {
    const sock = this.requireSock(accountId);
    const sections = [{
      title: 'الخيارات',
      rows: options.map((o) => ({
        title: `${o.number} - ${o.label}`.slice(0, 24),
        rowId: `opt_${o.number}`,
        description: '',
      })),
    }];
    const res = await this.safeSend(accountId, () => sock.sendMessage(jid, {
      text,
      footer: '',
      title: '',
      buttonText: 'اختر',
      sections,
    } as any));
    return res?.key?.id ?? undefined;
  }

  /**
   * Send a poll. This is the most reliable interactive message format Baileys
   * supports for non-Business-API senders — it renders as a real tappable card
   * on EVERY modern WhatsApp version (iOS, Android, Web, Business).
   *
   * Poll votes arrive encrypted; we save the random encKey + the option list
   * in the PollMapping table so we can decrypt the vote later (in the
   * messages.upsert handler) and route it back to the matcher as `opt_<number>`.
   */
  async sendPoll(
    accountId: string,
    jid: string,
    header: string,
    options: { number: string; label: string }[],
  ): Promise<string | undefined> {
    const sock = this.requireSock(accountId);
    const encKey = crypto.randomBytes(32);
    const values = options.map((o) => `${o.number} - ${o.label}`.slice(0, 100));
    const res = await this.safeSend(accountId, () => sock.sendMessage(jid, {
      poll: {
        name: header || 'اختر',
        values,
        selectableCount: 1,
        messageSecret: encKey,
      },
    }));
    const pollMsgId = res?.key?.id;
    const creatorJid = sock.user?.id ?? '';
    if (pollMsgId) {
      await prisma.pollMapping.create({
        data: {
          pollMsgId,
          accountId,
          creatorJid,
          encKey,
          optionsJson: JSON.stringify(options),
        },
      }).catch(() => {});
    }
    return pollMsgId ?? undefined;
  }

  /** Send a media file (audio/image/video/document). */
  async sendMedia(accountId: string, jid: string, m: OutgoingMedia): Promise<string | undefined> {
    const sock = this.requireSock(accountId);
    // Async read avoids blocking the event loop on multi-MB videos.
    const buf = await fs.promises.readFile(m.filePath);
    let payload: any;
    switch (m.type) {
      case 'image':
        payload = { image: buf, mimetype: m.mimeType, caption: m.caption };
        break;
      case 'video':
        payload = { video: buf, mimetype: m.mimeType, caption: m.caption };
        break;
      case 'audio': {
        // Root-cause fix for "audios silently missing from welcome burst":
        //   WhatsApp Web + Baileys queues submit non-PTT M4A / MP3 audio
        //   attachments to the server, then the server DOESN'T reliably
        //   deliver them to the mobile client in a fresh session — even
        //   though our DB shows status=sent. Videos in the same burst
        //   survive because MP4 video attachments are first-class.
        //
        //   The only combination WhatsApp delivers AND plays natively is
        //   real opus bytes + audio/ogg;codecs=opus mimetype + ptt:true.
        //   We transcode M4A/MP3 → opus/ogg via ffmpeg (application=voip,
        //   24 kbps VBR, mono, 48kHz — same format WA's own recorder emits)
        //   and cache the result next to the source, so subsequent sends
        //   are free.
        //
        //   We pass `seconds` explicitly (parsed from ffmpeg stderr) so
        //   mobile clients render the duration correctly (0:00 = won't
        //   play). We do NOT pass a synthetic waveform — every value we
        //   tried made WhatsApp mobile refuse to decode with "problème
        //   avec le fichier audio". Absent waveform → client draws flat
        //   bar, audio plays fine.
        //
        //   Native voice-note sources (already opus/ogg/webm/amr, e.g.
        //   AI-generated TTS via AiProvider.tts) skip the transcode.
        const t = await AudioTranscodeService.ensureOpusOgg(m.filePath, m.mimeType);
        const sendBuf = (t.transcoded && t.path !== m.filePath)
          ? await fs.promises.readFile(t.path)
          : buf;
        const isPtt = t.transcoded || /opus|ogg|webm|amr/i.test(t.mimeType);
        payload = {
          audio: sendBuf,
          mimetype: t.mimeType,
          ptt: isPtt,
        };
        if (t.seconds != null && Number.isFinite(t.seconds)) {
          (payload as any).seconds = Math.max(1, Math.round(t.seconds));
        }
        // Real waveform (64 amplitude bytes) computed by AudioTranscodeService
        // from the transcoded audio's actual PCM. Without this, PTT audio
        // reaches customers as "problème avec le fichier audio" on mobile
        // WhatsApp — the client rejects voice-notes that lack a valid
        // waveform packet. Baileys would compute it via `audio-decode` but
        // that package isn't installed; we compute via ffmpeg instead.
        if (t.waveform && t.waveform.length === 64) {
          (payload as any).waveform = t.waveform;
        }
        break;
      }
      case 'document':
        payload = {
          document: buf,
          mimetype: m.mimeType,
          fileName: m.fileName ?? path.basename(m.filePath),
          caption: m.caption,
        };
        break;
    }
    const t0 = Date.now();
    const res = await this.safeSend(accountId, () => sock.sendMessage(jid, payload));
    const waId = res?.key?.id ?? undefined;
    logger.info(
      {
        accountId, jid, type: m.type,
        srcMimeType: m.mimeType, size: buf.length,
        waId, durationMs: Date.now() - t0,
        ...(m.type === 'audio' ? {
          ptt: (payload as any)?.ptt === true,
          sendMime: (payload as any)?.mimetype,
          seconds: (payload as any)?.seconds ?? null,
          waveformBytes: (payload as any)?.waveform?.length ?? 0,
        } : {}),
      },
      `BaileysAdapter.sendMedia: ${m.type} sent`,
    );
    return waId;
  }

  /** Show "typing..." presence for ~ms milliseconds. */
  async simulateTyping(accountId: string, jid: string, ms: number): Promise<void> {
    const sock = this.sessions.get(accountId)?.socket;
    if (!sock) return;
    try {
      await sock.presenceSubscribe(jid);
      await sock.sendPresenceUpdate('composing', jid);
      await new Promise((r) => setTimeout(r, ms));
      await sock.sendPresenceUpdate('paused', jid);
    } catch {
      // presence is best-effort
    }
  }

  /**
   * Mark a received message as read (humanizes the conversation pace —
   * the customer sees ✓✓ blue before the bot replies, just like a real person).
   */
  async markRead(accountId: string, key: { id: string; remoteJid: string; fromMe: boolean; participant?: string }): Promise<void> {
    const sock = this.sessions.get(accountId)?.socket;
    if (!sock) return;
    try {
      await sock.readMessages([key as any]);
    } catch {
      // best-effort
    }
  }

  /** Reject an incoming WhatsApp call. Best-effort. */
  async rejectCall(accountId: string, callId: string, callFrom: string): Promise<void> {
    const sock = this.sessions.get(accountId)?.socket;
    if (!sock) return;
    try {
      await sock.rejectCall(callId, callFrom);
    } catch (e) {
      logger.warn({ err: e, accountId, callId }, 'rejectCall failed');
    }
  }

  async disconnect(accountId: string): Promise<void> {
    const s = this.sessions.get(accountId);
    if (!s) return;
    s.destroyed = true;
    if (s.reconnectTimer) { clearTimeout(s.reconnectTimer); s.reconnectTimer = undefined; }
    // Detach listeners BEFORE logout — otherwise the final connection.update
    // can race and re-enter the close handler against a session we're deleting.
    if (s.socket) {
      try { s.socket.ev.removeAllListeners('messages.upsert'); } catch {}
      try { s.socket.ev.removeAllListeners('connection.update'); } catch {}
      try { s.socket.ev.removeAllListeners('creds.update'); } catch {}
      try { s.socket.ev.removeAllListeners('call'); } catch {}
    }
    try { await s.socket?.logout(); } catch {}
    try { s.socket?.end(undefined); } catch {}
    s.socket = undefined;
    this.emitStatus(s, 'disconnected');
    this.sessions.delete(accountId);
  }

  /** Disconnect AND wipe credentials so next start needs a fresh QR. */
  async logout(accountId: string): Promise<void> {
    await this.disconnect(accountId);
    const dir = path.join(env.SESSIONS_DIR, accountId);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  /**
   * Graceful process shutdown: close every active socket cleanly WITHOUT
   * calling sock.logout() — that would wipe credentials on WA's side and
   * force a fresh QR after restart. We only cancel timers, detach listeners,
   * and end the socket. `resumeAll()` picks them up on next boot from DB.
   */
  async shutdownAll(): Promise<void> {
    const ids = Array.from(this.sessions.keys());
    // Per-account 2s cap so a hung socket end() / listener drain can't push
    // the overall shutdown past the outer 10s deadline. Any account that
    // times out is simply forgotten — the underlying process exit closes fds.
    await Promise.all(ids.map(async (accountId) => {
      const s = this.sessions.get(accountId);
      if (!s) return;
      const work = (async () => {
        if (s.reconnectTimer) { clearTimeout(s.reconnectTimer); s.reconnectTimer = undefined; }
        if (s.socket) {
          try { s.socket.ev.removeAllListeners('messages.upsert'); } catch {}
          try { s.socket.ev.removeAllListeners('connection.update'); } catch {}
          try { s.socket.ev.removeAllListeners('creds.update'); } catch {}
          try { s.socket.ev.removeAllListeners('call'); } catch {}
          try { s.socket.end(undefined); } catch {}
        }
        s.socket = undefined;
      })();
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 2000).unref?.());
      await Promise.race([work, timeout]);
    }));
    logger.info({ count: ids.length }, 'shutdownAll: all WA sockets closed (credentials preserved)');
  }

  status(accountId: string): AccountStatus {
    return this.sessions.get(accountId)?.status ?? 'disconnected';
  }

  isConnected(accountId: string): boolean {
    return this.status(accountId) === 'connected';
  }

  /**
   * Verify a phone number is registered on WhatsApp before we attempt to send.
   * Prevents the #1 ban vector: hitting invalid/deleted numbers en masse from
   * campaigns and follow-ups (WhatsApp instantly flags accounts that do this).
   *
   * Uses `sock.onWhatsApp` under the hood — a lightweight metadata call. We
   * cache results in-memory for 24h to spare WA a repeat lookup on the same jid.
   * A missing sock or a network error is treated as "unknown" → false, so the
   * safest thing (skip the send) happens.
   */
  private waCache = new Map<string, { exists: boolean; expiresAt: number }>();
  async isRegisteredOnWhatsApp(accountId: string, phoneOrJid: string): Promise<boolean> {
    const digits = phoneOrJid.replace(/[^\d]/g, '');
    if (!digits) return false;
    const jid = `${digits}@s.whatsapp.net`;
    const cached = this.waCache.get(jid);
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.exists;
    const sock = this.sessions.get(accountId)?.socket;
    if (!sock) return false;
    try {
      const rows = await sock.onWhatsApp(jid);
      const exists = !!rows?.[0]?.exists;
      this.waCache.set(jid, { exists, expiresAt: now + 24 * 3600 * 1000 });
      // Cap cache size — trim oldest 10% when we cross 5000 entries.
      if (this.waCache.size > 5000) {
        const entries = Array.from(this.waCache.entries()).sort((a, b) => a[1].expiresAt - b[1].expiresAt);
        for (const [k] of entries.slice(0, 500)) this.waCache.delete(k);
      }
      return exists;
    } catch (e) {
      logger.warn({ err: e, accountId, jid }, 'isRegisteredOnWhatsApp lookup failed');
      return false;
    }
  }

  /**
   * Create or update a WhatsApp chat-label with a deterministic id (so the
   * call is idempotent — second call with the same id renames/recolors).
   * The CustomerTagService uses this for the per-status labels.
   *
   * Caller passes the desired labelId, name, and color (0..19 — the Baileys
   * label palette). Returns the labelId on success. On personal accounts that
   * don't honor labels, the call may complete silently on WA's side; we
   * always return the id so the cache row is still persisted.
   */
  async upsertLabel(accountId: string, labelId: string, name: string, color: number): Promise<string> {
    const sock = this.requireSock(accountId);
    const selfJid = sock.user?.id ?? '';
    if (!selfJid) {
      logger.warn({ accountId, labelId }, 'upsertLabel: selfJid not ready — session still initializing');
      throw new Error('session_not_ready');
    }
    logger.info({ accountId, labelId, name, color }, 'baileys: upsertLabel start');
    try {
      await this.safeSend(accountId, () =>
        sock.addLabel(selfJid, { id: labelId, name, color, deleted: false } as any),
      );
      logger.info({ accountId, labelId, name }, 'baileys: upsertLabel sent (patch enqueued)');
    } catch (e: any) {
      logger.error({ err: e?.message ?? e, accountId, labelId, name }, 'baileys: upsertLabel FAILED');
      throw e;
    }
    return labelId;
  }

  /** Add a label to a chat. Idempotent on the WA side. */
  async addChatLabel(accountId: string, jid: string, labelId: string): Promise<void> {
    const sock = this.requireSock(accountId);
    logger.info({ accountId, jid, labelId }, 'baileys: addChatLabel start');
    try {
      await this.safeSend(accountId, () => sock.addChatLabel(jid, labelId));
      logger.info({ accountId, jid, labelId }, 'baileys: addChatLabel sent (patch enqueued)');
    } catch (e: any) {
      logger.error({ err: e?.message ?? e, accountId, jid, labelId }, 'baileys: addChatLabel FAILED');
      throw e;
    }
  }

  /** Remove a label from a chat. No-op if not currently labeled. */
  async removeChatLabel(accountId: string, jid: string, labelId: string): Promise<void> {
    const sock = this.requireSock(accountId);
    logger.info({ accountId, jid, labelId }, 'baileys: removeChatLabel start');
    try {
      await this.safeSend(accountId, () => sock.removeChatLabel(jid, labelId));
      logger.info({ accountId, jid, labelId }, 'baileys: removeChatLabel sent (patch enqueued)');
    } catch (e: any) {
      logger.error({ err: e?.message ?? e, accountId, jid, labelId }, 'baileys: removeChatLabel FAILED');
      throw e;
    }
  }

  /**
   * Baileys retransmit callback. When a recipient's WhatsApp can't decrypt one
   * of our messages (missing Signal session, out-of-order delivery, @lid
   * bootstrap timing), it sends a retransmit request; Baileys asks us for the
   * plaintext via this callback. If we return the message body, Baileys
   * re-encrypts with the fresh session state and resends — the recipient's
   * "En attente" placeholder resolves within a few seconds.
   *
   * Lookup is by waMessageId in the persisted outgoing rows. Text messages
   * cover the AI's primary output surface; media falls back to caption-as-text
   * so the recipient at least gets the context.
   */
  private async lookupSentMessage(key: any): Promise<any> {
    const id = key?.id;
    if (!id) return undefined;
    try {
      const row = await prisma.message.findFirst({
        where: { waMessageId: id, direction: 'out' },
        select: { type: true, body: true },
      });
      if (!row) {
        logger.info({ id }, 'getMessage: miss (no matching outgoing row)');
        return undefined;
      }
      if (row.type === 'text' && row.body) {
        logger.info({ id }, 'getMessage: served text retransmit');
        return { conversation: row.body };
      }
      if (row.body) {
        logger.info({ id, type: row.type }, 'getMessage: served body-as-text fallback for media');
        return { conversation: row.body };
      }
      // Media row without a caption — returning undefined here previously
      // caused the customer's device to silently discard the ciphertext
      // whenever it hit a decryption race (fresh session). Serve a tiny
      // synthetic placeholder instead: WhatsApp accepts it, the device
      // stops discarding, and the media has a chance to render.
      const placeholder =
        row.type === 'audio'    ? '🎧 رسالة صوتية' :
        row.type === 'video'    ? '🎬'             :
        row.type === 'image'    ? '📷'             :
        row.type === 'document' ? '📎'             :
                                  '…';
      logger.info({ id, type: row.type }, 'getMessage: served synthetic placeholder for media');
      return { conversation: placeholder };
    } catch (e) {
      logger.warn({ err: e, id }, 'getMessage lookup failed');
      return undefined;
    }
  }

  private requireSock(accountId: string): WASocket {
    const s = this.sessions.get(accountId);
    if (!s?.socket) throw new Error(`account ${accountId} is not connected`);
    return s.socket;
  }

  private emitStatus(
    s: Session,
    status: AccountStatus,
    info: { phoneNumber?: string | null; lastError?: string | null } = {}
  ) {
    s.status = status;
    this.emit('status', s.accountId, status, info);
  }
}

export const whatsapp = new WhatsAppAdapter();
