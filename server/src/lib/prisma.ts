import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient({
  log: ['warn', 'error'],
});

/**
 * SQLite performance + concurrency PRAGMAs. Run once at boot.
 *
 *  journal_mode = WAL     readers don't block writers and vice-versa.
 *                         Critical when many bots write the same DB.
 *  busy_timeout = 5000    a concurrent writer waits up to 5 s instead of
 *                         failing immediately on a locked DB.
 *  synchronous  = NORMAL  one fsync per checkpoint (safe + fast).
 *
 * Best-effort: a single failure here doesn't crash the server — the app
 * falls back to whatever Prisma's defaults are.
 */
export async function initSqlitePragmas(): Promise<void> {
  try {
    await prisma.$executeRawUnsafe(`PRAGMA journal_mode = WAL;`);
    await prisma.$executeRawUnsafe(`PRAGMA busy_timeout = 5000;`);
    await prisma.$executeRawUnsafe(`PRAGMA synchronous = NORMAL;`);
  } catch {
    // ignore — Postgres / non-SQLite providers will reject these; harmless.
  }
}
