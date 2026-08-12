import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { requireRole, type AuthedRequest, type UserRole } from '../middleware/auth.js';

export const adminRouter = Router();

const ROLES: UserRole[] = ['owner', 'admin', 'operator'];
const RoleSchema = z.enum(['owner', 'admin', 'operator']);

// All routes here gated to owner + admin. Owner has full power; admin can only
// manage operators (enforced below per-op).
adminRouter.use(requireRole('owner', 'admin'));

function safeSelect() {
  return {
    id: true,
    username: true,
    role: true,
    isActive: true,
    email: true,
    lastLoginAt: true,
    createdAt: true,
    createdById: true,
  } as const;
}

adminRouter.get('/users', async (_req: AuthedRequest, res, next) => {
  try {
    const users = await prisma.adminUser.findMany({
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
      select: safeSelect(),
    });
    res.json(users);
  } catch (e) { next(e); }
});

const CreateUserSchema = z.object({
  username: z.string().min(3).max(64),
  password: z.string().min(8),
  role: RoleSchema,
  email: z.string().email().optional().nullable(),
});

adminRouter.post('/users', async (req: AuthedRequest, res, next) => {
  try {
    const body = CreateUserSchema.parse(req.body);
    const actor = req.user!;
    // Admin cannot create owner or another admin.
    if (actor.role === 'admin' && body.role !== 'operator') {
      return res.status(403).json({ error: 'admin_can_only_create_operators' });
    }
    const existing = await prisma.adminUser.findUnique({ where: { username: body.username } });
    if (existing) return res.status(400).json({ error: 'username_taken' });
    const passwordHash = await bcrypt.hash(body.password, 12);
    const created = await prisma.adminUser.create({
      data: {
        username: body.username,
        passwordHash,
        role: body.role,
        email: body.email ?? null,
        createdById: actor.id,
      },
      select: safeSelect(),
    });
    res.status(201).json(created);
  } catch (e) { next(e); }
});

const UpdateUserSchema = z.object({
  role: RoleSchema.optional(),
  isActive: z.boolean().optional(),
  email: z.string().email().nullable().optional(),
});

adminRouter.patch('/users/:id', async (req: AuthedRequest, res, next) => {
  try {
    const body = UpdateUserSchema.parse(req.body);
    const actor = req.user!;
    const id = req.params.id;
    const target = await prisma.adminUser.findUnique({ where: { id } });
    if (!target) return res.status(404).json({ error: 'user_not_found' });

    // Guard: nobody can demote or deactivate themselves — prevents accidental lockout.
    if (target.id === actor.id) {
      if (body.role && body.role !== actor.role) {
        return res.status(400).json({ error: 'cannot_change_own_role' });
      }
      if (body.isActive === false) {
        return res.status(400).json({ error: 'cannot_deactivate_self' });
      }
    }

    // Guard: last active owner protection.
    if (target.role === 'owner' && (body.role && body.role !== 'owner' || body.isActive === false)) {
      const activeOwners = await prisma.adminUser.count({
        where: { role: 'owner', isActive: true },
      });
      if (activeOwners <= 1) {
        return res.status(400).json({ error: 'last_owner' });
      }
    }

    // Guard: admin can only manage operators, and cannot promote to admin/owner.
    if (actor.role === 'admin') {
      if (target.role !== 'operator') {
        return res.status(403).json({ error: 'admin_can_only_manage_operators' });
      }
      if (body.role && body.role !== 'operator') {
        return res.status(403).json({ error: 'admin_can_only_manage_operators' });
      }
    }

    const updated = await prisma.adminUser.update({
      where: { id },
      data: {
        ...(body.role != null ? { role: body.role } : {}),
        ...(body.isActive != null ? { isActive: body.isActive } : {}),
        ...(body.email !== undefined ? { email: body.email } : {}),
      },
      select: safeSelect(),
    });
    res.json(updated);
  } catch (e) { next(e); }
});

adminRouter.delete('/users/:id', async (req: AuthedRequest, res, next) => {
  try {
    const actor = req.user!;
    const id = req.params.id;
    const target = await prisma.adminUser.findUnique({ where: { id } });
    if (!target) return res.status(404).json({ error: 'user_not_found' });
    if (target.id === actor.id) return res.status(400).json({ error: 'cannot_delete_self' });
    if (actor.role === 'admin' && target.role !== 'operator') {
      return res.status(403).json({ error: 'admin_can_only_manage_operators' });
    }
    if (target.role === 'owner') {
      const activeOwners = await prisma.adminUser.count({
        where: { role: 'owner', isActive: true },
      });
      if (activeOwners <= 1) {
        return res.status(400).json({ error: 'last_owner' });
      }
    }
    await prisma.adminUser.delete({ where: { id } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

const ResetPasswordSchema = z.object({
  newPassword: z.string().min(8),
});

adminRouter.post('/users/:id/reset-password', async (req: AuthedRequest, res, next) => {
  try {
    const actor = req.user!;
    const id = req.params.id;
    const { newPassword } = ResetPasswordSchema.parse(req.body);
    const target = await prisma.adminUser.findUnique({ where: { id } });
    if (!target) return res.status(404).json({ error: 'user_not_found' });
    if (actor.role === 'admin' && target.role !== 'operator') {
      return res.status(403).json({ error: 'admin_can_only_manage_operators' });
    }
    const passwordHash = await bcrypt.hash(newPassword, 12);
    await prisma.adminUser.update({ where: { id }, data: { passwordHash } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Silence unused-role warning while keeping the exhaustive list for future use.
void ROLES;
