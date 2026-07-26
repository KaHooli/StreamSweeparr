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
import { startRun, RunContext, type LogLevel, type RunCounts } from "./jobs";

type Push = (level: LogLevel, msg: string) => void;

/**
 * Start a sweep in the background (behind the run lock). Returns the runId.
 * Throws RunLockError if another run is active.
 */
export async function runSweep(): Promise<number> {
  const settings = await getSettings();
  const dryRun = !settings.applyChanges;
  return startRun("SWEEP", dryRun, (ctx) => sweepBody(ctx, dryRun));
}

async function sweepBody(ctx: RunContext, dryRun: boolean): Promise<void> {
  const settings = await getSettings();
  const push: Push = (level, msg) => ctx.push(level, msg);
  const counts = ctx.counts;

  push("info", `Starting ${dryRun ? "DRY-RUN" : "LIVE"} sweep.`);

  // 1. Refresh snapshot first.
  push("info", "Syncing latest state from Sonarr/Radarr + Watchmode…");
  const sync = await runSync(push);
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
  // Note: no post-run resync. The sweep already updates the DB snapshot as it
  // toggles monitoring / deletes files, so the dashboard is current — and this
  // avoids a second full Watchmode pull (previously doubling TV credit usage).
}

async function sweepRadarr(
  conn: { id: number; name: string; baseUrl: string; apiKey: string },
  settings: { deleteFiles: boolean },
  dryRun: boolean,
  counts: RunCounts,
  push: Push
) {
  const client = new RadarrClient(conn.baseUrl, conn.apiKey);
  const movies = await prisma.mediaItem.findMany({
    where: { connectionId: conn.id, type: "MOVIE", skipped: false },
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
        if (dryRun) {
          // Preview: count what would be deleted.
          push("action", `[${conn.name}] Would delete file for "${m.title}".`);
          counts.deletedFiles++;
        } else {
          const movie = await client.getMovie(m.arrId);
          const fileId = movie?.movieFile?.id;
          if (fileId) {
            push("action", `[${conn.name}] Delete file for "${m.title}".`);
            await client.deleteMovieFile(fileId);
            await prisma.mediaItem.update({ where: { id: m.id }, data: { hasFile: false } });
            counts.deletedFiles++; // only count actual deletions
          } else {
            push("warn", `[${conn.name}] No file id found for "${m.title}"; skipped delete.`);
          }
        }
      }
    }
    // Case 2: unmonitored + confidently NOT on streaming -> re-monitor.
    // Skip when streaming status is unknown (failed/absent Watchmode lookup)
    // so a transient outage never re-monitors the whole library.
    else if (!m.monitored && !m.onStreaming && !m.streamingUnknown) {
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
  counts: RunCounts,
  push: Push
) {
  const client = new SonarrClient(conn.baseUrl, conn.apiKey);
  const series = await prisma.mediaItem.findMany({
    where: { connectionId: conn.id, type: "TV", skipped: false },
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
      } else if (!ep.monitored && !ep.onStreaming && !ep.streamingUnknown) {
        // Only re-monitor when we're confident the episode left streaming;
        // skip episodes whose availability we couldn't determine.
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
  counts: RunCounts,
  push: Push
) {
  const client = new RadarrClient(conn.baseUrl, conn.apiKey);
  const monitored = await prisma.mediaItem.findMany({
    where: { connectionId: conn.id, type: "MOVIE", monitored: true, skipped: false },
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
  counts: RunCounts,
  push: Push
) {
  const client = new SonarrClient(conn.baseUrl, conn.apiKey);
  const series = await prisma.mediaItem.findMany({
    where: { connectionId: conn.id, type: "TV", skipped: false },
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
