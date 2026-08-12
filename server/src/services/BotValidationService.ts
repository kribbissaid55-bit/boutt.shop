/**
 * BotValidationService — checks a bot's structure before publish.
 * Returns errors (block publish), warnings (allow but flag), and suggestions.
 */
import { prisma } from '../lib/prisma.js';

export type IssueLevel = 'error' | 'warning' | 'suggestion';
export interface Issue {
  level: IssueLevel;
  code: string;
  message: string;
  stepId?: string;
  blockId?: string;
  optionId?: string;
}

export const BotValidationService = {
  async validate(botId: string): Promise<{ errors: Issue[]; warnings: Issue[]; suggestions: Issue[] }> {
    const bot = await prisma.bot.findUnique({
      where: { id: botId },
      include: {
        accounts: true,
        steps: {
          include: {
            blocks: { include: { media: true } },
            options: true,
          },
        },
      },
    });
    if (!bot) throw Object.assign(new Error('bot not found'), { status: 404 });

    const issues: Issue[] = [];
    const stepIds = new Set(bot.steps.map((s) => s.id));

    const welcome = bot.steps.find((s) => s.type === 'welcome');
    const fallback = bot.steps.find((s) => s.type === 'fallback');
    const handover = bot.steps.find((s) => s.type === 'handover');

    if (!welcome) issues.push({ level: 'error', code: 'NO_WELCOME', message: 'البوت محتاج عقدة Welcome / Le bot doit avoir une étape de bienvenue' });
    if (welcome && welcome.blocks.length === 0) {
      issues.push({ level: 'error', code: 'EMPTY_WELCOME', message: 'عقدة الترحيب فارغة / Étape de bienvenue vide', stepId: welcome.id });
    }
    if (!fallback) issues.push({ level: 'warning', code: 'NO_FALLBACK', message: 'لا يوجد رد احتياطي / Pas d’étape fallback' });
    if (!handover) issues.push({ level: 'suggestion', code: 'NO_HANDOVER', message: 'لا يوجد تحويل لموظف / Pas d’étape de transfert humain' });

    if (bot.accounts.length === 0) {
      issues.push({ level: 'warning', code: 'NO_ACCOUNT_LINKED', message: 'لم يتم ربط حساب واتساب / Aucun compte WhatsApp lié' });
    }

    for (const step of bot.steps) {
      // empty body
      if (step.blocks.length === 0 && step.type !== 'end') {
        issues.push({ level: 'warning', code: 'EMPTY_STEP', message: `العقدة "${step.title}" فارغة`, stepId: step.id });
      }

      // empty text blocks
      for (const b of step.blocks) {
        if (b.type === 'text' && (!b.content || !b.content.trim())) {
          issues.push({ level: 'error', code: 'EMPTY_TEXT', message: 'كتلة نص فارغة', stepId: step.id, blockId: b.id });
        }
        if ((b.type === 'audio' || b.type === 'image' || b.type === 'video' || b.type === 'document') && !b.media) {
          // Warning, not error — empty media blocks are silently skipped at runtime,
          // so they don't actually break the bot. Just nudge the user.
          issues.push({ level: 'warning', code: 'MISSING_MEDIA', message: 'كتلة بدون ملف مرفق (سيتم تخطيها)', stepId: step.id, blockId: b.id });
        }
        if (b.type === 'delay' && (!b.delaySeconds || b.delaySeconds < 0)) {
          issues.push({ level: 'warning', code: 'BAD_DELAY', message: 'مدة الانتظار غير صحيحة', stepId: step.id, blockId: b.id });
        }
        if (b.type === 'text' && b.content && b.content.length > 1500) {
          issues.push({ level: 'warning', code: 'LONG_TEXT', message: 'نص طويل جدا قد يُقطع', stepId: step.id, blockId: b.id });
        }
      }

      // options
      for (const opt of step.options) {
        if (!opt.targetStepId) {
          issues.push({ level: 'error', code: 'OPTION_NO_TARGET', message: `الاختيار "${opt.label}" بدون عقدة هدف`, stepId: step.id, optionId: opt.id });
        } else if (!stepIds.has(opt.targetStepId)) {
          issues.push({ level: 'error', code: 'OPTION_DEAD_TARGET', message: `الاختيار "${opt.label}" يشير لعقدة غير موجودة`, stepId: step.id, optionId: opt.id });
        }
      }

      // button mode > 3 options
      const optBlocks = step.blocks.filter((b) => b.type === 'options');
      for (const ob of optBlocks) {
        const meta = ob.metadata ? safeJson(ob.metadata) : null;
        const mode = meta?.displayMode ?? 'numbered';
        if (mode === 'buttons' && step.options.length > 3) {
          issues.push({
            level: 'warning', code: 'TOO_MANY_BUTTONS',
            message: 'أكثر من 3 اختيارات في وضع الأزرار — سيتم التحويل تلقائيا للقائمة المرقمة',
            stepId: step.id, blockId: ob.id,
          });
        }
      }
    }

    const errors = issues.filter((i) => i.level === 'error');
    const warnings = issues.filter((i) => i.level === 'warning');
    const suggestions = issues.filter((i) => i.level === 'suggestion');
    return { errors, warnings, suggestions };
  },
};

function safeJson(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}
