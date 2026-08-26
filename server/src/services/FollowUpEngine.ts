/**
 * FollowUpEngine — the dynamic per-contact follow-up dispatcher.
 *
 * One process-wide 60s timer. Each tick:
 *   1. For each active rule × step: insert pending FollowUpLog rows for any
 *      contact whose lastInteractionAt + step.delay <= now AND who matches
 *      scope+conditions AND has no existing log for that (contact,rule,step).
 *      The @@unique(contactId, ruleId, stepId) constraint prevents duplicates.
 *   2. Read all pending logs whose scheduledAt <= now.
 *   3. For each: re-check stop-conditions (replied since, ordered, doNotContact,
 *      account online, bot-globally-on, working hours). Skip with reason if hit.
 *   4. Otherwise enqueue the step's messageSequence on MessageQueueService for
 *      the contact's accountId. On send → status='sent'. On error → 'failed'.
 *
 * Restart-safe: pending logs persist; on boot the engine just resumes ticking.
 */
import { prisma } from '../lib/prisma.js';
import { logger } from '../config/logger.js';
import { FollowUpRuleService, type RuleScope, type RuleConditions } from './FollowUpRuleService.js';
import { MessageQueueService } from './MessageQueueService.js';
import { SettingsService } from './SettingsService.js';
import { providerFor, isDeliverable, canSendFreeForm } from '../adapters/whatsapp/providerFactory.js';
import { runMessageSequence } from '../engine/runMessageSequence.js';
import { applyPreSendGuardrails } from '../engine/preSendGuardrails.js';
import { bus } from './EventBus.js';

const TICK_MS = 60_000;
const ACCOUNT_OFFLINE_GIVE_UP_MIN = 30;

let timer: NodeJS.Timeout | null = null;
let running = false;

const minutes = (ms: number) => ms * 60_000;

function compileScope(scope: RuleScope): any {
  const where: any = {};
  if (scope.accountIds?.length) where.accountId = { in: scope.accountIds };
  if (scope.statuses?.length) where.status = { in: scope.statuses };
  if (scope.cities?.length) where.city = { in: scope.cities };
  if (scope.importBatchIds?.length) where.importBatchId = { in: scope.importBatchIds };
  // tags: contains_any — implemented as an OR of LIKE clauses
  if (scope.tags?.length) {
    where.OR = scope.tags.map((tag) => ({ tags: { contains: `"${tag}"` } }));
  }
  return where;
}

function applyConditions(where: any, conditions: RuleConditions): any {
  const w = { ...where };
  // doNotContact and botPaused are always honored — operator intent.
  w.doNotContact = false;
  w.botPaused = false;
  // notRejected is opt-in — operators may want to re-engage rejecters.
  if (conditions.notRejected) {
    if (w.status && typeof w.status === 'object' && 'in' in w.status) {
      w.status.in = (w.status.in as string[]).filter((s) => s !== 'rejected');
    } else if (w.status === 'rejected') {
      w.status = '__none__';
    } else {
      w.status = { notIn: ['rejected'] };
    }
  }
  // NOTE: `conditions.notOrdered` and `conditions.notContactedInLastHours`
  // are now deprecated no-ops. The new findEligible enforces ordered-customer
  // exclusion unconditionally and uses lastInteractionAt as the anchor.
  return w;
}

/**
 * Fast eligibility: contacts whose lastInteractionAt + delay <= now,
 * matching scope+conditions, with no existing log for (rule, step, contact).
 */
async function findEligible(
  rule: any,
  step: any,
): Promise<{ id: string; accountId: string; lastInteractionAt: Date | null }[]> {
  const scope = FollowUpRuleService.parseScope(rule.scope);
  const conditions = FollowUpRuleService.parseConditions(rule.conditions);
  const delayMs = FollowUpRuleService.delayToMs(step.delayValue, step.delayUnit);
  const cutoff = new Date(Date.now() - delayMs);

  let where: any = compileScope(scope);
  where = applyConditions(where, conditions);

  // Per-bot scoping: when the rule belongs to a bot, the audience is every
  // account linked to that bot via `BotAccount`. This is the primary scope —
  // the legacy single-account picker is honored only when no bot is set.
  if (rule.botId) {
    const links = await prisma.botAccount.findMany({
      where: { botId: rule.botId },
      select: { accountId: true },
    });
    const accountIds = links.map((l) => l.accountId);
    if (!accountIds.length) return [];   // bot has no linked accounts → nothing to do
    where.accountId = { in: accountIds };
  } else if (rule.accountId) {
    where.accountId = rule.accountId;
  }

  // Anchor on lastInteractionAt — "N has passed since the LAST conversation
  // (any direction)". Follow-ups only target CUSTOMERS FROM THE LAST 24 h —
  // beyond that the customer no longer remembers the conversation and the
  // follow-up feels stale. So the eligible window is:
  //   max(now - 24h, rule.activatedAt)  <  lastInteractionAt  <=  now - delay
  const interactionFilter: any = {
    lte: cutoff,
    gte: new Date(Date.now() - 24 * 60 * 60_000),
    not: null,
  };

  // activatedAt cutoff: rule never fires on conversations older than activation.
  // Each /activate call resets activatedAt = now(), so re-activations always
  // start from "now" — matching the user's mental model of "send to NEW
  // customers we contacted from now on".
  if (rule.activatedAt) interactionFilter.gt = rule.activatedAt;

  where.lastInteractionAt = interactionFilter;

  // Active-session guard: never fire a follow-up on a contact who has had ANY
  // conversation activity in the last 10 minutes — customer OR bot. The prior
  // guard only checked `lastIncomingMessageAt` which let a fresh-contact race
  // land follow-ups right after the welcome step: the welcome finished and
  // updated `lastOutgoingMessageAt`, but `lastIncomingMessageAt` stayed old
  // (from the very first inbound), so the guard didn't fire. Using
  // `lastInteractionAt` (max of the two) closes that race.
  const activeWindowCutoff = new Date(Date.now() - 10 * 60_000);
  // Ordered-customer exclusion: unconditional. The "✅ ordered chip" derives
  // from either signal, so we filter on both:
  //   (a) Contact.status = 'ordered'    — set by aiEngine on order-finalize.
  //   (b) aiOrderDraft contains "finalized":true — JSON marker on the contact.
  where.AND = [
    ...(Array.isArray(where.AND) ? where.AND : []),
    {
      OR: [
        { lastInteractionAt: null },
        { lastInteractionAt: { lte: activeWindowCutoff } },
      ],
    },
    // Fresh-contact protection: a contact that hasn't received a single reply
    // from the bot yet is not follow-up material. The welcome step sets
    // `lastOutgoingMessageAt` when it walks — so as soon as the welcome
    // finishes AND the active-session window elapses, follow-ups become
    // eligible for their scheduled time. This prevents "welcome + follow-up
    // back-to-back" for brand-new customers.
    { lastOutgoingMessageAt: { not: null } },
    { status: { not: 'ordered' } },
    {
      OR: [
        { aiOrderDraft: null },
        { NOT: { aiOrderDraft: { contains: '"finalized":true' } } },
      ],
    },
  ];

  // exclude contacts that already have a log for this (rule, step)
  where.followUpLogs = where.followUpLogs ?? {};
  where.followUpLogs.none = { ruleId: rule.id, stepId: step.id };

  const contacts = await prisma.contact.findMany({
    where,
    select: { id: true, accountId: true, lastInteractionAt: true },
    take: 500,
  });
  return contacts;
}

async function runTick() {
  if (running) return;   // skip if previous tick still running (slow DB)
  running = true;
  try {
    const settings = await SettingsService.load();
    if (settings.emergency_stop || !settings.bot_globally_enabled) return;

    /* 1. Insert pending logs */
    const rules = await prisma.followUpRule.findMany({
      where: { isActive: true },
      include: { steps: { orderBy: { stepOrder: 'asc' } } },
    });

    for (const rule of rules) {
      for (const step of rule.steps) {
        const delayMs = FollowUpRuleService.delayToMs(step.delayValue, step.delayUnit as any);

        // Safety valve — a UI-side misconfiguration (delayValue=0) would
        // otherwise cause follow-ups to fire alongside the first reply.
        // Refuse to schedule; the operator sees an ERROR in the log.
        if (delayMs <= 0) {
          logger.error(
            {
              ruleId: rule.id, ruleName: rule.name, stepId: step.id,
              delayValue: step.delayValue, delayUnit: step.delayUnit,
            },
            'followup: refusing to schedule — non-positive delay in rule config',
          );
          continue;
        }

        const eligible = await findEligible(rule, step);
        for (const c of eligible) {
          try {
            // Anchor on the contact's last interaction. findEligible already
            // excludes contacts with null lastInteractionAt via `not: null`,
            // but fall back defensively to keep TypeScript happy.
            const anchor = c.lastInteractionAt ?? new Date();
            const scheduledAt = new Date(anchor.getTime() + delayMs);

            await prisma.followUpLog.create({
              data: {
                ruleId: rule.id, stepId: step.id,
                contactId: c.id, accountId: c.accountId,
                scheduledAt,
                status: 'pending',
              },
            });
            logger.info(
              {
                contactId: c.id, ruleId: rule.id, stepId: step.id,
                anchor: anchor.toISOString(),
                scheduledAt: scheduledAt.toISOString(),
                delayMs,
              },
              'followup: scheduled',
            );
            bus.emitEvent({
              type: 'log', level: 'info',
              message: `followup scheduled for ${c.id} at ${scheduledAt.toISOString()}`,
            });
          } catch {
            // unique constraint hit — already scheduled; ignore
          }
        }
      }
    }

    /* 2. Drain pending logs whose scheduledAt is in the past */
    const due = await prisma.followUpLog.findMany({
      where: { status: 'pending', scheduledAt: { lte: new Date() } },
      orderBy: { scheduledAt: 'asc' },
      take: 100,
    });

    for (const log of due) {
      try {
        const [rule, step, contact, account] = await Promise.all([
          prisma.followUpRule.findUnique({ where: { id: log.ruleId } }),
          prisma.followUpStep.findUnique({ where: { id: log.stepId } }),
          prisma.contact.findUnique({ where: { id: log.contactId } }),
          prisma.whatsAppAccount.findUnique({ where: { id: log.accountId } }),
        ]);

        if (!rule || !step || !contact || !account) {
          await prisma.followUpLog.update({
            where: { id: log.id }, data: { status: 'skipped', reason: 'missing_entity' },
          });
          continue;
        }
        if (!rule.isActive) {
          await prisma.followUpLog.update({
            where: { id: log.id }, data: { status: 'canceled', reason: 'rule_paused' },
          });
          continue;
        }

        // Re-check stop conditions
        let skipReason: string | null = null;
        if (contact.doNotContact) skipReason = 'do_not_contact';
        else if (contact.status === 'ordered') skipReason = 'contact_ordered';
        else if (contact.status === 'rejected') skipReason = 'contact_rejected';
        // Sanity: never fire a follow-up whose scheduledAt is > 24 h in the
        // past. That would mean the customer's silence exceeded delay + 24 h
        // — they're outside our "new-customer" window and the follow-up would
        // feel like it fell out of a time capsule. Belt-and-suspenders on top
        // of the eligibility 24 h `gte` bound.
        else if ((Date.now() - log.scheduledAt.getTime()) / 3_600_000 > 24) {
          skipReason = 'stale_beyond_24h';
        }
        else if (contact.lastInteractionAt && contact.lastInteractionAt > log.createdAt) {
          // Any interaction since the log was queued (customer typing OR bot
          // outgoing OR admin manual reply) means the conversation is no
          // longer quiet — the follow-up is stale.
          skipReason = 'reactivated_since_scheduled';
        } else if (account.cooldownUntil && account.cooldownUntil.getTime() > Date.now()) {
          skipReason = 'account_cooldown';
        } else if (account.status !== 'connected') {
          // give the account up to 30 min to come back
          const ageMin = (Date.now() - log.createdAt.getTime()) / minutes(1);
          if (ageMin >= ACCOUNT_OFFLINE_GIVE_UP_MIN) skipReason = 'account_offline';
          else continue;   // leave pending for next tick
        }

        // Belt: an outbound ✅ on this contact (bot-sent post-order OR
        // admin-typed manually in the Inbox) means "sold — hands off"
        // even if the status flip somehow missed. Self-heals the status
        // so the next tick short-circuits at the pre-filter. Cheap: single
        // indexed COUNT, only runs when no earlier skip condition hit.
        if (!skipReason) {
          const boughtMarker = await prisma.message.count({
            where: {
              contactId: contact.id,
              direction: 'out',
              body: { contains: '✅' },
            },
          });
          if (boughtMarker > 0) {
            skipReason = 'already_bought_check';
            await prisma.contact
              .update({ where: { id: contact.id }, data: { status: 'ordered' } })
              .catch(() => {});
          }
        }

        // Universal guardrails — botPaused, stop-word (idempotent no-op here
        // since incomingText is undefined), owner-intervention, daily cap.
        // Same source of truth as the incoming handler, so a follow-up won't
        // fire during an operator's manual reply window or once the daily
        // per-customer cap is exhausted.
        if (!skipReason && rule.botId) {
          const guard = await applyPreSendGuardrails({
            contactId: contact.id,
            botId: rule.botId,
          });
          if (guard.block) skipReason = `guardrails_${guard.reason}`;
        }

        if (skipReason) {
          logger.info(
            { contactId: contact.id, ruleId: log.ruleId, stepId: log.stepId, skipReason },
            'followup: skipping',
          );
          await prisma.followUpLog.update({
            where: { id: log.id }, data: { status: 'skipped', reason: skipReason },
          });
          continue;
        }

        // Anti-ban: never send to a jid that isn't registered on WhatsApp.
        // Blasting deleted/invalid numbers is the fastest way to a WA ban.
        //
        // Skip the API call when we've received at least one message from
        // this contact — inbound = proof of registration, no third-party
        // check needed. This also fixes the "everything skipped as
        // not_on_whatsapp" bug: contact.jid is often a `@lid` privacy id
        // (e.g. `33732740284668@lid`) and Baileys' onWhatsApp doesn't
        // accept @lid, so it returned false for every real customer.
        //
        // We ALSO skip when a resolved phoneJid exists: it can only exist
        // if the contact previously interacted (or was resolved via a
        // Baileys handshake), which is equivalent proof of registration.
        // This avoids per-tick N+1 network calls on cold imports whose
        // phoneJid was populated by a prior WA session.
        //
        // Only for genuinely unknown contacts (fresh imports with no
        // phoneJid and no inbound) do we still hit the API.
        const hasPhoneJid = !!(contact as any).phoneJid;
        const hasInbound = hasPhoneJid ? 1 : await prisma.message.count({
          where: { contactId: contact.id, direction: 'in' },
          take: 1,
        });
        if (hasInbound === 0) {
          try {
            const targetJid = (contact as any).phoneJid || contact.jid;
            const registered = await isDeliverable(account.id, targetJid);
            if (!registered) {
              await prisma.followUpLog.update({
                where: { id: log.id }, data: { status: 'skipped', reason: 'not_on_whatsapp' },
              });
              continue;
            }
          } catch (e) {
            logger.warn({ err: e, contactId: contact.id }, 'followup: onWhatsApp verify failed — proceeding cautiously');
          }
        }

        // Official-API policy: free-form follow-ups only land inside Meta's
        // 24h window (Cloud accounts). Skip with a clear reason otherwise.
        if (!(await canSendFreeForm(account.id, contact.id))) {
          await prisma.followUpLog.update({
            where: { id: log.id }, data: { status: 'skipped', reason: 'outside_24h_window_use_template' },
          }).catch(() => {});
          continue;
        }

        // Send via the per-account queue (same anti-ban guards as bot replies)
        const sequence = FollowUpRuleService.parseMessageSequence(step.messageSequence);
        const provider = providerFor(account.id);
        const ctx = {
          contact: { name: contact.name, jid: contact.jid },
          bot: { name: rule.name },
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
              senderType: 'follow_up',
              followUpLogId: log.id,
            }),
          {
            minDelayMs: settings.min_send_delay_ms,
            maxDelayMs: settings.max_send_delay_ms,
            dailyCap: account.dailySendCap,
            burstThreshold: settings.burst_threshold_count,
            burstWindowMin: settings.burst_window_minutes,
            burstCooldownSec: settings.burst_cooldown_seconds,
    warmupEnabled: settings.warmup_enabled,
          });

          await prisma.followUpLog.update({
            where: { id: log.id }, data: { status: 'sent', sentAt: new Date() },
          });
          bus.emitEvent({ type: 'log', level: 'info', message: `followup sent for ${contact.id}` });
        } catch (e) {
          await prisma.followUpLog.update({
            where: { id: log.id },
            data: { status: 'failed', reason: (e as Error).message?.slice(0, 200) ?? 'send_failed' },
          });
        }
      } catch (e) {
        logger.error({ err: e, logId: log.id }, 'FollowUpEngine: log dispatch failed');
      }
    }
  } catch (e) {
    logger.error({ err: e }, 'FollowUpEngine tick failed');
  } finally {
    running = false;
  }
}

export const FollowUpEngine = {
  start() {
    // Idempotent — a repeat start() on tsx-watch reload must not spin two
    // tickers (would double-send follow-ups for a few seconds until the old
    // process exited).
    if (timer) return;
    logger.info('FollowUpEngine started (60s tick)');
    timer = setInterval(runTick, TICK_MS);
    // Run one tick after a small startup delay so the boot is uncongested.
    setTimeout(runTick, 5_000);
  },
  stop() {
    if (timer) { clearInterval(timer); timer = null; }
  },
  /** Manual tick for the "run check now" button. */
  runOnce: runTick,
};
