/**
 * Bot Said 22 — private WhatsApp automation server.
 *
 * IMPORTANT INTERNAL WARNING:
 * This system uses Baileys (WhatsApp Web protocol) with QR/pairing-code auth,
 * NOT the official Meta WhatsApp Business API. WhatsApp can change behavior,
 * disconnect sessions, or block accounts that exhibit spammy patterns. The
 * adapter and engine include guard-rails (per-account FIFO queue, randomized
 * delays, daily caps, cold-start ignore window, idempotency on incoming, group
 * filtering, emergency stop) — but you must avoid spammy use.
 */
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { buildApp } from './http/app.js';
import { reportError } from './lib/errorReporter.js';

// Global crash-loop prevention.
//
// Baileys throws timing errors (prekey upload timeout, WA socket races) that
// bubble up as unhandled rejections and kill the Node process. We've observed
// these repeatedly in production. Logging + keep-alive is safer than exit:
// the WA session's own circuit breaker + reconnect logic recovers automatically,
// and other bots/HTTP traffic keep serving.
process.on('unhandledRejection', (reason: any, promise) => {
  logger.error(
    { err: reason?.message ?? reason, stack: reason?.stack, promise: String(promise) },
    'unhandledRejection — process kept alive',
  );
  reportError(reason, { kind: 'unhandledRejection' });
});
process.on('uncaughtException', (err: any) => {
  logger.error(
    { err: err?.message ?? err, stack: err?.stack },
    'uncaughtException — process kept alive',
  );
  reportError(err, { kind: 'uncaughtException' });
});
import { WhatsAppSessionService } from './services/WhatsAppSessionService.js';
import { BotEngineService } from './services/BotEngineService.js';
import { FollowUpEngine } from './services/FollowUpEngine.js';
import { CampaignEngine } from './services/CampaignEngine.js';
import { DataRetentionService } from './services/DataRetentionService.js';
import { handleIncomingCall } from './engine/handleIncomingCall.js';
import { initSqlitePragmas } from './lib/prisma.js';
import { StorageMonitorService } from './services/StorageMonitorService.js';
import { installShutdown } from './shutdown.js';
import fs from 'node:fs';

async function main() {
  fs.mkdirSync(env.SESSIONS_DIR, { recursive: true });
  fs.mkdirSync(env.MEDIA_DIR, { recursive: true });

  // SQLite concurrency tuning — WAL + busy_timeout + synchronous=NORMAL.
  await initSqlitePragmas();

  WhatsAppSessionService.init(
    (m) => BotEngineService.handleIncoming(m),
    (c) => handleIncomingCall(c),
  );

  const app = buildApp();
  const server = app.listen(env.PORT, () => {
    logger.info(`▶ http listening on http://localhost:${env.PORT}`);
  });

  installShutdown(server);

  // resume previously-connected accounts
  WhatsAppSessionService.resumeAll().catch((e) =>
    logger.error({ err: e }, 'resumeAll failed')
  );

  // start the follow-up engine (60s ticks, restart-safe via DB state)
  FollowUpEngine.start();

  // resume any campaigns that were running before the restart
  CampaignEngine.resumeRunning().catch((e) =>
    logger.error({ err: e }, 'CampaignEngine.resumeRunning failed')
  );

  // disk-usage monitor + auto-cleanup
  StorageMonitorService.start();

  // Hourly time-based retention: purges ProcessedMessage / PollMapping / LogEntry
  // beyond 30 days and terminal follow-up/campaign logs beyond 180 days.
  // Independent of the disk-pressure cleanup in StorageMonitorService.
  DataRetentionService.start();
}

main().catch((e) => {
  logger.error({ err: e }, 'fatal');
  process.exit(1);
});
