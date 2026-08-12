/**
 * How long a Watchmode answer is kept before it is asked for again.
 *
 * Watchmode credits are the scarce resource in this app, and on a free /
 * developer key they are the *only* thing rationing usage: those plans have no
 * Changes API, so the sync has nothing to tell it which series moved and falls
 * back entirely on "this answer is still young enough". Seven days is the
 * default because a monthly free budget spread over a weekly re-check is what
 * a normal library fits into.
 *
 * It is a setting rather than a constant because the right window depends on
 * the plan and the library: a paid key that already gets change detection can
 * afford a shorter window (the TTL is only its safety net), and a large library
 * on a free key may need a longer one to stay inside the budget at all.
 *
 * The window covers every metered Watchmode lookup: per-episode availability
 * for series, the title-level sources call that fills in provider deep links,
 * and — when `movieProvider` is WATCHMODE — movies too. It deliberately does
 * not cover TMDB movies, whose calls are free and which keep their own 24-hour
 * window (see `MOVIE_TTL_MS` in lib/sync.ts).
 *
 * No I/O here, so the settings card, the API route and the sync engine can all
 * import it.
 */

/**
 * Caching off: every sync looks every title up again.
 *
 * Zero is the sentinel rather than a separate boolean column because it is
 * already what the arithmetic says — a window of zero milliseconds means no
 * stored answer is ever young enough — so the freshness checks need no special
 * case and cannot disagree with a flag.
 *
 * It is a real choice (a paid plan with credits to spare, or a debugging
 * session where a stale snapshot is the thing being chased), but an expensive
 * one, so the UI warns rather than merely offering it.
 */
export const WATCHMODE_CACHE_DISABLED = 0;

/** Windows offered in the UI, in days; 0 (disabled) leads the list. */
export const WATCHMODE_CACHE_CHOICES = [
  WATCHMODE_CACHE_DISABLED,
  1,
  2,
  3,
  5,
  7,
  14,
  30,
  60,
  90,
] as const;

/** The floor is "disabled"; 1 day is the shortest window that still caches. */
export const MIN_WATCHMODE_CACHE_DAYS = WATCHMODE_CACHE_DISABLED;
/** Three months. Past this the snapshot is stale enough to be misleading. */
export const MAX_WATCHMODE_CACHE_DAYS = 90;

/**
 * The window a free / developer key is sized for, and what every install starts
 * on. Changing this changes the default for new installs only — existing rows
 * carry their own stored value.
 */
export const DEFAULT_WATCHMODE_CACHE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Clamp a stored or submitted value into the accepted range.
 *
 * Reads go through this as well as writes: a row written by an older build (or
 * by hand) must not be able to turn the freshness check into `NaN`, which would
 * make every title look stale and re-spend the whole budget on one sync. Note
 * that a *deliberate* zero does exactly that — the difference is that it was
 * asked for.
 */
export function clampWatchmodeCacheDays(days: number | null | undefined): number {
  if (typeof days !== "number" || !Number.isFinite(days)) return DEFAULT_WATCHMODE_CACHE_DAYS;
  const whole = Math.round(days);
  if (whole < MIN_WATCHMODE_CACHE_DAYS) return MIN_WATCHMODE_CACHE_DAYS;
  if (whole > MAX_WATCHMODE_CACHE_DAYS) return MAX_WATCHMODE_CACHE_DAYS;
  return whole;
}

/** Whether caching is switched off, i.e. every sync re-looks-up everything. */
export function watchmodeCacheDisabled(days: number | null | undefined): boolean {
  return clampWatchmodeCacheDays(days) === WATCHMODE_CACHE_DISABLED;
}

/**
 * The configured window in milliseconds, ready for a freshness comparison.
 *
 * Zero when caching is off, which every `age < ttl` test reads as "not fresh"
 * without being told about the setting.
 */
export function watchmodeCacheTtlMs(days: number | null | undefined): number {
  return clampWatchmodeCacheDays(days) * DAY_MS;
}

/**
 * "1 day" / "7 days" / "disabled" — for hints and run logs, where it appears
 * mid-sentence, so it is lower case.
 */
export function describeWatchmodeCache(days: number): string {
  const whole = clampWatchmodeCacheDays(days);
  if (whole === WATCHMODE_CACHE_DISABLED) return "disabled";
  return whole === 1 ? "1 day" : `${whole} days`;
}

/** The same, as a dropdown option: "Disabled" / "1 day" / "7 days". */
export function watchmodeCacheOptionLabel(days: number): string {
  const described = describeWatchmodeCache(days);
  return described === "disabled" ? "Disabled" : described;
}

/**
 * "7 days cache" / "cache disabled" — for the diagnostics line, where the
 * setting is one field among many rather than part of a sentence.
 */
export function watchmodeCacheSummary(days: number): string {
  return watchmodeCacheDisabled(days) ? "cache disabled" : `${describeWatchmodeCache(days)} cache`;
}
