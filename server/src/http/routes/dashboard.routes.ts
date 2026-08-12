import { Router } from 'express';
import { prisma } from '../../lib/prisma.js';

export const dashboardRouter = Router();

dashboardRouter.get('/stats', async (_req, res, next) => {
  try {
    const [accounts, connectedAccounts, bots, recentMessages] = await Promise.all([
      prisma.whatsAppAccount.count(),
      prisma.whatsAppAccount.count({ where: { status: 'connected' } }),
      prisma.bot.count(),
      prisma.message.findMany({
        where: { direction: 'in' },
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: { contact: true, account: true },
      }),
    ]);
    const activeBots = await prisma.bot.count({ where: { isActive: true } });
    res.json({
      accounts,
      connectedAccounts,
      disconnectedAccounts: accounts - connectedAccounts,
      bots,
      activeBots,
      recentMessages: recentMessages.map((m) => ({
        id: m.id,
        body: m.body,
        contactName: m.contact.name,
        contactJid: m.contact.jid,
        accountName: m.account.name,
        createdAt: m.createdAt,
      })),
    });
  } catch (e) { next(e); }
});
