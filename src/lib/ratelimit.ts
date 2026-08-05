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

/** Tunables for one class of key. */
export interface RatePolicy {
  /** Failures inside the window before lockout starts. */
  maxFails: number;
  /** Rolling window for counting failures. */
  windowMs: number;
  /** First lockout duration; doubles for each further failure. */
  baseLockMs: number;
  /** Cap on the exponential lockout. */
  maxLockMs: number;
}

/** Per-client / per-account default: strict, because it targets one victim. */
export const DEFAULT_POLICY: RatePolicy = {
  maxFails: 5,
  windowMs: 15 * 60 * 1000,
  baseLockMs: 30 * 1000,
  maxLockMs: 15 * 60 * 1000,
};

/**
 * Instance-wide backstop, applied to a single shared key in addition to the
 * per-client one. Without it, anyone able to vary their apparent identity
 * (a spoofed `X-Forwarded-For`, a botnet, or simply a rotating username) gets
 * unlimited attempts. The threshold is high enough that a household of people
 * fat-fingering passwords will not trip it.
 */
export const GLOBAL_POLICY: RatePolicy = {
  maxFails: 50,
  windowMs: 15 * 60 * 1000,
  baseLockMs: 10 * 1000,
  maxLockMs: 5 * 60 * 1000,
};

// Opportunistic cleanup so the map cannot grow unbounded.
function sweep(now: number, windowMs: number) {
  if (buckets.size < 5000) return;
  for (const [k, b] of buckets) {
    if (b.lockedUntil < now && now - b.firstFailAt > windowMs) buckets.delete(k);
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
export function registerFailure(key: string, policy: RatePolicy = DEFAULT_POLICY): RateResult {
  const now = Date.now();
  sweep(now, policy.windowMs);
  let b = buckets.get(key);
  if (!b || now - b.firstFailAt > policy.windowMs) {
    b = { fails: 0, firstFailAt: now, lockedUntil: 0 };
  }
  b.fails += 1;
  if (b.fails >= policy.maxFails) {
    // Exponential backoff based on how far past the threshold we are.
    const over = b.fails - policy.maxFails;
    const lock = Math.min(policy.baseLockMs * 2 ** over, policy.maxLockMs);
    b.lockedUntil = now + lock;
  }
  buckets.set(key, b);
  return checkRateLimit(key);
}

/** Clear a key after a successful attempt. */
export function resetRateLimit(key: string): void {
  buckets.delete(key);
}

/** Drop all buckets. Test helper — not used by the app. */
export function resetAllRateLimits(): void {
  buckets.clear();
}
