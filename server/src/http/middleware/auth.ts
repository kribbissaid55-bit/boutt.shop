import type { Request, Response, NextFunction } from 'express';
import type { CookieOptions } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';

export type UserRole = 'owner' | 'admin' | 'operator';

export interface AuthedRequest extends Request {
  user?: { id: string; username: string; role: UserRole };
}

export const COOKIE_NAME = 'bsa_session';

// Shared cookie options for every set/clear across auth + admin routes.
// - httpOnly: JS in the page can never read the session cookie.
// - secure: forced true in production regardless of other config.
// - sameSite: 'none' when we're serving cross-origin (requires secure=true).
//             'lax' when same-origin (default, works with CSRF-safe methods).
// - domain: only when env.COOKIE_DOMAIN is set (cross-origin sub-domain deploys).
export function cookieOpts(): CookieOptions {
  const isProd = env.NODE_ENV === 'production';
  const crossOrigin = env.IS_CROSS_ORIGIN;
  return {
    httpOnly: true,
    secure: isProd || crossOrigin,
    sameSite: crossOrigin ? 'none' : 'lax',
    maxAge: 2 * 24 * 3600 * 1000,
    path: '/',
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  };
}

// 2-day expiry — long enough that operators don't re-log daily, short enough
// that a stolen cookie doesn't linger for weeks. Matches cookieOpts().maxAge.
export function signToken(payload: { id: string; username: string; role: UserRole }) {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: '2d' });
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const tok = req.cookies?.[COOKIE_NAME];
  if (!tok) return res.status(401).json({ error: 'unauthenticated' });
  try {
    const payload = jwt.verify(tok, env.JWT_SECRET) as { id: string; username: string; role?: UserRole };
    // Legacy tokens issued before roles existed default to 'owner' so the seed
    // account keeps working across a version bump without re-login.
    req.user = { id: payload.id, username: payload.username, role: payload.role ?? 'owner' };
    next();
  } catch {
    res.status(401).json({ error: 'invalid_token' });
  }
}

export function requireRole(...allowed: UserRole[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const role = req.user?.role ?? 'operator';
    if (!allowed.includes(role)) return res.status(403).json({ error: 'forbidden' });
    next();
  };
}
