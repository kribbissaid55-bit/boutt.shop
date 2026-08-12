export async function retry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; minDelayMs?: number; maxDelayMs?: number } = {}
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const min = opts.minDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 8000;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i === attempts - 1) break;
      const delay = Math.min(max, min * 2 ** i) + Math.floor(Math.random() * 250);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const randInt = (min: number, max: number) =>
  Math.floor(Math.random() * (max - min + 1)) + min;
