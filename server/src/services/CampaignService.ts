/**
 * CampaignService — CRUD + lifecycle for retargeting campaigns.
 *
 * The "start" lifecycle step materializes recipient rows in
 * RetargetingCampaignLog. The unique(campaignId, contactId) constraint
 * prevents duplicate rows even on retry.
 *
 * The actual sending is done by CampaignEngine (one timer per running
 * campaign). State is fully in DB so server restart is safe.
 */
import { prisma } from '../lib/prisma.js';
import { SegmentService } from './SegmentService.js';
import type { MessageSequence } from '../engine/runMessageSequence.js';

export type CampaignStatus = 'draft' | 'scheduled' | 'running' | 'paused' | 'completed' | 'canceled' | 'failed';

export interface SendingSpeed {
  perMinute?: number;
  perHour?: number;
  jitterMs?: number;
}

export interface StopConditions {
  onReply?: boolean;       // skip contact if they reply mid-campaign
  onOrdered?: boolean;     // skip contact if status flips to 'ordered'
  onRejected?: boolean;
  doNotContact?: boolean;  // always honored
  skipIfContactedHours?: number;  // skip if contact got an outgoing in last N hours
}

const stringify = (v: unknown): string | null =>
  v === undefined || v === null ? null : JSON.stringify(v);
const safeJson = <T>(s: string | null, fallback: T): T => {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
};

export const CampaignService = {
  list() {
    return prisma.retargetingCampaign.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        segment: { select: { id: true, name: true } },
        account: { select: { id: true, name: true, status: true } },
        _count: { select: { logs: true } },
      },
    });
  },

  async get(id: string) {
    return prisma.retargetingCampaign.findUnique({
      where: { id },
      include: {
        segment: { select: { id: true, name: true } },
        account: { select: { id: true, name: true, status: true, phoneNumber: true } },
        _count: { select: { logs: true } },
      },
    });
  },

  create(data: {
    name: string;
    description?: string;
    segmentId: string;
    accountId: string;
    messageSequence: MessageSequence;
    scheduleAt?: Date;
    sendingSpeed?: SendingSpeed;
    stopConditions?: StopConditions;
  }) {
    return prisma.retargetingCampaign.create({
      data: {
        name: data.name.trim(),
        description: data.description ?? null,
        segmentId: data.segmentId,
        accountId: data.accountId,
        status: 'draft',
        messageSequence: JSON.stringify(data.messageSequence),
        scheduleAt: data.scheduleAt ?? null,
        sendingSpeed: stringify(data.sendingSpeed ?? { perMinute: 5, jitterMs: 5000 }),
        stopConditions: stringify(data.stopConditions ?? {
          onReply: true, onOrdered: true, onRejected: true, doNotContact: true,
        }),
      },
    });
  },

  update(id: string, data: Partial<{
    name: string;
    description: string | null;
    segmentId: string;
    accountId: string;
    messageSequence: MessageSequence;
    scheduleAt: Date | null;
    sendingSpeed: SendingSpeed;
    stopConditions: StopConditions;
  }>) {
    const patch: any = {};
    if (data.name !== undefined) patch.name = data.name.trim();
    if (data.description !== undefined) patch.description = data.description;
    if (data.segmentId !== undefined) patch.segmentId = data.segmentId;
    if (data.accountId !== undefined) patch.accountId = data.accountId;
    if (data.messageSequence !== undefined) patch.messageSequence = JSON.stringify(data.messageSequence);
    if (data.scheduleAt !== undefined) patch.scheduleAt = data.scheduleAt;
    if (data.sendingSpeed !== undefined) patch.sendingSpeed = stringify(data.sendingSpeed);
    if (data.stopConditions !== undefined) patch.stopConditions = stringify(data.stopConditions);
    return prisma.retargetingCampaign.update({ where: { id }, data: patch });
  },

  remove(id: string) {
    return prisma.retargetingCampaign.delete({ where: { id } });
  },

  parseMessageSequence(s: string | null): MessageSequence {
    return safeJson<MessageSequence>(s, { blocks: [] });
  },
  parseSendingSpeed(s: string | null): SendingSpeed {
    return safeJson<SendingSpeed>(s, { perMinute: 5, jitterMs: 5000 });
  },
  parseStopConditions(s: string | null): StopConditions {
    return safeJson<StopConditions>(s, { onReply: true, onOrdered: true, onRejected: true, doNotContact: true });
  },

  /** Validate before launch. Returns array of error codes; empty = valid. */
  validate(c: any, recipientCount: number): string[] {
    const errors: string[] = [];
    if (!c.name?.trim()) errors.push('name_required');
    if (!c.segmentId) errors.push('segment_required');
    if (!c.accountId) errors.push('account_required');
    const seq = this.parseMessageSequence(c.messageSequence);
    if (!seq.blocks?.length) errors.push('message_sequence_empty');
    if (recipientCount === 0) errors.push('segment_has_no_contacts');
    return errors;
  },

  /** Preview what would happen if we launched. */
  async preview(id: string) {
    const c = await prisma.retargetingCampaign.findUnique({
      where: { id }, include: { account: true },
    });
    if (!c) throw Object.assign(new Error('not_found'), { status: 404 });

    const recipients = await SegmentService.resolveContactIds(c.segmentId);
    const recipientCount = recipients.length;
    const errors = this.validate(c, recipientCount);
    const speed = this.parseSendingSpeed(c.sendingSpeed);
    const seq = this.parseMessageSequence(c.messageSequence);
    const etaMin = speed.perMinute ? Math.ceil(recipientCount / speed.perMinute) : null;

    // Sub-counts for warnings
    const [doNotContactCount, recentlyContactedCount] = await Promise.all([
      prisma.contact.count({
        where: { id: { in: recipients }, doNotContact: true },
      }),
      prisma.contact.count({
        where: {
          id: { in: recipients },
          lastOutgoingMessageAt: { gte: new Date(Date.now() - 24 * 3600_000) },
        },
      }),
    ]);

    return {
      recipientCount,
      doNotContactCount,
      recentlyContactedCount,
      etaMinutes: etaMin,
      blockCount: seq.blocks.length,
      account: c.account ? {
        id: c.account.id, name: c.account.name, status: c.account.status,
      } : null,
      errors,
    };
  },

  /**
   * Launch a campaign: materialize recipient logs and flip status to 'running'.
   * The CampaignEngine timer (started elsewhere) will pick them up.
   */
  async start(id: string): Promise<{ recipientCount: number }> {
    const c = await prisma.retargetingCampaign.findUnique({ where: { id } });
    if (!c) throw Object.assign(new Error('not_found'), { status: 404 });
    if (!['draft', 'scheduled', 'paused'].includes(c.status)) {
      throw Object.assign(new Error('invalid_status_transition'), { status: 409 });
    }

    const recipientIds = await SegmentService.resolveContactIds(c.segmentId);
    if (!recipientIds.length) {
      throw Object.assign(new Error('segment_empty'), { status: 400 });
    }

    // Materialize logs in batches (skip duplicates via @@unique)
    let inserted = 0;
    for (const cid of recipientIds) {
      try {
        const contact = await prisma.contact.findUnique({ where: { id: cid }, select: { accountId: true } });
        if (!contact) continue;
        await prisma.retargetingCampaignLog.create({
          data: {
            campaignId: id,
            contactId: cid,
            accountId: contact.accountId,
            status: 'pending',
            scheduledAt: new Date(),
          },
        });
        inserted++;
      } catch {
        // unique violation — already a recipient (re-launch case); ignore
      }
    }

    await prisma.retargetingCampaign.update({
      where: { id }, data: { status: 'running' },
    });
    return { recipientCount: inserted };
  },

  async pause(id: string) {
    return prisma.retargetingCampaign.update({ where: { id }, data: { status: 'paused' } });
  },
  async resume(id: string) {
    return prisma.retargetingCampaign.update({ where: { id }, data: { status: 'running' } });
  },
  async cancel(id: string) {
    await prisma.retargetingCampaignLog.updateMany({
      where: { campaignId: id, status: 'pending' },
      data: { status: 'canceled', reason: 'campaign_canceled' },
    });
    return prisma.retargetingCampaign.update({ where: { id }, data: { status: 'canceled' } });
  },

  async stats(id: string) {
    const grouped = await prisma.retargetingCampaignLog.groupBy({
      by: ['status'],
      where: { campaignId: id },
      _count: { _all: true },
    });
    const counts: Record<string, number> = {};
    for (const g of grouped) counts[g.status] = g._count._all;
    return {
      total: Object.values(counts).reduce((s, n) => s + n, 0),
      pending: counts.pending ?? 0,
      sent: counts.sent ?? 0,
      skipped: counts.skipped ?? 0,
      failed: counts.failed ?? 0,
      replied: counts.replied ?? 0,
      ordered: counts.ordered ?? 0,
      canceled: counts.canceled ?? 0,
    };
  },

  async listRecipients(id: string, opts: { status?: string; take?: number; skip?: number } = {}) {
    const where: any = { campaignId: id };
    if (opts.status) where.status = opts.status;
    return prisma.retargetingCampaignLog.findMany({
      where,
      include: { contact: { select: { id: true, name: true, jid: true, status: true } } },
      orderBy: { createdAt: 'desc' },
      take: opts.take ?? 100,
      skip: opts.skip ?? 0,
    });
  },
};
