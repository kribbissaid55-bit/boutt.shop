import 'dotenv/config';
import { z } from 'zod';
import path from 'node:path';

const Schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  // Auth secrets — required (no defaults). Startup fails loudly if these
  // aren't set, which is the correct behaviour for a production deploy.
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 chars'),
  // Admin seed — provide a real credential in .env; the seed script uses it.
  // No development-friendly default here — a leaked default is a footgun.
  ADMIN_USERNAME: z.string().min(1),
  ADMIN_PASSWORD: z.string().min(8, 'ADMIN_PASSWORD must be at least 8 chars'),
  // AI key vault secret. Optional in dev (falls back to a deterministic
  // per-install key in ai-crypto.ts). In production the startup will WARN
  // if unset but not exit — we can't hard-require it without breaking
  // existing encrypted credentials for operators who never set it.
  AI_KEY_SECRET: z.string().min(16).optional(),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_ROOT: z.string().default('../storage'),
  // CORS allowlist. Comma-separated origins. Empty → same-origin only
  // (any cross-origin request is rejected). Cross-origin deployments MUST
  // set this to the frontend's origin(s).
  ALLOWED_ORIGINS: z.string().optional(),
  // Cookie domain for cross-origin deployments (e.g. ".shop.ma" to share
  // between api.shop.ma and app.shop.ma). Leave unset for same-origin.
  COOKIE_DOMAIN: z.string().optional(),
});

const parsed = Schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const root = path.resolve(process.cwd(), parsed.data.STORAGE_ROOT);
const allowedOrigins = parsed.data.ALLOWED_ORIGINS
  ?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];

export const env = {
  ...parsed.data,
  STORAGE_ROOT: root,
  SESSIONS_DIR: path.join(root, 'sessions'),
  MEDIA_DIR: path.join(root, 'media'),
  ALLOWED_ORIGINS_LIST: allowedOrigins,
  IS_CROSS_ORIGIN: allowedOrigins.length > 0,
};

// Prod-safety warnings — logged once at import time. Non-fatal.
if (parsed.data.NODE_ENV === 'production') {
  if (!parsed.data.AI_KEY_SECRET) {
    console.warn(
      '[env] AI_KEY_SECRET is not set. AI credentials are encrypted with a ' +
      'deterministic per-install fallback key. Set AI_KEY_SECRET for real ' +
      'protection at rest (see server/src/lib/ai-crypto.ts).',
    );
  }
}
