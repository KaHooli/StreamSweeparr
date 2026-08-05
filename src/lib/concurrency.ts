/**
 * A tiny bounded-concurrency runner.
 *
 * Sync spends nearly all of its time waiting on HTTP: one TMDB call per movie,
 * one Watchmode call plus one Sonarr call per series. Run strictly one after
 * another, a few thousand titles take minutes of almost pure latency. Running
 * a handful at a time collapses that without hammering anyone's API.
 *
 * Deliberately not a dependency: this is twenty lines and the alternative
 * (p-limit and friends) brings ESM/CJS friction into a Next.js build.
 */

/** Default parallelism for provider lookups during a sync. */
export const DEFAULT_CONCURRENCY = 4;

/**
 * Parallelism for sync, from SYNC_CONCURRENCY.
 *
 * Kept modest by default. Each task holds a database connection while it
 * upserts, and Prisma sizes its pool from the CPU count — `(cpus * 2) + 1`, so
 * three on a single-core NAS. Going wide there trades API latency for pool
 * timeouts. Raise it (alongside `connection_limit` in DATABASE_URL) on hosts
 * with headroom.
 */
export function syncConcurrency(): number {
  const raw = Number(process.env.SYNC_CONCURRENCY);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_CONCURRENCY;
  return Math.min(Math.floor(raw), 32);
}

/**
 * Apply `fn` to every item, at most `limit` at a time, preserving input order
 * in the returned array.
 *
 * Rejections propagate — like `Promise.all`, the first failure wins — so
 * callers that must not abandon the remaining work should handle errors inside
 * `fn`. Both sync engines do exactly that, recording per-title failures and
 * carrying on.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const effective = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: effective }, worker));
  return results;
}
