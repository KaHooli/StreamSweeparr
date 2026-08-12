import { describe, it, expect } from "vitest";
import {
  clampWatchmodeCacheDays,
  watchmodeCacheTtlMs,
  describeWatchmodeCache,
  DEFAULT_WATCHMODE_CACHE_DAYS,
  MIN_WATCHMODE_CACHE_DAYS,
  MAX_WATCHMODE_CACHE_DAYS,
  WATCHMODE_CACHE_CHOICES,
} from "./watchmodeCache";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("clampWatchmodeCacheDays", () => {
  it("keeps a value inside the range", () => {
    expect(clampWatchmodeCacheDays(1)).toBe(1);
    expect(clampWatchmodeCacheDays(7)).toBe(7);
    expect(clampWatchmodeCacheDays(90)).toBe(90);
  });

  it("clamps to the bounds rather than rejecting", () => {
    expect(clampWatchmodeCacheDays(0)).toBe(MIN_WATCHMODE_CACHE_DAYS);
    expect(clampWatchmodeCacheDays(-5)).toBe(MIN_WATCHMODE_CACHE_DAYS);
    expect(clampWatchmodeCacheDays(365)).toBe(MAX_WATCHMODE_CACHE_DAYS);
  });

  it("falls back to the default for anything unusable", () => {
    // A row written by an older build has no value at all, and NaN would make
    // every title look stale — re-spending the whole credit budget in one sync.
    expect(clampWatchmodeCacheDays(null)).toBe(DEFAULT_WATCHMODE_CACHE_DAYS);
    expect(clampWatchmodeCacheDays(undefined)).toBe(DEFAULT_WATCHMODE_CACHE_DAYS);
    expect(clampWatchmodeCacheDays(Number.NaN)).toBe(DEFAULT_WATCHMODE_CACHE_DAYS);
    expect(clampWatchmodeCacheDays(Number.POSITIVE_INFINITY)).toBe(DEFAULT_WATCHMODE_CACHE_DAYS);
  });

  it("rounds a fractional value to whole days", () => {
    expect(clampWatchmodeCacheDays(6.4)).toBe(6);
    expect(clampWatchmodeCacheDays(6.6)).toBe(7);
  });
});

describe("watchmodeCacheTtlMs", () => {
  it("converts days to milliseconds", () => {
    expect(watchmodeCacheTtlMs(1)).toBe(DAY_MS);
    expect(watchmodeCacheTtlMs(7)).toBe(7 * DAY_MS);
  });

  it("never returns zero or NaN for a broken value", () => {
    expect(watchmodeCacheTtlMs(0)).toBe(DAY_MS);
    expect(watchmodeCacheTtlMs(Number.NaN)).toBe(DEFAULT_WATCHMODE_CACHE_DAYS * DAY_MS);
  });
});

describe("describeWatchmodeCache", () => {
  it("singularises one day", () => {
    expect(describeWatchmodeCache(1)).toBe("1 day");
    expect(describeWatchmodeCache(7)).toBe("7 days");
  });
});

describe("WATCHMODE_CACHE_CHOICES", () => {
  it("offers the default and stays inside the accepted range", () => {
    expect(WATCHMODE_CACHE_CHOICES).toContain(DEFAULT_WATCHMODE_CACHE_DAYS);
    for (const days of WATCHMODE_CACHE_CHOICES) {
      expect(clampWatchmodeCacheDays(days)).toBe(days);
    }
  });
});
