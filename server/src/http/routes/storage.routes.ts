/**
 * Storage monitor + cleanup API.
 *
 *   GET    /api/storage/status        → current usage + phase + config
 *   POST   /api/storage/cleanup-now   → manual force-cleanup
 *   PATCH  /api/storage/config        → adjust threshold / warning / grace
 */
import { Router } from 'express';
import { z } from 'zod';
import { StorageMonitorService } from '../../services/StorageMonitorService.js';

export const storageRouter = Router();

storageRouter.get('/status', async (_req, res, next) => {
  try {
    res.json(await StorageMonitorService.status());
  } catch (e) { next(e); }
});

storageRouter.post('/cleanup-now', async (_req, res, next) => {
  try {
    const out = await StorageMonitorService.forceCleanup();
    res.json(out);
  } catch (e) { next(e); }
});

const PatchSchema = z.object({
  thresholdGb: z.number().min(1).max(100_000).optional(),
  warningGb: z.number().min(1).max(100_000).optional(),
  gracePeriodDays: z.number().int().min(0).max(90).optional(),
});

storageRouter.patch('/config', async (req, res, next) => {
  try {
    const data = PatchSchema.parse(req.body);
    res.json(await StorageMonitorService.updateConfig(data));
  } catch (e) { next(e); }
});
