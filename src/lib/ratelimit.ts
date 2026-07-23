/**
 * Small in-process rate limiter with progressive lockout, used to throttle
 * login attempts. Keyed by identifier (e.g. "ip:username").
 *
 * NOTE: state is per-process. For a single-instance deployment (the common
 * self-hosted case) this is effective. Across multiple replicas each process
 * limits independently; a shared store (Redis) would be needed for a global
 * limit — documented as a known limitation.
 */

interface Bucket {
  fails: number;
  firstFailAt: number;
  lockedUntil: number;
}

const buckets = new Map<string, Bucket>();

// Tuning.
const MAX_FAILS = 5; // failures before lockout kicks in
const WINDOW_MS = 15 * 60 * 1000; // rolling window for counting failures
const BASE_LOCK_MS = 30 * 1000; // first lockout duration
const MAX_LOCK_MS = 15 * 60 * 1000; // cap on exponential lockout

// Opportunistic cleanup so the map cannot grow unbounded.
function sweep(now: number) {
  if (buckets.size < 5000) return;
  for (const [k, b] of buckets) {
    if (b.lockedUntil < now && now - b.firstFailAt > WINDOW_MS) buckets.delete(k);
  }
}

export interface RateResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

/** Check whether an action is currently allowed for this key. */
export function checkRateLimit(key: string): RateResult {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b) return { allowed: true, retryAfterSeconds: 0 };
  if (b.lockedUntil > now) {
    return { allowed: false, retryAfterSeconds: Math.ceil((b.lockedUntil - now) / 1000) };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

/** Record a failed attempt; may trigger/extend a lockout. */
export function registerFailure(key: string): RateResult {
  const now = Date.now();
  sweep(now);
  let b = buckets.get(key);
  if (!b || now - b.firstFailAt > WINDOW_MS) {
    b = { fails: 0, firstFailAt: now, lockedUntil: 0 };
  }
  b.fails += 1;
  if (b.fails >= MAX_FAILS) {
    // Exponential backoff based on how far past the threshold we are.
    const over = b.fails - MAX_FAILS;
    const lock = Math.min(BASE_LOCK_MS * 2 ** over, MAX_LOCK_MS);
    b.lockedUntil = now + lock;
  }
  buckets.set(key, b);
  return checkRateLimit(key);
}

/** Clear a key after a successful attempt. */
export function resetRateLimit(key: string): void {
  buckets.delete(key);
}
