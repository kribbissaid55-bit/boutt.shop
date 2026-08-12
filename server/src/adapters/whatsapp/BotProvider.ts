/**
 * BotProvider — provider-agnostic interface used by the engine.
 *
 * Two implementations:
 *   - BaileysProvider  → real WhatsApp via the existing Baileys adapter
 *   - VirtualProvider  → records calls without sending; used by the test simulator
 *
 * The engine never imports Baileys; it talks to this interface. Future provider
 * (e.g. official WhatsApp Business API) can plug in here.
 */
import { whatsapp } from './BaileysAdapter.js';
import type { OutgoingMedia } from './types.js';

export type DisplayMode = 'numbered' | 'buttons' | 'list' | 'poll' | 'auto';

export interface RenderedOption {
  number: string;
  label: string;
}

export interface BotProvider {
  sendText(jid: string, text: string): Promise<string | undefined>;
  sendAudio(jid: string, m: { filePath: string; mimeType: string; fileName?: string; caption?: string }): Promise<string | undefined>;
  sendImage(jid: string, m: { filePath: string; mimeType: string; fileName?: string; caption?: string }): Promise<string | undefined>;
  sendVideo(jid: string, m: { filePath: string; mimeType: string; fileName?: string; caption?: string }): Promise<string | undefined>;
  sendDocument(jid: string, m: { filePath: string; mimeType: string; fileName?: string; caption?: string }): Promise<string | undefined>;
  sendOptions(jid: string, header: string, options: RenderedOption[], mode: DisplayMode): Promise<string | undefined>;
  simulateTyping(jid: string, ms: number): Promise<void>;
}

const renderNumberedMenu = (header: string, options: RenderedOption[]): string => {
  const head = header ? header + '\n\n' : '';
  return head + options.map((o) => `${o.number} - ${o.label}`).join('\n');
};

export class BaileysProvider implements BotProvider {
  constructor(private accountId: string) {}

  sendText(jid: string, text: string) {
    return whatsapp.sendText(this.accountId, jid, text);
  }
  sendAudio(jid: string, m: { filePath: string; mimeType: string; fileName?: string; caption?: string }) {
    return whatsapp.sendMedia(this.accountId, jid, { type: 'audio', ...m });
  }
  sendImage(jid: string, m: { filePath: string; mimeType: string; fileName?: string; caption?: string }) {
    return whatsapp.sendMedia(this.accountId, jid, { type: 'image', ...m });
  }
  sendVideo(jid: string, m: { filePath: string; mimeType: string; fileName?: string; caption?: string }) {
    return whatsapp.sendMedia(this.accountId, jid, { type: 'video', ...m });
  }
  sendDocument(jid: string, m: { filePath: string; mimeType: string; fileName?: string; caption?: string }) {
    return whatsapp.sendMedia(this.accountId, jid, { type: 'document', ...m });
  }
  /**
   * Render options. Today: always numbered text fallback (the safe default for
   * Baileys/QR). The architecture is in place for buttons/list — when WhatsApp
   * confirms the device supports interactive payloads, swap in the real call
   * here; engine code will not need to change.
   */
  sendOptions(jid: string, header: string, options: RenderedOption[], mode: DisplayMode) {
    // 'poll' renders as a real interactive card on every modern WhatsApp
    // version — most reliable interactive option for Baileys senders.
    if (mode === 'poll' && options.length > 0) {
      return whatsapp.sendPoll(this.accountId, jid, header, options);
    }
    // Legacy 'buttons' / 'list' — WhatsApp downgrades these to plain text
    // on most phones in 2024+. Kept for users on WhatsApp Business.
    if (mode === 'buttons' && options.length > 0 && options.length <= 3) {
      return whatsapp.sendButtons(this.accountId, jid, header, options);
    }
    if (mode === 'list' && options.length > 0) {
      return whatsapp.sendList(this.accountId, jid, header, options);
    }
    return whatsapp.sendText(this.accountId, jid, renderNumberedMenu(header, options));
  }
  simulateTyping(jid: string, ms: number) {
    return whatsapp.simulateTyping(this.accountId, jid, ms);
  }
  // intentionally unused with current Baileys path
  _ = (_payload: OutgoingMedia) => undefined;
}

/**
 * VirtualProvider — used by the in-dashboard Test Simulator.
 * Records each call as an event; never touches WhatsApp.
 */
export type VirtualEvent =
  | { kind: 'text'; text: string }
  | { kind: 'audio' | 'image' | 'video' | 'document'; mediaId: string; mimeType: string; fileName: string; caption?: string }
  | { kind: 'options'; header: string; options: RenderedOption[]; mode: DisplayMode }
  | { kind: 'typing'; ms: number };

/**
 * VirtualProvider — used by the Test Simulator. The simulator itself emits
 * events directly with the richer mediaId/mimeType payload (see BotTestService),
 * but this class is kept so the BotProvider interface can be honored by any
 * caller that doesn't need media fidelity.
 */
export class VirtualProvider implements BotProvider {
  public onEvent: (e: VirtualEvent) => void;
  constructor(onEvent: (e: VirtualEvent) => void) { this.onEvent = onEvent; }

  async sendText(_jid: string, text: string) {
    this.onEvent({ kind: 'text', text });
    return 'virtual_' + Date.now();
  }
  async sendAudio(_jid: string, _m: { filePath: string; mimeType?: string; fileName?: string; caption?: string }) {
    return 'virtual_' + Date.now();
  }
  async sendImage(_jid: string, _m: { filePath: string; mimeType?: string; fileName?: string; caption?: string }) {
    return 'virtual_' + Date.now();
  }
  async sendVideo(_jid: string, _m: { filePath: string; mimeType?: string; fileName?: string; caption?: string }) {
    return 'virtual_' + Date.now();
  }
  async sendDocument(_jid: string, _m: { filePath: string; mimeType?: string; fileName?: string; caption?: string }) {
    return 'virtual_' + Date.now();
  }
  async sendOptions(_jid: string, header: string, options: RenderedOption[], mode: DisplayMode) {
    this.onEvent({ kind: 'options', header, options, mode });
    return 'virtual_' + Date.now();
  }
  async simulateTyping(_jid: string, ms: number) {
    this.onEvent({ kind: 'typing', ms });
  }
}
