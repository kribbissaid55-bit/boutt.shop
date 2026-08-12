import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { FollowUpRuleService } from '../../services/FollowUpRuleService.js';
import { FollowUpEngine } from '../../services/FollowUpEngine.js';

export const followupRouter = Router();

const TRIGGER = z.enum([
  'no_reply', 'after_first_message', 'after_welcome', 'after_bot_answer',
  'after_option', 'after_status', 'after_admin_reply', 'after_import_batch',
  'after_campaign', 'custom',
]);
const DELAY_UNIT = z.enum(['minutes', 'hours', 'days']);

/* ──── Rules ──── */

followupRouter.get('/rules', async (_req, res, next) => {
  try {
    const rules = await FollowUpRuleService.list();
    res.json(rules.map((r) => ({
      ...r,
      scope: FollowUpRuleService.parseScope(r.scope),
      conditions: FollowUpRuleService.parseConditions(r.conditions),
      steps: r.steps.map((s) => ({
        ...s,
        messageSequence: FollowUpRuleService.parseMessageSequence(s.messageSequence),
        conditions: s.conditions ? JSON.parse(s.conditions) : null,
        stopConditions: s.stopConditions ? JSON.parse(s.stopConditions) : null,
      })),
    })));
  } catch (e) { next(e); }
});

followupRouter.get('/rules/:id', async (req, res, next) => {
  try {
    const r = await FollowUpRuleService.get(req.params.id);
    if (!r) return res.status(404).json({ error: 'not_found' });
    res.json({
      ...r,
      scope: FollowUpRuleService.parseScope(r.scope),
      conditions: FollowUpRuleService.parseConditions(r.conditions),
      steps: r.steps.map((s) => ({
        ...s,
        messageSequence: FollowUpRuleService.parseMessageSequence(s.messageSequence),
        conditions: s.conditions ? JSON.parse(s.conditions) : null,
        stopConditions: s.stopConditions ? JSON.parse(s.stopConditions) : null,
      })),
    });
  } catch (e) { next(e); }
});

const CreateRuleSchema = z.object({
  name: z.string().min(1).max(120),
  triggerType: TRIGGER,
  isActive: z.boolean().optional(),
  accountId: z.string().nullable().optional(),
  botId: z.string().nullable().optional(),
  scope: z.any().optional(),
  conditions: z.any().optional(),
  workingHours: z.any().optional(),
});
followupRouter.post('/rules', async (req, res, next) => {
  try {
    const data = CreateRuleSchema.parse(req.body);
    res.status(201).json(await FollowUpRuleService.create(data));
  } catch (e) { next(e); }
});

const UpdateRuleSchema = CreateRuleSchema.partial();
followupRouter.put('/rules/:id', async (req, res, next) => {
  try {
    const data = UpdateRuleSchema.parse(req.body);
    res.json(await FollowUpRuleService.update(req.params.id, data as any));
  } catch (e) { next(e); }
});
followupRouter.patch('/rules/:id', async (req, res, next) => {
  try {
    const data = UpdateRuleSchema.parse(req.body);
    res.json(await FollowUpRuleService.update(req.params.id, data as any));
  } catch (e) { next(e); }
});

followupRouter.delete('/rules/:id', async (req, res, next) => {
  try { await FollowUpRuleService.remove(req.params.id); res.json({ ok: true }); }
  catch (e) { next(e); }
});

followupRouter.post('/rules/:id/activate', async (req, res, next) => {
  try {
    const rule = await FollowUpRuleService.get(req.params.id);
    if (!rule) return res.status(404).json({ error: 'not_found' });
    // Audience must come from somewhere: either a bot (its linked accounts via
    // BotAccount) or a single legacy account. A rule with neither cannot fire.
    if (!(rule as any).botId && !rule.accountId) {
      return res.status(400).json({ error: 'validation_failed', issues: ['account_or_bot_required'] });
    }
    const errors = FollowUpRuleService.validate(rule);
    if (errors.length) return res.status(400).json({ error: 'validation_failed', issues: errors });
    // activatedAt = now → engine ignores any contact whose lastOutgoingMessageAt is older than this.
    res.json(await FollowUpRuleService.update(req.params.id, {
      isActive: true,
      activatedAt: new Date(),
    }));
  } catch (e) { next(e); }
});

followupRouter.post('/rules/:id/pause', async (req, res, next) => {
  try { res.json(await FollowUpRuleService.update(req.params.id, { isActive: false })); }
  catch (e) { next(e); }
});

followupRouter.post('/rules/:id/run-check', async (_req, res, next) => {
  try {
    await FollowUpEngine.runOnce();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

followupRouter.post('/rules/:id/duplicate', async (req, res, next) => {
  try {
    const dup = await FollowUpRuleService.duplicate(req.params.id);
    if (!dup) return res.status(404).json({ error: 'not_found' });
    res.status(201).json(dup);
  } catch (e) { next(e); }
});

/* ──── Steps ──── */

const AddStepSchema = z.object({
  delayValue: z.number().int().min(0).max(10000),
  delayUnit: DELAY_UNIT,
  messageSequence: z.any().optional(),
  conditions: z.any().optional(),
  stopConditions: z.any().optional(),
});
followupRouter.post('/rules/:ruleId/steps', async (req, res, next) => {
  try {
    const data = AddStepSchema.parse(req.body);
    res.status(201).json(await FollowUpRuleService.addStep(req.params.ruleId, data));
  } catch (e) { next(e); }
});

const PatchStepSchema = AddStepSchema.partial();
followupRouter.put('/steps/:id', async (req, res, next) => {
  try {
    const data = PatchStepSchema.parse(req.body);
    res.json(await FollowUpRuleService.updateStep(req.params.id, data as any));
  } catch (e) { next(e); }
});
followupRouter.patch('/steps/:id', async (req, res, next) => {
  try {
    const data = PatchStepSchema.parse(req.body);
    res.json(await FollowUpRuleService.updateStep(req.params.id, data as any));
  } catch (e) { next(e); }
});

followupRouter.delete('/steps/:id', async (req, res, next) => {
  try { await FollowUpRuleService.removeStep(req.params.id); res.json({ ok: true }); }
  catch (e) { next(e); }
});

const ReorderSchema = z.object({ ruleId: z.string().min(1), stepIds: z.array(z.string().min(1)) });
followupRouter.post('/steps/reorder', async (req, res, next) => {
  try {
    const { ruleId, stepIds } = ReorderSchema.parse(req.body);
    res.json(await FollowUpRuleService.reorderSteps(ruleId, stepIds));
  } catch (e) { next(e); }
});

/* ──── Logs + dashboard ──── */

followupRouter.get('/logs', async (req, res, next) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const where: any = {};
    if (q.ruleId) where.ruleId = q.ruleId;
    if (q.contactId) where.contactId = q.contactId;
    if (q.status) where.status = q.status;
    const logs = await prisma.followUpLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: q.take ? Math.min(500, +q.take) : 100,
    });
    res.json(logs);
  } catch (e) { next(e); }
});

followupRouter.get('/dashboard', async (_req, res, next) => {
  try {
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const [activeRules, pausedRules, pending, sentToday, failedToday, skippedToday] = await Promise.all([
      prisma.followUpRule.count({ where: { isActive: true } }),
      prisma.followUpRule.count({ where: { isActive: false } }),
      prisma.followUpLog.count({ where: { status: 'pending' } }),
      prisma.followUpLog.count({ where: { status: 'sent', sentAt: { gte: startOfDay } } }),
      prisma.followUpLog.count({ where: { status: 'failed', updatedAt: { gte: startOfDay } } }),
      prisma.followUpLog.count({ where: { status: 'skipped', updatedAt: { gte: startOfDay } } }),
    ]);
    res.json({ activeRules, pausedRules, pending, sentToday, failedToday, skippedToday });
  } catch (e) { next(e); }
});
