/**
 * Sync engine.
 *
 * Pulls the current state of every enabled Sonarr/Radarr connection, enriches
 * each title with Watchmode streaming availability for the user's selected
 * countries + services, and writes a fresh snapshot to PostgreSQL. The
 * dashboard reads exclusively from this snapshot.
 */

import { prisma, getSettings } from "./db";
import {
  SonarrClient,
  RadarrClient,
  posterFromImages,
  type SonarrEpisode,
} from "./arr";
import { WatchmodeClient, matchSources, type WatchmodeTitleSource } from "./watchmode";
import type { WatchmodeEpisode } from "./watchmode";
import { lookupWatchmodeId, refreshTitleMap } from "./titlemap";

export interface SyncResult {
  connections: number;
  movies: number;
  series: number;
  onStreamingMovies: number;
  onStreamingSeries: number;
  errors: string[];
}

// Optional progress sink so a sync can stream status into a run log.
export type ProgressFn = (level: "info" | "action" | "warn", msg: string) => void;
const noopProgress: ProgressFn = () => {};

function streamingInfoJson(matched: WatchmodeTitleSource[]) {
  return matched.map((s) => ({
    sourceId: s.source_id,
    name: s.name,
    type: s.type,
    region: s.region,
    webUrl: s.web_url ?? null,
  }));
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
    errors,
  };

  if (!settings.watchmodeApiKey) throw new Error("Watchmode API key is not configured.");
  if (!settings.countries.length) throw new Error("No countries selected in settings.");
  if (!settings.serviceIds.length) throw new Error("No streaming services selected in settings.");

  // Ensure the local Title ID map is fresh (self-throttles to a 12h window).
  // A failure here is non-fatal: findTitleId falls back to the search API.
  try {
    await refreshTitleMap();
  } catch (e) {
    errors.push(`Title ID map refresh failed (using search fallback): ${(e as Error).message}`);
  }

  const wm = new WatchmodeClient(settings.watchmodeApiKey);
  const regions = settings.countries;
  const serviceIds = settings.serviceIds;
  const countedTypes = settings.countedTypes;

  const connections = settings.connections.filter((c) => c.enabled);
  result.connections = connections.length;

  for (const conn of connections) {
    try {
      progress("info", `Syncing ${conn.type === "RADARR" ? "movies" : "series"} from "${conn.name}"…`);
      if (conn.type === "RADARR") {
        await syncRadarr(conn, wm, regions, serviceIds, countedTypes, result, errors);
      } else {
        await syncSonarr(conn, wm, regions, serviceIds, countedTypes, result, errors);
      }
    } catch (e) {
      errors.push(`[${conn.name}] ${(e as Error).message}`);
    }
  }

  return result;
}

async function syncRadarr(
  conn: { id: number; name: string; baseUrl: string; apiKey: string },
  wm: WatchmodeClient,
  regions: string[],
  serviceIds: number[],
  countedTypes: string[],
  result: SyncResult,
  errors: string[]
) {
  const client = new RadarrClient(conn.baseUrl, conn.apiKey);
  const movies = await client.getMovies();
  // Track which arrIds we saw so we can prune stale rows afterwards.
  const seen: number[] = [];

  for (const movie of movies) {
    let matched: WatchmodeTitleSource[] = [];
    let watchmodeId: number | null = null;
    // Track whether we could actually determine streaming availability. A
    // failed lookup must not be treated as "not on streaming".
    let streamingUnknown = false;
    try {
      watchmodeId = await wm.findTitleId({
        tmdbId: movie.tmdbId,
        imdbId: movie.imdbId,
        type: "movie",
        name: movie.title,
        year: movie.year,
        resolveLocal: lookupWatchmodeId,
      });
      if (watchmodeId) {
        const sources = await wm.titleSources(watchmodeId, regions);
        matched = matchSources(sources, serviceIds, countedTypes);
      } else {
        // No Watchmode id at all -> we genuinely can't say. Mark unknown so the
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
        watchmodeId,
        monitored: movie.monitored,
        hasFile: movie.hasFile,
        onStreaming,
        streamingUnknown,
        streamingInfo: streamingInfoJson(matched),
      },
      update: {
        title: movie.title,
        year: movie.year ?? null,
        posterUrl: posterFromImages(movie.images),
        tmdbId: movie.tmdbId ?? null,
        imdbId: movie.imdbId ?? null,
        watchmodeId,
        monitored: movie.monitored,
        hasFile: movie.hasFile,
        onStreaming,
        streamingUnknown,
        streamingInfo: streamingInfoJson(matched),
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
  errors: string[]
) {
  const client = new SonarrClient(conn.baseUrl, conn.apiKey);
  const seriesList = await client.getSeries();
  const seen: number[] = [];

  for (const series of seriesList) {
    let watchmodeId: number | null = null;
    let wmEpisodes: WatchmodeEpisode[] = [];
    // If we couldn't resolve the show or fetch its episodes, per-episode
    // streaming status is unknown (do not re-monitor on this basis).
    let streamingUnknown = false;
    try {
      watchmodeId = await wm.findTitleId({
        tmdbId: series.tmdbId,
        imdbId: series.imdbId,
        type: "tv",
        name: series.title,
        year: series.year,
        resolveLocal: lookupWatchmodeId,
      });
      if (watchmodeId) {
        wmEpisodes = await wm.titleEpisodes(watchmodeId, regions);
      } else {
        streamingUnknown = true;
      }
    } catch (e) {
      streamingUnknown = true;
      errors.push(`[${conn.name}] ${series.title}: ${(e as Error).message}`);
    }

    // Index Watchmode episodes by season/episode for quick matching.
    const wmMap = new Map<string, WatchmodeTitleSource[]>();
    for (const ep of wmEpisodes) {
      const matched = matchSources(ep.sources, serviceIds, countedTypes);
      if (matched.length) wmMap.set(`${ep.season_number}x${ep.episode_number}`, matched);
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
        lastSyncedAt: new Date(),
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
        streamingInfo: streamingInfoJson(matched),
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
      },
    });
    seen.push(series.id);
  }

  await prisma.mediaItem.deleteMany({
    where: { connectionId: conn.id, type: "TV", arrId: { notIn: seen.length ? seen : [-1] } },
  });
}
