/**
 * Sweep engine — the core StreamSweeparr workflow.
 *
 * For every enabled connection:
 *   1. UNMONITOR + DELETE: monitored items (movies / episodes) that are now
 *      available on a selected streaming service are set to unmonitored and,
 *      if enabled, their files are deleted.
 *   2. RE-MONITOR: unmonitored items that are NO LONGER on any selected
 *      streaming service are set back to monitored.
 *   3. SEARCH: at the end, trigger a search for every monitored movie/episode.
 *
 * A run always syncs first so decisions are based on fresh data. When
 * `applyChanges` is false the run is a dry-run: it records what *would* happen
 * without mutating Sonarr/Radarr.
 */

import { prisma, getSettings } from "./db";
import { SonarrClient, RadarrClient } from "./arr";
import { runSync } from "./sync";

type LogLine = { level: "info" | "action" | "warn"; msg: string };

export async function runSweep(): Promise<number> {
  const settings = await getSettings();
  const dryRun = !settings.applyChanges;

  const run = await prisma.runLog.create({
    data: { dryRun, status: "RUNNING", log: [] },
  });

  const log: LogLine[] = [];
  const push = (level: LogLine["level"], msg: string) => log.push({ level, msg });

  const counts = {
    unmonitoredMovies: 0,
    remonitoredMovies: 0,
    unmonitoredEps: 0,
    remonitoredEps: 0,
    deletedFiles: 0,
    searchedItems: 0,
  };

  try {
    push("info", `Starting ${dryRun ? "DRY-RUN" : "LIVE"} sweep.`);

    // 1. Refresh snapshot first.
    push("info", "Syncing latest state from Sonarr/Radarr + Watchmode…");
    const sync = await runSync();
    push(
      "info",
      `Synced ${sync.movies} movies (${sync.onStreamingMovies} on streaming), ${sync.series} series (${sync.onStreamingSeries} on streaming).`
    );
    for (const e of sync.errors) push("warn", e);

    const connections = settings.connections.filter((c) => c.enabled);

    for (const conn of connections) {
      if (conn.type === "RADARR") {
        await sweepRadarr(conn, settings, dryRun, counts, push);
      } else {
        await sweepSonarr(conn, settings, dryRun, counts, push);
      }
    }

    // 3. Search all monitored items.
    if (settings.searchAtEnd) {
      push("info", "Triggering search for all monitored items…");
      for (const conn of connections) {
        if (conn.type === "RADARR") {
          await searchRadarr(conn, dryRun, counts, push);
        } else {
          await searchSonarr(conn, dryRun, counts, push);
        }
      }
    }

    push("info", "Sweep complete.");

    // Re-sync so the dashboard reflects the changes we just made (skip on dry-run).
    if (!dryRun) {
      await runSync().catch((e) => push("warn", `Post-run resync failed: ${(e as Error).message}`));
    }

    await prisma.runLog.update({
      where: { id: run.id },
      data: {
        status: "SUCCESS",
        finishedAt: new Date(),
        log: log as unknown as object,
        ...counts,
      },
    });
  } catch (e) {
    push("warn", `Run failed: ${(e as Error).message}`);
    await prisma.runLog.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        error: (e as Error).message,
        log: log as unknown as object,
        ...counts,
      },
    });
  }

  return run.id;
}

async function sweepRadarr(
  conn: { id: number; name: string; baseUrl: string; apiKey: string },
  settings: { deleteFiles: boolean },
  dryRun: boolean,
  counts: Record<string, number>,
  push: (l: LogLine["level"], m: string) => void
) {
  const client = new RadarrClient(conn.baseUrl, conn.apiKey);
  const movies = await prisma.mediaItem.findMany({
    where: { connectionId: conn.id, type: "MOVIE" },
  });

  for (const m of movies) {
    // Case 1: monitored + on streaming -> unmonitor (+ delete file).
    if (m.monitored && m.onStreaming) {
      push("action", `[${conn.name}] Unmonitor movie "${m.title}" (on streaming).`);
      counts.unmonitoredMovies++;
      if (!dryRun) {
        await client.setMovieMonitored(m.arrId, false);
        await prisma.mediaItem.update({ where: { id: m.id }, data: { monitored: false } });
      }
      if (settings.deleteFiles && m.hasFile) {
        const movie = dryRun ? null : await client.getMovie(m.arrId);
        const fileId = movie?.movieFile?.id;
        push("action", `[${conn.name}] Delete file for "${m.title}".`);
        counts.deletedFiles++;
        if (!dryRun && fileId) {
          await client.deleteMovieFile(fileId);
          await prisma.mediaItem.update({ where: { id: m.id }, data: { hasFile: false } });
        }
      }
    }
    // Case 2: unmonitored + NOT on streaming -> re-monitor.
    else if (!m.monitored && !m.onStreaming) {
      push("action", `[${conn.name}] Re-monitor movie "${m.title}" (left streaming).`);
      counts.remonitoredMovies++;
      if (!dryRun) {
        await client.setMovieMonitored(m.arrId, true);
        await prisma.mediaItem.update({ where: { id: m.id }, data: { monitored: true } });
      }
    }
  }
}

async function sweepSonarr(
  conn: { id: number; name: string; baseUrl: string; apiKey: string },
  settings: { deleteFiles: boolean },
  dryRun: boolean,
  counts: Record<string, number>,
  push: (l: LogLine["level"], m: string) => void
) {
  const client = new SonarrClient(conn.baseUrl, conn.apiKey);
  const series = await prisma.mediaItem.findMany({
    where: { connectionId: conn.id, type: "TV" },
    include: { episodes: true },
  });

  for (const s of series) {
    const toUnmonitor: number[] = [];
    const toRemonitor: number[] = [];
    const filesToDelete: { epId: number; fileId: number; label: string }[] = [];

    for (const ep of s.episodes) {
      if (ep.monitored && ep.onStreaming) {
        toUnmonitor.push(ep.arrEpisodeId);
        if (settings.deleteFiles && ep.hasFile && ep.episodeFileId) {
          filesToDelete.push({
            epId: ep.id,
            fileId: ep.episodeFileId,
            label: `${s.title} S${ep.seasonNumber}E${ep.episodeNumber}`,
          });
        }
      } else if (!ep.monitored && !ep.onStreaming) {
        toRemonitor.push(ep.arrEpisodeId);
      }
    }

    if (toUnmonitor.length) {
      push("action", `[${conn.name}] Unmonitor ${toUnmonitor.length} episode(s) of "${s.title}" (on streaming).`);
      counts.unmonitoredEps += toUnmonitor.length;
      if (!dryRun) {
        await client.setEpisodeMonitored(toUnmonitor, false);
        await prisma.episode.updateMany({
          where: { mediaId: s.id, arrEpisodeId: { in: toUnmonitor } },
          data: { monitored: false },
        });
      }
    }

    for (const f of filesToDelete) {
      push("action", `[${conn.name}] Delete file for ${f.label}.`);
      counts.deletedFiles++;
      if (!dryRun) {
        await client.deleteEpisodeFile(f.fileId);
        await prisma.episode.update({
          where: { id: f.epId },
          data: { hasFile: false, episodeFileId: null },
        });
      }
    }

    if (toRemonitor.length) {
      push("action", `[${conn.name}] Re-monitor ${toRemonitor.length} episode(s) of "${s.title}" (left streaming).`);
      counts.remonitoredEps += toRemonitor.length;
      if (!dryRun) {
        await client.setEpisodeMonitored(toRemonitor, true);
        await prisma.episode.updateMany({
          where: { mediaId: s.id, arrEpisodeId: { in: toRemonitor } },
          data: { monitored: true },
        });
      }
    }
  }
}

async function searchRadarr(
  conn: { id: number; name: string; baseUrl: string; apiKey: string },
  dryRun: boolean,
  counts: Record<string, number>,
  push: (l: LogLine["level"], m: string) => void
) {
  const client = new RadarrClient(conn.baseUrl, conn.apiKey);
  const monitored = await prisma.mediaItem.findMany({
    where: { connectionId: conn.id, type: "MOVIE", monitored: true },
    select: { arrId: true },
  });
  const ids = monitored.map((m) => m.arrId);
  if (!ids.length) return;
  push("action", `[${conn.name}] Search ${ids.length} monitored movie(s).`);
  counts.searchedItems += ids.length;
  if (!dryRun) await client.searchMovies(ids);
}

async function searchSonarr(
  conn: { id: number; name: string; baseUrl: string; apiKey: string },
  dryRun: boolean,
  counts: Record<string, number>,
  push: (l: LogLine["level"], m: string) => void
) {
  const client = new SonarrClient(conn.baseUrl, conn.apiKey);
  const series = await prisma.mediaItem.findMany({
    where: { connectionId: conn.id, type: "TV" },
    include: { episodes: { where: { monitored: true }, select: { arrEpisodeId: true } } },
  });
  const episodeIds = series.flatMap((s) => s.episodes.map((e) => e.arrEpisodeId));
  if (!episodeIds.length) return;
  push("action", `[${conn.name}] Search ${episodeIds.length} monitored episode(s).`);
  counts.searchedItems += episodeIds.length;
  if (!dryRun) {
    // Chunk to avoid overly large command payloads.
    for (let i = 0; i < episodeIds.length; i += 200) {
      await client.searchEpisodes(episodeIds.slice(i, i + 200));
    }
  }
}
