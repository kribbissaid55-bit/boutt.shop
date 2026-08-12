/**
 * InboxService — the human-side of the conversation engine.
 *
 * Lists conversations with rollups (last message, unread count, status,
 * tags, source). Wraps the existing send paths so admin manual sends flow
 * through the same per-account queue & anti-ban guards as bot sends, but
 * are tagged senderType='admin' for the inbox to display correctly.
 *
 * Reuses BotEngineService.manualSendText / manualSendMedia under the hood.
 */
import { prisma } from '../lib/prisma.js';
import { BotEngineService } from './BotEngineService.js';
import { SettingsService } from './SettingsService.js';
import { StepMatcherService } from './StepMatcherService.js';
import { normalizePhone, phoneToJid } from './phone.js';
import { deriveStatus, syncTagsForContact, type CustomerStatusKey } from './CustomerTagService.js';

// Admin-sent messages carrying ✅ mark the customer as "sold". This is the
// operator's manual signal — they type "تم البيع ✅" (or similar) in the
// Inbox and it flips the contact to status='ordered' and syncs the WhatsApp
// chat label. The follow-up engine then never re-targets this contact.
// No-op when the message doesn't contain ✅ or the contact is already ordered.
async function maybeMarkOrderedFromAdmin(contactId: string, body: string, accountId: string): Promise<void> {
  if (!body.includes('✅')) return;
  const cur = await prisma.contact.findUnique({ where: { id: contactId }, select: { status: true } });
  if (!cur || cur.status === 'ordered') return;
  await prisma.contact.update({ where: { id: contactId }, data: { status: 'ordered' } }).catch(() => {});
  void syncTagsForContact(null, accountId, contactId);
}

export type ConversationSummary = {
  id: string;
  jid: string;
  name: string | null;
  status: string;
  /** Derived "where are we" tag — drives the colored chip in the inbox. */
  derivedStatus: CustomerStatusKey | null;
  botPaused: boolean;
  doNotContact: boolean;
  tags: string[];
  source: string | null;
  city: string | null;
  unread: number;
  lastMessageBody: string | null;
  lastMessageType: string;
  lastMessageDirection: 'in' | 'out' | null;
  lastMessageAt: Date | null;
  account: { id: string; name: string };
};

const parseTags = (s: string | null): string[] => {
  if (!s) return [];
  try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch { return []; }
};

/**
 * Count how many bot replies this contact has received in the trailing 24h,
 * and read the active bot's per-customer cap so the inbox can show
 * "Replies today: X / Y." When cap = 0 (disabled), the display can simply
 * show the count.
 */
async function computeReplies24h(
  contactId: string,
  accountId: string,
): Promise<{ count: number; cap: number; resetsAt: string | null }> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [count, activeBot, oldest] = await Promise.all([
    prisma.message.count({
      where: {
        contactId, direction: 'out', senderType: 'bot',
        createdAt: { gte: since },
      },
    }),
    StepMatcherService.pickActiveBot(accountId),
    prisma.message.findFirst({
      where: {
        contactId, direction: 'out', senderType: 'bot',
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
  ]);
  let cap = 0;
  if (activeBot) {
    const cfg = await prisma.botAiConfig.findUnique({
      where: { botId: activeBot.id },
      select: { maxRepliesPerSession: true },
    });
    cap = cfg?.maxRepliesPerSession ?? 0;
  }
  const resetsAt = oldest
    ? new Date(oldest.createdAt.getTime() + 24 * 60 * 60 * 1000).toISOString()
    : null;
  return { count, cap, resetsAt };
}

export const InboxService = {
  /** List conversations for the inbox, applying filters & search. */
  async listConversations(opts: {
    accountId?: string;
    status?: string;
    botPaused?: boolean;
    needsHuman?: boolean;
    unreadOnly?: boolean;
    tag?: string;
    search?: string;
    take?: number;
    skip?: number;
  } = {}): Promise<ConversationSummary[]> {
    const where: any = {};
    if (opts.accountId) where.accountId = opts.accountId;
    if (opts.status) where.status = opts.status;
    if (opts.botPaused !== undefined) where.botPaused = opts.botPaused;
    if (opts.needsHuman) where.status = 'needs_human';
    if (opts.tag) where.tags = { contains: `"${opts.tag}"` };
    if (opts.search) {
      const s = opts.search.trim();
      where.OR = [
        { name:    { contains: s } },
        { jid:     { contains: s } },
        { city:    { contains: s } },
        { notes:   { contains: s } },
        { address: { contains: s } },
      ];
    }

    const contacts = await prisma.contact.findMany({
      where,
      include: { account: { select: { id: true, name: true } } },
      orderBy: [{ lastInteractionAt: 'desc' }, { lastSeenAt: 'desc' }],
      take: opts.take ?? 100,
      skip: opts.skip ?? 0,
    });

    // Latest message per contact + per-contact unread (incoming after lastOutgoingMessageAt)
    const ids = contacts.map((c) => c.id);
    if (!ids.length) return [];

    const lastMsgs = await prisma.message.findMany({
      where: { contactId: { in: ids } },
      orderBy: [{ contactId: 'asc' }, { createdAt: 'desc' }],
    });
    const lastByContact = new Map<string, typeof lastMsgs[number]>();
    for (const m of lastMsgs) {
      if (!lastByContact.has(m.contactId)) lastByContact.set(m.contactId, m);
    }

    const unreadCounts = await prisma.message.groupBy({
      by: ['contactId'],
      where: {
        contactId: { in: ids },
        direction: 'in',
        // unread = incoming after the contact's lastOutgoingMessageAt (or all if never replied)
      },
      _count: { _all: true },
    });
    const unreadMap = new Map<string, number>();
    for (const u of unreadCounts) unreadMap.set(u.contactId, u._count._all);

    const list = contacts.map<ConversationSummary>((c) => {
      const last = lastByContact.get(c.id);
      let unread = 0;
      if (c.lastOutgoingMessageAt) {
        // count incoming after lastOutgoing
        // (cheap heuristic: total in - those before lastOut). For Phase 1 use total in.
        unread = unreadMap.get(c.id) ?? 0;
      } else {
        unread = unreadMap.get(c.id) ?? 0;
      }
      return {
        id: c.id,
        jid: c.jid,
        name: c.name,
        status: c.status,
        derivedStatus: deriveStatus({
          status: c.status,
          lastIncomingMessageAt: c.lastIncomingMessageAt,
          lastOutgoingMessageAt: c.lastOutgoingMessageAt,
          aiOrderDraft: (c as any).aiOrderDraft ?? null,
        }),
        botPaused: c.botPaused,
        doNotContact: c.doNotContact,
        tags: parseTags(c.tags),
        source: c.source,
        city: c.city,
        unread,
        lastMessageBody: last?.body ?? null,
        lastMessageType: last?.type ?? 'text',
        lastMessageDirection: (last?.direction as 'in' | 'out') ?? null,
        lastMessageAt: last?.createdAt ?? c.lastInteractionAt ?? null,
        account: c.account,
      };
    });

    if (opts.unreadOnly) return list.filter((c) => c.unread > 0);
    return list;
  },

  /**
   * Paginated conversation loader.
   *
   * Defaults to the newest 30 messages (ascending order for display). Pass
   * `before` (ISO timestamp) to load the previous batch of `take` messages —
   * used by the "Load older" button in the chat thread. Returns `hasMore:true`
   * when there is at least one older message beyond this page, computed
   * cheaply via a `take + 1` overshoot instead of a separate COUNT query.
   */
  async getConversation(contactId: string, opts?: { take?: number; before?: string }) {
    const take = Math.min(200, Math.max(1, opts?.take ?? 30));

    const contact = await prisma.contact.findUnique({
      where: { id: contactId },
      include: {
        account: true,
        notesList: { orderBy: { createdAt: 'desc' }, take: 50 },
        orders:    { orderBy: { createdAt: 'desc' }, take: 20 },
      },
    });
    if (!contact) return null;

    const where: any = { contactId };
    if (opts?.before) where.createdAt = { lt: new Date(opts.before) };

    const rows = await prisma.message.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: take + 1,
    });
    const hasMore = rows.length > take;
    const trimmed = hasMore ? rows.slice(0, take) : rows;
    const messages = trimmed.reverse(); // oldest → newest for display

    // Operator visibility — replies to this customer in the trailing 24h,
    // vs the per-customer cap on the active bot's AI config. Lets the
    // operator instantly see WHY a specific customer isn't getting replies
    // (cap hit) vs some other reason (paused, cooldown, etc.).
    const repliesLast24h = await computeReplies24h(contact.id, contact.accountId);

    return {
      contact: {
        ...contact,
        tags: parseTags(contact.tags),
        repliesLast24h,
      },
      messages,
      hasMore,
    };
  },

  /** Send a text manually. Tagged senderType='admin' and optionally pauses the bot. */
  async sendText(contactId: string, text: string) {
    const c = await prisma.contact.findUniqueOrThrow({ where: { id: contactId } });
    if (c.doNotContact) {
      throw Object.assign(new Error('contact_marked_do_not_contact'), { status: 409 });
    }
    const settings = await SettingsService.load();

    // Use the engine's manual path — already enqueues + persists with status tracking.
    await BotEngineService.manualSendText(c.accountId, c.id, c.jid, text);

    // Tag the most recent outgoing as admin (manualSendText writes 'pending'/'sent'
    // but doesn't set senderType — we patch it here once it lands).
    // Best-effort; if the row hasn't landed yet it'll be tagged on the next call.
    setTimeout(async () => {
      const last = await prisma.message.findFirst({
        where: { contactId, direction: 'out' },
        orderBy: { createdAt: 'desc' },
      });
      if (last && !last.senderType) {
        await prisma.message.update({ where: { id: last.id }, data: { senderType: 'admin' } });
      }
    }, 200);

    // Auto-pause if configured
    const autoPause = (settings as any).auto_pause_on_manual_reply ?? true;
    if (autoPause && !c.botPaused) {
      await prisma.contact.update({ where: { id: c.id }, data: { botPaused: true } });
    }

    // ✅ auto-flip: admin typed the "sold" marker.
    void maybeMarkOrderedFromAdmin(contactId, text, c.accountId);
  },

  /** Send media (image/audio/video/document) by mediaId. */
  async sendMedia(contactId: string, mediaId: string, caption?: string) {
    const c = await prisma.contact.findUniqueOrThrow({ where: { id: contactId } });
    if (c.doNotContact) {
      throw Object.assign(new Error('contact_marked_do_not_contact'), { status: 409 });
    }
    const media = await prisma.mediaFile.findUniqueOrThrow({ where: { id: mediaId } });
    await BotEngineService.manualSendMedia(c.accountId, c.id, c.jid, media, caption);

    // Tag as admin (best-effort)
    setTimeout(async () => {
      const last = await prisma.message.findFirst({
        where: { contactId, direction: 'out', mediaId },
        orderBy: { createdAt: 'desc' },
      });
      if (last && !last.senderType) {
        await prisma.message.update({ where: { id: last.id }, data: { senderType: 'admin' } });
      }
    }, 200);

    // ✅ auto-flip: admin included the "sold" marker in the media caption.
    if (caption) void maybeMarkOrderedFromAdmin(contactId, caption, c.accountId);
  },

  async pauseBot(contactId: string) {
    return prisma.contact.update({ where: { id: contactId }, data: { botPaused: true } });
  },
  async resumeBot(contactId: string) {
    return prisma.contact.update({ where: { id: contactId }, data: { botPaused: false } });
  },
  async setStatus(contactId: string, status: string) {
    // When the operator moves a contact AWAY from 'ordered', also wipe the
    // aiOrderDraft. Otherwise the draft's `finalized:true` marker keeps
    // buildLayeredSystemMessage in post-order QUIET mode, and the LLM keeps
    // returning near-empty replies (which then get replaced by the canned
    // "please rephrase" message). This makes the status pill do what
    // operators intuitively expect: a real "reset this order" action.
    // Setting status TO 'ordered' does NOT touch the draft — a legitimate
    // order finalization should keep its collected fields.
    const patch: any = { status };
    if (status !== 'ordered') patch.aiOrderDraft = null;
    return prisma.contact.update({ where: { id: contactId }, data: patch });
  },
  async setTags(contactId: string, tags: string[]) {
    const clean = Array.from(new Set(tags.map((t) => t.trim()).filter(Boolean))).slice(0, 50);
    return prisma.contact.update({ where: { id: contactId }, data: { tags: JSON.stringify(clean) } });
  },
  async addNote(contactId: string, body: string) {
    if (!body.trim()) throw Object.assign(new Error('empty_note'), { status: 400 });
    return prisma.customerNote.create({ data: { contactId, body: body.trim() } });
  },
  async deleteNote(noteId: string) {
    return prisma.customerNote.delete({ where: { id: noteId } });
  },
  async setProfile(contactId: string, patch: { name?: string; city?: string; address?: string }) {
    return prisma.contact.update({ where: { id: contactId }, data: patch });
  },
  async setDoNotContact(contactId: string, doNotContact: boolean) {
    return prisma.contact.update({ where: { id: contactId }, data: { doNotContact } });
  },

  /**
   * Start a new conversation by phone number — creates the Contact row so the
   * admin can send the first message before the customer replies. The phone
   * is normalized (handles Moroccan local form, +CC, spaces, dashes). If a
   * contact already exists for (account, jid) we return it as-is.
   */
  async startConversation(opts: { accountId: string; phone: string; name?: string }) {
    const acc = await prisma.whatsAppAccount.findUnique({ where: { id: opts.accountId } });
    if (!acc) throw Object.assign(new Error('account_not_found'), { status: 404 });
    const phone = normalizePhone(opts.phone);
    if (!phone) throw Object.assign(new Error('invalid_phone'), { status: 400 });
    const jid = phoneToJid(phone);

    const existing = await prisma.contact.findUnique({
      where: { accountId_jid: { accountId: opts.accountId, jid } },
    });
    if (existing) {
      // Optionally bump the name
      if (opts.name && opts.name.trim() && existing.name !== opts.name.trim()) {
        return prisma.contact.update({
          where: { id: existing.id },
          data: { name: opts.name.trim() },
        });
      }
      return existing;
    }

    return prisma.contact.create({
      data: {
        accountId: opts.accountId,
        jid,
        name: opts.name?.trim() || null,
        source: 'manual',
      },
    });
  },
};
