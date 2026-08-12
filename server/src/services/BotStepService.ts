/**
 * BotStepService — CRUD + reorder + duplicate (deep clone of blocks & options).
 */
import { prisma } from '../lib/prisma.js';

export type StepType =
  | 'welcome' | 'keyword' | 'exact_match' | 'option_reply'
  | 'fallback' | 'handover' | 'order' | 'normal' | 'end';

export const BotStepService = {
  list(botId: string) {
    return prisma.botStep.findMany({
      where: { botId },
      orderBy: { sortOrder: 'asc' },
      include: {
        blocks: { orderBy: { sortOrder: 'asc' }, include: { media: true } },
        options: { orderBy: { sortOrder: 'asc' } },
      },
    });
  },

  async create(botId: string, data: {
    title: string; type: StepType;
    triggerType?: string; triggerValue?: string | null;
    description?: string | null; isActive?: boolean;
    settings?: any;
  }) {
    const last = await prisma.botStep.findFirst({
      where: { botId }, orderBy: { sortOrder: 'desc' },
    });
    return prisma.botStep.create({
      data: {
        botId,
        title: data.title,
        description: data.description,
        type: data.type,
        triggerType: data.triggerType ?? deriveTriggerType(data.type),
        triggerValue: data.triggerValue,
        isActive: data.isActive ?? true,
        sortOrder: (last?.sortOrder ?? -1) + 1,
        settings: data.settings ? JSON.stringify(data.settings) : null,
      },
    });
  },

  update(id: string, data: Partial<{
    title: string; description: string | null; type: StepType;
    triggerType: string; triggerValue: string | null;
    isActive: boolean; settings: any;
  }>) {
    return prisma.botStep.update({
      where: { id },
      data: {
        ...data,
        settings: data.settings === undefined ? undefined :
                  data.settings === null ? null : JSON.stringify(data.settings),
      },
    });
  },

  remove(id: string) {
    return prisma.botStep.delete({ where: { id } });
  },

  async reorder(botId: string, ids: string[]) {
    await prisma.$transaction(
      ids.map((id, i) =>
        prisma.botStep.update({ where: { id }, data: { sortOrder: i } })
      )
    );
    return this.list(botId);
  },

  async duplicate(stepId: string) {
    const src = await prisma.botStep.findUnique({
      where: { id: stepId },
      include: { blocks: true, options: true },
    });
    if (!src) throw Object.assign(new Error('step not found'), { status: 404 });

    const last = await prisma.botStep.findFirst({
      where: { botId: src.botId }, orderBy: { sortOrder: 'desc' },
    });

    return prisma.$transaction(async (tx) => {
      const copy = await tx.botStep.create({
        data: {
          botId: src.botId,
          title: src.title + ' (copy)',
          description: src.description,
          type: src.type,
          triggerType: src.triggerType,
          triggerValue: src.triggerValue,
          isActive: src.isActive,
          sortOrder: (last?.sortOrder ?? -1) + 1,
          settings: src.settings,
        },
      });
      for (const b of src.blocks) {
        await tx.messageBlock.create({
          data: {
            stepId: copy.id, type: b.type, content: b.content, mediaId: b.mediaId,
            caption: b.caption, delaySeconds: b.delaySeconds, actionType: b.actionType,
            actionPayload: b.actionPayload, enabled: b.enabled, sortOrder: b.sortOrder,
            metadata: b.metadata,
          },
        });
      }
      // options' targetStepId still points to the originals — that's the right behavior
      for (const o of src.options) {
        await tx.botOption.create({
          data: {
            stepId: copy.id, label: o.label, number: o.number, keywords: o.keywords,
            targetStepId: o.targetStepId, description: o.description, enabled: o.enabled,
            sortOrder: o.sortOrder, displayMode: o.displayMode,
          },
        });
      }
      return copy;
    });
  },
};

function deriveTriggerType(t: StepType): string {
  switch (t) {
    case 'welcome': return 'welcome';
    case 'fallback': return 'fallback';
    case 'handover': return 'handover';
    case 'keyword': return 'keyword';
    case 'exact_match': return 'exact_match';
    case 'option_reply': return 'option_number';
    default: return 'none';
  }
}
