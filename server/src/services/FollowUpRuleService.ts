/**
 * FollowUpRuleService — CRUD for FollowUpRule + FollowUpStep.
 *
 * The step's `messageSequence` is stored as a JSON string with the same shape
 * the bot's MessageBlock walker already understands. That way the FollowUpEngine
 * can hand the JSON to the same `walkStep`-style runner.
 */
import { prisma } from '../lib/prisma.js';
import type { FollowUpRule, FollowUpStep } from '@prisma/client';

export type Trigger =
  | 'no_reply'
  | 'after_first_message'
  | 'after_welcome'
  | 'after_bot_answer'
  | 'after_option'
  | 'after_status'
  | 'after_admin_reply'
  | 'after_import_batch'
  | 'after_campaign'
  | 'custom';

export type DelayUnit = 'minutes' | 'hours' | 'days';

export interface RuleScope {
  accountIds?: string[];
  botIds?: string[];
  segmentId?: string;
  statuses?: string[];
  tags?: string[];
  cities?: string[];
  importBatchIds?: string[];
}

export interface RuleConditions {
  notOrdered?: boolean;
  notRejected?: boolean;
  notDoNotContact?: boolean;
  respectBotPaused?: boolean;
  notContactedInLastHours?: number;
}

export interface MessageBlockJson {
  type: 'text' | 'audio' | 'image' | 'video' | 'document' | 'delay' | 'options' | 'action';
  content?: string;
  mediaId?: string;
  caption?: string;
  delaySeconds?: number;
  actionType?: string;
  actionPayload?: any;
  enabled?: boolean;
  metadata?: any;
  options?: { number: string; label: string; targetStepId?: string }[];
}

export interface MessageSequenceJson {
  blocks: MessageBlockJson[];
}

const safeJson = <T>(s: string | null, fallback: T): T => {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
};
const stringify = (v: unknown): string | null =>
  v === undefined || v === null ? null : JSON.stringify(v);

export interface RuleWithSteps extends FollowUpRule {
  steps: FollowUpStep[];
}

export const FollowUpRuleService = {
  async list(): Promise<RuleWithSteps[]> {
    return prisma.followUpRule.findMany({
      orderBy: { createdAt: 'desc' },
      include: { steps: { orderBy: { stepOrder: 'asc' } } },
    });
  },

  async get(id: string): Promise<RuleWithSteps | null> {
    return prisma.followUpRule.findUnique({
      where: { id },
      include: { steps: { orderBy: { stepOrder: 'asc' } } },
    });
  },

  async create(data: {
    name: string;
    triggerType: Trigger;
    isActive?: boolean;
    accountId?: string | null;
    botId?: string | null;
    scope?: RuleScope;
    conditions?: RuleConditions;
    workingHours?: any;
  }) {
    return prisma.followUpRule.create({
      data: {
        name: data.name.trim(),
        triggerType: data.triggerType,
        isActive: data.isActive ?? false,
        accountId: data.accountId ?? null,
        botId: data.botId ?? null,
        scope: stringify(data.scope),
        conditions: stringify(data.conditions),
        workingHours: stringify(data.workingHours),
      },
    });
  },

  async update(id: string, data: Partial<{
    name: string;
    triggerType: Trigger;
    isActive: boolean;
    activatedAt: Date | null;
    accountId: string | null;
    botId: string | null;
    scope: RuleScope | null;
    conditions: RuleConditions | null;
    workingHours: any;
  }>) {
    const patch: any = {};
    if (data.name !== undefined) patch.name = data.name.trim();
    if (data.triggerType !== undefined) patch.triggerType = data.triggerType;
    if (data.isActive !== undefined) patch.isActive = data.isActive;
    if (data.activatedAt !== undefined) patch.activatedAt = data.activatedAt;
    if (data.accountId !== undefined) patch.accountId = data.accountId;
    if (data.botId !== undefined) patch.botId = data.botId;
    if (data.scope !== undefined) patch.scope = stringify(data.scope);
    if (data.conditions !== undefined) patch.conditions = stringify(data.conditions);
    if (data.workingHours !== undefined) patch.workingHours = stringify(data.workingHours);
    return prisma.followUpRule.update({ where: { id }, data: patch });
  },

  remove(id: string) {
    return prisma.followUpRule.delete({ where: { id } });
  },

  async duplicate(id: string): Promise<RuleWithSteps | null> {
    const src = await prisma.followUpRule.findUnique({
      where: { id }, include: { steps: { orderBy: { stepOrder: 'asc' } } },
    });
    if (!src) return null;
    return prisma.$transaction(async (tx) => {
      const copy = await tx.followUpRule.create({
        data: {
          name: src.name + ' (copy)',
          triggerType: src.triggerType,
          isActive: false,
          scope: src.scope,
          conditions: src.conditions,
          workingHours: src.workingHours,
        },
      });
      for (const s of src.steps) {
        await tx.followUpStep.create({
          data: {
            ruleId: copy.id,
            stepOrder: s.stepOrder,
            delayValue: s.delayValue,
            delayUnit: s.delayUnit,
            messageSequence: s.messageSequence,
            conditions: s.conditions,
            stopConditions: s.stopConditions,
          },
        });
      }
      return tx.followUpRule.findUnique({ where: { id: copy.id }, include: { steps: { orderBy: { stepOrder: 'asc' } } } });
    });
  },

  /* ──── Steps ──── */

  async addStep(ruleId: string, data: {
    delayValue: number;
    delayUnit: DelayUnit;
    messageSequence?: MessageSequenceJson;
    conditions?: any;
    stopConditions?: any;
  }) {
    const last = await prisma.followUpStep.findFirst({
      where: { ruleId }, orderBy: { stepOrder: 'desc' },
    });
    return prisma.followUpStep.create({
      data: {
        ruleId,
        stepOrder: (last?.stepOrder ?? -1) + 1,
        delayValue: data.delayValue,
        delayUnit: data.delayUnit,
        messageSequence: stringify(data.messageSequence ?? { blocks: [] })!,
        conditions: stringify(data.conditions),
        stopConditions: stringify(data.stopConditions),
      },
    });
  },

  async updateStep(stepId: string, data: Partial<{
    delayValue: number;
    delayUnit: DelayUnit;
    messageSequence: MessageSequenceJson;
    conditions: any;
    stopConditions: any;
  }>) {
    const patch: any = {};
    if (data.delayValue !== undefined) patch.delayValue = data.delayValue;
    if (data.delayUnit !== undefined) patch.delayUnit = data.delayUnit;
    if (data.messageSequence !== undefined) patch.messageSequence = stringify(data.messageSequence);
    if (data.conditions !== undefined) patch.conditions = stringify(data.conditions);
    if (data.stopConditions !== undefined) patch.stopConditions = stringify(data.stopConditions);
    return prisma.followUpStep.update({ where: { id: stepId }, data: patch });
  },

  removeStep(stepId: string) {
    return prisma.followUpStep.delete({ where: { id: stepId } });
  },

  async reorderSteps(ruleId: string, stepIds: string[]) {
    await prisma.$transaction(
      stepIds.map((id, i) => prisma.followUpStep.update({ where: { id }, data: { stepOrder: i } }))
    );
    return prisma.followUpStep.findMany({ where: { ruleId }, orderBy: { stepOrder: 'asc' } });
  },

  /* ──── Validation + helpers ──── */

  parseMessageSequence(s: string | null): MessageSequenceJson {
    return safeJson<MessageSequenceJson>(s, { blocks: [] });
  },

  parseScope(s: string | null): RuleScope {
    return safeJson<RuleScope>(s, {});
  },

  parseConditions(s: string | null): RuleConditions {
    return safeJson<RuleConditions>(s, {});
  },

  /** Returns array of error strings; empty = valid. */
  validate(rule: RuleWithSteps): string[] {
    const errors: string[] = [];
    if (!rule.name?.trim()) errors.push('name_required');
    if (!rule.triggerType) errors.push('trigger_required');
    if (!rule.steps.length) errors.push('at_least_one_step_required');
    rule.steps.forEach((s, i) => {
      if (s.delayValue == null || s.delayValue < 0) errors.push(`step_${i + 1}_invalid_delay`);
      const seq = safeJson<MessageSequenceJson>(s.messageSequence, { blocks: [] });
      if (!seq.blocks?.length) errors.push(`step_${i + 1}_no_blocks`);
      else {
        const hasEnabled = seq.blocks.some((b) => b.enabled !== false);
        if (!hasEnabled) errors.push(`step_${i + 1}_all_blocks_disabled`);
      }
    });
    return errors;
  },

  /** Convert delay (value, unit) → milliseconds. */
  delayToMs(value: number, unit: DelayUnit): number {
    switch (unit) {
      case 'minutes': return value * 60_000;
      case 'hours':   return value * 60 * 60_000;
      case 'days':    return value * 24 * 60 * 60_000;
      default: return value * 60_000;
    }
  },
};
