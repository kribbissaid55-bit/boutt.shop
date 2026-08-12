/**
 * runMessageSequence — execute a JSON message sequence (the same shape used by
 * FollowUpStep.messageSequence and RetargetingCampaign.messageSequence).
 *
 * This is the campaign/follow-up cousin of `walkStep` (which walks
 * MessageBlock DB rows for the bot flow). Same provider interface, same
 * persistence pattern. Decoupled so flow steps and follow-ups/campaigns share
 * zero accidental state.
 */
import path from 'node:path';
import { prisma } from '../lib/prisma.js';
import { logger } from '../config/logger.js';
import { sleep } from '../lib/retry.js';
import { substitute, type SubstitutionContext } from './variables.js';
import { MediaService } from '../services/MediaService.js';
import type { BotProvider } from '../adapters/whatsapp/BotProvider.js';
import { bus } from '../services/EventBus.js';

void path;

export interface SequenceBlock {
  type: 'text' | 'audio' | 'image' | 'video' | 'document' | 'delay' | 'options' | 'action';
  content?: string;
  mediaId?: string;
  caption?: string;
  delaySeconds?: number;
  actionType?: string;
  actionPayload?: any;
  enabled?: boolean;
  metadata?: any;
  options?: { number: string; label: string }[];
}

export interface MessageSequence { blocks: SequenceBlock[] }

export interface SequenceContext {
  accountId: string;
  contactId: string;
  jid: string;
  ctx: SubstitutionContext;
  provider: BotProvider;
  /** What to set as `senderType` on persisted Message rows. */
  senderType: 'campaign' | 'follow_up' | 'admin' | 'bot';
  /** Optional log id (campaign log or follow-up log) for traceability. */
  campaignLogId?: string;
  followUpLogId?: string;
}

async function persistOut(s: SequenceContext, type: string, body: string | undefined, mediaId: string | undefined, waMessageId: string | undefined) {
  const clientId = `out_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date();
  await prisma.contact.update({
    where: { id: s.contactId },
    data: { lastOutgoingMessageAt: now, lastInteractionAt: now },
  }).catch(() => {});
  const msg = await prisma.message.create({
    data: {
      accountId: s.accountId, contactId: s.contactId,
      direction: 'out', type, body: body ?? null, mediaId: mediaId ?? null,
      waMessageId: waMessageId ?? null, clientMessageId: clientId,
      status: waMessageId ? 'sent' : 'pending',
      senderType: s.senderType,
      campaignLogId: s.campaignLogId ?? null,
      followUpLogId: s.followUpLogId ?? null,
    },
  });
  bus.emitEvent({ type: 'message.out', accountId: s.accountId, contactId: s.contactId, messageId: msg.id });
}

export async function runMessageSequence(seq: MessageSequence, s: SequenceContext): Promise<void> {
  const blocks = (seq.blocks ?? []).filter((b) => b.enabled !== false);

  for (const b of blocks) {
    try {
      switch (b.type) {
        case 'text': {
          const text = substitute(b.content ?? '', s.ctx);
          if (!text.trim()) break;
          const waId = await s.provider.sendText(s.jid, text);
          await persistOut(s, 'text', text, undefined, waId);
          break;
        }
        case 'image':
        case 'audio':
        case 'video':
        case 'document': {
          if (!b.mediaId) break;
          const media = await prisma.mediaFile.findUnique({ where: { id: b.mediaId } });
          if (!media) {
            logger.warn({ blockMediaId: b.mediaId }, 'sequence media missing — skipping block');
            break;
          }
          // Trust the DB-recorded type over the block declaration — operators
          // may pick e.g. an audio file into an image block in the editor.
          // Sending it through sendImage would crash at WA layer with a
          // confusing error; route by the file's real type instead.
          const realType = media.type as 'image' | 'audio' | 'video' | 'document';
          if (realType !== b.type) {
            logger.warn({ blockType: b.type, mediaType: realType, mediaId: media.id },
                        'sequence block type mismatches media — routing by media type');
          }
          const caption = b.caption ? substitute(b.caption, s.ctx) : undefined;
          const args = {
            filePath: MediaService.resolveAbsolute(media.path),
            mimeType: media.mimeType,
            fileName: media.name,
            caption,
          };
          let waId: string | undefined;
          if (realType === 'audio') waId = await s.provider.sendAudio(s.jid, args);
          else if (realType === 'image') waId = await s.provider.sendImage(s.jid, args);
          else if (realType === 'video') waId = await s.provider.sendVideo(s.jid, args);
          else waId = await s.provider.sendDocument(s.jid, args);
          await persistOut(s, realType, caption, media.id, waId);
          break;
        }
        case 'delay': {
          const ms = Math.max(0, (b.delaySeconds ?? 0) * 1000);
          if (ms > 0) await sleep(Math.min(60_000, ms));
          break;
        }
        case 'options': {
          const opts = (b.options ?? []).map((o) => ({ number: o.number, label: substitute(o.label, s.ctx) }));
          if (!opts.length) break;
          const header = substitute(b.content ?? '', s.ctx);
          // Honour the displayMode the editor saved (defaults to poll — the
          // most reliable interactive format that renders as tappable buttons
          // on every modern WhatsApp client).
          const mode = (b.metadata?.displayMode ?? 'poll') as 'numbered' | 'poll' | 'buttons' | 'list' | 'auto';
          const waId = await s.provider.sendOptions(s.jid, header, opts, mode);
          await persistOut(s, 'text', header || '(menu)', undefined, waId);
          break;
        }
        case 'action': {
          // Limited subset: change contact status / pause / DNC. No order/handover here
          // (those are bot-flow concerns, not appropriate for follow-up/campaign).
          const at = b.actionType;
          if (at === 'set_status' && b.actionPayload?.status) {
            await prisma.contact.update({ where: { id: s.contactId }, data: { status: b.actionPayload.status } });
          } else if (at === 'pause_bot') {
            await prisma.contact.update({ where: { id: s.contactId }, data: { botPaused: true } });
          } else if (at === 'add_tag' && b.actionPayload?.tag) {
            const c = await prisma.contact.findUnique({ where: { id: s.contactId } });
            if (c) {
              let tags: string[] = [];
              try { tags = c.tags ? JSON.parse(c.tags) : []; } catch {}
              if (!tags.includes(b.actionPayload.tag)) tags.push(b.actionPayload.tag);
              await prisma.contact.update({ where: { id: s.contactId }, data: { tags: JSON.stringify(tags) } });
            }
          }
          break;
        }
      }
    } catch (e: any) {
      logger.error({ err: e, blockType: b.type }, 'runMessageSequence: block failed — skipping to next');
      // Partial-success: continue with the rest of the sequence. If the error
      // is a hard socket failure (account in cooldown / not connected), abort
      // the whole sequence — sending further blocks would just compound the
      // problem. Otherwise (single block had bad media etc.), keep going.
      const msg = (e?.message ?? '').toLowerCase();
      if (/cooldown|not[_ ]connected|stream errored|connection closed|rate|429/i.test(msg)) {
        throw e;
      }
      // Otherwise swallow and move on.
    }
  }
}
