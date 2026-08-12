/**
 * UnsubscribeWatcher — checks an incoming customer text against a configurable
 * keyword list. On a hit:
 *   1. Set contact.doNotContact = true
 *   2. Cancel all pending FollowUpLog rows for this contact
 *   3. Cancel all pending RetargetingCampaignLog rows for this contact
 *   4. Append a CustomerNote
 *
 * The optional confirmation reply is left to the caller (engine) since it
 * needs to flow through the per-account queue.
 */
import { prisma } from '../lib/prisma.js';
import { normalizeText } from '../lib/jid.js';
import { SettingsService } from './SettingsService.js';

const DEFAULT_KEYWORDS = [
  'stop', 'cancel', 'unsubscribe',
  'لا تراسلني', 'باراكا', 'صافي', 'مبغيتش', 'ما تبقاش تصيفط', 'حذف',
];

export const UnsubscribeWatcher = {
  /** Returns true if the message matched and triggered cancellation. */
  async check(opts: { contactId: string; text: string }): Promise<{
    matched: boolean;
    keyword?: string;
    canceledFollowups?: number;
    canceledCampaignLogs?: number;
  }> {
    const norm = normalizeText(opts.text);
    if (!norm) return { matched: false };

    const settings = await SettingsService.load();
    const cfgKeywords = (settings as any).unsubscribe_keywords as string[] | undefined;
    const keywords = (Array.isArray(cfgKeywords) && cfgKeywords.length ? cfgKeywords : DEFAULT_KEYWORDS)
      .map((k) => normalizeText(k));

    const matched = keywords.find((kw) => norm.includes(kw));
    if (!matched) return { matched: false };

    // Mark DNC
    const contact = await prisma.contact.update({
      where: { id: opts.contactId },
      data: { doNotContact: true },
    }).catch(() => null);

    // Cancel pending follow-up logs
    const fu = await prisma.followUpLog.updateMany({
      where: { contactId: opts.contactId, status: 'pending' },
      data: { status: 'canceled', reason: 'unsubscribe' },
    });

    // Cancel pending campaign logs
    const cl = await prisma.retargetingCampaignLog.updateMany({
      where: { contactId: opts.contactId, status: 'pending' },
      data: { status: 'canceled', reason: 'unsubscribe' },
    });

    // Add a customer note for transparency
    await prisma.customerNote.create({
      data: {
        contactId: opts.contactId,
        body: 'Customer requested no more messages (unsubscribe keyword detected)',
      },
    }).catch(() => {});

    return {
      matched: true,
      keyword: matched,
      canceledFollowups: fu.count,
      canceledCampaignLogs: cl.count,
    };
    void contact;
  },
};
