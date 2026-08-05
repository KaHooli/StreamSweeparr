/**
 * Sweep engine — the core StreamSweeparr workflow.
 *
 * For every enabled connection:
 *   1. UNMONITOR + DELETE: monitored items (movies / episodes) that are now
 *      available on a selected streaming service are set to unmonitored and,
 *      if enabled, their files are deleted.
 *   2. RE-MONITOR: unmonitored items that are NO LONGER on any selected
 *      streaming service are set back to monitored.
 *   3. PURGE (optional, `purgeUnmonitoredFiles`): delete files for every item
 *      that is still unmonitored once 1 and 2 are decided. Unlike `deleteFiles`
 *      — which only covers titles this sweep just unmonitored — this also clears
 *      an unmonitored back-catalogue. Items re-monitored by 2 are never purged.
 *   4. SEARCH: at the end, trigger a search for every monitored movie/episode.
 *
 * A run always syncs first so decisions are based on fresh data. When
 * `applyChanges` is false the run is a dry-run: it records what *would* happen
 * without mutating Sonarr/Radarr.
 */

import { prisma, getSettings } from "./db";
import { SonarrClient, RadarrClient } from "./arr";
import { runSync } from "./sync";
import { startRun, RunContext, type LogLevel, type RunCounts } from "./jobs";
import { describeSchedule } from "./schedule";

type Push = (level: LogLevel, msg: string) => void;

/** What kicked the sweep off — recorded in the run log. */
export type SweepTrigger = "manual" | "schedule";

/**
 * Start a sweep in the background (behind the run lock). Returns the runId.
 * Throws RunLockError if another run is active.
 */
export async function runSweep(trigger: SweepTrigger = "manual"): Promise<number> {
  const settings = await getSettings();
  const dryRun = !settings.applyChanges;
  return startRun("SWEEP", dryRun, (ctx) => sweepBody(ctx, dryRun, trigger));
}

async function sweepBody(ctx: RunContext, dryRun: boolean, trigger: SweepTrigger): Promise<void> {
  const settings = await getSettings();
  const push: Push = (level, msg) => ctx.push(level, msg);
  const counts = ctx.counts;

  push(
    "info",
    trigger === "schedule"
      ? `Starting scheduled ${dryRun ? "DRY-RUN" : "LIVE"} sweep (${describeSchedule(
          settings.sweepIntervalHours
        )}).`
      : `Starting ${dryRun ? "DRY-RUN" : "LIVE"} sweep.`
  );

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

  // 4. Search all monitored items.
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

/** What the sweep should do with one item's monitoring flag. */
export type MonitorAction = "unmonitor" | "remonitor" | "none";

/** Why an item's file should be deleted, or null to keep it. */
export type DeleteReason = "on streaming" | "unmonitored";

export interface ItemPlan {
  monitor: MonitorAction;
  deleteFile: DeleteReason | null;
}

/**
 * Decide what happens to a single movie/episode. Pure: no I/O, so the whole
 * decision matrix (including the destructive ones) is unit-testable.
 *
 * Monitoring:
 *   - monitored + on streaming            -> unmonitor
 *   - unmonitored + confidently not on it -> remonitor
 *   - unknown streaming status            -> leave alone, so a Watchmode/TMDB
 *     outage can never re-monitor an entire library
 *
 * File deletion (at most one reason, so a file is never queued twice):
 *   - `deleteFiles` covers only the item this sweep just unmonitored.
 *   - `purgeUnmonitoredFiles` additionally covers anything left unmonitored,
 *     which is what clears a pre-existing unmonitored back-catalogue. Items
 *     being re-monitored are excluded: they are monitored once the sweep ends,
 *     so their files must survive.
 */
export function planItem(
  item: {
    monitored: boolean;
    onStreaming: boolean;
    streamingUnknown: boolean;
    hasFile: boolean;
  },
  settings: { deleteFiles: boolean; purgeUnmonitoredFiles: boolean }
): ItemPlan {
  let monitor: MonitorAction = "none";
  let monitoredAfter = item.monitored;

  if (item.monitored && item.onStreaming) {
    monitor = "unmonitor";
    monitoredAfter = false;
  } else if (!item.monitored && !item.onStreaming && !item.streamingUnknown) {
    monitor = "remonitor";
    monitoredAfter = true;
  }

  if (!item.hasFile) return { monitor, deleteFile: null };
  if (monitor === "unmonitor" && settings.deleteFiles) {
    return { monitor, deleteFile: "on streaming" };
  }
  if (settings.purgeUnmonitoredFiles && !monitoredAfter) {
    return { monitor, deleteFile: "unmonitored" };
  }
  return { monitor, deleteFile: null };
}

/**
 * Delete a movie's file. The DB snapshot only records *whether* a file exists,
 * so the file id is resolved from Radarr at deletion time. Returns true when a
 * file was deleted (or would be, in a dry-run) so the caller can track state.
 */
async function deleteMovieFile(
  client: RadarrClient,
  conn: { name: string },
  m: { id: number; arrId: number; title: string },
  reason: string,
  dryRun: boolean,
  counts: RunCounts,
  push: Push
): Promise<boolean> {
  if (dryRun) {
    // Preview: count what would be deleted.
    push("action", `[${conn.name}] Would delete file for "${m.title}" (${reason}).`);
    counts.deletedFiles++;
    return true;
  }
  const movie = await client.getMovie(m.arrId);
  const fileId = movie?.movieFile?.id;
  if (!fileId) {
    push("warn", `[${conn.name}] No file id found for "${m.title}"; skipped delete.`);
    return false;
  }
  push("action", `[${conn.name}] Delete file for "${m.title}" (${reason}).`);
  await client.deleteMovieFile(fileId);
  await prisma.mediaItem.update({ where: { id: m.id }, data: { hasFile: false } });
  counts.deletedFiles++; // only count actual deletions
  return true;
}

async function sweepRadarr(
  conn: { id: number; name: string; baseUrl: string; apiKey: string },
  settings: {
    deleteFiles: boolean;
    removeMissingTmdbMovies: boolean;
    purgeUnmonitoredFiles: boolean;
  },
  dryRun: boolean,
  counts: RunCounts,
  push: Push
) {
  const client = new RadarrClient(conn.baseUrl, conn.apiKey);
  const movies = await prisma.mediaItem.findMany({
    where: { connectionId: conn.id, type: "MOVIE", skipped: false },
  });

  for (const m of movies) {
    // Case 0: TMDB no longer knows this id, so we can never manage the title.
    // Remove it from Radarr (media files are kept) when enabled.
    if (m.tmdbMissing) {
      if (!settings.removeMissingTmdbMovies) {
        push("warn", `[${conn.name}] "${m.title}" is missing from TMDB; leaving it in Radarr.`);
        continue;
      }
      push(
        "action",
        `[${conn.name}] ${dryRun ? "Would remove" : "Remove"} movie "${m.title}" from Radarr ` +
          `(TMDB id ${m.tmdbId ?? "?"} no longer exists).`
      );
      counts.removedMovies++;
      if (!dryRun) {
        await client.deleteMovie(m.arrId);
        await prisma.mediaItem.delete({ where: { id: m.id } });
      }
      continue;
    }

    const plan = planItem(m, settings);

    if (plan.monitor === "unmonitor") {
      push("action", `[${conn.name}] Unmonitor movie "${m.title}" (on streaming).`);
      counts.unmonitoredMovies++;
      if (!dryRun) {
        await client.setMovieMonitored(m.arrId, false);
        await prisma.mediaItem.update({ where: { id: m.id }, data: { monitored: false } });
      }
    } else if (plan.monitor === "remonitor") {
      push("action", `[${conn.name}] Re-monitor movie "${m.title}" (left streaming).`);
      counts.remonitoredMovies++;
      if (!dryRun) {
        await client.setMovieMonitored(m.arrId, true);
        await prisma.mediaItem.update({ where: { id: m.id }, data: { monitored: true } });
      }
    }

    // Monitoring is never changed for a purge: the title is already unmonitored,
    // so only the file goes.
    if (plan.deleteFile) {
      await deleteMovieFile(client, conn, m, plan.deleteFile, dryRun, counts, push);
    }
  }
}

async function sweepSonarr(
  conn: { id: number; name: string; baseUrl: string; apiKey: string },
  settings: { deleteFiles: boolean; purgeUnmonitoredFiles: boolean },
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
    const filesToDelete: {
      epId: number;
      fileId: number;
      label: string;
      reason: DeleteReason;
    }[] = [];

    for (const ep of s.episodes) {
      const plan = planItem(ep, settings);

      if (plan.monitor === "unmonitor") toUnmonitor.push(ep.arrEpisodeId);
      else if (plan.monitor === "remonitor") toRemonitor.push(ep.arrEpisodeId);

      if (plan.deleteFile && ep.episodeFileId) {
        filesToDelete.push({
          epId: ep.id,
          fileId: ep.episodeFileId,
          label: `${s.title} S${ep.seasonNumber}E${ep.episodeNumber}`,
          reason: plan.deleteFile,
        });
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
      push("action", `[${conn.name}] Delete file for ${f.label} (${f.reason}).`);
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
