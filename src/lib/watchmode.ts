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
 *
 * The client is constructed with a *ring* of keys (usually one). Every request
 * starts at key 1; a key that is rejected or out of quota is retired for the
 * lifetime of the client and the request is retried on the next key. See
 * `lib/watchmodeKeys.ts` for the ring itself.
 */

import { normalizeWatchmodeKeys } from "./watchmodeKeys";

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
  /**
   * Browser deep link to the title on that service. This is the only link we
   * ever surface in the UI: `ios_url`/`android_url` are app-scheme links that
   * do nothing in a desktop browser, so they are deliberately unused.
   */
  web_url?: string;
  ios_url?: string;
  android_url?: string;
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

/** Notified when a key is retired, so a sync can say so in its log. */
export interface WatchmodeKeyExhaustedInfo {
  /** 1-based number of the key that was retired. */
  number: number;
  /** How many keys are configured in total. */
  total: number;
  error: WatchmodeError;
}

export interface WatchmodeClientOptions {
  onKeyExhausted?: (info: WatchmodeKeyExhaustedInfo) => void;
}

/**
 * A status that means "this key is done": 401/403 are Watchmode's answer for an
 * invalid key *and* for one that has spent its credits, 429 for a key that is
 * being rate limited. All three are reasons to move to the next key rather than
 * to fail the request.
 */
function isKeyExhausted(e: unknown): e is WatchmodeError {
  const status = e instanceof WatchmodeError ? e.status : undefined;
  return status === 401 || status === 403 || status === 429;
}

export class WatchmodeClient {
  private readonly keys: string[];
  private readonly onKeyExhausted?: (info: WatchmodeKeyExhaustedInfo) => void;
  /** Indices of keys retired during this client's lifetime. */
  private readonly exhausted = new Set<number>();
  /** Why the last key was retired — the error reported once all keys are gone. */
  private lastExhaustedError: WatchmodeError | null = null;

  constructor(apiKey: string | readonly string[], opts: WatchmodeClientOptions = {}) {
    this.keys = normalizeWatchmodeKeys(Array.isArray(apiKey) ? apiKey : [apiKey as string]);
    if (!this.keys.length) throw new WatchmodeError("Watchmode API key is not configured.");
    this.onKeyExhausted = opts.onKeyExhausted;
  }

  /** How many keys this client can draw on. */
  get keyCount(): number {
    return this.keys.length;
  }

  /** 1-based number of the key the next request will use, or null if all are spent. */
  get activeKeyNumber(): number | null {
    const index = this.keys.findIndex((_, i) => !this.exhausted.has(i));
    return index === -1 ? null : index + 1;
  }

  /** Indices still worth trying, in ring order (always starting at key 1). */
  private *liveKeys(): Generator<number> {
    for (let i = 0; i < this.keys.length; i++) {
      if (!this.exhausted.has(i)) yield i;
    }
  }

  private async get<T>(
    path: string,
    params: Record<string, string | number | undefined> = {},
    ttlMs = 0,
    timeoutMs = 20_000,
    opts: { rotate?: boolean } = {}
  ): Promise<T> {
    const url = new URL(`${BASE}${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    // A response says nothing about which key fetched it, so the cache is keyed
    // on the URL alone and is shared across the whole ring.
    const href = url.toString();
    if (ttlMs > 0) {
      const cached = cacheGet<T>(href);
      if (cached !== undefined) return cached;
    }

    const rotate = opts.rotate !== false;
    for (const index of this.liveKeys()) {
      try {
        const data = await this.fetchWith<T>(this.keys[index], index, href, timeoutMs);
        if (ttlMs > 0) cacheSet(href, data, ttlMs);
        return data;
      } catch (e) {
        // Anything that isn't "this key is spent" is a real failure: retrying it
        // on another key would burn credits to get the same answer.
        if (!rotate || !isKeyExhausted(e)) throw e;
        this.exhausted.add(index);
        this.lastExhaustedError = e;
        this.onKeyExhausted?.({ number: index + 1, total: this.keys.length, error: e });
      }
    }

    throw (
      this.lastExhaustedError ??
      new WatchmodeError("Watchmode API key is not configured.", 401)
    );
  }

  /** A single attempt against one key. */
  private async fetchWith<T>(
    apiKey: string,
    index: number,
    url: string,
    timeoutMs: number
  ): Promise<T> {
    // Hard timeout so a hung Watchmode endpoint can't stall a whole sync.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { "X-API-Key": apiKey, Accept: "application/json" },
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

    // Which key failed only matters when there is more than one.
    const which = this.keys.length > 1 ? ` ${index + 1}` : "";
    if (res.status === 401 || res.status === 403) {
      throw new WatchmodeError(
        `Watchmode rejected API key${which} (invalid or over quota).`,
        res.status
      );
    }
    if (res.status === 429) {
      throw new WatchmodeError(`Watchmode rate limit / quota exceeded on API key${which}.`, 429);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new WatchmodeError(`Watchmode request failed (${res.status}): ${body.slice(0, 200)}`, res.status);
    }

    return (await res.json()) as T;
  }

  // Reference-data lookups are only used by the interactive Settings UI, so
  // they fail fast (10s) rather than leaving the page waiting — important when
  // outbound DNS/network is blocked (a common container/NAS misconfiguration).
  private static readonly UI_TIMEOUT_MS = 10_000;

  /** All supported countries/regions. Cached 24h. */
  async regions(): Promise<WatchmodeRegion[]> {
    return this.get<WatchmodeRegion[]>(
      "/regions/",
      {},
      24 * 60 * 60 * 1000,
      WatchmodeClient.UI_TIMEOUT_MS
    );
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
      6 * 60 * 60 * 1000,
      WatchmodeClient.UI_TIMEOUT_MS
    );
  }

  /**
   * Verify the key + return quota status.
   *
   * No failover: this reports on the key the ring is currently on, and a caller
   * checking a key wants to hear that it was rejected, not to be handed another
   * key's numbers. Settings tests each key with its own client.
   */
  async status(): Promise<{ quota: number; quotaUsed: number }> {
    return this.get<{ quota: number; quotaUsed: number }>(
      "/status/",
      {},
      0,
      20_000,
      { rotate: false }
    );
  }

  /**
   * Detect whether the account has access to the premium Changes endpoints
   * (i.e. a paid plan). The /status endpoint does not expose the plan tier, so
   * we probe the cheapest changes call with a 1-day window:
   *   - success  -> "paid"  (Changes API usable → enable change-detection)
   *   - 401/403  -> "free"  (premium endpoints not permitted → TTL fallback)
   *   - other errors are treated as "unknown" (caller keeps prior state).
   * Costs a single API request; the result is cached on Settings.
   *
   * Failover is deliberately off here: on a free plan every key answers 403, so
   * rotating would spend a request on each one only to reach the same verdict.
   * The probe uses the key the ring is currently on.
   */
  async detectPlan(): Promise<"paid" | "free" | "unknown"> {
    const today = toYyyymmdd(new Date());
    try {
      await this.get<{ titles?: number[] }>(
        "/changes/titles_episodes_changed/",
        { start_date: today, end_date: today, page: 1, limit: 1 },
        0,
        20_000,
        { rotate: false }
      );
      return "paid";
    } catch (e) {
      const status = (e as WatchmodeError).status;
      if (status === 401 || status === 403) return "free";
      // 429 / 5xx / network — inconclusive.
      return "unknown";
    }
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

  /**
   * Streaming sources for a title as a whole (as opposed to per episode).
   *
   * Unlike the per-episode links from `titleEpisodes`, the `web_url` here is a
   * real URL on every plan tier, so this is what makes the dashboard provider
   * logos clickable on a free Watchmode plan. Cached 30m.
   */
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

  /**
   * Return the set of Watchmode title ids whose episodes changed since `since`.
   * Paginated; a handful of calls covers the whole feed regardless of library
   * size — the key to keeping sync quota near-zero on steady-state libraries.
   *
   * The Changes API is only available on paid Watchmode plans. Callers should
   * treat a thrown error (e.g. 401/403) as "changes feed unavailable" and fall
   * back to a time-based refresh.
   */
  async episodesChangedSince(since: Date): Promise<Set<number>> {
    const start = toYyyymmdd(since);
    const end = toYyyymmdd(new Date());
    const changed = new Set<number>();
    let page = 1;
    // Hard page cap so a pathological total_pages can't run away with quota.
    const MAX_PAGES = 20;
    // Do not cache — this is intentionally fresh each sync.
    for (; page <= MAX_PAGES; page++) {
      const data = await this.get<{
        titles?: number[];
        page?: number;
        total_pages?: number;
      }>("/changes/titles_episodes_changed/", { start_date: start, end_date: end, page, limit: 250 });
      for (const id of data.titles ?? []) changed.add(id);
      if (!data.total_pages || page >= data.total_pages) break;
    }
    return changed;
  }
}

function toYyyymmdd(d: Date): number {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return Number(`${y}${m}${day}`);
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
