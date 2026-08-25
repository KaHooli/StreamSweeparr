/**
 * Clients for Sonarr v3 and Radarr v3, plus optional Seerr discovery.
 *
 * These talk directly to the *arr APIs which is the only way to toggle
 * episode-level monitoring and delete files. Seerr is used purely to discover
 * configured Sonarr/Radarr instances when the user does not enter them by hand.
 */

import { safeFetch, type SafeFetchOptions } from "./safeFetch";

export class ArrError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "ArrError";
  }
}

function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

async function arrFetch<T>(
  baseUrl: string,
  apiKey: string,
  path: string,
  init: SafeFetchOptions = {}
): Promise<T> {
  const url = `${normalizeBase(baseUrl)}${path}`;
  // safeFetch validates the host (SSRF guard) and applies a timeout. Callers
  // may override `timeoutMs` for an endpoint whose work is not bounded by the
  // *arr's own responsiveness — see `removeFromQueue`.
  const res = await safeFetch(url, {
    ...init,
    headers: {
      "X-Api-Key": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init.headers || {}),
    },
    cache: "no-store",
  });
  if (res.status === 401 || res.status === 403) {
    throw new ArrError(`Authentication failed for ${url} (check API key).`, res.status);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ArrError(`Request failed ${res.status} ${url}: ${body.slice(0, 200)}`, res.status);
  }
  if (res.status === 204) return undefined as unknown as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/* -------------------------------- Tags --------------------------------- */

export interface ArrTag {
  id: number;
  label: string;
}

/**
 * Titles carrying this tag in Sonarr/Radarr are left completely alone:
 * StreamSweeparr does not look up their streaming availability, never changes
 * their monitored state, never deletes their files and never searches them.
 * Matched case-insensitively.
 */
export const SKIP_TAG_LABEL = "ss-skip";

/**
 * Given an instance's tag list, return the ids that mean "skip me".
 * (A label can in principle exist more than once, so this returns a set.)
 */
export function resolveSkipTagIds(
  tags: ArrTag[] | undefined | null,
  label: string = SKIP_TAG_LABEL
): Set<number> {
  const want = label.trim().toLowerCase();
  const out = new Set<number>();
  for (const t of tags ?? []) {
    if (typeof t?.id === "number" && t?.label?.trim().toLowerCase() === want) out.add(t.id);
  }
  return out;
}

/** Whether a title's tag ids include any of the skip tag ids. */
export function hasSkipTag(
  titleTags: number[] | undefined | null,
  skipIds: Set<number>
): boolean {
  if (!skipIds.size || !titleTags?.length) return false;
  return titleTags.some((id) => skipIds.has(id));
}

/* -------------------------- Download queue ------------------------------ */

/**
 * One row of Sonarr's or Radarr's download queue.
 *
 * Both apps return the same shape from `GET /api/v3/queue`, differing only in
 * which id names the title: Sonarr sends `episodeId` (plus `seriesId`), Radarr
 * sends `movieId`. `id` is the queue *record's* id — that, not the title's, is
 * what the removal endpoint takes.
 */
export interface ArrQueueItem {
  /** The queue record's own id. What DELETE /api/v3/queue/bulk takes. */
  id: number;
  /** Sonarr. Null for a record *arr cannot attribute to a known episode. */
  episodeId?: number | null;
  seriesId?: number | null;
  /** Radarr. */
  movieId?: number | null;
  /**
   * The download's id in the download client. Several queue records share one
   * when a single grab covers several episodes — see `planQueueRemovals` in
   * lib/sweep.ts, which is why this is carried through.
   */
  downloadId?: string | null;
  title?: string | null;
  /** QueueStatus: queued | downloading | paused | completed | failed | … */
  status?: string | null;
  /** TrackedDownloadState: downloading | importPending | importing | … */
  trackedDownloadState?: string | null;
}

interface ArrQueuePage {
  page: number;
  pageSize: number;
  totalRecords: number;
  records: ArrQueueItem[];
}

/**
 * `pageSize` for a queue read.
 *
 * The endpoint's own default is **10**, which is the trap here: a plain
 * `GET /api/v3/queue` returns ten rows and a `totalRecords` nobody reads, so a
 * queue of any size looks like it was walked when it was not. Asking for a
 * large page keeps a normal queue to one request; `fetchQueue` still pages, for
 * the install whose queue is bigger than this.
 */
const QUEUE_PAGE_SIZE = 1000;

/** Stop a malformed `totalRecords` turning pagination into an endless loop. */
const QUEUE_MAX_PAGES = 50;

/**
 * Which queue rows may be cancelled: the ones still on their way in.
 *
 * `trackedDownloadState` is the lifecycle field, and it is `downloading` for
 * everything the client has not finished — that covers the rows whose `status`
 * reads `queued`, `paused`, `delay` or `downloadClientUnavailable` too. Once
 * the download completes it moves through `importPending` → `importing` →
 * `imported`, and those are deliberately left alone: the bytes are already on
 * disk, so removing one races Sonarr's own import for the file. Nothing is lost
 * by waiting — the next sweep sees an ordinary file and `deleteFiles` handles
 * it by the path that already exists.
 *
 * `importBlocked`, `failed` and `ignored` are skipped for a different reason:
 * they are stuck rows an admin is likely looking at, and quietly clearing
 * someone's failed-download list is not what "cancel the download" asked for.
 *
 * The field is only absent on an *arr too old to send it, where `status` is all
 * there is; `completed` is the one value that certainly must not be cancelled.
 */
export function isCancellableQueueItem(item: ArrQueueItem): boolean {
  if (item.trackedDownloadState) return item.trackedDownloadState === "downloading";
  return item.status !== "completed";
}

/**
 * Walk every page of a queue endpoint.
 *
 * Shared by both clients because the paging envelope is identical; `path` is
 * what differs, carrying each app's own id filter.
 */
async function fetchQueue(
  baseUrl: string,
  apiKey: string,
  path: string,
  params: URLSearchParams
): Promise<ArrQueueItem[]> {
  const out: ArrQueueItem[] = [];
  for (let page = 1; page <= QUEUE_MAX_PAGES; page++) {
    params.set("page", String(page));
    params.set("pageSize", String(QUEUE_PAGE_SIZE));
    const res = await arrFetch<ArrQueuePage>(baseUrl, apiKey, `${path}?${params}`);
    const records = res?.records ?? [];
    out.push(...records);
    if (!records.length || out.length >= (res?.totalRecords ?? 0)) break;
  }
  return out;
}

/**
 * Timeout for a queue removal, far longer than the 15s `safeFetch` default.
 *
 * `RemoveMany` is not a database write. Sonarr and Radarr loop over the ids
 * **serially**, and for each distinct download they call out to the download
 * client to delete it — so the request's duration is a function of how many
 * downloads are in the batch and how quick qBittorrent/SABnzbd is to answer,
 * neither of which the *arr's own responsiveness bounds. Under the default a
 * batch of any size timed out, and because aborting the HTTP request does not
 * stop the loop the server had already gone on removing things the run then
 * reported as failures.
 *
 * The batch size (`QUEUE_BATCH` in lib/sweep.ts) is what keeps this bounded;
 * this is the headroom for a download client having a slow minute.
 */
const QUEUE_REMOVE_TIMEOUT_MS = 120_000;

/**
 * Query string for a queue removal.
 *
 * Every one of these defaults the wrong way round for a sweep, so all three are
 * always sent explicitly:
 *
 *   - `removeFromClient` defaults to **true** at the API, which is the one
 *     default that happens to be what we want — but it is the destructive one,
 *     so it is stated rather than inherited.
 *   - `blocklist` must stay false. Blocklisting means "this release is bad";
 *     here the release is fine and the *title* is simply no longer wanted. Set
 *     it, and the release could never be grabbed again once the title leaves
 *     streaming and a later sweep re-monitors it.
 *   - `skipRedownload` must be true, or Sonarr/Radarr may go looking for a
 *     replacement the moment the row disappears — cancelling a download only to
 *     start another one.
 */
function queueRemovalParams(removeFromClient: boolean): URLSearchParams {
  return new URLSearchParams({
    removeFromClient: String(removeFromClient),
    blocklist: "false",
    skipRedownload: "true",
  });
}

/* ------------------------------- Sonarr -------------------------------- */

export interface SonarrSeason {
  seasonNumber: number;
  monitored: boolean;
}

export interface SonarrSeries {
  id: number;
  title: string;
  tags?: number[];
  year?: number;
  monitored: boolean;
  seasons?: SonarrSeason[];
  /** "continuing" | "ended" | "upcoming" | "deleted", as Sonarr reports it. */
  status?: string;
  tvdbId?: number;
  imdbId?: string;
  tmdbId?: number;
  images?: { coverType: string; remoteUrl?: string; url?: string }[];
  statistics?: { episodeFileCount?: number; episodeCount?: number; totalEpisodeCount?: number };
}

export interface SonarrEpisode {
  id: number;
  seriesId: number;
  seasonNumber: number;
  episodeNumber: number;
  title?: string;
  /** ISO 8601, absent for an episode with no announced date. */
  airDateUtc?: string;
  monitored: boolean;
  hasFile: boolean;
  episodeFileId?: number;
}

export class SonarrClient {
  constructor(private baseUrl: string, private apiKey: string) {}

  ping() {
    return arrFetch<{ version: string }>(this.baseUrl, this.apiKey, "/api/v3/system/status");
  }

  getSeries() {
    return arrFetch<SonarrSeries[]>(this.baseUrl, this.apiKey, "/api/v3/series");
  }

  /** One series by id — for a sync scoped to a single show. */
  getSeriesById(id: number) {
    return arrFetch<SonarrSeries>(this.baseUrl, this.apiKey, `/api/v3/series/${id}`);
  }

  getTags() {
    return arrFetch<ArrTag[]>(this.baseUrl, this.apiKey, "/api/v3/tag");
  }

  getEpisodes(seriesId: number) {
    return arrFetch<SonarrEpisode[]>(
      this.baseUrl,
      this.apiKey,
      `/api/v3/episode?seriesId=${seriesId}&includeEpisodeFile=false`
    );
  }

  /**
   * PUT a full series resource back — how season-level monitoring is changed,
   * since Sonarr exposes `seasons[].monitored` only on the series itself.
   *
   * **This cascades.** For every season whose `monitored` differs from what
   * Sonarr has stored, `SeriesService.UpdateSeries` calls
   * `SetEpisodeMonitoredBySeason`, rewriting *every* episode in that season to
   * match — including episodes the caller never mentioned. Turning a season off
   * therefore unmonitors the whole season, and turning one on re-monitors the
   * whole season, whatever the sweep decided per episode.
   *
   * So: read the series, change only the seasons you mean to change, and put
   * the per-episode state back afterwards. `reconcileSeasons` in lib/sweep.ts
   * is the one caller and does exactly that.
   */
  updateSeries(series: SonarrSeries) {
    return arrFetch<SonarrSeries>(this.baseUrl, this.apiKey, `/api/v3/series/${series.id}`, {
      method: "PUT",
      body: JSON.stringify(series),
    });
  }

  /** Bulk toggle episode monitoring. */
  setEpisodeMonitored(episodeIds: number[], monitored: boolean) {
    if (!episodeIds.length) return Promise.resolve(undefined);
    return arrFetch<void>(this.baseUrl, this.apiKey, "/api/v3/episode/monitor", {
      method: "PUT",
      body: JSON.stringify({ episodeIds, monitored }),
    });
  }

  /** Delete a single episode file. */
  deleteEpisodeFile(episodeFileId: number) {
    return arrFetch<void>(this.baseUrl, this.apiKey, `/api/v3/episodefile/${episodeFileId}`, {
      method: "DELETE",
    });
  }

  /**
   * Delete many episode files in one request.
   *
   * A library-wide purge would otherwise issue one DELETE per file — thousands
   * of round trips where Sonarr accepts a single batch.
   */
  deleteEpisodeFiles(episodeFileIds: number[]) {
    if (!episodeFileIds.length) return Promise.resolve(undefined);
    return arrFetch<void>(this.baseUrl, this.apiKey, "/api/v3/episodefile/bulk", {
      method: "DELETE",
      body: JSON.stringify({ episodeFileIds }),
    });
  }

  /**
   * The download queue, optionally confined to some series.
   *
   * One request for a normal-sized queue however large the library is, and a
   * targeted sweep narrows it further with `seriesIds`. `includeUnknownSeriesItems`
   * is left off: a row Sonarr cannot attribute to a series is a row the sweep
   * has no title to match it against.
   */
  getQueue(seriesIds?: number[]) {
    const params = new URLSearchParams();
    for (const id of seriesIds ?? []) params.append("seriesIds", String(id));
    return fetchQueue(this.baseUrl, this.apiKey, "/api/v3/queue", params);
  }

  /**
   * Remove queue records, and with them the downloads behind them.
   *
   * `removeFromClient` is what makes this more than a tidy-up of Sonarr's own
   * list: it tells the download client to drop the download and its data. See
   * `queueRemovalParams` for why the other two flags are pinned.
   */
  removeFromQueue(queueIds: number[], removeFromClient: boolean) {
    if (!queueIds.length) return Promise.resolve(undefined);
    const params = queueRemovalParams(removeFromClient);
    return arrFetch<void>(this.baseUrl, this.apiKey, `/api/v3/queue/bulk?${params}`, {
      method: "DELETE",
      body: JSON.stringify({ ids: queueIds }),
      timeoutMs: QUEUE_REMOVE_TIMEOUT_MS,
    });
  }

  /**
   * Kick off a search for the given episode ids.
   *
   * Batching ids into one command saves round trips to Sonarr but **not**
   * indexer queries: `EpisodeSearchCommand` loops over `episodeIds` and runs a
   * separate search for each, so the cost to the indexers is one query per id
   * however few commands they arrive in. `searchSeason` is the cheaper shape
   * where it is safe; `planEpisodeSearch` in lib/sweep.ts decides which.
   */
  searchEpisodes(episodeIds: number[]) {
    if (!episodeIds.length) return Promise.resolve(undefined);
    return arrFetch<void>(this.baseUrl, this.apiKey, "/api/v3/command", {
      method: "POST",
      body: JSON.stringify({ name: "EpisodeSearch", episodeIds }),
    });
  }

  /**
   * Kick off a search for a whole season — one indexer query for the season,
   * where the equivalent `searchEpisodes` call would be one per episode.
   *
   * Sonarr decides for itself what a season query may grab, and that is the
   * catch: a season pack it accepts is imported in full, including episodes
   * that are unmonitored. Only call this for a season whose every episode is
   * meant to come back. See `planEpisodeSearch` in lib/sweep.ts.
   */
  searchSeason(seriesId: number, seasonNumber: number) {
    return arrFetch<void>(this.baseUrl, this.apiKey, "/api/v3/command", {
      method: "POST",
      body: JSON.stringify({ name: "SeasonSearch", seriesId, seasonNumber }),
    });
  }
}

/* ------------------------------- Radarr -------------------------------- */

export interface RadarrMovie {
  id: number;
  title: string;
  tags?: number[];
  year?: number;
  monitored: boolean;
  hasFile: boolean;
  tmdbId?: number;
  imdbId?: string;
  movieFile?: { id: number };
  images?: { coverType: string; remoteUrl?: string; url?: string }[];
}

export class RadarrClient {
  constructor(private baseUrl: string, private apiKey: string) {}

  ping() {
    return arrFetch<{ version: string }>(this.baseUrl, this.apiKey, "/api/v3/system/status");
  }

  getMovies() {
    return arrFetch<RadarrMovie[]>(this.baseUrl, this.apiKey, "/api/v3/movie");
  }

  getTags() {
    return arrFetch<ArrTag[]>(this.baseUrl, this.apiKey, "/api/v3/tag");
  }

  getMovie(id: number) {
    return arrFetch<RadarrMovie>(this.baseUrl, this.apiKey, `/api/v3/movie/${id}`);
  }

  /**
   * Toggle monitoring for many movies in one request.
   *
   * Radarr's editor endpoint takes a list of ids and the fields to change. The
   * per-movie alternative is a GET (to read the resource) plus a full-resource
   * PUT each — two round trips per title, where this is one for the batch.
   */
  setMoviesMonitored(movieIds: number[], monitored: boolean) {
    if (!movieIds.length) return Promise.resolve(undefined);
    return arrFetch<void>(this.baseUrl, this.apiKey, "/api/v3/movie/editor", {
      method: "PUT",
      body: JSON.stringify({ movieIds, monitored }),
    });
  }

  /** Toggle monitoring by PUTting the full movie resource back. */
  async setMovieMonitored(id: number, monitored: boolean) {
    const movie = await this.getMovie(id);
    movie.monitored = monitored;
    return arrFetch<RadarrMovie>(this.baseUrl, this.apiKey, `/api/v3/movie/${id}`, {
      method: "PUT",
      body: JSON.stringify(movie),
    });
  }

  /**
   * Remove a movie from Radarr. Defaults are deliberately conservative: media
   * files are kept and no import exclusion is added, so the title can simply be
   * re-added if it was removed in error.
   */
  deleteMovie(
    id: number,
    opts: { deleteFiles?: boolean; addImportExclusion?: boolean } = {}
  ) {
    const params = new URLSearchParams({
      deleteFiles: String(!!opts.deleteFiles),
      addImportExclusion: String(!!opts.addImportExclusion),
    });
    return arrFetch<void>(this.baseUrl, this.apiKey, `/api/v3/movie/${id}?${params}`, {
      method: "DELETE",
    });
  }

  deleteMovieFile(movieFileId: number) {
    return arrFetch<void>(this.baseUrl, this.apiKey, `/api/v3/moviefile/${movieFileId}`, {
      method: "DELETE",
    });
  }

  /** Delete many movie files in one request. */
  deleteMovieFiles(movieFileIds: number[]) {
    if (!movieFileIds.length) return Promise.resolve(undefined);
    return arrFetch<void>(this.baseUrl, this.apiKey, "/api/v3/moviefile/bulk", {
      method: "DELETE",
      body: JSON.stringify({ movieFileIds }),
    });
  }

  /** The download queue, optionally confined to some movies. */
  getQueue(movieIds?: number[]) {
    const params = new URLSearchParams();
    for (const id of movieIds ?? []) params.append("movieIds", String(id));
    return fetchQueue(this.baseUrl, this.apiKey, "/api/v3/queue", params);
  }

  /** Remove queue records, and with them the downloads behind them. */
  removeFromQueue(queueIds: number[], removeFromClient: boolean) {
    if (!queueIds.length) return Promise.resolve(undefined);
    const params = queueRemovalParams(removeFromClient);
    return arrFetch<void>(this.baseUrl, this.apiKey, `/api/v3/queue/bulk?${params}`, {
      method: "DELETE",
      body: JSON.stringify({ ids: queueIds }),
      timeoutMs: QUEUE_REMOVE_TIMEOUT_MS,
    });
  }

  searchMovies(movieIds: number[]) {
    if (!movieIds.length) return Promise.resolve(undefined);
    return arrFetch<void>(this.baseUrl, this.apiKey, "/api/v3/command", {
      method: "POST",
      body: JSON.stringify({ name: "MoviesSearch", movieIds }),
    });
  }
}

export function posterFromImages(
  images?: { coverType: string; remoteUrl?: string; url?: string }[]
): string | null {
  if (!images) return null;
  const poster = images.find((i) => i.coverType === "poster");
  return poster?.remoteUrl || poster?.url || null;
}

/* -------------------------------- Seerr -------------------------------- */

export interface SeerrArrInstance {
  id: number;
  name: string;
  hostname: string;
  port: number;
  apiKey: string;
  useSsl?: boolean;
  baseUrl?: string;
}

/**
 * Discover Sonarr/Radarr instances configured inside Seerr.
 * Seerr exposes them at /api/v1/settings/{sonarr,radarr}.
 */
export class SeerrClient {
  constructor(private baseUrl: string, private apiKey: string) {}

  private base() {
    return normalizeBase(this.baseUrl);
  }

  private buildUrl(inst: SeerrArrInstance): string {
    const proto = inst.useSsl ? "https" : "http";
    const path = inst.baseUrl ? `/${inst.baseUrl.replace(/^\/+/, "")}` : "";
    return `${proto}://${inst.hostname}:${inst.port}${path}`;
  }

  async getSonarr(): Promise<{ name: string; baseUrl: string; apiKey: string }[]> {
    const data = await arrFetch<SeerrArrInstance[]>(
      this.base(),
      this.apiKey,
      "/api/v1/settings/sonarr"
    );
    return data.map((i) => ({ name: i.name, baseUrl: this.buildUrl(i), apiKey: i.apiKey }));
  }

  async getRadarr(): Promise<{ name: string; baseUrl: string; apiKey: string }[]> {
    const data = await arrFetch<SeerrArrInstance[]>(
      this.base(),
      this.apiKey,
      "/api/v1/settings/radarr"
    );
    return data.map((i) => ({ name: i.name, baseUrl: this.buildUrl(i), apiKey: i.apiKey }));
  }
}
