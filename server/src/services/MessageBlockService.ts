import { prisma } from '../lib/prisma.js';

export type BlockType = 'text' | 'audio' | 'image' | 'video' | 'document' | 'delay' | 'options' | 'action';

const stringifyJson = (v: unknown) => v === undefined ? undefined : v === null ? null : JSON.stringify(v);

export const MessageBlockService = {
  async create(stepId: string, data: {
    type: BlockType;
    content?: string | null;
    mediaId?: string | null;
    caption?: string | null;
    delaySeconds?: number | null;
    actionType?: string | null;
    actionPayload?: any;
    enabled?: boolean;
    metadata?: any;
  }) {
    const last = await prisma.messageBlock.findFirst({
      where: { stepId }, orderBy: { sortOrder: 'desc' },
    });
    return prisma.messageBlock.create({
      data: {
        stepId,
        type: data.type,
        content: data.content,
        mediaId: data.mediaId,
        caption: data.caption,
        delaySeconds: data.delaySeconds,
        actionType: data.actionType,
        actionPayload: stringifyJson(data.actionPayload),
        enabled: data.enabled ?? true,
        sortOrder: (last?.sortOrder ?? -1) + 1,
        metadata: stringifyJson(data.metadata),
      },
      include: { media: true },
    });
  },

  update(id: string, data: Partial<{
    type: BlockType;
    content: string | null;
    mediaId: string | null;
    caption: string | null;
    delaySeconds: number | null;
    actionType: string | null;
    actionPayload: any;
    enabled: boolean;
    metadata: any;
  }>) {
    return prisma.messageBlock.update({
      where: { id },
      data: {
        ...data,
        actionPayload: stringifyJson(data.actionPayload),
        metadata: stringifyJson(data.metadata),
      },
      include: { media: true },
    });
  },

  remove(id: string) {
    return prisma.messageBlock.delete({ where: { id } });
  },

  async reorder(stepId: string, ids: string[]) {
    await prisma.$transaction(
      ids.map((id, i) =>
        prisma.messageBlock.update({ where: { id }, data: { sortOrder: i } })
      )
    );
    return prisma.messageBlock.findMany({
      where: { stepId },
      orderBy: { sortOrder: 'asc' },
      include: { media: true },
    });
  },
};
