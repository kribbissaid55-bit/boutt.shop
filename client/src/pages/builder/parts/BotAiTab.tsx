/**
 * BotAiTab — AI personality, voice, order-collection, owner-notify config.
 * Reuses the existing MediaPickerModal for intro media. Includes a built-in
 * WhatsApp-style preview (right pane) for end-to-end testing without paying
 * for a real WA send.
 */
import { useEffect, useRef, useState } from 'react';
import { Save, Sparkles, Mic, Phone, Settings as SettingsIcon, MessageCircle, Send, Package, Paperclip, X, Info, Clock } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../../../api/client';
import { useI18n } from '../../../i18n';
import { Card, CardBody, CardHeader } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Input, Field, Textarea } from '../../../components/ui/Input';
import { Modal } from '../../../components/ui/Modal';
import { MediaPickerModal } from './MediaPickerModal';
import { UnifiedBotTest } from './UnifiedBotTest';

type AiCfg = {
  enabled: boolean;
  provider: 'openai' | 'deepseek' | 'gemini' | 'anthropic';
  model: string;
  // Optional override for voice-mode chat replies.
  voiceChatProvider: 'openai' | 'deepseek' | 'gemini' | 'anthropic' | null;
  voiceChatModel: string | null;
  systemPrompt: string;
  replyMode: 'text' | 'voice' | 'auto';
  voiceProvider: 'openai' | 'elevenlabs';
  voiceId: string;
  transcribeAudio: boolean;
  collectionEnabled: boolean;
  collectName: boolean; collectPhone: boolean; collectCity: boolean;
  collectAddress: boolean; collectQuantity: boolean;
  notifyOwnerEnabled: boolean;
  ownerPhone: string | null;
  stopWord: string | null;
  ownerInterventionMinutes: number;
  maxRepliesPerSession: number;
  customerReplyTimeoutMin: number;
  continueAfterOrder: boolean;
  postOrderThanksMessage: string | null;
  instructionMedia: string | null;
  customerTagsConfig: string | null;
  requirePreSendConfirm: boolean;
  voiceQuality: 'standard' | 'hd';
  voiceInstructions: string | null;
  sttContextPrompt: string | null;
  chatTemperature: number;
  voiceStability: number;
  voiceSimilarityBoost: number;
  voiceModelId: 'eleven_turbo_v2_5' | 'eleven_multilingual_v2' | 'eleven_v3';
  voiceStyle: number;
  engineMode: 'rule_only' | 'ai_only' | 'hybrid' | 'rule_priority' | 'disabled';
  // Reply-timing controls. Values in seconds; 0 = no delay.
  firstReplyDelaySeconds: number;
  firstReplyDelayMaxSeconds: number;
  firstReplyRandomize: boolean;
  replyDelaySeconds: number;
  replyDelayMaxSeconds: number;
  replyRandomize: boolean;
  // Set after the operator clones their voice via ElevenLabs IVC. Contains
  // a Whisper transcript excerpt of the cloned sample — the LLM uses it to
  // mimic the operator's dialect + tone. NULL when no clone exists.
  voiceClonedPersona?: string | null;
};

interface Media { id: string; name: string; type: string }
type InstructionMediaItem = { id: string; label: string; note?: string };

type CustomerStatusKey = 'sentNoReply' | 'replied' | 'ordered';
type TagCategory = { enabled: boolean; label: string; color: number };
type CustomerTagsConfig = {
  enabled: boolean;
  sentNoReply: TagCategory;
  replied:     TagCategory;
  ordered:     TagCategory;
};

const DEFAULT_TAGS_CONFIG: CustomerTagsConfig = {
  enabled: false,
  sentNoReply: { enabled: true, label: 'ما ردّش', color: 5 },
  replied:     { enabled: true, label: 'ردّ',      color: 9 },
  ordered:     { enabled: true, label: 'طلب',      color: 2 },
};

// 20 WhatsApp label colors (Baileys palette). The hex values are approximate
// and used only to preview the swatch in the dropdown — the actual WA color
// is decided by the index when the label is created server-side.
const WA_LABEL_COLORS: string[] = [
  '#FF7B6A','#FFB02E','#FFC93C','#76C843','#22C55E',
  '#EF4444','#F472B6','#A855F7','#6366F1','#3B82F6',
  '#0EA5E9','#06B6D4','#14B8A6','#84CC16','#A3A3A3',
  '#737373','#525252','#737A8A','#9CA3AF','#1F2937',
];

function sanitizeLabel(s: string): string {
  return s.toLowerCase()
    .replace(/[\s.]+/g, '_')
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 40) || 'media';
}

type VoiceLang = 'darija' | 'ar' | 'multi' | 'en';

// Curated OpenAI voices ordered by Arabic suitability. The `lang` badge tells
// the operator honestly which voices carry Arabic intonation naturally vs which
// are English-default. All six can speak Arabic via the `instructions`
// accent-steering, but the 'darija' ones sound noticeably more native.
const OPENAI_VOICES: { id: string; label: string; lang: VoiceLang }[] = [
  { id: 'alloy',   label: 'Alloy — محايد',              lang: 'darija' },
  { id: 'onyx',    label: 'Onyx — رجالي عميق',          lang: 'darija' },
  { id: 'shimmer', label: 'Shimmer — أنثوي رقيق',       lang: 'darija' },
  { id: 'nova',    label: 'Nova — أنثوي',               lang: 'en' },
  { id: 'echo',    label: 'Echo — رجالي',               lang: 'en' },
  { id: 'fable',   label: 'Fable — دافئ',               lang: 'en' },
  // Newer OpenAI TTS voices — well-suited to Darija persona steering.
  { id: 'ash',     label: 'Ash — رجالي هادئ (جديد)',    lang: 'darija' },
  { id: 'coral',   label: 'Coral — أنثوي حيوي (جديد)',   lang: 'darija' },
  { id: 'sage',    label: 'Sage — رجالي وقور (جديد)',    lang: 'darija' },
];

// Curated ElevenLabs voices that carry Arabic well. Combined with the new
// default `voiceModelId = eleven_multilingual_v2`, even the 'multi' voices
// pronounce Arabic correctly. Operators can also pick from their ElevenLabs
// library (cloned voices) via the "📚 من مكتبتك" mode in ElevenVoicePicker.
const ELEVEN_VOICES: { id: string; label: string; lang: VoiceLang }[] = [
  { id: 'IES4nrmZdUBHByLBde0P', label: 'Haytham — رجالي عربي طبيعي',          lang: 'ar' },
  { id: 'tnSpp4vdxKPjI9w0GnoV', label: 'Hope — أنثوي عربي/متعدد، دافئ',       lang: 'ar' },
  { id: 'pNInz6obpgDQGcFmaJgB', label: 'Adam — متعدد، يقبل العربية',          lang: 'multi' },
  { id: 'XB0fDUnXU5powFXDhCwa', label: 'Charlotte — متعدد، أنثوي هادئ',       lang: 'multi' },
  { id: '21m00Tcm4TlvDq8ikWAM', label: 'Rachel — متعدد، أنثوي دافئ',          lang: 'multi' },
  { id: 'TX3LPaxmHKxFdv7VOQHJ', label: 'Liam — متعدد، رجالي ودي',             lang: 'multi' },
  // Additional widely-available ElevenLabs shared voices — all multilingual,
  // pair well with `eleven_multilingual_v2` when the operator's ElevenLabs
  // subscription includes Voice Library access.
  { id: 'CwhRBWXzGAHq8TQ4Fs17', label: 'Roger — رجالي متعدد، مناسب للدارجة',   lang: 'multi' },
  { id: 'ZQe5CZNOzWyzPSCn5a3c', label: 'James — رجالي متعدد، هادئ',            lang: 'multi' },
  { id: 'JBFqnCBsd6RMkjVDRZzb', label: 'George — رجالي متعدد، عميق',           lang: 'multi' },
  { id: 'nPczCjzI2devNBz1zQrb', label: 'Bill — رجالي متعدد، صديق',             lang: 'multi' },
];

// Curated "one-click" Moroccan voice presets. Each preset bundles a full
// voice config (provider + voice + model + sliders + persona instructions)
// that has been hand-tuned for Darija pronunciation. Selecting a preset
// auto-applies every field in the voice card — operator can still adjust
// afterwards. The persona `instructions` overlay is what makes OpenAI's
// English-first voices sound distinctly Moroccan; the server-side
// TTS_DARIJA_BASELINE still applies underneath.
type MoroccanPreset = {
  key: string;
  emoji: string;
  label: string;
  provider: 'openai' | 'elevenlabs';
  voiceId: string;
  voiceModelId?: 'eleven_multilingual_v2' | 'eleven_turbo_v2_5' | 'eleven_v3';
  voiceQuality?: 'standard' | 'hd';
  voiceStability?: number;
  voiceSimilarityBoost?: number;
  voiceStyle?: number;
  instructions: string;
};

const MOROCCAN_PRESETS: MoroccanPreset[] = [
  {
    key: 'karim-sales',
    emoji: '🧔',
    label: 'كريم — بائع مغربي دافئ',
    provider: 'openai',
    voiceId: 'onyx',
    voiceQuality: 'standard',
    instructions: 'أنت كريم، بائع مغربي في محل بالدار البيضاء. لهجة دار البيضاء الأصلية. صوت رجالي دافئ ومقنع، عمرك حوالي 35 سنة. تتحدث بثقة الخبير الذي يعرف منتجه، لكن دون تباهي. تنغيم متوسط الإيقاع، لا تسرع ولا تُطيل. عند شرح المزايا استعمل جمل قصيرة قوية. عند ذكر الأثمنة انطقها بوضوح («مية وسبعين درهم»). تجنب اللكنة الفصحى أو الخليجية.',
  },
  {
    key: 'salma-professional',
    emoji: '👩‍💼',
    label: 'سلمى — موظفة استقبال مهنية',
    provider: 'openai',
    voiceId: 'nova',
    voiceQuality: 'standard',
    instructions: 'أنت سلمى، موظفة استقبال في متجر إلكتروني بالرباط. لهجة رباطية أنيقة. صوت أنثوي مهني ودود، عمرك حوالي 28 سنة. تلقي التحية ببرودة الاحتراف مع دفء الترحيب. إيقاع متوسط، جمل مرتبة. عند طلب معلومات العميل (اسم، هاتف، عنوان) اسألي بوضوح ولطف. تجنبي الفصحى الجافة والتشنج.',
  },
  {
    key: 'yassin-consultant',
    emoji: '🎓',
    label: 'ياسين — مستشار مبيعات',
    provider: 'openai',
    voiceId: 'ash',
    voiceQuality: 'hd',
    instructions: 'أنت ياسين، مستشار مبيعات ذو خبرة في متجر بمراكش. لهجة مراكشية سلسة. صوت رجالي هادئ محترم، عمرك حوالي 40 سنة. تنغيم بطيء متأمل يوحي بالثقة والخبرة. تتكلم بمصداقية، تُقنع دون ضغط. عند شرح تقني تُبسّط. لا تُبالغ في الحماس.',
  },
  {
    key: 'yasmine-customer-service',
    emoji: '💐',
    label: 'ياسمين — خدمة عملاء دافئة',
    provider: 'openai',
    voiceId: 'shimmer',
    voiceQuality: 'standard',
    instructions: 'أنت ياسمين، من خدمة العملاء في شركة توصيل بأكادير. لهجة سوسية طبيعية. صوت أنثوي دافئ متعاطف، عمرك حوالي 32 سنة. تتعاملي مع كل عميل كأنه ضيف. عند مشكلة اعتذري بصدق، عند سؤال أجيبي بوضوح. إيقاع دافئ ليس بطيئا. الابتسامة تُسمع في صوتك.',
  },
  {
    key: 'haytham-elevenlabs',
    emoji: '🎙️',
    label: 'هيثم — صوت مغربي طبيعي (ElevenLabs)',
    provider: 'elevenlabs',
    voiceId: 'IES4nrmZdUBHByLBde0P',
    voiceModelId: 'eleven_multilingual_v2',
    voiceStability: 0.55,
    voiceSimilarityBoost: 0.80,
    voiceStyle: 0.30,
    instructions: 'دارجة مغربية طبيعية، إيقاع محادثة يومية.',
  },
  {
    key: 'hope-elevenlabs',
    emoji: '🌸',
    label: 'هوب — صوت أنثوي عربي (ElevenLabs)',
    provider: 'elevenlabs',
    voiceId: 'tnSpp4vdxKPjI9w0GnoV',
    voiceModelId: 'eleven_multilingual_v2',
    voiceStability: 0.55,
    voiceSimilarityBoost: 0.80,
    voiceStyle: 0.30,
    instructions: 'دارجة مغربية أنثوية دافئة، مهنية ودودة.',
  },
];

function voiceBadge(lang: VoiceLang): string {
  if (lang === 'darija') return '🇲🇦 يقبل الدارجة';
  if (lang === 'ar')     return '🇲🇦 عربي';
  if (lang === 'multi')  return '🌍 متعدد';
  return '🇬🇧 إنجليزي أساسا';
}

// gpt-4o is the new default (smarter, follows Darija instructions better).
const MODELS_BY_PROVIDER: Record<string, string[]> = {
  openai:    ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini'],
  deepseek:  ['deepseek-chat', 'deepseek-reasoner'],
  gemini:    ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
  anthropic: ['claude-3-5-haiku-latest', 'claude-3-5-sonnet-latest', 'claude-opus-4-5'],
};

export function BotAiTab({ botId, onSwitchToSteps }: { botId: string; onSwitchToSteps?: () => void }) {
  const { t } = useI18n();
  const [cfg, setCfg] = useState<AiCfg | null>(null);
  const [busy, setBusy] = useState(false);
  // Brain media — operator-pinned attachments referenced inline from the
  // systemPrompt by short labels. Stored as a hidden in-memory array; the
  // operator never sees it as a list — only their inserted labels in the
  // prompt text. GC on save drops entries whose label no longer appears.
  const [instructionMedia, setInstructionMedia] = useState<InstructionMediaItem[]>([]);
  const [instructionPickerOpen, setInstructionPickerOpen] = useState(false);
  const systemPromptRef = useRef<HTMLTextAreaElement>(null);
  // Customer status tags (admin chip + WA chat label). Hydrated from cfg.
  const [tagsCfg, setTagsCfg] = useState<CustomerTagsConfig>(DEFAULT_TAGS_CONFIG);

  // (Preview state now lives entirely inside <UnifiedBotTest>; this tab only
  // owns the configuration form on the left side.)

  // linked products
  const [linkedProducts, setLinkedProducts] = useState<{ id: string; name: string; price: string | null }[]>([]);
  const [allProducts, setAllProducts] = useState<{ id: string; name: string; price: string | null }[]>([]);
  const [productPickerOpen, setProductPickerOpen] = useState(false);
  // Providers that have at least one saved API credential. Used to warn the
  // operator inline when they've picked a provider with no key on file —
  // otherwise every reply would silently fail because getKey() would fall
  // back to an empty env var. Refreshed whenever this tab reloads.
  const [credProviders, setCredProviders] = useState<Set<string>>(new Set());

  useEffect(() => {
    api.get<AiCfg>(`/bots/${botId}/ai`).then(setCfg);
    api.get<typeof linkedProducts>(`/products/bot/${botId}`).then(setLinkedProducts).catch(() => {});
    api.get<typeof allProducts>('/products').then(setAllProducts).catch(() => {});
    api.get<{ provider: string }[]>('/ai/credentials')
      .then((rows) => setCredProviders(new Set(rows.map((r) => r.provider))))
      .catch(() => {});
  }, [botId]);

  const linkProduct = async (productId: string) => {
    await api.post(`/products/bot/${botId}/link`, { productId });
    const fresh = await api.get<typeof linkedProducts>(`/products/bot/${botId}`);
    setLinkedProducts(fresh);
  };
  const unlinkProduct = async (productId: string) => {
    await api.delete(`/products/bot/${botId}/link/${productId}`);
    setLinkedProducts((prev) => prev.filter((p) => p.id !== productId));
  };

  // Hydrate the brain-media list from the cfg JSON string.
  useEffect(() => {
    if (!cfg) return;
    let items: InstructionMediaItem[] = [];
    try {
      const raw = (cfg as any).instructionMedia;
      if (raw) items = JSON.parse(raw);
    } catch {}
    setInstructionMedia(Array.isArray(items) ? items : []);
  }, [cfg?.instructionMedia]);

  useEffect(() => {
    if (!cfg) return;
    let parsed: CustomerTagsConfig = DEFAULT_TAGS_CONFIG;
    try {
      const raw = (cfg as any).customerTagsConfig;
      if (raw) parsed = { ...DEFAULT_TAGS_CONFIG, ...JSON.parse(raw) };
    } catch {}
    setTagsCfg(parsed);
  }, [cfg?.customerTagsConfig]);

  const patchTag = (key: CustomerStatusKey, patch: Partial<TagCategory>) => {
    setTagsCfg((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  };

  const insertAtCursor = (text: string) => {
    if (!cfg) return;
    const ta = systemPromptRef.current;
    const current = cfg.systemPrompt ?? '';
    const start = ta?.selectionStart ?? current.length;
    const end = ta?.selectionEnd ?? current.length;
    const next = current.slice(0, start) + text + current.slice(end);
    update({ systemPrompt: next });
    requestAnimationFrame(() => {
      ta?.focus();
      const pos = start + text.length;
      ta?.setSelectionRange(pos, pos);
    });
  };

  const addInstructionMedia = async (mediaId: string) => {
    // Dedup by mediaId — if already bound, reuse its label so the operator
    // doesn't end up with `demo` and `demo_2` for the same file.
    const existing = instructionMedia.find((x) => x.id === mediaId);
    if (existing) {
      setInstructionPickerOpen(false);
      insertAtCursor(existing.label);
      return;
    }
    const all = await api.get<Media[]>('/media').catch(() => [] as Media[]);
    const found = all.find((m) => m.id === mediaId);
    const base = sanitizeLabel(found?.name ?? 'media');
    let label = base, i = 2;
    while (instructionMedia.some((x) => x.label === label)) label = `${base}_${i++}`;
    setInstructionMedia((prev) => [...prev, { id: mediaId, label }]);
    setInstructionPickerOpen(false);
    insertAtCursor(label);
  };

  if (!cfg) return <div className="p-8 text-gray-400">…</div>;

  const update = (patch: Partial<AiCfg>) => setCfg({ ...cfg, ...patch });

  const save = async () => {
    setBusy(true);
    try {
      const payload: any = { ...cfg };
      // GC orphans: only keep brain-media entries whose label actually
      // appears in the systemPrompt text. If the operator deleted the label
      // from the prompt, the binding drops automatically — no manual
      // management UI needed.
      const promptText = cfg.systemPrompt ?? '';
      payload.instructionMedia = instructionMedia
        .filter((it) => it.id && it.label.trim() && promptText.includes(it.label.trim()))
        .map((it) => ({ id: it.id, label: it.label.trim() }));
      // Customer-tag config goes as a parsed object — server stringifies it.
      payload.customerTagsConfig = tagsCfg;
      const updated = await api.patch<AiCfg>(`/bots/${botId}/ai`, payload);
      setCfg(updated);
      toast.success(t.app.saved);
    } catch (e: any) {
      toast.error(e?.message ?? t.app.error);
    } finally { setBusy(false); }
  };

  return (
    <div className="grid h-full grid-cols-1 gap-4 p-6 lg:grid-cols-[1fr_380px]">
      {/* LEFT — config */}
      <div className="space-y-4">
        {/* Info banner — AI inherits all bot-level rules */}
        <div className="flex items-start gap-2 rounded-lg border border-blue-100 bg-blue-50/60 px-3 py-2 text-[12px] text-blue-900">
          <Info size={14} className="mt-0.5 shrink-0 text-blue-600" />
          <div className="flex-1">
            {t.builder.ai.rulesBanner}
            {onSwitchToSteps && (
              <>
                {' '}
                <button onClick={onSwitchToSteps} className="font-medium underline hover:text-blue-700">
                  {t.builder.ai.openBotRules}
                </button>
              </>
            )}
          </div>
        </div>

        <Card>
          <CardHeader>
            <span className="inline-flex items-center gap-2">
              <Sparkles size={16} className="text-brand-600" />
              {t.builder.ai.title}
            </span>
          </CardHeader>
          <CardBody className="space-y-4">
            <EngineModePicker
              value={cfg.engineMode ?? 'hybrid'}
              onChange={(v) => {
                // Keep `enabled` in sync for backward-compat callers.
                update({ engineMode: v, enabled: v !== 'disabled' && v !== 'rule_only' });
              }}
            />
            <FallbackToggle botId={botId} engineMode={cfg.engineMode ?? 'hybrid'} />

            <div className="grid grid-cols-2 gap-3">
              <Field label={t.builder.ai.provider}>
                <select className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" value={cfg.provider} onChange={(e) => {
                  const p = e.target.value as AiCfg['provider'];
                  update({ provider: p, model: MODELS_BY_PROVIDER[p][0] });
                }}>
                  <option value="openai">OpenAI</option>
                  <option value="deepseek">DeepSeek</option>
                  <option value="gemini">Google Gemini</option>
                  <option value="anthropic">Anthropic Claude</option>
                </select>
              </Field>
              <Field label={t.builder.ai.model}>
                <select className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" value={cfg.model} onChange={(e) => update({ model: e.target.value })}>
                  {(MODELS_BY_PROVIDER[cfg.provider] ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </Field>
            </div>
            {!credProviders.has(cfg.provider) && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800" dir="rtl">
                ⚠️ لا يوجد مفتاح API محفوظ للمزوّد المختار «{cfg.provider}». البوت لن يستطيع الرد على العملاء حتى تضيف مفتاحاً من صفحة{' '}
                <a href="/ai-keys" className="underline font-medium">مفاتيح الذكاء</a>{' '}
                (أو غيّر المزوّد لواحد لديك مفتاح له).
              </div>
            )}

            {/* Optional LLM override for voice-mode replies */}
            <div className="rounded-lg border border-violet-100 bg-violet-50/30 p-2">
              <div className="mb-1 flex items-center gap-2">
                <span className="text-xs font-semibold text-violet-800">🔁 {t.builder.ai.voiceChatProvider}</span>
              </div>
              <p className="mb-2 text-[11px] leading-snug text-violet-800/70">{t.builder.ai.voiceChatProviderHint}</p>
              <div className="grid grid-cols-2 gap-2">
                <select
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm"
                  value={cfg.voiceChatProvider ?? ''}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (!v) update({ voiceChatProvider: null, voiceChatModel: null });
                    else update({
                      voiceChatProvider: v as AiCfg['voiceChatProvider'],
                      voiceChatModel: MODELS_BY_PROVIDER[v][0],
                    });
                  }}
                >
                  <option value="">— {t.builder.ai.voiceChatSameAsDefault} —</option>
                  <option value="openai">OpenAI</option>
                  <option value="deepseek">DeepSeek</option>
                  <option value="gemini">Google Gemini</option>
                  <option value="anthropic">Anthropic Claude</option>
                </select>
                <select
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm disabled:opacity-50"
                  disabled={!cfg.voiceChatProvider}
                  value={cfg.voiceChatModel ?? ''}
                  onChange={(e) => update({ voiceChatModel: e.target.value })}
                >
                  {(cfg.voiceChatProvider ? MODELS_BY_PROVIDER[cfg.voiceChatProvider] ?? [] : []).map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
              {/* Voice-override warning: same idea as the top provider warning.
                  If the operator sets a voice-chat provider but never added a
                  key for it, voice-turns will silently fail. */}
              {cfg.voiceChatProvider && !credProviders.has(cfg.voiceChatProvider) && (
                <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800" dir="rtl">
                  ⚠️ لا يوجد مفتاح API للمزوّد «{cfg.voiceChatProvider}» الذي حددته للردود الصوتية. أضف مفتاحاً في{' '}
                  <a href="/ai-keys" className="underline font-medium">مفاتيح الذكاء</a>.
                </div>
              )}
              {/* "Test which model answers what" — hits the preview endpoint
                  twice (text turn + audio turn) and shows which provider/model
                  actually got picked, so the operator can verify the routing
                  matches their intent without touching real WhatsApp. */}
              <VoiceOverrideTester botId={botId} />
            </div>

            <div className="relative">
              <Field label={t.builder.ai.systemPrompt} hint={t.builder.ai.systemPromptHint}>
                <Textarea
                  ref={systemPromptRef}
                  rows={8}
                  value={cfg.systemPrompt}
                  onChange={(e) => update({ systemPrompt: e.target.value })}
                />
              </Field>
              <button
                type="button"
                onClick={() => setInstructionPickerOpen(true)}
                title={t.builder.ai.instructionMediaAdd}
                aria-label={t.builder.ai.instructionMediaAdd}
                className="absolute top-7 end-2 inline-flex items-center gap-1 rounded-full border border-violet-200 bg-white px-2 py-1 text-[11px] font-medium text-violet-700 shadow-sm hover:border-violet-400 hover:bg-violet-50"
              >
                <Paperclip size={12} /> {t.builder.ai.instructionMediaAdd}
              </button>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <span className="inline-flex items-center gap-2"><Mic size={16} className="text-emerald-600" /> {t.builder.ai.voiceSection}</span>
          </CardHeader>
          <CardBody className="space-y-3">
            <Field label={t.builder.ai.replyMode}>
              <select className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" value={cfg.replyMode} onChange={(e) => update({ replyMode: e.target.value as any })}>
                <option value="text">{t.builder.ai.modeText}</option>
                <option value="voice">{t.builder.ai.modeVoice}</option>
                <option value="auto">{t.builder.ai.modeAuto}</option>
              </select>
            </Field>
            {cfg.replyMode !== 'text' && (
              <div className="grid grid-cols-2 gap-3">
                <Field label={t.builder.ai.voiceProvider}>
                  <select className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" value={cfg.voiceProvider} onChange={(e) => update({ voiceProvider: e.target.value as any })}>
                    <option value="openai">OpenAI TTS</option>
                    <option value="elevenlabs">ElevenLabs</option>
                  </select>
                </Field>
                <Field label={t.builder.ai.voice}>
                  {cfg.voiceProvider === 'openai' ? (
                    <select className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" value={cfg.voiceId} onChange={(e) => update({ voiceId: e.target.value })}>
                      {OPENAI_VOICES.map((v) => (
                        <option key={v.id} value={v.id}>{v.label} — {voiceBadge(v.lang)}</option>
                      ))}
                    </select>
                  ) : (
                    <ElevenVoicePicker
                      value={cfg.voiceId}
                      onChange={(v) => update({ voiceId: v })}
                    />
                  )}
                </Field>
              </div>
            )}
            {cfg.replyMode !== 'text' && (
              <VoicePreviewButton botId={botId} />
            )}
            {/* Curated Moroccan Darija voice presets — one-click bundles */}
            {cfg.replyMode !== 'text' && (
              <MoroccanVoicePresets
                botId={botId}
                currentVoiceId={cfg.voiceId}
                onApply={(patch) => update(patch)}
              />
            )}
            {/* Voice cloning (ElevenLabs IVC). Only visible on voice/auto
                bots — pointless for text-only. Cloning sets voiceProvider
                to elevenlabs and voiceId to the cloned voice_id. */}
            {cfg.replyMode !== 'text' && (
              <VoiceCloningPanel
                botId={botId}
                hasClone={!!cfg.voiceClonedPersona}
                onCloned={(next) => setCfg({ ...cfg, ...next })}
                onDeleted={() => setCfg({ ...cfg, voiceClonedPersona: null, voiceId: 'IES4nrmZdUBHByLBde0P' })}
              />
            )}
            <Toggle label={t.builder.ai.transcribeAudio} checked={cfg.transcribeAudio} onChange={(v) => update({ transcribeAudio: v })} />
            <p className="-mt-1.5 text-[11px] text-gray-500">{t.builder.ai.transcribeAudioHint}</p>

            {/* Advanced — collapsible block for quality + Darija fine-tuning */}
            <details className="group rounded-lg border border-gray-100 bg-gray-50/60 p-2">
              <summary className="cursor-pointer text-xs font-medium text-gray-600 hover:text-gray-900">
                ⚙️ {t.builder.ai.advanced.title}
              </summary>
              <div className="mt-3 space-y-3">
                <Field label={t.builder.ai.advanced.voiceQuality} hint={t.builder.ai.advanced.voiceQualityHint}>
                  <select
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
                    value={cfg.voiceQuality ?? 'standard'}
                    onChange={(e) => update({ voiceQuality: e.target.value as 'standard' | 'hd' })}
                  >
                    <option value="standard">{t.builder.ai.advanced.qualityStandard}</option>
                    <option value="hd">{t.builder.ai.advanced.qualityHd}</option>
                  </select>
                </Field>
                <Field label={t.builder.ai.advanced.voiceInstructions} hint={t.builder.ai.advanced.voiceInstructionsHint}>
                  <Textarea
                    rows={3}
                    value={cfg.voiceInstructions ?? ''}
                    onChange={(e) => update({ voiceInstructions: e.target.value || null })}
                    placeholder={t.builder.ai.advanced.voiceInstructionsPh}
                  />
                </Field>
                <Field label={t.builder.ai.advanced.sttContextPrompt} hint={t.builder.ai.advanced.sttContextPromptHint}>
                  <Textarea
                    rows={3}
                    value={cfg.sttContextPrompt ?? ''}
                    onChange={(e) => update({ sttContextPrompt: e.target.value || null })}
                    placeholder={t.builder.ai.advanced.sttContextPromptPh}
                  />
                </Field>

                <Slider
                  label={t.builder.ai.advanced.chatTemperature}
                  hint={t.builder.ai.advanced.chatTemperatureHint}
                  value={cfg.chatTemperature ?? 0.4}
                  min={0} max={1} step={0.05}
                  onChange={(v) => update({ chatTemperature: v })}
                />
                {cfg.voiceProvider === 'elevenlabs' && cfg.replyMode !== 'text' && (
                  <>
                    <Field label={t.builder.ai.advanced.voiceModel} hint={t.builder.ai.advanced.voiceModelHint}>
                      <select
                        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
                        value={cfg.voiceModelId ?? 'eleven_multilingual_v2'}
                        onChange={(e) => update({ voiceModelId: e.target.value as any })}
                      >
                        <option value="eleven_multilingual_v2">{t.builder.ai.advanced.voiceModelMultilingual}</option>
                        <option value="eleven_turbo_v2_5">{t.builder.ai.advanced.voiceModelTurbo}</option>
                        <option value="eleven_v3">{t.builder.ai.advanced.voiceModelV3}</option>
                      </select>
                    </Field>
                    <Slider
                      label={t.builder.ai.advanced.voiceStability}
                      hint={t.builder.ai.advanced.voiceStabilityHint}
                      value={cfg.voiceStability ?? 0.5}
                      min={0} max={1} step={0.05}
                      onChange={(v) => update({ voiceStability: v })}
                    />
                    <Slider
                      label={t.builder.ai.advanced.voiceSimilarityBoost}
                      hint={t.builder.ai.advanced.voiceSimilarityBoostHint}
                      value={cfg.voiceSimilarityBoost ?? 0.75}
                      min={0} max={1} step={0.05}
                      onChange={(v) => update({ voiceSimilarityBoost: v })}
                    />
                    <Slider
                      label={t.builder.ai.advanced.voiceStyle}
                      hint={t.builder.ai.advanced.voiceStyleHint}
                      value={cfg.voiceStyle ?? 0.35}
                      min={0} max={1} step={0.05}
                      onChange={(v) => update({ voiceStyle: v })}
                    />
                  </>
                )}
              </div>
            </details>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>{t.builder.ai.collectionSection}</CardHeader>
          <CardBody className="space-y-3">
            <Toggle label={t.builder.ai.collectionEnable} checked={cfg.collectionEnabled} onChange={(v) => update({ collectionEnabled: v })} />
            {cfg.collectionEnabled && (
              <CollectionFields cfg={cfg} update={update} />
            )}
            <hr className="border-gray-100" />
            <Toggle label={t.builder.ai.notifyOwner} checked={cfg.notifyOwnerEnabled} onChange={(v) => update({ notifyOwnerEnabled: v })} />
            {cfg.notifyOwnerEnabled && (
              <Field label={t.builder.ai.ownerPhone} hint={t.builder.ai.ownerPhoneHint}>
                <Input value={cfg.ownerPhone ?? ''} onChange={(e) => update({ ownerPhone: e.target.value || null })} placeholder="+212601020304" dir="ltr" />
              </Field>
            )}
            <Toggle label={t.builder.ai.continueAfterOrder} checked={cfg.continueAfterOrder} onChange={(v) => update({ continueAfterOrder: v })} small />
            {cfg.collectionEnabled && (
              <Field label={t.builder.ai.postOrderThanks} hint={t.builder.ai.postOrderThanksHint}>
                <Textarea
                  rows={4}
                  value={cfg.postOrderThanksMessage ?? ''}
                  onChange={(e) => update({ postOrderThanksMessage: e.target.value || null })}
                  placeholder={t.builder.ai.postOrderThanksPlaceholder}
                />
              </Field>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <span className="inline-flex items-center gap-2"><SettingsIcon size={16} /> {t.builder.ai.behaviour}</span>
          </CardHeader>
          <CardBody className="space-y-3">
            <Field label={t.builder.ai.stopWord} hint={t.builder.ai.stopWordHint}>
              <Input value={cfg.stopWord ?? ''} onChange={(e) => update({ stopWord: e.target.value || null })} placeholder="إيقاف" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t.builder.ai.interventionMin}>
                <Input type="number" min={0} max={1440} value={cfg.ownerInterventionMinutes} onChange={(e) => update({ ownerInterventionMinutes: Math.max(0, +e.target.value || 0) })} />
              </Field>
              <Field label={t.builder.ai.maxReplies}>
                <Input type="number" min={0} max={1000} value={cfg.maxRepliesPerSession} onChange={(e) => update({ maxRepliesPerSession: Math.max(0, +e.target.value || 0) })} />
              </Field>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <span className="inline-flex items-center gap-2">
              <Clock size={16} className="text-brand-600" /> {t.builder.ai.replyTiming.title}
            </span>
          </CardHeader>
          <CardBody className="space-y-5">
            {/* First-reply delay */}
            <div className="space-y-2">
              <div className="text-sm font-semibold text-gray-800">
                {t.builder.ai.replyTiming.firstReply}
              </div>
              <p className="text-[11px] text-gray-500">
                {t.builder.ai.replyTiming.hintFirstScope}
              </p>
              <div className="grid grid-cols-2 gap-3">
                <Field label={t.builder.ai.replyTiming.delaySeconds}>
                  <Input
                    type="number" min={0} max={600}
                    value={cfg.firstReplyDelaySeconds}
                    onChange={(e) => update({ firstReplyDelaySeconds: Math.max(0, Math.min(600, +e.target.value || 0)) })}
                  />
                </Field>
                {cfg.firstReplyRandomize && (
                  <Field label={t.builder.ai.replyTiming.maxSeconds}>
                    <Input
                      type="number" min={0} max={600}
                      value={cfg.firstReplyDelayMaxSeconds}
                      onChange={(e) => update({ firstReplyDelayMaxSeconds: Math.max(0, Math.min(600, +e.target.value || 0)) })}
                    />
                  </Field>
                )}
              </div>
              <label className="mt-1 flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                  checked={cfg.firstReplyRandomize}
                  onChange={(e) => update({ firstReplyRandomize: e.target.checked })}
                />
                {t.builder.ai.replyTiming.randomize}
              </label>
              <p className="text-[11px] text-gray-500">
                {cfg.firstReplyRandomize
                  ? t.builder.ai.replyTiming.hintRandom
                  : t.builder.ai.replyTiming.hintFixed}
              </p>
            </div>

            <hr className="border-gray-100" />

            {/* Subsequent-reply delay */}
            <div className="space-y-2">
              <div className="text-sm font-semibold text-gray-800">
                {t.builder.ai.replyTiming.subsequentReply}
              </div>
              <p className="text-[11px] text-gray-500">
                {t.builder.ai.replyTiming.hintSubsequentScope}
              </p>
              <div className="grid grid-cols-2 gap-3">
                <Field label={t.builder.ai.replyTiming.delaySeconds}>
                  <Input
                    type="number" min={0} max={600}
                    value={cfg.replyDelaySeconds}
                    onChange={(e) => update({ replyDelaySeconds: Math.max(0, Math.min(600, +e.target.value || 0)) })}
                  />
                </Field>
                {cfg.replyRandomize && (
                  <Field label={t.builder.ai.replyTiming.maxSeconds}>
                    <Input
                      type="number" min={0} max={600}
                      value={cfg.replyDelayMaxSeconds}
                      onChange={(e) => update({ replyDelayMaxSeconds: Math.max(0, Math.min(600, +e.target.value || 0)) })}
                    />
                  </Field>
                )}
              </div>
              <label className="mt-1 flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                  checked={cfg.replyRandomize}
                  onChange={(e) => update({ replyRandomize: e.target.checked })}
                />
                {t.builder.ai.replyTiming.randomize}
              </label>
              <p className="text-[11px] text-gray-500">
                {cfg.replyRandomize
                  ? t.builder.ai.replyTiming.hintRandom
                  : t.builder.ai.replyTiming.hintFixed}
              </p>
            </div>
          </CardBody>
        </Card>

        <CustomerTagsCard
          botId={botId}
          cfg={tagsCfg}
          onMasterToggle={(v) => setTagsCfg((p) => ({ ...p, enabled: v }))}
          onPatch={patchTag}
          t={t}
        />

        <Card>
          <CardHeader>
            <span className="inline-flex items-center gap-2">
              <Package size={16} className="text-amber-600" /> {t.builder.ai.products}
            </span>
          </CardHeader>
          <CardBody className="space-y-2">
            <p className="text-[11px] text-gray-500">{t.builder.ai.productsHint}</p>
            {linkedProducts.length === 0 ? (
              <p className="text-xs text-gray-400">{t.builder.ai.noProducts}</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {linkedProducts.map((p) => (
                  <span key={p.id} className="flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700">
                    {p.name}{p.price ? ` (${p.price})` : ''}
                    <button onClick={() => unlinkProduct(p.id)} className="hover:text-red-700"><X size={11} /></button>
                  </span>
                ))}
              </div>
            )}
            <Button variant="secondary" onClick={() => setProductPickerOpen(true)}>+ {t.builder.ai.addProduct}</Button>
          </CardBody>
        </Card>

        <div className="flex justify-end">
          <Button onClick={save} loading={busy}><Save size={14} /> {t.app.save}</Button>
        </div>
      </div>

      {/* RIGHT — Unified test: rule + AI + call rejection + follow-up + voice */}
      <UnifiedBotTest botId={botId} engineMode={cfg.engineMode} />

      <MediaPickerModal
        open={instructionPickerOpen}
        onClose={() => setInstructionPickerOpen(false)}
        onPick={addInstructionMedia}
      />

      {productPickerOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={() => setProductPickerOpen(false)}>
          <div className="max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-lg bg-white p-4 shadow-lg" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-semibold">{t.builder.ai.pickProduct}</h3>
              <button onClick={() => setProductPickerOpen(false)} className="text-gray-500"><X size={16} /></button>
            </div>
            <div className="space-y-1.5">
              {allProducts.length === 0 ? (
                <p className="text-sm text-gray-500">{t.builder.ai.noProductsInLibrary}</p>
              ) : (
                allProducts.filter((p) => !linkedProducts.find((l) => l.id === p.id)).map((p) => (
                  <button
                    key={p.id}
                    onClick={() => { linkProduct(p.id); setProductPickerOpen(false); }}
                    className="flex w-full items-center gap-2 rounded border border-gray-200 px-3 py-2 text-start hover:bg-gray-50"
                  >
                    <Package size={14} className="text-amber-600" />
                    <span className="flex-1 font-medium text-gray-900">{p.name}</span>
                    {p.price && <span className="text-xs text-brand-700">{p.price}</span>}
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * CollectionFields — numbered, vertically-stacked field toggles. Renders in
 * the fixed engine asking order (name → phone → city → address → quantity)
 * and re-numbers live as the operator toggles fields on/off, so the displayed
 * number == the actual asking position. The hint line above shows the live
 * sequence so the operator can read it at a glance.
 */
function CollectionFields({ cfg, update }: { cfg: AiCfg; update: (p: Partial<AiCfg>) => void }) {
  const { t } = useI18n();
  const FIELDS: { key: keyof AiCfg; flag: keyof AiCfg; label: string }[] = [
    { key: 'collectName',     flag: 'collectName',     label: t.builder.ai.fields.name },
    { key: 'collectPhone',    flag: 'collectPhone',    label: t.builder.ai.fields.phone },
    { key: 'collectCity',     flag: 'collectCity',     label: t.builder.ai.fields.city },
    { key: 'collectAddress',  flag: 'collectAddress',  label: t.builder.ai.fields.address },
    { key: 'collectQuantity', flag: 'collectQuantity', label: t.builder.ai.fields.quantity },
  ];
  const active = FIELDS.filter((f) => !!cfg[f.flag]);

  return (
    <div className="space-y-2">
      <p className="rounded bg-emerald-50 px-2 py-1.5 text-[11px] text-emerald-800">
        <span className="font-semibold">{t.builder.ai.collectionOrder}:</span>{' '}
        {active.length === 0
          ? t.builder.ai.collectionWillAsk
          : active.map((f, i) => `${i + 1}. ${f.label}`).join(' → ')}
      </p>
      <div className="space-y-1">
        {FIELDS.map((f) => {
          const enabled = !!cfg[f.flag];
          const orderIdx = active.findIndex((a) => a.flag === f.flag);
          return (
            <div
              key={String(f.flag)}
              className={`flex items-center gap-3 rounded-lg border px-3 py-2 transition ${
                enabled
                  ? 'border-brand-200 bg-brand-50/40'
                  : 'border-gray-200 bg-gray-50 opacity-60'
              }`}
            >
              <span
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                  enabled ? 'bg-brand-500 text-white' : 'bg-gray-300 text-gray-500'
                }`}
              >
                {enabled ? orderIdx + 1 : '—'}
              </span>
              <span className={`flex-1 text-sm ${enabled ? 'font-medium text-gray-900' : 'text-gray-500'}`}>
                {f.label}
              </span>
              <label className="relative inline-flex cursor-pointer items-center">
                <input
                  type="checkbox"
                  className="peer sr-only"
                  checked={enabled}
                  onChange={(e) => update({ [f.flag]: e.target.checked } as Partial<AiCfg>)}
                />
                <span className="h-5 w-9 rounded-full bg-gray-200 peer-checked:bg-brand-500 transition" />
                <span className="absolute start-0.5 top-0.5 h-4 w-4 rounded-full bg-white peer-checked:translate-x-4 rtl:peer-checked:-translate-x-4 transition" />
              </label>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Per-bot toggle: when the rule engine can't match a customer's message
 * (no option, exact_match, or keyword hits), should the bot send a fallback
 * message («سمح ليا، ما فهمتش…») — or stay silent?
 * The state lives on BotSettings.fallbackEnabled and is patched via
 * PATCH /bots/:id/settings (same endpoint BotCallsTab uses for call settings).
 */
function FallbackToggle({ botId, engineMode }: { botId: string; engineMode: string }) {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        const bot = await api.get<{ settings: { fallbackEnabled?: boolean } | null }>(`/bots/${botId}`);
        setEnabled(!!bot.settings?.fallbackEnabled);
      } catch { setEnabled(false); }
    })();
  }, [botId]);
  if (enabled === null) return null;

  // In rule_only mode the engine FORCES fallback off regardless of the DB
  // value — the operator's intent for that mode is "bot answers programmed
  // messages then stays silent". Reflect that: show the toggle disabled and
  // unchecked with an explanatory hint.
  const forcedOff = engineMode === 'rule_only';
  const displayChecked = forcedOff ? false : enabled;

  const flip = async () => {
    if (busy || forcedOff) return;
    const next = !enabled;
    setBusy(true);
    setEnabled(next); // optimistic
    try {
      await api.patch(`/bots/${botId}/settings`, { fallbackEnabled: next });
    } catch (e: any) {
      setEnabled(!next);
      toast.error(e?.message ?? 'save_failed');
    } finally { setBusy(false); }
  };
  return (
    <div className="rounded-lg border border-gray-100 bg-gray-50/60 p-3">
      <label className={`flex items-start gap-3 ${forcedOff ? 'cursor-not-allowed opacity-70' : 'cursor-pointer'}`}>
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 accent-brand-500"
          checked={displayChecked}
          disabled={busy || forcedOff}
          onChange={flip}
        />
        <div className="flex-1">
          <div className="text-sm font-medium text-gray-800">
            {(t.builder.ai as any).fallbackEnabled ?? 'الرد التلقائي عند عدم فهم رسالة الزبون'}
          </div>
          <div className="mt-0.5 text-[11px] leading-snug text-gray-500">
            {forcedOff
              ? ((t.builder.ai as any).fallbackForcedOffHint
                  ?? 'مطفأ دائماً في هذا الوضع — البوت يصمت عند عدم الفهم.')
              : ((t.builder.ai as any).fallbackEnabledHint
                  ?? 'مطفأ يعني: إذا الزبون ما اختار من القائمة، البوت يصمت. مشغّل يعني: يبعث «ما فهمتش…».')}
          </div>
        </div>
      </label>
    </div>
  );
}

type EngineMode = 'rule_only' | 'ai_only' | 'hybrid' | 'rule_priority' | 'disabled';

function EngineModePicker({ value, onChange }: { value: EngineMode; onChange: (v: EngineMode) => void }) {
  const { t } = useI18n();
  const opts: { id: EngineMode; emoji: string; label: string; hint: string }[] = [
    { id: 'disabled',       emoji: '🛑', label: t.builder.ai.engineMode.disabled,       hint: t.builder.ai.engineMode.disabledHint },
    { id: 'rule_only',      emoji: '🤖', label: t.builder.ai.engineMode.ruleOnly,       hint: t.builder.ai.engineMode.ruleOnlyHint },
    { id: 'ai_only',        emoji: '✨', label: t.builder.ai.engineMode.aiOnly,         hint: t.builder.ai.engineMode.aiOnlyHint },
    { id: 'hybrid',         emoji: '🔀', label: t.builder.ai.engineMode.hybrid,         hint: t.builder.ai.engineMode.hybridHint },
    { id: 'rule_priority',  emoji: '👑', label: t.builder.ai.engineMode.rulePriority,   hint: t.builder.ai.engineMode.rulePriorityHint },
  ];
  const active = opts.find((o) => o.id === value) ?? opts[3];
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-gray-700">{t.builder.ai.engineMode.label}</div>
      <div className="grid grid-cols-3 gap-1.5 md:grid-cols-5">
        {opts.map((o) => (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(o.id)}
            className={`flex flex-col items-center gap-0.5 rounded-lg border px-2 py-2 text-[11px] font-medium transition ${
              value === o.id
                ? 'border-brand-500 bg-brand-50 text-brand-700 shadow-sm'
                : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
            }`}
          >
            <span className="text-lg leading-none">{o.emoji}</span>
            <span className="text-center leading-tight">{o.label}</span>
          </button>
        ))}
      </div>
      <p className="rounded bg-gray-50 px-2 py-1 text-[11px] text-gray-600">{active.hint}</p>
    </div>
  );
}

function Toggle({ label, checked, onChange, small }: { label: string; checked: boolean; onChange: (v: boolean) => void; small?: boolean }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3">
      <span className={`${small ? 'text-xs' : 'text-sm'} text-gray-700`}>{label}</span>
      <span className="relative inline-flex items-center">
        <input type="checkbox" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="h-5 w-9 rounded-full bg-gray-200 peer-checked:bg-brand-500 transition" />
        <span className="absolute start-0.5 top-0.5 h-4 w-4 rounded-full bg-white peer-checked:translate-x-4 rtl:peer-checked:-translate-x-4 transition" />
      </span>
    </label>
  );
}

function Slider({ label, hint, value, min, max, step, onChange }: {
  label: string; hint?: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="font-medium text-gray-700">{label}</span>
        <span className="font-mono text-gray-500">{value.toFixed(2)}</span>
      </div>
      <input
        type="range"
        min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-brand-500"
      />
      {hint && <p className="mt-1 text-[10px] text-gray-500">{hint}</p>}
    </div>
  );
}

type LibraryVoice = {
  id: string;
  name: string;
  category: string;
  labels?: Record<string, string>;
};

function ElevenVoicePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const isPreset = ELEVEN_VOICES.some((v) => v.id === value);
  // Three modes: 'preset' = curated list, 'library' = operator's own voices
  // (cloned + premade from elevenlabs.io), 'custom' = paste a raw ID.
  const [mode, setMode] = useState<'preset' | 'library' | 'custom'>(isPreset ? 'preset' : 'custom');
  const [library, setLibrary] = useState<LibraryVoice[] | null>(null);
  const [libraryErr, setLibraryErr] = useState<string | null>(null);
  const [libraryBusy, setLibraryBusy] = useState(false);
  // Filter for the library view — «عربي فقط» narrows to voices flagged as
  // Arabic in ElevenLabs metadata (labels.language==='ar' or ar/arabic in
  // the name), which is what most operators want to find fast.
  const [arabicOnly, setArabicOnly] = useState(false);

  const loadLibrary = async () => {
    if (library) return;
    setLibraryBusy(true); setLibraryErr(null);
    try {
      const r = await api.get<{ voices: LibraryVoice[] }>('/ai/voices/elevenlabs');
      setLibrary(r.voices);
    } catch (e: any) {
      setLibraryErr(e?.message ?? 'failed_to_load');
    } finally { setLibraryBusy(false); }
  };

  const enterLibrary = () => { setMode('library'); loadLibrary(); };

  const isArabic = (v: LibraryVoice) => {
    const acc = (v.labels?.accent ?? '').toLowerCase();
    const lang = (v.labels?.language ?? '').toLowerCase();
    return acc.includes('arab') || acc.includes('morocc') || acc.includes('darija') || lang.includes('ar');
  };

  return (
    <div className="space-y-1.5">
      {mode === 'preset' && (
        <>
          <select
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
            value={isPreset ? value : ELEVEN_VOICES[0].id}
            onChange={(e) => onChange(e.target.value)}
          >
            {ELEVEN_VOICES.map((v) => (
              <option key={v.id} value={v.id}>{v.label} — {voiceBadge(v.lang)}</option>
            ))}
          </select>
          <div className="flex gap-2 text-[11px]">
            <button onClick={enterLibrary} className="text-violet-600 hover:underline">📚 من مكتبتك</button>
            <button onClick={() => setMode('custom')} className="text-gray-500 hover:underline">— ID مخصص</button>
          </div>
        </>
      )}

      {mode === 'library' && (
        <>
          {libraryBusy && <div className="text-xs text-gray-500">…</div>}
          {libraryErr && (
            <div className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
              {libraryErr === 'no_elevenlabs_key' ? 'مفتاح ElevenLabs غير محفوظ. أضِفه أولا من قسم بيانات الاعتماد.' : libraryErr}
            </div>
          )}
          {library && (
            <>
              <div className="mb-1 flex gap-1 rounded bg-gray-100 p-0.5">
                <button
                  type="button"
                  onClick={() => setArabicOnly(false)}
                  className={`flex-1 rounded px-2 py-0.5 text-[11px] font-medium ${!arabicOnly ? 'bg-white shadow' : 'text-gray-500'}`}
                >
                  الكل
                </button>
                <button
                  type="button"
                  onClick={() => setArabicOnly(true)}
                  className={`flex-1 rounded px-2 py-0.5 text-[11px] font-medium ${arabicOnly ? 'bg-emerald-500 text-white' : 'text-gray-500'}`}
                >
                  🇲🇦 عربي فقط
                </button>
              </div>
              <div className="max-h-48 overflow-y-auto rounded border border-gray-200 bg-white">
                {library.filter((v) => !arabicOnly || isArabic(v)).length === 0 ? (
                  <div className="p-2 text-xs text-gray-500">
                    {arabicOnly ? 'لا يوجد صوت عربي في مكتبتك — أضِف واحداً من ElevenLabs Voice Library.' : 'لا توجد أصوات في مكتبتك.'}
                  </div>
                ) : library.filter((v) => !arabicOnly || isArabic(v)).map((v) => (
                  <button
                    key={v.id}
                    onClick={() => { onChange(v.id); }}
                    className={`flex w-full items-center justify-between gap-2 border-b border-gray-50 px-2 py-1.5 text-start text-[12px] hover:bg-violet-50 ${
                      v.id === value ? 'bg-violet-100' : ''
                    }`}
                  >
                    <span className="flex flex-1 items-center gap-1.5">
                      <span className="font-medium text-gray-900">{v.name}</span>
                      {isArabic(v) && <span className="rounded-full bg-emerald-50 px-1.5 py-0 text-[10px] text-emerald-700">🇲🇦 عربي</span>}
                      {v.category === 'cloned' && <span className="rounded-full bg-violet-50 px-1.5 py-0 text-[10px] text-violet-700">مستنسخ</span>}
                    </span>
                    <span className="font-mono text-[10px] text-gray-400">{v.id.slice(0, 6)}…</span>
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="flex gap-2 text-[11px]">
            <button onClick={() => setMode('preset')} className="text-gray-500 hover:underline">← القائمة المحضّرة</button>
            <button onClick={() => setMode('custom')} className="text-gray-500 hover:underline">— ID مخصص</button>
          </div>
        </>
      )}

      {mode === 'custom' && (
        <>
          <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder="ElevenLabs voice id" dir="ltr" />
          <div className="flex gap-2 text-[11px]">
            <button onClick={() => { setMode('preset'); onChange(ELEVEN_VOICES[0].id); }} className="text-brand-600 hover:underline">← القائمة المحضّرة</button>
            <button onClick={enterLibrary} className="text-violet-600 hover:underline">📚 من مكتبتك</button>
          </div>
        </>
      )}
    </div>
  );
}

function VoicePreviewButton({ botId }: { botId: string }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  const onPreview = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ audioBase64: string; audioMime: string }>(`/bots/${botId}/ai/voice-preview`, {});
      const bin = atob(r.audioBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: r.audioMime });
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      const url = URL.createObjectURL(blob);
      setAudioUrl(url);
      // Auto-play
      setTimeout(() => {
        const a = new Audio(url);
        a.play().catch(() => {});
      }, 50);
    } catch (e: any) {
      toast.error(e?.message ?? t.app.error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={onPreview}
        disabled={busy}
        className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
      >
        <Mic size={12} /> {busy ? '…' : t.builder.ai.previewVoice}
      </button>
      {audioUrl && (
        <audio src={audioUrl} controls className="h-7 max-w-[200px]" />
      )}
    </div>
  );
}

function CustomerTagsCard({
  botId, cfg, onMasterToggle, onPatch, t,
}: {
  botId: string;
  cfg: CustomerTagsConfig;
  onMasterToggle: (v: boolean) => void;
  onPatch: (key: CustomerStatusKey, patch: Partial<TagCategory>) => void;
  t: any;
}) {
  const [testOpen, setTestOpen] = useState(false);
  const [resyncing, setResyncing] = useState(false);
  const rows: { key: CustomerStatusKey; emoji: string }[] = [
    { key: 'sentNoReply', emoji: '🟡' },
    { key: 'replied',     emoji: '🔵' },
    { key: 'ordered',     emoji: '🟢' },
  ];
  return (
    <Card>
      <CardHeader>
        <span className="inline-flex items-center gap-2">
          <span>🏷️</span> {t.builder.ai.tags.title}
        </span>
      </CardHeader>
      <CardBody className="space-y-3">
        <p className="text-[11px] leading-snug text-gray-500">{t.builder.ai.tags.hint}</p>
        <Toggle label={t.builder.ai.tags.masterToggle} checked={cfg.enabled} onChange={onMasterToggle} />
        {cfg.enabled && (
          <>
            <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-[11px] leading-snug text-amber-900">
              ⚠️ {t.builder.ai.tags.businessOnly}
            </div>
            <div className="space-y-2">
              {rows.map(({ key, emoji }) => {
                const cat = cfg[key];
                return (
                  <div
                    key={key}
                    className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50/60 p-2"
                  >
                    <input
                      type="checkbox"
                      checked={cat.enabled}
                      onChange={(e) => onPatch(key, { enabled: e.target.checked })}
                      className="h-4 w-4 accent-brand-500"
                      aria-label={t.builder.ai.tags.status[key]}
                    />
                    <span className="w-24 shrink-0 text-xs font-medium text-gray-700">
                      {emoji} {t.builder.ai.tags.status[key]}
                    </span>
                    <Input
                      value={cat.label}
                      onChange={(e) => onPatch(key, { label: e.target.value.slice(0, 40) })}
                      placeholder={t.builder.ai.tags.labelPh}
                      className="h-8 flex-1"
                    />
                    <ColorSwatch
                      value={cat.color}
                      onChange={(v) => onPatch(key, { color: v })}
                    />
                  </div>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => setTestOpen(true)}
                className="inline-flex items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-3 py-1 text-[11px] font-medium text-violet-700 hover:bg-violet-100"
              >
                🔬 {t.builder.ai.tags.testSync}
              </button>
              <button
                disabled={resyncing}
                onClick={async () => {
                  if (resyncing) return;
                  setResyncing(true);
                  try {
                    const r = await api.post<{ processed: number; labeled: number; skipped: number; errors: number }>(
                      `/bots/${botId}/customer-tags/resync-all`, {},
                    );
                    toast.success(
                      (t.builder.ai.tags.resyncDone ?? 'تمت إعادة المزامنة') +
                      `: ${r.labeled}/${r.processed}${r.errors ? ` — ${r.errors} خطأ` : ''}`,
                    );
                  } catch (e: any) {
                    toast.error(e?.message ?? 'resync_failed');
                  } finally { setResyncing(false); }
                }}
                className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[11px] font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
              >
                {resyncing ? '⏳' : '🔁'} {t.builder.ai.tags.resyncAll ?? 'إعادة مزامنة كل العلامات'}
              </button>
            </div>
          </>
        )}
        <p className="text-[10px] text-gray-400">{t.builder.ai.tags.fallback}</p>
      </CardBody>
      <TagsTestSyncModal botId={botId} open={testOpen} onClose={() => setTestOpen(false)} t={t} />
    </Card>
  );
}

type SyncStepDTO = { step: string; ok: boolean; detail?: string };
type SyncResultDTO = {
  steps: SyncStepDTO[];
  accountPlatform: string | null;
  isBusiness: boolean | null;
  visibilityHint: string;
};

function TagsTestSyncModal({
  botId, open, onClose, t,
}: { botId: string; open: boolean; onClose: () => void; t: any }) {
  type Account = { id: string; name: string };
  type Conv = { id: string; name: string | null; jid: string; account: { id: string; name: string } };
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [conversations, setConversations] = useState<Conv[]>([]);
  const [accountId, setAccountId] = useState('');
  const [contactId, setContactId] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SyncResultDTO | null>(null);

  useEffect(() => {
    if (!open) return;
    api.get<Account[]>('/accounts').then((rows) => {
      setAccounts(rows);
      if (rows.length === 1) setAccountId(rows[0].id);
    }).catch(() => {});
    api.get<Conv[]>('/inbox/conversations?take=50').then(setConversations).catch(() => {});
  }, [open]);

  const filteredConvs = accountId
    ? conversations.filter((c) => c.account.id === accountId)
    : conversations;

  const runSync = async () => {
    if (!accountId || !contactId || busy) return;
    setBusy(true); setResult(null);
    try {
      const r = await api.post<SyncResultDTO>(
        `/bots/${botId}/customer-tags/test-sync`,
        { accountId, contactId },
      );
      setResult(r);
    } catch (e: any) {
      toast.error(e?.message ?? 'test_sync_failed');
    } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title={t.builder.ai.tags.testSyncTitle} wide
      footer={<>
        <Button variant="secondary" onClick={onClose}>{t.app.close ?? 'إغلاق'}</Button>
        <Button onClick={runSync} loading={busy} disabled={!accountId || !contactId}>
          {t.builder.ai.tags.runSync}
        </Button>
      </>}>
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          <select
            className="rounded-lg border border-gray-200 px-3 py-2 text-sm"
            value={accountId}
            onChange={(e) => { setAccountId(e.target.value); setContactId(''); }}
          >
            <option value="">— {t.builder.ai.tags.pickAccount} —</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <select
            className="rounded-lg border border-gray-200 px-3 py-2 text-sm disabled:opacity-50"
            disabled={!accountId}
            value={contactId}
            onChange={(e) => setContactId(e.target.value)}
          >
            <option value="">— {t.builder.ai.tags.pickContact} —</option>
            {filteredConvs.map((c) => (
              <option key={c.id} value={c.id}>{c.name ?? c.jid.split('@')[0]}</option>
            ))}
          </select>
        </div>

        {result && (
          <>
            <div className="rounded-lg border border-violet-200 bg-violet-50/60 px-3 py-2 text-[12px] text-violet-900">
              💡 {result.visibilityHint}
            </div>
            <div className="rounded-lg border border-gray-200 bg-gray-50/60 p-2 text-[11px]">
              <div className="mb-1 flex items-center gap-2 text-[11px] text-gray-700">
                <span>platform: <strong>{result.accountPlatform ?? '<unknown>'}</strong></span>
                <span>· isBusiness: <strong>{result.isBusiness === null ? '<unknown>' : String(result.isBusiness)}</strong></span>
              </div>
              <ul className="space-y-0.5">
                {result.steps.map((s, i) => (
                  <li key={i} className="flex items-start gap-1.5">
                    <span>{s.ok ? '✅' : '❌'}</span>
                    <span className="font-mono text-[10px] text-gray-500">{s.step}</span>
                    {s.detail && <span className="text-[11px] text-gray-700">— {s.detail}</span>}
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function ColorSwatch({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="h-7 w-9 rounded border border-gray-300 shadow-sm"
        style={{ backgroundColor: WA_LABEL_COLORS[value] ?? '#9CA3AF' }}
        aria-label="color"
      />
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute end-0 top-9 z-20 grid w-[160px] grid-cols-5 gap-1 rounded-lg border border-gray-200 bg-white p-2 shadow-lg">
            {WA_LABEL_COLORS.map((hex, i) => (
              <button
                key={i}
                type="button"
                onClick={() => { onChange(i); setOpen(false); }}
                className={`h-6 w-6 rounded border ${i === value ? 'border-brand-500 ring-2 ring-brand-300' : 'border-gray-200'}`}
                style={{ backgroundColor: hex }}
                aria-label={`color ${i}`}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * VoiceOverrideTester — runs the same preview endpoint twice (a text-turn
 * customer message, then an audio-turn customer message) and shows which
 * chat provider + model each turn ended up using. Lets the operator verify
 * the voice-override routing without touching real WhatsApp.
 */
function VoiceOverrideTester({ botId }: { botId: string }) {
  type Result = { chatProvider?: string; chatModel?: string; mode?: string; error?: string };
  const [textResult, setTextResult] = useState<Result | null>(null);
  const [voiceResult, setVoiceResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    setTextResult(null);
    setVoiceResult(null);
    try {
      const [tr, vr] = await Promise.all([
        api.post<Result>(`/bots/${botId}/ai/test`, {
          userMessage: 'test',
          history: [],
          incomingKind: 'text',
        }).catch((e) => ({ error: e?.message ?? 'text_test_failed' } as Result)),
        api.post<Result>(`/bots/${botId}/ai/test`, {
          userMessage: '[صوت اختباري]',
          history: [],
          incomingKind: 'audio',
        }).catch((e) => ({ error: e?.message ?? 'voice_test_failed' } as Result)),
      ]);
      setTextResult(tr);
      setVoiceResult(vr);
    } finally { setBusy(false); }
  };

  const Row = ({ label, r }: { label: string; r: Result | null }) => (
    <div className="flex items-center gap-2 text-[11px]" dir="rtl">
      <span className="w-16 shrink-0 text-gray-500">{label}:</span>
      {!r ? (
        <span className="text-gray-400">—</span>
      ) : r.error ? (
        <span className="text-red-600">✗ {r.error}</span>
      ) : (
        <>
          <span className="rounded-full bg-white/60 px-1.5 py-0.5 font-medium text-gray-800" dir="ltr">
            {r.chatProvider ?? '?'}
          </span>
          <span className="font-mono text-[10px] text-gray-600" dir="ltr">{r.chatModel ?? '?'}</span>
        </>
      )}
    </div>
  );

  return (
    <div className="mt-2 rounded-md border border-violet-200 bg-white/70 px-2 py-1.5">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[10px] font-semibold text-violet-700">اختبار توجيه الردود</span>
        <button
          type="button"
          onClick={run}
          disabled={busy}
          className="rounded border border-violet-300 bg-violet-50 px-2 py-0.5 text-[10px] font-medium text-violet-800 hover:bg-violet-100 disabled:opacity-50"
        >
          {busy ? '…' : 'اختبر'}
        </button>
      </div>
      <div className="space-y-0.5">
        <Row label="نص" r={textResult} />
        <Row label="صوت" r={voiceResult} />
      </div>
    </div>
  );
}

/**
 * VoiceCloningPanel — operator records or uploads 3-5 min of their voice.
 * Backend uploads it to ElevenLabs IVC (returns a voice_id) AND transcribes
 * it via Whisper (returned excerpt is stored on the bot's persona field).
 * On success the bot answers customers in the cloned voice AND matches the
 * operator's dialect / tone in the LLM's word choice.
 *
 * Uses the browser's MediaRecorder for in-browser capture (webm/opus by
 * default — ElevenLabs accepts it). Falls back to standard file upload for
 * operators who prefer a pre-recorded WAV/MP3/M4A.
 */
function VoiceCloningPanel({
  botId,
  hasClone,
  onCloned,
  onDeleted,
}: {
  botId: string;
  hasClone: boolean;
  onCloned: (patch: { voiceProvider: 'elevenlabs'; voiceId: string; voiceClonedPersona: string | null }) => void;
  onDeleted: () => void;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<'record' | 'upload'>('record');
  const [name, setName] = useState<string>('صوتي');
  const [blob, setBlob] = useState<Blob | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // null = still loading credentials; true/false = presence check result.
  // Voice cloning is ONLY available with an ElevenLabs key on file. If
  // missing we show an amber banner + disable the Clone button so the
  // operator doesn't waste time recording before hitting the wall.
  const [hasElevenlabsKey, setHasElevenlabsKey] = useState<boolean | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    api.get<{ provider: string }[]>('/ai/credentials')
      .then((rows) => setHasElevenlabsKey(rows.some((r) => r.provider === 'elevenlabs')))
      .catch(() => setHasElevenlabsKey(null));
  }, []);

  const MAX_SECONDS = 5 * 60;

  const setBlobWithPreview = (b: Blob | null) => {
    setBlob(b);
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    setBlobUrl(b ? URL.createObjectURL(b) : null);
    setError(null);
  };

  const startRecording = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const rec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      recorderRef.current = rec;
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
      rec.onstop = () => {
        const merged = new Blob(chunks, { type: 'audio/webm' });
        setBlobWithPreview(merged);
        streamRef.current?.getTracks().forEach((tr) => tr.stop());
        streamRef.current = null;
        if (timerRef.current) window.clearInterval(timerRef.current);
        timerRef.current = null;
        setRecording(false);
        setElapsed(0);
      };
      rec.start();
      setRecording(true);
      setElapsed(0);
      timerRef.current = window.setInterval(() => {
        setElapsed((s) => {
          const next = s + 1;
          if (next >= MAX_SECONDS) rec.stop();
          return next;
        });
      }, 1000);
    } catch {
      setError(t.builder.ai.voiceCloneMicDenied);
    }
  };

  const stopRecording = () => {
    try { recorderRef.current?.stop(); } catch { /* ignore */ }
  };

  const onFileChosen = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setBlobWithPreview(f);
  };

  const doClone = async () => {
    if (!blob) return;
    setBusy(true); setError(null);
    try {
      const form = new FormData();
      form.append('file', blob, mode === 'record' ? 'sample.webm' : 'sample.audio');
      form.append('name', name.trim() || 'صوتي');
      const r = await fetch(`/api/bots/${botId}/voice/clone`, { method: 'POST', body: form });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        throw new Error(txt || `HTTP ${r.status}`);
      }
      const data = await r.json() as { voiceId: string; transcriptExcerpt: string };
      onCloned({
        voiceProvider: 'elevenlabs',
        voiceId: data.voiceId,
        voiceClonedPersona: data.transcriptExcerpt || null,
      });
      toast.success(t.builder.ai.voiceCloneCloned);
      setBlobWithPreview(null);
    } catch (e: any) {
      // Server sends {error, code} on failure. Parse `code` and translate
      // to a friendly Arabic message + next-step guidance. Fall back to
      // the raw message if we can't recognize the shape (network errors,
      // unexpected failures).
      const raw = (e?.message ?? String(e)).trim();
      let code: string | undefined;
      try { code = JSON.parse(raw)?.code; } catch { /* not JSON */ }
      const friendly =
        code === 'missing_elevenlabs_key'
          ? '⚠️ لا يوجد مفتاح ElevenLabs محفوظ. أضفه من صفحة "مفاتيح الذكاء" ثم أعد المحاولة.'
        : code === 'elevenlabs_quota'
          ? '⚠️ حصة الاستنساخ في اشتراك ElevenLabs الخاص بك ممتلئة. احذف صوتاً قديماً من ElevenLabs أو رقّي الاشتراك.'
        : code === 'elevenlabs_auth'
          ? '⚠️ مفتاح ElevenLabs غير صالح (401). راجعه من صفحة "مفاتيح الذكاء".'
        : raw.slice(0, 200);
      setError(friendly);
      toast.error(friendly);
    } finally { setBusy(false); }
  };

  const doDelete = async () => {
    if (!confirm(t.app.delete + '?')) return;
    setBusy(true);
    try {
      await api.delete(`/bots/${botId}/voice/clone`);
      onDeleted();
      toast.success(t.app.saved);
    } finally { setBusy(false); }
  };

  return (
    <div className="rounded-xl border border-brand-200 bg-brand-50/40 p-3" dir="rtl">
      <div className="mb-1 flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand-800">
          🎙️ {t.builder.ai.voiceCloneTitle}
        </span>
        {hasClone && (
          <Button size="sm" variant="ghost" onClick={doDelete} disabled={busy}>
            <X size={12} /> {t.builder.ai.voiceCloneDelete}
          </Button>
        )}
      </div>
      <p className="mb-2 text-[11px] leading-snug text-brand-800/70">{t.builder.ai.voiceCloneHint}</p>

      {hasElevenlabsKey === false && (
        <div className="mb-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] leading-snug text-amber-900">
          ⚠️ استنساخ الصوت يحتاج مفتاح ElevenLabs، ولم يُضَف بعد.{' '}
          <a href="/ai-keys" className="font-medium underline">أضف المفتاح من هنا</a>{' '}
          ثم عد لتجربة الاستنساخ.
        </div>
      )}

      <div className="mb-2 flex gap-1 rounded-md bg-white p-0.5">
        <button
          type="button"
          onClick={() => setMode('record')}
          className={`flex-1 rounded px-2 py-1 text-xs font-medium ${mode === 'record' ? 'bg-brand-500 text-white' : 'text-gray-600 hover:bg-gray-100'}`}
        >{t.builder.ai.voiceCloneRecord}</button>
        <button
          type="button"
          onClick={() => setMode('upload')}
          className={`flex-1 rounded px-2 py-1 text-xs font-medium ${mode === 'upload' ? 'bg-brand-500 text-white' : 'text-gray-600 hover:bg-gray-100'}`}
        >{t.builder.ai.voiceCloneUpload}</button>
      </div>

      {mode === 'record' ? (
        <div className="mb-2 flex items-center gap-2">
          {!recording ? (
            <Button size="sm" variant="primary" onClick={startRecording} disabled={busy}>
              🔴 {t.builder.ai.voiceCloneRecord}
            </Button>
          ) : (
            <Button size="sm" variant="danger" onClick={stopRecording}>
              ⏹ {t.builder.ai.voiceCloneStopRecording}
            </Button>
          )}
          {recording && (
            <span className="text-xs font-mono text-red-600">
              {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')} / 5:00
            </span>
          )}
          <span className="text-[10px] text-gray-500">{t.builder.ai.voiceCloneMaxMinutes}</span>
        </div>
      ) : (
        <input
          type="file"
          accept="audio/*"
          onChange={onFileChosen}
          disabled={busy}
          className="mb-2 block w-full text-xs text-gray-700 file:me-2 file:rounded-md file:border-0 file:bg-brand-100 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-brand-800 hover:file:bg-brand-200"
        />
      )}

      {blobUrl && (
        <audio controls src={blobUrl} className="mb-2 w-full" />
      )}

      <div className="flex items-center gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t.builder.ai.voiceCloneNamePlaceholder}
          className="flex-1 rounded-md border border-gray-200 px-2 py-1 text-xs"
          disabled={busy}
        />
        <Button size="sm" variant="primary" onClick={doClone} disabled={!blob || busy || recording || hasElevenlabsKey === false} loading={busy}>
          {busy ? t.builder.ai.voiceCloneCloning : t.builder.ai.voiceCloneStart}
        </Button>
      </div>

      {error && (
        <div className="mt-2 rounded-md border border-red-300 bg-red-50 px-2 py-1.5 text-[11px] text-red-800">
          ⚠ {error}
        </div>
      )}
      {hasClone && !blob && !busy && (
        <div className="mt-2 rounded-md border border-emerald-300 bg-emerald-50 px-2 py-1.5 text-[11px] text-emerald-800">
          ✓ {t.builder.ai.voiceCloneCloned}
        </div>
      )}
    </div>
  );
}

/**
 * MoroccanVoicePresets — one-click Darija-tuned voice picks.
 * Each preset bundles provider + voice + model + sliders + persona
 * `instructions`. Clicking a card applies all fields at once via the
 * parent `update()` callback. A small preview button plays a canned
 * Darija sentence through the current preset's TTS path.
 */
function MoroccanVoicePresets({
  botId,
  currentVoiceId,
  onApply,
}: {
  botId: string;
  currentVoiceId: string;
  onApply: (patch: Partial<AiCfg>) => void;
}) {
  const [previewBusy, setPreviewBusy] = useState<string | null>(null);

  const apply = (p: MoroccanPreset) => {
    onApply({
      voiceProvider: p.provider,
      voiceId: p.voiceId,
      ...(p.voiceModelId ? { voiceModelId: p.voiceModelId } : {}),
      ...(p.voiceQuality ? { voiceQuality: p.voiceQuality } : {}),
      voiceInstructions: p.instructions,
      ...(p.voiceStability != null ? { voiceStability: p.voiceStability } : {}),
      ...(p.voiceSimilarityBoost != null ? { voiceSimilarityBoost: p.voiceSimilarityBoost } : {}),
      ...(p.voiceStyle != null ? { voiceStyle: p.voiceStyle } : {}),
    });
    toast.success(`✓ ${p.label}`);
  };

  const preview = async (p: MoroccanPreset) => {
    setPreviewBusy(p.key);
    try {
      // Use the existing voice-preview endpoint with the preset's config.
      // It returns audio bytes (base64) that we play inline.
      const r = await api.post<{ audioBase64?: string; audioMime?: string; error?: string }>(
        `/bots/${botId}/ai/voice-preview`,
        {
          text: 'مرحبا بيك! المنتج ديالنا بـ 180 درهم والتوصيل مجاني لجميع المدن.',
          voice: p.voiceId,
          voiceProvider: p.provider,
          voiceQuality: p.voiceQuality,
          voiceInstructions: p.instructions,
          voiceStability: p.voiceStability,
          voiceSimilarityBoost: p.voiceSimilarityBoost,
          voiceStyle: p.voiceStyle,
          voiceModelId: p.voiceModelId,
        },
      );
      if (!r?.audioBase64) throw new Error(r?.error ?? 'no audio');
      const blob = new Blob(
        [Uint8Array.from(atob(r.audioBase64), (c) => c.charCodeAt(0))],
        { type: r.audioMime ?? 'audio/ogg' },
      );
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.play().catch(() => {});
      audio.onended = () => URL.revokeObjectURL(url);
    } catch (e: any) {
      toast.error(`⚠️ ${e?.message ?? 'المعاينة فشلت'}`);
    } finally {
      setPreviewBusy(null);
    }
  };

  return (
    <div className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-3" dir="rtl">
      <div className="mb-1 flex items-center gap-1.5">
        <span className="text-sm font-semibold text-emerald-800">🇲🇦 أصوات مغربية جاهزة</span>
        <span className="text-[10px] text-emerald-700/60">(اضغط لتطبيق فوري)</span>
      </div>
      <p className="mb-2 text-[11px] leading-snug text-emerald-800/70">
        كل خيار يضبط الصوت + النموذج + التعليمات دفعة واحدة. يمكنك التعديل بعد الاختيار.
      </p>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
        {MOROCCAN_PRESETS.map((p) => {
          const selected = p.voiceId === currentVoiceId;
          return (
            <div
              key={p.key}
              className={`flex flex-col rounded-lg border bg-white p-2 transition ${
                selected ? 'border-emerald-500 ring-2 ring-emerald-300' : 'border-gray-200 hover:border-emerald-300'
              }`}
            >
              <button
                type="button"
                onClick={() => apply(p)}
                className="text-right"
              >
                <div className="mb-0.5 text-lg leading-none">{p.emoji}</div>
                <div className="text-[12px] font-medium leading-tight text-gray-900">{p.label}</div>
                <div className="mt-0.5 text-[9px] uppercase tracking-wide text-gray-500">
                  {p.provider === 'openai' ? 'OpenAI TTS' : 'ElevenLabs'}
                </div>
              </button>
              <button
                type="button"
                onClick={() => preview(p)}
                disabled={previewBusy === p.key}
                className="mt-1.5 rounded border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
              >
                {previewBusy === p.key ? '⏳ ...' : '🔊 استمع'}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
