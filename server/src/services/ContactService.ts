import { prisma } from '../lib/prisma.js';

export const ContactService = {
  /**
   * `phoneJid` is the phone-bearing JID resolved from Baileys' senderPn when
   * the routing jid is a privacy `@lid`. It's persisted lazily — once a
   * contact acquires a known phoneJid, subsequent calls that don't supply
   * one preserve the stored value (never null it out).
   */
  async findOrCreate(accountId: string, jid: string, name?: string, phoneJid?: string) {
    const existing = await prisma.contact.findUnique({
      where: { accountId_jid: { accountId, jid } },
    });
    if (existing) {
      const patch: Record<string, unknown> = { lastSeenAt: new Date() };
      if (name && existing.name !== name) patch.name = name;
      // Backfill phoneJid the first time we learn it — never overwrite a
      // known value with a different guess.
      if (phoneJid && !(existing as any).phoneJid) patch.phoneJid = phoneJid;
      return prisma.contact.update({ where: { id: existing.id }, data: patch });
    }
    return prisma.contact.create({
      data: { accountId, jid, name, phoneJid, lastSeenAt: new Date() } as any,
    });
  },

  async setStatus(id: string, status: string) {
    return prisma.contact.update({ where: { id }, data: { status } });
  },

  async pause(id: string, paused: boolean) {
    return prisma.contact.update({ where: { id }, data: { botPaused: paused } });
  },

  async setNote(id: string, notes: string) {
    return prisma.contact.update({ where: { id }, data: { notes } });
  },

  async setCurrentStep(id: string, currentStepId: string | null) {
    return prisma.contact.update({ where: { id }, data: { currentStepId } });
  },
};
