/**
 * whatsappWebhook.routes — PUBLIC Meta webhook for the OFFICIAL WhatsApp
 * Cloud API. Mounted in app.ts BEFORE the global json parser (raw body needed
 * for X-Hub-Signature-256) and before auth (Meta calls it without cookies).
 *
 *   GET  /api/whatsapp/webhook → hub.challenge verification handshake
 *   POST /api/whatsapp/webhook → messages + delivery statuses
 *
 * Design mirrors the battle-tested social webhook:
 *   - HMAC-SHA256 signature verification against the Meta App Secret
 *   - 200 fast-ack, async processing (Meta retries slow responses)
 *   - Idempotency downstream via ProcessedMessage (engine) — Meta redelivers
 *   - Incoming events are converted to the SAME IncomingMessage shape the
 *     Baileys adapter emits, so the entire engine runs unchanged.
 */
import { Router, json } from 'express';
import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../config/logger.js';
import { CloudApiService } from '../../services/CloudApiService.js';
import { BotEngineService } from '../../services/BotEngineService.js';
import { bus } from '../../services/EventBus.js';
import type { IncomingMessage, IncomingMessageKind } from '../../adapters/whatsapp/types.js';

export const whatsappWebhookRouter = Router();

const getSetting = async (key: string) =>
  (await prisma.setting.findUnique({ where: { key } }))?.value ?? '';

whatsappWebhookRouter.use('/api/whatsapp/webhook', json({
  limit: '1mb',
  verify: (req: any, _res, buf) => { req.rawBody = buf; },
}));

// ── Verification handshake ────────────────────────────────────────────────
whatsappWebhookRouter.get('/api/whatsapp/webhook', async (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const expected = await getSetting('wa_cloud_verify_token');
  if (mode === 'subscribe' && expected && token === expected) {
    logger.info('[cloud] webhook verified by Meta');
    return res.status(200).send(String(challenge ?? ''));
  }
  res.sendStatus(403);
});

// ── Event delivery ────────────────────────────────────────────────────────
whatsappWebhookRouter.post('/api/whatsapp/webhook', async (req: any, res) => {
  try {
    const secret = await CloudApiService.getAppSecret();
    if (secret) {
      const sig = String(req.headers['x-hub-signature-256'] ?? '');
      const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody ?? Buffer.alloc(0)).digest('hex');
      const ok = sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
      if (!ok) return res.sendStatus(401);
    }
  } catch (e) {
    logger.warn({ err: (e as Error).message }, '[cloud] webhook signature check failed');
    return res.sendStatus(401);
  }

  res.sendStatus(200); // ack fast — process async below

  processDelivery(req.body ?? {}).catch((e) =>
    logger.error({ err: (e as Error).message }, '[cloud] processDelivery failed'));
});

async function processDelivery(body: any): Promise<void> {
  if (body?.object !== 'whatsapp_business_account') return;
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      if (change?.field !== 'messages') continue;
      const value = change.value ?? {};
      try { await handleValue(value); }
      catch (e) { logger.error({ err: (e as Error).message }, '[cloud] handleValue failed'); }
    }
  }
}

async function handleValue(value: any): Promise<void> {
  const phoneNumberId: string = value?.metadata?.phone_number_id ?? '';
  if (!phoneNumberId) return;

  const account = await prisma.whatsAppAccount.findUnique({
    where: { phoneNumberId },
  });
  if (!account) {
    logger.warn({ phoneNumberId }, '[cloud] webhook for unknown phone_number_id — activate the number in the dashboard');
    return;
  }

  // ── Delivery/read/failure statuses for OUR outbound messages ────────────
  for (const st of value?.statuses ?? []) {
    try {
      const wamid: string = st.id;
      const status: string = st.status; // sent | delivered | read | failed
      if (!wamid || !status) continue;
      const err = Array.isArray(st.errors) && st.errors.length
        ? `${st.errors[0].code}: ${st.errors[0].title ?? st.errors[0].message ?? ''}`.slice(0, 300)
        : null;
      const updated = await prisma.message.updateMany({
        where: { waMessageId: wamid },
        data: { status, ...(err ? { error: err } : {}) },
      });
      if (updated.count > 0) {
        const row = await prisma.message.findFirst({ where: { waMessageId: wamid }, select: { id: true, contactId: true } });
        if (row) bus.emitEvent({ type: 'message.status', accountId: account.id, contactId: row.contactId, messageId: row.id, status });
      }
      if (status === 'failed') {
        logger.warn({ wamid, err }, '[cloud] outbound message failed');
      }
    } catch (e) { logger.warn({ err: (e as Error).message }, '[cloud] status update failed'); }
  }

  // ── Incoming customer messages → the SAME engine as Baileys ─────────────
  const contactName: string | undefined = value?.contacts?.[0]?.profile?.name;
  for (const msg of value?.messages ?? []) {
    try {
      const m = toIncoming(account.id, msg, contactName);
      if (m) BotEngineService.handleIncoming(m);
    } catch (e) { logger.error({ err: (e as Error).message }, '[cloud] toIncoming failed'); }
  }

  for (const err of value?.errors ?? []) {
    logger.warn({ code: err?.code, title: err?.title }, '[cloud] webhook value-level error');
  }
}

/** Convert one Cloud API message object to the provider-agnostic shape. */
function toIncoming(accountId: string, msg: any, pushName?: string): IncomingMessage | null {
  const from: string = msg?.from ?? '';
  const wamid: string = msg?.id ?? '';
  if (!from || !wamid) return null;

  const type: string = msg?.type ?? 'unknown';
  let kind: IncomingMessageKind = 'text';
  let text = '';
  let cloudMedia: { id: string; mimeType?: string } | undefined;

  switch (type) {
    case 'text':
      text = msg.text?.body ?? '';
      break;
    case 'button': // template quick-reply
      text = msg.button?.text ?? msg.button?.payload ?? '';
      break;
    case 'interactive': {
      const i = msg.interactive ?? {};
      // We set reply id = option number when sending, so the id is exactly
      // the token the step matcher expects ("1", "2", ...).
      const r = i.button_reply ?? i.list_reply ?? {};
      text = r.id ?? r.title ?? '';
      break;
    }
    case 'audio':
      kind = 'audio';
      if (msg.audio?.id) cloudMedia = { id: String(msg.audio.id), mimeType: msg.audio.mime_type };
      break;
    case 'image':
      kind = 'image';
      text = msg.image?.caption ?? '';
      if (msg.image?.id) cloudMedia = { id: String(msg.image.id), mimeType: msg.image.mime_type };
      break;
    case 'video':
      kind = 'video';
      text = msg.video?.caption ?? '';
      if (msg.video?.id) cloudMedia = { id: String(msg.video.id), mimeType: msg.video.mime_type };
      break;
    case 'document':
      kind = 'document';
      text = msg.document?.caption ?? msg.document?.filename ?? '';
      if (msg.document?.id) cloudMedia = { id: String(msg.document.id), mimeType: msg.document.mime_type };
      break;
    case 'sticker':
      kind = 'sticker';
      break;
    case 'location':
      text = `📍 ${msg.location?.latitude},${msg.location?.longitude}` + (msg.location?.name ? ` (${msg.location.name})` : '');
      break;
    case 'contacts':
      text = '[بطاقة جهة اتصال]';
      break;
    case 'reaction':
      // Reactions are not conversation turns — ignore (same as Baileys path).
      return null;
    default:
      text = msg?.errors?.length ? '' : '';
      break;
  }

  return {
    accountId,
    waMessageId: wamid,
    fromJid: `${from}@s.whatsapp.net`,
    fromMe: false,
    isGroup: false, // Cloud API delivers 1:1 customer messages only
    pushName,
    text: text || undefined,
    timestamp: Number(msg.timestamp ?? Math.floor(Date.now() / 1000)),
    kind,
    // Cloud media handle — transcribeIfAudio/downstream detect `cloudMedia`.
    rawMsg: cloudMedia ? { cloudMedia } : undefined,
  };
}

logger.info('[cloud] whatsapp webhook routes ready');
