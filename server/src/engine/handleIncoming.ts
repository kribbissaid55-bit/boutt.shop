/**
 * Engine v2 — top-level handler for an incoming WhatsApp message.
 *
 * Responsibilities (in order):
 *   1. Drop fromMe / cold-start / status-broadcast / disabled-globally
 *   2. Idempotency on waMessageId
 *   3. Group filter
 *   4. Find or create Contact, persist incoming
 *   5. Bot pause / contact pause / handover keywords
 *   6. If Contact is in order-collection state → route to OrderFlow
 *   7. Pick active bot → match next step → walk it via per-account queue
 *   8. Fallback attempt counter; auto-handover after N fails
 */
import { prisma } from '../lib/prisma.js';
import { logger } from '../config/logger.js';
import { providerFor, markReadFor } from '../adapters/whatsapp/providerFactory.js';
import { ContactService } from '../services/ContactService.js';
import { SettingsService } from '../services/SettingsService.js';
import { MessageQueueService } from '../services/MessageQueueService.js';
import { StepMatcherService, type StepWithChildren } from '../services/StepMatcherService.js';
import { OrderService, ORDER_QUESTIONS_AR } from '../services/OrderService.js';
import { UnsubscribeWatcher } from '../services/UnsubscribeWatcher.js';
import { walkStep, type WalkContext } from './walkStep.js';
import { normalizeText, extractOptionNumber } from '../lib/jid.js';
import { bus } from '../services/EventBus.js';
import { syncTagsForContact } from '../services/CustomerTagService.js';
import { transcribeIfAudio } from './aiEngine.js';
import { applyPreSendGuardrails } from './preSendGuardrails.js';
import { AiProvider } from '../services/AiProvider.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { IncomingMessage, IncomingMessageKind } from '../adapters/whatsapp/types.js';

const BOOT_TIME = Date.now();

// Per-contact debounce — collapses back-to-back customer messages into ONE
// engine turn. If a customer sends "salam" then "bghit nsewlek" then "shhal?"
// within a few seconds, without this the bot would fire 3 racing replies.
// With this map, only the LAST message's timer survives; when it fires, the
// engine reads ALL the queued messages from DB and answers once with full
// context. 4000 ms is calibrated to catch common patterns like "reaction +
// follow-up sentence" or "typo + retype" that arrive 3-4 s apart — still
// snappy from the customer's PoV (they see the typing indicator during it).
const pendingReplyTimers = new Map<string, NodeJS.Timeout>();
const REPLY_DEBOUNCE_MS = 4000;

/** Returns true if "now" falls inside the given HH:MM window (in the tz). */
function withinWorkingHours(wh: { start: string; end: string; tz: string }): boolean {
  try {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone: wh.tz,
    });
    const [h, mn] = fmt.format(now).split(':').map(Number);
    const cur = h * 60 + mn;
    const [sh, sm] = wh.start.split(':').map(Number);
    const [eh, em] = wh.end.split(':').map(Number);
    const start = sh * 60 + sm;
    const end = eh * 60 + em;
    if (start <= end) return cur >= start && cur < end;
    return cur >= start || cur < end; // crosses midnight
  } catch { return true; }
}

// per-contact rate-limit buckets (process-local)
const rateBuckets = new Map<string, { minute: number; minuteAt: number; hour: number; hourAt: number }>();

// Cooldown for the "please re-record" auto-reply we send when Whisper can't
// transcribe an inbound voice message. 2 minutes prevents a ping-pong loop
// if the customer keeps sending unintelligible audio. Process-local — resets
// on server restart, which is fine (recovers automatically after 2 min anyway).
const voiceFailCooldown = new Map<string, number>();
const VOICE_FAIL_COOLDOWN_MS = 2 * 60_000;
const VOICE_FALLBACK_TEXT =
  'عفاك رني مسمعتش مزيان هاد الأوديو، ممكن تعاود تسجّل واحد أوضح باش نفهم مزيان؟';
const CLARIFY_FALLBACK_TEXT =
  'عفاك ممكن تعاود صياغة سؤالك؟ ما فهمتش بالضبط شنو بغيتي.';

// Sweep idle buckets every 30 min. A contact whose last bucket-update was
// more than 2 hours ago will never come back through the rate-limit check
// the same hour, so dropping them is safe and stops the Map from growing
// with one entry per lifetime-unique contactId.
setInterval(() => {
  const now = Date.now();
  const IDLE_CUTOFF = 2 * 60 * 60_000;
  for (const [id, b] of rateBuckets) {
    if (now - b.hourAt > IDLE_CUTOFF) rateBuckets.delete(id);
  }
}, 30 * 60_000).unref?.();

function checkRate(contactId: string, perMin: number, perHour: number): boolean {
  const now = Date.now();
  let b = rateBuckets.get(contactId);
  if (!b) { b = { minute: 0, minuteAt: now, hour: 0, hourAt: now }; rateBuckets.set(contactId, b); }
  if (now - b.minuteAt > 60_000) { b.minute = 0; b.minuteAt = now; }
  if (now - b.hourAt > 3_600_000) { b.hour = 0; b.hourAt = now; }
  if (b.minute >= perMin || b.hour >= perHour) return false;
  b.minute++; b.hour++;
  return true;
}

export async function handleIncoming(m: IncomingMessage): Promise<void> {
  if (m.fromMe) {
    // Operator sent this from a linked WhatsApp surface (phone / Web /
    // desktop) — NOT via our inbox. Persist as senderType='admin' so the
    // next customer inbound triggers the owner-intervention window.
    //
    // Critical: Baileys also emits `fromMe:true` events for OUR OWN bot
    // sends (echo). Those are already persisted by walkStep/persistOut
    // with senderType='bot'. If we blindly wrote another row here we'd
    // (a) collide on the waMessageId unique constraint at best, or
    // (b) LAND FIRST in a race and mis-tag the bot's send as 'admin',
    // which then makes preSendGuardrails block every subsequent reply.
    // Guard: query first, only insert when no row with this waMessageId
    // exists yet. If it exists, this is either our echo (walkStep already
    // persisted) or a duplicate delivery — either way, skip.
    if (m.isGroup) {
      logger.info({ accountId: m.accountId, jid: m.fromJid, waMessageId: m.waMessageId },
                  'handleIncoming: dropped fromMe (group chat)');
      return;
    }
    try {
      const already = await prisma.message.findFirst({
        where: { waMessageId: m.waMessageId },
        select: { id: true, senderType: true },
      });
      if (already) {
        logger.info(
          { accountId: m.accountId, jid: m.fromJid, waMessageId: m.waMessageId, senderType: already.senderType },
          'handleIncoming: fromMe echo of already-persisted outgoing — skip',
        );
        return;
      }
      const contact = await ContactService.findOrCreate(m.accountId, m.fromJid, m.pushName, m.phoneJid);
      const now = new Date();
      await prisma.message.create({
        data: {
          accountId: m.accountId, contactId: contact.id,
          direction: 'out',
          type: m.kind ?? 'text',
          body: m.text ?? '',
          waMessageId: m.waMessageId,
          clientMessageId: `manual_from_device_${m.waMessageId}`,
          status: 'sent',
          senderType: 'admin',
        },
      }).catch(() => {
        // Race: walkStep persistOut wrote the bot row between our findFirst
        // and create. The waMessageId unique constraint rejects — silent OK.
      });
      await prisma.contact.update({
        where: { id: contact.id },
        data: { lastOutgoingMessageAt: now, lastInteractionAt: now },
      }).catch(() => {});
      logger.info(
        { accountId: m.accountId, jid: m.fromJid, waMessageId: m.waMessageId, contactId: contact.id },
        'handleIncoming: persisted fromMe as admin (owner intervention will apply)',
      );
    } catch (e) {
      logger.warn({ err: e, waMessageId: m.waMessageId }, 'fromMe: persist admin row failed');
    }
    return;
  }

  const settings = await SettingsService.load();

  // cold-start window
  if (m.timestamp * 1000 < BOOT_TIME - settings.cold_start_ignore_seconds * 1000) {
    logger.info({ accountId: m.accountId, lagSec: (BOOT_TIME - m.timestamp * 1000) / 1000 },
                'handleIncoming: dropped by cold-start window');
    return;
  }
  if (settings.emergency_stop || !settings.bot_globally_enabled) {
    logger.info({ accountId: m.accountId, emergency: settings.emergency_stop, globally: settings.bot_globally_enabled },
                'handleIncoming: dropped by global flag');
    return;
  }

  const account = await prisma.whatsAppAccount.findUnique({ where: { id: m.accountId } });
  if (!account) return;
  if (m.isGroup && (account.ignoreGroups ?? settings.ignore_groups_default)) {
    logger.info({ accountId: m.accountId, jid: m.fromJid }, 'handleIncoming: dropped group');
    return;
  }

  // Cache the cooldown state so the rest of the flow uses one consistent
  // snapshot (the account row may flip during async work below).
  const inCooldown = !!(account.cooldownUntil && account.cooldownUntil.getTime() > Date.now());
  if (inCooldown) {
    logger.warn({ accountId: account.id, until: account.cooldownUntil }, 'account in cooldown — incoming saved, no auto-reply, no mark-read');
  }

  // idempotency
  try {
    await prisma.processedMessage.create({
      data: { waMessageId: m.waMessageId, accountId: m.accountId },
    });
  } catch { return; }

  const contact = await ContactService.findOrCreate(m.accountId, m.fromJid, m.pushName, m.phoneJid);

  // Mark as read on WA side BEFORE replying — humanizes the conversation.
  // Skip during cooldown to avoid hitting the rate-limited socket.
  if (!inCooldown && settings.read_receipts) {
    markReadFor(m).catch(() => {});
  }

  const now = new Date();
  // Persist with the REAL media kind from the adapter — not the historical
  // hardcoded 'text'. This is the load-bearing fix that makes the AI engine's
  // reply-mode mirror (voice in → voice out) actually trigger.
  const persistType: IncomingMessageKind = m.kind ?? 'text';
  const inMsg = await prisma.message.create({
    data: {
      accountId: m.accountId, contactId: contact.id,
      direction: 'in', type: persistType, body: m.text ?? '',
      waMessageId: m.waMessageId, status: 'delivered',
      senderType: 'customer',
    },
  });
  // Update CRM timestamps. firstMessageAt set only once.
  await prisma.contact.update({
    where: { id: contact.id },
    data: {
      lastIncomingMessageAt: now,
      lastInteractionAt: now,
      ...(contact.firstMessageAt ? {} : { firstMessageAt: now }),
    },
  });
  bus.emitEvent({ type: 'message.in', accountId: m.accountId, contactId: contact.id, messageId: inMsg.id });
  // Customer just replied → may flip the status chip/label from sent_no_reply
  // to replied. Fire-and-forget (service-internal try/catch).
  void syncTagsForContact(null, m.accountId, contact.id);

  // Unsubscribe detection (early, before any reply path). On hit, the watcher
  // marks DNC and cancels all pending follow-up + campaign logs for this contact.
  const unsub = await UnsubscribeWatcher.check({ contactId: contact.id, text: m.text ?? '' });
  if (unsub.matched) {
    logger.info({ contactId: contact.id, keyword: unsub.keyword, canceledFollowups: unsub.canceledFollowups, canceledCampaignLogs: unsub.canceledCampaignLogs }, 'unsubscribe detected');
    return; // Don't run any further reply logic for this message
  }

  // Customer replied → flip recently-sent campaign logs to 'replied' (last 7d).
  // This stops further campaign sends to this contact and surfaces in stats.
  const campaignReplyCutoff = new Date(Date.now() - 7 * 24 * 3_600_000);
  await prisma.retargetingCampaignLog.updateMany({
    where: {
      contactId: contact.id,
      status: 'sent',
      sentAt: { gte: campaignReplyCutoff },
    },
    data: { status: 'replied' },
  }).catch(() => {});

  if (contact.botPaused) {
    logger.info({ contactId: contact.id }, 'engine: contact botPaused — silent');
    return;
  }

  if (inCooldown) {
    logger.info({ contactId: contact.id, accountId: m.accountId }, 'engine: account in cooldown — silent');
    return;
  }

  // Working-hours gate intentionally NOT enforced — operator rule: bot must
  // reply to every message. `withinWorkingHours` helper stays in this file
  // as dead code for a possible future opt-in.

  const bot = await StepMatcherService.pickActiveBot(m.accountId);
  if (!bot) return;

  // Voice-note pipeline. When the customer sent audio and the bot's AI config
  // has transcribe-audio on (default), STT it via the existing helper. This
  // (a) feeds the AI a real text input on `m.text`, (b) writes the transcript
  // back to the persisted Message so the dashboard shows what was said, and
  // (c) keeps `type='audio'` so the reply-mode mirror flips to voice.
  //
  // KEY invariant: even if transcription fails (Whisper error, no key, quota,
  // no rawMsg), we STILL set `m.text` — to an INSTRUCTIONAL placeholder that
  // tells the LLM exactly what to do. Every voice message gets a reply.
  if (m.kind === 'audio') {
    logger.info({ contactId: contact.id, hasRawMsg: !!m.rawMsg }, 'voice: received audio message');

    // Wider select — we may need the voice/reply-mode fields to send the
    // canned resend request without going through the LLM.
    const aiCfg = await prisma.botAiConfig.findUnique({
      where: { botId: bot.id },
      select: {
        transcribeAudio: true, sttContextPrompt: true,
        replyMode: true, voiceId: true, voiceProvider: true,
        voiceInstructions: true, voiceQuality: true,
        voiceStability: true, voiceSimilarityBoost: true,
        voiceModelId: true, voiceStyle: true,
      },
    });

    let transcript: string | null = null;
    if (m.rawMsg) {
      try {
        const shouldTranscribe = aiCfg?.transcribeAudio !== false;
        if (shouldTranscribe) {
          logger.info({ contactId: contact.id }, 'voice: transcribing (Whisper)');
          transcript = await transcribeIfAudio(m, m.rawMsg, aiCfg?.sttContextPrompt ?? undefined);
          if (transcript && transcript.trim()) {
            logger.info({ contactId: contact.id, len: transcript.length }, 'voice: transcript ready');
          } else {
            logger.warn({ contactId: contact.id }, 'voice: transcript empty or null');
          }
        } else {
          logger.info({ contactId: contact.id }, 'voice: transcription disabled for this bot');
        }
      } catch (e) {
        logger.warn({ err: e, contactId: contact.id }, 'voice: transcription threw');
      }
    } else {
      logger.warn({ contactId: contact.id }, 'voice: no rawMsg attached — cannot transcribe');
    }

    const successful = !!(transcript && transcript.trim());

    if (successful) {
      m.text = transcript!.trim();
      logger.info(
        { contactId: contact.id, textLen: m.text.length },
        'voice: dispatching to engine',
      );
      await prisma.message.update({
        where: { id: inMsg.id },
        data: { body: m.text },
      }).catch(() => {});
    } else {
      // Deterministic re-record request. No LLM dependency — the operator
      // needs the customer to always hear this, even if the LLM is down /
      // returns empty / is disabled. Modality mirrors the bot's replyMode:
      // voice-mode bots reply with TTS, text-mode bots reply with text.
      // 'auto' → voice (customer just sent audio, so voice-in → voice-out).
      const now = Date.now();
      const last = voiceFailCooldown.get(contact.id) ?? 0;
      if (now - last < VOICE_FAIL_COOLDOWN_MS) {
        logger.info(
          { contactId: contact.id, cooldownMs: VOICE_FAIL_COOLDOWN_MS - (now - last) },
          'voice: transcription failed but cooldown holds — skipping resend request',
        );
        return;
      }
      voiceFailCooldown.set(contact.id, now);

      const useVoice = (aiCfg?.replyMode === 'voice') ||
                       (aiCfg?.replyMode == null || aiCfg.replyMode === 'auto');
      logger.info(
        { contactId: contact.id, useVoice, replyMode: aiCfg?.replyMode },
        'voice: transcription empty — sending canned resend request',
      );

      let sentWaId: string | undefined;
      let sentType: 'audio' | 'text' = 'text';
      const vProvider = providerFor(m.accountId);

      if (useVoice) {
        try {
          const audio = await AiProvider.tts(VOICE_FALLBACK_TEXT, {
            voice: aiCfg?.voiceId || 'nova',
            provider: aiCfg?.voiceProvider ?? undefined,
            instructions: aiCfg?.voiceInstructions ?? undefined,
            quality: (aiCfg?.voiceQuality === 'hd' ? 'hd' : 'standard'),
            voiceStability: aiCfg?.voiceStability ?? undefined,
            voiceSimilarityBoost: aiCfg?.voiceSimilarityBoost ?? undefined,
            voiceStyle: (aiCfg as any)?.voiceStyle ?? undefined,
            voiceModelId: (aiCfg as any)?.voiceModelId ?? undefined,
          });
          const tmp = path.join(os.tmpdir(), `voice-fail-${crypto.randomBytes(6).toString('hex')}.ogg`);
          await fs.promises.writeFile(tmp, audio);
          sentWaId = await vProvider.sendAudio(contact.jid, {
            filePath: tmp,
            mimeType: 'audio/ogg; codecs=opus',
            fileName: 'reply.ogg',
          });
          sentType = 'audio';
          await fs.promises.unlink(tmp).catch(() => {});
        } catch (e) {
          logger.error(
            { err: e, contactId: contact.id },
            'voice: TTS failed for resend request — falling back to text',
          );
          sentWaId = await vProvider.sendText(contact.jid, VOICE_FALLBACK_TEXT);
          sentType = 'text';
        }
      } else {
        sentWaId = await vProvider.sendText(contact.jid, VOICE_FALLBACK_TEXT);
        sentType = 'text';
      }

      const clientId = `out_vfail_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      await prisma.message.create({
        data: {
          accountId: m.accountId, contactId: contact.id,
          direction: 'out', type: sentType, body: VOICE_FALLBACK_TEXT,
          clientMessageId: clientId,
          waMessageId: sentWaId ?? null, status: sentWaId ? 'sent' : 'pending',
          senderType: 'bot',
        },
      }).catch((e) => logger.warn({ err: e, contactId: contact.id }, 'voice: failed to persist fallback out row'));
      await prisma.contact.update({
        where: { id: contact.id },
        data: { lastOutgoingMessageAt: new Date(), lastInteractionAt: new Date() },
      }).catch(() => {});
      bus.emitEvent({ type: 'message.out', accountId: m.accountId, contactId: contact.id, messageId: '' });
      return;
    }
  }

  // Debounced engine dispatch — see comment on pendingReplyTimers above.
  const existing = pendingReplyTimers.get(contact.id);
  if (existing) {
    clearTimeout(existing);
    logger.info({ contactId: contact.id }, 'debounce: collapsed prior pending reply');
  }
  const timer = setTimeout(() => {
    pendingReplyTimers.delete(contact.id);
    dispatchEngineTurn(bot.id, m, contact).catch((e) =>
      logger.error({ err: e, contactId: contact.id }, 'dispatchEngineTurn failed'));
  }, REPLY_DEBOUNCE_MS);
  pendingReplyTimers.set(contact.id, timer);
}

/**
 * Decide which engine (AI / rule / hybrid) handles the customer's turn, based
 * on `BotAiConfig.engineMode`. Called from the debounce timer so the contact's
 * latest state (and any newer messages persisted in DB) are visible.
 */
async function dispatchEngineTurn(
  botId: string,
  m: IncomingMessage,
  contact: { id: string },
): Promise<void> {
  // Universal guardrails — stop-word, owner-intervention, daily cap, and the
  // per-contact pause flag. Applied here (before any engine mode branches)
  // so rule-only bots, hybrid welcome steps, AI turns, and order flow ALL
  // honor the operator's "Behavior and constraints" configuration equally.
  // Follow-ups run the same guard from FollowUpEngine's drain loop.
  const guard = await applyPreSendGuardrails({
    contactId: contact.id,
    botId,
    incomingText: m.text ?? null,
  });
  if (guard.block) return;

  const aiCfg = await prisma.botAiConfig.findUnique({ where: { botId } });
  // Resolve the effective engine mode. Defaults to 'hybrid' for new bots,
  // 'ai_only' for legacy rows where enabled=true was the only signal,
  // 'rule_only' otherwise.
  let engineMode = aiCfg?.engineMode ?? 'hybrid';
  if (!aiCfg) engineMode = 'rule_only';
  else if (aiCfg.engineMode == null) engineMode = aiCfg.enabled ? 'ai_only' : 'rule_only';

  if (engineMode === 'disabled') {
    logger.info({ contactId: contact.id }, 'engine: disabled — silent');
    return;
  }

  if (engineMode === 'ai_only') {
    logger.info({ contactId: contact.id, engineMode }, 'engine: routing to AI (ai_only)');
    return runAiTurn(botId, m, contact as any);
  }

  if (engineMode === 'rule_priority') {
    // Try the rule-bot matcher first. If a programmed step matches the
    // customer's message (option / exact / keyword), let the rule walk it.
    // Otherwise the AI runs as fallback — programmed messages take priority.
    const contactFull = await prisma.contact.findUnique({
      where: { id: contact.id },
      select: { currentStepId: true },
    });
    const current = contactFull?.currentStepId
      ? await StepMatcherService.getStep(contactFull.currentStepId)
      : null;
    const matched = await StepMatcherService.tryMatch(botId, current as any, m.text ?? '');
    if (matched) {
      logger.info(
        { contactId: contact.id, engineMode, stepId: matched.id },
        'engine: routing to rule (rule_priority match)',
      );
      return runRuleFlow(botId, m, contact, engineMode);
    }
    logger.info(
      { contactId: contact.id, engineMode },
      'engine: routing to AI (rule_priority — no rule match, AI fallback)',
    );
    return runAiTurn(botId, m, contact as any);
  }

  if (engineMode === 'hybrid') {
    const hadOut = await prisma.message.findFirst({
      where: { contactId: contact.id, direction: 'out' },
      select: { id: true },
    });
    if (hadOut) {
      logger.info(
        { contactId: contact.id, engineMode },
        'engine: routing to AI (hybrid, has prior outgoing)',
      );
      return runAiTurn(botId, m, contact as any);
    }
    logger.info(
      { contactId: contact.id, engineMode },
      'engine: routing to rule (hybrid, first contact — welcome)',
    );
    // fall through to rule welcome
  } else {
    logger.info(
      { contactId: contact.id, engineMode },
      'engine: routing to rule (rule_only)',
    );
  }

  // rule_only OR hybrid-on-first-contact
  return runRuleFlow(botId, m, contact, engineMode);
}

/**
 * The legacy rule-based reply path (welcome → match → walkStep). Extracted
 * from handleIncoming() so the dispatcher can call it cleanly per engineMode.
 */
async function runRuleFlow(
  botId: string,
  m: IncomingMessage,
  contact: any,
  engineMode: string = 'rule_only',
): Promise<void> {
  const settings = await SettingsService.load();
  // Per-bot fallback toggle. When false, the rule engine stays silent whenever
  // the customer's message doesn't match any programmed option/exact/keyword.
  // Preserve legacy behavior (true) when the row is missing entirely.
  //
  // OVERRIDE: in `rule_only` mode the fallback is ALWAYS off — the operator's
  // explicit intent for that mode is "bot answers programmed messages then
  // stays silent". Ignore whatever the per-bot toggle stores. Other modes
  // (hybrid on first contact) keep respecting the flag.
  const botSettings = await prisma.botSettings.findUnique({ where: { botId } });
  const fallbackEnabled =
    engineMode === 'rule_only'
      ? false
      : (botSettings?.fallbackEnabled ?? true);

  // global handover keywords (always evaluated; route to handover step)
  const text = m.text ?? '';
  const norm = normalizeText(text);
  if (settings.handover_keywords.some((kw) => norm.includes(normalizeText(kw)))) {
    return walkAndQueue(botId, m.accountId, contact.id, m.fromJid, await StepMatcherService.getHandoverStep(botId));
  }

  // Per-contact rate limit intentionally NOT enforced — operator rule:
  // the bot must reply to every customer message. Only the 3 allow-listed
  // silencers (daily cap, stop word, owner intervention) may block a reply.
  // The checkRate helper + rateBuckets map are kept in this file for a
  // possible future opt-in feature, but never called on the hot path.

  // 1) order-collection state takes precedence
  const orderState = OrderService.getState(contact);
  if (orderState && (orderState.currentField || orderState.awaitingConfirmation)) {
    return handleOrderInput(botId, m.accountId, contact.id, m.fromJid, text, orderState);
  }

  // 2) normal matching
  const current = contact.currentStepId
    ? await StepMatcherService.getStep(contact.currentStepId)
    : null;

  // Welcome: only on first contact (no currentStep, no prior outgoing) AND welcomeEnabled
  let target: { id: string } | null = null;
  if (!current && settings.welcome_enabled) {
    const hadOut = await prisma.message.findFirst({
      where: { contactId: contact.id, direction: 'out' },
      select: { id: true },
    });
    if (!hadOut) target = await StepMatcherService.getWelcomeStep(botId);
  }
  if (!target) target = await StepMatcherService.match(botId, current, text);

  // Silent-when-unmatched: if the matched target is the fallback step and the
  // operator has turned off fallback replies for this bot, bail out BEFORE the
  // failed-attempts counter so silence doesn't quietly promote to handover.
  if (target && !fallbackEnabled && (await isFallback(target.id))) {
    logger.info({ contactId: contact.id, botId }, 'rule: unmatched input; fallbackEnabled=false — staying silent');
    return;
  }

  // fallback attempt counter
  if (target && (await isFallback(target.id))) {
    const updated = await prisma.contact.update({
      where: { id: contact.id }, data: { failedAttempts: { increment: 1 } },
    });
    const settingsRow = await prisma.botSettings.findUnique({ where: { botId } });
    const max = settingsRow?.maxFailedAttempts ?? 3;
    if (updated.failedAttempts >= max) {
      const handover = await StepMatcherService.getHandoverStep(botId);
      if (handover) {
        await prisma.contact.update({ where: { id: contact.id }, data: { failedAttempts: 0 } });
        return walkAndQueue(botId, m.accountId, contact.id, m.fromJid, handover);
      }
    }
  } else if (target) {
    // success — reset attempts
    if (contact.failedAttempts > 0) {
      await prisma.contact.update({ where: { id: contact.id }, data: { failedAttempts: 0 } });
    }
  }

  if (!target) {
    // Respect the same per-bot toggle for the global-default-text path.
    if (fallbackEnabled && settings.default_fallback_text) {
      await sendRawText(m.accountId, contact.id, m.fromJid, settings.default_fallback_text);
    }
    return;
  }

  return walkAndQueue(botId, m.accountId, contact.id, m.fromJid, target);
}

async function isFallback(stepId: string): Promise<boolean> {
  const s = await prisma.botStep.findUnique({ where: { id: stepId }, select: { type: true } });
  return s?.type === 'fallback';
}

async function walkAndQueue(
  botId: string, accountId: string, contactId: string, jid: string,
  target: { id: string } | null
) {
  if (!target) return;
  const full = await StepMatcherService.getStep(target.id);
  if (!full) return;

  const settings = await SettingsService.load();
  const account = await prisma.whatsAppAccount.findUnique({ where: { id: accountId } });
  if (!account) return;
  const contact = await prisma.contact.findUnique({ where: { id: contactId } });
  const bot = await prisma.bot.findUnique({ where: { id: botId } });
  if (!contact || !bot) return;

  const provider = providerFor(accountId);

  await MessageQueueService.enqueue(accountId, async () => {
    if (settings.typing_simulation) {
      const headBlock = full.blocks.find((b) => b.enabled && (b.type === 'text' || b.type === 'options'));
      if (headBlock) {
        const len = (headBlock.content ?? '').length;
        await provider.simulateTyping(jid, Math.min(2500, Math.max(800, len * 25)));
      }
    }
    const w: WalkContext = {
      accountId, contactId, jid, botId,
      ctx: {
        contact: { name: contact.name, jid: contact.jid },
        bot: { name: bot.name },
        account: { name: account.name },
      },
      provider,
      persist: true,
    };
    await walkStep(full, w);
  }, {
    minDelayMs: settings.min_send_delay_ms,
    maxDelayMs: settings.max_send_delay_ms,
    dailyCap: account.dailySendCap,
    burstThreshold: settings.burst_threshold_count,
    burstWindowMin: settings.burst_window_minutes,
    burstCooldownSec: settings.burst_cooldown_seconds,
  });
}

async function sendRawText(
  accountId: string, contactId: string, jid: string, text: string,
  opts: { bypassDelay?: boolean; senderType?: 'admin' | 'bot' } = {}
) {
  const settings = await SettingsService.load();
  const account = await prisma.whatsAppAccount.findUnique({ where: { id: accountId } });
  if (!account) return;
  const provider = providerFor(accountId);
  await MessageQueueService.enqueue(accountId, async () => {
    const waId = await provider.sendText(jid, text);
    const msg = await prisma.message.create({
      data: {
        accountId, contactId, direction: 'out', type: 'text',
        body: text, waMessageId: waId ?? null, status: waId ? 'sent' : 'pending',
        senderType: opts.senderType ?? 'bot',
      },
    });
    bus.emitEvent({ type: 'message.out', accountId, contactId, messageId: msg.id });
  }, {
    minDelayMs: settings.min_send_delay_ms,
    maxDelayMs: settings.max_send_delay_ms,
    dailyCap: account.dailySendCap,
    burstThreshold: settings.burst_threshold_count,
    burstWindowMin: settings.burst_window_minutes,
    burstCooldownSec: settings.burst_cooldown_seconds,
    bypassDelay: opts.bypassDelay,
  });
}

/** Handles a customer's reply while we're collecting order fields. */
async function handleOrderInput(
  botId: string, accountId: string, contactId: string, jid: string,
  text: string, state: ReturnType<typeof OrderService.getState>
) {
  if (!state) return;

  // confirmation step
  if (state.awaitingConfirmation) {
    const num = extractOptionNumber(text);
    if (num === '1') {
      await OrderService.confirm(contactId, botId);
      await sendRawText(accountId, contactId, jid, 'تم تأكيد الطلب، شكرا لك. سنتواصل معك قريبا.');
      return;
    }
    if (num === '2') {
      await OrderService.cancel(contactId);
      await sendRawText(accountId, contactId, jid, 'تم الإلغاء. ابدأ من جديد إلا بغيتي تطلب.');
      return;
    }
    await sendRawText(accountId, contactId, jid, 'عافاك جاوب بـ 1 للتأكيد أو 2 للإلغاء.');
    return;
  }

  // collect current field, then ask next or summarize
  const { next, done, state: newState } = await OrderService.answer(contactId, text);
  if (next) {
    await sendRawText(accountId, contactId, jid, ORDER_QUESTIONS_AR[next]);
    return;
  }
  if (done) {
    const summary = OrderService.buildSummaryAr(newState);
    await sendRawText(accountId, contactId, jid, summary);
  }
}

/** Public wrapper kept for callers that want to send a free-form message
 *  through the engine (e.g., manual replies from the inbox). */
export async function manualSendText(
  accountId: string, contactId: string, jid: string, text: string,
  opts: { bypassDelay?: boolean } = {}
) {
  // Manual admin sends bypass the human-like delay by default — the admin is
  // already waiting and clicked send. Bot replies (campaign/follow-up) keep it.
  return sendRawText(accountId, contactId, jid, text, {
    bypassDelay: opts.bypassDelay ?? true,
    senderType: 'admin',
  });
}

/**
 * Dispatch a turn to the AI engine. Encapsulates the try/catch so the rule
 * flow can choose to skip or proceed cleanly. Returns true (handled).
 */
async function runAiTurn(botId: string, m: IncomingMessage, contact: { id: string }): Promise<void> {
  try {
    const { aiHandleIncoming } = await import('./aiEngine.js');
    const handled = await aiHandleIncoming({
      accountId: m.accountId,
      contactId: contact.id,
      jid: m.fromJid,
      botId,
      text: m.text ?? '',
    });
    if (handled) return;
  } catch (e) {
    logger.error({ err: e, botId }, 'AI engine threw — falling back to rule flow');
  }
}
