/**
 * Shared layered-system-message assembly used by BOTH the production engine
 * (`aiHandleIncoming` in aiEngine.ts) AND the preview test endpoint
 * (`POST /bots/:id/ai/test` in ai.routes.ts). Previously each site duplicated
 * the assembly and was a drift risk — adding a new rule in one place meant
 * the operator's preview would diverge from real WhatsApp behavior.
 *
 * Order is load-bearing: the operator-override block sits LAST (just before
 * the JSON envelope) so the LLM treats it as the final, highest-priority
 * instruction. Many LLMs honor the LAST contradictory rule when conflicts
 * appear in a single system message.
 */
import {
  AI_SALES_SCRIPT_AR,
  buildOperatorOverrideBlock,
  buildStageHint,
} from './aiSalesScript.js';
import {
  buildCollectionPrompt,
  buildInstructionMediaBlock,
  type InstructionMediaItem,
  type OrderDraft,
} from './aiEngine.js';
import type { CustomerStatusKey } from '../services/CustomerTagService.js';

function buildDisabledFieldsHardBlock(cfg: { [key: string]: any }): string {
  const disabledLabels: string[] = [];
  if (!cfg.collectName)     disabledLabels.push('الاسم الكامل');
  if (!cfg.collectPhone)    disabledLabels.push('رقم الهاتف');
  if (!cfg.collectCity)     disabledLabels.push('المدينة');
  if (!cfg.collectAddress)  disabledLabels.push('العنوان');
  if (!cfg.collectQuantity) disabledLabels.push('الكمية');
  if (!disabledLabels.length) return '';
  return [
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '🔴 حقول مُعطّلة — قاعدة لا تقبل التساهل',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'الحقول التالية مُعطّلة من قبل المالك:',
    ...disabledLabels.map((l) => `  - ${l}`),
    'ممنوع منعا قاطعا:',
    '  • طلبها من العميل (لا مباشرة ولا تلميحا).',
    '  • استخراجها من رسائله حتى لو ذكرها هو بنفسه.',
    '  • وضعها في draft_updates ضمن JSON الرد.',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  ].join('\n');
}

function buildAskedBlock(lastAiQuestions: string[]): string {
  if (!lastAiQuestions.length) return '';
  return [
    '📜 أسئلة سبق أن طرحتَها على هذا العميل — لا تكررها بنفس الصياغة:',
    ...lastAiQuestions.map((q) => `  - ${q.slice(0, 140)}`),
    'إذا لم يجب العميل، نوّع الصياغة أو انتقل لمعلومة أخرى.',
  ].join('\n');
}

function buildPostOrderBlock(postOrderQuiet: boolean): string {
  if (!postOrderQuiet) return '';
  return [
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '🏁 وضع ما بعد الطلب — العميل أكمل الطلب بنجاح',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '• لا تطرح أي سؤال جديد على العميل.',
    '• لا تقدم عروضا، منتجات إضافية، أو ملاحظات تلقائية.',
    '• رد فقط إذا سأل العميل سؤالا مباشرا (وليس مجرد "شكرا" أو "أوكي").',
    '• كل رد سطر واحد قصير جدا، بأسلوب لطيف.',
    '• إذا كانت رسالة العميل تحية أو شكر، رد بكلمة واحدة: "في الخدمة 🌹".',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  ].join('\n');
}

/**
 * Block injected when the operator has cloned their voice via ElevenLabs IVC.
 * The stored `voiceClonedPersona` is a Whisper transcript excerpt of the
 * sample they uploaded; feeding it to the LLM as "match this speaking style"
 * gets the AI's word choice, dialect and register to align with the operator.
 * The TTS side plays the cloned voice; this side aligns the text itself.
 * Empty / null persona → block omitted.
 */
function buildVoicePersonaBlock(voiceClonedPersona: string | null | undefined): string {
  const s = (voiceClonedPersona ?? '').trim();
  if (!s) return '';
  return [
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '🎙️ نمط الكلام المستهدف — قلّده حرفياً في كل رد',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'هذا نموذج حقيقي من طريقة كلام مالك المتجر (لهجة، مفردات، نبرة، إيقاع).',
    'صُغْ ردودك بنفس اللهجة والأسلوب والاختصارات، حتى يشعر العميل أنه يتحدث مع نفس الشخص:',
    '<<START>>',
    s,
    '<<END>>',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  ].join('\n');
}

export function buildLayeredSystemMessage(input: {
  cfg: {
    systemPrompt?: string | null;
    collectionEnabled?: boolean;
    [key: string]: any;
  };
  draft: OrderDraft;
  catalog: string;
  instructionMedia: InstructionMediaItem[];
  stage: CustomerStatusKey | null;
  /** Most recent AI replies that contained a question — injected as
   *  "already asked, don't repeat" guidance. */
  recentAiQuestions?: string[];
  /** True when draft.finalized && cfg.continueAfterOrder — adds the quiet-mode
   *  post-order block so the AI stops being proactive after a successful order. */
  postOrderQuiet?: boolean;
}): string {
  const { cfg, draft, catalog, instructionMedia, stage } = input;
  const collection = cfg.collectionEnabled ? buildCollectionPrompt(cfg, draft) : '';
  const mediaBlock = buildInstructionMediaBlock(instructionMedia);
  const stageHint = buildStageHint(stage);
  const operatorOverride = buildOperatorOverrideBlock(cfg.systemPrompt ?? null);
  const disabledHardBlock = cfg.collectionEnabled ? buildDisabledFieldsHardBlock(cfg) : '';
  const askedBlock = buildAskedBlock(input.recentAiQuestions ?? []);
  const postOrderBlock = buildPostOrderBlock(!!input.postOrderQuiet);
  const voicePersonaBlock = buildVoicePersonaBlock(cfg.voiceClonedPersona ?? null);

  return [
    AI_SALES_SCRIPT_AR,
    catalog,
    mediaBlock,
    disabledHardBlock,
    collection,
    askedBlock,
    stageHint,
    `قواعد الرد (افتراضية — يمكن أن يلغيها المالك في توجيهاته):`,
    `- اجعل ردودك قصيرة (سطر إلى ثلاثة أسطر) ما لم يطلب العميل التفاصيل.`,
    `- لا تفصح أنك بوت أو ذكاء اصطناعي.`,
    `- استعمل الدارجة المغربية البسيطة.`,
    cfg.collectionEnabled ? `- لا تطلب أكثر من معلومة واحدة في كل رد.` : '',
    `إذا طلب العميل صورة/فيديو لمنتج وهو موجود في الكتالوج، أضف معرّف الملف في send_media_ids.`,
    postOrderBlock,
    // Persona block goes RIGHT BEFORE the operator override, so the
    // operator's own systemPrompt (highest priority) can still countermand.
    voicePersonaBlock,
    operatorOverride,
    `أجب بصيغة JSON صارمة بدون شرح خارجي:`,
    // The `mode` field is intentionally NOT in this envelope. The reply mode
    // (text vs voice) is decided server-side from the operator's pin or the
    // mirror in 'auto' — the LLM has no say.
    `{"reply":"<النص>","draft_updates":{...},"use_wa_phone":true|false,"order_done":true|false,"send_media_ids":["<labelOrMediaId>", ...]}`,
    // Provider-agnostic guarantee that at least a `reply` shows up. Without
    // this, DeepSeek in json_object mode routinely returns `{}` on short or
    // casual inputs — which then triggers our canned "please rephrase" and
    // creates a self-reinforcing loop the operator sees as "bot broken".
    `إلزامي: حقل \`reply\` مطلوب في كل رد ويجب أن يحتوي نصاً غير فارغ. لا تُرجع \`{}\` فارغاً. إذا كنت غير متأكد من نية العميل فاسأله سؤالاً واحداً واضحاً في \`reply\` لتوضح.`,
  ].filter(Boolean).join('\n');
}
