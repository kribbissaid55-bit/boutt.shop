import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { BotTemplateService } from '../../services/BotTemplateService.js';
import { BotValidationService } from '../../services/BotValidationService.js';

export const botsRouter = Router();

botsRouter.get('/', async (_req, res, next) => {
  try {
    const bots = await prisma.bot.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        accounts: { include: { account: true } },
        _count: { select: { steps: true } },
      },
    });
    res.json(bots);
  } catch (e) { next(e); }
});

botsRouter.get('/:id', async (req, res, next) => {
  try {
    const bot = await prisma.bot.findUnique({
      where: { id: req.params.id },
      include: {
        accounts: { include: { account: true } },
        settings: true,
        steps: {
          orderBy: { sortOrder: 'asc' },
          include: {
            blocks: { orderBy: { sortOrder: 'asc' }, include: { media: true } },
            options: { orderBy: { sortOrder: 'asc' } },
          },
        },
      },
    });
    if (!bot) return res.status(404).json({ error: 'not_found' });
    res.json(bot);
  } catch (e) { next(e); }
});

const CreateSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
});
botsRouter.post('/', async (req, res, next) => {
  try {
    const data = CreateSchema.parse(req.body);
    const bot = await BotTemplateService.createBotWithDefaults(data);
    res.status(201).json(bot);
  } catch (e) { next(e); }
});

const PatchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(500).optional(),
  isActive: z.boolean().optional(),
  priority: z.number().int().min(0).max(100).optional(),
  status: z.enum(['draft', 'active', 'paused']).optional(),
  defaultLanguage: z.string().min(2).max(5).optional(),
});
botsRouter.patch('/:id', async (req, res, next) => {
  try {
    const data = PatchSchema.parse(req.body);
    res.json(await prisma.bot.update({ where: { id: req.params.id }, data }));
  } catch (e) { next(e); }
});

botsRouter.put('/:id', async (req, res, next) => {
  try {
    const data = PatchSchema.parse(req.body);
    res.json(await prisma.bot.update({ where: { id: req.params.id }, data }));
  } catch (e) { next(e); }
});

botsRouter.delete('/:id', async (req, res, next) => {
  try {
    await prisma.bot.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

const SettingsSchema = z.object({
  welcomeEnabled: z.boolean().optional(),
  fallbackEnabled: z.boolean().optional(),
  groupsEnabled: z.boolean().optional(),
  workingHours: z.any().optional(),
  defaultFallbackMessage: z.string().nullable().optional(),
  humanHandoverKeywords: z.array(z.string()).optional(),
  inactivityResetHours: z.number().int().min(0).max(720).optional(),
  sendWelcomeOnce: z.boolean().optional(),
  pauseAfterWelcome: z.boolean().optional(),
  notifyOnHandover: z.boolean().optional(),
  maxFailedAttempts: z.number().int().min(1).max(20).optional(),
  callRejectionEnabled: z.boolean().optional(),
  callRejectionDelaySeconds: z.number().int().min(0).max(10).optional(),
  callRejectionSequence: z.any().optional(),   // { blocks: [...] }
});
botsRouter.patch('/:id/settings', async (req, res, next) => {
  try {
    const data = SettingsSchema.parse(req.body);
    const patch: any = { ...data };
    if (data.workingHours !== undefined) patch.workingHours = JSON.stringify(data.workingHours);
    if (data.humanHandoverKeywords !== undefined) patch.humanHandoverKeywords = JSON.stringify(data.humanHandoverKeywords);
    if (data.callRejectionSequence !== undefined) patch.callRejectionSequence = data.callRejectionSequence === null ? null : JSON.stringify(data.callRejectionSequence);
    const updated = await prisma.botSettings.upsert({
      where: { botId: req.params.id },
      update: patch,
      create: { botId: req.params.id, ...patch },
    });
    res.json(updated);
  } catch (e) { next(e); }
});

botsRouter.post('/:id/publish', async (req, res, next) => {
  try {
    const v = await BotValidationService.validate(req.params.id);
    if (v.errors.length) return res.status(400).json({ error: 'validation_failed', issues: v });
    res.json(await prisma.bot.update({ where: { id: req.params.id }, data: { status: 'active' } }));
  } catch (e) { next(e); }
});
botsRouter.post('/:id/pause', async (req, res, next) => {
  try { res.json(await prisma.bot.update({ where: { id: req.params.id }, data: { status: 'paused' } })); }
  catch (e) { next(e); }
});
botsRouter.post('/:id/validate', async (req, res, next) => {
  try { res.json(await BotValidationService.validate(req.params.id)); }
  catch (e) { next(e); }
});

const LinkSchema = z.object({ accountId: z.string().min(1) });
botsRouter.post('/:id/accounts', async (req, res, next) => {
  try {
    const { accountId } = LinkSchema.parse(req.body);
    await prisma.botAccount.upsert({
      where: { botId_accountId: { botId: req.params.id, accountId } },
      update: {}, create: { botId: req.params.id, accountId },
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});
botsRouter.delete('/:id/accounts/:accountId', async (req, res, next) => {
  try {
    await prisma.botAccount.delete({
      where: { botId_accountId: { botId: req.params.id, accountId: req.params.accountId } },
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

botsRouter.get('/:id/orders', async (req, res, next) => {
  try {
    const orders = await prisma.order.findMany({
      where: { botId: req.params.id },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { contact: true },
    });
    res.json(orders);
  } catch (e) { next(e); }
});
