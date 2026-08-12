/**
 * StepMatcherService — picks the next step given the current contact state +
 * incoming text. Replaces the old FlowMatcherService.
 *
 * Priority (after the engine has handled order-state, handover-keywords,
 * paused contacts, idempotency, and emergency-stop):
 *   1. current step's options (number / label / keywords)
 *   2. exact_match steps (whole-message normalized equality)
 *   3. keyword steps (any keyword found in the message)
 *   4. welcome (first contact + welcomeEnabled + inactivity reset)
 *   5. fallback step
 */
import { prisma } from '../lib/prisma.js';
import { normalizeText } from '../lib/jid.js';
import { matchOption } from '../engine/matchOption.js';
import type { Bot, BotStep, BotOption, MessageBlock, MediaFile } from '@prisma/client';

export type StepWithChildren = BotStep & {
  blocks: (MessageBlock & { media: MediaFile | null })[];
  options: BotOption[];
};

export const StepMatcherService = {
  async pickActiveBot(accountId: string): Promise<Bot | null> {
    const links = await prisma.botAccount.findMany({
      where: { accountId },
      include: { bot: true },
    });
    const active = links.map((l) => l.bot).filter((b) => b.isActive && b.status !== 'paused');
    if (!active.length) return null;
    active.sort(
      (a, b) =>
        b.priority - a.priority ||
        b.updatedAt.getTime() - a.updatedAt.getTime()
    );
    return active[0];
  },

  async getStep(stepId: string): Promise<StepWithChildren | null> {
    return prisma.botStep.findUnique({
      where: { id: stepId },
      include: {
        blocks: { orderBy: { sortOrder: 'asc' }, include: { media: true } },
        options: { orderBy: { sortOrder: 'asc' } },
      },
    }) as any;
  },

  getWelcomeStep(botId: string) {
    return prisma.botStep.findFirst({ where: { botId, type: 'welcome', isActive: true } });
  },

  getFallbackStep(botId: string) {
    return prisma.botStep.findFirst({ where: { botId, type: 'fallback', isActive: true } });
  },

  getHandoverStep(botId: string) {
    return prisma.botStep.findFirst({ where: { botId, type: 'handover', isActive: true } });
  },

  /** Return the next step to walk, given current step + incoming text. */
  async match(botId: string, current: StepWithChildren | null, text: string) {
    const norm = normalizeText(text);
    if (!norm) return this.getFallbackStep(botId);

    // 1) options on current step
    if (current?.options?.length) {
      const opt = matchOption(current.options, text);
      if (opt?.targetStepId) {
        return prisma.botStep.findUnique({ where: { id: opt.targetStepId } });
      }
    }

    // 1b) Welcome step's options act as a "main menu" reachable from any step.
    //     This fixes the dead-end where, after walking an option_reply leaf,
    //     the user types another number and gets the fallback (the leaf step
    //     has no options of its own to match).
    if (current?.id !== undefined) {
      const welcome = await this.getWelcomeStep(botId);
      if (welcome && welcome.id !== current.id) {
        const fullWelcome = await this.getStep(welcome.id);
        if (fullWelcome?.options?.length) {
          const opt = matchOption(fullWelcome.options, text);
          if (opt?.targetStepId) {
            return prisma.botStep.findUnique({ where: { id: opt.targetStepId } });
          }
        }
      }
    }

    // 2) exact_match anywhere in the bot
    const exacts = await prisma.botStep.findMany({
      where: { botId, type: 'exact_match', isActive: true },
    });
    for (const s of exacts) {
      if (s.triggerValue && normalizeText(s.triggerValue) === norm) return s;
    }

    // 3) keyword anywhere in the bot
    const kwSteps = await prisma.botStep.findMany({
      where: { botId, type: 'keyword', isActive: true },
    });
    for (const s of kwSteps) {
      const kws = (s.triggerValue ?? '').split(',').map((k) => normalizeText(k)).filter(Boolean);
      if (kws.some((k) => norm.includes(k))) return s;
    }

    return this.getFallbackStep(botId);
  },

  /**
   * Like `match()`, but returns null when no option / exact_match / keyword
   * matches. Used by the `rule_priority` engine mode to decide whether the
   * rule-bot has a programmed response for this message, or AI should take
   * over. Does NOT consult the fallback step — the AI is the fallback.
   */
  async tryMatch(botId: string, current: StepWithChildren | null, text: string) {
    const norm = normalizeText(text);
    if (!norm) return null;

    // 1) options on current step
    if (current?.options?.length) {
      const opt = matchOption(current.options, text);
      if (opt?.targetStepId) {
        return prisma.botStep.findUnique({ where: { id: opt.targetStepId } });
      }
    }

    // 1b) Welcome step's options act as a "main menu" reachable from any step.
    if (current?.id !== undefined) {
      const welcome = await this.getWelcomeStep(botId);
      if (welcome && welcome.id !== current.id) {
        const fullWelcome = await this.getStep(welcome.id);
        if (fullWelcome?.options?.length) {
          const opt = matchOption(fullWelcome.options, text);
          if (opt?.targetStepId) {
            return prisma.botStep.findUnique({ where: { id: opt.targetStepId } });
          }
        }
      }
    }

    // 2) exact_match anywhere in the bot
    const exacts = await prisma.botStep.findMany({
      where: { botId, type: 'exact_match', isActive: true },
    });
    for (const s of exacts) {
      if (s.triggerValue && normalizeText(s.triggerValue) === norm) return s;
    }

    // 3) keyword anywhere in the bot
    const kwSteps = await prisma.botStep.findMany({
      where: { botId, type: 'keyword', isActive: true },
    });
    for (const s of kwSteps) {
      const kws = (s.triggerValue ?? '').split(',').map((k) => normalizeText(k)).filter(Boolean);
      if (kws.some((k) => norm.includes(k))) return s;
    }

    return null;   // ← AI is the fallback in rule_priority mode
  },
};
