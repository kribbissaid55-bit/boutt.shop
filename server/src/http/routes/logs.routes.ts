import { Router } from 'express';
import { prisma } from '../../lib/prisma.js';

export const logsRouter = Router();

logsRouter.get('/', async (req, res, next) => {
  try {
    const { level, scope, accountId } = req.query as Record<string, string | undefined>;
    const where: any = {};
    if (level) where.level = level;
    if (scope) where.scope = scope;
    if (accountId) where.accountId = accountId;
    const items = await prisma.logEntry.findMany({ where, orderBy: { createdAt: 'desc' }, take: 300 });
    res.json(items);
  } catch (e) { next(e); }
});
