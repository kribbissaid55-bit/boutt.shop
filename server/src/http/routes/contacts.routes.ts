import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { ContactService } from '../../services/ContactService.js';
import { BotEngineService } from '../../services/BotEngineService.js';
import { MediaService } from '../../services/MediaService.js';

export const contactsRouter = Router();

contactsRouter.get('/', async (req, res, next) => {
  try {
    const { accountId, status, search } = req.query as Record<string, string | undefined>;
    const where: any = {};
    if (accountId) where.accountId = accountId;
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { name: { contains: search } },
        { jid: { contains: search } },
      ];
    }
    const contacts = await prisma.contact.findMany({
      where,
      orderBy: { lastSeenAt: 'desc' },
      take: 200,
      include: { account: true },
    });
    res.json(contacts);
  } catch (e) { next(e); }
});

contactsRouter.get('/:id', async (req, res, next) => {
  try {
    const c = await prisma.contact.findUnique({
      where: { id: req.params.id },
      include: { account: true },
    });
    if (!c) return res.status(404).json({ error: 'not_found' });
    res.json(c);
  } catch (e) { next(e); }
});

const PatchSchema = z.object({
  name: z.string().max(120).nullish(),
  status: z.enum(['new', 'interested', 'ordered', 'rejected', 'needs_human']).optional(),
  botPaused: z.boolean().optional(),
  notes: z.string().max(2000).nullish(),
});
contactsRouter.patch('/:id', async (req, res, next) => {
  try {
    const data = PatchSchema.parse(req.body);
    res.json(await prisma.contact.update({ where: { id: req.params.id }, data }));
  } catch (e) { next(e); }
});

contactsRouter.get('/:id/messages', async (req, res, next) => {
  try {
    const msgs = await prisma.message.findMany({
      where: { contactId: req.params.id },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { mediaId: false } as any,
    });
    res.json(msgs.reverse());
  } catch (e) { next(e); }
});

const SendSchema = z.object({
  text: z.string().max(4096).optional(),
  mediaId: z.string().optional(),
  caption: z.string().max(1024).optional(),
}).refine((d) => d.text || d.mediaId, { message: 'text or mediaId required' });

contactsRouter.post('/:id/messages', async (req, res, next) => {
  try {
    const data = SendSchema.parse(req.body);
    const c = await prisma.contact.findUnique({ where: { id: req.params.id } });
    if (!c) return res.status(404).json({ error: 'not_found' });
    if (data.text) {
      await BotEngineService.runRawText(c.accountId, c.id, c.jid, data.text);
    }
    if (data.mediaId) {
      const media = await prisma.mediaFile.findUnique({ where: { id: data.mediaId } });
      if (!media) return res.status(404).json({ error: 'media_not_found' });
      void MediaService; // ensure import side-effects (none)
      await BotEngineService.enqueueMedia(c.accountId, c.id, c.jid, media, data.caption);
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

void ContactService; // used elsewhere
