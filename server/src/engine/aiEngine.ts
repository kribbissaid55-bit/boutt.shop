/**
 * aiEngine — LLM-driven reply pipeline that takes over from the rule-based
 * walker when a bot has BotAiConfig.enabled=true.
 *
 * Per incoming message flow:
 *   1. Resolve the bot's AiConfig.
 *   2. If incoming is an audio block, transcribe via Whisper to plaintext.
 *   3. Build a chat context: system prompt + last N turns + the new user msg.
 *      The system prompt is augmented with collection-state context (which
 *      fields we still need from the customer) and stop-word instructions.
 *   4. Ask the model for two things in one JSON-mode call:
 *        - human reply text (in Moroccan dialect)
 *        - extracted updates to the order draft (name/phone/city/address/quantity)
 *   5. Persist order-draft updates onto the contact.
 *   6. If all required fields filled → send order summary to owner, mark contact.
 *   7. Dispatch the reply through the existing per-account queue:
 *        - replyMode='text' → sendText
 *        - replyMode='voice' → TTS → sendAudio
 *        - replyMode='auto' → AI also returns {mode:"voice"|"text"}
 *
 * Cross-cutting:
 *   - stopWord match → contact.botPaused=true forever, no reply
 *   - owner intervention check: if any admin Message in last N minutes, skip
 *   - maxRepliesPerSession: counter on contact; resets on order finalisation
 */
import { prisma } from '../lib/prisma.js';
import { logger } from '../config/logger.js';
import { AiProvider, type ChatMessage } from '../services/AiProvider.js';
import { providerFor } from '../adapters/whatsapp/providerFactory.js';
import { MessageQueueService } from '../services/MessageQueueService.js';
import { SettingsService } from '../services/SettingsService.js';
import { MediaService } from '../services/MediaService.js';
import { bus } from '../services/EventBus.js';
import { CloudApiService } from '../services/CloudApiService.js';
import { phoneFromJid, resolveContactPhone } from '../lib/jid.js';
import { toMoroccanLocal } from '../services/phone.js';
import { sleep } from '../lib/retry.js';
import { syncTagsForContact, deriveStatus } from '../services/CustomerTagService.js';
import { safeParseObject } from '../lib/safe-parse.js';
import { computeReplyDelayMs } from '../lib/replyDelay.js';
import { buildLayeredSystemMessage } from './buildSystemMessage.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { IncomingMessage } from '../adapters/whatsapp/types.js';

// Default. Per-bot override via BotAiConfig.historyTurns.
const DEFAULT_HISTORY_TURNS = 12;

// Final closing line sent to the customer right after `order_done=true`.
// Per-bot override via BotAiConfig.postOrderThanksMessage (null → this default).
export const DEFAULT_POST_ORDER_THANKS =
  'شكرا على إتمام الطلب 🌹\nسيتصل بك الموصل لكي تستلم طلبك في غضون يوم إلى يومين.\nالمرجو الانتباه لهاتفك.';

// Hard cap on every text reply the bot sends to the customer. WhatsApp
// messages are casual — long walls read as bot-like and hurt conversion.
// The persona prompt asks the LLM to stay short; this is the enforcement.
const REPLY_MAX_CHARS = 300;

// Canned fallback bodies — never let these leak back into the LLM chat
// history or into `recentAiQuestions`. Otherwise the LLM sees a stream of
// "please rephrase" as the assistant's persona and locks itself into an
// infinite loop of empty responses (which then re-emit "please rephrase").
const CANNED_FALLBACK_BODIES = new Set<string>([
  'عفاك ممكن تعاود صياغة سؤالك؟ ما فهمتش بالضبط شنو بغيتي.',
  'في الخدمة 🌹',
  'عفاك رني مسمعتش مزيان هاد الأوديو، ممكن تعاود تسجّل واحد أوضح باش نفهم مزيان؟',
]);
function isCannedFallback(body: string | null | undefined): boolean {
  return !!body && CANNED_FALLBACK_BODIES.has(body.trim());
}

function truncateReply(text: string, max = REPLY_MAX_CHARS): string {
  const s = (text ?? '').trim();
  if (s.length <= max) return s;
  const slice = s.slice(0, max - 1);
  const lastSpace = slice.lastIndexOf(' ');
  // Prefer word-boundary cut only if it saves >40% of the budget — otherwise
  // hard-cut so we don't lose too much content to a single early space.
  const cut = lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}

// Customer explicitly asking for a resend. Matches common Arabic (fusha +
// darija), French, and English phrasings. If it hits, the media-dedup filter
// is bypassed for THIS turn only.
const RESEND_RE = /(ما\s?وصل|اعد\s?الارسال|أعد\s?الإرسال|رجع(ها|و|يه)?\s?لي|بعث(ها|و)?\s?مرة|ارسل\s?من\s?جديد|resend|send\s?again|renvoi|retransmet)/i;

// Whole-message confirmation words — Arabic (fusha + darija), French, English.
// Intentionally strict: whole-message match with only trailing punctuation.
// This prevents "ok مافي شي" (yes-but…) or "yes but change the name" from
// firing false finalization. Used by the engine yes/no fallback after the
// bot sent the summary template.
const CONFIRM_RE = /^(نعم|ايه|أيه|صح|صحيح|أكد|اكد|أكدلي|اكدلي|تمام|موافق|واخا|واخى|صافي|ok|okay|oui|d'accord|yes|yep)[\s.!?،]*$/i;

function isResendRequest(text: string | null | undefined): boolean {
  if (!text) return false;
  return RESEND_RE.test(text);
}

async function wasMediaSent(contactId: string, mediaId: string): Promise<boolean> {
  const hit = await prisma.message.findFirst({
    where: { contactId, mediaId, direction: 'out' },
    select: { id: true },
  });
  return !!hit;
}

export type OrderDraft = {
  name?: string; phone?: string; city?: string; address?: string;
  quantity?: string; notes?: string; finalized?: boolean;
  // Set to true once all required fields are collected AND the customer has
  // been shown the text summary + explicit confirmation ask. Cleared when
  // the customer either confirms (→ finalized=true) or modifies (→ let LLM
  // re-collect, then re-enter the summary loop). Prevents auto-finalisation
  // in voice mode (where the LLM might set order_done without ever showing
  // the summary) and forces an explicit human confirmation for EVERY order.
  awaitingConfirm?: boolean;
};

// Sent as the "thanks" body of the pre-finalisation summary. Kept in Darija
// to match the operator's Moroccan audience. The customer sees the summary
// card above this ask, then replies with a CONFIRM_RE word to finalise.
const ORDER_CONFIRM_ASK =
  'باش نأكد ليك الطلب، اقرا المعلومات فوق ثم جاوب:\n' +
  '• «نعم» أو «صح» → نأكد الطلب\n' +
  '• أو صحّح المعلومة اللي غير صحيحة';

export type InstructionMediaItem = { id: string; label: string; note?: string };

export function parseInstructionMedia(s: string | null | undefined): InstructionMediaItem[] {
  if (!s) return [];
  try {
    const arr = JSON.parse(s);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((it) => it && typeof it.id === 'string' && typeof it.label === 'string' && it.label.trim())
      .map((it) => ({ id: it.id, label: String(it.label).trim(), note: it.note ? String(it.note) : undefined }));
  } catch { return []; }
}

export function buildInstructionMediaBlock(items: InstructionMediaItem[]): string {
  if (!items.length) return '';
  const lines = items.map((it) =>
    it.note
      ? `  - label: "${it.label}" — ملاحظة: "${it.note}"`
      : `  - label: "${it.label}"`
  );
  return [
    `📎 ملفات تحت أمرك (أرسلها وقتما تراها مناسبة حسب التعليمات أعلاه):`,
    ...lines,
    `لإرسال إحداها، ضع التسمية (label) ضمن send_media_ids في JSON الرد.`,
  ].join('\n');
}

export function resolveMediaRef(ref: string, items: InstructionMediaItem[]): string {
  const trimmed = (ref ?? '').trim();
  if (!trimmed) return trimmed;
  const byLabel = items.find((it) => it.label === trimmed);
  if (byLabel) return byLabel.id;
  return trimmed; // fallback: assume it's already a raw MediaFile.id
}

function parseDraft(s: string | null | undefined): OrderDraft {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}

interface AiHandleContext {
  accountId: string;
  contactId: string;
  jid: string;
  botId: string;
  text: string;            // already-transcribed if voice
  /** Original full message — used to fetch attached audio when transcribing. */
  raw?: IncomingMessage;
}

/**
 * Returns true if the message was handled by the AI engine. False = caller
 * should fall through to the rule-based flow.
 */
export async function aiHandleIncoming(c: AiHandleContext): Promise<boolean> {
  const cfg = await prisma.botAiConfig.findUnique({ where: { botId: c.botId } });
  if (!cfg || !cfg.enabled) return false;

  // Behavior & constraint guardrails (stop-word, owner-intervention, daily cap
  // per-customer, contact.botPaused) live in `preSendGuardrails.ts` and run
  // once at the top of the dispatcher (`dispatchEngineTurn`) so every routing
  // path — rule-only, hybrid welcome, AI turns, follow-ups — honors them
  // uniformly. If we got here, guardrails already passed.

  // Build conversation history. We over-fetch, then drop canned-fallback
  // bodies (see CANNED_FALLBACK_BODIES) — otherwise the LLM's own past
  // "please rephrase" messages become part of its persona and feed a
  // silent-response loop.
  const historyRaw = await prisma.message.findMany({
    where: { contactId: c.contactId },
    orderBy: { createdAt: 'desc' },
    take: Math.max(1, Math.min(100, (cfg.historyTurns ?? DEFAULT_HISTORY_TURNS) * 2)),
    select: { direction: true, body: true, type: true, senderType: true },
  });
  historyRaw.reverse();
  const history = historyRaw
    .filter((m) => !(m.direction === 'out' && m.senderType === 'bot' && isCannedFallback(m.body)))
    .slice(-Math.max(1, Math.min(50, cfg.historyTurns ?? DEFAULT_HISTORY_TURNS)));

  // Reply-mode resolution — operator's intent is absolute. Computed early so
  // we can route the chat call to a different LLM provider for TEXT replies
  // when the operator configured an override (see `voiceChatProvider` /
  // `voiceChatModel` below — the DB column name is historical; semantically
  // it's now the "override for text replies", while the main provider serves
  // voice turns and any text turn without an override).
  //   cfg.replyMode = 'text'  → text always
  //   cfg.replyMode = 'voice' → voice always
  //   cfg.replyMode = 'auto'  → mirror the LAST persisted incoming message
  const lastIncoming = history.filter((m) => m.direction === 'in').slice(-1)[0];
  const lastWasAudio = lastIncoming?.type === 'audio';
  // `let` (not `const`) so the finalize block below can override to 'text' —
  // order summaries are mandatory-text (Rule 2) even on voice-mode bots.
  let replyMode: 'text' | 'voice' =
    cfg.replyMode === 'voice' ? 'voice' :
    cfg.replyMode === 'text'  ? 'text'  :
    /* 'auto' or undefined */   (lastWasAudio ? 'voice' : 'text');

  // Daily-cap enforcement moved to preSendGuardrails.ts — a single source
  // of truth applied to rule-only, welcome, AI, and follow-up paths alike.

  const contact = await prisma.contact.findUnique({ where: { id: c.contactId } });
  if (!contact) return false;
  const draft = parseDraft((contact as any).aiOrderDraft);

  // Post-order silence short-circuit intentionally REMOVED — operator rule:
  // bot must reply to every customer message. The `continueAfterOrder` flag
  // now only influences TONE (via postOrderQuiet below → LLM told to reply
  // briefly with "في الخدمة 🌹" on greetings). The bot always answers.

  // ─── Build system + chat ─────────────────────────────────────────────
  // Layered system prompt — shared with the preview test endpoint so the
  // operator's "what I see in the test" matches "what a real customer gets".
  const catalog = await buildCatalogContext(c.botId);
  const instructionMedia = parseInstructionMedia((cfg as any).instructionMedia);
  const stageKey = deriveStatus({
    status: contact.status,
    lastIncomingMessageAt: contact.lastIncomingMessageAt,
    lastOutgoingMessageAt: contact.lastOutgoingMessageAt,
    aiOrderDraft: (contact as any).aiOrderDraft ?? null,
  });
  // Pull the last 3 AI replies that contained a question — used to tell the
  // LLM "you already asked this, don't repeat it".
  const recentAiQuestions = history
    .filter((m) => m.direction === 'out' && m.senderType === 'bot' && m.body && m.body.includes('؟'))
    .slice(-3)
    .map((m) => (m.body ?? '').trim())
    .filter(Boolean);
  // Quiet mode kicks in only when the order is finalized AND operator allows
  // post-order replies. If continueAfterOrder=false, the early-return at line
  // ~176 already silences the bot entirely.
  const postOrderQuiet = !!(draft.finalized && cfg.continueAfterOrder);
  const sys: ChatMessage = {
    role: 'system',
    content: buildLayeredSystemMessage({
      cfg, draft, catalog, instructionMedia, stage: stageKey,
      recentAiQuestions, postOrderQuiet,
    }),
  };
  const chat: ChatMessage[] = [sys];
  for (const m of history) {
    chat.push({
      role: m.direction === 'in' ? 'user' : 'assistant',
      content: m.body ?? (m.type !== 'text' ? `[${m.type}]` : ''),
    });
  }
  chat.push({ role: 'user', content: c.text });

  let result: {
    reply?: string;
    mode?: 'text' | 'voice';
    draft_updates?: Record<string, string>;
    use_wa_phone?: boolean;
    order_done?: boolean;
    send_media_ids?: string[];
  } = {};
  // Dual-provider routing. The override targets TEXT turns — operator's
  // mental model: main = voice (high-quality speech model), override = text
  // (cheap / fast). Voice turns keep the main provider/model. Historical DB
  // column name `voiceChatProvider` is preserved to avoid a schema
  // migration; semantically it's the text-override.
  const textOverrideProvider = (cfg as any).voiceChatProvider as string | null | undefined;
  const textOverrideModel = (cfg as any).voiceChatModel as string | null | undefined;
  const useTextOverride = replyMode === 'text' && !!textOverrideProvider && !!textOverrideModel;
  const chatProvider = useTextOverride ? textOverrideProvider! : cfg.provider;
  const chatModel    = useTextOverride ? textOverrideModel!    : cfg.model;
  // Raw LLM response captured for the fallback log — helps the operator
  // diagnose whether canned-fallback fires because the LLM returned empty,
  // returned an unexpected shape, or the auth/quota check failed.
  let rawText = '';
  let rawTokenUsage: { input?: number; output?: number } | undefined;
  try {
    const doChat = async (opts: { nudge?: string; plainTextOnly?: boolean } = {}) => {
      const messages = opts.nudge
        ? [...chat, { role: 'user' as const, content: opts.nudge }]
        : chat;
      return AiProvider.chat(chatProvider, {
        messages,
        model: chatModel,
        // Lower default (0.4) than the previous 0.7 — keeps answers polished
        // and consistent, especially during order collection. Operator can
        // raise via BotAiConfig.chatTemperature.
        temperature: cfg.chatTemperature ?? 0.4,
        maxTokens: 600,
        responseJsonSchema: { type: 'object' },
        plainTextOnly: opts.plainTextOnly,
      });
    };
    let res = await doChat();
    rawText = res.text ?? '';
    rawTokenUsage = res.tokenUsage;
    result = res.parsed ?? safeParseObject(res.text) ?? { reply: res.text };
    // One-shot retry when the first pass came back genuinely empty. DeepSeek's
    // `json_object` mode routinely returns `{}` on short casuals ("كك", "تل",
    // "م", ambiguous phrases) — the schema is satisfied but there's no `reply`.
    // The retry drops `response_format` (plainTextOnly:true) so DeepSeek is
    // free to answer in free-form text; we then use the whole response as the
    // reply. Structured fields like draft_updates are intentionally NOT
    // extracted on retry — for these short casual turns there's nothing worth
    // updating, we just want to keep the conversation alive.
    const firstReplyEmpty = !((result.reply ?? '').trim());
    const firstMediaEmpty = !((result.send_media_ids ?? []).length);
    if (firstReplyEmpty && firstMediaEmpty) {
      logger.info(
        { contactId: c.contactId, provider: chatProvider, model: chatModel },
        'AI: first pass returned empty — retrying in plain-text mode (attempt: 2)',
      );
      const nudge = 'ردّك السابق كان فارغاً. أعطِ الآن ردّاً نصيّاً قصيراً ولطيفاً بالدارجة المغربية يستمر المحادثة (نص عادي بدون JSON).';
      res = await doChat({ nudge, plainTextOnly: true });
      rawText = res.text ?? rawText;
      rawTokenUsage = res.tokenUsage ?? rawTokenUsage;
      // Plain-text mode → the raw response IS the reply. Do NOT run it through
      // safeParseObject (would silently swallow non-JSON text and lose it).
      result = { reply: (res.text ?? '').trim() };
    }
  } catch (e: any) {
    // Sanitize the error message for the log — keep the provider/model and
    // HTTP status visible so the operator can grep and diagnose without
    // leaking credentials.
    const errMsg = (e?.message ?? String(e)).slice(0, 300);
    logger.error(
      { err: errMsg, provider: chatProvider, model: chatModel, contactId: c.contactId },
      'AI chat failed — LLM call errored; falling back to rule engine',
    );
    return false; // let rule-based flow try
  }

  let replyText = truncateReply(result.reply ?? '');
  const updates = result.draft_updates ?? {};
  // Disabled-field scrub — belt-and-suspenders enforcement of operator toggles.
  // Even if the LLM ignores the strict prompt and tries to write a disabled
  // field, the persisted draft never records it. The mapping mirrors
  // buildCollectionPrompt().
  const disabledKeys: (keyof OrderDraft)[] = [];
  if (!cfg.collectName)     disabledKeys.push('name');
  if (!cfg.collectPhone)    disabledKeys.push('phone');
  if (!cfg.collectCity)     disabledKeys.push('city');
  if (!cfg.collectAddress)  disabledKeys.push('address');
  if (!cfg.collectQuantity) disabledKeys.push('quantity');
  for (const k of disabledKeys) {
    if (k in updates) {
      logger.info({ contactId: c.contactId, field: k }, 'AI: scrubbed draft_update for disabled field');
      delete (updates as any)[k];
    }
  }

  // Phone handling — the engine, NOT the LLM, owns digit extraction.
  //   1. If the customer said "use this WA number" the LLM signals via
  //      use_wa_phone=true. We pull digits from the JID and skip whatever
  //      the LLM might have hallucinated into updates.phone.
  //   2. Whatever phone makes it through (whether engine-supplied or LLM-
  //      supplied from the customer's typed number) gets normalized to
  //      Moroccan local format "0XXXXXXXXX" before persistence.
  let usedWaPhone = false;
  if (result.use_wa_phone === true && cfg.collectPhone) {
    // Resolves phone from contact.phoneJid when the jid is @lid; returns null
    // if we don't yet have a real phone (never fabricates from LID digits).
    const waPhone = resolveContactPhone(contact);
    const local = waPhone ? toMoroccanLocal(waPhone) : null;
    if (local) {
      updates.phone = local;
      usedWaPhone = true;
    } else {
      logger.info(
        { contactId: c.contactId, jid: contact.jid },
        'use_wa_phone: no phone available (LID with no senderPn) — persona should re-ask',
      );
    }
  }
  if (typeof updates.phone === 'string') {
    const local = toMoroccanLocal(updates.phone);
    if (local) updates.phone = local;
  }

  let newDraft: OrderDraft = { ...draft, ...updates };
  if (usedWaPhone) {
    (newDraft as any).phoneFromWA = true;
  } else if (typeof updates.phone === 'string' && (draft as any).phoneFromWA) {
    // Customer typed a different number on top of the WA pick — drop the tag.
    delete (newDraft as any).phoneFromWA;
  }

  // Save draft updates
  if (Object.keys(updates).length) {
    await prisma.contact.update({
      where: { id: c.contactId },
      data: { aiOrderDraft: JSON.stringify(newDraft) } as any,
    });
  }

  // ─── Two-step confirmation state machine ─────────────────────────────
  //
  // Before finalisation, the customer MUST see the summary + explicitly
  // confirm. This closes the voice-mode bug where the LLM could set
  // `order_done=true` on its own without the customer ever seeing a summary.
  //
  // Path A — awaiting + confirm word → finalise (below block).
  // Path B — awaiting + non-confirm text → clear flag, let LLM handle
  //          (usually a field modification; a fresh summary is shown
  //          again next turn once all fields are still present).
  // Path C — ready but not yet awaiting → intercept: replace LLM reply
  //          with a TEXT summary + explicit ask. Set flag. Owner not
  //          notified this turn.
  const readyForConfirm = cfg.collectionEnabled && hasAllRequired(cfg, newDraft) && !newDraft.finalized;
  const customerText = (c.text ?? '').trim();
  const customerConfirmed = CONFIRM_RE.test(customerText);
  let finalised = false;

  if (readyForConfirm && newDraft.awaitingConfirm && customerConfirmed) {
    // Path A — confirmed. Fall through to finalisation block.
    finalised = true;
  } else if (readyForConfirm && newDraft.awaitingConfirm && !customerConfirmed) {
    // Path B — modification. Clear the flag and let the LLM's normal reply
    // pass through. Next turn re-enters Path C if fields are still complete.
    newDraft.awaitingConfirm = false;
    await prisma.contact.update({
      where: { id: c.contactId },
      data: { aiOrderDraft: JSON.stringify(newDraft) } as any,
    });
    logger.info({ contactId: c.contactId, customerText }, 'AI: order-confirm cleared by modification');
  } else if (readyForConfirm && !newDraft.awaitingConfirm) {
    // Path C — first time all fields present. Show summary + ask, don't
    // finalise. Rule 2: text-mode even on voice bots.
    newDraft.awaitingConfirm = true;
    await prisma.contact.update({
      where: { id: c.contactId },
      data: { aiOrderDraft: JSON.stringify(newDraft) } as any,
    });
    logger.info({ contactId: c.contactId, botId: c.botId }, 'AI: order pre-confirm summary sent');
    replyText = buildOrderSummary(cfg, newDraft, ORDER_CONFIRM_ASK);
    replyMode = 'text';
    (result as any).send_media_ids = [];
  }

  // Belt-and-suspenders fallback. Kept for the edge case where Path C ran
  // on a prior turn, the customer confirmed, but `awaitingConfirm` got lost
  // (e.g. a manual DB edit or a race between updates). Requires all three
  // guards: fields complete, whole-message confirmation, prior summary in
  // outgoing history.
  if (!finalised && !newDraft.awaitingConfirm && cfg.collectionEnabled && hasAllRequired(cfg, newDraft)) {
    if (CONFIRM_RE.test(customerText)) {
      const lastOut = await prisma.message.findFirst({
        where: { contactId: c.contactId, direction: 'out' },
        orderBy: { createdAt: 'desc' },
        select: { body: true },
      });
      if (lastOut?.body?.includes('ملخص الطلب')) {
        logger.info(
          { contactId: c.contactId, customerText },
          'AI: engine confirmation fallback fired (awaitingConfirm was lost)',
        );
        finalised = true;
      }
    }
  }

  if (finalised) {
    newDraft.finalized = true;
    newDraft.awaitingConfirm = false;
    await prisma.contact.update({
      where: { id: c.contactId },
      data: { aiOrderDraft: JSON.stringify(newDraft), status: 'ordered' } as any,
    });

    // Owner-notify with explicit diagnostics — the operator can grep the log
    // to see WHY the owner wasn't notified when they expected to be.
    if (!cfg.notifyOwnerEnabled) {
      logger.warn(
        { botId: c.botId, contactId: c.contactId },
        'AI: order finalised but notifyOwnerEnabled=false — owner NOT notified',
      );
    } else if (!cfg.ownerPhone) {
      logger.warn(
        { botId: c.botId, contactId: c.contactId },
        'AI: order finalised but ownerPhone is empty — owner NOT notified (set BotAiConfig.ownerPhone)',
      );
    } else {
      forwardOrderToOwner(cfg.ownerPhone, c.accountId, contact, newDraft).catch((e) =>
        logger.error({ err: e, ownerPhone: cfg.ownerPhone, contactId: c.contactId }, 'AI: forwardOrderToOwner failed'));
    }
    // Promote the chip/label to "ordered" immediately so the operator sees it
    // even if no further outgoing send happens this turn.
    void syncTagsForContact(c.botId, c.accountId, c.contactId);

    // Deterministic closing — replace whatever the LLM emitted on the
    // confirmation turn with a WRITTEN order summary + operator's thanks
    // (or DEFAULT_POST_ORDER_THANKS). The customer's last touchpoint is a
    // brand-critical promise + a receipt they can screenshot/reference —
    // never let it drift to LLM freestyle.
    //
    // Rule 2: this summary MUST be sent as TEXT even on voice-mode bots.
    // We override replyMode='text' and drop any pending media so the whole
    // turn is one clean text bubble containing the summary. Next customer
    // turn returns to the operator-configured mode.
    const customThanks = ((cfg as any).postOrderThanksMessage ?? '').trim();
    const thanks = customThanks || DEFAULT_POST_ORDER_THANKS;
    // Guarantee the customer's LAST touchpoint carries ✅ so both the
    // customer AND the follow-up engine can spot the "sold" marker. Don't
    // double-append if the operator's custom thanks already ends with it.
    const thanksWithMark = /✅\s*$/.test(thanks) ? thanks : `${thanks} ✅`;
    replyText = buildOrderSummary(cfg, newDraft, thanksWithMark);
    replyMode = 'text';
    // Also drop any pending media the LLM emitted on the confirmation turn.
    // The summary IS the whole turn — no product images tacked on.
    (result as any).send_media_ids = [];
  }

  // ─── Dispatch the reply ─────────────────────────────────────────────
  const account = await prisma.whatsAppAccount.findUnique({ where: { id: c.accountId } });
  if (!account) return true;
  const settings = await SettingsService.load();
  const provider = providerFor(c.accountId);
  // replyMode was resolved upstream (right after history.reverse) so we could
  // pick the right LLM provider for voice turns. It's still in scope here.

  // Never-resend-the-same-media rule.
  // The LLM may still emit an id we've already sent to this contact (LLMs
  // forget). Resolve + filter BEFORE we enter the send queue so the queue
  // stays fast, and so the "no text + only dupes" case can short-circuit.
  // The customer can bypass the dedup by asking explicitly ("ما وصلاتني" /
  // "أعد الإرسال" / "resend"...) — see RESEND_RE.
  const allowResend = isResendRequest(c.text);
  const rawRefs = (result.send_media_ids ?? []).slice(0, 5);
  const sendables: { ref: string; id: string }[] = [];
  for (const ref of rawRefs) {
    const id = resolveMediaRef(ref, instructionMedia);
    if (!id) continue;
    if (!allowResend && await wasMediaSent(c.contactId, id)) {
      logger.info({ contactId: c.contactId, mediaId: id, ref }, 'AI: skipped duplicate media send');
      continue;
    }
    sendables.push({ ref, id });
  }

  if (!replyText && !sendables.length) {
    // Never-silent policy: rather than returning without a reply (which the
    // operator experiences as "the site stops answering"), fall back to a
    // short canned prompt. Which one depends on where we are in the flow:
    //
    // • Post-order quiet mode → the LLM was TOLD to stay minimal on
    //   greetings/thanks/etc. Matching the system prompt's own instruction
    //   ("رد بكلمة واحدة 'في الخدمة 🌹' على التحيات"), we send a warm
    //   short line instead of asking a paid customer to rephrase.
    // • Otherwise → keep the classic "please rephrase" clarify — for a
    //   fresh conversation where the LLM genuinely can't parse the input.
    if (postOrderQuiet) {
      replyText = 'في الخدمة 🌹';
    } else {
      replyText = 'عفاك ممكن تعاود صياغة سؤالك؟ ما فهمتش بالضبط شنو بغيتي.';
    }
    // Diagnostic log: capture enough context for the operator to grep this
    // line and know instantly WHY the canned fired. Raw LLM text (truncated),
    // token usage, which provider/model, the stage, and what the customer
    // actually sent. Without this we're flying blind on every canned reply.
    logger.info(
      {
        contactId: c.contactId,
        provider: chatProvider,
        model: chatModel,
        postOrderQuiet,
        stage: stageKey,
        customerText: (c.text ?? '').slice(0, 200),
        rawLlmText: rawText.slice(0, 500),
        tokenUsage: rawTokenUsage,
      },
      'AI: LLM returned neither reply text nor media — sending canned',
    );
  }

  // Human-touch delay — wait before the reply is QUEUED so multiple
  // conversations wait in parallel. Sleeping INSIDE the enqueue callback
  // would serialize every other conversation on this account behind us.
  // First-vs-subsequent is signalled by `contact.lastOutgoingMessageAt`
  // (null == the bot has never sent to this contact before). Defaults are
  // 0 → no-op for existing bots.
  const isFirstReply = contact.lastOutgoingMessageAt == null;
  const preSendWaitMs = computeReplyDelayMs(isFirstReply
    ? { min: (cfg as any).firstReplyDelaySeconds ?? 0,
        max: (cfg as any).firstReplyDelayMaxSeconds ?? 0,
        rnd: (cfg as any).firstReplyRandomize ?? false }
    : { min: (cfg as any).replyDelaySeconds ?? 0,
        max: (cfg as any).replyDelayMaxSeconds ?? 0,
        rnd: (cfg as any).replyRandomize ?? false });
  if (preSendWaitMs > 0) {
    logger.debug(
      { contactId: c.contactId, isFirstReply, waitMs: preSendWaitMs },
      'AI: pre-send human-touch delay',
    );
    await sleep(preSendWaitMs);
  }

  await MessageQueueService.enqueue(c.accountId, async () => {
    // Rule 1 — ONE message per customer turn. No exceptions.
    //
    // Decision matrix (never emits more than one send):
    //   voice mode + replyText            → one voice-note (TTS of replyText).
    //                                       Any media the LLM tried to attach
    //                                       is DROPPED (voice + media = 2
    //                                       messages, not allowed).
    //   voice mode + !replyText + media   → send only sendables[0] uncaptioned.
    //   text mode  + media                → send only sendables[0] with
    //                                       replyText as caption (if any).
    //                                       Extra media in sendables[1..] are
    //                                       dropped.
    //   text mode  + !media + replyText   → one text bubble.
    //
    // The canned-fallback upstream guarantees replyText is populated when
    // both are empty, so the else-branch of "no send" only fires in ai_only
    // mode when the customer's inbound was itself empty.
    const droppedExtras = Math.max(0, sendables.length - 1);
    if (replyMode === 'voice' && replyText) {
      if (sendables.length > 0) {
        logger.info(
          { contactId: c.contactId, dropped: sendables.length },
          'AI: voice mode + media → dropped media (Rule 1: one message per turn)',
        );
      }
      try {
        // Humanize: pretend to "record" before sending the voice note.
        await provider.simulateTyping(c.jid, Math.min(3000, 800 + Math.floor(Math.random() * 2200)));
        const audio = await AiProvider.tts(replyText, {
          voice: cfg.voiceId,
          provider: cfg.voiceProvider,
          instructions: cfg.voiceInstructions ?? undefined,
          quality: (cfg.voiceQuality === 'hd' ? 'hd' : 'standard'),
          voiceStability: cfg.voiceStability ?? undefined,
          voiceSimilarityBoost: cfg.voiceSimilarityBoost ?? undefined,
          voiceStyle: (cfg as any).voiceStyle ?? undefined,
          voiceModelId: (cfg as any).voiceModelId ?? undefined,
        });
        const tmp = path.join(os.tmpdir(), `ai-${crypto.randomBytes(6).toString('hex')}.ogg`);
        await fs.promises.writeFile(tmp, audio);
        const waId = await provider.sendAudio(c.jid, {
          filePath: tmp,
          mimeType: 'audio/ogg; codecs=opus',
          fileName: 'reply.ogg',
        });
        await persistAiOut(c, 'audio', replyText, undefined, waId);
        await fs.promises.unlink(tmp).catch(() => {});
      } catch (e) {
        logger.error({
          err: e,
          voiceProvider: cfg.voiceProvider,
          voiceId: cfg.voiceId,
          voiceModelId: (cfg as any).voiceModelId,
        }, 'AI tts failed — falling back to text. Check credentials + voice id.');
        const waId = await provider.sendText(c.jid, replyText);
        await persistAiOut(c, 'text', replyText, undefined, waId);
      }
      return;
    }

    if (sendables.length > 0) {
      // Text mode with media (or voice mode with no text): send exactly ONE
      // media, with replyText as caption when in text mode.
      const { ref, id } = sendables[0];
      const caption = (replyMode === 'text' && replyText) ? replyText : undefined;
      if (droppedExtras > 0) {
        logger.info(
          { contactId: c.contactId, kept: ref, dropped: droppedExtras },
          'AI: multiple media → sent first only (Rule 1: one message per turn)',
        );
      }
      try { await sendCatalogMedia(c, provider, id, caption); }
      catch (e) { logger.warn({ err: e, ref, id }, 'AI: send_media_ids item failed'); }
      return;
    }

    if (!replyText) return;

    // Text mode, no media → one text bubble.
    const typingMs = Math.min(3500, 400 + replyText.length * 25);
    await provider.simulateTyping(c.jid, typingMs);
    const waId = await provider.sendText(c.jid, replyText);
    await persistAiOut(c, 'text', replyText, undefined, waId);
  }, {
    minDelayMs: settings.min_send_delay_ms,
    maxDelayMs: settings.max_send_delay_ms,
    dailyCap: account.dailySendCap,
    burstThreshold: settings.burst_threshold_count,
    burstWindowMin: settings.burst_window_minutes,
    burstCooldownSec: settings.burst_cooldown_seconds,
    warmupEnabled: settings.warmup_enabled,
  }).catch((e) => logger.warn({ err: e }, 'AI reply enqueue failed'));

  return true;
}

async function persistAiOut(c: AiHandleContext, type: string, body: string, mediaId: string | undefined, waMessageId: string | undefined) {
  const clientId = `out_ai_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const msg = await prisma.message.create({
    data: {
      accountId: c.accountId, contactId: c.contactId,
      direction: 'out', type, body,
      mediaId: mediaId ?? null, clientMessageId: clientId,
      waMessageId: waMessageId ?? null, status: waMessageId ? 'sent' : 'pending',
      senderType: 'bot',
    },
  });
  await prisma.contact.update({
    where: { id: c.contactId },
    data: { lastOutgoingMessageAt: new Date(), lastInteractionAt: new Date() },
  }).catch(() => {});
  bus.emitEvent({ type: 'message.out', accountId: c.accountId, contactId: c.contactId, messageId: msg.id });
  // Reconcile the customer status tag (admin chip + WA chat label). Fire-and-
  // forget; the service swallows its own errors so the send path stays clean.
  void syncTagsForContact(c.botId, c.accountId, c.contactId);
}

export function buildCollectionPrompt(cfg: any, draft: OrderDraft): string {
  // Strict asking order: name → phone → city → address → quantity.
  // This matches the BotAiTab UI numbering so the LLM never "skips ahead".
  type FieldDef = { flag: string; key: keyof OrderDraft; label: string };
  const ALL: FieldDef[] = [
    { flag: 'collectName',     key: 'name',     label: 'الاسم الكامل' },
    { flag: 'collectPhone',    key: 'phone',    label: 'رقم الهاتف' },
    { flag: 'collectCity',     key: 'city',     label: 'المدينة' },
    { flag: 'collectAddress',  key: 'address',  label: 'العنوان' },
    { flag: 'collectQuantity', key: 'quantity', label: 'الكمية' },
  ];
  const active = ALL.filter((f) => !!cfg[f.flag]);
  const disabled = ALL.filter((f) => !cfg[f.flag]);
  const missing = active.filter((f) => !draft[f.key]);

  if (!missing.length) {
    // Build the summary block SERVER-SIDE with the customer's real values.
    // The LLM's only job is to emit this block verbatim — no paraphrase,
    // no "let me summarize", no extra chatter. Kills the drift where the
    // LLM writes prose instead of the ✅ card the operator expects.
    const summaryLines = active
      .filter((f) => draft[f.key])
      .map((f) => `${f.label}: ${draft[f.key]}`);
    const summaryBlock =
      '✅ ملخص الطلب\n─────────────\n' +
      summaryLines.join('\n') +
      '\n─────────────\nواش كل المعلومات لي فوق صحيحة؟';

    return `كل الحقول المطلوبة جُمعت.
🔒 هاد الدورة: أرسل للعميل ملخص الطلب بالحرف — كوبي/بايست القالب هذا في replyك ما تغير فيه والو:

${summaryBlock}

قواعد صارمة على هذا الرد:
- ابعث القالب كما هو، سطراً بسطر. بدون شرح إضافي، بدون تحية، بدون تعليق قبل ولا بعد.
- ما تعيد صياغة كأنه نص عادي — القالب لازم يبان كبطاقة منظمة بالخطوط ─────.
- انتظر جواب العميل. لا تفترض الموافقة، لا تُرسل order_done=true في هذي الدورة.

بمجرد جواب العميل في الدورة الموالية:
- إذا رد بـ«نعم» / «ايه» / «صحيح» / «تمام» / «أكد» / «موافق» / «واخا» / «ok» / «oui» / أي عبارة تعني الموافقة → **أرسل order_done=true في JSON الرد**.
- إذا رد بـ«لا» / «غلط» / طلب تعديل حقل معين → اطلب التصحيح المحدد لهاد الحقل فقط. لا تعيد كل الأسئلة من الأول.`;
  }

  // Build a checked list showing what's done, what's being asked, what's later
  const currentField = missing[0]!;
  const checklist = active.map((f, i) => {
    const num = i + 1;
    if (draft[f.key]) return `  ${num}. ${f.label} ✅ (${draft[f.key]})`;
    if (f.flag === currentField.flag) return `  ${num}. ${f.label} ⏳ ← اطلب هذا الآن`;
    return `  ${num}. ${f.label} ⌛ (لاحقا — لا تذكره الآن)`;
  }).join('\n');

  const disabledBlock = disabled.length
    ? `\n🔕 الحقول التالية مُعطّلة من قبل المالك — لا تذكرها أبدا في الردود ولا تطلبها:\n${disabled.map((f) => `  - ${f.label}`).join('\n')}`
    : '';

  const phoneAskRule = currentField.flag === 'collectPhone'
    ? `
🔑 سؤال الرقم — قاعدة لا تتزعزع:
- اسأل العميل بالدارجة: "أش هو الرقم اللي يمكن نتصلو بيك فيه؟"
- إذا أعطاك رقماً، ضعه كما قاله في draft_updates.phone — نحن نطبّعه إلى صيغة 0XXXXXXXXX.
- إذا قال "هاد الرقم" / "نفس رقم الواتساب" / "استعمل هاد" / "هاد اللي كنكلم بيك بيه" أو أي عبارة تعني الرقم نفسه ديال الواتساب — ضع use_wa_phone: true في الـ JSON ولا تكتب أرقاما بنفسك.
- ممنوع منعا قاطعا أن تخمن أو تختلق أرقاما.`
    : '';

  const addressRule = currentField.flag === 'collectAddress' && draft.city
    ? `
🏙️ سؤال العنوان — تفرّع ذكي حسب المدينة (المدينة المسجّلة: "${draft.city}"):

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔴 قاعدة أولى — قبل ما تختار أي فرع تحت:
افحص رسالة العميل الحالية. إذا كانت تحتوي على أي معلومة تحدد مكاناً (اسم شارع، حي، درب، زنقة، دوار، منطقة، جهة، عمارة، معلم، إشارة، أي شيء ملموس):
   → هاد الجواب كاف تماماً. لا تعيد سؤال العنوان مطلقاً.
   → ضع القيمة كما هي في draft_updates.address.
   → رد بإقرار قصير + الانتقال للحقل التالي (الكمية) أو ملخص الطلب.
   → أمثلة على أجوبة كافية 100٪ — لا تعيد السؤال عنها أبداً:
     «شارع الامل» ✓  «حي أكدال» ✓  «درب عمار» ✓  «زنقة الحرية» ✓
     «قرب مسجد النور» ✓  «دوار الحفاية» ✓  «منطقة صناعية» ✓  «حي المحمدي» ✓
     اسم أي حي أو شارع أو مكان معروف بغض النظر عن نوعه.
لا تختار الفرع الأول (المدن الكبيرة) ولا الفرع الثاني (المدن الصغيرة) إلا إذا رسالة العميل ما فيها شي معلومة موقع.

📍 المدن المغربية الكبيرة (التوصيل فيها كيتطلب اسم الحي/الشارع/المنطقة/الجهة):
الدار البيضاء / كازا، الرباط، سلا، تمارة، مراكش، فاس، مكناس، طنجة، تطوان،
أكادير، وجدة، الناظور، بني ملال، القنيطرة، المحمدية، خريبكة، الجديدة، آسفي،
الحسيمة، تازة، العيون، الداخلة، ورزازات، خنيفرة، إنزكان.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
➤ إذا "${draft.city}" ضمن المدن الكبيرة:
   السؤال الأول (مرة وحدة فقط، بأسلوب مفتوح):
   "صافي، شنو هو العنوان في ${draft.city}؟ (اسم حي / شارع / درب / منطقة — أي معلومة تحدد المكان كافية)"
   ⛔ لا تحصر السؤال في «حي أو منطقة أو جهة» فقط — الشارع والدرب والمعلم كلها إجابات صحيحة.

   ⚠️ إذا الجواب فضفاض («فين ما جبتها»، «كيف ما كان»، «ما كاينش مشكل»):
   - أعد السؤال مرة واحدة بلطف: "فالمدينة الكبيرة الموصل ممكن يلف ساعة بدون معلومة أدق. اسم أي مكان تحدده كافي — شارع، حي، درب. شنو أقرب معلومة؟"
   - سؤال واحد فقط، بدون تفاصيل إضافية.

   ✅ إذا العميل عطاك أي جواب محدد يحدد المكان:
   أمثلة كلها مقبولة تماماً (لا تسأل عن شيء إضافي):
     «شارع الامل» ✓  «حي أكدال» ✓  «درب عمار» ✓  «زنقة الحرية» ✓
     «قرب مسجد النور» ✓  «دوار العزوزية» ✓  «حي المحمدي، عمارة 12» ✓
   - اقبل الجواب مباشرة، ضعه في draft_updates.address بالحرف كما قاله.
   - رد التأكيد (استعمل قالب مقارب — اذكر ما قاله العميل باقتضاب):
     "صافي، سجّلت: <العنوان اللي قاله> — غادي نكمل الطلب."
   - ⛔ ممنوع بأي شكل ترد بـ«فأي حي…» أو «فأي منطقة…» أو «فأي جهة…» أو أي سؤال آخر عن العنوان.
   - ثم انتقل مباشرة للحقل التالي (الكمية) أو أعرض ملخص الطلب إذا هو آخر حقل.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
➤ إذا "${draft.city}" ماشي من هاد اللائحة (مدينة صغيرة، بلدة، قرية، دوار):
   السؤال الأول (مرة وحدة فقط، وبدون تفاصيل):
   "صافي. فين نوصلك المنتج؟"
   ⛔ ممنوع تذكر فالسؤال: «معلم قريب»، «مسجد»، «سوق»، «شارع»، «قرب…».
      هاد الكلمات كتنبّه العميل لأنك ما تعرفش مدينته — وهذا كيخسر الثقة.

   ✅ ﻷي جواب يعطيه العميل — فضفاض ("فين ما جبتها"، "الموصل يعيّط ليّا")
      ولا محدد (اسم شارع، حي، درب، دوار، أي شيء) — اقبله فوراً:
   - ضع القيمة في draft_updates.address بالضبط كما قالها.
     (إذا كانت فضفاضة، سجّل مثلا: "التواصل بالهاتف عند الوصول".)
   - رد التأكيد الوحيد المسموح (استعمل قالب مقارب):
     "صافي، الموصل غايعيّط ليك قبل ما يوصل. كلشي تمام 👌"
   - انتقل مباشرة للحقل التالي (الكمية) أو أعرض ملخص الطلب.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🚫 قاعدة لا تتزعزع — «لا سؤال ثاني حول العنوان»:
بعد ما يعطي العميل أي جواب لسؤال العنوان (فضفاض ولا محدد)، **ممنوع منعا قاطعا** أن يحتوي ردك على:
   ❌ سؤال عن «معلم قريب» / «نقطة قريبة» / «مسجد ولا سوق» / «شارع»
   ❌ سؤال عن «قرب أي...»، «قدام شنو»، «حدا شنو»
   ❌ أي طلب تفاصيل إضافية حول الموقع بأي صيغة
   ❌ أي Hook-Question حول العنوان — حتى ولو بأسلوب ودود
النمط الصحيح للرد بعد استلام العنوان:
   ✅ إقرار قصير («صافي، تسجّل العنوان») + الانتقال للحقل التالي أو ملخص الطلب.
هاد الخطأ (سؤال ثاني على العنوان بعد جواب العميل) هو من أخطر الأخطاء — كيفقد الزبون ثقته ويلغي الطلب.

🚫 ممنوع كذلك:
- إصرار على تفاصيل إضافية في مدينة صغيرة بعد أي جواب — احترم معرفة العميل بمدينته.
- قبول جواب فضفاض فالمدينة الكبيرة بدون طلب اسم الحي مرة وحدة إضافية.
- ذكر سياسات شركة التوصيل ولا اللوجستيك — العميل يريد الاحترام، ليس التفاصيل التقنية.`
    : '';

  return `📋 تجميع الطلب — حالة الحقول:
${checklist}
${disabledBlock}
${phoneAskRule}
${addressRule}

⚠️ استثناء مهم قبل القاعدة الصارمة تحت:
إذا في رسالة العميل هذي اعتراض، شك، تقليل من قيمة المنتج، اتهام بالخداع، انتقاد للسعر، انتقاد للجودة، سخرية، أو غضب — لا تطرح سؤال "${currentField.label}" فهاد الدورة أصلا. أجب فقط على الاعتراض باستعمال إطار ARPM (إقرار → إعادة تأطير → دليل → سؤال صغير منخفض الخطر، ماشي طلب لأي حقل). الدورة الموالية، إذا العميل بان مهتم فعلا، رجع للحقل المطلوب.

🔒 قاعدة صارمة جدا (تنطبق فقط لما الرسالة عادية وبدون اعتراض):
في هذا الرد، اطرح سؤالا واحدا فقط — على "${currentField.label}".
- لا تذكر الحقول التي بعده.
- لا تعطي قائمة بالحقول.
- لا تجمع حقلين في سؤال واحد.
- بعد أن يرد العميل بالمعلومة، نقدر ننتقل للحقل التالي.

🎯 دورة التأكيد — قاعدة عامة تنطبق على كل الحقول (اسم، هاتف، مدينة، عنوان، كمية):
إذا رسالة العميل الحالية جاوب عن الحقل المطلوب "${currentField.label}" بأي شكل (محدد ولا فضفاض):
- لا تعد السؤال على نفس الحقل بأي صيغة — لا كسؤال إضافة، لا كتوضيح، لا كـHook-Question.
- الرد يجب أن يقرّ قصيراً بما قاله العميل، ثم ينتقل للحقل التالي (إذا موجود) أو يعرض ملخص الطلب.
- Hook-Question المسموحة في هذي الدورة يجب أن تكون على الحقل الموالي، ماشي على الحقل اللي راه توّاعطينا الجواب فيه.
هاد القاعدة تحمي الزبون من الشعور بأنه كنستنطقو مرتين على نفس المعلومة — هاد الإحساس كيخسر الطلب.

بمجرد جمع كل الحقول، اعرض ملخص الطلب في القالب المحدد (📜 قالب ملخص الطلب)
ثم اسأل التأكيد، وإذا أكد العميل، أرسل order_done=true.`;
}

function hasAllRequired(cfg: any, draft: OrderDraft): boolean {
  if (cfg.collectName && !draft.name) return false;
  if (cfg.collectPhone && !draft.phone) return false;
  if (cfg.collectCity && !draft.city) return false;
  if (cfg.collectAddress && !draft.address) return false;
  if (cfg.collectQuantity && !draft.quantity) return false;
  return true;
}

/**
 * Rule 2 helper — assemble the customer-facing order summary sent on
 * finalize. Lines respect the operator's `cfg.collect*` toggles: a field
 * that wasn't asked for is also not shown in the summary. Always ends with
 * the operator's closing thanks (or DEFAULT_POST_ORDER_THANKS) so the
 * customer's last touchpoint is a warm "we got you" line.
 *
 * The block uses simple box-drawing (─) that renders identically on iOS
 * and Android WhatsApp — no image, no emoji-only reliance.
 */
export function buildOrderSummary(cfg: any, draft: OrderDraft, thanks: string): string {
  const lines: string[] = ['✅ ملخص الطلب', '─────────────'];
  const em = '—';
  if (cfg.collectName)     lines.push(`• الاسم:    ${(draft.name ?? '').trim() || em}`);
  if (cfg.collectPhone)    lines.push(`• الهاتف:   ${(draft.phone ?? '').trim() || em}`);
  if (cfg.collectCity)     lines.push(`• المدينة:  ${(draft.city ?? '').trim() || em}`);
  if (cfg.collectAddress)  lines.push(`• العنوان:  ${(draft.address ?? '').trim() || em}`);
  if (cfg.collectQuantity) lines.push(`• الكمية:   ${(draft.quantity ?? '').trim() || em}`);
  lines.push('─────────────');
  lines.push(thanks.trim());
  return lines.join('\n');
}

/** Forward the finalised order to the owner's WhatsApp number. */
async function forwardOrderToOwner(ownerPhone: string, accountId: string, contact: any, draft: OrderDraft): Promise<void> {
  const ownerJid = `${ownerPhone.replace(/\D/g, '')}@s.whatsapp.net`;
  // Real phone digits when known; null for LID-only contacts with no senderPn.
  // NEVER fabricate — better to omit the WA-phone line than send the owner a
  // fake number they will call and reach a stranger.
  const waPhone = resolveContactPhone(contact);
  const phoneTag = (draft as any).phoneFromWA ? ' (رقم الواتساب)' : '';
  const ts = new Date().toLocaleString('ar-MA', {
    hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric',
  });
  const message = [
    '🎉 *طلب جديد عبر البائع الذكي*',
    '━━━━━━━━━━━━━━━━━━━',
    '',
    `👤 *العميل:* ${contact.name ?? (waPhone ?? '—')}`,
    waPhone ? `📱 *الواتساب:* +${waPhone}` : '📱 *الواتساب:* غير معلن (LID)',
    waPhone ? `🔗 wa.me/${waPhone}` : null,
    '',
    '📦 *تفاصيل الطلب:*',
    draft.name      ? `   • الاسم: ${draft.name}`                        : null,
    draft.phone     ? `   • الهاتف: ${draft.phone}${phoneTag}`            : null,
    draft.city      ? `   • المدينة: ${draft.city}`                       : null,
    draft.address   ? `   • العنوان: ${draft.address}`                    : null,
    draft.quantity  ? `   • الكمية: ${draft.quantity}`                    : null,
    draft.notes     ? `   • ملاحظات: ${draft.notes}`                      : null,
    '',
    '━━━━━━━━━━━━━━━━━━━',
    `🕐 ${ts}`,
  ].filter(Boolean).join('\n');
  try {
    await providerFor(accountId).sendText(ownerJid, message);
  } catch (e) {
    logger.warn({ err: e, ownerJid }, 'forwardOrderToOwner failed');
  }
}

/** Best-effort STT helper — fetches the WA media for an incoming audio
 *  message and returns the transcript. Caller passes empty string on miss. */
export async function transcribeIfAudio(m: IncomingMessage, msg: any, extraPrompt?: string): Promise<string | null> {
  // Official Cloud API path — the webhook attaches { cloudMedia: { id, mimeType } }
  // instead of a Baileys proto; download via the Graph media endpoint.
  if (msg?.cloudMedia?.id) {
    try {
      const { buffer, mimeType } = await CloudApiService.downloadMedia(String(msg.cloudMedia.id));
      return await AiProvider.transcribe(buffer, msg.cloudMedia.mimeType ?? mimeType, extraPrompt);
    } catch (e) {
      logger.warn({ err: e, accountId: m.accountId }, 'transcribeIfAudio (cloud) failed');
      return null;
    }
  }
  const audio = msg?.message?.audioMessage;
  if (!audio) return null;
  try {
    const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
    const buf: Buffer = await downloadMediaMessage(msg as any, 'buffer', {}) as Buffer;
    const mime = audio.mimetype ?? 'audio/ogg';
    return await AiProvider.transcribe(buf, mime, extraPrompt);
  } catch (e) {
    logger.warn({ err: e, accountId: m.accountId }, 'transcribeIfAudio failed');
    return null;
  }
}

/** Re-export for test harnesses */
export const __test__ = { hasAllRequired, parseDraft, buildCollectionPrompt };

void sleep;   // explicit no-op to silence unused-import

/**
 * Pull the bot's catalog (linked products), expand into a system-prompt block
 * the AI can quote from. Always returns a string (empty if no products).
 */
export async function buildCatalogContext(botId: string): Promise<string> {
  const links = await prisma.botProduct.findMany({
    where: { botId },
    include: { product: true },
  });
  const active = links.map((l) => l.product).filter((p) => p && p.isActive);
  if (!active.length) return '';
  const lines: string[] = [
    '=== كتالوج المنتجات — هذا مرجعك العلمي ===',
    '⚙️ قبل أي رد، اقرأ وصف كل منتج كأنك خبير قضى سنوات يدرس فيه. لكل منتج، صنّف سرّاً:',
    '   (أ) نوعه — فوري المفعول / تدريجي تجميلي-علاجي / خدمة / غذائي.',
    '   (ب) المشكلة المحددة اللي يحلها.',
    '   (ج) آلية الاشتغال — كيف يعمل بالضبط؟',
    '   (د) الزمن الواقعي للنتائج — لا تكذب، لا تبالغ، لا تنقص.',
    '   (هـ) الفئة المثلى من الزبناء.',
    '   (و) الحدود الصادقة — شنو ما يقدرش يدير.',
    '🔒 الأسعار التزم بها حرفيا. لا تخمن، لا تقرب.',
    '📓 ملاحظات داخلية = ذخيرة سرية من المالك. استعملها كمصدر، لا تنقلها حرفيا للزبون.',
    '',
  ];
  active.forEach((p, i) => {
    const priceLine = p.price ? `السعر: ${p.price}${p.currency ? ' ' + p.currency : ''}` : '';
    let mediaLine = '';
    try {
      const mediaIds: string[] = p.mediaIds ? JSON.parse(p.mediaIds) : [];
      if (mediaIds.length) mediaLine = `صور/فيديو متاحة (mediaIds): ${mediaIds.join(', ')}`;
    } catch {}
    const notes = p.notes ? `ملاحظات داخلية: ${p.notes}` : '';
    lines.push([
      `${i + 1}) ${p.name}`,
      priceLine,
      p.description ?? '',
      mediaLine,
      notes,
    ].filter(Boolean).join('\n   '));
  });
  return lines.join('\n');
}

/**
 * Send one MediaFile referenced by id through the bot account, persist as an
 * outgoing AI message. Optional `caption` collapses "media + text" into ONE
 * WhatsApp message (supported for image/video/document; ignored for audio,
 * which has no WA caption surface).
 */
async function sendCatalogMedia(
  c: AiHandleContext,
  provider: import('../adapters/whatsapp/BotProvider.js').BotProvider,
  mediaId: string,
  caption?: string,
): Promise<void> {
  const media = await prisma.mediaFile.findUnique({ where: { id: mediaId } });
  if (!media) return;
  const abs = MediaService.resolveAbsolute(media.path);
  let outgoingMime = media.mimeType;
  if (media.type === 'audio' && /webm/i.test(media.mimeType)) {
    outgoingMime = 'audio/ogg; codecs=opus';
  }
  const realType = media.type as 'image' | 'audio' | 'video' | 'document';
  // Audio messages on WhatsApp don't support captions — drop it silently
  // rather than fail or send a phantom second message.
  const effectiveCaption = realType === 'audio' ? undefined : caption;
  const args = {
    filePath: abs,
    mimeType: outgoingMime,
    fileName: media.name,
    caption: effectiveCaption,
  };
  const waId =
    realType === 'image'    ? await provider.sendImage(c.jid, args) :
    realType === 'video'    ? await provider.sendVideo(c.jid, args) :
    realType === 'audio'    ? await provider.sendAudio(c.jid, args) :
                              await provider.sendDocument(c.jid, args);
  // Persist the caption as body so dashboards show what the customer saw with
  // the media — not an empty bubble.
  await persistAiOut(c, realType, effectiveCaption ?? '', media.id, waId);
}
