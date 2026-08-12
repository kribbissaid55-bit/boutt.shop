/**
 * CampaignEngine — drains pending RetargetingCampaignLog rows for running
 * campaigns. One timer per running campaign.
 *
 * Tick:
 *   1. Read sendingSpeed.perMinute → compute batch size for this 10s tick.
 *   2. Pick up to N pending logs.
 *   3. For each: re-evaluate stop-conditions against the contact's *current*
 *      state (doNotContact, replied since campaign-start, ordered, rejected,
 *      recently-contacted). Skip with reason if matched.
 *   4. Otherwise enqueue the campaign messageSequence on MessageQueueService
 *      for the contact's accountId. On send → status='sent'. On error → 'failed'.
 *   5. If no pending logs left → campaign.status='completed', stop the timer.
 *
 * Restart-safe: on boot, resume() finds running campaigns and starts their timers.
 */
import { prisma } from '../lib/prisma.js';
import { logger } from '../config/logger.js';
import { CampaignService } from './CampaignService.js';
import { MessageQueueService } from './MessageQueueService.js';
import { SettingsService } from './SettingsService.js';
import { BaileysProvider } from '../adapters/whatsapp/BotProvider.js';
import { whatsapp } from '../adapters/whatsapp/BaileysAdapter.js';
import { runMessageSequence } from '../engine/runMessageSequence.js';

const TICK_INTERVAL_MS = 10_000;
const timers = new Map<string, NodeJS.Timeout>();

async function tickCampaign(campaignId: string) {
  try {
    const c = await prisma.retargetingCampaign.findUnique({
      where: { id: campaignId }, include: { account: true },
    });
    if (!c) { stopTimer(campaignId); return; }

    if (c.status !== 'running') { stopTimer(campaignId); return; }

    const settings = await SettingsService.load();
    if (settings.emergency_stop || !settings.bot_globally_enabled) return;

    const speed = CampaignService.parseSendingSpeed(c.sendingSpeed);
    const stopCfg = CampaignService.parseStopConditions(c.stopConditions);
    const sequence = CampaignService.parseMessageSequence(c.messageSequence);

    // Compute batch size for this tick: TICK_INTERVAL_MS / 60000 * perMinute
    const perMinute = speed.perMinute ?? 5;
    const batchSize = Math.max(1, Math.round((TICK_INTERVAL_MS / 60_000) * perMinute));

    const due = await prisma.retargetingCampaignLog.findMany({
      where: { campaignId, status: 'pending' },
      orderBy: { createdAt: 'asc' },
      take: batchSize,
    });

    if (due.length === 0) {
      // Nothing pending → done
      const remaining = await prisma.retargetingCampaignLog.count({
        where: { campaignId, status: 'pending' },
      });
      if (remaining === 0) {
        await prisma.retargetingCampaign.update({
          where: { id: campaignId }, data: { status: 'completed' },
        });
        stopTimer(campaignId);
      }
      return;
    }

    for (const log of due) {
      try {
        const [contact, account] = await Promise.all([
          prisma.contact.findUnique({ where: { id: log.contactId } }),
          prisma.whatsAppAccount.findUnique({ where: { id: log.accountId } }),
        ]);
        if (!contact || !account) {
          await prisma.retargetingCampaignLog.update({
            where: { id: log.id }, data: { status: 'skipped', reason: 'missing_entity' },
          });
          continue;
        }

        // Stop-condition checks
        let skip: string | null = null;
        if (stopCfg.doNotContact !== false && contact.doNotContact) skip = 'do_not_contact';
        else if (stopCfg.onOrdered && contact.status === 'ordered') skip = 'contact_ordered';
        else if (stopCfg.onRejected && contact.status === 'rejected') skip = 'contact_rejected';
        else if (stopCfg.onReply && contact.lastIncomingMessageAt && contact.lastIncomingMessageAt > log.createdAt) {
          skip = 'replied';
        } else if (stopCfg.skipIfContactedHours && contact.lastOutgoingMessageAt) {
          const cutoff = new Date(Date.now() - stopCfg.skipIfContactedHours * 3_600_000);
          if (contact.lastOutgoingMessageAt > cutoff) skip = 'recently_contacted';
        } else if (account.cooldownUntil && account.cooldownUntil.getTime() > Date.now()) {
          skip = 'account_cooldown';
        } else if (account.status !== 'connected') skip = 'account_offline';

        if (skip) {
          await prisma.retargetingCampaignLog.update({
            where: { id: log.id }, data: { status: 'skipped', reason: skip },
          });
          continue;
        }

        // Anti-ban: never send to a jid that isn't registered on WhatsApp.
        // Campaigns are the highest-risk outbound path — one bad blast to
        // dead numbers can trigger a WA account ban. Cached 24h per jid.
        try {
          const registered = await whatsapp.isRegisteredOnWhatsApp(account.id, contact.jid);
          if (!registered) {
            await prisma.retargetingCampaignLog.update({
              where: { id: log.id }, data: { status: 'skipped', reason: 'not_on_whatsapp' },
            });
            continue;
          }
        } catch (e) {
          logger.warn({ err: e, contactId: contact.id }, 'campaign: onWhatsApp verify failed — proceeding cautiously');
        }

        // Optimistic claim — flip pending→sent only after successful queue dispatch
        const provider = new BaileysProvider(account.id);
        const ctx = {
          contact: { name: contact.name, jid: contact.jid },
          bot: { name: c.name },
          account: { name: account.name },
        };

        try {
          await MessageQueueService.enqueue(account.id, async () =>
            runMessageSequence(sequence, {
              accountId: account.id,
              contactId: contact.id,
              jid: contact.jid,
              ctx,
              provider,
              senderType: 'campaign',
              campaignLogId: log.id,
            }),
          {
            minDelayMs: settings.min_send_delay_ms,
            maxDelayMs: settings.max_send_delay_ms,
            dailyCap: account.dailySendCap,
            burstThreshold: settings.burst_threshold_count,
            burstWindowMin: settings.burst_window_minutes,
            burstCooldownSec: settings.burst_cooldown_seconds,
          });
          await prisma.retargetingCampaignLog.update({
            where: { id: log.id }, data: { status: 'sent', sentAt: new Date() },
          });
        } catch (e) {
          await prisma.retargetingCampaignLog.update({
            where: { id: log.id },
            data: { status: 'failed', reason: (e as Error).message?.slice(0, 200) ?? 'send_failed' },
          });
        }
      } catch (e) {
        logger.error({ err: e, logId: log.id }, 'CampaignEngine log failed');
      }
    }
  } catch (e) {
    logger.error({ err: e, campaignId }, 'CampaignEngine tick failed');
  }
}

function startTimer(campaignId: string) {
  if (timers.has(campaignId)) return;
  const t = setInterval(() => tickCampaign(campaignId), TICK_INTERVAL_MS);
  timers.set(campaignId, t);
  // Run a tick almost immediately so the user sees progress fast
  setTimeout(() => tickCampaign(campaignId), 1500);
  logger.info({ campaignId }, 'CampaignEngine: timer started');
}

function stopTimer(campaignId: string) {
  const t = timers.get(campaignId);
  if (t) { clearInterval(t); timers.delete(campaignId); }
}

export const CampaignEngine = {
  start(campaignId: string) { startTimer(campaignId); },
  stop(campaignId: string) { stopTimer(campaignId); },

  /** Boot-time recovery — find running campaigns and restart their timers. */
  async resumeRunning() {
    const running = await prisma.retargetingCampaign.findMany({
      where: { status: 'running' }, select: { id: true },
    });
    for (const r of running) startTimer(r.id);
    if (running.length) logger.info(`CampaignEngine: resumed ${running.length} running campaigns`);
  },
};
