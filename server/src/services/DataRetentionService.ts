import { prisma } from '../lib/prisma.js';
import { logger } from '../config/logger.js';

// Hourly cleanup of tables that would otherwise grow forever. Each purge is
// independent + best-effort — a failure in one bucket doesn't block the rest.
//
// Retentions:
//   ProcessedMessage         30 days  (Baileys idempotency, hot only)
//   PollMapping              30 days  (schema TTL comment)
//   LogEntry                 30 days  (dashboard observability)
//   FollowUpLog terminal    180 days  (kept for audit; pending never purged)
//   RetargetingCampaignLog  180 days  (same rationale)
//
// StorageMonitorService already handles the disk-pressure path (aggressive
// cleanup near the space threshold). This service is the time-based backstop
// for operators who never hit the threshold.

const TICK_MS = 60 * 60 * 1000;   // 1 hour
const DAY_MS  = 24 * 60 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;

async function purge() {
  const now = Date.now();
  const cutoff30 = new Date(now - 30 * DAY_MS);
  const cutoff180 = new Date(now - 180 * DAY_MS);
  const totals: Record<string, number> = {};

  try {
    const r = await prisma.processedMessage.deleteMany({ where: { processedAt: { lt: cutoff30 } } });
    totals.processedMessage = r.count;
  } catch (e) { logger.warn({ err: e }, 'retention: processedMessage purge failed'); }

  try {
    const r = await prisma.pollMapping.deleteMany({ where: { createdAt: { lt: cutoff30 } } });
    totals.pollMapping = r.count;
  } catch (e) { logger.warn({ err: e }, 'retention: pollMapping purge failed'); }

  try {
    const r = await prisma.logEntry.deleteMany({ where: { createdAt: { lt: cutoff30 } } });
    totals.logEntry = r.count;
  } catch (e) { logger.warn({ err: e }, 'retention: logEntry purge failed'); }

  try {
    const r = await prisma.followUpLog.deleteMany({
      where: {
        createdAt: { lt: cutoff180 },
        status: { in: ['sent', 'skipped', 'failed', 'canceled'] },
      },
    });
    totals.followUpLog = r.count;
  } catch (e) { logger.warn({ err: e }, 'retention: followUpLog purge failed'); }

  try {
    const r = await prisma.retargetingCampaignLog.deleteMany({
      where: {
        createdAt: { lt: cutoff180 },
        status: { in: ['sent', 'skipped', 'failed', 'replied', 'ordered'] },
      },
    });
    totals.retargetingCampaignLog = r.count;
  } catch (e) { logger.warn({ err: e }, 'retention: retargetingCampaignLog purge failed'); }

  const anyDeleted = Object.values(totals).some((n) => n > 0);
  if (anyDeleted) logger.info(totals, 'retention: purge complete');
}

export const DataRetentionService = {
  start() {
    if (timer) return;
    logger.info('DataRetentionService started (1h tick)');
    timer = setInterval(purge, TICK_MS);
    timer.unref?.();
    // First tick delayed so boot is uncongested.
    setTimeout(purge, 60_000).unref?.();
  },
  stop() {
    if (timer) { clearInterval(timer); timer = null; }
  },
  runOnce: purge,
};
