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

/**
 * Collects per-item failures so one unreachable title cannot abandon the rest
 * of the library.
 *
 * A sweep walks thousands of titles across several instances. Letting an
 * exception propagate would mean a single 500 on movie #12 leaves #13 onward
 * untouched. Instead every item is attempted, failures are logged where they
 * happen, and the run ends FAILED with a summary — a partial sweep should never
 * be mistaken for a clean one.
 */
class ErrorCollector {
  readonly messages: string[] = [];

  constructor(private push: Push) {}

  /** Run `fn`, recording and swallowing any error. */
  async attempt<T>(what: string, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (e) {
      this.record(what, e);
      return undefined;
    }
  }

  record(what: string, e: unknown) {
    const msg = `${what}: ${(e as Error).message}`;
    this.messages.push(msg);
    this.push("warn", msg);
  }

  get count() {
    return this.messages.length;
  }

  /** A summary suitable for the run's `error` field, or null if all was well. */
  summary(): string | null {
    if (!this.messages.length) return null;
    const shown = this.messages.slice(0, 5);
    const rest = this.messages.length - shown.length;
    return (
      `Sweep finished with ${this.messages.length} error(s). ` +
      shown.join(" | ") +
      (rest > 0 ? ` | …and ${rest} more (see the run log).` : "")
    );
  }
}

/** Thrown at the very end of a sweep that completed but hit item failures. */
export class SweepPartialFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SweepPartialFailure";
  }
}

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

  const errors = new ErrorCollector(push);

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
    // A connection that falls over (unreachable instance, bad API key) must not
    // take the other connections down with it.
    await errors.attempt(`[${conn.name}] sweep`, () =>
      conn.type === "RADARR"
        ? sweepRadarr(conn, settings, dryRun, counts, push, errors)
        : sweepSonarr(conn, settings, dryRun, counts, push, errors)
    );
  }

  // 4. Search all monitored items.
  if (settings.searchAtEnd) {
    push("info", "Triggering search for all monitored items…");
    for (const conn of connections) {
      await errors.attempt(`[${conn.name}] search`, () =>
        conn.type === "RADARR"
          ? searchRadarr(conn, dryRun, counts, push)
          : searchSonarr(conn, dryRun, counts, push)
      );
    }
  }

  // Note: no post-run resync. The sweep already updates the DB snapshot as it
  // toggles monitoring / deletes files, so the dashboard is current — and this
  // avoids a second full Watchmode pull (previously doubling TV credit usage).
  const summary = errors.summary();
  if (summary) {
    // Everything that could be done has been done — but the run did not fully
    // succeed, and saying SUCCESS here would hide that.
    push("warn", `Sweep finished with ${errors.count} error(s).`);
    throw new SweepPartialFailure(summary);
  }

  push("info", "Sweep complete.");
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
 * A batch of files queued for deletion, so the *arr call can be made once for
 * the whole set instead of once per title.
 */
interface PendingFileDelete {
  /** MediaItem / Episode row id, updated once the delete succeeds. */
  rowId: number;
  /** Radarr movieFileId or Sonarr episodeFileId. */
  fileId: number;
  label: string;
  reason: DeleteReason;
}

/** Split a list into fixed-size chunks so request payloads stay reasonable. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Ids per bulk *arr request. */
const BATCH = 200;

async function sweepRadarr(
  conn: { id: number; name: string; baseUrl: string; apiKey: string },
  settings: {
    deleteFiles: boolean;
    removeMissingTmdbMovies: boolean;
    purgeUnmonitoredFiles: boolean;
  },
  dryRun: boolean,
  counts: RunCounts,
  push: Push,
  errors: ErrorCollector
) {
  const client = new RadarrClient(conn.baseUrl, conn.apiKey);
  const movies = await prisma.mediaItem.findMany({
    where: { connectionId: conn.id, type: "MOVIE", skipped: false },
  });

  // Decide everything first, then act in batches. Planning is pure and cannot
  // fail, so a Radarr outage can only cost us the apply step — never leave the
  // library half-planned.
  const toUnmonitor: { rowId: number; arrId: number; title: string }[] = [];
  const toRemonitor: { rowId: number; arrId: number; title: string }[] = [];
  const filesToDelete: PendingFileDelete[] = [];
  const missingFileId: string[] = [];

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
        // Removals stay one-at-a-time: they are rare, and isolating them means a
        // single stubborn title cannot block the others.
        await errors.attempt(`[${conn.name}] remove "${m.title}"`, async () => {
          await client.deleteMovie(m.arrId);
          await prisma.mediaItem.delete({ where: { id: m.id } });
        });
      }
      continue;
    }

    const plan = planItem(m, settings);
    const entry = { rowId: m.id, arrId: m.arrId, title: m.title };

    if (plan.monitor === "unmonitor") {
      push("action", `[${conn.name}] Unmonitor movie "${m.title}" (on streaming).`);
      counts.unmonitoredMovies++;
      toUnmonitor.push(entry);
    } else if (plan.monitor === "remonitor") {
      push("action", `[${conn.name}] Re-monitor movie "${m.title}" (left streaming).`);
      counts.remonitoredMovies++;
      toRemonitor.push(entry);
    }

    // Monitoring is never changed for a purge: the title is already unmonitored,
    // so only the file goes.
    if (plan.deleteFile) {
      push(
        "action",
        `[${conn.name}] ${dryRun ? "Would delete" : "Delete"} file for "${m.title}" ` +
          `(${plan.deleteFile}).`
      );
      if (dryRun) {
        counts.deletedFiles++;
      } else if (m.movieFileId) {
        filesToDelete.push({
          rowId: m.id,
          fileId: m.movieFileId,
          label: m.title,
          reason: plan.deleteFile,
        });
      } else {
        // Rows synced before movieFileId existed, or a movie whose file Radarr
        // did not report. Resolved individually below.
        missingFileId.push(m.title);
        await errors.attempt(`[${conn.name}] delete file for "${m.title}"`, async () => {
          const movie = await client.getMovie(m.arrId);
          const fileId = movie?.movieFile?.id;
          if (!fileId) {
            push("warn", `[${conn.name}] No file id found for "${m.title}"; skipped delete.`);
            return;
          }
          await client.deleteMovieFile(fileId);
          await prisma.mediaItem.update({
            where: { id: m.id },
            data: { hasFile: false, movieFileId: null },
          });
          counts.deletedFiles++;
        });
      }
    }
  }

  if (dryRun) return;

  await applyRadarrMonitoring(client, conn, toUnmonitor, false, errors);
  await applyRadarrMonitoring(client, conn, toRemonitor, true, errors);

  for (const batch of chunk(filesToDelete, BATCH)) {
    await errors.attempt(`[${conn.name}] delete ${batch.length} movie file(s)`, async () => {
      await client.deleteMovieFiles(batch.map((f) => f.fileId));
      await prisma.mediaItem.updateMany({
        where: { id: { in: batch.map((f) => f.rowId) } },
        data: { hasFile: false, movieFileId: null },
      });
      counts.deletedFiles += batch.length;
    });
  }

  if (missingFileId.length) {
    push(
      "info",
      `[${conn.name}] ${missingFileId.length} movie(s) had no cached file id and were ` +
        `resolved individually; the next sync records them.`
    );
  }
}

/** Apply one monitoring state to a set of movies, in batches. */
async function applyRadarrMonitoring(
  client: RadarrClient,
  conn: { name: string },
  items: { rowId: number; arrId: number }[],
  monitored: boolean,
  errors: ErrorCollector
) {
  const verb = monitored ? "re-monitor" : "unmonitor";
  for (const batch of chunk(items, BATCH)) {
    await errors.attempt(`[${conn.name}] ${verb} ${batch.length} movie(s)`, async () => {
      await client.setMoviesMonitored(
        batch.map((m) => m.arrId),
        monitored
      );
      await prisma.mediaItem.updateMany({
        where: { id: { in: batch.map((m) => m.rowId) } },
        data: { monitored },
      });
    });
  }
}

async function sweepSonarr(
  conn: { id: number; name: string; baseUrl: string; apiKey: string },
  settings: { deleteFiles: boolean; purgeUnmonitoredFiles: boolean },
  dryRun: boolean,
  counts: RunCounts,
  push: Push,
  errors: ErrorCollector
) {
  const client = new SonarrClient(conn.baseUrl, conn.apiKey);
  const series = await prisma.mediaItem.findMany({
    where: { connectionId: conn.id, type: "TV", skipped: false },
    include: { episodes: true },
  });

  for (const s of series) {
    const toUnmonitor: number[] = [];
    const toRemonitor: number[] = [];
    const filesToDelete: PendingFileDelete[] = [];

    for (const ep of s.episodes) {
      const plan = planItem(ep, settings);

      if (plan.monitor === "unmonitor") toUnmonitor.push(ep.arrEpisodeId);
      else if (plan.monitor === "remonitor") toRemonitor.push(ep.arrEpisodeId);

      if (plan.deleteFile && ep.episodeFileId) {
        filesToDelete.push({
          rowId: ep.id,
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
        await errors.attempt(`[${conn.name}] unmonitor episodes of "${s.title}"`, async () => {
          await client.setEpisodeMonitored(toUnmonitor, false);
          await prisma.episode.updateMany({
            where: { mediaId: s.id, arrEpisodeId: { in: toUnmonitor } },
            data: { monitored: false },
          });
        });
      }
    }

    for (const f of filesToDelete) {
      push("action", `[${conn.name}] ${dryRun ? "Would delete" : "Delete"} file for ${f.label} (${f.reason}).`);
      if (dryRun) counts.deletedFiles++;
    }
    if (!dryRun) {
      for (const batch of chunk(filesToDelete, BATCH)) {
        await errors.attempt(
          `[${conn.name}] delete ${batch.length} episode file(s) of "${s.title}"`,
          async () => {
            await client.deleteEpisodeFiles(batch.map((f) => f.fileId));
            await prisma.episode.updateMany({
              where: { id: { in: batch.map((f) => f.rowId) } },
              data: { hasFile: false, episodeFileId: null },
            });
            counts.deletedFiles += batch.length;
          }
        );
      }
    }

    if (toRemonitor.length) {
      push("action", `[${conn.name}] Re-monitor ${toRemonitor.length} episode(s) of "${s.title}" (left streaming).`);
      counts.remonitoredEps += toRemonitor.length;
      if (!dryRun) {
        await errors.attempt(`[${conn.name}] re-monitor episodes of "${s.title}"`, async () => {
          await client.setEpisodeMonitored(toRemonitor, true);
          await prisma.episode.updateMany({
            where: { mediaId: s.id, arrEpisodeId: { in: toRemonitor } },
            data: { monitored: true },
          });
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
  // Read the episode ids directly rather than loading every series with its
  // episodes attached: the search only needs the ids.
  const episodes = await prisma.episode.findMany({
    where: {
      monitored: true,
      media: { connectionId: conn.id, type: "TV", skipped: false },
    },
    select: { arrEpisodeId: true },
  });
  const episodeIds = episodes.map((e) => e.arrEpisodeId);
  if (!episodeIds.length) return;
  push("action", `[${conn.name}] Search ${episodeIds.length} monitored episode(s).`);
  counts.searchedItems += episodeIds.length;
  if (!dryRun) {
    // Chunk to avoid overly large command payloads.
    for (const batch of chunk(episodeIds, BATCH)) {
      await client.searchEpisodes(batch);
    }
  }
}
