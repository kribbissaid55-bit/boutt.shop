import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import {
  COOKIE_NAME,
  cookieOpts,
  requireAuth,
  signToken,
  type AuthedRequest,
  type UserRole,
} from '../middleware/auth.js';
import { env } from '../../config/env.js';

export const authRouter = Router();

const LoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

// Brute-force guard on credential-touching endpoints. 10 attempts per 15 min
// per IP is comfortable for a real operator (test/retype) but stops password
// spraying. Skipped in the test environment to keep unit tests fast.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => env.NODE_ENV === 'test',
  message: { error: 'too_many_attempts' },
});

authRouter.post('/login', authLimiter, async (req, res, next) => {
  try {
    const { username, password } = LoginSchema.parse(req.body);
    const user = await prisma.adminUser.findUnique({ where: { username } });
    if (!user) return res.status(401).json({ error: 'invalid_credentials' });
    if (!user.isActive) return res.status(401).json({ error: 'account_disabled' });
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'invalid_credentials' });
    const role = (user.role as UserRole) ?? 'owner';
    const token = signToken({ id: user.id, username: user.username, role });
    res.cookie(COOKIE_NAME, token, cookieOpts());
    // Side-effect: record login time so the team table can show it.
    prisma.adminUser
      .update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
      .catch(() => {});
    res.json({ id: user.id, username: user.username, role });
  } catch (e) { next(e); }
});

authRouter.post('/logout', (_req, res) => {
  // Clear must use the same path (and domain, if set) as the set-cookie call.
  const { maxAge: _mx, ...clearOpts } = cookieOpts();
  void _mx;
  res.clearCookie(COOKIE_NAME, clearOpts);
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, (req: AuthedRequest, res) => {
  res.json(req.user);
});

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

authRouter.post('/change-password', authLimiter, requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const { currentPassword, newPassword } = ChangePasswordSchema.parse(req.body);
    const user = await prisma.adminUser.findUnique({ where: { id: req.user!.id } });
    if (!user) return res.status(404).json({ error: 'user_not_found' });
    const ok = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!ok) return res.status(400).json({ error: 'wrong_current_password' });
    const passwordHash = await bcrypt.hash(newPassword, 12);
    await prisma.adminUser.update({ where: { id: user.id }, data: { passwordHash } });
    // Rotate the cookie so tab stays authenticated with fresh credentials.
    const role = (user.role as UserRole) ?? 'owner';
    const token = signToken({ id: user.id, username: user.username, role });
    res.cookie(COOKIE_NAME, token, cookieOpts());
    res.json({ ok: true });
  } catch (e) { next(e); }
});
