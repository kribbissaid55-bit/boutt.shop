// Provider-agnostic types for the WhatsApp adapter.
// Engine code only depends on this file — never on Baileys directly.
// This is the firewall against future Baileys/WhatsApp changes.

export type AccountStatus =
  | 'disconnected'
  | 'connecting'
  | 'qr_required'
  | 'connected'
  | 'error';

export type IncomingMessageKind = 'text' | 'audio' | 'image' | 'video' | 'document' | 'sticker';

export interface IncomingMessage {
  accountId: string;
  waMessageId: string;
  fromJid: string;
  /**
   * Phone-bearing JID (e.g. "212XXXXXXXXX@s.whatsapp.net"), extracted from
   * Baileys' WAMessageKey.senderPn when `fromJid` is a privacy `@lid`.
   * Undefined for classic `@s.whatsapp.net` senders — no resolution needed.
   */
  phoneJid?: string;
  fromMe: boolean;
  isGroup: boolean;
  pushName?: string;
  text?: string;
  timestamp: number;
  // Raw WA key, used by adapter.markRead to send blue ticks
  rawKey?: { id: string; remoteJid: string; fromMe: boolean; participant?: string };
  /**
   * Original media kind on WhatsApp. 'text' is the default for plain messages.
   * The engine uses this for the reply-mode mirror (voice in → voice out)
   * and persists it on the Message row so downstream queries see the real type.
   */
  kind?: IncomingMessageKind;
  /**
   * Raw Baileys proto for the message — attached only when kind!=='text' so
   * the engine can call `downloadMediaMessage(rawMsg, 'buffer', {})` to
   * transcribe audio or download an image. Untyped to keep this module free
   * of Baileys imports (the adapter layer is the only place that knows
   * Baileys exists).
   */
  rawMsg?: any;
}

export interface OutgoingMedia {
  type: 'audio' | 'image' | 'video' | 'document';
  filePath: string;
  mimeType: string;
  fileName?: string;
  caption?: string;
}

export interface AdapterEvents {
  qr: (accountId: string, dataUrl: string) => void;
  status: (
    accountId: string,
    status: AccountStatus,
    info: { phoneNumber?: string | null; lastError?: string | null }
  ) => void;
  message: (msg: IncomingMessage) => void;
}
