/**
 * BotEngineService — thin facade around the engine v2 modules.
 *
 * - `handleIncoming`: called by WhatsAppSessionService on each Baileys message.
 * - `runStep`: kicks off a step manually (used by the contact "test from admin"
 *   path, if needed).
 * - `manualSendText` / `manualSendMedia`: out-of-flow sends from the inbox.
 *
 * All sends still go through the per-account queue, randomized delays, and
 * daily cap — the same safety rails as automated replies.
 */
import { prisma } from '../lib/prisma.js';
import { logger } from '../config/logger.js';
import { handleIncoming, manualSendText } from '../engine/handleIncoming.js';
import { walkStep } from '../engine/walkStep.js';
import { StepMatcherService } from './StepMatcherService.js';
import { MessageQueueService } from './MessageQueueService.js';
import { SettingsService } from './SettingsService.js';
import { BaileysProvider } from '../adapters/whatsapp/BotProvider.js';
import { MediaService } from './MediaService.js';
import { bus } from './EventBus.js';
import type { IncomingMessage } from '../adapters/whatsapp/types.js';
import { retry } from '../lib/retry.js';

export const BotEngineService = {
  handleIncoming,
  manualSendText,

  async runStep(accountId: string, contactId: string, jid: string, stepId: string) {
    const step = await StepMatcherService.getStep(stepId);
    if (!step) return;
    const settings = await SettingsService.load();
    const account = await prisma.whatsAppAccount.findUnique({ where: { id: accountId } });
    const contact = await prisma.contact.findUnique({ where: { id: contactId } });
    if (!account || !contact) return;
    const bot = await prisma.bot.findFirst({ where: { steps: { some: { id: stepId } } } });
    const provider = new BaileysProvider(accountId);

    await MessageQueueService.enqueue(accountId, async () =>
      walkStep(step, {
        accountId, contactId, jid, botId: bot?.id ?? '',
        provider, persist: true,
        ctx: {
          contact: { name: contact.name, jid: contact.jid },
          bot: { name: bot?.name ?? '' },
          account: { name: account.name },
        },
      }),
    {
      minDelayMs: settings.min_send_delay_ms,
      maxDelayMs: settings.max_send_delay_ms,
      dailyCap: account.dailySendCap,
      burstThreshold: settings.burst_threshold_count,
      burstWindowMin: settings.burst_window_minutes,
      burstCooldownSec: settings.burst_cooldown_seconds,
    });
  },

  async manualSendMedia(
    accountId: string, contactId: string, jid: string,
    media: { id: string; type: string; mimeType: string; path: string; name: string },
    caption: string | undefined,
  ) {
    const settings = await SettingsService.load();
    const account = await prisma.whatsAppAccount.findUnique({ where: { id: accountId } });
    if (!account) return;
    const provider = new BaileysProvider(accountId);
    const abs = MediaService.resolveAbsolute(media.path);

    // Voice-note quirk: browsers (Chrome) record as audio/webm-opus, but
    // WhatsApp only renders as a true voice note (waveform + play) when the
    // declared mimetype is audio/ogg. The codec inside is opus either way,
    // so we override the mimetype on the wire for these audio uploads.
    let outgoingMime = media.mimeType;
    if (media.type === 'audio' && /webm/i.test(media.mimeType)) {
      outgoingMime = 'audio/ogg; codecs=opus';
    }

    const args = { filePath: abs, mimeType: outgoingMime, fileName: media.name, caption };
    const clientId = `out_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await MessageQueueService.enqueue(accountId, async () => {
      try {
        const waId = await retry(async () => {
          if (media.type === 'image') return provider.sendImage(jid, args);
          if (media.type === 'video') return provider.sendVideo(jid, args);
          if (media.type === 'audio') return provider.sendAudio(jid, args);
          return provider.sendDocument(jid, args);
        }, { attempts: 3 });
        const msg = await prisma.message.create({
          data: {
            accountId, contactId, direction: 'out', type: media.type,
            body: caption ?? null, mediaId: media.id, waMessageId: waId ?? null,
            clientMessageId: clientId, status: waId ? 'sent' : 'pending',
            senderType: 'admin',
          },
        });
        bus.emitEvent({ type: 'message.out', accountId, contactId, messageId: msg.id });
      } catch (e) {
        await prisma.message.create({
          data: {
            accountId, contactId, direction: 'out', type: media.type,
            mediaId: media.id, clientMessageId: clientId,
            status: 'failed', error: (e as Error).message,
            senderType: 'admin',
          },
        });
        logger.error({ err: e, accountId }, 'manualSendMedia failed');
      }
    }, {
      minDelayMs: settings.min_send_delay_ms,
      maxDelayMs: settings.max_send_delay_ms,
      dailyCap: account.dailySendCap,
      burstThreshold: settings.burst_threshold_count,
      burstWindowMin: settings.burst_window_minutes,
      burstCooldownSec: settings.burst_cooldown_seconds,
      bypassDelay: true,   // admin clicked send — go now
    });
  },

  /** Backwards-compat alias used by the contacts route. */
  async runRawText(accountId: string, contactId: string, jid: string, text: string) {
    return manualSendText(accountId, contactId, jid, text);
  },

  async enqueueMedia(accountId: string, contactId: string, jid: string, media: any, caption?: string) {
    return this.manualSendMedia(accountId, contactId, jid, media, caption);
  },
};

export type { IncomingMessage };
