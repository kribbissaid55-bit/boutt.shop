/**
 * Realistic browser identity pool for Baileys' `browser` option.
 *
 * Each entry is the [name, platform, version] tuple Baileys expects.
 * We pick once on first connect and persist on the account row, so the
 * same account always presents the same fingerprint to WhatsApp — that
 * looks human (real users don't reinstall their browser between sessions).
 *
 * Different accounts pick different browsers so they don't all look like
 * the same device. If you want every account to use a fixed identity,
 * pass it directly via WhatsAppAccount.browserIdentity.
 */
export type BrowserTuple = [name: string, platform: string, version: string];

export const POOL: BrowserTuple[] = [
  ['Chrome',  'Mac OS',  '120.0.6099.130'],
  ['Chrome',  'Windows', '120.0.6099.130'],
  ['Chrome',  'Linux',   '120.0.6099.71'],
  ['Edge',    'Windows', '120.0.2210.91'],
  ['Edge',    'Mac OS',  '120.0.2210.77'],
  ['Firefox', 'Mac OS',  '121.0'],
  ['Firefox', 'Windows', '121.0'],
  ['Firefox', 'Linux',   '121.0'],
  ['Safari',  'Mac OS',  '17.2.1'],
  ['Opera',   'Windows', '105.0.4970.34'],
];

export const pickBrowser = (): BrowserTuple => {
  return POOL[Math.floor(Math.random() * POOL.length)];
};

export const parseStored = (s: string | null | undefined): BrowserTuple | null => {
  if (!s) return null;
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed) && parsed.length === 3 && parsed.every((x) => typeof x === 'string')) {
      return parsed as BrowserTuple;
    }
  } catch {}
  return null;
};

export const stringify = (b: BrowserTuple): string => JSON.stringify(b);
