import type { Server } from 'node:http';
import { logger } from './config/logger.js';
import { prisma } from './lib/prisma.js';
import { whatsapp } from './adapters/whatsapp/BaileysAdapter.js';
import { FollowUpEngine } from './services/FollowUpEngine.js';
import { StorageMonitorService } from './services/StorageMonitorService.js';

/**
 * Graceful shutdown on SIGINT/SIGTERM.
 *
 * Order matters:
 *   1. Stop timers (FollowUpEngine, StorageMonitor) so they don't fire mid-shutdown.
 *   2. Close HTTP server so no new requests come in.
 *   3. Close WA sockets cleanly WITHOUT sock.logout() — keeps credentials so
 *      reconnect works next boot. Auto-reconnect stays intact.
 *   4. Disconnect Prisma so pending queries flush.
 *   5. Hard-exit after 10s if anything is still hanging.
 */
export function installShutdown(server: Server) {
  let shuttingDown = false;
  const close = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'graceful shutdown starting');
    const hardExit = setTimeout(() => {
      logger.warn('shutdown deadline hit — hard exit');
      process.exit(1);
    }, 10_000);
    hardExit.unref();

    // 1. Stop background timers.
    try { FollowUpEngine.stop(); } catch (e) { logger.warn({ err: e }, 'FollowUpEngine.stop failed'); }
    try { StorageMonitorService.stop(); } catch (e) { logger.warn({ err: e }, 'StorageMonitorService.stop failed'); }

    // 2. Stop accepting new HTTP requests.
    await new Promise<void>((resolve) => server.close(() => { logger.info('http closed'); resolve(); }));

    // 3. Close WA sockets WITHOUT logging out.
    try { await whatsapp.shutdownAll(); } catch (e) { logger.warn({ err: e }, 'shutdownAll failed'); }

    // 4. Prisma disconnect.
    try { await prisma.$disconnect(); } catch (e) { logger.warn({ err: e }, 'prisma.$disconnect failed'); }

    logger.info('graceful shutdown complete');
    clearTimeout(hardExit);
    process.exit(0);
  };
  process.on('SIGINT', () => close('SIGINT'));
  process.on('SIGTERM', () => close('SIGTERM'));
}
