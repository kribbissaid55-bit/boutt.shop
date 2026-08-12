/**
 * AiProvider — pluggable adapter over chat-completion + speech-to-text +
 * text-to-speech providers. The goal is one tiny interface the AI engine
 * calls, with concrete implementations for the major providers behind it.
 *
 * Chat completion: every major provider now ships an OpenAI-compatible
 * endpoint shape, so we ship a single ChatAdapter and just swap base URL +
 * model name per provider.
 *
 * STT: OpenAI Whisper (best Arabic/Darija accuracy at low cost).
 * TTS: OpenAI tts-1 / tts-1-hd (high-quality natural voices, multilingual).
 *      Optionally ElevenLabs for premium voice cloning (one extra credential).
 */
import { prisma } from '../lib/prisma.js';
import { decryptApiKey } from '../lib/ai-crypto.js';
import { logger } from '../config/logger.js';

/** A single block inside a multimodal user message. */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }     // OpenAI vision shape
  | { type: 'input_audio'; input_audio: { data: string; format: string } }; // for future audio-native models

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  /** Plain string (legacy) OR an array of typed parts for multimodal inputs. */
  content: string | ChatContentPart[];
};

export interface ChatRequest {
  messages: ChatMessage[];
  model: string;
  temperature?: number;
  maxTokens?: number;
  /** Optional JSON schema the model must answer with — used for order extraction. */
  responseJsonSchema?: object;
  /**
   * Escape hatch for the retry path in aiEngine: when set, `openaiCompatibleChat`
   * suppresses `response_format: json_object` even if `responseJsonSchema` is
   * still passed. Used when DeepSeek's json_object mode returned an empty `{}`
   * on the first pass — dropping the format lets the model answer in free-form
   * text, which aiEngine then uses directly as the reply.
   */
  plainTextOnly?: boolean;
}

export interface ChatResponse {
  text: string;
  /** When responseJsonSchema is set, parsed object. */
  parsed?: any;
  tokenUsage?: { input: number; output: number };
}

const PROVIDER_BASE: Record<string, { url: string; envFallback?: string }> = {
  openai:    { url: 'https://api.openai.com/v1', envFallback: 'OPENAI_API_KEY' },
  deepseek:  { url: 'https://api.deepseek.com/v1', envFallback: 'DEEPSEEK_API_KEY' },
  gemini:    { url: 'https://generativelanguage.googleapis.com/v1beta/openai', envFallback: 'GOOGLE_API_KEY' },
  anthropic: { url: 'https://api.anthropic.com/v1', envFallback: 'ANTHROPIC_API_KEY' },
  elevenlabs:{ url: 'https://api.elevenlabs.io/v1', envFallback: 'ELEVENLABS_API_KEY' },
};

async function getKey(provider: string): Promise<string> {
  const row = await prisma.aiCredential.findFirst({
    where: { provider, isDefault: true },
    orderBy: { createdAt: 'desc' },
  }) ?? await prisma.aiCredential.findFirst({
    where: { provider },
    orderBy: { createdAt: 'desc' },
  });
  if (row) {
    try { return decryptApiKey(row.encryptedKey); } catch (e) {
      logger.warn({ err: e, provider }, 'decryptApiKey failed — falling back to env');
    }
  }
  const env = PROVIDER_BASE[provider]?.envFallback;
  if (env && process.env[env]) {
    logger.warn(
      { provider, envVar: env },
      'AI: no DB credential for provider — using env fallback. Add a key at /ai-keys to make this stable.',
    );
    return process.env[env]!;
  }
  // Loud error the operator can grep in the log: tells them WHICH provider is
  // misconfigured. Common cause: operator switched their bot to use provider X
  // but never added a credential for X (or added it under the wrong provider
  // in the AiKeys form — the modal's default is 'openai').
  const known = await prisma.aiCredential.findMany({
    select: { provider: true }, distinct: ['provider'],
  }).then((rs) => rs.map((r) => r.provider));
  logger.error(
    { provider, availableCredentialProviders: known },
    'AI: chat call blocked — no credential AND no env fallback. Add a key for this provider at /ai-keys.',
  );
  throw Object.assign(new Error(`no_credentials_for_${provider}`), { status: 400 });
}

/** OpenAI-compatible chat-completion call (works for OpenAI/DeepSeek/Gemini). */
async function openaiCompatibleChat(
  provider: string,
  req: ChatRequest,
): Promise<ChatResponse> {
  const apiKey = await getKey(provider);
  const base = PROVIDER_BASE[provider]?.url;
  if (!base) throw new Error(`unknown_provider_${provider}`);
  const body: any = {
    model: req.model,
    messages: req.messages,
    temperature: req.temperature ?? 0.7,
  };
  if (req.maxTokens) body.max_tokens = req.maxTokens;
  // plainTextOnly is the retry escape hatch — see the ChatRequest doc comment.
  if (req.responseJsonSchema && !req.plainTextOnly) {
    body.response_format = { type: 'json_object' };
  }
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '<no-body>');
    throw new Error(`chat_${provider}_${res.status}: ${txt.slice(0, 200)}`);
  }
  const j: any = await res.json();
  const text: string = j?.choices?.[0]?.message?.content ?? '';
  let parsed: any;
  if (req.responseJsonSchema) {
    try { parsed = JSON.parse(text); } catch {}
  }
  const usage = j?.usage;
  return {
    text,
    parsed,
    tokenUsage: usage ? { input: usage.prompt_tokens, output: usage.completion_tokens } : undefined,
  };
}

/** Anthropic Claude (different shape from OpenAI). */
async function anthropicChat(req: ChatRequest): Promise<ChatResponse> {
  const apiKey = await getKey('anthropic');
  // Split system vs other messages.
  const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const turns = req.messages.filter((m) => m.role !== 'system').map((m) => ({
    role: m.role, content: m.content,
  }));
  const body: any = {
    model: req.model,
    max_tokens: req.maxTokens ?? 1024,
    system: system || undefined,
    messages: turns,
    temperature: req.temperature ?? 0.7,
  };
  const res = await fetch(`${PROVIDER_BASE.anthropic.url}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '<no-body>');
    throw new Error(`chat_anthropic_${res.status}: ${txt.slice(0, 200)}`);
  }
  const j: any = await res.json();
  const text = (j?.content ?? []).map((c: any) => c?.text ?? '').join('');
  let parsed: any;
  if (req.responseJsonSchema) {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) { try { parsed = JSON.parse(match[0]); } catch {} }
  }
  return {
    text, parsed,
    tokenUsage: j?.usage ? { input: j.usage.input_tokens, output: j.usage.output_tokens } : undefined,
  };
}

export const AiProvider = {
  async chat(provider: string, req: ChatRequest): Promise<ChatResponse> {
    if (provider === 'anthropic') return anthropicChat(req);
    return openaiCompatibleChat(provider, req);
  },

  /**
   * Verify a specific API key by calling the provider with a tiny prompt.
   * Bypasses the DB credential lookup — the caller supplies the raw key,
   * so this can validate a NEW key BEFORE we make it the default. Used by
   * the AiKeysPage's 🧪 button to give the operator instant feedback on
   * whether their key is valid, expired, out-of-quota, or otherwise broken.
   *
   * Never throws — always returns a structured result.
   */
  async pingWithKey(
    provider: string,
    apiKey: string,
  ): Promise<{ ok: boolean; latencyMs: number; sampleReply?: string; status?: number; error?: string }> {
    const t0 = Date.now();
    try {
      if (provider === 'anthropic') {
        const res = await fetch(`${PROVIDER_BASE.anthropic.url}/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5',
            max_tokens: 8,
            messages: [{ role: 'user', content: 'Reply with the word OK' }],
          }),
        });
        const latencyMs = Date.now() - t0;
        if (!res.ok) {
          const txt = await res.text().catch(() => '<no-body>');
          return { ok: false, latencyMs, status: res.status, error: txt.slice(0, 200) };
        }
        const j: any = await res.json();
        const text = (j?.content ?? []).map((c: any) => c?.text ?? '').join('');
        return { ok: true, latencyMs, sampleReply: text.slice(0, 100) };
      }
      // OpenAI-compatible (openai / deepseek / gemini). Use a widely-supported
      // small model per provider so we don't get "invalid model" errors that
      // masquerade as auth failures.
      const modelByProvider: Record<string, string> = {
        openai: 'gpt-4o-mini',
        deepseek: 'deepseek-chat',
        gemini: 'gemini-2.0-flash-lite',
      };
      const base = PROVIDER_BASE[provider]?.url;
      if (!base) return { ok: false, latencyMs: Date.now() - t0, error: `unknown_provider_${provider}` };
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: modelByProvider[provider] ?? 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'Reply with just: OK' }],
          max_tokens: 8,
          temperature: 0,
        }),
      });
      const latencyMs = Date.now() - t0;
      if (!res.ok) {
        const txt = await res.text().catch(() => '<no-body>');
        return { ok: false, latencyMs, status: res.status, error: txt.slice(0, 200) };
      }
      const j: any = await res.json();
      const text: string = j?.choices?.[0]?.message?.content ?? '';
      return { ok: true, latencyMs, sampleReply: text.slice(0, 100) };
    } catch (e: any) {
      return {
        ok: false,
        latencyMs: Date.now() - t0,
        error: (e?.message ?? String(e)).slice(0, 200),
      };
    }
  },

  /** Expose key lookup so routes can call provider APIs directly. */
  getKey,

  /**
   * ElevenLabs Instant Voice Cloning (IVC). Uploads 1-N audio samples of the
   * operator's voice; the API returns a `voice_id` that then works with every
   * TTS endpoint (elevenlabsTts uses it as `/v1/text-to-speech/{voiceId}`).
   *
   * Requires an ElevenLabs plan that includes IVC (Starter and above; Starter
   * caps at 1 clone). Quota / auth failures come back as a thrown Error with
   * the sanitized provider message so the caller can surface it to the UI.
   */
  async cloneVoiceElevenLabs(opts: {
    name: string;
    description?: string;
    files: { buffer: Buffer; filename: string; mimeType: string }[];
  }): Promise<{ voice_id: string }> {
    const apiKey = await getKey('elevenlabs');
    const form = new FormData();
    form.append('name', opts.name);
    if (opts.description) form.append('description', opts.description);
    for (const f of opts.files) {
      const blob = new Blob([new Uint8Array(f.buffer)], { type: f.mimeType || 'audio/mpeg' });
      form.append('files', blob, f.filename);
    }
    const res = await fetch(`${PROVIDER_BASE.elevenlabs.url}/voices/add`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey },
      body: form,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '<no-body>');
      throw new Error(`elevenlabs_clone_${res.status}: ${txt.slice(0, 300)}`);
    }
    const j: any = await res.json();
    if (!j?.voice_id) throw new Error('elevenlabs_clone_no_voice_id');
    return { voice_id: String(j.voice_id) };
  },

  /**
   * Remove a cloned voice from the operator's ElevenLabs library. Called when
   * the operator clicks "حذف الاستنساخ". Best-effort: a 404 is not an error
   * (voice may have been removed manually from the ElevenLabs dashboard).
   */
  async deleteVoiceElevenLabs(voiceId: string): Promise<{ ok: boolean }> {
    const apiKey = await getKey('elevenlabs');
    const res = await fetch(`${PROVIDER_BASE.elevenlabs.url}/voices/${encodeURIComponent(voiceId)}`, {
      method: 'DELETE',
      headers: { 'xi-api-key': apiKey },
    });
    if (res.ok || res.status === 404) return { ok: true };
    const txt = await res.text().catch(() => '<no-body>');
    throw new Error(`elevenlabs_delete_${res.status}: ${txt.slice(0, 200)}`);
  },

  /**
   * Transcribe audio bytes to text via OpenAI. Uses the newer
   * `gpt-4o-mini-transcribe` model (better Darija accuracy than `whisper-1`)
   * with `language: 'ar'` AND a vocabulary anchor prompt — Whisper biases
   * decoding toward words listed in the prompt, so this dramatically improves
   * recognition of Darija-specific words like "بغيت", "شحال", "كاين".
   */
  async transcribe(audioBuf: Buffer, mimeType: string, extraPrompt?: string): Promise<string> {
    const apiKey = await getKey('openai');
    const ext = mimeTypeToExt(mimeType);
    const blob = new Blob([new Uint8Array(audioBuf)], { type: mimeType || 'audio/ogg' });
    const form = new FormData();
    form.append('file', blob, `audio.${ext}`);
    form.append('model', 'gpt-4o-mini-transcribe');
    form.append('language', 'ar');
    form.append('response_format', 'json');
    const prompt = extraPrompt
      ? `${STT_DARIJA_ANCHOR}\n${extraPrompt}`
      : STT_DARIJA_ANCHOR;
    form.append('prompt', prompt);
    const res = await fetch(`${PROVIDER_BASE.openai.url}/audio/transcriptions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: form,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '<no-body>');
      throw new Error(`stt_openai_${res.status}: ${txt.slice(0, 200)}`);
    }
    const j: any = await res.json();
    return j?.text ?? '';
  },

  /**
   * Synthesise text → ogg/opus audio bytes (WhatsApp voice-note compatible).
   *
   * Quality tiers:
   *   - 'standard' (default) → `gpt-4o-mini-tts` with operator-tunable
   *     `instructions` (accent, tone, pace). Best for Darija naturalness.
   *   - 'hd' → `tts-1-hd` (no instructions, but higher fidelity).
   */
  async tts(
    text: string,
    opts: {
      voice: string;
      provider?: string;
      instructions?: string;
      quality?: 'standard' | 'hd';
      // ElevenLabs voice settings — ignored for openai provider
      voiceStability?: number;
      voiceSimilarityBoost?: number;
      voiceStyle?: number;
      voiceModelId?: string;
    },
  ): Promise<Buffer> {
    const provider = opts.provider ?? 'openai';
    if (provider === 'elevenlabs') return elevenlabsTts(text, opts.voice, {
      stability: opts.voiceStability,
      similarityBoost: opts.voiceSimilarityBoost,
      style: opts.voiceStyle,
      modelId: opts.voiceModelId,
    });
    const apiKey = await getKey('openai');
    const model = opts.quality === 'hd' ? 'tts-1-hd' : 'gpt-4o-mini-tts';
    const body: any = {
      model,
      voice: opts.voice || 'nova',
      input: text.slice(0, 4000),
      response_format: 'opus',  // ogg/opus container — WhatsApp voice-note format
    };
    // Only the newer gpt-4o-mini-tts supports `instructions` for accent/style.
    if (model === 'gpt-4o-mini-tts') {
      const fullInstructions = opts.instructions
        ? `${TTS_DARIJA_BASELINE}\n${opts.instructions}`
        : TTS_DARIJA_BASELINE;
      body.instructions = fullInstructions;
    }
    const res = await fetch(`${PROVIDER_BASE.openai.url}/audio/speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '<no-body>');
      throw new Error(`tts_openai_${res.status}: ${txt.slice(0, 200)}`);
    }
    return Buffer.from(await res.arrayBuffer());
  },
};

/**
 * Hardcoded baselines — the floor for voice + transcription quality regardless
 * of operator config. Operator-supplied overrides ADD to these, never replace.
 */
// Arabic-language steering tends to produce stronger Arabic intonation from
// gpt-4o-mini-tts than English steering does. Operator's `voiceInstructions`
// is appended AFTER this baseline (operator-last wins on conflict).
const TTS_DARIJA_BASELINE =
  "أنت بائع/ة مغربي/ة طبيعي/ة تتكلم الدارجة المغربية الأصلية " +
  "(لهجة الدار البيضاء أو الرباط).\n" +
  "- إيقاع متوسط: ليس سريعا جدا، ليس بطيئا.\n" +
  "- نبرة دافئة مهنية ودية كأنك في متجر حقيقي، ولست مذيع/ة أخبار.\n" +
  "- تنغيم طبيعي: ارفع الصوت قليلا في نهاية الأسئلة، اخفضه في نهاية الجمل المثبتة.\n" +
  "- لا تنطق الكلمات بإطالة مصطنعة. الحركات والمدود بسيطة وطبيعية.\n" +
  "- عند ذكر الأرقام والثمن، انطقها بالعربية المغربية (مثال: \"تسعة وتسعين درهم\").\n" +
  "- الكلمات الدخيلة من الفرنسية (siplé, mzyan, bonjour) ينطقها بلكنتها الطبيعية.\n" +
  "- تجنب الفصحى الجافة، وتجنب أي لكنة إنجليزية أو خليجية.";

const STT_DARIJA_ANCHOR =
  "محادثة بالدارجة المغربية حول التسوق والطلبات. كلمات شائعة: " +
  "شحال، بغيت، كاين، فين، عافاك، صافي، واخا، بزاف، شوية، الثمن، " +
  "التوصيل، الكمية، المدينة، الدار البيضاء، الرباط، مراكش، فاس، طنجة، " +
  "أكادير، مرحبا، السلام، ايه، ايوا، ما عنديش، خاصني، عندي، نشري، " +
  "كنشري، غادي، رخيص، غالي، كنحب، نتمنى، هاد، داكشي، مزيان، بسلامة، " +
  "كيفاش، شنو، ولا، عاود، ديالي، ديالك، الله يخليك، البركة، بصح، ياك، " +
  "ساي، يلاه، فلوس، درهم، توصيلة، وحدة، جوج، تلاتة.";

/**
 * ElevenLabs voice synthesis with full quality controls.
 * Uses `eleven_turbo_v2_5` by default (best Arabic naturalness/latency in
 * late-2025). Accepts voice_settings to tune expression vs stability.
 */
async function elevenlabsTts(
  text: string,
  voiceId: string,
  opts?: {
    stability?: number;
    similarityBoost?: number;
    style?: number;
    modelId?: string;
  },
): Promise<Buffer> {
  const apiKey = await getKey('elevenlabs');
  const url = `${PROVIDER_BASE.elevenlabs.url}/text-to-speech/${encodeURIComponent(voiceId)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'xi-api-key': apiKey,
      'Accept': 'audio/ogg',
    },
    body: JSON.stringify({
      text: text.slice(0, 4000),
      model_id: opts?.modelId ?? 'eleven_turbo_v2_5',
      output_format: 'opus_48000',
      voice_settings: {
        stability: opts?.stability ?? 0.5,
        similarity_boost: opts?.similarityBoost ?? 0.75,
        style: opts?.style ?? 0.35,
        use_speaker_boost: true,
      },
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '<no-body>');
    // Fallback to multilingual_v2 if turbo isn't on the user's plan
    if (res.status === 404 || /not.*available|forbidden/i.test(txt)) {
      return elevenlabsTtsLegacy(text, voiceId, opts);
    }
    throw new Error(`tts_elevenlabs_${res.status}: ${txt.slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Legacy fallback using eleven_multilingual_v2 (broad plan availability). */
async function elevenlabsTtsLegacy(
  text: string,
  voiceId: string,
  opts?: { stability?: number; similarityBoost?: number; style?: number },
): Promise<Buffer> {
  const apiKey = await getKey('elevenlabs');
  const url = `${PROVIDER_BASE.elevenlabs.url}/text-to-speech/${encodeURIComponent(voiceId)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'xi-api-key': apiKey,
      'Accept': 'audio/ogg',
    },
    body: JSON.stringify({
      text: text.slice(0, 4000),
      model_id: 'eleven_multilingual_v2',
      output_format: 'opus_48000',
      voice_settings: {
        stability: opts?.stability ?? 0.5,
        similarity_boost: opts?.similarityBoost ?? 0.75,
        style: opts?.style ?? 0.35,
        use_speaker_boost: true,
      },
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '<no-body>');
    throw new Error(`tts_elevenlabs_${res.status}: ${txt.slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

function mimeTypeToExt(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes('webm')) return 'webm';
  if (m.includes('ogg') || m.includes('opus')) return 'ogg';
  if (m.includes('mp3') || m.includes('mpeg')) return 'mp3';
  if (m.includes('mp4') || m.includes('m4a')) return 'm4a';
  if (m.includes('wav')) return 'wav';
  if (m.includes('flac')) return 'flac';
  return 'bin';
}
