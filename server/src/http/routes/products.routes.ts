/**
 * Products CRUD + bot linkage.
 *
 *   GET    /products
 *   POST   /products
 *   GET    /products/:id
 *   PATCH  /products/:id
 *   DELETE /products/:id
 *
 *   GET    /bots/:botId/products       — products linked to this bot
 *   POST   /bots/:botId/products       — link { productId }
 *   DELETE /bots/:botId/products/:productId — unlink
 *
 * Media is referenced by MediaFile id (no duplication). Tags/mediaIds are
 * stored as JSON strings in SQLite and parsed at the boundary.
 */
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';

export const productsRouter = Router();

function serialize(p: any) {
  return {
    ...p,
    tags: safe(p.tags) ?? [],
    mediaIds: safe(p.mediaIds) ?? [],
  };
}
function safe<T = any>(s: string | null | undefined): T | null {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

productsRouter.get('/', async (_req, res, next) => {
  try {
    const rows = await prisma.product.findMany({ orderBy: { createdAt: 'desc' } });
    res.json(rows.map(serialize));
  } catch (e) { next(e); }
});

productsRouter.get('/:id', async (req, res, next) => {
  try {
    const p = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!p) return res.status(404).json({ error: 'not_found' });
    res.json(serialize(p));
  } catch (e) { next(e); }
});

const CreateSchema = z.object({
  name: z.string().min(1).max(160),
  description: z.string().max(4000).nullable().optional(),
  price: z.string().max(40).nullable().optional(),
  currency: z.string().max(8).nullable().optional(),
  sku: z.string().max(80).nullable().optional(),
  tags: z.array(z.string().min(1).max(40)).max(40).nullable().optional(),
  mediaIds: z.array(z.string().min(1)).max(20).nullable().optional(),
  isActive: z.boolean().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

productsRouter.post('/', async (req, res, next) => {
  try {
    const data = CreateSchema.parse(req.body);
    const row = await prisma.product.create({
      data: {
        name: data.name.trim(),
        description: data.description ?? null,
        price: data.price ?? null,
        currency: data.currency ?? null,
        sku: data.sku ?? null,
        tags: data.tags ? JSON.stringify(data.tags) : null,
        mediaIds: data.mediaIds ? JSON.stringify(data.mediaIds) : null,
        isActive: data.isActive ?? true,
        notes: data.notes ?? null,
      },
    });
    res.status(201).json(serialize(row));
  } catch (e) { next(e); }
});

const PatchSchema = CreateSchema.partial();

productsRouter.patch('/:id', async (req, res, next) => {
  try {
    const data = PatchSchema.parse(req.body);
    const patch: any = { ...data };
    if (data.tags !== undefined) patch.tags = data.tags === null ? null : JSON.stringify(data.tags);
    if (data.mediaIds !== undefined) patch.mediaIds = data.mediaIds === null ? null : JSON.stringify(data.mediaIds);
    if (data.name !== undefined) patch.name = data.name.trim();
    const row = await prisma.product.update({ where: { id: req.params.id }, data: patch });
    res.json(serialize(row));
  } catch (e) { next(e); }
});

productsRouter.delete('/:id', async (req, res, next) => {
  try {
    await prisma.product.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── Bot linkage ──────────────────────────────────────────────────────────

productsRouter.get('/bot/:botId', async (req, res, next) => {
  try {
    const links = await prisma.botProduct.findMany({
      where: { botId: req.params.botId },
      include: { product: true },
    });
    res.json(links.map((l) => serialize(l.product)));
  } catch (e) { next(e); }
});

const LinkSchema = z.object({ productId: z.string().min(1) });

productsRouter.post('/bot/:botId/link', async (req, res, next) => {
  try {
    const { productId } = LinkSchema.parse(req.body);
    await prisma.botProduct.upsert({
      where: { botId_productId: { botId: req.params.botId, productId } },
      update: {},
      create: { botId: req.params.botId, productId },
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

productsRouter.delete('/bot/:botId/link/:productId', async (req, res, next) => {
  try {
    await prisma.botProduct.delete({
      where: { botId_productId: { botId: req.params.botId, productId: req.params.productId } },
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});
