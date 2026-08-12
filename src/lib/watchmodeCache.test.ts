import { describe, it, expect } from "vitest";
import {
  clampWatchmodeCacheDays,
  watchmodeCacheTtlMs,
  watchmodeCacheDisabled,
  watchmodeCacheOptionLabel,
  watchmodeCacheSummary,
  describeWatchmodeCache,
  DEFAULT_WATCHMODE_CACHE_DAYS,
  MIN_WATCHMODE_CACHE_DAYS,
  MAX_WATCHMODE_CACHE_DAYS,
  WATCHMODE_CACHE_CHOICES,
  WATCHMODE_CACHE_DISABLED,
} from "./watchmodeCache";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("clampWatchmodeCacheDays", () => {
  it("keeps a value inside the range", () => {
    expect(clampWatchmodeCacheDays(1)).toBe(1);
    expect(clampWatchmodeCacheDays(7)).toBe(7);
    expect(clampWatchmodeCacheDays(90)).toBe(90);
  });

  it("keeps a deliberate zero, which is what disables caching", () => {
    expect(clampWatchmodeCacheDays(0)).toBe(WATCHMODE_CACHE_DISABLED);
  });

  it("clamps to the bounds rather than rejecting", () => {
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

  it("is zero when caching is off, so nothing is ever fresh", () => {
    // The freshness checks are all `age < ttl`, which no age satisfies at zero —
    // that is the whole implementation of "disabled".
    expect(watchmodeCacheTtlMs(WATCHMODE_CACHE_DISABLED)).toBe(0);
    expect(0 - 0 < watchmodeCacheTtlMs(WATCHMODE_CACHE_DISABLED)).toBe(false);
  });

  it("falls back to the default rather than NaN for a broken value", () => {
    expect(watchmodeCacheTtlMs(Number.NaN)).toBe(DEFAULT_WATCHMODE_CACHE_DAYS * DAY_MS);
  });
});

describe("watchmodeCacheDisabled", () => {
  it("is true only at zero", () => {
    expect(watchmodeCacheDisabled(0)).toBe(true);
    expect(watchmodeCacheDisabled(-1)).toBe(true); // clamped to the floor
    expect(watchmodeCacheDisabled(1)).toBe(false);
    expect(watchmodeCacheDisabled(null)).toBe(false); // unset means the default
  });
});

describe("describeWatchmodeCache", () => {
  it("singularises one day", () => {
    expect(describeWatchmodeCache(1)).toBe("1 day");
    expect(describeWatchmodeCache(7)).toBe("7 days");
  });

  it("says disabled at zero, in the case each caller needs", () => {
    // Mid-sentence in hints and run logs; capitalised as a dropdown option.
    expect(describeWatchmodeCache(0)).toBe("disabled");
    expect(watchmodeCacheOptionLabel(0)).toBe("Disabled");
    expect(watchmodeCacheOptionLabel(7)).toBe("7 days");
    expect(watchmodeCacheSummary(0)).toBe("cache disabled");
    expect(watchmodeCacheSummary(7)).toBe("7 days cache");
  });
});

describe("WATCHMODE_CACHE_CHOICES", () => {
  it("leads with Disabled, offers the default, and stays inside the range", () => {
    expect(WATCHMODE_CACHE_CHOICES[0]).toBe(WATCHMODE_CACHE_DISABLED);
    expect(WATCHMODE_CACHE_CHOICES).toContain(DEFAULT_WATCHMODE_CACHE_DAYS);
    for (const days of WATCHMODE_CACHE_CHOICES) {
      expect(clampWatchmodeCacheDays(days)).toBe(days);
    }
  });
});
