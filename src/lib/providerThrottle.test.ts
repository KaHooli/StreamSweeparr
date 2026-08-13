import { describe, it, expect } from "vitest";
import {
  MAX_RETRY_AFTER_MS,
  PACE_LADDER_MS,
  parseRetryAfter,
  ProviderThrottle,
} from "./providerThrottle";

/** A throttle whose waiting advances a fake clock rather than real time. */
function harness(start = 1_000_000) {
  let clock = start;
  const slept: number[] = [];
  const throttle = new ProviderThrottle({
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
  });
  return {
    throttle,
    slept,
    now: () => clock,
    elapsed: () => clock - start,
    /** Move time on without sending anything, as a slow request would. */
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("parseRetryAfter", () => {
  it("reads delay-seconds", () => {
    expect(parseRetryAfter("5")).toBe(5_000);
    expect(parseRetryAfter(" 2 ")).toBe(2_000);
  });

  it("reads an HTTP date, relative to now", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:03 GMT", now)).toBe(3_000);
  });

  it("treats a date in the past as 'retry now' rather than going backwards", () => {
    const now = Date.parse("2026-01-01T00:00:10Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:00 GMT", now)).toBe(0);
  });

  it("ignores a missing or unparseable value so the caller backs off instead", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter("   ")).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
    expect(parseRetryAfter("-1")).toBeNull();
  });

  it("caps a long wait — a sync must not sit on the run lock until it is reaped", () => {
    expect(parseRetryAfter("600")).toBe(MAX_RETRY_AFTER_MS);
  });
});

describe("ProviderThrottle", () => {
  it("does not wait at all until something has been rate limited", async () => {
    const h = harness();
    await h.throttle.acquire();
    await h.throttle.acquire();
    expect(h.slept).toEqual([]);
    expect(h.throttle.intervalMs).toBe(0);
  });

  it("spaces later requests once a limit is hit", async () => {
    const h = harness();
    h.throttle.rateLimited(0, null);
    expect(h.throttle.intervalMs).toBe(PACE_LADDER_MS[0]);

    await h.throttle.acquire(); // waits out the pause
    expect(h.elapsed()).toBe(1_000);

    await h.throttle.acquire(); // and then keeps its distance
    expect(h.elapsed()).toBe(1_000 + PACE_LADDER_MS[0]);
  });

  it("hands concurrent callers separate slots instead of one shared instant", async () => {
    const h = harness();
    h.throttle.rateLimited(0, null);

    // Four workers arriving together, as a default sync's do.
    await Promise.all([
      h.throttle.acquire(),
      h.throttle.acquire(),
      h.throttle.acquire(),
      h.throttle.acquire(),
    ]);
    // The pause, plus one spacing per queued worker after the first — none of
    // them may fire the moment the pause lifts.
    expect(h.elapsed()).toBe(1_000 + 3 * PACE_LADDER_MS[0]);
  });

  it("uses Retry-After in preference to its own backoff", () => {
    const h = harness();
    expect(h.throttle.rateLimited(0, 7_500).waitMs).toBe(7_500);
  });

  it("backs off further on each attempt at the same request", () => {
    const h = harness();
    expect(h.throttle.rateLimited(0, null).waitMs).toBe(1_000);
    h.advance(60_000);
    expect(h.throttle.rateLimited(1, null).waitMs).toBe(2_000);
    h.advance(60_000);
    expect(h.throttle.rateLimited(2, null).waitMs).toBe(4_000);
    h.advance(60_000);
    // Past the end of the ladder it holds at the last step rather than growing.
    expect(h.throttle.rateLimited(9, null).waitMs).toBe(4_000);
  });

  it("steps the pacing along once per burst, not once per refused request", () => {
    const h = harness();
    expect(h.throttle.rateLimited(0, null).escalated).toBe(true);

    // The three requests already in flight come back 429 a moment later. They
    // are describing the burst that has just been answered, not a new one.
    expect(h.throttle.rateLimited(0, null).escalated).toBe(false);
    expect(h.throttle.rateLimited(0, null).escalated).toBe(false);
    expect(h.throttle.intervalMs).toBe(PACE_LADDER_MS[0]);

    h.advance(60_000);
    expect(h.throttle.rateLimited(0, null).escalated).toBe(true);
    expect(h.throttle.intervalMs).toBe(PACE_LADDER_MS[1]);
  });

  it("stops escalating at the floor of the ladder", () => {
    const h = harness();
    for (let i = 0; i < 10; i++) {
      h.throttle.rateLimited(0, null);
      h.advance(60_000);
    }
    expect(h.throttle.intervalMs).toBe(PACE_LADDER_MS[PACE_LADDER_MS.length - 1]);
    expect(h.throttle.rateLimited(0, null).escalated).toBe(false);
  });

  it("keeps the longest pause when several arrive at once", async () => {
    const h = harness();
    h.throttle.rateLimited(0, 10_000);
    h.throttle.rateLimited(0, 1_000); // must not shorten the wait already set
    await h.throttle.acquire();
    expect(h.elapsed()).toBe(10_000);
  });
});
