/**
 * Prompt Builder — conversational assistant that interviews the operator
 * about their product and writes a professional sales system-prompt for the
 * bot's "AI brain" (systemPrompt). Chat-style: the operator talks to it like
 * a chatbot, can attach a product image, and when ready the assistant emits
 * the final prompt between [[PROMPT]] ... [[/PROMPT]] markers which the UI
 * offers to adopt into the systemPrompt field with one click.
 *
 * POST /api/bots/:id/ai/prompt-builder
 *   body: { messages: [{role, content}], imageDataUrl? }
 *   resp: { reply: string, prompt: string | null }
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
      content: z.string().min(1).max(6000),
    }))
    .min(1)
    .max(40),
  // Optional product image as a data URL (image/*). ~5MB base64 cap.
  imageDataUrl: z.string().regex(/^data:image\//).max(7_000_000).optional(),
});

const META_SYSTEM_PROMPT = `أنت "مساعد بناء البرومبت" — خبير عالمي في هندسة البرومبتات وكتابة الإعلانات (copywriting) وأفضل بائع على الإطلاق، متمكن بعمق من الدارجة المغربية وثقافة التجارة الإلكترونية والدفع عند الاستلام (COD) في المغرب.

مهمتك: محاورة صاحب المتجر لجمع معلومات منتجه، ثم كتابة "برومبت نظام" احترافي كامل يصبح شخصية وتعليمات بوت واتساب بيّاع.

قواعد الحوار:
- تكلم بلغة المستخدم نفسها (دارجة مغربية، عربية فصحى، أو فرنسية). كن ودوداً ومختصراً.
- اطرح سؤالاً إلى ثلاثة أسئلة قصيرة في كل رسالة، بالتدريج: المنتج وفائدته، الجمهور، الثمن والعروض، التوصيل، ما يميزه، الاعتراضات الشائعة، أسلوب الرد المطلوب، روابط أو ملفات وسائط متوفرة.
- إذا أرفق المستخدم صورة منتج، حللها بدقة واستخرج منها كل التفاصيل المفيدة للبيع.
- اعتمد على أفضل أطر البيع المعروفة (AIDA، PAS، الإثبات الاجتماعي، الندرة، معالجة الاعتراضات) دون ذكرها بأسماء تقنية للمستخدم.

متى تكتب البرومبت النهائي:
- عندما تجمع معلومات كافية، أو عندما يطلبه المستخدم صراحة، اكتب النسخة النهائية.
- ضع البرومبت النهائي فقط بين علامتي [[PROMPT]] و [[/PROMPT]] وبدون أي شرح داخلهما.
- قبل العلامة اكتب جملة قصيرة مثل: "ها هو البرومبت — يمكنك اعتماده بضغطة واحدة أو طلب تعديلات".

مواصفات البرومبت النهائي (داخل العلامتين):
- مكتوب بالعربية مع توجيه صريح أن يرد البوت بالدارجة المغربية الطبيعية الحلوة.
- يتضمن: هوية البوت واسمه ودوره؛ وصف المنتج والفوائد بالتفصيل؛ الثمن والعروض والتوصيل؛ أسلوب الكلام (طيب، محترم، مقنع، ردود قصيرة مثل محادثة واتساب حقيقية، بدون مبالغة ولا كذب)؛ سيناريو البيع خطوة بخطوة من الترحيب إلى جمع الطلب (الاسم، الهاتف، المدينة، العنوان)؛ أجوبة جاهزة لأشهر الاعتراضات (الثمن غالي، خايف من الجودة، نفكر...)؛ قواعد صارمة: لا يخترع معلومات، لا يخفض الثمن بدون إذن، يحوّل للإنسان عند الطلب.
- طويل بما يكفي ليكون كاملاً (400-900 كلمة) ومنظم بعناوين قصيرة.

ممنوع: لا تدّعي أنك تتصفح الإنترنت مباشرة؛ اعتمد على خبرتك ومعرفتك الواسعة وأفضل الممارسات المجرّبة.`;

promptBuilderRouter.post('/bots/:id/ai/prompt-builder', async (req, res) => {
  try {
    const { messages, imageDataUrl } = BodySchema.parse(req.body);

    const cfg = await prisma.botAiConfig.findUnique({ where: { botId: req.params.id } });

    // Provider routing: images need vision → OpenAI. Otherwise reuse the
    // bot's configured provider so the operator's existing key keeps working.
    let provider = cfg?.provider ?? 'openai';
    let model = cfg?.model ?? 'gpt-4o-mini';
    if (imageDataUrl) {
      provider = 'openai';
      model = 'gpt-4o';
    } else if (provider === 'deepseek') {
      model = 'deepseek-chat'; // force the non-reasoner model for snappy chat
    }

    const chatMessages: ChatMessage[] = [
      { role: 'system', content: META_SYSTEM_PROMPT },
      ...messages.slice(0, -1).map((m) => ({ role: m.role, content: m.content }) as ChatMessage),
    ];
    const last = messages[messages.length - 1];
    if (imageDataUrl && last.role === 'user') {
      const parts: ChatContentPart[] = [
        { type: 'text', text: last.content },
        { type: 'image_url', image_url: { url: imageDataUrl } },
      ];
      chatMessages.push({ role: 'user', content: parts });
    } else {
      chatMessages.push({ role: last.role, content: last.content } as ChatMessage);
    }

    const result = await AiProvider.chat(provider, {
      messages: chatMessages,
      model,
      temperature: 0.7,
      maxTokens: 2000,
      plainTextOnly: true,
    });

    const raw = result.text ?? '';
    // Extract the final prompt if the assistant emitted one.
    const m = raw.match(/\[\[PROMPT\]\]([\s\S]*?)\[\[\/PROMPT\]\]/);
    const prompt = m ? m[1].trim() : null;
    // Strip the markers (and their content) from the visible reply — the UI
    // renders the extracted prompt in its own styled card instead.
    const reply = raw.replace(/\[\[PROMPT\]\][\s\S]*?\[\[\/PROMPT\]\]/g, '').trim();

    res.json({ reply: reply || (prompt ? '✅' : ''), prompt });
  } catch (e: any) {
    const msg: string = e?.message ?? 'prompt_builder_failed';
    // Surface credential problems in a way the UI can translate.
    const friendly = msg.startsWith('no_credentials_for_')
      ? msg
      : msg.slice(0, 200);
    res.status(400).json({ error: friendly });
  }
});
