/**
 * StorageMonitorService — disk-usage watchdog + warn-then-cleanup state machine.
 *
 *   Boot → tick every 30 minutes.
 *   Measure storage/{media,sessions,exports} + SQLite files.
 *   Compare against operator-configured warning + threshold (in GB).
 *
 * Phases (persisted in Setting → key `storage_state`):
 *   ok                → usage < warning. No banner.
 *   warning           → warning ≤ usage < threshold. Banner shown. `firstWarnedAt` set.
 *   critical_warned   → usage ≥ threshold AND grace period NOT elapsed. Louder banner.
 *   cleanup_required  → grace period elapsed → cleanup runs → return to `ok`.
 *
 * The cleanup itself is intentionally conservative:
 *   - Orphan MediaFile (file >6 months old AND not referenced anywhere)
 *   - Message older than 12 months
 *   - ProcessedMessage older than 30 days
 *   - LogEntry older than 30 days
 *   - FollowUpLog + RetargetingCampaignLog older than 90 days (status != pending)
 *   - PollMapping older than 30 days
 *   - Files in STORAGE_ROOT/exports older than 7 days
 */
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { bus } from './EventBus.js';

const TICK_MS = 30 * 60_000;          // 30 min
const GB = 1024 * 1024 * 1024;

export interface StorageState {
  phase: 'ok' | 'warning' | 'critical_warned' | 'cleanup_required';
  firstWarnedAt?: string;             // ISO timestamp
  lastCleanupAt?: string;             // ISO timestamp
  lastCheckAt?: string;
  lastFreedBytes?: number;
}

export interface StorageConfig {
  thresholdGb: number;                // hard limit — cleanup triggers here
  warningGb: number;                  // start showing banner
  gracePeriodDays: number;            // wait this long after firstWarnedAt before cleanup
}

const DEFAULT_CONFIG: StorageConfig = {
  thresholdGb: 60,
  warningGb: 50,
  gracePeriodDays: 3,
};

let timer: NodeJS.Timeout | null = null;

async function getConfig(): Promise<StorageConfig> {
  const row = await prisma.setting.findUnique({ where: { key: 'storage_config' } });
  if (!row) return { ...DEFAULT_CONFIG };
  try {
    const parsed = JSON.parse(row.value) as Partial<StorageConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function saveConfig(cfg: StorageConfig): Promise<void> {
  await prisma.setting.upsert({
    where: { key: 'storage_config' },
    update: { value: JSON.stringify(cfg) },
    create: { key: 'storage_config', value: JSON.stringify(cfg) },
  });
}

async function getState(): Promise<StorageState> {
  const row = await prisma.setting.findUnique({ where: { key: 'storage_state' } });
  if (!row) return { phase: 'ok' };
  try { return JSON.parse(row.value) as StorageState; }
  catch { return { phase: 'ok' }; }
}

async function saveState(s: StorageState): Promise<void> {
  await prisma.setting.upsert({
    where: { key: 'storage_state' },
    update: { value: JSON.stringify(s) },
    create: { key: 'storage_state', value: JSON.stringify(s) },
  });
}

/** Recursive byte count. Returns 0 if dir doesn't exist. */
function dirBytes(dir: string): number {
  let total = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(dir, e.name);
      try {
        if (e.isDirectory()) total += dirBytes(p);
        else if (e.isFile()) total += fs.statSync(p).size;
      } catch {}
    }
  } catch {}
  return total;
}

export interface StorageBreakdown {
  media: number;
  sessions: number;
  exports: number;
  database: number;
  total: number;
}

export function measure(): StorageBreakdown {
  const media = dirBytes(env.MEDIA_DIR);
  const sessions = dirBytes(env.SESSIONS_DIR);
  const exportsDir = path.join(env.STORAGE_ROOT, 'exports');
  const exportsBytes = dirBytes(exportsDir);
  // SQLite file + WAL + SHM
  let database = 0;
  for (const f of ['dev.db', 'dev.db-wal', 'dev.db-shm']) {
    try { database += fs.statSync(path.join(process.cwd(), 'prisma', f)).size; } catch {}
  }
  return {
    media, sessions, exports: exportsBytes, database,
    total: media + sessions + exportsBytes + database,
  };
}

/** The actual purge — only call when phase = cleanup_required. */
async function runCleanup(): Promise<{ summary: string; freedBytes: number }> {
  const now = new Date();
  const cuts = {
    sixMonths: new Date(now.getTime() - 180 * 86400_000),
    twelveMonths: new Date(now.getTime() - 365 * 86400_000),
    thirtyDays: new Date(now.getTime() - 30 * 86400_000),
    ninetyDays: new Date(now.getTime() - 90 * 86400_000),
    sevenDays: new Date(now.getTime() - 7 * 86400_000),
  };

  let freedBytes = 0;
  const audit: string[] = [];

  // 1) Orphan MediaFile rows (file older than 6 months AND not referenced)
  const oldMedia = await prisma.mediaFile.findMany({
    where: { createdAt: { lt: cuts.sixMonths } },
    select: { id: true, path: true, sizeBytes: true },
  });
  let mediaDeleted = 0;
  for (const m of oldMedia) {
    // Reference checks — any "contains: id" hit on a JSON-stringified blob
    // keeps the media. instructionMedia is the live brain-attachments column;
    // introMediaIds + recallMediaTags are legacy nullable columns we still
    // scan so old rows don't lose their media.
    const refs = await Promise.all([
      prisma.messageBlock.count({ where: { mediaId: m.id } }),
      prisma.message.count({ where: { mediaId: m.id } }),
      prisma.product.count({ where: { mediaIds: { contains: m.id } } }),
      prisma.botAiConfig.count({ where: { instructionMedia: { contains: m.id } } }),
      prisma.botAiConfig.count({ where: { introMediaIds: { contains: m.id } } }),
      prisma.botAiConfig.count({ where: { recallMediaTags: { contains: m.id } } }),
      prisma.botSettings.count({ where: { callRejectionSequence: { contains: m.id } } }),
      prisma.followUpStep.count({ where: { messageSequence: { contains: m.id } } }),
      prisma.retargetingCampaign.count({ where: { messageSequence: { contains: m.id } } }),
    ]);
    if (refs.some((c) => c > 0)) continue;
    // Safe to remove
    try {
      const absPath = path.isAbsolute(m.path) ? m.path : path.join(env.MEDIA_DIR, m.path);
      try { freedBytes += fs.statSync(absPath).size; } catch {}
      try { fs.unlinkSync(absPath); } catch {}
    } catch {}
    await prisma.mediaFile.delete({ where: { id: m.id } }).catch(() => {});
    mediaDeleted++;
  }
  if (mediaDeleted) audit.push(`media orphans: ${mediaDeleted}`);

  // 2) Old Messages (12 months)
  const msgDel = await prisma.message.deleteMany({ where: { createdAt: { lt: cuts.twelveMonths } } });
  if (msgDel.count) audit.push(`messages: ${msgDel.count}`);

  // 3) ProcessedMessage (30 days) — idempotency only
  const procDel = await prisma.processedMessage.deleteMany({ where: { processedAt: { lt: cuts.thirtyDays } } });
  if (procDel.count) audit.push(`processedMessage: ${procDel.count}`);

  // 4) LogEntry (30 days)
  const logDel = await prisma.logEntry.deleteMany({ where: { createdAt: { lt: cuts.thirtyDays } } });
  if (logDel.count) audit.push(`logs: ${logDel.count}`);

  // 5) FollowUpLog (90 days, non-pending)
  const fuDel = await prisma.followUpLog.deleteMany({
    where: { createdAt: { lt: cuts.ninetyDays }, NOT: { status: 'pending' } },
  });
  if (fuDel.count) audit.push(`followUpLog: ${fuDel.count}`);

  // 6) RetargetingCampaignLog (90 days, non-pending)
  const rcDel = await prisma.retargetingCampaignLog.deleteMany({
    where: { createdAt: { lt: cuts.ninetyDays }, NOT: { status: 'pending' } },
  });
  if (rcDel.count) audit.push(`campaignLog: ${rcDel.count}`);

  // 7) PollMapping (30 days)
  try {
    const pmDel = await (prisma as any).pollMapping?.deleteMany?.({
      where: { createdAt: { lt: cuts.thirtyDays } },
    });
    if (pmDel?.count) audit.push(`pollMapping: ${pmDel.count}`);
  } catch {}

  // 8) Export files (7 days)
  let exportFilesDel = 0;
  try {
    const exDir = path.join(env.STORAGE_ROOT, 'exports');
    if (fs.existsSync(exDir)) {
      for (const f of fs.readdirSync(exDir)) {
        const fp = path.join(exDir, f);
        try {
          const st = fs.statSync(fp);
          if (st.mtime.getTime() < cuts.sevenDays.getTime()) {
            freedBytes += st.size;
            fs.unlinkSync(fp);
            exportFilesDel++;
          }
        } catch {}
      }
    }
  } catch {}
  if (exportFilesDel) audit.push(`exportFiles: ${exportFilesDel}`);

  const summary = audit.length ? audit.join(', ') : 'nothing-to-delete';
  logger.info({ summary, freedBytes }, 'storage cleanup completed');
  return { summary, freedBytes };
}

async function tick(): Promise<void> {
  try {
    const cfg = await getConfig();
    const state = await getState();
    const usage = measure();
    const totalBytes = usage.total;
    const thresholdBytes = cfg.thresholdGb * GB;
    const warningBytes = cfg.warningGb * GB;
    const now = new Date();

    let newPhase: StorageState['phase'] = 'ok';
    if (totalBytes >= thresholdBytes) {
      const first = state.firstWarnedAt ? new Date(state.firstWarnedAt) : now;
      const ageDays = (now.getTime() - first.getTime()) / 86400_000;
      if (ageDays >= cfg.gracePeriodDays) {
        newPhase = 'cleanup_required';
      } else {
        newPhase = 'critical_warned';
      }
    } else if (totalBytes >= warningBytes) {
      newPhase = 'warning';
    }

    let next: StorageState = { ...state, phase: newPhase, lastCheckAt: now.toISOString() };

    // On entering warning phase for the first time, stamp the start.
    if (newPhase !== 'ok' && !state.firstWarnedAt) {
      next.firstWarnedAt = now.toISOString();
    }
    // On returning to ok, clear the start.
    if (newPhase === 'ok' && state.firstWarnedAt) {
      next.firstWarnedAt = undefined;
    }

    if (newPhase === 'cleanup_required') {
      const { freedBytes } = await runCleanup();
      next = {
        phase: 'ok',
        lastCleanupAt: now.toISOString(),
        lastCheckAt: now.toISOString(),
        lastFreedBytes: freedBytes,
        firstWarnedAt: undefined,
      };
    }

    if (newPhase !== state.phase) {
      bus.emitEvent({ type: 'log', level: 'info', message: `storage phase: ${state.phase} → ${newPhase}` } as any);
    }
    await saveState(next);
  } catch (e) {
    logger.error({ err: e }, 'StorageMonitorService tick failed');
  }
}

export const StorageMonitorService = {
  start() {
    if (timer) return;
    logger.info('StorageMonitorService started (30 min tick)');
    timer = setInterval(tick, TICK_MS);
    timer.unref?.();
    // Tick once after a short startup delay so a tight loop doesn't slow boot.
    setTimeout(() => { tick().catch(() => {}); }, 60_000);
  },
  stop() {
    if (timer) { clearInterval(timer); timer = null; }
  },
  /** Manual cleanup for the operator's "force now" button. */
  async forceCleanup(): Promise<{ summary: string; freedBytes: number }> {
    const out = await runCleanup();
    await saveState({
      phase: 'ok',
      lastCleanupAt: new Date().toISOString(),
      lastCheckAt: new Date().toISOString(),
      lastFreedBytes: out.freedBytes,
    });
    return out;
  },
  async status() {
    const cfg = await getConfig();
    const state = await getState();
    const usage = measure();
    return {
      usage,
      config: cfg,
      state,
    };
  },
  async updateConfig(patch: Partial<StorageConfig>): Promise<StorageConfig> {
    const cur = await getConfig();
    const next: StorageConfig = {
      thresholdGb: clampNum(patch.thresholdGb ?? cur.thresholdGb, 1, 100_000),
      warningGb: clampNum(patch.warningGb ?? cur.warningGb, 1, 100_000),
      gracePeriodDays: clampNum(patch.gracePeriodDays ?? cur.gracePeriodDays, 0, 90),
    };
    // Enforce warning < threshold
    if (next.warningGb >= next.thresholdGb) next.warningGb = Math.max(1, next.thresholdGb - 1);
    await saveConfig(next);
    return next;
  },
};

function clampNum(n: number, min: number, max: number): number {
  if (typeof n !== 'number' || !isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}
