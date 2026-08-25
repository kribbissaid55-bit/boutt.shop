/**
 * Prompt Builder v2 — conversational assistant that interviews the operator
 * about their product and writes a professional Darija sales system-prompt
 * for the bot's "AI brain" (systemPrompt).
 *
 * v2 capabilities:
 *  - Voice input: operator records a voice note → transcribed via the
 *    existing OpenAI STT pipeline (Darija-anchored) before the chat turn.
 *  - Product image: analyzed with vision (routed to OpenAI automatically).
 *  - Text attachments: .txt/.md/.csv product docs merged into the context.
 *  - Model routing: prefers the strongest available model (OpenAI gpt-4o
 *    when a key exists) and falls back to the bot's configured provider.
 *
 * POST /api/bots/:id/ai/prompt-builder
 *   body: { messages, imageDataUrl?, audioBase64?, audioMime?, attachments? }
 *   resp: { reply, prompt|null, transcript? }
 */
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { AiProvider, type ChatMessage, type ChatContentPart } from '../../services/AiProvider.js';

export const promptBuilderRouter = Router();

const BodySchema = z.object({
  messages: z
    .array(z.object({
      role: z.enum(['user', 'assistant']),
      content: z.string().min(1).max(8000),
    }))
    .min(1)
    .max(40),
  // Optional product image as a data URL (image/*). Client downsizes first.
  imageDataUrl: z.string().regex(/^data:image\//).max(1_500_000).optional(),
  // Optional voice note (base64, no data: prefix). ≤ ~1MB of audio.
  audioBase64: z.string().max(1_600_000).optional(),
  audioMime: z.string().max(80).optional(),
  // Optional text documents the operator attached (client-extracted).
  attachments: z.array(z.object({
    name: z.string().min(1).max(120),
    text: z.string().min(1).max(20_000),
  })).max(3).optional(),
});

const META_SYSTEM_PROMPT = `أنت "مساعد بناء البرومبت" — أذكى خبير في العالم في هندسة البرومبتات، وكتابة الإعلانات، وعلم نفس المبيعات، متمكن بعمق من الدارجة المغربية وتجارة الدفع عند الاستلام (COD) في المغرب.

مرجعيتك المعرفية (مدمجة في خبرتك — طبّقها دون ذكر أسمائها التقنية للمستخدم):
- مبادئ الإقناع الستة لروبرت سيالديني: المعاملة بالمثل، الالتزام والاتساق، الإثبات الاجتماعي، الإعجاب، السلطة، الندرة.
- بناء العرض الذي لا يُرفض (Alex Hormozi): تعظيم القيمة المدركة، تقليل المخاطر (ضمان/دفع عند الاستلام)، إضافة الاستعجال الصادق.
- أطر الكتابة: AIDA (انتباه-اهتمام-رغبة-فعل)، PAS (مشكلة-تهييج-حل)، FAB (خاصية-ميزة-فائدة)، القصص القصيرة.
- قواعد محادثات واتساب التجارية: ردود قصيرة كأنها من إنسان، رسالة واحدة = فكرة واحدة، سؤال واحد في كل رسالة، إغلاق الطلب في أقل عدد من الرسائل، عدم الإلحاح المزعج.
- خصوصيات السوق المغربي: الثقة أولاً، الدارجة الطبيعية غير المتكلفة، التوصيل والدفع عند الاستلام حجة قوية، التعامل الذكي مع "غالي" و"نفكر" و"خايف من الجودة".

مهمتك: محاورة صاحب المتجر لجمع معلومات منتجه، ثم كتابة "برومبت نظام" يجعل بوت واتساب أفضل بائع على الإطلاق.

قواعد الحوار:
- تكلم بلغة المستخدم نفسها (دارجة مغربية، عربية، أو فرنسية). كن ودوداً ومختصراً وعملياً.
- اطرح 1-3 أسئلة قصيرة في كل رسالة، بالتدريج: المنتج وفوائده، الجمهور، الثمن والعروض، التوصيل، التميز عن المنافسين، الاعتراضات الشائعة، أسلوب الرد، الوسائط المتوفرة.
- إذا وصلتك صورة منتج، حللها بعمق (الشكل، الجودة الظاهرة، الاستعمال، نقاط بيع بصرية) واستعملها.
- إذا وصلك نص من ملف مرفق، اعتبره مصدر حقيقة عن المنتج وادمج تفاصيله.
- إذا وصلتك رسالة صوتية مفرّغة، تعامل معها كأي كلام من المستخدم.

متى تكتب البرومبت النهائي:
- عندما تجمع معلومات كافية، أو عندما يطلبه المستخدم صراحة.
- قبل إخراجه، راجعه ذهنياً مقابل قائمة الجودة: (1) هوية وشخصية واضحة، (2) كل معلومات المنتج والثمن والتوصيل صحيحة كما أعطاها المستخدم دون اختراع، (3) سيناريو بيع متدرج حتى جمع بيانات الطلب، (4) ردود مقنعة على أشهر 4-6 اعتراضات، (5) قواعد صارمة ضد الاختراع وضد تخفيض الثمن، (6) دارجة طبيعية سلسة، (7) طول 400-900 كلمة منظم بعناوين. أصلح أي نقص قبل الإخراج.
- ضع البرومبت النهائي فقط بين [[PROMPT]] و [[/PROMPT]] بدون أي شرح داخلهما، وقبله جملة قصيرة مثل: "ها هو البرومبت — اعتمده بضغطة أو اطلب تعديلات".

مواصفات البرومبت النهائي (داخل العلامتين):
- بالعربية مع توجيه صريح أن يرد البوت بالدارجة المغربية الطبيعية الحلوة.
- يتضمن: هوية البوت واسمه ودوره؛ وصف المنتج والفوائد؛ الثمن والعروض والتوصيل؛ أسلوب الكلام (طيب، محترم، مقنع، ردود قصيرة، بدون مبالغة ولا كذب)؛ سيناريو البيع خطوة بخطوة من الترحيب إلى جمع الطلب (الاسم، الهاتف، المدينة، العنوان)؛ أجوبة جاهزة للاعتراضات؛ قواعد صارمة: لا يخترع معلومات، لا يغير الثمن، يحوّل للإنسان عند الطلب.

ممنوع: لا تدّعي أنك تتصفح الإنترنت مباشرة؛ اعتمد على خبرتك العميقة وأفضل الممارسات المجرّبة أعلاه.`;

promptBuilderRouter.post('/bots/:id/ai/prompt-builder', async (req, res) => {
  try {
    const { messages, imageDataUrl, audioBase64, audioMime, attachments } = BodySchema.parse(req.body);

    const cfg = await prisma.botAiConfig.findUnique({ where: { botId: req.params.id } });

    // ── STT: voice note → text (Darija-anchored OpenAI pipeline) ─────────
    let transcript: string | undefined;
    if (audioBase64) {
      try {
        const buf = Buffer.from(audioBase64, 'base64');
        transcript = await AiProvider.transcribe(buf, audioMime ?? 'audio/webm', cfg?.sttContextPrompt ?? undefined);
      } catch (e: any) {
        return res.status(400).json({ error: `stt_failed: ${String(e?.message ?? e).slice(0, 160)}` });
      }
    }

    // ── Model routing: strongest available first ─────────────────────────
    // Vision (image) requires OpenAI. Otherwise prefer gpt-4o when an OpenAI
    // credential exists — the builder is a one-shot authoring tool where
    // quality matters more than token price — else the bot's own provider.
    const hasOpenAiKey = !!(await prisma.aiCredential.findFirst({ where: { provider: 'openai' } }))
      || !!process.env.OPENAI_API_KEY;
    let provider: string;
    let model: string;
    if (imageDataUrl || hasOpenAiKey) {
      provider = 'openai';
      model = 'gpt-4o';
    } else {
      provider = cfg?.provider ?? 'deepseek';
      model = provider === 'deepseek' ? 'deepseek-chat' : (cfg?.model ?? 'gpt-4o-mini');
    }

    // ── Build the conversation ───────────────────────────────────────────
    const chatMessages: ChatMessage[] = [
      { role: 'system', content: META_SYSTEM_PROMPT },
      ...messages.slice(0, -1).map((m) => ({ role: m.role, content: m.content }) as ChatMessage),
    ];
    const last = messages[messages.length - 1];

    let lastText = last.content;
    if (transcript && transcript.trim()) {
      lastText = lastText === '🎤' ? `[رسالة صوتية]: ${transcript}` : `${lastText}\n[رسالة صوتية]: ${transcript}`;
    }
    if (attachments?.length) {
      const docs = attachments
        .map((a) => `--- ملف مرفق: ${a.name} ---\n${a.text}`)
        .join('\n\n');
      lastText = `${lastText}\n\n${docs}`;
    }

    if (imageDataUrl && last.role === 'user') {
      const parts: ChatContentPart[] = [
        { type: 'text', text: lastText },
        { type: 'image_url', image_url: { url: imageDataUrl } },
      ];
      chatMessages.push({ role: 'user', content: parts });
    } else {
      chatMessages.push({ role: last.role, content: lastText } as ChatMessage);
    }

    const result = await AiProvider.chat(provider, {
      messages: chatMessages,
      model,
      temperature: 0.7,
      maxTokens: 2500,
      plainTextOnly: true,
    });

    const raw = result.text ?? '';
    const m = raw.match(/\[\[PROMPT\]\]([\s\S]*?)\[\[\/PROMPT\]\]/);
    const prompt = m ? m[1].trim() : null;
    const reply = raw.replace(/\[\[PROMPT\]\][\s\S]*?\[\[\/PROMPT\]\]/g, '').trim();

    res.json({ reply: reply || (prompt ? '✅' : ''), prompt, transcript });
  } catch (e: any) {
    const msg: string = e?.message ?? 'prompt_builder_failed';
    const friendly = msg.startsWith('no_credentials_for_') ? msg : msg.slice(0, 200);
    res.status(400).json({ error: friendly });
  }
});
