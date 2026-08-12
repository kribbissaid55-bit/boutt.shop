/**
 * Opt-in error reporter — Sentry-shaped, but zero cost when unconfigured.
 *
 * Set `SENTRY_DSN` in the env and install `@sentry/node`. If either is missing,
 * `reportError` becomes a no-op and the module never pulls the dependency. The
 * existing pino logger continues to receive every error via the caller, so this
 * is purely additive for external alerting.
 */
import { logger } from '../config/logger.js';

type SentryLike = {
  init: (opts: { dsn: string; environment?: string }) => void;
  captureException: (err: unknown, ctx?: { extra?: Record<string, unknown> }) => void;
};

let sentry: SentryLike | null = null;
let ready = false;

async function ensureInit(): Promise<void> {
  if (ready) return;
  ready = true;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  try {
    const mod = (await import('@sentry/node' as any)) as SentryLike;
    mod.init({ dsn, environment: process.env.NODE_ENV });
    sentry = mod;
    logger.info('errorReporter: Sentry initialized');
  } catch (e: any) {
    logger.warn(
      { err: e?.message ?? e },
      'errorReporter: SENTRY_DSN set but @sentry/node not installed — install to enable',
    );
  }
}

void ensureInit();

export function reportError(err: unknown, context?: Record<string, unknown>): void {
  if (!sentry) return;
  try {
    sentry.captureException(err, { extra: context });
  } catch {
    // Never let the reporter itself throw.
  }
}
