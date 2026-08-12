import { Router } from 'express';
import { z } from 'zod';
import { BotTestService } from '../../services/BotTestService.js';

export const testsRouter = Router();

testsRouter.post('/bots/:botId/test/start', async (req, res, next) => {
  try {
    const sessionId = await BotTestService.start(req.params.botId);
    res.json({ sessionId });
  } catch (e) { next(e); }
});

const MsgSchema = z.object({ sessionId: z.string().min(1), text: z.string().min(1).max(2000) });
testsRouter.post('/bots/:botId/test/message', async (req, res, next) => {
  try {
    const { sessionId, text } = MsgSchema.parse(req.body);
    const items = await BotTestService.receive(sessionId, text);
    res.json({ items });
  } catch (e) { next(e); }
});

testsRouter.post('/bots/:botId/test/reset', async (req, res, next) => {
  try {
    const { sessionId } = z.object({ sessionId: z.string().min(1) }).parse(req.body);
    BotTestService.reset(sessionId);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
