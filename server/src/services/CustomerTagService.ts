/**
 * CustomerTagService — derive a contact's "where are we" status from existing
 * message timestamps + order draft, and reconcile that status with both:
 *   1. the admin chip (rendered from `deriveStatus()` server-side),
 *   2. a per-status WhatsApp chat label (via Baileys' addChatLabel).
 *
 * The status is one of:
 *   'sent_no_reply' — we sent them something, they haven't replied since.
 *   'replied'       — their last incoming is after our last outgoing.
 *   'ordered'       — order finalized (`status='ordered'` OR draft.finalized).
 *
 * Configuration lives at `BotAiConfig.customerTagsConfig` (per-bot). When
 * disabled or a status's category is off, no WA label is pushed for that key.
 */
import { prisma } from '../lib/prisma.js';
import { logger } from '../config/logger.js';
import { whatsapp } from '../adapters/whatsapp/BaileysAdapter.js';

export type CustomerStatusKey = 'sent_no_reply' | 'replied' | 'ordered';

export type CustomerTagsConfig = {
  enabled: boolean;
  sentNoReply: { enabled: boolean; label: string; color: number };
  replied:     { enabled: boolean; label: string; color: number };
  ordered:     { enabled: boolean; label: string; color: number };
};

export const DEFAULT_TAGS_CONFIG: CustomerTagsConfig = {
  enabled: false,
  sentNoReply: { enabled: true, label: 'ما ردّش',  color: 5  }, // red
  replied:     { enabled: true, label: 'ردّ',       color: 9  }, // blue
  ordered:     { enabled: true, label: 'طلب',       color: 2  }, // green
};

export function parseTagsConfig(raw: string | null | undefined): CustomerTagsConfig {
  if (!raw) return { ...DEFAULT_TAGS_CONFIG };
  try {
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_TAGS_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_TAGS_CONFIG };
  }
}

/**
 * Pure derivation — no DB calls. Order matters: 'ordered' wins, then we look
 * at the incoming/outgoing timestamps to choose between 'replied' and
 * 'sent_no_reply'.
 */
export function deriveStatus(contact: {
  status: string;
  lastIncomingMessageAt: Date | null;
  lastOutgoingMessageAt: Date | null;
  aiOrderDraft: string | null;
}): CustomerStatusKey | null {
  // 'ordered' — either persisted status or a finalized draft.
  if (contact.status === 'ordered') return 'ordered';
  if (contact.aiOrderDraft) {
    try {
      if (JSON.parse(contact.aiOrderDraft)?.finalized === true) return 'ordered';
    } catch { /* fall through */ }
  }
  const out = contact.lastOutgoingMessageAt?.getTime() ?? 0;
  const inc = contact.lastIncomingMessageAt?.getTime() ?? 0;
  if (out && inc > out) return 'replied';
  if (out) return 'sent_no_reply';
  return null;   // no outbound yet → no chip / no label
}

const STATUS_KEYS: CustomerStatusKey[] = ['sent_no_reply', 'replied', 'ordered'];

function pickCategory(cfg: CustomerTagsConfig, key: CustomerStatusKey) {
  if (key === 'sent_no_reply') return cfg.sentNoReply;
  if (key === 'replied')       return cfg.replied;
  return cfg.ordered;
}

export type SyncStep = { step: string; ok: boolean; detail?: string };
export type SyncResult = {
  steps: SyncStep[];
  accountPlatform: string | null;
  isBusiness: boolean | null;
};

/**
 * Reconcile the WA labels on this contact's chat with the derived status.
 *
 * Fire-and-forget: never throws past this boundary. Callers use this from
 * the engine hot path (send/receive/order-finalize) without try/catch.
 *
 * The implementation delegates to `syncTagsForContactInstrumented` which
 * returns step-by-step breadcrumbs — useful for the UI "test sync" button.
 * Production callers ignore the return value.
 */
export async function syncTagsForContact(
  botIdOrNull: string | null | undefined,
  accountId: string,
  contactId: string,
): Promise<void> {
  await syncTagsForContactInstrumented(botIdOrNull, accountId, contactId).catch(() => {});
}

export async function syncTagsForContactInstrumented(
  botIdOrNull: string | null | undefined,
  accountId: string,
  contactId: string,
): Promise<SyncResult> {
  const steps: SyncStep[] = [];
  const push = (step: string, ok: boolean, detail?: string) => {
    steps.push({ step, ok, detail });
    if (ok) logger.info({ accountId, contactId, step, detail }, 'CustomerTag: ' + step);
    else    logger.warn({ accountId, contactId, step, detail }, 'CustomerTag: ' + step);
  };

  // Account-level info (platform/isBusiness) is returned to the caller so the
  // test-sync UI can show a "Business vs Personal" note next to the steps.
  const accountRow = await prisma.whatsAppAccount.findUnique({
    where: { id: accountId },
    select: { platform: true, isBusiness: true },
  });
  const accountPlatform = accountRow?.platform ?? null;
  const isBusiness = accountRow?.isBusiness ?? null;

  try {
    push('start', true, `botId=${botIdOrNull ?? '<none>'}`);

    // Pick the per-bot tag config: prefer the bot the caller named.
    let cfg: CustomerTagsConfig | null = null;
    if (botIdOrNull) {
      const ai = await prisma.botAiConfig.findUnique({
        where: { botId: botIdOrNull },
        select: { customerTagsConfig: true },
      });
      if (ai) cfg = parseTagsConfig(ai.customerTagsConfig);
    }
    if (!cfg || !cfg.enabled) {
      const links = await prisma.botAccount.findMany({
        where: { accountId },
        select: { bot: { select: { aiConfig: { select: { customerTagsConfig: true } } } } },
      });
      for (const l of links) {
        const candidate = parseTagsConfig(l.bot?.aiConfig?.customerTagsConfig ?? null);
        if (candidate.enabled) { cfg = candidate; break; }
      }
    }
    if (!cfg || !cfg.enabled) {
      push('load_config', false, 'tags config not enabled for this bot/account');
      return { steps, accountPlatform, isBusiness };
    }
    push('load_config', true, 'tags enabled');

    if (!whatsapp.isConnected(accountId)) {
      push('check_connection', false, 'WA socket not connected for this account');
      return { steps, accountPlatform, isBusiness };
    }
    push('check_connection', true, 'WA socket connected');

    const contact = await prisma.contact.findUnique({
      where: { id: contactId },
      select: { jid: true, status: true, lastIncomingMessageAt: true, lastOutgoingMessageAt: true, aiOrderDraft: true },
    });
    if (!contact) {
      push('load_contact', false, `contact ${contactId} not found`);
      return { steps, accountPlatform, isBusiness };
    }
    const derived = deriveStatus(contact as any);
    push('derive_status', true, `derived=${derived ?? '<none>'} jid=${contact.jid}`);

    if (!derived) {
      push('skip', true, 'no derived status (e.g. no outbound yet) — nothing to apply');
      return { steps, accountPlatform, isBusiness };
    }

    // Ensure each enabled status has a cached labelId.
    const cache = await prisma.whatsAppChatLabel.findMany({
      where: { accountId, statusKey: { in: STATUS_KEYS } },
    });
    const cachedByKey = new Map(cache.map((r) => [r.statusKey as CustomerStatusKey, r] as const));

    // Short, stable label IDs per account. WhatsApp Business Android renders
    // labels reliably only with short IDs; long compound strings frequently
    // fail to display even when Baileys enqueues the patch successfully.
    // These three IDs are per-status per-account (each account has its own
    // three-label triad; different accounts don't collide because WA labels
    // are per-device/account).
    const SHORT_ID_BY_KEY: Record<CustomerStatusKey, string> = {
      sent_no_reply: 'bsa1',
      replied:       'bsa2',
      ordered:       'bsa3',
    };

    for (const key of STATUS_KEYS) {
      const cat = pickCategory(cfg, key);
      if (!cat.enabled) continue;
      const existing = cachedByKey.get(key);
      const labelId = existing?.waLabelId ?? SHORT_ID_BY_KEY[key];
      const nameChanged = existing && (existing.name !== cat.label || existing.color !== cat.color);
      if (!existing || nameChanged) {
        try {
          await whatsapp.upsertLabel(accountId, labelId, cat.label, cat.color);
          push(`upsert_label_${key}`, true, `labelId=${labelId} name="${cat.label}" color=${cat.color}`);
          // Grace pause: give WA server time to register the label before we
          // reference it in a subsequent addChatLabel patch. Without this,
          // Baileys may enqueue add-chat-label before the label exists on the
          // server, and WA silently drops the assignment.
          await new Promise((r) => setTimeout(r, 600));
        } catch (e: any) {
          push(`upsert_label_${key}`, false, `${e?.message ?? e}`);
          // Still persist the cache row so the admin chip stays consistent.
        }
        await prisma.whatsAppChatLabel.upsert({
          where: { accountId_statusKey: { accountId, statusKey: key } },
          create: { accountId, statusKey: key, waLabelId: labelId, name: cat.label, color: cat.color },
          update: { name: cat.label, color: cat.color, waLabelId: labelId },
        });
        cachedByKey.set(key, {
          ...(existing ?? { id: '', accountId, statusKey: key, createdAt: new Date(), updatedAt: new Date() } as any),
          waLabelId: labelId,
          name: cat.label,
          color: cat.color,
        });
      }
    }

    // Apply the derived status: add the matching label, remove others.
    for (const key of STATUS_KEYS) {
      const row = cachedByKey.get(key);
      if (!row) continue;
      const cat = pickCategory(cfg, key);
      if (!cat.enabled) {
        try {
          await whatsapp.removeChatLabel(accountId, contact.jid, row.waLabelId);
          push(`remove_disabled_${key}`, true, `labelId=${row.waLabelId}`);
        } catch (e: any) {
          push(`remove_disabled_${key}`, false, `${e?.message ?? e}`);
        }
        continue;
      }
      try {
        if (key === derived) {
          await whatsapp.addChatLabel(accountId, contact.jid, row.waLabelId);
          push(`apply_${key}`, true, `add to chat ${contact.jid}`);
        } else {
          await whatsapp.removeChatLabel(accountId, contact.jid, row.waLabelId);
          push(`remove_${key}`, true, `remove from chat ${contact.jid}`);
        }
      } catch (e: any) {
        push(`apply_${key}`, false, `${e?.message ?? e}`);
      }
    }
    push('done', true);
  } catch (e: any) {
    push('fatal', false, `${e?.message ?? e}`);
    logger.warn({ err: e, botId: botIdOrNull, accountId, contactId }, 'CustomerTag: sync failed');
  }
  return { steps, accountPlatform, isBusiness };
}

export type ResyncSummary = {
  accountId: string;
  processed: number;
  labeled: number;
  skipped: number;
  errors: number;
  errorDetails: string[];
};

/**
 * Force-resync all labels for every contact that has a derived status.
 * Repair tool for when labels have gone out of sync between our cache and the
 * actual WhatsApp Business app — the operator hits a button and every contact
 * gets its label reapplied. Spaced with a small delay between contacts so we
 * don't flood WA's appPatch queue.
 */
export async function resyncAllTagsForBot(botId: string): Promise<ResyncSummary> {
  const bot = await prisma.bot.findUnique({
    where: { id: botId },
    include: { accounts: { select: { accountId: true } } },
  });
  if (!bot) throw new Error('bot_not_found');
  const accountIds = bot.accounts.map((l) => l.accountId);
  if (!accountIds.length) throw new Error('bot_has_no_account');
  const accountId = accountIds[0]!;

  const contacts = await prisma.contact.findMany({
    where: { accountId },
    select: { id: true, jid: true, status: true, lastIncomingMessageAt: true, lastOutgoingMessageAt: true, aiOrderDraft: true },
  });

  const summary: ResyncSummary = {
    accountId, processed: 0, labeled: 0, skipped: 0, errors: 0, errorDetails: [],
  };
  for (const c of contacts) {
    summary.processed++;
    const derived = deriveStatus(c as any);
    if (!derived) { summary.skipped++; continue; }
    try {
      const res = await syncTagsForContactInstrumented(botId, accountId, c.id);
      // If any step failed, count as error, but still counts as processed.
      const anyFail = res.steps.some((s) => !s.ok && !['skip', 'load_config'].includes(s.step));
      if (anyFail) {
        summary.errors++;
        const firstFail = res.steps.find((s) => !s.ok);
        if (firstFail && summary.errorDetails.length < 5) {
          summary.errorDetails.push(`${c.jid}: ${firstFail.step} — ${firstFail.detail ?? ''}`);
        }
      } else {
        summary.labeled++;
      }
    } catch (e: any) {
      summary.errors++;
      if (summary.errorDetails.length < 5) {
        summary.errorDetails.push(`${c.jid}: ${e?.message ?? e}`);
      }
    }
    // Pace: 250ms between contacts. For a 200-contact list that's ~50s total.
    // Small enough that the UI feels responsive, large enough that we don't
    // flood WA's inbound appPatch queue and get throttled.
    await new Promise((r) => setTimeout(r, 250));
  }
  return summary;
}
