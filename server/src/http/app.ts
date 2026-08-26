import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { errorHandler, notFound } from './middleware/error.js';
import { requireAuth } from './middleware/auth.js';
import { authRouter } from './routes/auth.routes.js';
import { dashboardRouter } from './routes/dashboard.routes.js';
import { accountsRouter } from './routes/accounts.routes.js';
import { botsRouter } from './routes/bots.routes.js';
import { stepsRouter } from './routes/steps.routes.js';
import { blocksRouter } from './routes/blocks.routes.js';
import { optionsRouter } from './routes/options.routes.js';
import { testsRouter } from './routes/tests.routes.js';
import { mediaRouter } from './routes/media.routes.js';
import { contactsRouter } from './routes/contacts.routes.js';
import { settingsRouter } from './routes/settings.routes.js';
import { logsRouter } from './routes/logs.routes.js';
import { eventsRouter } from './routes/events.routes.js';
import { inboxRouter } from './routes/inbox.routes.js';
import { savedRepliesRouter } from './routes/savedReplies.routes.js';
import { customersRouter } from './routes/customers.routes.js';
import { customerExportRouter } from './routes/customerExport.routes.js';
import { customerImportRouter } from './routes/customerImport.routes.js';
import { followupRouter } from './routes/followup.routes.js';
import { segmentsRouter } from './routes/segments.routes.js';
import { retargetingRouter } from './routes/retargeting.routes.js';
import { aiRouter } from './routes/ai.routes.js';
import { promptBuilderRouter } from './routes/promptBuilder.routes.js';
import { socialRouter } from './routes/social.routes.js';
import { socialWebhookRouter } from './routes/socialWebhook.routes.js';
import { whatsappWebhookRouter } from './routes/whatsappWebhook.routes.js';
import { whatsappCloudRouter } from './routes/whatsappCloud.routes.js';
import { productsRouter } from './routes/products.routes.js';
import { storageRouter } from './routes/storage.routes.js';
import { adminRouter } from './routes/admin.routes.js';

export function buildApp() {
  const app = express();

  // Trust reverse proxy (nginx / cloudflare / etc.) so req.ip reflects the
  // real client IP for rate limiting and cookie decisions. Safe with a single
  // proxy hop; increase if the operator adds more layers.
  app.set('trust proxy', 1);

  // CORS allowlist. Same-origin dev (Vite proxy) never triggers CORS because
  // fetches go to the loaded page's own origin. Only cross-origin production
  // needs env.ALLOWED_ORIGINS_LIST populated.
  const allowed = new Set(env.ALLOWED_ORIGINS_LIST);
  app.use(cors({
    origin: (origin, cb) => {
      // Requests without an Origin header (curl, server-side, same-origin
      // fetches) are always allowed — cookies don't cross origins in those.
      if (!origin) return cb(null, true);
      if (allowed.size === 0) return cb(null, false);
      cb(null, allowed.has(origin));
    },
    credentials: true,
  }));
  // Meta webhook — mounted BEFORE the global json parser so it can capture
  // the raw body for X-Hub-Signature-256 verification, and before auth
  // because Meta's servers call it without a session cookie.
  app.use(socialWebhookRouter);
  // Official WhatsApp Cloud API webhook — same raw-body/no-auth constraints.
  app.use(whatsappWebhookRouter);

  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());

  logger.info(
    { env: env.NODE_ENV, allowedOrigins: env.ALLOWED_ORIGINS_LIST, crossOrigin: env.IS_CROSS_ORIGIN },
    'http config',
  );

  // Rich health check — probes DB, counts WA sessions by status, reports RSS
  // and uptime. Returns 503 when the DB ping fails so uptime monitors alert
  // instead of silently green-ticking.
  app.get('/api/health', async (_req, res) => {
    const memMB = Math.round(process.memoryUsage().rss / (1024 * 1024));
    const uptimeSec = Math.round(process.uptime());
    const [dbOk, sessions] = await Promise.all([
      prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
      prisma.whatsAppAccount.findMany({ select: { status: true } }).catch(() => [] as { status: string }[]),
    ]);
    const sessionCounts: Record<string, number> = {};
    for (const s of sessions) sessionCounts[s.status] = (sessionCounts[s.status] ?? 0) + 1;
    res.status(dbOk ? 200 : 503).json({
      ok: dbOk,
      ts: Date.now(),
      uptimeSec,
      memMB,
      dbOk,
      sessions: sessionCounts,
    });
  });

  app.use('/api/auth', authRouter);

  // everything below requires auth
  app.use('/api', requireAuth);

  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/accounts', accountsRouter);
  app.use('/api/bots', botsRouter);
  app.use('/api', stepsRouter);    // /bots/:botId/steps, /steps/:id, /steps/reorder
  app.use('/api', blocksRouter);   // /steps/:stepId/blocks, /blocks/:id, /blocks/reorder
  app.use('/api', optionsRouter);  // /steps/:stepId/options, /options/:id, /options/reorder
  app.use('/api', testsRouter);    // /bots/:botId/test/{start,message,reset}
  app.use('/api/media', mediaRouter);
  app.use('/api/contacts', contactsRouter);
  app.use('/api/inbox', inboxRouter);
  app.use('/api/saved-replies', savedRepliesRouter);
  app.use('/api/customers', customersRouter);
  app.use('/api/customers/export', customerExportRouter);
  app.use('/api/customers/import', customerImportRouter);
  app.use('/api/follow-ups', followupRouter);
  app.use('/api/segments', segmentsRouter);
  app.use('/api/retargeting', retargetingRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api', aiRouter);        // /bots/:id/ai, /ai/credentials
  app.use('/api', promptBuilderRouter); // /bots/:id/ai/prompt-builder
  app.use('/api', socialRouter);        // /social/* — pages, accounts, events
  app.use('/api', whatsappCloudRouter); // /wa-cloud/* — official Cloud API setup
  app.use('/api/products', productsRouter);
  app.use('/api/storage', storageRouter);
  app.use('/api/logs', logsRouter);
  app.use('/api/events', eventsRouter);

  // Serve the built SPA (client/dist) when present — lets one domain serve
  // both the API (/api/*) and the frontend in production (Docker/Dokploy).
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const clientDist = path.resolve(moduleDir, '../../../client/dist');
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
