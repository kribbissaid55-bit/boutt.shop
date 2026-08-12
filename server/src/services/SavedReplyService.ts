/**
 * SavedReplyService — CRUD + shortcut resolver for inbox templates.
 *
 * Shortcuts are like Slack snippets: typing `/price` in the composer
 * resolves to the saved reply. Stored without the leading slash.
 */
import { prisma } from '../lib/prisma.js';

const parseMediaIds = (s: string | null): string[] => {
  if (!s) return [];
  try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch { return []; }
};

const stringifyMediaIds = (ids: string[] | null | undefined): string | null => {
  if (!ids || !ids.length) return null;
  return JSON.stringify(ids);
};

const normalizeShortcut = (s: string | null | undefined): string | null => {
  if (!s) return null;
  const trimmed = s.trim().toLowerCase();
  if (!trimmed) return null;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
};

export const SavedReplyService = {
  list(opts: { activeOnly?: boolean; category?: string; search?: string } = {}) {
    const where: any = {};
    if (opts.activeOnly) where.isActive = true;
    if (opts.category) where.category = opts.category;
    if (opts.search) {
      where.OR = [
        { title:    { contains: opts.search } },
        { text:     { contains: opts.search } },
        { shortcut: { contains: opts.search } },
      ];
    }
    return prisma.savedReply.findMany({
      where,
      orderBy: [{ category: 'asc' }, { title: 'asc' }],
    });
  },

  async create(data: {
    title: string;
    text?: string;
    category?: string;
    shortcut?: string;
    mediaIds?: string[];
    isActive?: boolean;
    tags?: string;
  }) {
    return prisma.savedReply.create({
      data: {
        title: data.title.trim(),
        text: data.text ?? null,
        category: data.category ?? null,
        shortcut: normalizeShortcut(data.shortcut),
        mediaIds: stringifyMediaIds(data.mediaIds),
        isActive: data.isActive ?? true,
        tags: data.tags ?? null,
      },
    });
  },

  async update(id: string, data: Partial<{
    title: string;
    text: string | null;
    category: string | null;
    shortcut: string | null;
    mediaIds: string[];
    isActive: boolean;
    tags: string | null;
  }>) {
    const patch: any = { ...data };
    if (data.shortcut !== undefined) patch.shortcut = normalizeShortcut(data.shortcut);
    if (data.mediaIds !== undefined) patch.mediaIds = stringifyMediaIds(data.mediaIds);
    return prisma.savedReply.update({ where: { id }, data: patch });
  },

  remove(id: string) {
    return prisma.savedReply.delete({ where: { id } });
  },

  /** Resolve a shortcut (e.g. "/price") to its saved reply, or null if not found / inactive. */
  async resolveShortcut(shortcut: string) {
    const norm = normalizeShortcut(shortcut);
    if (!norm) return null;
    const r = await prisma.savedReply.findUnique({ where: { shortcut: norm } });
    if (!r || !r.isActive) return null;
    return { ...r, mediaIds: parseMediaIds(r.mediaIds) };
  },

  /** Convenience for the inbox composer typeahead. */
  async searchByPrefix(prefix: string, limit = 8) {
    const norm = normalizeShortcut(prefix);
    const items = await prisma.savedReply.findMany({
      where: {
        isActive: true,
        OR: norm ? [
          { shortcut: { startsWith: norm } },
          { title: { contains: prefix.replace(/^\//, '') } },
        ] : [{ title: { contains: prefix } }],
      },
      orderBy: [{ shortcut: 'asc' }, { title: 'asc' }],
      take: limit,
    });
    return items.map((r) => ({ ...r, mediaIds: parseMediaIds(r.mediaIds) }));
  },
};
