import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { logger } from '../../config/logger.js';
import { logDb } from '../../lib/logDb.js';

export function notFound(_req: Request, res: Response) {
  res.status(404).json({ error: 'not_found' });
}

// Domain error codes that are safe to expose to clients. These are the
// stable strings the frontend/UI translates into user-visible messages.
// Anything not in this set is treated as "internal" and its raw text is
// hidden from the response body (still logged server-side).
const PUBLIC_ERROR_CODES = new Set([
  'validation',
  'not_found',
  'unauthenticated',
  'invalid_token',
  'invalid_credentials',
  'account_disabled',
  'forbidden',
  'wrong_current_password',
  'user_not_found',
  'username_taken',
  'last_owner',
  'cannot_change_own_role',
  'cannot_deactivate_self',
  'cannot_delete_self',
  'admin_can_only_manage_operators',
  'admin_can_only_create_operators',
  'too_many_attempts',
  'invalid_path',
  'no_credentials_for_elevenlabs',
  'no_credentials_for_openai',
  'no_credentials_for_deepseek',
  'no_credentials_for_anthropic',
  'no_credentials_for_gemini',
]);

export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    logger.warn({ path: req.path, method: req.method, issues: err.flatten() }, 'validation error');
    return res.status(400).json({ error: 'validation', details: err.flatten() });
  }
  const status = err?.status ?? err?.statusCode ?? 500;
  const raw = err?.message;
  // 4xx → warn with context; 5xx → error with stack. Everything gets logged;
  // silence used to be the default and it made production incidents opaque.
  if (status >= 500) {
    logger.error({ err, path: req.path, method: req.method }, 'unhandled error');
    logDb.error('http', String(raw ?? 'internal_error'), { path: req.path, method: req.method, status });
  } else if (status >= 400) {
    logger.warn({ msg: raw, path: req.path, method: req.method, status }, 'client error');
  }
  // Body sanitation: expose known-safe codes verbatim; hide everything else
  // behind a generic tag so we never leak internal paths, prisma errors,
  // stack traces, or ffmpeg strings to the network.
  const publicCode = typeof raw === 'string' && PUBLIC_ERROR_CODES.has(raw) ? raw
    : status >= 500 ? 'internal_error' : 'bad_request';
  res.status(status).json({ error: publicCode });
}
