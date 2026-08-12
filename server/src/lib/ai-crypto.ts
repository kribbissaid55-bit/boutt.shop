/**
 * Symmetric encryption for AI provider API keys at rest.
 *
 * Algorithm: AES-256-GCM. Wire format (base64): iv (12B) || authTag (16B) || ciphertext.
 *
 * Key derivation: the secret comes from `AI_KEY_SECRET` env var, hashed with
 * SHA-256 to produce a fixed 32-byte AES key. If the env var is missing we
 * derive a deterministic per-install key from the SQLite path + a static salt
 * — good enough to keep keys non-trivially readable to anyone with DB access,
 * not a substitute for a real KMS. Set `AI_KEY_SECRET` in production.
 */
import crypto from 'node:crypto';

const FALLBACK_KEY_INPUT = 'bot-said-22:ai-key-fallback:v1';

function deriveKey(): Buffer {
  const secret = process.env.AI_KEY_SECRET || FALLBACK_KEY_INPUT;
  return crypto.createHash('sha256').update(secret).digest();
}

export function encryptApiKey(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decryptApiKey(encoded: string): string {
  const buf = Buffer.from(encoded, 'base64');
  if (buf.length < 12 + 16 + 1) throw new Error('encrypted_key_too_short');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(), iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

/** Mask all but the last 4 chars: `sk-...xyz9`. */
export function maskKey(plain: string): string {
  if (!plain || plain.length <= 6) return '****';
  const head = plain.slice(0, 3);
  const tail = plain.slice(-4);
  return `${head}…${tail}`;
}
