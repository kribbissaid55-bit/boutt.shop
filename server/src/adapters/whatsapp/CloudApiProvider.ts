/**
 * CloudApiProvider — BotProvider implementation backed by the OFFICIAL Meta
 * WhatsApp Cloud API. Plugs into the exact same interface the engine already
 * uses, so bot flows, AI replies, campaigns and follow-ups run unchanged.
 *
 * jid ↔ Cloud mapping: the engine speaks in Baileys-style jids
 * ("2126...@s.whatsapp.net"); Cloud wants bare E.164 digits. We convert at
 * this boundary only.
 *
 * NOTE (honest limits — do not remove):
 *  - Free-form messages only reach customers inside Meta's 24-hour customer
 *    service window. Outside it Meta rejects the send (error 131047) and the
 *    row is stored as failed — use approved templates for re-engagement.
 *  - The official API does NOT make automation ban-proof; Meta enforces its
 *    own quality rating and messaging limits per number.
 */
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../config/logger.js';
import { CloudApiService, jidToWaNumber } from '../../services/CloudApiService.js';
import type { BotProvider, DisplayMode, RenderedOption } from './BotProvider.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// accountId → phoneNumberId (small, refreshed on miss; invalidated on account edits)
const phoneIdCache = new Map<string, { id: string; at: number }>();
const PHONE_CACHE_MS = 60_000;

export async function cloudPhoneNumberId(accountId: string): Promise<string> {
  const hit = phoneIdCache.get(accountId);
  if (hit && Date.now() - hit.at < PHONE_CACHE_MS) return hit.id;
  const acc = await prisma.whatsAppAccount.findUnique({
    where: { id: accountId }, select: { phoneNumberId: true },
  });
  if (!acc?.phoneNumberId) throw new Error('cloud_account_missing_phone_number_id');
  phoneIdCache.set(accountId, { id: acc.phoneNumberId, at: Date.now() });
  return acc.phoneNumberId;
}

export class CloudApiProvider implements BotProvider {
  constructor(private accountId: string) {}

  private async pid() { return cloudPhoneNumberId(this.accountId); }

  async sendText(jid: string, text: string) {
    return CloudApiService.sendText(await this.pid(), jidToWaNumber(jid), text);
  }
  async sendAudio(jid: string, m: { filePath: string; mimeType: string; fileName?: string; caption?: string }) {
    return CloudApiService.sendMedia(await this.pid(), jidToWaNumber(jid), { type: 'audio', ...m });
  }
  async sendImage(jid: string, m: { filePath: string; mimeType: string; fileName?: string; caption?: string }) {
    return CloudApiService.sendMedia(await this.pid(), jidToWaNumber(jid), { type: 'image', ...m });
  }
  async sendVideo(jid: string, m: { filePath: string; mimeType: string; fileName?: string; caption?: string }) {
    return CloudApiService.sendMedia(await this.pid(), jidToWaNumber(jid), { type: 'video', ...m });
  }
  async sendDocument(jid: string, m: { filePath: string; mimeType: string; fileName?: string; caption?: string }) {
    return CloudApiService.sendMedia(await this.pid(), jidToWaNumber(jid), { type: 'document', ...m });
  }

  /**
   * Interactive rendering on Cloud API:
   *   buttons (≤3) → real reply buttons; list (≤10) → real list;
   *   poll → unsupported on Cloud → numbered text; auto → buttons/list by count.
   * Reply id = option number, so the webhook can feed the engine the exact
   * token its matcher expects.
   */
  async sendOptions(jid: string, header: string, options: RenderedOption[], mode: DisplayMode) {
    const pid = await this.pid();
    const to = jidToWaNumber(jid);
    const numbered = () => {
      const head = header ? header + '\n\n' : '';
      return CloudApiService.sendText(pid, to, head + options.map((o) => `${o.number} - ${o.label}`).join('\n'));
    };
    try {
      if (options.length === 0) return numbered();
      if (mode === 'buttons' || (mode === 'auto' && options.length <= 3)) {
        if (options.length <= 3) return await CloudApiService.sendButtons(pid, to, header, options);
      }
      if (mode === 'list' || (mode === 'auto' && options.length <= 10)) {
        if (options.length <= 10) return await CloudApiService.sendList(pid, to, header, options);
      }
      return await numbered();
    } catch (e) {
      logger.warn({ err: (e as Error).message, accountId: this.accountId }, '[cloud] interactive send failed — numbered fallback');
      return numbered();
    }
  }

  /** Cloud API has no free-standing presence channel; we keep the humanizing
   *  pause so reply pacing stays identical across providers. */
  async simulateTyping(_jid: string, ms: number) {
    await sleep(Math.min(ms, 3000));
  }
}

export function invalidateCloudPhoneCache(accountId?: string) {
  if (accountId) phoneIdCache.delete(accountId); else phoneIdCache.clear();
}
