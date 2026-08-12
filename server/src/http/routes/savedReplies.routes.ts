import { Router } from 'express';
import { z } from 'zod';
import { SavedReplyService } from '../../services/SavedReplyService.js';

export const savedRepliesRouter = Router();

savedRepliesRouter.get('/', async (req, res, next) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    res.json(await SavedReplyService.list({
      activeOnly: q.active === 'true',
      category: q.category,
      search: q.search,
    }));
  } catch (e) { next(e); }
});

const Schema = z.object({
  title: z.string().min(1).max(120),
  text: z.string().max(4096).nullish(),
  category: z.string().max(80).nullish(),
  shortcut: z.string().max(60).nullish(),
  mediaIds: z.array(z.string().min(1)).max(20).optional(),
  isActive: z.boolean().optional(),
  tags: z.string().nullish(),
});

savedRepliesRouter.post('/', async (req, res, next) => {
  try {
    const data = Schema.parse(req.body);
    res.status(201).json(await SavedReplyService.create({
      title: data.title,
      text: data.text ?? undefined,
      category: data.category ?? undefined,
      shortcut: data.shortcut ?? undefined,
      mediaIds: data.mediaIds,
      isActive: data.isActive,
      tags: data.tags ?? undefined,
    }));
  } catch (e) { next(e); }
});

const PatchSchema = Schema.partial();
savedRepliesRouter.put('/:id', async (req, res, next) => {
  try {
    const data = PatchSchema.parse(req.body);
    res.json(await SavedReplyService.update(req.params.id, data as any));
  } catch (e) { next(e); }
});
savedRepliesRouter.patch('/:id', async (req, res, next) => {
  try {
    const data = PatchSchema.parse(req.body);
    res.json(await SavedReplyService.update(req.params.id, data as any));
  } catch (e) { next(e); }
});

savedRepliesRouter.delete('/:id', async (req, res, next) => {
  try { await SavedReplyService.remove(req.params.id); res.json({ ok: true }); }
  catch (e) { next(e); }
});

// Composer typeahead — accepts `?prefix=/pri`
savedRepliesRouter.get('/typeahead', async (req, res, next) => {
  try {
    const prefix = (req.query.prefix as string) ?? '';
    if (!prefix) return res.json([]);
    res.json(await SavedReplyService.searchByPrefix(prefix));
  } catch (e) { next(e); }
});

// Resolve a single shortcut
savedRepliesRouter.get('/resolve/:shortcut', async (req, res, next) => {
  try {
    const r = await SavedReplyService.resolveShortcut(req.params.shortcut);
    if (!r) return res.status(404).json({ error: 'not_found' });
    res.json(r);
  } catch (e) { next(e); }
});
