/**
 * Walk a step: iterate its blocks in order, dispatching each through the
 * provider. Records every outgoing message in DB. Variable substitution at
 * send-time. Action blocks update DB state.
 */
import { prisma } from '../lib/prisma.js';
import { logger } from '../config/logger.js';
import { sleep } from '../lib/retry.js';
import { substitute, type SubstitutionContext } from './variables.js';
import { OrderService } from '../services/OrderService.js';
import type { BotProvider, DisplayMode, RenderedOption } from '../adapters/whatsapp/BotProvider.js';
import type { StepWithChildren } from '../services/StepMatcherService.js';
import { bus } from '../services/EventBus.js';
import { syncTagsForContact } from '../services/CustomerTagService.js';

export interface WalkContext {
  accountId: string;
  contactId: string;
  jid: string;
  botId: string;
  ctx: SubstitutionContext;
  provider: BotProvider;
  /** Persist messages (true for real send, false for virtual/test). */
  persist: boolean;
}

export async function walkStep(step: StepWithChildren, w: WalkContext): Promise<void> {
  let optionsEmitted = false;
  const stepSettings: any = (() => {
    try { return step.settings ? JSON.parse(step.settings) : {}; } catch { return {}; }
  })();

  // Rule: one bot message per customer inquiry. Welcome step is the ONLY
  // exception — the operator's first-impression sequence (audio/video/etc.)
  // is intentional and stays intact. Every other step type (fallback,
  // option_reply, handover, keyword, order, normal, end) emits at most ONE
  // customer-visible message. Delay/action blocks are non-emitting and
  // still run at any position.
  const isWelcome = step.type === 'welcome';
  const EMITTING_TYPES = new Set(['text', 'image', 'video', 'audio', 'document', 'options']);

  let anyBlockEmitted = false;
  let emittedInLoop = 0;
  for (const b of step.blocks) {
    if (!b.enabled) continue;

    // One-message-per-turn enforcement for non-welcome steps.
    if (!isWelcome && emittedInLoop >= 1 && EMITTING_TYPES.has(b.type)) {
      logger.info(
        { stepId: step.id, stepType: step.type, blockId: b.id, blockType: b.type, sortOrder: b.sortOrder },
        'walkStep: skipping extra emitting block — one-message-per-turn rule (non-welcome step)',
      );
      continue;
    }

    // Pace between emitting blocks. WhatsApp Web + Baileys silently drops
    // media in rapid audio→video→video bursts (fresh session, upload queue
    // congestion — DB shows status=sent but customer never receives). 800ms
    // between blocks lets Baileys fully upload + encrypt each media before
    // starting the next; the operator perceives it as a natural typing pace.
    // Skip for the first block and for non-emitting types (delay blocks
    // already sleep on their own; action blocks emit nothing).
    if (emittedInLoop > 0 && (b.type === 'text' || b.type === 'image' || b.type === 'video' || b.type === 'audio' || b.type === 'document' || b.type === 'options')) {
      await sleep(800);
    }

    try {
      switch (b.type) {
        case 'text': {
          const text = substitute(b.content ?? '', w.ctx);
          if (!text.trim()) {
            logger.info(
              { stepId: step.id, blockId: b.id, sortOrder: b.sortOrder },
              'walkStep: text block empty — skipping',
            );
            break;
          }
          const waId = await w.provider.sendText(w.jid, text);
          if (w.persist) await persistOut(w, 'text', text, undefined, waId);
          anyBlockEmitted = true;
          emittedInLoop++;
          break;
        }
        case 'audio':
        case 'image':
        case 'video':
        case 'document': {
          // Source of truth = the block's declared type. Preview uses `b.type`;
          // real send must too so the operator's tuned sequence matches
          // exactly (audio→video stays audio→video, not "video-only"
          // because a stored media type disagreed).
          const declaredType = b.type as 'image' | 'audio' | 'video' | 'document';

          if (!b.media || !b.media.path) {
            // Surface it exactly like preview does — visible in the inbox
            // instead of a silent gap the operator has to hunt for.
            logger.warn(
              { stepId: step.id, blockId: b.id, blockType: declaredType, sortOrder: b.sortOrder },
              'walkStep: block skipped — missing media file',
            );
            if (w.persist) {
              await persistOut(
                w,
                'text',
                `⚠ كتلة ${declaredType} بدون ملف مرفق — ارفع الملف من محرر البوت (block ${b.id.slice(0, 8)})`,
                undefined,
                undefined,
              );
            }
            anyBlockEmitted = true;
            emittedInLoop++;
            break;
          }

          // Sanity check: if the stored file's kind disagrees with the block's
          // declared type (rare — usually a legacy misupload), warn and
          // continue with the operator's declared intent.
          if (b.media.type && b.media.type !== declaredType) {
            logger.warn(
              {
                stepId: step.id, blockId: b.id,
                declaredType, storedType: b.media.type, mediaId: b.media.id,
              },
              'walkStep: block type ≠ media type — using block declaration',
            );
          }

          const caption = b.caption ? substitute(b.caption, w.ctx) : undefined;
          const filePath = (await import('../services/MediaService.js')).MediaService.resolveAbsolute(b.media.path);
          const args = { filePath, mimeType: b.media.mimeType, fileName: b.media.name, caption };

          logger.info(
            {
              stepId: step.id, blockId: b.id, declaredType,
              mediaId: b.media.id, mimeType: b.media.mimeType, sortOrder: b.sortOrder,
            },
            'walkStep: dispatching media block',
          );

          let waId: string | undefined;
          if (declaredType === 'audio')      waId = await w.provider.sendAudio(w.jid, args);
          else if (declaredType === 'image') waId = await w.provider.sendImage(w.jid, args);
          else if (declaredType === 'video') waId = await w.provider.sendVideo(w.jid, args);
          else                                waId = await w.provider.sendDocument(w.jid, args);
          if (w.persist) await persistOut(w, declaredType, caption, b.media.id, waId);
          anyBlockEmitted = true;
          emittedInLoop++;
          break;
        }
        case 'delay': {
          await sleep(Math.max(0, (b.delaySeconds ?? 0)) * 1000);
          break;
        }
        case 'options': {
          const optsForStep = step.options;
          if (!optsForStep.length) break;
          const meta = parseJson(b.metadata);
          const mode: DisplayMode = (meta?.displayMode ?? 'poll') as DisplayMode;
          const rendered: RenderedOption[] = optsForStep
            .filter((o) => o.enabled)
            .map((o) => ({ number: o.number, label: substitute(o.label, w.ctx) }));
          const header = substitute(b.content ?? '', w.ctx);
          const waId = await w.provider.sendOptions(w.jid, header, rendered, mode);
          if (w.persist) await persistOut(w, 'text', header || '(menu)', undefined, waId);
          optionsEmitted = true;
          anyBlockEmitted = true;
          emittedInLoop++;
          break;
        }
        case 'action': {
          await runAction(b.actionType ?? '', parseJson(b.actionPayload), w);
          // Actions don't count as "emit" — currentStepId should not advance
          // on an action-only step (e.g. tag-add-then-nothing).
          break;
        }
      }
    } catch (e: any) {
      const errMsg = (e?.message ?? String(e)).slice(0, 200);
      logger.error(
        { err: errMsg, stepId: step.id, blockId: b.id, blockType: b.type },
        'walkStep: block send failed — continuing',
      );
      // Persist a red-flag Message row so the failure is visible in the
      // inbox instead of an unexplained silence. Same pattern as preview's
      // ⚠ warning bubble — brings preview↔real parity for failures too.
      if (w.persist) {
        await persistOut(
          w,
          'text',
          `⚠ فشل إرسال كتلة ${b.type} — ${errMsg}`,
          undefined,
          undefined,
        ).catch(() => {});
      }
    }
  }

  // Auto-emit options menu at the end of the step if:
  //   - the step has at least one enabled option,
  //   - no `options` block was already emitted in the sequence,
  //   - the step's autoMenu setting is not explicitly false.
  const enabledOptions = step.options.filter((o) => o.enabled);
  if (
    !optionsEmitted &&
    enabledOptions.length > 0 &&
    stepSettings.autoMenu !== false
  ) {
    try {
      const firstText = step.blocks.find((b) => b.enabled && b.type === 'text' && (b.content ?? '').trim());
      const header = substitute(
        stepSettings.menuHeader ?? firstText?.content ?? 'اختار من القائمة:',
        w.ctx
      );
      const rendered = enabledOptions.map((o) => ({
        number: o.number,
        label: substitute(o.label, w.ctx),
      }));
      // Step-level displayMode. Default to 'poll' — interactive cards that
      // render as tappable buttons on every modern WhatsApp version. Owners
      // can opt back to 'numbered' from step settings if they prefer text.
      const autoMode: DisplayMode = (stepSettings.displayMode ?? 'poll') as DisplayMode;
      const waId = await w.provider.sendOptions(w.jid, header, rendered, autoMode);
      if (w.persist) await persistOut(w, 'text', header || '(menu)', undefined, waId);
      anyBlockEmitted = true;
    } catch (e) {
      logger.error({ err: e, stepId: step.id }, 'auto options emit failed');
    }
  }

  // Advance the contact's "current step" only if we actually emitted at
  // least one bubble — otherwise the next incoming would match against
  // a step that visually did nothing, confusing the customer.
  if (w.persist && anyBlockEmitted) {
    await prisma.contact.update({
      where: { id: w.contactId },
      data: { currentStepId: step.id },
    });
  }
}

async function persistOut(
  w: WalkContext,
  type: string,
  body: string | undefined,
  mediaId: string | undefined,
  waMessageId: string | undefined
) {
  const clientId = `out_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date();
  await prisma.contact.update({
    where: { id: w.contactId },
    data: { lastOutgoingMessageAt: now, lastInteractionAt: now },
  }).catch(() => {});
  const msg = await prisma.message.create({
    data: {
      accountId: w.accountId,
      contactId: w.contactId,
      direction: 'out',
      type,
      body: body ?? null,
      senderType: 'bot',
      mediaId: mediaId ?? null,
      clientMessageId: clientId,
      waMessageId: waMessageId ?? null,
      status: waMessageId ? 'sent' : 'pending',
    },
  });
  bus.emitEvent({ type: 'message.out', accountId: w.accountId, contactId: w.contactId, messageId: msg.id });
  // Rule-bot outgoing → may flip the chip/label to sent_no_reply.
  void syncTagsForContact(w.botId, w.accountId, w.contactId);
}

async function runAction(kind: string, payload: any, w: WalkContext) {
  switch (kind) {
    case 'set_status': {
      if (payload?.status) {
        await prisma.contact.update({ where: { id: w.contactId }, data: { status: payload.status } });
      }
      break;
    }
    case 'pause_bot':
      await prisma.contact.update({ where: { id: w.contactId }, data: { botPaused: true } });
      break;
    case 'resume_bot':
      await prisma.contact.update({ where: { id: w.contactId }, data: { botPaused: false } });
      break;
    case 'mark_needs_human':
      await prisma.contact.update({ where: { id: w.contactId }, data: { status: 'needs_human' } });
      break;
    case 'end_conversation':
      await prisma.contact.update({
        where: { id: w.contactId },
        data: { currentStepId: null, failedAttempts: 0 },
      });
      break;
    case 'start_order_collection': {
      await OrderService.start(w.contactId);
      break;
    }
    case 'confirm_order': {
      await OrderService.confirm(w.contactId, w.botId);
      break;
    }
    case 'notify_admin': {
      // Internal flag — surfaced via dashboard / SSE log
      bus.emitEvent({ type: 'log', level: 'info', message: payload?.message ?? 'admin_notify' });
      break;
    }
    case 'add_tag':
      // not surfaced in v1 UI; stored in metadata.tags[]
      await addTag(w.contactId, payload?.tag);
      break;
    default:
      // unknown action — ignore silently to keep flows resilient
      break;
  }
}

async function addTag(contactId: string, tag?: string) {
  if (!tag) return;
  const c = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!c) return;
  let meta: any = {};
  try { meta = c.metadata ? JSON.parse(c.metadata) : {}; } catch {}
  meta.tags = Array.from(new Set([...(meta.tags ?? []), tag]));
  await prisma.contact.update({ where: { id: contactId }, data: { metadata: JSON.stringify(meta) } });
}

function parseJson(s: string | null | undefined): any {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}
