/**
 * Per-account FIFO outgoing queue. concurrency=1 per account.
 *
 * Anti-ban features:
 *   - Randomized human-like delay between sends (min/max from settings)
 *   - Daily send cap per account (refuses sends past the cap)
 *   - Burst-cooldown: if account sent ≥ N in last M minutes, inject extra wait
 *   - Account-level cooldownUntil (set when WA returns rate-limit/error) — refuses
 *     all sends until the cooldown clears
 *   - Persists lastSendAt + dailySent on the account row (visible in dashboard)
 */
import PQueue from 'p-queue';
import { randInt, sleep } from '../lib/retry.js';
import { logger } from '../config/logger.js';
import { prisma } from '../lib/prisma.js';

type QueueState = {
  queue: PQueue;
  sentToday: number;
  dayKey: string;
  recentSends: number[]; // ms timestamps; trimmed to burst window
};

const queues = new Map<string, QueueState>();

const todayKey = () => new Date().toISOString().slice(0, 10);

function getState(accountId: string): QueueState {
  let s = queues.get(accountId);
  const day = todayKey();
  if (!s) {
    s = {
      queue: new PQueue({ concurrency: 1 }),
      sentToday: 0, dayKey: day,
      recentSends: [],
    };
    queues.set(accountId, s);
  } else if (s.dayKey !== day) {
    s.sentToday = 0;
    s.dayKey = day;
  }
  return s;
}

export interface QueueOpts {
  minDelayMs: number;
  maxDelayMs: number;
  dailyCap: number;
  burstThreshold?: number;   // count
  burstWindowMin?: number;   // window minutes
  burstCooldownSec?: number; // extra wait when threshold hit
  /** When true, skip the random human-like delay (1.2-3.5s). Use for admin
   *  manual sends from the inbox — the human is already waiting. Bot/campaign
   *  /follow-up sends should leave this off so they look natural. */
  bypassDelay?: boolean;
}

export const MessageQueueService = {
  enqueue<T>(
    accountId: string,
    job: () => Promise<T>,
    opts: QueueOpts
  ): Promise<T> {
    const s = getState(accountId);
    return s.queue.add(async () => {
      // 1. Account-level cooldown gate
      const acc = await prisma.whatsAppAccount.findUnique({
        where: { id: accountId },
        select: { cooldownUntil: true, dailySent: true, lastSendAt: true },
      });
      if (acc?.cooldownUntil) {
        if (acc.cooldownUntil.getTime() > Date.now()) {
          logger.warn({ accountId, until: acc.cooldownUntil }, 'account in cooldown — refusing send');
          throw new Error('account_in_cooldown');
        }
        // Stale cooldown — clear it so it doesn't keep appearing in dashboards.
        await prisma.whatsAppAccount.update({
          where: { id: accountId },
          data: { cooldownUntil: null },
        }).catch(() => {});
      }

      // 2. Daily cap. Guard against misconfigured caps (0/NaN/negative) — fall
      // back to a safe default of 100/day so a typo can't permanently block.
      // Auto-reset the DB counter across day boundaries: if the last send was
      // on a previous ISO day, treat dailySent as 0. Prevents a restart from
      // preserving yesterday's counter and permanently blocking today's sends.
      const todayIso = todayKey();
      const lastSendIso = acc?.lastSendAt ? acc.lastSendAt.toISOString().slice(0, 10) : todayIso;
      const dbSentToday = lastSendIso === todayIso ? (acc?.dailySent ?? 0) : 0;
      if (dbSentToday === 0 && (acc?.dailySent ?? 0) > 0) {
        // Persist the reset so subsequent queries see 0 today.
        await prisma.whatsAppAccount.update({
          where: { id: accountId },
          data: { dailySent: 0 },
        }).catch(() => {});
      }
      const cap = (typeof opts.dailyCap === 'number' && opts.dailyCap > 0)
        ? opts.dailyCap
        : 100;
      const todaySent = Math.max(s.sentToday, dbSentToday);
      if (todaySent >= cap) {
        logger.warn({ accountId, dailyCap: cap }, 'daily send cap reached');
        throw new Error('daily_send_cap_reached');
      }

      // 3. Burst-cooldown: if we've sent a lot recently, slow down further
      const now = Date.now();
      const winMs = (opts.burstWindowMin ?? 30) * 60_000;
      s.recentSends = s.recentSends.filter((t) => now - t <= winMs);
      const threshold = opts.burstThreshold ?? 50;
      let extraDelay = 0;
      if (s.recentSends.length >= threshold) {
        extraDelay = (opts.burstCooldownSec ?? 15) * 1000 + randInt(0, 5000);
        logger.info({ accountId, recent: s.recentSends.length, extraDelay }, 'burst-cooldown active');
      }

      // 4. Base random human-like delay (skipped for admin manual sends)
      const baseDelay = opts.bypassDelay ? 0 : randInt(opts.minDelayMs, opts.maxDelayMs);
      if (baseDelay + extraDelay > 0) await sleep(baseDelay + extraDelay);

      // 5. Run the actual send
      try {
        const result = await job();
        // 6. On success: bookkeeping
        s.sentToday++;
        s.recentSends.push(Date.now());
        try {
          await prisma.whatsAppAccount.update({
            where: { id: accountId },
            data: { lastSendAt: new Date(), dailySent: { increment: 1 } },
          });
        } catch {}
        return result;
      } catch (e) {
        const msg = (e as Error).message ?? '';
        // Heuristic: WA throwback rate-limit / 429 / overlimit → set 1h cooldown
        if (/rate|overlimit|429|too[ -]many/i.test(msg)) {
          const until = new Date(Date.now() + 60 * 60 * 1000);
          await prisma.whatsAppAccount.update({
            where: { id: accountId },
            data: { cooldownUntil: until, lastError: msg.slice(0, 200) },
          }).catch(() => {});
          logger.warn({ accountId, until }, 'WA returned rate-limit; setting 1h cooldown');
        }
        throw e;
      }
    }) as Promise<T>;
  },

  stats(accountId: string) {
    const s = getState(accountId);
    return { pending: s.queue.size, running: s.queue.pending, sentToday: s.sentToday, recent: s.recentSends.length };
  },

  clear(accountId: string) {
    const s = queues.get(accountId);
    if (s) s.queue.clear();
  },

  /**
   * Tear down a per-account queue completely. Called when the account is
   * deleted so the in-process Map doesn't keep accumulating entries for
   * every account that has ever existed.
   */
  removeAccount(accountId: string) {
    const s = queues.get(accountId);
    if (s) {
      try { s.queue.clear(); } catch {}
      queues.delete(accountId);
    }
  },
};
