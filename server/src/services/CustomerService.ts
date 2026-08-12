/**
 * CustomerService — table queries + bulk updates for the Customers page.
 *
 * Reuses the same Contact model as the inbox; adds richer filtering and a
 * bulk-update helper that's transactional. Keeps phone/JID conversions
 * delegated to phone.ts.
 */
import { prisma } from '../lib/prisma.js';
import type { Prisma } from '@prisma/client';

const parseTags = (s: string | null): string[] => {
  if (!s) return [];
  try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch { return []; }
};
const writeTags = (a: string[]): string => JSON.stringify(Array.from(new Set(a)));

export interface CustomerFilters {
  accountId?: string;
  status?: string;
  tag?: string;
  city?: string;
  source?: string;
  campaignName?: string;
  importBatchId?: string;
  doNotContact?: boolean;
  hasOrder?: boolean;
  noReplyHours?: number;       // contacts whose lastIncomingMessageAt is null OR older than X hours
  followUpDue?: boolean;       // there exists a pending FollowUpLog for the contact
  search?: string;
  dateFrom?: Date;             // createdAt >= dateFrom
  dateTo?: Date;
}

const compileWhere = (f: CustomerFilters): Prisma.ContactWhereInput => {
  const where: Prisma.ContactWhereInput = {};
  if (f.accountId) where.accountId = f.accountId;
  if (f.status) where.status = f.status;
  if (f.city) where.city = f.city;
  if (f.source) where.source = f.source;
  if (f.campaignName) where.campaignName = f.campaignName;
  if (f.importBatchId) where.importBatchId = f.importBatchId;
  if (f.doNotContact !== undefined) where.doNotContact = f.doNotContact;
  if (f.tag) where.tags = { contains: `"${f.tag}"` };
  if (f.search) {
    const s = f.search.trim();
    where.OR = [
      { name:    { contains: s } },
      { jid:     { contains: s } },
      { city:    { contains: s } },
      { address: { contains: s } },
      { notes:   { contains: s } },
    ];
  }
  if (f.dateFrom || f.dateTo) {
    where.createdAt = {};
    if (f.dateFrom) (where.createdAt as any).gte = f.dateFrom;
    if (f.dateTo)   (where.createdAt as any).lte = f.dateTo;
  }
  if (f.noReplyHours !== undefined) {
    const cutoff = new Date(Date.now() - f.noReplyHours * 3600 * 1000);
    where.OR = [
      ...(where.OR ?? []),
      { lastIncomingMessageAt: null },
      { lastIncomingMessageAt: { lt: cutoff } },
    ];
  }
  if (f.hasOrder !== undefined) {
    if (f.hasOrder) where.orders = { some: { status: 'confirmed' } };
    else where.orders = { none: { status: 'confirmed' } };
  }
  if (f.followUpDue) {
    where.followUpLogs = { some: { status: 'pending', scheduledAt: { lte: new Date() } } };
  }
  return where;
};

export const CustomerService = {
  compileWhere,

  async list(filters: CustomerFilters & { take?: number; skip?: number }) {
    const { take = 50, skip = 0, ...f } = filters;
    const where = compileWhere(f);
    const [items, total] = await Promise.all([
      prisma.contact.findMany({
        where,
        include: {
          account: { select: { id: true, name: true } },
          _count: { select: { messages: true, orders: true } },
        },
        orderBy: [{ lastInteractionAt: 'desc' }, { createdAt: 'desc' }],
        take, skip,
      }),
      prisma.contact.count({ where }),
    ]);
    return {
      items: items.map((c) => ({ ...c, tags: parseTags(c.tags) })),
      total,
      take, skip,
    };
  },

  async count(filters: CustomerFilters) {
    return prisma.contact.count({ where: compileWhere(filters) });
  },

  async ids(filters: CustomerFilters, limit?: number): Promise<string[]> {
    const items = await prisma.contact.findMany({
      where: compileWhere(filters),
      select: { id: true },
      orderBy: [{ lastInteractionAt: 'desc' }, { createdAt: 'desc' }],
      ...(limit ? { take: limit } : {}),
    });
    return items.map((c) => c.id);
  },

  async bulkUpdate(ids: string[], patch: {
    status?: string;
    tagsAdd?: string[];
    tagsRemove?: string[];
    botPaused?: boolean;
    doNotContact?: boolean;
    accountId?: string;
    city?: string;
    source?: string;
  }): Promise<{ updated: number }> {
    if (!ids.length) return { updated: 0 };

    // Tags need read-modify-write per row; the rest can be a single updateMany.
    if (patch.tagsAdd?.length || patch.tagsRemove?.length) {
      const targets = await prisma.contact.findMany({
        where: { id: { in: ids } },
        select: { id: true, tags: true },
      });
      await prisma.$transaction(
        targets.map((c) => {
          let next = parseTags(c.tags);
          if (patch.tagsAdd) next = Array.from(new Set([...next, ...patch.tagsAdd]));
          if (patch.tagsRemove) next = next.filter((t) => !patch.tagsRemove!.includes(t));
          return prisma.contact.update({
            where: { id: c.id },
            data: { tags: next.length ? writeTags(next) : null },
          });
        })
      );
    }

    const directs: any = {};
    if (patch.status !== undefined) directs.status = patch.status;
    if (patch.botPaused !== undefined) directs.botPaused = patch.botPaused;
    if (patch.doNotContact !== undefined) directs.doNotContact = patch.doNotContact;
    if (patch.accountId !== undefined) directs.accountId = patch.accountId;
    if (patch.city !== undefined) directs.city = patch.city;
    if (patch.source !== undefined) directs.source = patch.source;

    if (Object.keys(directs).length) {
      const r = await prisma.contact.updateMany({ where: { id: { in: ids } }, data: directs });
      return { updated: r.count };
    }
    return { updated: ids.length };
  },

  async deleteMany(ids: string[]): Promise<{ deleted: number }> {
    if (!ids.length) return { deleted: 0 };
    const r = await prisma.contact.deleteMany({ where: { id: { in: ids } } });
    return { deleted: r.count };
  },
};
