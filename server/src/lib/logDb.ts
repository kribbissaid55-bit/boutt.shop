import { prisma } from './prisma.js';
import { logger } from '../config/logger.js';

// Persist high-signal log lines (warn/error) to the `LogEntry` table so the
// operator's Logs page has actual content. This runs alongside pino — it
// doesn't replace it. Best-effort: a DB stall degrades log persistence but
// never blocks the request thread.
//
// Bounded queue: drops the oldest entry when full so a burst of errors can't
// consume unbounded RAM. Flush interval + max queue size are conservative.

type Level = 'info' | 'warn' | 'error';

interface Entry {
  level: Level;
  scope: string;
  message: string;
  accountId?: string | null;
  meta?: unknown;
  createdAt: Date;
}

const MAX_QUEUE = 500;
const FLUSH_MS = 5_000;

const queue: Entry[] = [];
let flushTimer: NodeJS.Timeout | null = null;

function enqueue(entry: Entry) {
  if (queue.length >= MAX_QUEUE) queue.shift();
  queue.push(entry);
  if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
}

async function flush() {
  flushTimer = null;
  if (queue.length === 0) return;
  const batch = queue.splice(0, queue.length);
  try {
    await prisma.logEntry.createMany({
      data: batch.map((e) => ({
        level: e.level,
        scope: e.scope,
        accountId: e.accountId ?? null,
        message: e.message,
        meta: e.meta ? safeJson(e.meta) : null,
        createdAt: e.createdAt,
      })),
    });
  } catch (err) {
    // Fall back to pino so we don't lose the observability if the DB dies.
    logger.warn({ err, dropped: batch.length }, 'logDb flush failed');
  }
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v); } catch { return '"<uncloneable>"'; }
}

export const logDb = {
  warn(scope: string, message: string, meta?: unknown, accountId?: string | null) {
    enqueue({ level: 'warn', scope, message, meta, accountId, createdAt: new Date() });
  },
  error(scope: string, message: string, meta?: unknown, accountId?: string | null) {
    enqueue({ level: 'error', scope, message, meta, accountId, createdAt: new Date() });
  },
  /** For observability tests / graceful shutdown. */
  flushNow: flush,
};
