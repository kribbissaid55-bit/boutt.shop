import { Router } from 'express';
import { z } from 'zod';
import { BotOptionService } from '../../services/BotOptionService.js';

export const optionsRouter = Router();

const CreateSchema = z.object({
  label: z.string().min(1).max(200),
  number: z.string().min(1).max(10),
  keywords: z.array(z.string().min(1).max(80)).nullish(),
  targetStepId: z.string().nullish(),
  description: z.string().max(500).nullish(),
  enabled: z.boolean().optional(),
  displayMode: z.enum(['numbered', 'buttons', 'list', 'auto']).optional(),
});

optionsRouter.post('/steps/:stepId/options', async (req, res, next) => {
  try {
    const data = CreateSchema.parse(req.body);
    res.status(201).json(await BotOptionService.create(req.params.stepId, data));
  } catch (e) { next(e); }
});

const PatchSchema = CreateSchema.partial();
optionsRouter.put('/options/:id', async (req, res, next) => {
  try {
    const data = PatchSchema.parse(req.body);
    res.json(await BotOptionService.update(req.params.id, data));
  } catch (e) { next(e); }
});
optionsRouter.patch('/options/:id', async (req, res, next) => {
  try {
    const data = PatchSchema.parse(req.body);
    res.json(await BotOptionService.update(req.params.id, data));
  } catch (e) { next(e); }
});

optionsRouter.delete('/options/:id', async (req, res, next) => {
  try { await BotOptionService.remove(req.params.id); res.json({ ok: true }); }
  catch (e) { next(e); }
});

const ReorderSchema = z.object({ stepId: z.string().min(1), ids: z.array(z.string().min(1)) });
optionsRouter.post('/options/reorder', async (req, res, next) => {
  try {
    const { stepId, ids } = ReorderSchema.parse(req.body);
    res.json(await BotOptionService.reorder(stepId, ids));
  } catch (e) { next(e); }
});
