import { Router } from 'express';
import { z } from 'zod';
import { CampaignService } from '../../services/CampaignService.js';
import { CampaignEngine } from '../../services/CampaignEngine.js';

export const retargetingRouter = Router();

const Schema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullish(),
  segmentId: z.string().min(1),
  accountId: z.string().min(1),
  messageSequence: z.object({ blocks: z.array(z.any()) }),
  scheduleAt: z.string().datetime().nullish(),
  sendingSpeed: z.object({
    perMinute: z.number().int().min(1).max(120).optional(),
    perHour: z.number().int().min(1).max(7200).optional(),
    jitterMs: z.number().int().min(0).max(60000).optional(),
  }).optional(),
  stopConditions: z.object({
    onReply: z.boolean().optional(),
    onOrdered: z.boolean().optional(),
    onRejected: z.boolean().optional(),
    doNotContact: z.boolean().optional(),
    skipIfContactedHours: z.number().int().min(0).max(720).optional(),
  }).optional(),
});

retargetingRouter.get('/campaigns', async (_req, res, next) => {
  try {
    const items = await CampaignService.list();
    res.json(items.map((c) => ({
      ...c,
      messageSequence: CampaignService.parseMessageSequence(c.messageSequence),
      sendingSpeed: CampaignService.parseSendingSpeed(c.sendingSpeed),
      stopConditions: CampaignService.parseStopConditions(c.stopConditions),
    })));
  } catch (e) { next(e); }
});

retargetingRouter.get('/campaigns/:id', async (req, res, next) => {
  try {
    const c = await CampaignService.get(req.params.id);
    if (!c) return res.status(404).json({ error: 'not_found' });
    res.json({
      ...c,
      messageSequence: CampaignService.parseMessageSequence(c.messageSequence),
      sendingSpeed: CampaignService.parseSendingSpeed(c.sendingSpeed),
      stopConditions: CampaignService.parseStopConditions(c.stopConditions),
    });
  } catch (e) { next(e); }
});

retargetingRouter.post('/campaigns', async (req, res, next) => {
  try {
    const data = Schema.parse(req.body);
    res.status(201).json(await CampaignService.create({
      name: data.name,
      description: data.description ?? undefined,
      segmentId: data.segmentId,
      accountId: data.accountId,
      messageSequence: data.messageSequence as any,
      scheduleAt: data.scheduleAt ? new Date(data.scheduleAt) : undefined,
      sendingSpeed: data.sendingSpeed,
      stopConditions: data.stopConditions,
    }));
  } catch (e) { next(e); }
});

retargetingRouter.put('/campaigns/:id', async (req, res, next) => {
  try {
    const data = Schema.partial().parse(req.body);
    const patch: any = { ...data };
    if (data.scheduleAt !== undefined) patch.scheduleAt = data.scheduleAt ? new Date(data.scheduleAt) : null;
    res.json(await CampaignService.update(req.params.id, patch));
  } catch (e) { next(e); }
});

retargetingRouter.delete('/campaigns/:id', async (req, res, next) => {
  try { await CampaignService.remove(req.params.id); res.json({ ok: true }); }
  catch (e) { next(e); }
});

retargetingRouter.post('/campaigns/:id/preview', async (req, res, next) => {
  try { res.json(await CampaignService.preview(req.params.id)); }
  catch (e) { next(e); }
});

retargetingRouter.post('/campaigns/:id/start', async (req, res, next) => {
  try {
    const result = await CampaignService.start(req.params.id);
    CampaignEngine.start(req.params.id);
    res.json(result);
  } catch (e) { next(e); }
});

retargetingRouter.post('/campaigns/:id/pause', async (req, res, next) => {
  try {
    await CampaignService.pause(req.params.id);
    CampaignEngine.stop(req.params.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

retargetingRouter.post('/campaigns/:id/resume', async (req, res, next) => {
  try {
    await CampaignService.resume(req.params.id);
    CampaignEngine.start(req.params.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

retargetingRouter.post('/campaigns/:id/cancel', async (req, res, next) => {
  try {
    await CampaignService.cancel(req.params.id);
    CampaignEngine.stop(req.params.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

retargetingRouter.get('/campaigns/:id/stats', async (req, res, next) => {
  try { res.json(await CampaignService.stats(req.params.id)); }
  catch (e) { next(e); }
});

retargetingRouter.get('/campaigns/:id/recipients', async (req, res, next) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    res.json(await CampaignService.listRecipients(req.params.id, {
      status: q.status, take: q.take ? +q.take : 100, skip: q.skip ? +q.skip : 0,
    }));
  } catch (e) { next(e); }
});
