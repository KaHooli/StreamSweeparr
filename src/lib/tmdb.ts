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
 */

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
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "TmdbError";
  }
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

export class TmdbClient {
  constructor(private apiKey: string) {
    if (!apiKey) throw new TmdbError("TMDB API key is not configured.");
  }

  private async get<T>(
    path: string,
    params: Record<string, string | number | undefined> = {},
    ttlMs = 0
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
    const timer = setTimeout(() => controller.abort(), 20_000);
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
    if (res.status === 429) throw new TmdbError("TMDB rate limit exceeded.", 429);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new TmdbError(`TMDB request failed (${res.status}): ${body.slice(0, 200)}`, res.status);
    }

    const data = (await res.json()) as T;
    if (ttlMs > 0) cacheSet(cacheKey, data, ttlMs);
    return data;
  }

  /** Validate the key (cheap authenticated call). */
  async validate(): Promise<boolean> {
    await this.get("/authentication");
    return true;
  }

  /** Supported watch-provider regions. Cached 24h. */
  async regions(): Promise<TmdbRegion[]> {
    const data = await this.get<{ results: TmdbRegion[] }>(
      "/watch/providers/regions",
      {},
      24 * 60 * 60 * 1000
    );
    return data.results ?? [];
  }

  /** Movie providers, optionally filtered to one region. Cached 6h. */
  async movieProviders(watchRegion?: string): Promise<TmdbProvider[]> {
    const data = await this.get<{ results: TmdbProvider[] }>(
      "/watch/providers/movie",
      { watch_region: watchRegion },
      6 * 60 * 60 * 1000
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
        out.push({ providerId: p.provider_id, name: p.provider_name, type: cat, region });
      }
    }
  }
  return out;
}
