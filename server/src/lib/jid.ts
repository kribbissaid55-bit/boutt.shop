// WhatsApp jid utilities. Pure functions, no Baileys dependency.

export const isGroupJid = (jid: string) => jid.endsWith('@g.us');
export const isBroadcastJid = (jid: string) =>
  jid === 'status@broadcast' || jid.endsWith('@broadcast');
// `@lid` is WhatsApp's newer privacy-preserving JID format ("linked-device id").
// Treat as user-equivalent — Baileys handles routing to/from these transparently.
export const isUserJid = (jid: string) =>
  jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');

export const phoneFromJid = (jid: string): string => {
  const at = jid.indexOf('@');
  const head = at === -1 ? jid : jid.slice(0, at);
  const colon = head.indexOf(':');
  return colon === -1 ? head : head.slice(0, colon);
};

/**
 * Return the real phone digits (E.164, no `+`) for a contact.
 *
 * Prefers `phoneJid` — the phone-bearing JID populated from Baileys'
 * `WAMessageKey.senderPn` when the routing `jid` is a privacy `@lid`.
 * Falls back to `jid` ONLY when that jid is `@s.whatsapp.net`.
 *
 * Returns `null` for LID-only contacts with no resolved phone yet. Callers
 * MUST treat null as "phone not yet known" and must NOT fabricate a phone
 * from LID digits (they are a random device identifier, not a phone).
 */
export function resolveContactPhone(c: { jid: string; phoneJid?: string | null }): string | null {
  const preferred = c.phoneJid && c.phoneJid.endsWith('@s.whatsapp.net') ? c.phoneJid : null;
  const fallback = c.jid.endsWith('@s.whatsapp.net') ? c.jid : null;
  const chosen = preferred ?? fallback;
  return chosen ? phoneFromJid(chosen) : null;
}

// Normalize Arabic text for keyword matching: strip tashkeel, unify alif/yeh,
// fold Arabic-Indic digits to Latin, lowercase, trim, collapse whitespace.
export const normalizeText = (s: string): string => {
  if (!s) return '';
  return s
    .toLowerCase()
    .replace(/[ً-ٰٟ]/g, '') // tashkeel
    .replace(/[إأآا]/g, 'ا') // alif variants
    .replace(/ى/g, 'ي') // ya
    .replace(/ة/g, 'ه') // ta marbuta
    // Arabic-Indic digits 0-9 (U+0660..U+0669)
    .replace(/[٠۰]/g, '0').replace(/[١۱]/g, '1')
    .replace(/[٢۲]/g, '2').replace(/[٣۳]/g, '3')
    .replace(/[٤۴]/g, '4').replace(/[٥۵]/g, '5')
    .replace(/[٦۶]/g, '6').replace(/[٧۷]/g, '7')
    .replace(/[٨۸]/g, '8').replace(/[٩۹]/g, '9')
    .replace(/[\.,،]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
};

// Map Arabic ordinal words to digits (best-effort, not exhaustive).
const ARABIC_ORDINALS: Record<string, string> = {
  'الاول': '1', 'الاولى': '1', 'اول': '1',
  'الثاني': '2', 'الثانيه': '2', 'ثاني': '2',
  'الثالث': '3', 'الثالثه': '3', 'ثالث': '3',
  'الرابع': '4', 'الرابعه': '4', 'رابع': '4',
  'الخامس': '5', 'الخامسه': '5', 'خامس': '5',
  'السادس': '6', 'السادسه': '6', 'سادس': '6',
};

/**
 * Extract a candidate option-number from a free-form message.
 * Examples: "1" → "1", "١" → "1", "اختيار 2" → "2", "الأول" → "1", "رقم 3." → "3"
 * Returns null if no clean number-like signal is present.
 */
export const extractOptionNumber = (s: string): string | null => {
  const norm = normalizeText(s);
  if (!norm) return null;

  const m = norm.match(/(?:^|[^\d])(\d{1,3})(?:[^\d]|$)/);
  if (m) return m[1];

  for (const [word, digit] of Object.entries(ARABIC_ORDINALS)) {
    if (norm.includes(word)) return digit;
  }

  return null;
};
