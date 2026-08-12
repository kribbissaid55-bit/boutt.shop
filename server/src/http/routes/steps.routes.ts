import { Router } from 'express';
import { z } from 'zod';
import { BotStepService } from '../../services/BotStepService.js';

export const stepsRouter = Router();

const STEP_TYPES = ['welcome', 'keyword', 'exact_match', 'option_reply', 'fallback', 'handover', 'order', 'normal', 'end'] as const;

const CreateSchema = z.object({
  title: z.string().min(1).max(120),
  type: z.enum(STEP_TYPES),
  triggerType: z.string().max(40).optional(),
  triggerValue: z.string().max(500).nullish(),
  description: z.string().max(500).nullish(),
  isActive: z.boolean().optional(),
  settings: z.any().optional(),
});

stepsRouter.get('/bots/:botId/steps', async (req, res, next) => {
  try { res.json(await BotStepService.list(req.params.botId)); } catch (e) { next(e); }
});

stepsRouter.post('/bots/:botId/steps', async (req, res, next) => {
  try {
    const data = CreateSchema.parse(req.body);
    res.status(201).json(await BotStepService.create(req.params.botId, data));
  } catch (e) { next(e); }
});

const PatchSchema = CreateSchema.partial();
stepsRouter.put('/steps/:id', async (req, res, next) => {
  try {
    const data = PatchSchema.parse(req.body);
    res.json(await BotStepService.update(req.params.id, data));
  } catch (e) { next(e); }
});
stepsRouter.patch('/steps/:id', async (req, res, next) => {
  try {
    const data = PatchSchema.parse(req.body);
    res.json(await BotStepService.update(req.params.id, data));
  } catch (e) { next(e); }
});

stepsRouter.delete('/steps/:id', async (req, res, next) => {
  try { await BotStepService.remove(req.params.id); res.json({ ok: true }); }
  catch (e) { next(e); }
});

stepsRouter.post('/steps/:id/duplicate', async (req, res, next) => {
  try { res.status(201).json(await BotStepService.duplicate(req.params.id)); }
  catch (e) { next(e); }
});

const ReorderSchema = z.object({ botId: z.string().min(1), ids: z.array(z.string().min(1)) });
stepsRouter.post('/steps/reorder', async (req, res, next) => {
  try {
    const { botId, ids } = ReorderSchema.parse(req.body);
    res.json(await BotStepService.reorder(botId, ids));
  } catch (e) { next(e); }
});
