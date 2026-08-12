import { Router } from 'express';
import { z } from 'zod';
import { InboxService } from '../../services/InboxService.js';

export const inboxRouter = Router();

inboxRouter.get('/conversations', async (req, res, next) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const conversations = await InboxService.listConversations({
      accountId: q.accountId,
      status: q.status,
      botPaused: q.botPaused === 'true' ? true : q.botPaused === 'false' ? false : undefined,
      needsHuman: q.needsHuman === 'true',
      unreadOnly: q.unread === 'true',
      tag: q.tag,
      search: q.search,
      take: q.take ? Math.min(500, +q.take) : 100,
      skip: q.skip ? +q.skip : 0,
    });
    res.json(conversations);
  } catch (e) { next(e); }
});

const StartConversationSchema = z.object({
  accountId: z.string().min(1),
  phone: z.string().min(3).max(50),
  name: z.string().max(120).optional(),
});
inboxRouter.post('/conversations/new', async (req, res, next) => {
  try {
    const data = StartConversationSchema.parse(req.body);
    const contact = await InboxService.startConversation(data);
    res.status(201).json(contact);
  } catch (e) { next(e); }
});

inboxRouter.get('/conversations/:contactId', async (req, res, next) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const out = await InboxService.getConversation(req.params.contactId, {
      take: q.take ? Math.min(200, Math.max(1, +q.take)) : undefined,
      before: q.before || undefined,
    });
    if (!out) return res.status(404).json({ error: 'not_found' });
    res.json(out);
  } catch (e) { next(e); }
});

const SendTextSchema = z.object({ text: z.string().min(1).max(4096) });
inboxRouter.post('/conversations/:contactId/send-text', async (req, res, next) => {
  try {
    const { text } = SendTextSchema.parse(req.body);
    await InboxService.sendText(req.params.contactId, text);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

const SendMediaSchema = z.object({ mediaId: z.string().min(1), caption: z.string().max(1024).optional() });
inboxRouter.post('/conversations/:contactId/send-media', async (req, res, next) => {
  try {
    const { mediaId, caption } = SendMediaSchema.parse(req.body);
    await InboxService.sendMedia(req.params.contactId, mediaId, caption);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

inboxRouter.post('/conversations/:contactId/pause-bot', async (req, res, next) => {
  try { res.json(await InboxService.pauseBot(req.params.contactId)); } catch (e) { next(e); }
});
inboxRouter.post('/conversations/:contactId/resume-bot', async (req, res, next) => {
  try { res.json(await InboxService.resumeBot(req.params.contactId)); } catch (e) { next(e); }
});

const StatusSchema = z.object({
  status: z.enum(['new', 'interested', 'ordered', 'rejected', 'needs_human', 'cold', 'hot']),
});
inboxRouter.post('/conversations/:contactId/status', async (req, res, next) => {
  try {
    const { status } = StatusSchema.parse(req.body);
    res.json(await InboxService.setStatus(req.params.contactId, status));
  } catch (e) { next(e); }
});

const TagsSchema = z.object({ tags: z.array(z.string().min(1).max(40)).max(50) });
inboxRouter.post('/conversations/:contactId/tags', async (req, res, next) => {
  try {
    const { tags } = TagsSchema.parse(req.body);
    res.json(await InboxService.setTags(req.params.contactId, tags));
  } catch (e) { next(e); }
});

const NoteSchema = z.object({ body: z.string().min(1).max(2000) });
inboxRouter.post('/conversations/:contactId/notes', async (req, res, next) => {
  try {
    const { body } = NoteSchema.parse(req.body);
    res.status(201).json(await InboxService.addNote(req.params.contactId, body));
  } catch (e) { next(e); }
});
inboxRouter.delete('/notes/:noteId', async (req, res, next) => {
  try { await InboxService.deleteNote(req.params.noteId); res.json({ ok: true }); }
  catch (e) { next(e); }
});

const ProfileSchema = z.object({
  name: z.string().max(120).optional(),
  city: z.string().max(80).optional(),
  address: z.string().max(500).optional(),
});
inboxRouter.patch('/conversations/:contactId/profile', async (req, res, next) => {
  try {
    const data = ProfileSchema.parse(req.body);
    res.json(await InboxService.setProfile(req.params.contactId, data));
  } catch (e) { next(e); }
});

const DnCSchema = z.object({ doNotContact: z.boolean() });
inboxRouter.post('/conversations/:contactId/do-not-contact', async (req, res, next) => {
  try {
    const { doNotContact } = DnCSchema.parse(req.body);
    res.json(await InboxService.setDoNotContact(req.params.contactId, doNotContact));
  } catch (e) { next(e); }
});
