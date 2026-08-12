import { Router } from 'express';
import { z } from 'zod';
import { WhatsAppSessionService } from '../../services/WhatsAppSessionService.js';

export const accountsRouter = Router();

accountsRouter.get('/', async (_req, res, next) => {
  try { res.json(await WhatsAppSessionService.list()); } catch (e) { next(e); }
});

accountsRouter.get('/:id', async (req, res, next) => {
  try {
    const acc = await WhatsAppSessionService.get(req.params.id);
    if (!acc) return res.status(404).json({ error: 'not_found' });
    const lastQr = WhatsAppSessionService.getLastQr(acc.id);
    res.json({ ...acc, lastQr });
  } catch (e) { next(e); }
});

const CreateSchema = z.object({ name: z.string().min(1).max(80) });
accountsRouter.post('/', async (req, res, next) => {
  try {
    const { name } = CreateSchema.parse(req.body);
    res.status(201).json(await WhatsAppSessionService.create(name));
  } catch (e) { next(e); }
});

const PatchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  ignoreGroups: z.boolean().optional(),
  dailySendCap: z.number().int().min(1).max(10000).optional(),
  proxyUrl: z.string().url().nullable().optional(),
});
accountsRouter.patch('/:id', async (req, res, next) => {
  try {
    res.json(await WhatsAppSessionService.patch(req.params.id, PatchSchema.parse(req.body)));
  } catch (e) { next(e); }
});

accountsRouter.post('/:id/connect', async (req, res, next) => {
  try { await WhatsAppSessionService.connect(req.params.id); res.json({ ok: true }); }
  catch (e) { next(e); }
});

accountsRouter.post('/:id/disconnect', async (req, res, next) => {
  try { await WhatsAppSessionService.disconnect(req.params.id); res.json({ ok: true }); }
  catch (e) { next(e); }
});

accountsRouter.post('/:id/logout', async (req, res, next) => {
  try { await WhatsAppSessionService.logoutAndWipe(req.params.id); res.json({ ok: true }); }
  catch (e) { next(e); }
});

accountsRouter.delete('/:id', async (req, res, next) => {
  try { await WhatsAppSessionService.remove(req.params.id); res.json({ ok: true }); }
  catch (e) { next(e); }
});
