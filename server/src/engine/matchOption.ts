/**
 * Forgiving option matcher.
 * Tries: number (Arabic + Latin digits + ordinals), label, keywords.
 */
import { extractOptionNumber, normalizeText } from '../lib/jid.js';
import type { BotOption } from '@prisma/client';

export function matchOption(
  options: BotOption[],
  rawText: string
): BotOption | null {
  if (!options.length) return null;

  // 0) Button / list tap — selectedButtonId or selectedRowId arrive as `opt_<number>`.
  //    These are emitted by BaileysAdapter.sendButtons / sendList. Match strictly
  //    by the captured number; no fuzzy fallback (the tap is unambiguous).
  const tap = rawText.match(/^opt_([\w-]+)$/);
  if (tap) {
    const byTap = options.find((o) => o.enabled && o.number === tap[1]);
    if (byTap) return byTap;
  }

  const norm = normalizeText(rawText);
  if (!norm) return null;

  // 1) numeric / ordinal
  const num = extractOptionNumber(rawText);
  if (num) {
    const byNum = options.find((o) => o.enabled && normalizeText(o.number) === num);
    if (byNum) return byNum;
  }

  // 2) exact normalized label
  const byLabel = options.find((o) => o.enabled && normalizeText(o.label) === norm);
  if (byLabel) return byLabel;

  // 3) substring of label (only if option label has 2+ chars)
  const byLabelInc = options.find((o) => {
    if (!o.enabled) return false;
    const ln = normalizeText(o.label);
    return ln.length >= 2 && norm.includes(ln);
  });
  if (byLabelInc) return byLabelInc;

  // 4) keyword hits
  for (const o of options) {
    if (!o.enabled || !o.keywords) continue;
    let kws: string[];
    try { kws = JSON.parse(o.keywords); } catch { continue; }
    if (kws.some((k) => norm.includes(normalizeText(k)))) return o;
  }
  return null;
}
