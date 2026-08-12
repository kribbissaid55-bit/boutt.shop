/**
 * AI configuration + credential management routes.
 *
 *   GET    /bots/:id/ai           → current BotAiConfig (creates default if missing)
 *   PATCH  /bots/:id/ai           → upsert
 *   POST   /bots/:id/ai/test      → "preview" — run a single AI turn against a synthetic context
 *
 *   GET    /ai/credentials        → list (provider, label, masked tail, isDefault)
 *   POST   /ai/credentials        → add (encrypt + persist)
 *   PATCH  /ai/credentials/:id    → relabel / setDefault
 *   DELETE /ai/credentials/:id    → remove
 */
import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { logger } from '../../config/logger.js';
import { prisma } from '../../lib/prisma.js';
import { encryptApiKey, decryptApiKey, maskKey } from '../../lib/ai-crypto.js';
import { AiProvider, type ChatMessage, type ChatContentPart } from '../../services/AiProvider.js';
import {
  parseInstructionMedia,
  resolveMediaRef,
  buildCatalogContext,
  type InstructionMediaItem,
  type OrderDraft,
} from '../../engine/aiEngine.js';
import { buildLayeredSystemMessage } from '../../engine/buildSystemMessage.js';
import { MediaService } from '../../services/MediaService.js';
import type { CustomerStatusKey } from '../../services/CustomerTagService.js';
import { safeParseObject } from '../../lib/safe-parse.js';

export const aiRouter = Router();

// ── Bot-scoped config ────────────────────────────────────────────────────

aiRouter.get('/bots/:id/ai', async (req, res, next) => {
  try {
    let cfg = await prisma.botAiConfig.findUnique({ where: { botId: req.params.id } });
    if (!cfg) cfg = await prisma.botAiConfig.create({ data: { botId: req.params.id } });
    res.json(cfg);
  } catch (e) { next(e); }
});

const PROVIDERS = ['openai', 'deepseek', 'gemini', 'anthropic'] as const;
const VOICE_PROVIDERS = ['openai', 'elevenlabs'] as const;
const REPLY_MODES = ['text', 'voice', 'auto'] as const;

const PatchSchema = z.object({
  enabled: z.boolean().optional(),
  provider: z.enum(PROVIDERS).optional(),
  // Optional LLM override for voice-mode replies. Setting both to a non-null
  // value routes voice turns to a different provider+model than text turns.
  voiceChatProvider: z.enum(PROVIDERS).nullable().optional(),
  voiceChatModel: z.string().min(1).max(80).nullable().optional(),
  model: z.string().min(1).max(80).optional(),
  systemPrompt: z.string().max(8000).optional(),
  replyMode: z.enum(REPLY_MODES).optional(),
  voiceProvider: z.enum(VOICE_PROVIDERS).optional(),
  voiceId: z.string().max(80).optional(),
  transcribeAudio: z.boolean().optional(),
  collectionEnabled: z.boolean().optional(),
  collectName: z.boolean().optional(),
  collectPhone: z.boolean().optional(),
  collectCity: z.boolean().optional(),
  collectAddress: z.boolean().optional(),
  collectQuantity: z.boolean().optional(),
  notifyOwnerEnabled: z.boolean().optional(),
  ownerPhone: z.string().max(40).nullable().optional(),
  stopWord: z.string().max(80).nullable().optional(),
  ownerInterventionMinutes: z.number().int().min(0).max(24 * 60).optional(),
  maxRepliesPerSession: z.number().int().min(0).max(1000).optional(),
  customerReplyTimeoutMin: z.number().int().min(0).max(7 * 24 * 60).optional(),
  continueAfterOrder: z.boolean().optional(),
  postOrderThanksMessage: z.string().max(800).nullable().optional(),
  instructionMedia: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1).max(40),
    note: z.string().max(160).optional(),
  })).nullable().optional(),
  customerTagsConfig: z.object({
    enabled: z.boolean(),
    sentNoReply: z.object({ enabled: z.boolean(), label: z.string().min(1).max(40), color: z.number().int().min(0).max(19) }),
    replied:     z.object({ enabled: z.boolean(), label: z.string().min(1).max(40), color: z.number().int().min(0).max(19) }),
    ordered:     z.object({ enabled: z.boolean(), label: z.string().min(1).max(40), color: z.number().int().min(0).max(19) }),
  }).nullable().optional(),
  requirePreSendConfirm: z.boolean().optional(),
  voiceQuality: z.enum(['standard', 'hd']).optional(),
  voiceInstructions: z.string().max(2000).nullable().optional(),
  sttContextPrompt: z.string().max(2000).nullable().optional(),
  chatTemperature: z.number().min(0).max(1).optional(),
  voiceStability: z.number().min(0).max(1).optional(),
  voiceSimilarityBoost: z.number().min(0).max(1).optional(),
  // ElevenLabs fine-grained controls.
  voiceModelId: z.enum(['eleven_turbo_v2_5', 'eleven_multilingual_v2', 'eleven_v3']).optional(),
  voiceStyle: z.number().min(0).max(1).optional(),
  engineMode: z.enum(['rule_only', 'ai_only', 'hybrid', 'rule_priority', 'disabled']).optional(),
  historyTurns: z.number().int().min(1).max(50).optional(),
  // Reply-timing controls. All values in seconds, clamped [0, 600] to match
  // the engine's runtime ceiling in server/src/lib/replyDelay.ts.
  firstReplyDelaySeconds:    z.number().int().min(0).max(600).optional(),
  firstReplyDelayMaxSeconds: z.number().int().min(0).max(600).optional(),
  firstReplyRandomize:       z.boolean().optional(),
  replyDelaySeconds:         z.number().int().min(0).max(600).optional(),
  replyDelayMaxSeconds:      z.number().int().min(0).max(600).optional(),
  replyRandomize:            z.boolean().optional(),
});

aiRouter.patch('/bots/:id/ai', async (req, res, next) => {
  try {
    const data = PatchSchema.parse(req.body);
    const patch: any = { ...data };
    if (data.instructionMedia !== undefined) {
      patch.instructionMedia = data.instructionMedia === null ? null : JSON.stringify(data.instructionMedia);
    }
    if (data.customerTagsConfig !== undefined) {
      patch.customerTagsConfig = data.customerTagsConfig === null ? null : JSON.stringify(data.customerTagsConfig);
    }
    const updated = await prisma.botAiConfig.upsert({
      where: { botId: req.params.id },
      update: patch,
      create: { botId: req.params.id, ...patch },
    });
    res.json(updated);
  } catch (e) { next(e); }
});

const STAGE_VALUES = ['sent_no_reply', 'replied', 'ordered'] as const;
const DraftSchema = z.object({
  name:     z.string().max(160).optional(),
  phone:    z.string().max(80).optional(),
  city:     z.string().max(120).optional(),
  address:  z.string().max(400).optional(),
  quantity: z.string().max(40).optional(),
  notes:    z.string().max(400).optional(),
}).partial();

const TestSchema = z.object({
  userMessage: z.string().min(1).max(4000),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })).max(40).optional(),
  // Multimodal input: optional image data-URL (data:image/jpeg;base64,...).
  imageDataUrl: z.string().max(20 * 1024 * 1024).optional(),
  // Multimodal input: optional audio buffer in base64 — server transcribes first.
  audioBase64: z.string().max(40 * 1024 * 1024).optional(),
  audioMime: z.string().max(80).optional(),
  // Session-local order draft + derived stage — keeps preview parity with
  // production (same prompt → same behavior). When omitted the script picks
  // first_contact + an empty draft.
  draft: DraftSchema.optional(),
  stage: z.enum(STAGE_VALUES).nullable().optional(),
  // Customer's input kind for this turn — drives the auto-mode mirror so
  // the preview matches production. The UI sets this to 'audio' when the
  // operator records a voice note. Defaults to 'audio' if audioBase64 is
  // present, else 'text'.
  incomingKind: z.enum(['text', 'audio']).optional(),
});

aiRouter.post('/bots/:id/ai/test', async (req, res, next) => {
  try {
    const { userMessage, history, imageDataUrl, audioBase64, audioMime, draft: incomingDraft, stage: incomingStage, incomingKind }
      = TestSchema.parse(req.body);
    const cfg = await prisma.botAiConfig.findUnique({ where: { botId: req.params.id } });
    if (!cfg) return res.status(404).json({ error: 'ai_not_configured' });

    // ─── STT for voice input ─────────────────────────────────────────────
    let effectiveText = userMessage;
    if (audioBase64) {
      try {
        const buf = Buffer.from(audioBase64, 'base64');
        const transcript = await AiProvider.transcribe(
          buf,
          audioMime ?? 'audio/ogg',
          cfg.sttContextPrompt ?? undefined,
        );
        if (transcript.trim()) effectiveText = `[رسالة صوتية]: ${transcript}`;
      } catch (e: any) {
        return res.status(400).json({ error: `stt_failed: ${e?.message}` });
      }
    }

    // ─── Build the SAME layered prompt as production aiHandleIncoming ────
    const draft: OrderDraft = (incomingDraft ?? {}) as OrderDraft;
    const catalog = await buildCatalogContext(req.params.id);
    const instructionMedia: InstructionMediaItem[] = parseInstructionMedia((cfg as any).instructionMedia);
    const systemContent = buildLayeredSystemMessage({
      cfg,
      draft,
      catalog,
      instructionMedia,
      stage: (incomingStage ?? null) as CustomerStatusKey | null,
    });

    const userContent: string | ChatContentPart[] = imageDataUrl
      ? [
          { type: 'text', text: effectiveText },
          { type: 'image_url', image_url: { url: imageDataUrl } },
        ]
      : effectiveText;

    const messages: ChatMessage[] = [
      { role: 'system', content: systemContent },
      ...(history ?? []).map((h) => ({ role: h.role, content: h.content }) as ChatMessage),
      { role: 'user', content: userContent },
    ];
    // Resolve chosenMode UPFRONT so we can pick the right LLM provider for
    // voice turns (dual-provider routing). Same logic as production engine.
    const effectiveIncomingKind: 'text' | 'audio' =
      incomingKind ?? (audioBase64 ? 'audio' : 'text');
    const chosenMode: 'text' | 'voice' =
      cfg.replyMode === 'voice' ? 'voice' :
      cfg.replyMode === 'text'  ? 'text'  :
                                  (effectiveIncomingKind === 'audio' ? 'voice' : 'text');
    // Mirror aiEngine's routing: override targets TEXT turns; voice turns
    // keep using the main provider/model. DB column name is historical.
    const textOverrideProvider = (cfg as any).voiceChatProvider as string | null | undefined;
    const textOverrideModel = (cfg as any).voiceChatModel as string | null | undefined;
    const useTextOverride = chosenMode === 'text' && !!textOverrideProvider && !!textOverrideModel;
    const chatProvider = useTextOverride ? textOverrideProvider! : cfg.provider;
    const chatModel    = useTextOverride ? textOverrideModel!    : cfg.model;
    const result = await AiProvider.chat(chatProvider, {
      messages,
      model: chatModel,
      temperature: cfg.chatTemperature ?? 0.4,
      maxTokens: 600,
      responseJsonSchema: { type: 'object' },
    });
    // Parse the JSON envelope fully — the raw envelope must never reach the
    // operator's screen; only the parsed pieces.
    const parsed = result.parsed ?? safeParseObject(result.text);
    const replyText: string = (parsed?.reply ?? result.text ?? '').toString();
    const draftUpdates: Record<string, string> = (parsed?.draft_updates && typeof parsed.draft_updates === 'object')
      ? parsed.draft_updates
      : {};
    const orderDone: boolean = !!parsed?.order_done;
    const sendMediaIds: string[] = Array.isArray(parsed?.send_media_ids) ? parsed.send_media_ids : [];

    // Resolve labels → MediaFile metadata so the UI can render an inline
    // preview of what the customer would see on WhatsApp.
    const seenIds = new Set<string>();
    const mediaPreviews: Array<{ id: string; name: string; type: string; mimeType: string; rawUrl: string }> = [];
    for (const ref of sendMediaIds.slice(0, 5)) {
      const id = resolveMediaRef(String(ref ?? ''), instructionMedia);
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      const media = await prisma.mediaFile.findUnique({ where: { id } });
      if (!media) continue;
      mediaPreviews.push({
        id: media.id,
        name: media.name,
        type: media.type,
        mimeType: media.mimeType,
        rawUrl: `/api/media/${media.id}/raw`,
      });
    }
    // MediaService is referenced so the import stays meaningful even when
    // future paths need server-resolved absolute paths.
    void MediaService;

    // chosenMode was resolved upstream so we could route the chat call.

    // Voice TTS — same wiring as production.
    let audioReplyBase64: string | undefined;
    let audioReplyMime: string | undefined;
    if (chosenMode === 'voice' && replyText.trim()) {
      try {
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
        audioReplyBase64 = audio.toString('base64');
        audioReplyMime = 'audio/ogg';
      } catch (e: any) {
        audioReplyBase64 = undefined;
        audioReplyMime = undefined;
      }
    }

    res.json({
      reply: replyText,
      mode: chosenMode,
      // Which chat model actually served the request — lets the UI display
      // "text turn used gpt-4o-mini, voice turn used gpt-4o" so the operator
      // can eyeball that voice-override routing works as configured.
      chatProvider,
      chatModel,
      audioBase64: audioReplyBase64,
      audioMime: audioReplyMime,
      transcript: audioBase64 ? effectiveText : undefined,
      tokenUsage: result.tokenUsage,
      draftUpdates,
      orderDone,
      mediaPreviews,
    });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? 'ai_test_failed' });
  }
});

// ── Voice preview ────────────────────────────────────────────────────────

const PreviewSchema = z.object({
  text: z.string().min(1).max(500).optional(),
  // Optional overrides — useful for the UI to preview a setting before saving.
  voice: z.string().max(80).optional(),
  voiceProvider: z.enum(['openai', 'elevenlabs']).optional(),
  voiceQuality: z.enum(['standard', 'hd']).optional(),
  voiceStability: z.number().min(0).max(1).optional(),
  voiceSimilarityBoost: z.number().min(0).max(1).optional(),
  voiceInstructions: z.string().max(2000).optional(),
  voiceModelId: z.enum(['eleven_turbo_v2_5', 'eleven_multilingual_v2', 'eleven_v3']).optional(),
  voiceStyle: z.number().min(0).max(1).optional(),
});

const DEFAULT_PREVIEW_TEXT = 'السلام عليكم! شحال هاد المنتج؟ غادي تعجبك الجودة ديالو، شحال بغيتي تاخد منو؟';

aiRouter.post('/bots/:id/ai/voice-preview', async (req, res) => {
  try {
    const overrides = PreviewSchema.parse(req.body ?? {});
    const cfg = await prisma.botAiConfig.findUnique({ where: { botId: req.params.id } });
    if (!cfg) return res.status(404).json({ error: 'ai_not_configured' });

    const audio = await AiProvider.tts(overrides.text ?? DEFAULT_PREVIEW_TEXT, {
      voice: overrides.voice ?? cfg.voiceId,
      provider: overrides.voiceProvider ?? cfg.voiceProvider,
      instructions: overrides.voiceInstructions ?? cfg.voiceInstructions ?? undefined,
      quality: (overrides.voiceQuality ?? cfg.voiceQuality) === 'hd' ? 'hd' : 'standard',
      voiceStability: overrides.voiceStability ?? cfg.voiceStability ?? undefined,
      voiceSimilarityBoost: overrides.voiceSimilarityBoost ?? cfg.voiceSimilarityBoost ?? undefined,
      voiceStyle: overrides.voiceStyle ?? (cfg as any).voiceStyle ?? undefined,
      voiceModelId: overrides.voiceModelId ?? (cfg as any).voiceModelId ?? undefined,
    });

    res.json({
      audioBase64: audio.toString('base64'),
      audioMime: 'audio/ogg',
    });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? 'voice_preview_failed' });
  }
});

// ── Customer-tag test sync ──────────────────────────────────────────────

const TestSyncSchema = z.object({
  contactId: z.string().min(1),
  accountId: z.string().min(1),
});

aiRouter.post('/bots/:botId/customer-tags/test-sync', async (req, res) => {
  try {
    const { contactId, accountId } = TestSyncSchema.parse(req.body);
    const { syncTagsForContactInstrumented } = await import('../../services/CustomerTagService.js');
    const result = await syncTagsForContactInstrumented(req.params.botId, accountId, contactId);

    // Visibility hint for the operator: chat-labels are a WA Business UI feature.
    let visibilityHint = '';
    if (result.isBusiness === true) {
      visibilityHint = 'حساب WhatsApp Business — افتح التطبيق، اذهب إلى Labels لرؤية العلامة على المحادثة.';
    } else if (result.isBusiness === false) {
      visibilityHint = 'هذا الحساب شخصي — العلامات لن تظهر داخل تطبيق الواتساب على الهاتف (الميزة محصورة بـ WhatsApp Business). لوحة التحكم تعرض الشارة الملوّنة دائماً.';
    } else {
      visibilityHint = 'لم يتم التحقق من نوع الحساب بعد — أعد ربط الواتساب لتفعيل الكشف. لوحة التحكم تعرض الشارة على كل حال.';
    }
    res.json({ ...result, visibilityHint });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? 'test_sync_failed' });
  }
});

// Force-resync all labels for every contact of the bot's linked account.
// Repair tool — the operator hits this when labels appear stale in their WA
// Business app. Response reports counts per outcome so the UI can display.
aiRouter.post('/bots/:botId/customer-tags/resync-all', async (req, res) => {
  try {
    const { resyncAllTagsForBot } = await import('../../services/CustomerTagService.js');
    const summary = await resyncAllTagsForBot(req.params.botId);
    res.json(summary);
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? 'resync_all_failed' });
  }
});

// ── ElevenLabs voice library browser ─────────────────────────────────────

/**
 * GET /ai/voices/elevenlabs
 * Proxies ElevenLabs' GET /v1/voices using the operator's saved key. Returns
 * a normalized list so the UI can show ALL the operator's voices — including
 * cloned ones (the highest-quality path for a true Moroccan voice).
 */
aiRouter.get('/ai/voices/elevenlabs', async (_req, res) => {
  try {
    const key = await AiProvider.getKey('elevenlabs').catch(() => null);
    if (!key) return res.status(400).json({ error: 'no_elevenlabs_key' });
    const r = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': key, 'Accept': 'application/json' },
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return res.status(r.status).json({ error: `elevenlabs_voices_failed: ${txt.slice(0, 200)}` });
    }
    const data: any = await r.json();
    const voices = (data?.voices ?? []).map((v: any) => ({
      id: v.voice_id,
      name: v.name,
      category: v.category, // 'premade' | 'cloned' | 'generated' | 'professional'
      labels: v.labels ?? {},
      previewUrl: v.preview_url ?? undefined,
    }));
    res.json({ voices });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? 'elevenlabs_voices_failed' });
  }
});

// ── Unified test: simulate-call + next-followup ──────────────────────────

type RenderedBlock = {
  kind: 'text' | 'audio' | 'image' | 'video' | 'document' | 'delay' | 'options' | 'action';
  body?: string;
  caption?: string;
  delaySeconds?: number;
  options?: { number: string; label: string }[];
  mediaPreview?: { id: string; name: string; type: string; mimeType: string; rawUrl: string };
};

async function blocksToRendered(blocks: any[]): Promise<RenderedBlock[]> {
  const out: RenderedBlock[] = [];
  for (const b of (blocks ?? [])) {
    if (b?.enabled === false) continue;
    const kind = b?.type as RenderedBlock['kind'];
    const item: RenderedBlock = { kind };
    if (b?.content) item.body = b.content;
    if (b?.caption) item.caption = b.caption;
    if (b?.delaySeconds != null) item.delaySeconds = b.delaySeconds;
    if (Array.isArray(b?.options)) {
      item.options = b.options.map((o: any) => ({ number: o.number, label: o.label }));
    }
    if (b?.mediaId && kind !== 'text') {
      const m = await prisma.mediaFile.findUnique({ where: { id: b.mediaId } });
      if (m) {
        item.mediaPreview = {
          id: m.id, name: m.name, type: m.type, mimeType: m.mimeType,
          rawUrl: `/api/media/${m.id}/raw`,
        };
      }
    }
    out.push(item);
  }
  return out;
}

/**
 * POST /bots/:id/ai/test/simulate-call
 * Returns the configured call-rejection sequence as rendered blocks the unified
 * preview can paint as bot bubbles. No real WA send.
 */
aiRouter.post('/bots/:id/ai/test/simulate-call', async (req, res) => {
  try {
    const settings = await prisma.botSettings.findUnique({ where: { botId: req.params.id } });
    if (!settings) return res.json({ enabled: false, blocks: [] });
    const enabled = !!settings.callRejectionEnabled;
    let blocks: RenderedBlock[] = [];
    if (settings.callRejectionSequence) {
      try {
        const parsed = JSON.parse(settings.callRejectionSequence);
        blocks = await blocksToRendered(parsed?.blocks ?? []);
      } catch { /* fall through */ }
    }
    res.json({
      enabled,
      delaySeconds: settings.callRejectionDelaySeconds ?? 0,
      blocks,
    });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? 'simulate_call_failed' });
  }
});

const NextFollowupSchema = z.object({
  // How many minutes ago the simulated session went silent (operator picks
  // 5/30/120/1440 in the UI). The endpoint returns the FIRST follow-up step
  // whose delay <= sessionSilentMinutes for any rule belonging to this bot.
  sessionSilentMinutes: z.number().int().min(1).max(60 * 24 * 14),
});

aiRouter.post('/bots/:id/ai/test/next-followup', async (req, res) => {
  try {
    const { sessionSilentMinutes } = NextFollowupSchema.parse(req.body ?? {});
    const rules = await prisma.followUpRule.findMany({
      where: { botId: req.params.id, isActive: true },
      include: { steps: { orderBy: { stepOrder: 'asc' } } },
    });
    if (!rules.length) return res.json({ matched: false, blocks: [] });

    // Find the matching step: convert each step's delay to minutes, take the
    // largest step.delayMinutes <= sessionSilentMinutes (i.e. the most-recent
    // step that would have fired by now).
    let bestRule: typeof rules[number] | null = null;
    let bestStep: typeof rules[number]['steps'][number] | null = null;
    let bestStepMins = -1;
    for (const r of rules) {
      for (const s of r.steps) {
        const mins =
          s.delayUnit === 'minutes' ? s.delayValue :
          s.delayUnit === 'hours'   ? s.delayValue * 60 :
                                      s.delayValue * 60 * 24;
        if (mins <= sessionSilentMinutes && mins > bestStepMins) {
          bestRule = r; bestStep = s; bestStepMins = mins;
        }
      }
    }
    if (!bestRule || !bestStep) return res.json({ matched: false, blocks: [] });

    let blocks: RenderedBlock[] = [];
    if (bestStep.messageSequence) {
      try {
        const parsed = JSON.parse(bestStep.messageSequence);
        blocks = await blocksToRendered(parsed?.blocks ?? []);
      } catch { /* fall through */ }
    }
    res.json({
      matched: true,
      ruleName: bestRule.name,
      stepDelayMinutes: bestStepMins,
      blocks,
    });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? 'next_followup_failed' });
  }
});

// ── Credentials vault ────────────────────────────────────────────────────

aiRouter.get('/ai/credentials', async (_req, res, next) => {
  try {
    const rows = await prisma.aiCredential.findMany({ orderBy: { createdAt: 'desc' } });
    res.json(rows.map((r) => {
      let masked = '****';
      try { masked = maskKey(decryptApiKey(r.encryptedKey)); } catch {}
      return {
        id: r.id, provider: r.provider, label: r.label,
        masked, isDefault: r.isDefault,
        createdAt: r.createdAt,
      };
    }));
  } catch (e) { next(e); }
});

/**
 * List providers that at least one active bot's AI config is configured
 * to use (chat provider + voice-mode chat override + voice TTS provider),
 * so the AiKeysPage can pre-warn the operator when they've picked a
 * provider that has no credential on file.
 */
aiRouter.get('/ai/providers-needed', async (_req, res, next) => {
  try {
    const cfgs = await prisma.botAiConfig.findMany({
      where: { enabled: true },
      select: { provider: true, voiceChatProvider: true, voiceProvider: true },
    });
    const providers = new Set<string>();
    for (const c of cfgs) {
      if (c.provider) providers.add(c.provider);
      if (c.voiceChatProvider) providers.add(c.voiceChatProvider);
      if (c.voiceProvider) providers.add(c.voiceProvider);
    }
    res.json({ providers: Array.from(providers) });
  } catch (e) { next(e); }
});

const CredSchema = z.object({
  provider: z.enum([...PROVIDERS, ...VOICE_PROVIDERS]),
  label: z.string().min(1).max(80),
  apiKey: z.string().min(8).max(500),
  isDefault: z.boolean().optional(),
});

aiRouter.post('/ai/credentials', async (req, res, next) => {
  try {
    const data = CredSchema.parse(req.body);
    const encrypted = encryptApiKey(data.apiKey.trim());
    if (data.isDefault) {
      await prisma.aiCredential.updateMany({
        where: { provider: data.provider }, data: { isDefault: false },
      });
    }
    const row = await prisma.aiCredential.create({
      data: {
        provider: data.provider, label: data.label,
        encryptedKey: encrypted, isDefault: data.isDefault ?? false,
      },
    });
    res.status(201).json({ id: row.id });
  } catch (e) { next(e); }
});

const PatchCredSchema = z.object({
  label: z.string().min(1).max(80).optional(),
  isDefault: z.boolean().optional(),
});

aiRouter.patch('/ai/credentials/:id', async (req, res, next) => {
  try {
    const data = PatchCredSchema.parse(req.body);
    if (data.isDefault) {
      const cur = await prisma.aiCredential.findUnique({ where: { id: req.params.id } });
      if (cur) {
        await prisma.aiCredential.updateMany({
          where: { provider: cur.provider }, data: { isDefault: false },
        });
      }
    }
    const row = await prisma.aiCredential.update({
      where: { id: req.params.id }, data,
    });
    res.json({ id: row.id });
  } catch (e) { next(e); }
});

aiRouter.delete('/ai/credentials/:id', async (req, res, next) => {
  try {
    await prisma.aiCredential.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/**
 * Verify a saved credential actually works with its provider. Used by the
 * AiKeysPage 🧪 button — gives the operator instant feedback on whether a
 * key is valid, expired, out-of-quota, or otherwise broken. Prevents the
 * silent-failure mode where the operator swaps a key, the bot goes quiet,
 * and nobody knows why until a customer complains.
 *
 * Voice-only providers (elevenlabs) skip the chat ping — those are TTS
 * providers and don't have a chat endpoint to hit. We return ok:true with
 * a note.
 */
aiRouter.post('/ai/credentials/:id/test', async (req, res, next) => {
  try {
    const row = await prisma.aiCredential.findUnique({ where: { id: req.params.id } });
    if (!row) return res.status(404).json({ error: 'credential_not_found' });
    if (row.provider === 'elevenlabs') {
      return res.json({ ok: true, latencyMs: 0, sampleReply: '(TTS provider — chat ping skipped)' });
    }
    let apiKey: string;
    try { apiKey = decryptApiKey(row.encryptedKey); }
    catch { return res.json({ ok: false, latencyMs: 0, error: 'decrypt_failed' }); }
    const result = await AiProvider.pingWithKey(row.provider, apiKey);
    res.json(result);
  } catch (e) { next(e); }
});

// ── Voice cloning (ElevenLabs Instant Voice Cloning) ────────────────────
//
// The operator records or uploads 3-5 min of their own voice → we push it to
// ElevenLabs IVC and get back a `voice_id` → the bot then answers customers
// in that voice. In parallel we transcribe the sample via Whisper and store
// a short excerpt as `voiceClonedPersona` so the LLM can mimic the
// operator's dialect + register on the text side.

const voiceCloneUpload = multer({
  dest: path.join(os.tmpdir(), 'bsa-voice-clone'),
  limits: { fileSize: 30 * 1024 * 1024 }, // 30 MB — plenty for 5 min high-quality audio
});

aiRouter.post(
  '/bots/:botId/voice/clone',
  voiceCloneUpload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'no_file' });
      const name = (typeof req.body?.name === 'string' && req.body.name.trim())
        ? req.body.name.trim().slice(0, 60)
        : 'صوت المشغّل';
      const filePath = req.file.path;
      const mimeType = req.file.mimetype || 'audio/webm';
      const originalName = req.file.originalname || 'sample.webm';
      const buf = await fs.promises.readFile(filePath);

      const t0 = Date.now();
      let cloneRes: { voice_id: string };
      // Kick off clone + transcribe in parallel — Whisper failure never blocks
      // the clone (voice_id is the load-bearing artifact; the dialect hint is
      // a nice-to-have).
      const [cloneResult, transcript] = await Promise.all([
        AiProvider.cloneVoiceElevenLabs({
          name,
          files: [{ buffer: buf, filename: originalName, mimeType }],
        }),
        AiProvider.transcribe(buf, mimeType).catch((e) => {
          logger.warn({ err: e?.message ?? String(e) }, 'voice-clone: transcribe failed (non-fatal)');
          return '';
        }),
      ]);
      cloneRes = cloneResult;
      // Best-effort cleanup of the multer tmp file.
      await fs.promises.unlink(filePath).catch(() => {});

      const trimmed = (transcript || '').trim().slice(0, 800);
      await prisma.botAiConfig.upsert({
        where: { botId: req.params.botId },
        create: {
          botId: req.params.botId,
          voiceProvider: 'elevenlabs',
          voiceId: cloneRes.voice_id,
          voiceModelId: 'eleven_multilingual_v2',
          voiceClonedPersona: trimmed || null,
        },
        update: {
          voiceProvider: 'elevenlabs',
          voiceId: cloneRes.voice_id,
          voiceModelId: 'eleven_multilingual_v2',
          voiceClonedPersona: trimmed || null,
        },
      });
      logger.info(
        {
          botId: req.params.botId,
          voiceId: cloneRes.voice_id,
          transcriptChars: trimmed.length,
          durationMs: Date.now() - t0,
        },
        'voice-clone: created ElevenLabs IVC voice + updated BotAiConfig',
      );
      res.json({
        voiceId: cloneRes.voice_id,
        transcriptExcerpt: trimmed,
        latencyMs: Date.now() - t0,
      });
    } catch (e: any) {
      // Best-effort cleanup on error.
      if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => {});
      const msg = (e?.message ?? String(e)).slice(0, 300);
      logger.error({ err: msg, botId: req.params.botId }, 'voice-clone: failed');
      // Classify so the UI can show a friendly Arabic message + link to
      // /ai-keys instead of dumping the raw error JSON to the operator.
      // The `error` field stays for backward compat.
      const code =
        msg.includes('no_credentials_for_elevenlabs') ? 'missing_elevenlabs_key' :
        msg.startsWith('elevenlabs_clone_402')        ? 'elevenlabs_quota'       :
        msg.startsWith('elevenlabs_clone_401')        ? 'elevenlabs_auth'        :
                                                        'clone_failed';
      res.status(400).json({ error: msg, code });
    }
  },
);

/** Remove the cloned voice from the bot AND from ElevenLabs' cloud. */
aiRouter.delete('/bots/:botId/voice/clone', async (req, res, next) => {
  try {
    const cfg = await prisma.botAiConfig.findUnique({ where: { botId: req.params.botId } });
    if (!cfg) return res.json({ ok: true });
    const currentVoiceId = cfg.voiceId;
    // Reset the bot's persona + revert to the default preset voice (same as
    // schema default so operators get the pre-cloning experience back).
    await prisma.botAiConfig.update({
      where: { botId: req.params.botId },
      data: {
        voiceClonedPersona: null,
        voiceId: 'IES4nrmZdUBHByLBde0P',
      },
    });
    // Best-effort ElevenLabs delete. Silence 404 / auth failures — we've
    // already cleaned up on our side; the operator can manually purge from
    // ElevenLabs if needed.
    if (currentVoiceId && currentVoiceId !== 'IES4nrmZdUBHByLBde0P') {
      AiProvider.deleteVoiceElevenLabs(currentVoiceId).catch((e) => {
        logger.warn(
          { err: e?.message ?? String(e), voiceId: currentVoiceId, botId: req.params.botId },
          'voice-clone: ElevenLabs delete failed (bot-side reset succeeded anyway)',
        );
      });
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});
