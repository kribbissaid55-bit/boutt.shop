/**
 * Creates a new bot pre-populated with a Welcome / Fallback / Handover step
 * skeleton plus a default BotSettings row. Called by POST /api/bots.
 */
import { prisma } from '../lib/prisma.js';

export const BotTemplateService = {
  async createBotWithDefaults(input: { name: string; description?: string }) {
    return prisma.$transaction(async (tx) => {
      const bot = await tx.bot.create({
        data: {
          name: input.name,
          description: input.description,
          status: 'draft',
          defaultLanguage: 'ar',
        },
      });

      await tx.botSettings.create({
        data: {
          botId: bot.id,
          welcomeEnabled: true,
          // Safer default: bot stays silent when the customer's message
          // doesn't match any option/exact/keyword. Operator can turn this
          // on in the bot settings UI to send the fallback text instead.
          fallbackEnabled: false,
          groupsEnabled: false,
          inactivityResetHours: 24,
          sendWelcomeOnce: false,
          pauseAfterWelcome: false,
          notifyOnHandover: true,
          maxFailedAttempts: 3,
          defaultFallbackMessage:
            'سمح ليا، ما فهمتش الاختيار ديالك. عافاك اختار رقم من القائمة.',
          humanHandoverKeywords: JSON.stringify([
            'بغيت نهضر مع شي واحد',
            'عيط ليا',
            'موظف',
            'صاحب المحل',
            'الدعم',
            'support',
            'human',
            'call me',
            'parler à un humain',
            'agent',
          ]),
        },
      });

      // Welcome step
      const welcome = await tx.botStep.create({
        data: {
          botId: bot.id,
          title: 'رسالة الترحيب',
          type: 'welcome',
          triggerType: 'welcome',
          isActive: true,
          sortOrder: 0,
        },
      });
      await tx.messageBlock.create({
        data: {
          stepId: welcome.id, type: 'text', sortOrder: 0,
          content: 'السلام عليكم، مرحبا بك. اختار السؤال اللي بغيتي:',
        },
      });

      // Fallback
      await tx.botStep.create({
        data: {
          botId: bot.id,
          title: 'الرد الاحتياطي',
          type: 'fallback',
          triggerType: 'fallback',
          isActive: true,
          sortOrder: 99,
        },
      });

      // Handover
      const handover = await tx.botStep.create({
        data: {
          botId: bot.id,
          title: 'تحويل لموظف',
          type: 'handover',
          triggerType: 'handover',
          isActive: true,
          sortOrder: 100,
        },
      });
      await tx.messageBlock.create({
        data: {
          stepId: handover.id, type: 'text', sortOrder: 0,
          content: 'وصلات رسالتك، غادي يتواصل معك واحد المسؤول في أقرب وقت.',
        },
      });
      await tx.messageBlock.create({
        data: {
          stepId: handover.id, type: 'action', sortOrder: 1,
          actionType: 'mark_needs_human',
        },
      });
      await tx.messageBlock.create({
        data: {
          stepId: handover.id, type: 'action', sortOrder: 2,
          actionType: 'pause_bot',
        },
      });

      return bot;
    });
  },
};
