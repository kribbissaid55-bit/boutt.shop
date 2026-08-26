/**
 * whatsappCloud.routes — admin API for the official WhatsApp Cloud API setup.
 * Auth-protected (mounted under the global requireAuth like every /api route).
 *
 *   GET  /wa-cloud/config              → masked config + webhook info
 *   PUT  /wa-cloud/config              → save token / app secret / WABA id
 *   POST /wa-cloud/test                → verify token + WABA (reads WABA node)
 *   GET  /wa-cloud/phones              → list numbers on the WABA (live)
 *   POST /wa-cloud/phones/activate     → create/attach a WhatsAppAccount row
 *   POST /wa-cloud/subscribe           → subscribe our app to the WABA webhooks
 *   GET  /wa-cloud/templates           → list approved message templates
 *
 * SECURITY: the access token is write-only from the dashboard — GET returns a
 * mask. Tokens are stored AES-256-GCM encrypted in the Setting table.
 */
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../config/logger.js';
import { CloudApiService, CloudApiError } from '../../services/CloudApiService.js';
import { invalidateProviderCache } from '../../adapters/whatsapp/providerFactory.js';
import { invalidateCloudPhoneCache } from '../../adapters/whatsapp/CloudApiProvider.js';

export const whatsappCloudRouter = Router();

const wrap = (fn: (req: any, res: any) => Promise<void>) =>
  (req: any, res: any) => fn(req, res).catch((e: any) => {
    const msg = e instanceof CloudApiError
      ? `${e.message}${e.code ? ` (code ${e.code})` : ''}`
      : (e?.message ?? 'unknown_error');
    logger.warn({ err: msg, path: req.path }, '[cloud] admin route error');
    res.status(400).json({ error: msg });
  });

whatsappCloudRouter.get('/wa-cloud/config', wrap(async (_req, res) => {
  res.json(await CloudApiService.getConfig());
}));

const ConfigBody = z.object({
  accessToken: z.string().optional(),
  appSecret: z.string().optional(),
  wabaId: z.string().optional(),
});

whatsappCloudRouter.put('/wa-cloud/config', wrap(async (req, res) => {
  const body = ConfigBody.parse(req.body ?? {});
  await CloudApiService.saveConfig(body);
  res.json(await CloudApiService.getConfig());
}));

whatsappCloudRouter.post('/wa-cloud/test', wrap(async (_req, res) => {
  const info = await CloudApiService.testConnection();
  res.json({ ok: true, ...info });
}));

whatsappCloudRouter.get('/wa-cloud/phones', wrap(async (_req, res) => {
  const phones = await CloudApiService.fetchPhones();
  // annotate which ones are already activated locally
  const local = await prisma.whatsAppAccount.findMany({
    where: { provider: 'cloud' }, select: { id: true, phoneNumberId: true },
  });
  const byPid = new Map(local.map((a) => [a.phoneNumberId, a.id]));
  res.json(phones.map((p) => ({ ...p, accountId: byPid.get(p.phoneNumberId) ?? null })));
}));

const ActivateBody = z.object({
  phoneNumberId: z.string().min(3),
  displayPhone: z.string().optional(),
  verifiedName: z.string().optional(),
});

whatsappCloudRouter.post('/wa-cloud/phones/activate', wrap(async (req, res) => {
  const { phoneNumberId, displayPhone, verifiedName } = ActivateBody.parse(req.body ?? {});
  const wabaId = (await CloudApiService.getConfig()).wabaId || null;

  const existing = await prisma.whatsAppAccount.findUnique({ where: { phoneNumberId } });
  const account = existing
    ? await prisma.whatsAppAccount.update({
        where: { id: existing.id },
        data: {
          provider: 'cloud', status: 'connected', lastError: null,
          phoneNumber: displayPhone ?? existing.phoneNumber, wabaId,
          ...(verifiedName ? { name: verifiedName } : {}),
        },
      })
    : await prisma.whatsAppAccount.create({
        data: {
          name: verifiedName || displayPhone || 'WhatsApp الرسمي',
          provider: 'cloud',
          phoneNumberId,
          wabaId,
          phoneNumber: displayPhone ?? null,
          status: 'connected',
          sessionPath: `cloud:${phoneNumberId}`, // unique, never a real dir
          isBusiness: true,
          platform: 'cloud_api',
        },
      });

  invalidateProviderCache(account.id);
  invalidateCloudPhoneCache(account.id);
  logger.info({ accountId: account.id, phoneNumberId }, '[cloud] phone activated');
  res.json(account);
}));

whatsappCloudRouter.post('/wa-cloud/subscribe', wrap(async (_req, res) => {
  const ok = await CloudApiService.subscribeApp();
  res.json({ ok });
}));

whatsappCloudRouter.get('/wa-cloud/templates', wrap(async (_req, res) => {
  res.json(await CloudApiService.listTemplates());
}));

/** Send a test message (free-form) from an activated cloud number — the
 *  recipient must have messaged the number first OR be a Meta test recipient. */
const TestSendBody = z.object({
  phoneNumberId: z.string().min(3),
  to: z.string().min(6),
  text: z.string().min(1).max(1000),
});

whatsappCloudRouter.post('/wa-cloud/test-send', wrap(async (req, res) => {
  const { phoneNumberId, to, text } = TestSendBody.parse(req.body ?? {});
  const wamid = await CloudApiService.sendText(phoneNumberId, to.replace(/[^\d]/g, ''), text);
  res.json({ ok: !!wamid, wamid });
}));
