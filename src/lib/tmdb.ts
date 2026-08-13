/**
 * Thin, typed client for TheMovieDB (TMDB) API — https://api.themoviedb.org.
 *
 * Used for MOVIE streaming availability (TV episodes remain on Watchmode).
 * TMDB's watch-provider data is powered by JustWatch.
 *
 * Endpoints used:
 *   GET /3/watch/providers/regions            -> supported regions
 *   GET /3/watch/providers/movie?watch_region -> movie providers (with logos)
 *   GET /3/movie/{id}/watch/providers          -> per-title availability by region
 *
 * Auth: v3 API key sent as the `api_key` query parameter. (TMDB also accepts a
 * v4 bearer token, but the classic v3 key is what most users have.)
 *
 * TMDB's calls are free, so nothing here rations them — the one limit that
 * bites is how *fast* they arrive, which is waited out and paced against rather
 * than failed on. See `lib/providerThrottle.ts`.
 */

import { ProviderThrottle, parseRetryAfter } from "./providerThrottle";

const BASE = "https://api.themoviedb.org/3";
export const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/original";

export interface TmdbRegion {
  iso_3166_1: string; // e.g. "US"
  english_name: string;
  native_name?: string;
}

export interface TmdbProvider {
  provider_id: number;
  provider_name: string;
  logo_path?: string;
  display_priority?: number;
  display_priorities?: Record<string, number>;
}

export interface TmdbProviderEntry {
  provider_id: number;
  provider_name: string;
  logo_path?: string;
  display_priority?: number;
}

// Per-region availability. Each category is optional.
export interface TmdbRegionAvailability {
  link?: string;
  flatrate?: TmdbProviderEntry[];
  free?: TmdbProviderEntry[];
  ads?: TmdbProviderEntry[];
  rent?: TmdbProviderEntry[];
  buy?: TmdbProviderEntry[];
}

export class TmdbError extends Error {
  constructor(
    message: string,
    public status?: number,
    /** Milliseconds TMDB asked us to wait, from `Retry-After` on a 429. */
    public retryAfterMs?: number
  ) {
    super(message);
    this.name = "TmdbError";
  }
}

/**
 * True when an error means "TMDB has no such id" (HTTP 404 / status_code 34),
 * as opposed to a transient failure. TMDB deletes or merges entries — most
 * often cancelled or never-produced films — leaving Radarr with a dead id.
 * Transient problems surface as 5xx/429/timeouts, so 404 is safe to act on.
 */
export function isTmdbNotFound(e: unknown): boolean {
  return e instanceof TmdbError && e.status === 404;
}

// In-process TTL cache (reference data changes rarely; per-title cached briefly).
type CacheEntry = { value: unknown; expires: number };
const cache = new Map<string, CacheEntry>();
function cacheGet<T>(key: string): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return hit.value as T;
}
function cacheSet(key: string, value: unknown, ttlMs: number) {
  cache.set(key, { value, expires: Date.now() + ttlMs });
}

/** Notified when a request is rate limited, so a sync can say so in its log. */
export interface TmdbRateLimitInfo {
  /** Which attempt at this request was refused (1-based). */
  attempt: number;
  /** How long the whole client now pauses before trying again. */
  waitMs: number;
  /** The gap now kept between requests; 0 while none has been needed. */
  intervalMs: number;
  /** Whether this 429 moved the pacing along, or echoed one already answered. */
  escalated: boolean;
}

export interface TmdbClientOptions {
  onRateLimited?: (info: TmdbRateLimitInfo) => void;
  /** Test seam: injects the throttle's clock so backoff needn't be waited out. */
  throttle?: ProviderThrottle;
}

/**
 * How many times a rate-limited request is tried again.
 *
 * Same budget as the Watchmode client, for the same reason: long enough to ride
 * out a burst, short enough that a movie which cannot be looked up is left
 * unknown rather than the sync holding its run lock open waiting for it.
 */
const MAX_RATE_LIMIT_ATTEMPTS = 4;

export class TmdbClient {
  private readonly onRateLimited?: (info: TmdbRateLimitInfo) => void;
  /** Shared pacing for every request this client makes. */
  private readonly throttle: ProviderThrottle;

  constructor(private apiKey: string, opts: TmdbClientOptions = {}) {
    if (!apiKey) throw new TmdbError("TMDB API key is not configured.");
    this.onRateLimited = opts.onRateLimited;
    this.throttle = opts.throttle ?? new ProviderThrottle();
  }

  /**
   * One request, retried while TMDB says it is arriving too fast.
   *
   * A 429 is not a fact about the movie — retried a moment later the same call
   * succeeds — so failing the title on the first refusal both lost an answer
   * TMDB was willing to give and left the titles behind it going just as fast,
   * to trip the same limit again. The pause is held on the throttle rather than
   * slept on here, so the other `SYNC_CONCURRENCY` workers hold off too instead
   * of filling the gap this one just left.
   */
  private async get<T>(
    path: string,
    params: Record<string, string | number | undefined> = {},
    ttlMs = 0,
    timeoutMs = 20_000
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.throttle.acquire();
      try {
        return await this.fetchOnce<T>(path, params, ttlMs, timeoutMs);
      } catch (e) {
        if (!(e instanceof TmdbError) || e.status !== 429) throw e;
        if (attempt >= MAX_RATE_LIMIT_ATTEMPTS - 1) {
          // Still 429 with the pacing already widened: say what would help,
          // since the run log line is all the user has to go on.
          throw new TmdbError(
            `TMDB is rate limiting requests — still refused after ${MAX_RATE_LIMIT_ATTEMPTS} attempts. ` +
              "Lower SYNC_CONCURRENCY if it keeps happening.",
            429
          );
        }
        const step = this.throttle.rateLimited(attempt, e.retryAfterMs ?? null);
        this.onRateLimited?.({ attempt: attempt + 1, ...step });
      }
    }
  }

  private async fetchOnce<T>(
    path: string,
    params: Record<string, string | number | undefined>,
    ttlMs: number,
    timeoutMs: number
  ): Promise<T> {
    const url = new URL(`${BASE}${path}`);
    url.searchParams.set("api_key", this.apiKey);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    // Cache key excludes the api_key.
    const cacheKey = `${path}?${new URLSearchParams(
      Object.entries(params).reduce<Record<string, string>>((acc, [k, v]) => {
        if (v !== undefined && v !== null && v !== "") acc[k] = String(v);
        return acc;
      }, {})
    )}`;
    if (ttlMs > 0) {
      const cached = cacheGet<T>(cacheKey);
      if (cached !== undefined) return cached;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: controller.signal,
      });
    } catch (e) {
      if ((e as Error).name === "AbortError") throw new TmdbError("TMDB request timed out.", 408);
      throw e;
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401) throw new TmdbError("TMDB rejected the API key (invalid).", 401);
    if (res.status === 429) {
      throw new TmdbError(
        "TMDB is rate limiting requests.",
        429,
        parseRetryAfter(res.headers.get("retry-after")) ?? undefined
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new TmdbError(`TMDB request failed (${res.status}): ${body.slice(0, 200)}`, res.status);
    }

    const data = (await res.json()) as T;
    if (ttlMs > 0) cacheSet(cacheKey, data, ttlMs);
    return data;
  }

  // Reference-data / validation lookups are only used by the interactive
  // Settings UI, so they fail fast rather than leaving the page waiting.
  private static readonly UI_TIMEOUT_MS = 10_000;

  /** Validate the key (cheap authenticated call). */
  async validate(): Promise<boolean> {
    await this.get("/authentication", {}, 0, TmdbClient.UI_TIMEOUT_MS);
    return true;
  }

  /** Supported watch-provider regions. Cached 24h. */
  async regions(): Promise<TmdbRegion[]> {
    const data = await this.get<{ results: TmdbRegion[] }>(
      "/watch/providers/regions",
      {},
      24 * 60 * 60 * 1000,
      TmdbClient.UI_TIMEOUT_MS
    );
    return data.results ?? [];
  }

  /** Movie providers, optionally filtered to one region. Cached 6h. */
  async movieProviders(watchRegion?: string): Promise<TmdbProvider[]> {
    const data = await this.get<{ results: TmdbProvider[] }>(
      "/watch/providers/movie",
      { watch_region: watchRegion },
      6 * 60 * 60 * 1000,
      TmdbClient.UI_TIMEOUT_MS
    );
    return data.results ?? [];
  }

  /** Per-region availability for a movie. Cached 30m. */
  async movieWatchProviders(
    tmdbId: number
  ): Promise<Record<string, TmdbRegionAvailability>> {
    const data = await this.get<{ results: Record<string, TmdbRegionAvailability> }>(
      `/movie/${tmdbId}/watch/providers`,
      {},
      30 * 60 * 1000
    );
    return data.results ?? {};
  }
}

export interface MatchedTmdbProvider {
  providerId: number;
  name: string;
  type: string; // flatrate | free | ads | rent | buy
  region: string;
  /** Absolute logo URL, or null when TMDB has no logo for the provider. */
  logo: string | null;
}

/**
 * Given a movie's per-region availability, the user's selected regions,
 * provider ids and counted categories, return the matched providers.
 * Empty array == not on the user's streaming services.
 */
export function matchTmdbProviders(
  availability: Record<string, TmdbRegionAvailability>,
  regions: string[],
  providerIds: number[],
  countedTypes: string[]
): MatchedTmdbProvider[] {
  const ids = new Set(providerIds);
  const wantRegions = new Set(regions);
  const wantTypes = new Set(countedTypes);
  const seen = new Set<string>();
  const out: MatchedTmdbProvider[] = [];

  const categories: (keyof TmdbRegionAvailability)[] = ["flatrate", "free", "ads", "rent", "buy"];

  for (const [region, avail] of Object.entries(availability)) {
    if (!wantRegions.has(region)) continue;
    for (const cat of categories) {
      if (!wantTypes.has(cat)) continue;
      const list = avail[cat];
      if (!Array.isArray(list)) continue;
      for (const p of list) {
        if (!ids.has(p.provider_id)) continue;
        const key = `${p.provider_id}:${region}:${cat}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          providerId: p.provider_id,
          name: p.provider_name,
          type: cat,
          region,
          logo: p.logo_path ? `${TMDB_IMAGE_BASE}${p.logo_path}` : null,
        });
      }
    }
  }
  return out;
}
