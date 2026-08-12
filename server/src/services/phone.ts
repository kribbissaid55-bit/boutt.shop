/**
 * Phone-number normalization and JID conversion.
 *
 * Tolerant of human input: "+212 6 12 34 56 78", "0612345678", "(212)612345678"
 * → all become "212612345678". Stored as the JID local part.
 */

const MOROCCO_CC = '212';

export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // strip everything except digits and a leading +
  let s = String(raw).replace(/[\s\-()_.  ]/g, '').trim();
  if (!s) return null;

  // remove leading +
  if (s.startsWith('+')) s = s.slice(1);

  // strip non-digits (defensive)
  s = s.replace(/\D/g, '');
  if (!s) return null;

  // Moroccan local form: starts with "0" → prepend country code 212
  if (s.startsWith('0')) {
    s = MOROCCO_CC + s.slice(1);
  }

  // Reject obviously-bad lengths (E.164 max 15 digits, min ~7)
  if (s.length < 7 || s.length > 15) return null;

  return s;
}

export const phoneToJid = (phone: string): string => `${phone}@s.whatsapp.net`;

export const jidToPhone = (jid: string): string => {
  const at = jid.indexOf('@');
  const head = at === -1 ? jid : jid.slice(0, at);
  const colon = head.indexOf(':');
  return colon === -1 ? head : head.slice(0, colon);
};

/**
 * Convert any plausible Moroccan phone shape into local 10-digit "0XXXXXXXXX".
 *
 *   "+212 6 54 77 88 98"   → "0654778898"
 *   "212654778898"         → "0654778898"
 *   "0654778898"           → "0654778898"   (idempotent)
 *   "654778898"            → "0654778898"   (9-digit local without leading 0)
 *
 * Non-Moroccan / unrecognized lengths fall through to the digits-only form
 * (safer than mis-prefixing a 0). Returns null only for empty input.
 */
export function toMoroccanLocal(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 12 && digits.startsWith(MOROCCO_CC)) return '0' + digits.slice(3);
  if (digits.length === 10 && digits.startsWith('0'))        return digits;
  if (digits.length === 9)                                   return '0' + digits;
  return digits;
}
