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
import { TmdbClient, matchTmdbProviders, type MatchedTmdbProvider } from "./tmdb";

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
  /** Titles left alone because they carry the ss-skip tag. */
  taggedSkipped: number;
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

// Re-probe the Watchmode plan at most this often (in case the user upgrades
// from free to paid, or vice versa).
const PLAN_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;

/** Prisma's Json input type needs an index signature; our shapes are plain
 *  JSON-safe objects, so cast at the boundary rather than polluting the types. */
const asJson = (v: unknown) => v as Prisma.InputJsonValue;

interface StreamingInfoEntry {
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
    webUrl: s.web_url ?? null,
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
    taggedSkipped: 0,
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
        await syncRadarr(conn, tmdb, tmdbRegions, tmdbProviderIds, tmdbCountedTypes, result, errors);
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
      `(${result.tvSkipped} skipped as unchanged/fresh). ` +
      `${result.taggedSkipped} title(s) ignored via the "${SKIP_TAG_LABEL}" tag.`
  );

  return result;
}

async function syncRadarr(
  conn: { id: number; name: string; baseUrl: string; apiKey: string },
  tmdb: TmdbClient,
  regions: string[],
  providerIds: number[],
  countedTypes: string[],
  result: SyncResult,
  errors: string[]
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
  // Track which arrIds we saw so we can prune stale rows afterwards.
  const seen: number[] = [];

  for (const movie of movies) {
    const skipped = hasSkipTag(movie.tags, skipIds);

    if (skipped) {
      // Don't spend an API call and don't record availability: the sweep must
      // never act on this title. We still refresh the basic metadata so it
      // shows up correctly elsewhere.
      result.taggedSkipped++;
      result.movies++;
      await prisma.mediaItem.upsert({
        where: { connectionId_type_arrId: { connectionId: conn.id, type: "MOVIE", arrId: movie.id } },
        create: {
          connectionId: conn.id,
          type: "MOVIE",
          arrId: movie.id,
          title: movie.title,
          year: movie.year ?? null,
          posterUrl: posterFromImages(movie.images),
          tmdbId: movie.tmdbId ?? null,
          imdbId: movie.imdbId ?? null,
          monitored: movie.monitored,
          hasFile: movie.hasFile,
          skipped: true,
          onStreaming: false,
          streamingUnknown: true,
          streamingInfo: [],
        },
        update: {
          title: movie.title,
          year: movie.year ?? null,
          posterUrl: posterFromImages(movie.images),
          tmdbId: movie.tmdbId ?? null,
          imdbId: movie.imdbId ?? null,
          monitored: movie.monitored,
          hasFile: movie.hasFile,
          skipped: true,
          onStreaming: false,
          streamingUnknown: true,
          streamingInfo: [],
          lastSyncedAt: new Date(),
        },
      });
      seen.push(movie.id);
      continue;
    }

    let matched: MatchedTmdbProvider[] = [];
    // Track whether we could actually determine streaming availability. A
    // failed lookup must not be treated as "not on streaming".
    let streamingUnknown = false;
    try {
      if (movie.tmdbId) {
        const availability = await tmdb.movieWatchProviders(movie.tmdbId);
        matched = matchTmdbProviders(availability, regions, providerIds, countedTypes);
      } else {
        // No TMDB id from Radarr -> we can't look it up. Mark unknown so the
        // sweep leaves it alone rather than re-monitoring.
        streamingUnknown = true;
      }
    } catch (e) {
      streamingUnknown = true;
      errors.push(`[${conn.name}] ${movie.title}: ${(e as Error).message}`);
    }

    const onStreaming = matched.length > 0;
    if (onStreaming) result.onStreamingMovies++;
    result.movies++;

    const info = matched.map((m) => ({
      sourceId: m.providerId,
      name: m.name,
      type: m.type,
      region: m.region,
      logo: m.logo,
      webUrl: null,
    }));

    await prisma.mediaItem.upsert({
      where: { connectionId_type_arrId: { connectionId: conn.id, type: "MOVIE", arrId: movie.id } },
      create: {
        connectionId: conn.id,
        type: "MOVIE",
        arrId: movie.id,
        title: movie.title,
        year: movie.year ?? null,
        posterUrl: posterFromImages(movie.images),
        tmdbId: movie.tmdbId ?? null,
        imdbId: movie.imdbId ?? null,
        monitored: movie.monitored,
        hasFile: movie.hasFile,
        skipped: false,
        onStreaming,
        streamingUnknown,
        streamingInfo: info,
      },
      update: {
        title: movie.title,
        year: movie.year ?? null,
        posterUrl: posterFromImages(movie.images),
        tmdbId: movie.tmdbId ?? null,
        imdbId: movie.imdbId ?? null,
        monitored: movie.monitored,
        hasFile: movie.hasFile,
        skipped: false,
        onStreaming,
        streamingUnknown,
        streamingInfo: info,
        lastSyncedAt: new Date(),
      },
    });
    seen.push(movie.id);
  }

  await prisma.mediaItem.deleteMany({
    where: { connectionId: conn.id, type: "MOVIE", arrId: { notIn: seen.length ? seen : [-1] } },
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
  const seen: number[] = [];
  const now = Date.now();

  for (const series of seriesList) {
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
          lastSyncedAt: new Date(),
        },
      });
      await prisma.episode.deleteMany({ where: { mediaId: existingSkipped.id } });
      seen.push(series.id);
      continue;
    }

    // Existing cached snapshot (for freshness + reusing streaming data).
    const existing = await prisma.mediaItem.findUnique({
      where: { connectionId_type_arrId: { connectionId: conn.id, type: "TV", arrId: series.id } },
      include: { episodes: true },
    });

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
      // Reuse cached streaming info — NO Watchmode call.
      result.tvSkipped++;
      for (const ep of existing!.episodes) {
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
        providerSyncedAt: pulledFresh ? new Date() : null,
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
        lastSyncedAt: new Date(),
        // Advance the provider timestamp only when we pulled fresh; leave it
        // untouched when skipping so the TTL keeps counting from the real pull.
        ...(pulledFresh ? { providerSyncedAt: new Date() } : {}),
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

    await prisma.mediaItem.update({
      where: { id: mediaItem.id },
      data: {
        totalEpisodes: realEpisodes.length,
        monitoredEpisodes,
        streamingEpisodes,
        onStreaming,
        streamingUnknown,
        // Series-level provider list (deduped across episodes) so the dashboard
        // tile can show one logo per streaming service.
        streamingInfo: asJson(aggregateSeriesProviders(wmMap.values(), logos)),
      },
    });
    seen.push(series.id);
  }

  await prisma.mediaItem.deleteMany({
    where: { connectionId: conn.id, type: "TV", arrId: { notIn: seen.length ? seen : [-1] } },
  });
}
