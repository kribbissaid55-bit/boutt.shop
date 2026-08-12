// Human-touch reply delays. Used by the AI engine to wait a moment before
// sending the first (or every subsequent) reply — makes the bot feel less
// robotic. Values are in SECONDS from the DB; this returns MS.
// Callers use `sleep(ms)` from `lib/retry` to actually wait.

const MAX_DELAY_MS = 600_000;   // 10 min hard ceiling — safety against typos.

export interface ReplyDelayConfig {
  min: number;
  max: number;
  rnd: boolean;
}

export function computeReplyDelayMs(cfg: ReplyDelayConfig): number {
  const min = Math.max(0, cfg.min | 0);
  const max = Math.max(0, cfg.max | 0);
  if (min === 0 && max === 0) return 0;
  // Randomize in [min, max] when the toggle is on AND the range is valid.
  // Otherwise use the fixed `min` value.
  const seconds = (cfg.rnd && max > min)
    ? min + Math.floor(Math.random() * (max - min + 1))
    : min;
  return Math.min(MAX_DELAY_MS, seconds * 1000);
}
