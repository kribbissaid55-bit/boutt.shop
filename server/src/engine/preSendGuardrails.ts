/**
 * Shared pre-send guardrails — one authoritative gate for every automated
 * outgoing message the platform produces. Runs at the top of both the
 * incoming dispatcher and the follow-up drain loop, so rule-only bots,
 * hybrid welcome steps, AI turns, and scheduled follow-ups all honor the
 * same "Behavior and constraints" the operator configured in the bot
 * editor. Manual admin sends are intentionally NOT gated — those are the
 * operator's own actions.
 *
 * Guards, in order:
 *   1. Contact-level pause (`Contact.botPaused`).
 *   2. Stop word — `BotAiConfig.stopWord` triggers a permanent pause.
 *   3. Owner intervention — recent admin manual reply silences the bot
 *      for `BotAiConfig.ownerInterventionMinutes` minutes.
 *   4. Daily reply cap — outgoing count in the trailing 24h
 *      (`senderType IN ('bot','follow_up')`) capped at
 *      `BotAiConfig.maxRepliesPerSession`.
 *
 * Guards silently no-op when the relevant `BotAiConfig` field is missing
 * or zero, matching the operator's UI expectation ("blank = disabled").
 */
import { prisma } from '../lib/prisma.js';
import { logger } from '../config/logger.js';

export type GuardrailReason =
  | 'contact_paused'
  | 'stop_word'
  | 'owner_intervention'
  | 'daily_cap';

export interface GuardrailInput {
  contactId: string;
  botId: string;
  /** The most recent inbound text from the customer, used for stop-word matching. */
  incomingText?: string | null;
}

export type GuardrailResult =
  | { block: false }
  | { block: true; reason: GuardrailReason };

export async function applyPreSendGuardrails(
  input: GuardrailInput,
): Promise<GuardrailResult> {
  const { contactId, botId, incomingText } = input;

  const contact = await prisma.contact.findUnique({
    where: { id: contactId },
    select: { id: true, botPaused: true },
  });
  if (!contact) return { block: false };

  if (contact.botPaused) {
    logger.info({ contactId }, 'guardrails: contact botPaused — silent');
    return { block: true, reason: 'contact_paused' };
  }

  const cfg = await prisma.botAiConfig.findUnique({ where: { botId } });

  // ─── Stop word ─────────────────────────────────────────────────────
  if (cfg?.stopWord && incomingText) {
    const needle = cfg.stopWord.trim().toLowerCase();
    if (needle && incomingText.toLowerCase().includes(needle)) {
      await prisma.contact.update({
        where: { id: contactId },
        data: { botPaused: true },
      });
      logger.info(
        { contactId, stopWord: cfg.stopWord },
        'guardrails: stop-word hit — bot paused for contact',
      );
      return { block: true, reason: 'stop_word' };
    }
  }

  // ─── Owner intervention ────────────────────────────────────────────
  const interventionMinutes = cfg?.ownerInterventionMinutes ?? 0;
  if (interventionMinutes > 0) {
    const lastOut = await prisma.message.findFirst({
      where: { contactId, direction: 'out' },
      orderBy: { createdAt: 'desc' },
      select: { senderType: true, createdAt: true },
    });
    if (
      lastOut?.senderType === 'admin' &&
      (Date.now() - lastOut.createdAt.getTime()) / 60_000 < interventionMinutes
    ) {
      logger.info(
        { contactId, minutes: interventionMinutes },
        'guardrails: owner intervention active — silent',
      );
      return { block: true, reason: 'owner_intervention' };
    }
  }

  // ─── Daily reply cap ───────────────────────────────────────────────
  // Cap counts all automated outgoing (bot AND follow_up) in the last 24h.
  // Admin manual sends do NOT count against the cap.
  const cap = cfg?.maxRepliesPerSession ?? 0;
  if (cap > 0) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const count = await prisma.message.count({
      where: {
        contactId,
        direction: 'out',
        senderType: { in: ['bot', 'follow_up'] },
        createdAt: { gte: since },
      },
    });
    if (count >= cap) {
      logger.info(
        { contactId, count, cap },
        'guardrails: daily reply cap hit — silent until window rolls off',
      );
      return { block: true, reason: 'daily_cap' };
    }
  }

  return { block: false };
}
