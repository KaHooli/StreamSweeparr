/**
 * Sync engine.
 *
 * Pulls the current state of every enabled Sonarr/Radarr connection, enriches
 * each title with Watchmode streaming availability for the user's selected
 * countries + services, and writes a fresh snapshot to PostgreSQL. The
 * dashboard reads exclusively from this snapshot.
 */

import type { Prisma } from "@prisma/client";
import { prisma, getSettings } from "./db";
import {
  SonarrClient,
  RadarrClient,
  posterFromImages,
  resolveSkipTagIds,
  hasSkipTag,
  SKIP_TAG_LABEL,
  type SonarrEpisode,
} from "./arr";
import { WatchmodeClient, matchSources, type WatchmodeTitleSource } from "./watchmode";
import { lookupWatchmodeId, refreshTitleMap } from "./titlemap";
import { sanitizeExternalUrl } from "./urls";
import { mapWithConcurrency, syncConcurrency } from "./concurrency";
import {
  TmdbClient,
  matchTmdbProviders,
  isTmdbNotFound,
  type MatchedTmdbProvider,
} from "./tmdb";

export interface SyncResult {
  connections: number;
  movies: number;
  series: number;
  onStreamingMovies: number;
  onStreamingSeries: number;
  // How many series actually hit the Watchmode episodes endpoint this sync,
  // and how many were skipped as unchanged/fresh (credit-saving visibility).
  tvProviderCalls: number;
  tvSkipped: number;
  /** Movies that hit TMDB this sync, and those served from the cached answer. */
  movieProviderCalls: number;
  movieSkipped: number;
  /** Series that hit the title-level sources endpoint for provider deep links. */
  tvLinkCalls: number;
  /** On-streaming series with ≥1 provider Watchmode gave no `web_url` for. */
  tvMissingLinks: number;
  /** Titles left alone because they carry the ss-skip tag. */
  taggedSkipped: number;
  /** Movies whose TMDB id no longer resolves (candidates for removal). */
  tmdbMissingMovies: number;
  errors: string[];
}

// Optional progress sink so a sync can stream status into a run log.
export type ProgressFn = (level: "info" | "action" | "warn", msg: string) => void;
const noopProgress: ProgressFn = () => {};

// A series whose Watchmode data is younger than this is not re-pulled unless
// the changes feed says it changed. Safety net for when the changes feed is
// unavailable or misses something.
const TTL_DAYS = 7;
const TTL_MS = TTL_DAYS * 24 * 60 * 60 * 1000;

// Movies have no changes feed to consult, so their freshness is purely
// time-based and the window is correspondingly shorter than the TV one.
const MOVIE_TTL_HOURS = 24;
export const MOVIE_TTL_MS = MOVIE_TTL_HOURS * 60 * 60 * 1000;

// Re-probe the Watchmode plan at most this often (in case the user upgrades
// from free to paid, or vice versa).
const PLAN_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;

/** Prisma's Json input type needs an index signature; our shapes are plain
 *  JSON-safe objects, so cast at the boundary rather than polluting the types. */
const asJson = (v: unknown) => v as Prisma.InputJsonValue;

export interface StreamingInfoEntry {
  sourceId: number;
  name: string;
  type: string;
  region: string;
  logo?: string | null;
  webUrl?: string | null;
}

function streamingInfoJson(
  matched: WatchmodeTitleSource[],
  logos?: Map<number, string | null>
): StreamingInfoEntry[] {
  return matched.map((s) => ({
    sourceId: s.source_id,
    name: s.name,
    type: s.type,
    region: s.region,
    logo: logos?.get(s.source_id) ?? null,
    // Watchmode returns a placeholder sentence here on free plans, so only keep
    // real absolute URLs.
    webUrl: sanitizeExternalUrl(s.web_url),
  }));
}

/**
 * Collapse the per-episode matches of a series into one provider list for the
 * show tile: one entry per streaming service, keeping the first deep link we
 * saw and filling in the service logo from the Watchmode sources catalogue.
 */
function aggregateSeriesProviders(
  perEpisode: Iterable<StreamingInfoEntry[]>,
  logos: Map<number, string | null>
): StreamingInfoEntry[] {
  const bySource = new Map<number, StreamingInfoEntry>();
  for (const entries of perEpisode) {
    for (const e of entries) {
      const existing = bySource.get(e.sourceId);
      if (!existing) {
        bySource.set(e.sourceId, {
          ...e,
          // Always take the logo from the catalogue so shows whose episode data
          // came from cache (before logos were stored) still render one.
          logo: logos.get(e.sourceId) ?? e.logo ?? null,
        });
      } else if (!existing.webUrl && e.webUrl) {
        existing.webUrl = e.webUrl;
      }
    }
  }
  return [...bySource.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Streaming service id -> browser deep link, from a set of title sources.
 *
 * Only `web_url` is considered: Watchmode also returns `ios_url`/`android_url`,
 * but those are app-scheme links that are useless in a browser.
 */
export function providerLinkMap(
  sources: Pick<WatchmodeTitleSource, "source_id" | "web_url">[]
): Map<number, string> {
  const links = new Map<number, string>();
  for (const s of sources) {
    if (links.has(s.source_id)) continue; // first region wins
    const url = sanitizeExternalUrl(s.web_url);
    if (url) links.set(s.source_id, url);
  }
  return links;
}

/** Deep links already persisted on a series' provider list (free to reuse). */
function storedProviderLinks(info: unknown): Map<number, string> {
  if (!Array.isArray(info)) return new Map();
  return providerLinkMap(
    (info as StreamingInfoEntry[])
      .filter((e) => e && typeof e.sourceId === "number")
      .map((e) => ({ source_id: e.sourceId, web_url: e.webUrl ?? undefined }))
  );
}

/**
 * Whether it is time to (re)ask Watchmode for a series' provider deep links.
 *
 * Intentionally independent of the episode-availability TTL — a show whose
 * episodes are still fresh would otherwise keep its unlinked logos for up to a
 * week — but still rate-limited to one request per TTL so a source
 * Watchmode has no link for can't be re-probed on every sync.
 */
export function providerLinksAreStale(
  lastCheckedAt: Date | null | undefined,
  now = Date.now(),
  ttlMs = TTL_MS
): boolean {
  if (!lastCheckedAt) return true; // never asked (incl. rows predating the column)
  return now - lastCheckedAt.getTime() >= ttlMs;
}

/** Fill in any missing deep links from `links`. Returns true if all are set. */
export function applyProviderLinks(
  entries: StreamingInfoEntry[],
  links: Map<number, string>
): boolean {
  let complete = true;
  for (const e of entries) {
    if (!e.webUrl) e.webUrl = links.get(e.sourceId) ?? null;
    if (!e.webUrl) complete = false;
  }
  return complete;
}

export async function runSync(progress: ProgressFn = noopProgress): Promise<SyncResult> {
  const settings = await getSettings();
  const errors: string[] = [];
  const result: SyncResult = {
    connections: 0,
    movies: 0,
    series: 0,
    onStreamingMovies: 0,
    onStreamingSeries: 0,
    tvProviderCalls: 0,
    tvSkipped: 0,
    movieProviderCalls: 0,
    movieSkipped: 0,
    tvLinkCalls: 0,
    tvMissingLinks: 0,
    taggedSkipped: 0,
    tmdbMissingMovies: 0,
    errors,
  };

  const connections = settings.connections.filter((c) => c.enabled);
  result.connections = connections.length;

  const hasRadarr = connections.some((c) => c.type === "RADARR");
  const hasSonarr = connections.some((c) => c.type === "SONARR");

  // TV episodes use Watchmode; movies use TMDB. Validate only what's needed
  // for the connection types actually configured.
  if (hasSonarr) {
    if (!settings.watchmodeApiKey) throw new Error("Watchmode API key is not configured (needed for TV).");
    if (!settings.countries.length) throw new Error("No Watchmode countries selected (needed for TV).");
    if (!settings.serviceIds.length) throw new Error("No Watchmode streaming services selected (needed for TV).");
  }
  if (hasRadarr) {
    if (!settings.tmdbApiKey) throw new Error("TMDB API key is not configured (needed for movies).");
    if (!settings.tmdbRegions.length) throw new Error("No TMDB regions selected (needed for movies).");
    if (!settings.tmdbProviderIds.length) throw new Error("No TMDB movie providers selected (needed for movies).");
  }

  // TV (Watchmode) setup — only when a Sonarr connection exists.
  let wm: WatchmodeClient | null = null;
  // Set of Watchmode ids whose episodes changed since the last sync. When
  // present, series NOT in this set (and still within the freshness TTL) skip
  // the per-series Watchmode call entirely — the main credit saving.
  let changedIds: Set<number> | null = null;
  // Detected Watchmode plan for this run (drives whether the Changes API is used).
  let watchmodePlan: "paid" | "free" | "unknown" | null = null;
  // Timestamp captured *before* work starts; becomes the next changes cursor.
  const syncStartedAt = new Date();

  if (hasSonarr && settings.watchmodeApiKey) {
    // Ensure the local Title ID map is fresh (self-throttles to a 12h window).
    // A failure here is non-fatal: findTitleId falls back to the search API.
    try {
      await refreshTitleMap();
    } catch (e) {
      errors.push(`Title ID map refresh failed (using search fallback): ${(e as Error).message}`);
    }
    wm = new WatchmodeClient(settings.watchmodeApiKey);

    // Detect the account plan (cached). Only paid plans can use the premium
    // Changes API; free plans use the 7-day TTL fallback. Re-probe if we've
    // never checked or the last check is stale (user may have upgraded).
    watchmodePlan = settings.watchmodePlan as "paid" | "free" | "unknown" | null;
    const planStale =
      !settings.watchmodePlanCheckedAt ||
      Date.now() - settings.watchmodePlanCheckedAt.getTime() > PLAN_RECHECK_MS;
    if (!watchmodePlan || watchmodePlan === "unknown" || planStale) {
      const detected = await wm.detectPlan();
      // Keep a previous definitive result if the probe was inconclusive.
      watchmodePlan = detected === "unknown" ? watchmodePlan ?? "unknown" : detected;
      await prisma.settings.update({
        where: { id: 1 },
        data: { watchmodePlan, watchmodePlanCheckedAt: new Date() },
      });
      progress("info", `Watchmode plan detected: ${watchmodePlan}.`);
    }

    if (watchmodePlan === "paid") {
      // Ask Watchmode which titles changed since our last sync. A few paginated
      // calls cover the whole feed regardless of library size.
      if (settings.watchmodeChangesCursor) {
        try {
          changedIds = await wm.episodesChangedSince(settings.watchmodeChangesCursor);
          progress("info", `Watchmode changes feed: ${changedIds.size} title(s) changed since last sync.`);
        } catch (e) {
          changedIds = null;
          progress(
            "info",
            `Watchmode changes feed error (${(e as Error).message}); using ${TTL_DAYS}-day refresh fallback this run.`
          );
        }
      } else {
        progress("info", "First Watchmode sync — pulling all series (building cache).");
      }
    } else {
      // Free/unknown plan: no premium Changes API. Rely on the TTL only.
      changedIds = null;
      progress(
        "info",
        `Watchmode plan is "${watchmodePlan}" — Changes API unavailable; using ${TTL_DAYS}-day refresh fallback.`
      );
    }
  }
  const regions = settings.countries;
  const serviceIds = settings.serviceIds;
  const countedTypes = settings.countedTypes;

  // Service id -> logo URL, used to show provider logos on the dashboard.
  // One cheap call per sync (in-process cached for 6h) and non-fatal on failure.
  const wmLogos = new Map<number, string | null>();
  if (wm) {
    try {
      for (const src of await wm.sources(regions)) {
        if (!wmLogos.has(src.id)) wmLogos.set(src.id, src.logo_100px ?? null);
      }
    } catch (e) {
      errors.push(`Could not load Watchmode service logos: ${(e as Error).message}`);
    }
  }

  // Movie (TMDB) setup — only when a Radarr connection exists.
  const tmdb = hasRadarr && settings.tmdbApiKey ? new TmdbClient(settings.tmdbApiKey) : null;
  const tmdbRegions = settings.tmdbRegions;
  const tmdbProviderIds = settings.tmdbProviderIds;
  const tmdbCountedTypes = settings.tmdbCountedTypes;

  for (const conn of connections) {
    try {
      progress("info", `Syncing ${conn.type === "RADARR" ? "movies" : "series"} from "${conn.name}"…`);
      if (conn.type === "RADARR") {
        if (!tmdb) throw new Error("TMDB is not configured.");
        await syncRadarr(conn, tmdb, tmdbRegions, tmdbProviderIds, tmdbCountedTypes, result, errors, progress);
      } else {
        if (!wm) throw new Error("Watchmode is not configured.");
        await syncSonarr(conn, wm, regions, serviceIds, countedTypes, result, errors, changedIds, wmLogos);
      }
    } catch (e) {
      errors.push(`[${conn.name}] ${(e as Error).message}`);
    }
  }

  // Advance the changes cursor only on a paid plan (the only case the cursor is
  // consumed). Using the pre-work timestamp guarantees we never miss a change
  // that landed while this sync was running.
  if (hasSonarr && wm && watchmodePlan === "paid") {
    await prisma.settings.update({
      where: { id: 1 },
      data: { watchmodeChangesCursor: syncStartedAt },
    });
  }

  progress(
    "info",
    `Watchmode calls this sync: ${result.tvProviderCalls} episode fetch(es) across ${result.series} series ` +
      `(${result.tvSkipped} skipped as unchanged/fresh), ` +
      `${result.tvLinkCalls} provider-link fetch(es). ` +
      `TMDB calls: ${result.movieProviderCalls} across ${result.movies} movies ` +
      `(${result.movieSkipped} served from cache, ${MOVIE_TTL_HOURS}h freshness window). ` +
      `${result.taggedSkipped} title(s) ignored via the "${SKIP_TAG_LABEL}" tag.`
  );
  if (result.tvMissingLinks) {
    progress(
      "warn",
      `${result.tvMissingLinks} series have a streaming service Watchmode gives no web_url for — ` +
        `those provider logos fall back to a search on the service itself.`
    );
  }

  return result;
}

async function syncRadarr(
  conn: { id: number; name: string; baseUrl: string; apiKey: string },
  tmdb: TmdbClient,
  regions: string[],
  providerIds: number[],
  countedTypes: string[],
  result: SyncResult,
  errors: string[],
  progress: ProgressFn
) {
  const client = new RadarrClient(conn.baseUrl, conn.apiKey);
  const movies = await client.getMovies();
  // Which tag ids mean "leave this title alone"? Tag lookup is a local *arr
  // call, so it costs nothing against the streaming APIs.
  let skipIds = new Set<number>();
  try {
    skipIds = resolveSkipTagIds(await client.getTags());
  } catch (e) {
    errors.push(`[${conn.name}] Could not read tags: ${(e as Error).message}`);
  }

  // One read of the existing snapshot instead of a lookup per title. Used for
  // the freshness check and to carry cached availability forward on a skip.
  const existingRows = await prisma.mediaItem.findMany({
    where: { connectionId: conn.id, type: "MOVIE" },
    select: {
      arrId: true,
      providerSyncedAt: true,
      streamingUnknown: true,
      onStreaming: true,
      streamingInfo: true,
      tmdbMissing: true,
      skipped: true,
    },
  });
  const existingByArrId = new Map(existingRows.map((r) => [r.arrId, r]));

  // Every row touched by this pass gets exactly this timestamp, so anything
  // still older afterwards is a title that has left Radarr. Comparing against a
  // single app-side instant avoids both the "send every id we saw" query and
  // any dependence on the database clock agreeing with ours.
  const syncedAt = new Date();
  const now = syncedAt.getTime();

  await mapWithConcurrency(movies, syncConcurrency(), async (movie) => {
    const base = {
      title: movie.title,
      year: movie.year ?? null,
      posterUrl: posterFromImages(movie.images),
      tmdbId: movie.tmdbId ?? null,
      imdbId: movie.imdbId ?? null,
      monitored: movie.monitored,
      hasFile: movie.hasFile,
      movieFileId: movie.movieFile?.id ?? null,
      lastSyncedAt: syncedAt,
    };
    const key = {
      connectionId_type_arrId: { connectionId: conn.id, type: "MOVIE" as const, arrId: movie.id },
    };

    if (hasSkipTag(movie.tags, skipIds)) {
      // Don't spend an API call and don't record availability: the sweep must
      // never act on this title. We still refresh the basic metadata so it
      // shows up correctly elsewhere.
      result.taggedSkipped++;
      result.movies++;
      const skippedState = {
        skipped: true,
        onStreaming: false,
        streamingUnknown: true,
        streamingInfo: [],
      };
      await prisma.mediaItem.upsert({
        where: key,
        create: { connectionId: conn.id, type: "MOVIE", arrId: movie.id, ...base, ...skippedState },
        update: { ...base, ...skippedState },
      });
      return;
    }

    const existing = existingByArrId.get(movie.id);

    // Movies have no equivalent of Watchmode's changes feed, so freshness is
    // purely time-based: a title looked up recently, successfully, and not
    // flagged as missing keeps its answer. Availability moves on a monthly
    // cadence, so a day-old answer is still a good one — and on a 12-hourly
    // schedule this halves the TMDB traffic.
    const fresh =
      !!existing &&
      !existing.skipped &&
      !existing.streamingUnknown &&
      !existing.tmdbMissing &&
      !!existing.providerSyncedAt &&
      now - existing.providerSyncedAt.getTime() < MOVIE_TTL_MS;

    if (fresh) {
      result.movieSkipped++;
      result.movies++;
      if (existing!.onStreaming) result.onStreamingMovies++;
      // Metadata still refreshes (title, monitored, file state); the cached
      // availability columns are simply left untouched.
      await prisma.mediaItem.update({ where: key, data: { ...base, skipped: false } });
      return;
    }

    let matched: MatchedTmdbProvider[] = [];
    // Track whether we could actually determine streaming availability. A
    // failed lookup must not be treated as "not on streaming".
    let streamingUnknown = false;
    // TMDB says this id no longer exists (deleted/merged entry). Recorded here;
    // the sweep decides whether to remove it from Radarr. Sync stays read-only.
    let tmdbMissing = false;
    try {
      if (movie.tmdbId) {
        const availability = await tmdb.movieWatchProviders(movie.tmdbId);
        result.movieProviderCalls++;
        matched = matchTmdbProviders(availability, regions, providerIds, countedTypes);
      } else {
        // No TMDB id from Radarr -> we can't look it up. Mark unknown so the
        // sweep leaves it alone rather than re-monitoring.
        streamingUnknown = true;
      }
    } catch (e) {
      streamingUnknown = true;
      if (isTmdbNotFound(e)) {
        tmdbMissing = true;
        result.tmdbMissingMovies++;
        progress(
          "warn",
          `[${conn.name}] "${movie.title}" no longer exists on TMDB (id ${movie.tmdbId}).`
        );
      } else {
        errors.push(`[${conn.name}] ${movie.title}: ${(e as Error).message}`);
      }
    }

    const onStreaming = matched.length > 0;
    if (onStreaming) result.onStreamingMovies++;
    result.movies++;

    const availabilityState = {
      skipped: false,
      tmdbMissing,
      onStreaming,
      streamingUnknown,
      streamingInfo: matched.map((m) => ({
        sourceId: m.providerId,
        name: m.name,
        type: m.type,
        region: m.region,
        logo: m.logo,
        webUrl: null,
      })),
      // Only start the freshness clock on a lookup that actually answered.
      providerSyncedAt: streamingUnknown ? null : syncedAt,
    };

    await prisma.mediaItem.upsert({
      where: key,
      create: {
        connectionId: conn.id,
        type: "MOVIE",
        arrId: movie.id,
        ...base,
        ...availabilityState,
      },
      update: { ...base, ...availabilityState },
    });
  });

  // Anything this pass did not touch is no longer in Radarr.
  await prisma.mediaItem.deleteMany({
    where: { connectionId: conn.id, type: "MOVIE", lastSyncedAt: { lt: syncedAt } },
  });
}

async function syncSonarr(
  conn: { id: number; name: string; baseUrl: string; apiKey: string },
  wm: WatchmodeClient,
  regions: string[],
  serviceIds: number[],
  countedTypes: string[],
  result: SyncResult,
  errors: string[],
  // Watchmode ids known to have changed since last sync (null = feed
  // unavailable → rely on the TTL alone).
  changedIds: Set<number> | null,
  // Streaming service id -> logo URL, for the dashboard tiles.
  logos: Map<number, string | null>
) {
  const client = new SonarrClient(conn.baseUrl, conn.apiKey);
  const seriesList = await client.getSeries();
  let skipIds = new Set<number>();
  try {
    skipIds = resolveSkipTagIds(await client.getTags());
  } catch (e) {
    errors.push(`[${conn.name}] Could not read tags: ${(e as Error).message}`);
  }

  // One read of the existing snapshot for the whole connection, without the
  // episode rows: those are only needed for series we end up skipping, and
  // eagerly joining them loads the entire episode table on every sync.
  const existingRows = await prisma.mediaItem.findMany({
    where: { connectionId: conn.id, type: "TV" },
    select: {
      id: true,
      arrId: true,
      watchmodeId: true,
      providerSyncedAt: true,
      providerLinksSyncedAt: true,
      streamingUnknown: true,
      streamingInfo: true,
    },
  });
  const existingByArrId = new Map(existingRows.map((r) => [r.arrId, r]));

  // See syncRadarr: one timestamp for the pass, used to prune untouched rows.
  const syncedAt = new Date();
  const now = syncedAt.getTime();

  await mapWithConcurrency(seriesList, syncConcurrency(), async (series) => {
    if (hasSkipTag(series.tags, skipIds)) {
      // Leave the show entirely alone: no Watchmode call, no availability
      // recorded, and its episode rows are dropped so the sweep can't act on
      // stale data.
      result.taggedSkipped++;
      result.series++;
      const existingSkipped = await prisma.mediaItem.upsert({
        where: { connectionId_type_arrId: { connectionId: conn.id, type: "TV", arrId: series.id } },
        create: {
          connectionId: conn.id,
          type: "TV",
          arrId: series.id,
          title: series.title,
          year: series.year ?? null,
          posterUrl: posterFromImages(series.images),
          tmdbId: series.tmdbId ?? null,
          imdbId: series.imdbId ?? null,
          tvdbId: series.tvdbId ?? null,
          monitored: series.monitored,
          skipped: true,
          onStreaming: false,
          streamingUnknown: true,
          streamingInfo: [],
          lastSyncedAt: syncedAt,
        },
        update: {
          title: series.title,
          year: series.year ?? null,
          posterUrl: posterFromImages(series.images),
          tmdbId: series.tmdbId ?? null,
          imdbId: series.imdbId ?? null,
          tvdbId: series.tvdbId ?? null,
          monitored: series.monitored,
          skipped: true,
          onStreaming: false,
          streamingUnknown: true,
          streamingInfo: [],
          totalEpisodes: 0,
          monitoredEpisodes: 0,
          streamingEpisodes: 0,
          lastSyncedAt: syncedAt,
        },
      });
      await prisma.episode.deleteMany({ where: { mediaId: existingSkipped.id } });
      return;
    }

    // Existing cached snapshot (for freshness + reusing streaming data).
    const existing = existingByArrId.get(series.id) ?? null;

    let watchmodeId: number | null = existing?.watchmodeId ?? null;
    // Resolve the Watchmode id from the local map (free) if not already known.
    if (!watchmodeId) {
      try {
        watchmodeId = await wm.findTitleId({
          tmdbId: series.tmdbId,
          imdbId: series.imdbId,
          type: "tv",
          name: series.title,
          year: series.year,
          resolveLocal: lookupWatchmodeId,
        });
      } catch (e) {
        errors.push(`[${conn.name}] ${series.title}: ${(e as Error).message}`);
      }
    }

    // Decide whether we can skip the (metered) Watchmode episodes call.
    const fresh =
      !!existing?.providerSyncedAt &&
      now - existing.providerSyncedAt.getTime() < TTL_MS;
    const changed =
      changedIds !== null && watchmodeId !== null && changedIds.has(watchmodeId);
    // Skip only when: we have a prior successful pull, it's still fresh, and the
    // changes feed did NOT flag it (or the feed is unavailable but data is fresh).
    const canSkipWatchmode =
      !!existing && !existing.streamingUnknown && fresh && !changed && watchmodeId !== null;

    // Build a season×episode -> matched-sources map, either from a fresh
    // Watchmode pull or from the cached episode rows.
    const wmMap = new Map<string, ReturnType<typeof streamingInfoJson>>();
    let streamingUnknown = false;

    if (canSkipWatchmode) {
      // Reuse cached streaming info — NO Watchmode call. The episode rows are
      // fetched only on this branch, which is the only one that reads them.
      result.tvSkipped++;
      const cachedEpisodes = await prisma.episode.findMany({
        where: { mediaId: existing!.id },
        select: { seasonNumber: true, episodeNumber: true, streamingInfo: true },
      });
      for (const ep of cachedEpisodes) {
        const info = (ep.streamingInfo as ReturnType<typeof streamingInfoJson> | null) ?? [];
        if (Array.isArray(info) && info.length) {
          wmMap.set(`${ep.seasonNumber}x${ep.episodeNumber}`, info);
        }
      }
    } else if (watchmodeId !== null) {
      // Pull fresh episode availability from Watchmode.
      try {
        const wmEpisodes = await wm.titleEpisodes(watchmodeId, regions);
        result.tvProviderCalls++;
        for (const ep of wmEpisodes) {
          const matched = matchSources(ep.sources, serviceIds, countedTypes);
          if (matched.length) {
            wmMap.set(`${ep.season_number}x${ep.episode_number}`, streamingInfoJson(matched, logos));
          }
        }
      } catch (e) {
        streamingUnknown = true;
        errors.push(`[${conn.name}] ${series.title}: ${(e as Error).message}`);
      }
    } else {
      // No Watchmode id at all → availability genuinely unknown.
      streamingUnknown = true;
    }

    let arrEpisodes: SonarrEpisode[] = [];
    try {
      arrEpisodes = await client.getEpisodes(series.id);
    } catch (e) {
      errors.push(`[${conn.name}] ${series.title} episodes: ${(e as Error).message}`);
    }
    // Ignore specials (season 0) for streaming roll-ups.
    const realEpisodes = arrEpisodes.filter((e) => e.seasonNumber > 0);

    let streamingEpisodes = 0;
    let monitoredEpisodes = 0;

    // Whether this series' streaming data is considered current.
    const pulledFresh = !canSkipWatchmode && watchmodeId !== null && !streamingUnknown;

    const mediaItem = await prisma.mediaItem.upsert({
      where: { connectionId_type_arrId: { connectionId: conn.id, type: "TV", arrId: series.id } },
      create: {
        connectionId: conn.id,
        type: "TV",
        arrId: series.id,
        title: series.title,
        year: series.year ?? null,
        posterUrl: posterFromImages(series.images),
        tmdbId: series.tmdbId ?? null,
        imdbId: series.imdbId ?? null,
        tvdbId: series.tvdbId ?? null,
        watchmodeId,
        monitored: series.monitored,
        skipped: false,
        lastSyncedAt: syncedAt,
        providerSyncedAt: pulledFresh ? syncedAt : null,
      },
      update: {
        title: series.title,
        year: series.year ?? null,
        posterUrl: posterFromImages(series.images),
        tmdbId: series.tmdbId ?? null,
        imdbId: series.imdbId ?? null,
        tvdbId: series.tvdbId ?? null,
        watchmodeId,
        monitored: series.monitored,
        skipped: false,
        lastSyncedAt: syncedAt,
        // Advance the provider timestamp only when we pulled fresh; leave it
        // untouched when skipping so the TTL keeps counting from the real pull.
        ...(pulledFresh ? { providerSyncedAt: syncedAt } : {}),
      },
    });

    // Replace the episode snapshot atomically so a failure mid-loop can't
    // leave a series with a partial set of episodes.
    const episodeRows = realEpisodes.map((ep) => {
      const matched = wmMap.get(`${ep.seasonNumber}x${ep.episodeNumber}`) ?? [];
      const onStreaming = matched.length > 0;
      if (onStreaming) streamingEpisodes++;
      if (ep.monitored) monitoredEpisodes++;
      return {
        mediaId: mediaItem.id,
        arrEpisodeId: ep.id,
        seasonNumber: ep.seasonNumber,
        episodeNumber: ep.episodeNumber,
        title: ep.title ?? null,
        monitored: ep.monitored,
        hasFile: ep.hasFile,
        episodeFileId: ep.episodeFileId ?? null,
        onStreaming,
        streamingUnknown,
        streamingInfo: asJson(matched),
      };
    });

    await prisma.$transaction([
      prisma.episode.deleteMany({ where: { mediaId: mediaItem.id } }),
      prisma.episode.createMany({ data: episodeRows }),
    ]);

    const onStreaming = streamingEpisodes > 0;
    if (onStreaming) result.onStreamingSeries++;
    result.series++;

    // Series-level provider list (deduped across episodes) so the dashboard
    // tile can show one logo per streaming service.
    const seriesProviders = aggregateSeriesProviders(wmMap.values(), logos);

    // The dashboard links each logo to the show on that service, using
    // Watchmode's `web_url`. Per-episode `web_url`s are a paid-plan feature
    // (free plans return a placeholder that we discard), so fill any gaps from
    // the *title*-level sources endpoint, whose `web_url` is a real link on
    // every plan tier. Links we already persisted are reused for free.
    let linksComplete = applyProviderLinks(
      seriesProviders,
      storedProviderLinks(existing?.streamingInfo)
    );
    let providerLinksSyncedAt = existing?.providerLinksSyncedAt ?? null;
    if (
      onStreaming &&
      !linksComplete &&
      watchmodeId !== null &&
      providerLinksAreStale(providerLinksSyncedAt, now)
    ) {
      try {
        const titleSources = await wm.titleSources(watchmodeId, regions);
        result.tvLinkCalls++;
        providerLinksSyncedAt = syncedAt;
        linksComplete = applyProviderLinks(seriesProviders, providerLinkMap(titleSources));
      } catch (e) {
        // Non-fatal: the affected logos just render without a link.
        errors.push(`[${conn.name}] ${series.title} provider links: ${(e as Error).message}`);
      }
    }
    // Surface the one case the user can otherwise only diagnose by clicking a
    // logo: Watchmode gave us no deep link, so the logo isn't clickable.
    if (onStreaming && !linksComplete) result.tvMissingLinks++;

    await prisma.mediaItem.update({
      where: { id: mediaItem.id },
      data: {
        totalEpisodes: realEpisodes.length,
        monitoredEpisodes,
        streamingEpisodes,
        onStreaming,
        streamingUnknown,
        streamingInfo: asJson(seriesProviders),
        providerLinksSyncedAt,
      },
    });
  });

  // Anything this pass did not touch is no longer in Sonarr.
  await prisma.mediaItem.deleteMany({
    where: { connectionId: conn.id, type: "TV", lastSyncedAt: { lt: syncedAt } },
  });
}
