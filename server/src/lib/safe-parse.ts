/**
 * Safe JSON parse with a {…} fallback — useful for parsing LLM responses
 * that sometimes wrap their JSON in prose or backticks. Returns null on
 * any failure so callers can fall through to defaults without try/catch.
 */
export function safeParseObject(s: string | null | undefined): any {
  if (!s) return null;
  try { return JSON.parse(s); } catch {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}
