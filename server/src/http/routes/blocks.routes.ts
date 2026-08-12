import { Router } from 'express';
import { z } from 'zod';
import { MessageBlockService } from '../../services/MessageBlockService.js';

export const blocksRouter = Router();

const BLOCK_TYPES = ['text', 'audio', 'image', 'video', 'document', 'delay', 'options', 'action'] as const;
const ACTION_TYPES = [
  'set_status', 'add_tag', 'pause_bot', 'resume_bot',
  'mark_needs_human', 'end_conversation', 'notify_admin',
  'start_order_collection', 'confirm_order',
] as const;

const CreateSchema = z.object({
  type: z.enum(BLOCK_TYPES),
  content: z.string().max(8000).nullish(),
  mediaId: z.string().nullish(),
  caption: z.string().max(1024).nullish(),
  delaySeconds: z.number().int().min(0).max(600).nullish(),
  actionType: z.enum(ACTION_TYPES).nullish(),
  actionPayload: z.any().optional(),
  enabled: z.boolean().optional(),
  metadata: z.any().optional(),
});

blocksRouter.post('/steps/:stepId/blocks', async (req, res, next) => {
  try {
    const data = CreateSchema.parse(req.body);
    res.status(201).json(await MessageBlockService.create(req.params.stepId, data));
  } catch (e) { next(e); }
});

const PatchSchema = CreateSchema.partial();
blocksRouter.put('/blocks/:id', async (req, res, next) => {
  try {
    const data = PatchSchema.parse(req.body);
    res.json(await MessageBlockService.update(req.params.id, data));
  } catch (e) { next(e); }
});
blocksRouter.patch('/blocks/:id', async (req, res, next) => {
  try {
    const data = PatchSchema.parse(req.body);
    res.json(await MessageBlockService.update(req.params.id, data));
  } catch (e) { next(e); }
});

blocksRouter.delete('/blocks/:id', async (req, res, next) => {
  try { await MessageBlockService.remove(req.params.id); res.json({ ok: true }); }
  catch (e) { next(e); }
});

const ReorderSchema = z.object({ stepId: z.string().min(1), ids: z.array(z.string().min(1)) });
blocksRouter.post('/blocks/reorder', async (req, res, next) => {
  try {
    const { stepId, ids } = ReorderSchema.parse(req.body);
    res.json(await MessageBlockService.reorder(stepId, ids));
  } catch (e) { next(e); }
});
