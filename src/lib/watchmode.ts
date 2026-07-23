/**
 * Thin, typed client for the Watchmode API (https://api.watchmode.com).
 *
 * Endpoints used:
 *   GET /v1/regions/                      -> supported countries
 *   GET /v1/sources/?regions=US,GB        -> streaming services
 *   GET /v1/search/?search_field=...      -> map TMDB/IMDB id -> Watchmode id
 *   GET /v1/title/{id}/sources/?regions=  -> streaming sources for a title
 *   GET /v1/title/{id}/episodes/?regions= -> episodes incl. per-episode sources
 *
 * Auth is sent with the `X-API-Key` header (recommended over the query string).
 */

const BASE = "https://api.watchmode.com/v1";

export interface WatchmodeRegion {
  name: string;
  country: string; // ISO 3166-1 alpha-2, e.g. "US"
}

export interface WatchmodeSource {
  id: number;
  name: string;
  type: string; // sub | free | purchase | rent | tv_everywhere
  logo_100px?: string;
  ios_appstore_url?: string;
  android_playstore_url?: string;
  regions?: string[];
}

export interface WatchmodeTitleSource {
  source_id: number;
  name: string;
  type: string;
  region: string;
  web_url?: string;
  format?: string;
  price?: number | null;
  seasons?: number | null;
  episodes?: number | null;
}

export interface WatchmodeSearchTitleResult {
  id: number;
  name: string;
  type: string;
  year?: number;
  imdb_id?: string;
  tmdb_id?: number;
  tmdb_type?: string;
}

export interface WatchmodeEpisode {
  id: number;
  name: string;
  episode_number: number;
  season_number: number;
  tmdb_id?: number;
  imdb_id?: string;
  release_date?: string;
  sources?: WatchmodeTitleSource[];
}

export class WatchmodeError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "WatchmodeError";
  }
}

// Simple in-process TTL cache. Reference data (regions/sources) changes rarely;
// title lookups are cached briefly to avoid burning quota within a single run.
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

export class WatchmodeClient {
  constructor(private apiKey: string) {
    if (!apiKey) throw new WatchmodeError("Watchmode API key is not configured.");
  }

  private async get<T>(
    path: string,
    params: Record<string, string | number | undefined> = {},
    ttlMs = 0
  ): Promise<T> {
    const url = new URL(`${BASE}${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    const cacheKey = url.toString();
    if (ttlMs > 0) {
      const cached = cacheGet<T>(cacheKey);
      if (cached !== undefined) return cached;
    }

    // Hard timeout so a hung Watchmode endpoint can't stall a whole sync.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        headers: { "X-API-Key": this.apiKey, Accept: "application/json" },
        // Watchmode data is not real-time; avoid Next.js caching surprises.
        cache: "no-store",
        signal: controller.signal,
      });
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        throw new WatchmodeError("Watchmode request timed out.", 408);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401 || res.status === 403) {
      throw new WatchmodeError("Watchmode rejected the API key (invalid or over quota).", res.status);
    }
    if (res.status === 429) {
      throw new WatchmodeError("Watchmode rate limit / quota exceeded.", 429);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new WatchmodeError(`Watchmode request failed (${res.status}): ${body.slice(0, 200)}`, res.status);
    }

    const data = (await res.json()) as T;
    if (ttlMs > 0) cacheSet(cacheKey, data, ttlMs);
    return data;
  }

  /** All supported countries/regions. Cached 24h. */
  async regions(): Promise<WatchmodeRegion[]> {
    return this.get<WatchmodeRegion[]>("/regions/", {}, 24 * 60 * 60 * 1000);
  }

  /**
   * All streaming sources, optionally filtered to the given region codes.
   * Cached 6h. Each source carries a `regions` array so we can present per
   * country availability in the UI.
   */
  async sources(regions?: string[]): Promise<WatchmodeSource[]> {
    return this.get<WatchmodeSource[]>(
      "/sources/",
      { regions: regions && regions.length ? regions.join(",") : undefined },
      6 * 60 * 60 * 1000
    );
  }

  /** Verify the key + return quota status. */
  async status(): Promise<{ quota: number; quotaUsed: number }> {
    return this.get<{ quota: number; quotaUsed: number }>("/status/");
  }

  /**
   * Resolve a Watchmode title id from external ids.
   *
   * Order of preference:
   *   0) Local Title ID map (imported CSV) — free, no quota cost. Injected by
   *      the caller via `opts.resolveLocal` to keep this module dependency-free.
   *   1) Watchmode /search by TMDB id.
   *   2) Watchmode /search by IMDB id.
   *   3) Watchmode /search by name (disambiguated by type + year).
   * Returns null if not found.
   */
  async findTitleId(opts: {
    tmdbId?: number | null;
    imdbId?: string | null;
    type: "movie" | "tv";
    name?: string;
    year?: number | null;
    resolveLocal?: (o: {
      tmdbId?: number | null;
      imdbId?: string | null;
      type: "movie" | "tv";
    }) => Promise<number | null>;
  }): Promise<number | null> {
    // 0) Local map first (avoids Watchmode search quota entirely).
    if (opts.resolveLocal) {
      const local = await opts.resolveLocal({
        tmdbId: opts.tmdbId,
        imdbId: opts.imdbId,
        type: opts.type,
      });
      if (local) return local;
    }
    // 1) TMDB id (most reliable when present).
    if (opts.tmdbId) {
      const field = opts.type === "movie" ? "tmdb_movie_id" : "tmdb_tv_id";
      const r = await this.search(field, String(opts.tmdbId));
      const found = r.find((t) => t.tmdb_id === opts.tmdbId);
      if (found) return found.id;
      if (r[0]) return r[0].id;
    }
    // 2) IMDB id.
    if (opts.imdbId) {
      const r = await this.search("imdb_id", opts.imdbId);
      if (r[0]) return r[0].id;
    }
    // 3) Name (last resort, disambiguate by year + type).
    if (opts.name) {
      const r = await this.search("name", opts.name);
      const wanted = opts.type === "movie" ? "movie" : "tv_series";
      const byYear = r.find(
        (t) => t.type === wanted && (!opts.year || t.year === opts.year)
      );
      if (byYear) return byYear.id;
      const byType = r.find((t) => t.type === wanted);
      if (byType) return byType.id;
      if (r[0]) return r[0].id;
    }
    return null;
  }

  private async search(field: string, value: string): Promise<WatchmodeSearchTitleResult[]> {
    const data = await this.get<{ title_results?: WatchmodeSearchTitleResult[] }>(
      "/search/",
      { search_field: field, search_value: value },
      60 * 60 * 1000
    );
    return data.title_results ?? [];
  }

  /** Streaming sources for a title in the given regions. Cached 30m. */
  async titleSources(watchmodeId: number, regions: string[]): Promise<WatchmodeTitleSource[]> {
    return this.get<WatchmodeTitleSource[]>(
      `/title/${watchmodeId}/sources/`,
      { regions: regions.join(",") },
      30 * 60 * 1000
    );
  }

  /** Episodes for a TV title, each with per-episode sources. Cached 30m. */
  async titleEpisodes(watchmodeId: number, regions: string[]): Promise<WatchmodeEpisode[]> {
    return this.get<WatchmodeEpisode[]>(
      `/title/${watchmodeId}/episodes/`,
      { regions: regions.join(",") },
      30 * 60 * 1000
    );
  }
}

/**
 * Given a set of a title's sources and the user's selected service ids +
 * counted types, return the matched sources (empty array == not on streaming).
 */
export function matchSources(
  sources: WatchmodeTitleSource[] | undefined,
  serviceIds: number[],
  countedTypes: string[]
): WatchmodeTitleSource[] {
  if (!sources || !sources.length) return [];
  const ids = new Set(serviceIds);
  const types = new Set(countedTypes);
  const seen = new Set<string>();
  const out: WatchmodeTitleSource[] = [];
  for (const s of sources) {
    if (!ids.has(s.source_id)) continue;
    if (!types.has(s.type)) continue;
    const key = `${s.source_id}:${s.region}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}
