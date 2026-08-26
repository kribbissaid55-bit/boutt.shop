/**
 * providerFactory — single decision point for "which WhatsApp pipe does this
 * account use?". Engine code calls `providerFor(accountId)` instead of
 * `new BaileysProvider(accountId)`; the returned object implements BotProvider
 * and resolves the real provider (Baileys vs official Cloud API) per call,
 * from the account row's `provider` column (60s in-process cache).
 *
 * Rollback story: flip WhatsAppAccount.provider back to 'baileys' and the
 * very next send routes through the old adapter — no restart, no redeploy.
 */
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../config/logger.js';
import { whatsapp } from './BaileysAdapter.js';
import { BaileysProvider, type BotProvider, type DisplayMode, type RenderedOption } from './BotProvider.js';
import { CloudApiProvider, cloudPhoneNumberId } from './CloudApiProvider.js';
import { CloudApiService } from '../../services/CloudApiService.js';
import type { IncomingMessage } from './types.js';

const kindCache = new Map<string, { provider: string; at: number }>();
const KIND_CACHE_MS = 60_000;

export async function accountProviderKind(accountId: string): Promise<'baileys' | 'cloud'> {
  const hit = kindCache.get(accountId);
  if (hit && Date.now() - hit.at < KIND_CACHE_MS) return hit.provider as any;
  const acc = await prisma.whatsAppAccount.findUnique({
    where: { id: accountId }, select: { provider: true },
  });
  const kind = acc?.provider === 'cloud' ? 'cloud' : 'baileys';
  kindCache.set(accountId, { provider: kind, at: Date.now() });
  return kind;
}

export function invalidateProviderCache(accountId?: string) {
  if (accountId) kindCache.delete(accountId); else kindCache.clear();
}

class RoutingProvider implements BotProvider {
  private baileys: BaileysProvider;
  private cloud: CloudApiProvider;
  constructor(private accountId: string) {
    this.baileys = new BaileysProvider(accountId);
    this.cloud = new CloudApiProvider(accountId);
  }
  private async pick(): Promise<BotProvider> {
    return (await accountProviderKind(this.accountId)) === 'cloud' ? this.cloud : this.baileys;
  }
  async sendText(jid: string, text: string) { return (await this.pick()).sendText(jid, text); }
  async sendAudio(jid: string, m: { filePath: string; mimeType: string; fileName?: string; caption?: string }) {
    return (await this.pick()).sendAudio(jid, m);
  }
  async sendImage(jid: string, m: { filePath: string; mimeType: string; fileName?: string; caption?: string }) {
    return (await this.pick()).sendImage(jid, m);
  }
  async sendVideo(jid: string, m: { filePath: string; mimeType: string; fileName?: string; caption?: string }) {
    return (await this.pick()).sendVideo(jid, m);
  }
  async sendDocument(jid: string, m: { filePath: string; mimeType: string; fileName?: string; caption?: string }) {
    return (await this.pick()).sendDocument(jid, m);
  }
  async sendOptions(jid: string, header: string, options: RenderedOption[], mode: DisplayMode) {
    return (await this.pick()).sendOptions(jid, header, options, mode);
  }
  async simulateTyping(jid: string, ms: number) { return (await this.pick()).simulateTyping(jid, ms); }
}

/** Drop-in replacement for `new BaileysProvider(accountId)`. */
export function providerFor(accountId: string): BotProvider {
  return new RoutingProvider(accountId);
}

/** Provider-aware mark-as-read (blue ticks). Baileys needs the raw WA key;
 *  Cloud needs the wamid. Non-fatal either way. */
export async function markReadFor(m: IncomingMessage): Promise<void> {
  try {
    if ((await accountProviderKind(m.accountId)) === 'cloud') {
      const pid = await cloudPhoneNumberId(m.accountId);
      await CloudApiService.markRead(pid, m.waMessageId, true);
    } else if (m.rawKey) {
      await whatsapp.markRead(m.accountId, m.rawKey);
    }
  } catch (e) {
    logger.debug({ err: (e as Error).message, accountId: m.accountId }, 'markReadFor failed (non-fatal)');
  }
}

/**
 * Deliverability pre-check used by campaigns/follow-ups.
 * Baileys: on-WhatsApp lookup. Cloud: no lookup API — return true and let the
 * send surface Meta's own error if the number is not on WhatsApp.
 */
export async function isDeliverable(accountId: string, jid: string): Promise<boolean> {
  if ((await accountProviderKind(accountId)) === 'cloud') return true;
  try { return await whatsapp.isRegisteredOnWhatsApp(accountId, jid); } catch { return true; }
}

/**
 * Meta 24-hour customer-service window check for CLOUD accounts.
 * Free-form (non-template) business-initiated sends outside the window are
 * rejected by Meta (error 131047) — campaigns/follow-ups call this first to
 * fail fast with a clear reason instead of burning API calls.
 * Baileys accounts always return true (no such restriction on that path).
 */
export async function canSendFreeForm(accountId: string, contactId: string): Promise<boolean> {
  if ((await accountProviderKind(accountId)) !== 'cloud') return true;
  const cutoff = new Date(Date.now() - 24 * 3_600_000);
  const last = await prisma.message.findFirst({
    where: { accountId, contactId, direction: 'in', createdAt: { gte: cutoff } },
    select: { id: true },
  });
  return !!last;
}
