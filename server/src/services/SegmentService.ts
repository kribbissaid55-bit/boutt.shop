/**
 * SegmentService — saved customer filters.
 *
 * Filter DSL (JSON):
 *   { all: [ { field, op, value }, … ] }
 * Supported ops: eq, neq, in, not_in, contains_any, older_than_hours,
 *                younger_than_hours, between, exists.
 *
 * The compiler translates the DSL to a Prisma `where` for Contact queries.
 * Unknown ops/fields fail loud so segments don't silently match nothing.
 */
import { prisma } from '../lib/prisma.js';

export type FilterOp =
  | 'eq' | 'neq' | 'in' | 'not_in' | 'contains_any'
  | 'older_than_hours' | 'younger_than_hours' | 'between' | 'exists';

export interface FilterClause {
  field: string;
  op: FilterOp;
  value?: any;
}

export interface FilterDSL {
  all?: FilterClause[];
  any?: FilterClause[];
}

/** Fields we know how to translate to Contact's Prisma where. */
const SCALAR_FIELDS = new Set([
  'status', 'accountId', 'city', 'source', 'campaignName',
  'doNotContact', 'botPaused', 'importBatchId',
]);
const DATE_FIELDS = new Set([
  'firstMessageAt', 'lastIncomingMessageAt', 'lastOutgoingMessageAt',
  'lastInteractionAt', 'createdAt',
]);
const ARRAY_JSON_FIELDS = new Set(['tags']);

function compileClause(c: FilterClause): any {
  const { field, op, value } = c;

  if (ARRAY_JSON_FIELDS.has(field)) {
    if (op === 'contains_any') {
      const vs: string[] = Array.isArray(value) ? value : [value];
      return { OR: vs.map((v) => ({ [field]: { contains: `"${v}"` } })) };
    }
    if (op === 'exists') return { [field]: value ? { not: null } : null };
    throw new Error(`unsupported_op_for_field:${field}:${op}`);
  }

  if (DATE_FIELDS.has(field)) {
    if (op === 'older_than_hours') {
      const cutoff = new Date(Date.now() - Number(value) * 3_600_000);
      return { [field]: { lt: cutoff } };
    }
    if (op === 'younger_than_hours') {
      const cutoff = new Date(Date.now() - Number(value) * 3_600_000);
      return { [field]: { gte: cutoff } };
    }
    if (op === 'between') {
      const [from, to] = value as [string, string];
      return { [field]: { gte: new Date(from), lte: new Date(to) } };
    }
    if (op === 'exists') return { [field]: value ? { not: null } : null };
    throw new Error(`unsupported_op_for_date:${field}:${op}`);
  }

  if (SCALAR_FIELDS.has(field)) {
    switch (op) {
      case 'eq':     return { [field]: value };
      case 'neq':    return { [field]: { not: value } };
      case 'in':     return { [field]: { in: Array.isArray(value) ? value : [value] } };
      case 'not_in': return { [field]: { notIn: Array.isArray(value) ? value : [value] } };
      case 'exists': return { [field]: value ? { not: null } : null };
      default: throw new Error(`unsupported_op_for_scalar:${field}:${op}`);
    }
  }

  // Special composite: hasOrder
  if (field === 'hasOrder') {
    if (op === 'eq') {
      return value
        ? { orders: { some: { status: 'confirmed' } } }
        : { orders: { none: { status: 'confirmed' } } };
    }
    throw new Error(`unsupported_op_for_hasOrder:${op}`);
  }

  throw new Error(`unknown_field:${field}`);
}

export const SegmentService = {
  list() {
    return prisma.customerSegment.findMany({ orderBy: { createdAt: 'desc' } });
  },

  get(id: string) {
    return prisma.customerSegment.findUnique({ where: { id } });
  },

  create(data: { name: string; description?: string; filters: FilterDSL }) {
    return prisma.customerSegment.create({
      data: {
        name: data.name.trim(),
        description: data.description ?? null,
        filters: JSON.stringify(data.filters),
      },
    });
  },

  update(id: string, data: Partial<{ name: string; description: string | null; filters: FilterDSL }>) {
    const patch: any = {};
    if (data.name !== undefined) patch.name = data.name.trim();
    if (data.description !== undefined) patch.description = data.description;
    if (data.filters !== undefined) patch.filters = JSON.stringify(data.filters);
    return prisma.customerSegment.update({ where: { id }, data: patch });
  },

  remove(id: string) {
    return prisma.customerSegment.delete({ where: { id } });
  },

  async duplicate(id: string) {
    const src = await prisma.customerSegment.findUnique({ where: { id } });
    if (!src) return null;
    return prisma.customerSegment.create({
      data: { name: src.name + ' (copy)', description: src.description, filters: src.filters },
    });
  },

  /** Compile a DSL to a Prisma `where`. Throws if any clause is invalid. */
  compile(dsl: FilterDSL): any {
    const all = (dsl.all ?? []).map(compileClause);
    const any = (dsl.any ?? []).map(compileClause);
    const where: any = {};
    if (all.length) where.AND = all;
    if (any.length) where.OR = any;
    return where;
  },

  parseFilters(s: string | null): FilterDSL {
    if (!s) return { all: [] };
    try { return JSON.parse(s); } catch { return { all: [] }; }
  },

  async preview(id: string, opts: { take?: number; skip?: number } = {}) {
    const seg = await prisma.customerSegment.findUnique({ where: { id } });
    if (!seg) throw Object.assign(new Error('not_found'), { status: 404 });
    const dsl = this.parseFilters(seg.filters);
    const where = this.compile(dsl);
    const [items, total] = await Promise.all([
      prisma.contact.findMany({
        where,
        include: { account: { select: { id: true, name: true } } },
        orderBy: [{ lastInteractionAt: 'desc' }],
        take: Math.min(500, opts.take ?? 50),
        skip: opts.skip ?? 0,
      }),
      prisma.contact.count({ where }),
    ]);
    return { items, total };
  },

  async previewDsl(dsl: FilterDSL, opts: { take?: number; skip?: number } = {}) {
    const where = this.compile(dsl);
    const [items, total] = await Promise.all([
      prisma.contact.findMany({
        where,
        include: { account: { select: { id: true, name: true } } },
        orderBy: [{ lastInteractionAt: 'desc' }],
        take: Math.min(500, opts.take ?? 50),
        skip: opts.skip ?? 0,
      }),
      prisma.contact.count({ where }),
    ]);
    return { items, total };
  },

  /** Resolve the contact-id list for a segment (used by CampaignService.start). */
  async resolveContactIds(segmentId: string, limit?: number): Promise<string[]> {
    const seg = await prisma.customerSegment.findUnique({ where: { id: segmentId } });
    if (!seg) throw Object.assign(new Error('segment_not_found'), { status: 404 });
    const where = this.compile(this.parseFilters(seg.filters));
    const items = await prisma.contact.findMany({
      where, select: { id: true },
      ...(limit ? { take: limit } : {}),
    });
    return items.map((c) => c.id);
  },
};
