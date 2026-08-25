/**
 * socialWebhook.routes — PUBLIC Meta webhook endpoint (no auth cookie: Meta's
 * servers call it). Mounted in app.ts BEFORE the global json parser and auth
 * so it can (a) capture the raw body for X-Hub-Signature-256 verification and
 * (b) stay reachable without a session.
 *
 *   GET  /api/social/webhook  → subscription verification (hub.challenge)
 *   POST /api/social/webhook  → comment + message events (page / instagram)
 *
 * Events are acknowledged immediately (Meta retries on slow responses) and
 * processed asynchronously. The SocialEvent unique(platform, externalId)
 * constraint deduplicates Meta's redeliveries.
 */
import { Router, json } from 'express';
import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../config/logger.js';
import { decryptApiKey } from '../../lib/ai-crypto.js';
import { SocialGraphService } from '../../services/SocialGraphService.js';
import { socialEngine } from '../../engine/socialEngine.js';

export const socialWebhookRouter = Router();

const getSetting = async (key: string) =>
  (await prisma.setting.findUnique({ where: { key } }))?.value ?? '';

// Own body parser that keeps the raw bytes for signature verification.
socialWebhookRouter.use('/api/social/webhook', json({
  limit: '1mb',
  verify: (req: any, _res, buf) => { req.rawBody = buf; },
}));

// ── Verification handshake ────────────────────────────────────────────────
socialWebhookRouter.get('/api/social/webhook', async (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const expected = await getSetting('social_verify_token');
  if (mode === 'subscribe' && expected && token === expected) {
    return res.status(200).send(String(challenge ?? ''));
  }
  res.sendStatus(403);
});

// ── Event delivery ────────────────────────────────────────────────────────
socialWebhookRouter.post('/api/social/webhook', async (req: any, res) => {
  // Signature check (skippable only when no secret is configured yet).
  try {
    const secretEnc = await getSetting('social_app_secret_enc');
    if (secretEnc) {
      const secret = decryptApiKey(secretEnc);
      const sig = String(req.headers['x-hub-signature-256'] ?? '');
      const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody ?? Buffer.alloc(0)).digest('hex');
      const ok = sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
      if (!ok) return res.sendStatus(401);
    }
  } catch (e) {
    SocialGraphService.safeLog('signature-check', e);
    return res.sendStatus(401);
  }

  res.sendStatus(200); // ack fast — process async below

  const body = req.body ?? {};
  processDelivery(body).catch((e) => SocialGraphService.safeLog('processDelivery', e));
});

async function processDelivery(body: any): Promise<void> {
  const object = body?.object;
  for (const entry of body?.entry ?? []) {
    // Comments arrive under entry.changes; DMs under entry.messaging.
    for (const change of entry?.changes ?? []) {
      try {
        if (object === 'page' && change.field === 'feed') await handleFbFeed(change.value);
        else if (object === 'instagram' && (change.field === 'comments' || change.field === 'live_comments')) {
          await handleIgComment(entry.id, change.value);
        }
      } catch (e) { SocialGraphService.safeLog(`change:${change?.field}`, e); }
    }
    for (const msg of entry?.messaging ?? []) {
      try { await handleDm(object, entry.id, msg); }
      catch (e) { SocialGraphService.safeLog('messaging', e); }
    }
  }
}

// ── Facebook page comments ────────────────────────────────────────────────
async function handleFbFeed(v: any): Promise<void> {
  if (v?.item !== 'comment' || v?.verb !== 'add') return;
  const commentId: string = v.comment_id;
  const text: string = v.message ?? '';
  const fromId: string = v.from?.id ?? '';
  const fromName: string = v.from?.name ?? '';
  if (!commentId || !text.trim()) return;

  // post_id is "<pageId>_<postId>" — resolve the account by page id.
  const pageId = String(v.post_id ?? '').split('_')[0];
  const account = await prisma.socialAccount.findFirst({ where: { pageId, enabled: true } });
  if (!account || !account.commentAutoReply) return;
  if (fromId === account.pageId) return; // our own reply — avoid loops

  await replyToComment(account, 'facebook', commentId, text, fromId, fromName);
}

// ── Instagram comments (entry.id = IG business account id) ────────────────
async function handleIgComment(igUserId: string, v: any): Promise<void> {
  const commentId: string = v?.id;
  const text: string = v?.text ?? '';
  const fromId: string = v?.from?.id ?? '';
  const fromName: string = v?.from?.username ?? '';
  if (!commentId || !text.trim()) return;
  const account = await prisma.socialAccount.findFirst({ where: { igUserId, enabled: true } });
  if (!account || !account.commentAutoReply) return;
  if (fromId && account.igUserId && fromId === account.igUserId) return; // own reply

  await replyToComment(account, 'instagram', commentId, text, fromId, fromName);
}

async function replyToComment(
  account: any, platform: 'facebook' | 'instagram',
  commentId: string, text: string, fromId: string, fromName: string,
): Promise<void> {
  // Dedup via unique(platform, externalId) — bail if we've already seen it.
  let ev;
  try {
    ev = await prisma.socialEvent.create({
      data: { accountId: account.id, platform, kind: 'comment', externalId: commentId, senderId: fromId, senderName: fromName, inText: text.slice(0, 2000), status: 'skipped' },
    });
  } catch { return; } // duplicate delivery

  try {
    const token = decryptApiKey(account.accessToken);
    const out = await socialEngine.commentReply(account, { commentText: text, senderName: fromName, platform });
    let replied = false;
    if (out.publicReply.trim()) {
      if (platform === 'facebook') await SocialGraphService.replyToFbComment(commentId, token, out.publicReply);
      else await SocialGraphService.replyToIgComment(commentId, token, out.publicReply);
      replied = true;
    }
    let priv = '';
    if (account.privateReplyOnComment && out.privateMessage.trim()) {
      try {
        await SocialGraphService.privateReplyToComment(commentId, token, out.privateMessage);
        priv = out.privateMessage;
      } catch (e) { SocialGraphService.safeLog('private-reply', e); }
    }
    await prisma.socialEvent.update({
      where: { id: ev.id },
      data: { replyText: out.publicReply || null, privateReplyText: priv || null, status: replied || priv ? 'replied' : 'skipped' },
    });
  } catch (e: any) {
    await prisma.socialEvent.update({ where: { id: ev.id }, data: { status: 'error', error: String(e?.message ?? e).slice(0, 300) } }).catch(() => {});
  }
}

// ── DMs: Messenger (object=page) & Instagram DMs (object=instagram) ───────
async function handleDm(object: string, entryId: string, msg: any): Promise<void> {
  const message = msg?.message;
  if (!message || message.is_echo) return;      // ignore echoes of our own sends
  const mid: string = message.mid ?? '';
  const text: string = message.text ?? '';
  const senderId: string = msg.sender?.id ?? '';
  if (!mid || !senderId) return;

  const account = object === 'instagram'
    ? await prisma.socialAccount.findFirst({ where: { igUserId: entryId, enabled: true } })
    : await prisma.socialAccount.findFirst({ where: { pageId: entryId, enabled: true } });
  if (!account || !account.dmAutoReply) return;
  if (senderId === account.pageId || (account.igUserId && senderId === account.igUserId)) return;

  const platform = object === 'instagram' ? 'instagram' : 'messenger';
  let ev;
  try {
    ev = await prisma.socialEvent.create({
      data: {
        accountId: account.id, platform, kind: 'dm', externalId: mid, senderId,
        inText: (text || '[وسائط]').slice(0, 2000), status: 'skipped',
      },
    });
  } catch { return; }

  if (!text.trim()) return; // attachments-only — log it, don't reply blindly

  try {
    const token = decryptApiKey(account.accessToken);
    const reply = await socialEngine.dmReply(account, { text, senderId });
    if (reply.trim()) {
      await SocialGraphService.sendDm(senderId, token, reply);
      await prisma.socialEvent.update({ where: { id: ev.id }, data: { replyText: reply, status: 'replied' } });
    }
  } catch (e: any) {
    await prisma.socialEvent.update({ where: { id: ev.id }, data: { status: 'error', error: String(e?.message ?? e).slice(0, 300) } }).catch(() => {});
  }
}

logger.info('[social] webhook routes ready');
