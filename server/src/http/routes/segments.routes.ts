import { Router } from 'express';
import { z } from 'zod';
import { SegmentService } from '../../services/SegmentService.js';

export const segmentsRouter = Router();

const Filter = z.object({
  field: z.string().min(1).max(40),
  op: z.enum(['eq', 'neq', 'in', 'not_in', 'contains_any', 'older_than_hours', 'younger_than_hours', 'between', 'exists']),
  // `z.any()` would make this optional in the inferred type; use unknown + transform
  // to keep it required so it lines up with FilterClause.
  value: z.unknown(),
});
const DSL = z.object({
  all: z.array(Filter).optional(),
  any: z.array(Filter).optional(),
});
const Schema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullish(),
  filters: DSL,
});

segmentsRouter.get('/', async (_req, res, next) => {
  try {
    const items = await SegmentService.list();
    res.json(items.map((s) => ({ ...s, filters: SegmentService.parseFilters(s.filters) })));
  } catch (e) { next(e); }
});

segmentsRouter.get('/:id', async (req, res, next) => {
  try {
    const s = await SegmentService.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not_found' });
    res.json({ ...s, filters: SegmentService.parseFilters(s.filters) });
  } catch (e) { next(e); }
});

segmentsRouter.post('/', async (req, res, next) => {
  try {
    const data = Schema.parse(req.body);
    res.status(201).json(await SegmentService.create({
      name: data.name,
      description: data.description ?? undefined,
      filters: data.filters,
    }));
  } catch (e) { next(e); }
});

segmentsRouter.put('/:id', async (req, res, next) => {
  try {
    const data = Schema.partial().parse(req.body);
    res.json(await SegmentService.update(req.params.id, data as any));
  } catch (e) { next(e); }
});

segmentsRouter.delete('/:id', async (req, res, next) => {
  try { await SegmentService.remove(req.params.id); res.json({ ok: true }); }
  catch (e) { next(e); }
});

segmentsRouter.post('/:id/duplicate', async (req, res, next) => {
  try {
    const dup = await SegmentService.duplicate(req.params.id);
    if (!dup) return res.status(404).json({ error: 'not_found' });
    res.status(201).json(dup);
  } catch (e) { next(e); }
});

segmentsRouter.post('/:id/preview', async (req, res, next) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    res.json(await SegmentService.preview(req.params.id, {
      take: q.take ? +q.take : 50, skip: q.skip ? +q.skip : 0,
    }));
  } catch (e) { next(e); }
});

// Live preview while building (DSL not yet saved)
const DslOnly = z.object({ filters: DSL });
segmentsRouter.post('/preview-dsl', async (req, res, next) => {
  try {
    const { filters } = DslOnly.parse(req.body);
    const q = req.query as Record<string, string | undefined>;
    res.json(await SegmentService.previewDsl(filters, {
      take: q.take ? +q.take : 50, skip: q.skip ? +q.skip : 0,
    }));
  } catch (e: any) {
    // Compile errors → 400 with the reason so the UI can show it
    if (typeof e?.message === 'string' && /^(unknown_field|unsupported_op|unsupported_op_for_)/.test(e.message)) {
      return res.status(400).json({ error: 'invalid_filter', reason: e.message });
    }
    next(e);
  }
});
