import { describe, it, expect, beforeEach } from "vitest";
import { mapWithConcurrency, syncConcurrency, DEFAULT_CONCURRENCY } from "./concurrency";

/** Resolve after a tick, so overlapping tasks really do overlap. */
const tick = () => new Promise((r) => setTimeout(r, 1));

describe("mapWithConcurrency", () => {
  it("returns results in input order regardless of completion order", async () => {
    const out = await mapWithConcurrency([30, 10, 20, 0], 4, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    expect(out).toEqual([30, 10, 20, 0]);
  });

  it("never exceeds the requested parallelism", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 25 }, (_, i) => i), 4, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight--;
    });
    expect(peak).toBe(4);
  });

  it("still runs everything when the limit exceeds the item count", async () => {
    const seen: number[] = [];
    await mapWithConcurrency([1, 2, 3], 50, async (n) => {
      await tick();
      seen.push(n);
    });
    expect(seen.sort()).toEqual([1, 2, 3]);
  });

  it("handles an empty list", async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });

  it("treats a nonsense limit as serial rather than stalling", async () => {
    const out = await mapWithConcurrency([1, 2], 0, async (n) => n * 2);
    expect(out).toEqual([2, 4]);
  });

  it("propagates a rejection", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      })
    ).rejects.toThrow("boom");
  });
});

describe("syncConcurrency", () => {
  beforeEach(() => {
    delete process.env.SYNC_CONCURRENCY;
  });

  it("defaults when unset", () => {
    expect(syncConcurrency()).toBe(DEFAULT_CONCURRENCY);
  });

  it("reads a valid override", () => {
    process.env.SYNC_CONCURRENCY = "8";
    expect(syncConcurrency()).toBe(8);
  });

  it("caps absurd values so a typo cannot open 10,000 sockets", () => {
    process.env.SYNC_CONCURRENCY = "10000";
    expect(syncConcurrency()).toBe(32);
  });

  it("falls back on junk or non-positive values", () => {
    for (const v of ["", "abc", "0", "-3"]) {
      process.env.SYNC_CONCURRENCY = v;
      expect(syncConcurrency()).toBe(DEFAULT_CONCURRENCY);
    }
  });
});
