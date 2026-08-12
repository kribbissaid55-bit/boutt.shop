import { prisma } from '../lib/prisma.js';
import { normalizeText } from '../lib/jid.js';

const normalizeKeywords = (kws?: string[] | null): string | null => {
  if (!kws || !kws.length) return null;
  const cleaned = kws.map((s) => normalizeText(s)).filter(Boolean);
  return cleaned.length ? JSON.stringify(cleaned) : null;
};

export const BotOptionService = {
  async create(stepId: string, data: {
    label: string; number: string;
    keywords?: string[] | null;
    targetStepId?: string | null;
    description?: string | null;
    enabled?: boolean;
    displayMode?: 'numbered' | 'buttons' | 'list' | 'auto';
  }) {
    const last = await prisma.botOption.findFirst({
      where: { stepId }, orderBy: { sortOrder: 'desc' },
    });
    return prisma.botOption.create({
      data: {
        stepId,
        label: data.label,
        number: data.number,
        keywords: normalizeKeywords(data.keywords),
        targetStepId: data.targetStepId,
        description: data.description,
        enabled: data.enabled ?? true,
        sortOrder: (last?.sortOrder ?? -1) + 1,
        displayMode: data.displayMode ?? 'numbered',
      },
    });
  },

  update(id: string, data: Partial<{
    label: string; number: string;
    keywords: string[] | null;
    targetStepId: string | null;
    description: string | null;
    enabled: boolean;
    displayMode: 'numbered' | 'buttons' | 'list' | 'auto';
  }>) {
    const patch: any = { ...data };
    if (data.keywords !== undefined) patch.keywords = normalizeKeywords(data.keywords);
    return prisma.botOption.update({ where: { id }, data: patch });
  },

  remove(id: string) {
    return prisma.botOption.delete({ where: { id } });
  },

  async reorder(stepId: string, ids: string[]) {
    await prisma.$transaction(
      ids.map((id, i) =>
        prisma.botOption.update({ where: { id }, data: { sortOrder: i } })
      )
    );
    return prisma.botOption.findMany({ where: { stepId }, orderBy: { sortOrder: 'asc' } });
  },
};
