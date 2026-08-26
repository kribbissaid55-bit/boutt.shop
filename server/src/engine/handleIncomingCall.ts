/**
 * Engine — react to an incoming WhatsApp voice/video call.
 *
 * Resolution order:
 *   1. Find the active bot for this account. If found AND its BotSettings has
 *      `callRejectionEnabled = true`, use the per-bot configuration:
 *         - delay `callRejectionDelaySeconds` seconds (let the call ring naturally)
 *         - reject
 *         - run `callRejectionSequence` JSON via runMessageSequence
 *   2. Otherwise fall back to the global Setting keys (`auto_reject_calls` etc.)
 *      so existing behaviour is preserved when no bot is linked or per-bot is
 *      disabled.
 *
 * Per-contact dedup: the configured follow-up sequence is sent AT MOST ONCE
 * per `CALL_REJECTION_DEDUP_HOURS` (24h by default). Subsequent calls within
 * the window are still rejected on the WA side, but no message is resent —
 * stops the bot from spamming a persistent caller.
 */
import { prisma } from '../lib/prisma.js';
import { logger } from '../config/logger.js';
import { whatsapp } from '../adapters/whatsapp/BaileysAdapter.js';
import { providerFor } from '../adapters/whatsapp/providerFactory.js';
import { ContactService } from '../services/ContactService.js';
import { SettingsService } from '../services/SettingsService.js';
import { MessageQueueService } from '../services/MessageQueueService.js';
import { MediaService } from '../services/MediaService.js';
import { StepMatcherService } from '../services/StepMatcherService.js';
import { runMessageSequence, type MessageSequence } from './runMessageSequence.js';
import { sleep } from '../lib/retry.js';
import { bus } from '../services/EventBus.js';
import { isGroupJid, phoneFromJid } from '../lib/jid.js';

export type IncomingCall = {
  accountId: string;
  callId: string;
  from: string;
  isVideo: boolean;
  isGroup: boolean;
};

const safeJson = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
};

/** How long to suppress a follow-up after sending it once. */
const CALL_REJECTION_DEDUP_MS = 24 * 60 * 60_000;

export async function handleIncomingCall(c: IncomingCall): Promise<void> {
  // Skip group calls — different shape, not handled.
  if (c.isGroup || isGroupJid(c.from)) {
    logger.info({ accountId: c.accountId, from: c.from }, 'incoming call: group call ignored');
    return;
  }

  const account = await prisma.whatsAppAccount.findUnique({ where: { id: c.accountId } });
  if (!account) return;

  // 1) Try per-bot config first.
  const bot = await StepMatcherService.pickActiveBot(c.accountId);
  const botSettings = bot
    ? await prisma.botSettings.findUnique({ where: { botId: bot.id } })
    : null;

  let enabled: boolean;
  let delaySeconds: number;
  let sequence: MessageSequence | null = null;
  let usingPerBot = false;

  if (botSettings?.callRejectionEnabled) {
    enabled = true;
    // Guard against NaN/garbage in the DB column.
    const rawDelay = botSettings.callRejectionDelaySeconds;
    const cleanDelay = typeof rawDelay === 'number' && !isNaN(rawDelay) ? rawDelay : 0;
    delaySeconds = Math.max(0, Math.min(10, cleanDelay));
    sequence = safeJson<MessageSequence>(botSettings.callRejectionSequence, { blocks: [] });
    usingPerBot = true;
  } else {
    // Fall back to global Setting keys.
    const settings = await SettingsService.load();
    enabled = !!settings.auto_reject_calls;
    delaySeconds = 0;
    sequence = await buildLegacyGlobalSequence(settings);
  }

  if (!enabled) {
    logger.info({ accountId: c.accountId, from: c.from }, 'incoming call: auto-reject disabled, ignoring');
    return;
  }

  if (delaySeconds > 0) {
    logger.info({ accountId: c.accountId, delaySeconds }, 'call: ringing before reject');
    await sleep(delaySeconds * 1000);
  }

  await whatsapp.rejectCall(c.accountId, c.callId, c.from);
  logger.info({ accountId: c.accountId, from: c.from, isVideo: c.isVideo, perBot: usingPerBot }, 'call rejected');

  if (!sequence) return;
  const liveBlocks = (sequence.blocks ?? []).filter((b: any) => b.enabled !== false);
  if (!liveBlocks.length) return;

  const contact = await ContactService.findOrCreate(c.accountId, c.from, phoneFromJid(c.from));

  // Per-contact dedup: skip the follow-up if we already sent it within the
  // last 24h. The call itself was still rejected above.
  const lastSent = (contact as any).lastCallRejectionMessageAt as Date | null | undefined;
  if (lastSent && (Date.now() - lastSent.getTime()) < CALL_REJECTION_DEDUP_MS) {
    logger.info(
      { accountId: c.accountId, contactId: contact.id, lastSent },
      'call-rejection: skip message (sent within 24h)',
    );
    return;
  }

  const provider = providerFor(c.accountId);
  const settings = await SettingsService.load();

  await MessageQueueService.enqueue(c.accountId, async () => {
    try {
      await runMessageSequence(sequence!, {
        accountId: c.accountId,
        contactId: contact.id,
        jid: c.from,
        ctx: {
          contact: { name: contact.name, jid: contact.jid },
          bot: { name: bot?.name ?? '' },
          account: { name: account.name },
        },
        provider,
        senderType: 'bot',
      });
      // Mark the dedup timestamp ONLY after a successful send — failures
      // shouldn't lock us out of retrying on the next call.
      await prisma.contact.update({
        where: { id: contact.id },
        data: { lastCallRejectionMessageAt: new Date() } as any,
      }).catch(() => {});
    } catch (e) {
      logger.error({ err: e, accountId: c.accountId, from: c.from }, 'call rejection follow-up failed');
    }
  }, {
    minDelayMs: settings.min_send_delay_ms,
    maxDelayMs: settings.max_send_delay_ms,
    dailyCap: account.dailySendCap,
    burstThreshold: settings.burst_threshold_count,
    burstWindowMin: settings.burst_window_minutes,
    burstCooldownSec: settings.burst_cooldown_seconds,
  }).catch((e) => {
    logger.warn({ err: e, accountId: c.accountId }, 'call rejection enqueue rejected');
  });

  // Suppress unused warning for legacy single-shot media path import.
  void MediaService; void bus;
}

/** Translate the legacy global Setting keys into a one-block MessageSequence. */
async function buildLegacyGlobalSequence(settings: any): Promise<MessageSequence | null> {
  const type: string = settings.call_rejection_message_type;
  if (!type || type === 'none') return null;
  if (type === 'text') {
    const body = (settings.call_rejection_message_text ?? '').trim();
    if (!body) return null;
    return { blocks: [{ type: 'text', content: body, enabled: true }] };
  }
  // media types — wrap as a single sequence block referencing the existing mediaId
  const mediaId: string | null = settings.call_rejection_media_id;
  if (!mediaId) return null;
  return { blocks: [{ type: type as any, mediaId, enabled: true }] };
}
