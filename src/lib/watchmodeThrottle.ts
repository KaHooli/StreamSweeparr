/**
 * How the Watchmode client behaves once the API answers **429 Too Many
 * Requests**.
 *
 * Watchmode rations two different things and says so with two different status
 * codes: a key that is invalid or has spent its monthly credits is refused with
 * 401/403, while 429 means the *requests are arriving too fast*. The two want
 * opposite responses — a spent key should be set aside and the next one used,
 * whereas a rate limit clears on its own if you simply wait. Treating 429 as
 * "this key is finished" is what turned one burst into a run where every
 * remaining title reported an exhausted key and came back `streamingUnknown`.
 *
 * So this module is the "wait" half. It holds two pieces of state, both shared
 * by every in-flight request on a client (sync looks titles up `SYNC_CONCURRENCY`
 * at a time, so a limit tripped by one worker is about to be tripped by the
 * other three):
 *
 *   - **a pause**, until which nobody sends anything — set from `Retry-After`
 *     when the response carries one, otherwise from a backoff ladder;
 *   - **a spacing**, a minimum gap between consecutive requests, which starts at
 *     zero and steps up each time a limit is hit. That is the part that makes
 *     the *rest* of the run succeed rather than trip the same limit again.
 *
 * The spacing is learned per client, i.e. per sync run, and starts from zero
 * every time. Persisting it would save the one or two 429s a run spends
 * re-learning, but it would also mean an install that was throttled once carries
 * that penalty forever with nothing to tell it the limit had been lifted. A
 * couple of wasted calls per run is the cheaper mistake.
 *
 * No I/O and an injectable clock, so the ladder can be tested without waiting
 * for real seconds to pass.
 */

/**
 * Gaps between consecutive requests, in order of escalation. Each 429 moves one
 * step down the ladder; the last step is the floor the client will not go past,
 * on the grounds that a sync pacing itself at 2s a title is already so slow that
 * the useful answer is "your key cannot support this library", not more waiting.
 */
export const PACE_LADDER_MS = [250, 500, 1000, 2000] as const;

/**
 * How long to wait before retrying a request that was rate limited, indexed by
 * attempt. Only used when the response carries no `Retry-After`.
 */
export const RETRY_BACKOFF_MS = [1_000, 2_000, 4_000] as const;

/**
 * Ceiling on a `Retry-After` we will honour. A server asking us to wait ten
 * minutes is not describing a burst, and a sync holding a run lock for that long
 * would be reaped as dead (`lib/jobs.ts` gives up on a run whose heartbeat is
 * five minutes old). Past this the request fails instead and its title is left
 * `streamingUnknown`, which is safe by design.
 */
export const MAX_RETRY_AFTER_MS = 30_000;

/**
 * How long after an escalation another 429 can escalate again.
 *
 * Requests already in flight when the limit was hit will each come back 429 a
 * moment later; without this the four workers of a default sync would walk the
 * whole ladder on a single burst. Anything reported inside the window is taken
 * as an echo of the burst that has already been answered.
 */
const ESCALATION_COOLDOWN_MS = 1_000;

const sleepReal = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface WatchmodeThrottleOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Parse a `Retry-After` header into milliseconds from now.
 *
 * Both forms in the spec are accepted — delay-seconds and an HTTP date — since
 * which one a server sends is not something a client gets to choose. Returns
 * null for a missing or unparseable value (the caller falls back to the backoff
 * ladder) and never returns more than `MAX_RETRY_AFTER_MS` or less than zero: a
 * date already in the past means "you may retry now", not "go backwards".
 */
export function parseRetryAfter(header: string | null | undefined, now = Date.now()): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    if (seconds < 0) return null;
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }

  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.min(Math.max(at - now, 0), MAX_RETRY_AFTER_MS);
}

/** What one 429 did to the throttle, so the caller can say so in the run log. */
export interface WatchmodeThrottleStep {
  /** How long this request will wait before it is retried. */
  waitMs: number;
  /** The spacing now applied between requests; 0 while none has been needed. */
  intervalMs: number;
  /** Whether this 429 moved the spacing along, or was an echo of an earlier one. */
  escalated: boolean;
}

/**
 * A shared pacer for one `WatchmodeClient`.
 *
 * `acquire()` is called before every request and `rateLimited()` after every
 * 429. Both are cheap and, while nothing has been rate limited, `acquire()`
 * neither sleeps nor allocates.
 */
export class WatchmodeThrottle {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  /** Current minimum gap between requests; 0 until a limit is hit. */
  private interval = 0;
  /** Earliest send time the next request may claim, from the spacing. */
  private nextSlotAt = 0;
  /** Nothing is sent before this — a whole-ring pause after a 429. */
  private pausedUntil = 0;
  /** When the spacing may next step down the ladder. */
  private escalationAllowedAt = 0;

  constructor(opts: WatchmodeThrottleOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? sleepReal;
  }

  /** The spacing currently applied between requests, in ms (0 = none). */
  get intervalMs(): number {
    return this.interval;
  }

  /**
   * Claim the next send slot, waiting for it if it has not arrived.
   *
   * Slots are handed out in call order and reserved as they are handed out, so
   * concurrent callers space themselves apart rather than all waiting for the
   * same instant and then firing together — which would reproduce exactly the
   * burst the spacing exists to break up.
   */
  async acquire(): Promise<void> {
    const now = this.now();
    const at = Math.max(now, this.nextSlotAt, this.pausedUntil);
    this.nextSlotAt = at + this.interval;
    if (at > now) await this.sleep(at - now);
  }

  /**
   * Record a 429 and return how the client should respond to it.
   *
   * `attempt` is 0 for the first failure of a request, 1 for the retry after
   * that, and so on; it selects the backoff step used when the response carried
   * no `Retry-After`. The pause is applied to the whole client, so callers do
   * not sleep on the returned `waitMs` themselves — the next `acquire()` will
   * not return until it has passed.
   */
  rateLimited(attempt: number, retryAfterMs: number | null): WatchmodeThrottleStep {
    const now = this.now();
    const step = RETRY_BACKOFF_MS[Math.min(Math.max(attempt, 0), RETRY_BACKOFF_MS.length - 1)];
    const waitMs = retryAfterMs ?? step;

    let escalated = false;
    if (now >= this.escalationAllowedAt) {
      const next = PACE_LADDER_MS.find((ms) => ms > this.interval);
      if (next !== undefined) {
        this.interval = next;
        escalated = true;
      }
      // Held even when the ladder is already at its floor, so a storm of 429s
      // cannot keep re-answering "escalated" for a spacing that never moves.
      this.escalationAllowedAt = now + Math.max(ESCALATION_COOLDOWN_MS, this.interval);
    }

    this.pausedUntil = Math.max(this.pausedUntil, now + waitMs);
    // Nothing may claim a slot inside the pause either, or the requests queued
    // behind it would all come due the moment it lifts.
    this.nextSlotAt = Math.max(this.nextSlotAt, this.pausedUntil);

    return { waitMs, intervalMs: this.interval, escalated };
  }
}
