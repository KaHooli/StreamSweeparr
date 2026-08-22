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
 *   4. SEASONS + SERIES (Sonarr only): Sonarr's own flags are brought into line
 *      with what sits underneath them. A season goes off once every *aired*
 *      episode of it is unmonitored and on while it still holds a monitored
 *      one; the series itself goes off once it has **ended** and every season
 *      is unmonitored, and on while any season is. Those flags are what a newly
 *      aired episode inherits and what Sonarr checks before grabbing anything,
 *      so leaving them wrong decides whether a show the user already streams
 *      keeps collecting episodes.
 *   5. SEARCH: at the end, trigger a search for everything left monitored that
 *      is still missing a file, grouping episodes into season searches wherever
 *      that cannot pull back an episode the sweep just unmonitored. Searching
 *      per episode is what an indexer feels, so this is where the run's cost to
 *      the outside world is decided — see `planEpisodeSearch`.
 *
 * A run always syncs first so decisions are based on fresh data. When
 * `applyChanges` is false the run is a dry-run: it records what *would* happen
 * without mutating Sonarr/Radarr.
 */

import type { MediaType } from "@/generated/prisma/client";
import { prisma, getSettings } from "./db";
import { SonarrClient, RadarrClient } from "./arr";
import { runSync, type SyncTarget } from "./sync";
import {
  startRun,
  RunAbortedError,
  RunContext,
  type CheckAbort,
  type LogLevel,
  type RunCounts,
} from "./jobs";
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
      // An abort is not an item failure — it is the run being told to stop, so
      // it has to travel straight through the collector. Recorded and swallowed
      // like anything else, it would be logged as a broken title and the sweep
      // would carry on to the next one, which is the opposite of what was asked.
      if (e instanceof RunAbortedError) throw e;
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
export type SweepTrigger = "manual" | "schedule" | "webhook";

/**
 * One title a sweep should confine itself to.
 *
 * A targeted sweep is the whole sweep — same sync, same decision matrix, same
 * end-of-run search — with every database query narrowed to these titles. That
 * is what makes "Sonarr just added a show, check that show" cost one Watchmode
 * call instead of a library-wide pass.
 */
export interface SweepTarget {
  connectionId: number;
  type: MediaType;
  arrId: number;
  /** For the run log; the sweep re-reads everything it acts on. */
  title: string;
}

/**
 * Start a sweep in the background (behind the run lock). Returns the runId.
 * Throws RunLockError if another run is active.
 */
export async function runSweep(trigger: SweepTrigger = "manual"): Promise<number> {
  const settings = await getSettings();
  const dryRun = !settings.applyChanges;
  return startRun("SWEEP", dryRun, (ctx) => sweepBody(ctx, dryRun, trigger));
}

/**
 * Start a sweep confined to `targets` — the webhook path.
 *
 * `onFinished` runs once the body is done, before the run is finalised, and is
 * how the caller learns the outcome of work that is otherwise detached: the
 * queue uses it to drop the titles it handed over, or to put them back.
 */
export async function runTargetedSweep(
  targets: SweepTarget[],
  opts: {
    trigger?: SweepTrigger;
    onFinished?: (outcome: { ok: boolean; error?: Error }) => Promise<void>;
  } = {}
): Promise<number> {
  if (!targets.length) throw new Error("A targeted sweep needs at least one title.");
  const settings = await getSettings();
  const dryRun = !settings.applyChanges;
  return startRun("SWEEP", dryRun, async (ctx) => {
    let outcome: { ok: boolean; error?: Error } = { ok: false };
    try {
      await sweepBody(ctx, dryRun, opts.trigger ?? "webhook", targets);
      outcome = { ok: true };
    } catch (e) {
      outcome = { ok: false, error: e as Error };
      throw e;
    } finally {
      if (opts.onFinished) {
        // A bookkeeping failure must not turn a completed sweep into a failed
        // one — the run log is the record of what actually happened.
        await opts.onFinished(outcome).catch(() => {});
      }
    }
  });
}

/** Human-readable list of the titles a targeted sweep covers. */
function describeTargets(targets: SweepTarget[]): string {
  const shown = targets.slice(0, 5).map((t) => `"${t.title}"`);
  const rest = targets.length - shown.length;
  return shown.join(", ") + (rest > 0 ? ` and ${rest} more` : "");
}

async function sweepBody(
  ctx: RunContext,
  dryRun: boolean,
  trigger: SweepTrigger,
  targets?: SweepTarget[]
): Promise<void> {
  const settings = await getSettings();
  const push: Push = (level, msg) => ctx.push(level, msg);
  // Handed to every phase so an admin's "Abort" lands between titles rather
  // than only between whole connections.
  const checkAbort: CheckAbort = () => ctx.checkAbort();
  const counts = ctx.counts;
  const mode = dryRun ? "DRY-RUN" : "LIVE";

  push(
    "info",
    targets
      ? `Starting webhook-triggered ${mode} sweep for ${targets.length} newly added ` +
          `title(s): ${describeTargets(targets)}.`
      : trigger === "schedule"
      ? `Starting scheduled ${mode} sweep (${describeSchedule(settings.sweepIntervalHours)}).`
      : `Starting ${mode} sweep.`
  );

  const errors = new ErrorCollector(push);

  // Which *arr ids each connection is limited to, or null for the whole library.
  const scope = targets ? targetsByConnection(targets) : null;

  // 1. Refresh snapshot first. A targeted sweep forces the provider lookup: it
  // is running *because* something just changed for these titles, so a cached
  // answer is the wrong one to act on.
  push("info", "Syncing latest state from Sonarr/Radarr + Watchmode…");
  const sync = await runSync(push, {
    ...(targets ? { targets: targets.map(toSyncTarget), force: true } : {}),
    checkAbort,
  });
  push(
    "info",
    `Synced ${sync.movies} movies (${sync.onStreamingMovies} on streaming), ${sync.series} series (${sync.onStreamingSeries} on streaming).`
  );
  for (const e of sync.errors) push("warn", e);

  const connections = settings.connections.filter(
    (c) => c.enabled && (!scope || scope.has(c.id))
  );

  for (const conn of connections) {
    await checkAbort();
    const arrIds = scope?.get(conn.id);
    // A connection that falls over (unreachable instance, bad API key) must not
    // take the other connections down with it.
    await errors.attempt(`[${conn.name}] sweep`, () =>
      conn.type === "RADARR"
        ? sweepRadarr(conn, settings, dryRun, counts, push, errors, checkAbort, arrIds)
        : sweepSonarr(conn, settings, dryRun, counts, push, errors, checkAbort, arrIds)
    );
  }

  // 5. Search the monitored items this sweep covered.
  if (settings.searchAtEnd) {
    push(
      "info",
      targets
        ? "Triggering search for the monitored items among these titles…"
        : "Triggering search for all monitored items…"
    );
    for (const conn of connections) {
      await checkAbort();
      const arrIds = scope?.get(conn.id);
      await errors.attempt(`[${conn.name}] search`, () =>
        conn.type === "RADARR"
          ? searchRadarr(conn, dryRun, counts, push, arrIds)
          : searchSonarr(conn, dryRun, counts, push, arrIds)
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

/** Drop the label a targeted sweep carries for the run log. */
function toSyncTarget(t: SweepTarget): SyncTarget {
  return { connectionId: t.connectionId, type: t.type, arrId: t.arrId };
}

/** Connection id -> the *arr ids a targeted sweep is confined to on it. */
function targetsByConnection(targets: SweepTarget[]): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const t of targets) {
    const ids = out.get(t.connectionId) ?? [];
    if (!ids.includes(t.arrId)) ids.push(t.arrId);
    out.set(t.connectionId, ids);
  }
  return out;
}

/**
 * A Prisma `where` fragment confining a query to a targeted sweep's ids.
 * Undefined means "the whole library", which is the unscoped sweep.
 */
function arrIdFilter(arrIds?: number[]) {
  return arrIds ? { arrId: { in: arrIds } } : {};
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

/** One episode as the season decision sees it, after `planItem` has spoken. */
export interface SeasonEpisode {
  seasonNumber: number;
  arrEpisodeId: number;
  /** Monitored state once this sweep's episode changes are applied. */
  monitored: boolean;
  /** Null when Sonarr has no announced date — treated as "not aired yet". */
  airDateUtc: Date | null;
}

/** A season flag this sweep should bring into line with its episodes. */
export interface SeasonPlan {
  seasonNumber: number;
  /** What to write to Sonarr's season flag. */
  monitored: boolean;
  /**
   * Episodes whose settled state is the *opposite* of `monitored`. Writing the
   * season flattens every episode in it to `monitored`, so these have to be set
   * back immediately afterwards or the write undoes the sweep's own decisions.
   */
  correct: number[];
}

/**
 * Decide which season flags to write. Pure, like `planItem`, so the matrix is
 * unit-testable without a Sonarr.
 *
 * Sonarr keeps a monitored flag on the season as well as on each episode, and
 * the episode endpoint does not touch it — so a sweep that unmonitors episodes
 * leaves the two disagreeing. That is not merely cosmetic: the season flag is
 * what a newly aired episode inherits when Sonarr refreshes the series, so the
 * disagreement decides whether the season quietly starts collecting episodes
 * again.
 *
 * **Unmonitor** a season when:
 *   - it has at least one **aired** episode — a season that has not started
 *     carries no evidence either way, and marking it unmonitored would be a
 *     guess about a show the user may well still want; and
 *   - every aired episode is unmonitored once this sweep is applied.
 *
 * Unaired episodes are deliberately ignored rather than required to be
 * unmonitored. A season that is still airing has future episodes sitting
 * monitored precisely so Sonarr grabs them, and waiting for those would mean a
 * currently-airing season could never qualify — which is the case the user hits
 * most, because it is the one where Sonarr keeps adding episodes.
 *
 * **Monitor** a season that ends the sweep holding any monitored episode. That
 * covers the show which has left streaming and had its episodes re-monitored,
 * but it is deliberately not limited to it: the flag is meant to describe the
 * episodes, so a season holding something monitored is monitored however it got
 * that way. Hand-set monitoring is not a reason to hold back — `planItem`
 * already re-monitors an episode the user unmonitored by hand, and `ss-skip` is
 * how a title opts out of all of it.
 *
 * The unmonitor rule wins when both fit, which happens when a still-streaming
 * season has unaired episodes left monitored. Nothing is lost by that: Sonarr
 * grabs an episode on its own monitored flag, not its season's, so those are
 * still picked up — and letting the two rules alternate would flip the flag on
 * every sweep.
 *
 * Season 0 is never considered: sync drops specials from the snapshot, so
 * "every aired episode is unmonitored" would be vacuously true for a season we
 * hold no episodes of. The `> 0` test is what stops that becoming an unmonitor.
 */
export function planSeasons(episodes: SeasonEpisode[], now: Date): SeasonPlan[] {
  const hasAired = (e: SeasonEpisode) =>
    e.airDateUtc !== null && e.airDateUtc.getTime() <= now.getTime();

  const bySeason = new Map<number, SeasonEpisode[]>();
  for (const ep of episodes) {
    if (ep.seasonNumber <= 0) continue;
    const list = bySeason.get(ep.seasonNumber);
    if (list) list.push(ep);
    else bySeason.set(ep.seasonNumber, [ep]);
  }

  const plans: SeasonPlan[] = [];
  for (const [seasonNumber, eps] of bySeason) {
    const aired = eps.filter(hasAired);
    const spent = aired.length > 0 && !aired.some((e) => e.monitored);
    const monitored = spent ? false : eps.some((e) => e.monitored) ? true : null;
    if (monitored === null) continue;
    plans.push({
      seasonNumber,
      monitored,
      correct: eps.filter((e) => e.monitored !== monitored).map((e) => e.arrEpisodeId),
    });
  }
  // Sorted so the run log reads in season order rather than snapshot order.
  return plans.sort((a, b) => a.seasonNumber - b.seasonNumber);
}

/** Sonarr's series status for a show that will not produce more episodes. */
const ENDED = "ended";

/**
 * Decide the series' own monitored flag from the seasons it will end up with.
 * Null means leave it alone. Pure, so the rule is testable without a Sonarr.
 *
 * A series flag sits above the season flags and is the one Sonarr checks first:
 * an unmonitored series is never grabbed for, whatever its episodes say. So the
 * two directions are deliberately not symmetric.
 *
 * **Off** takes both a spent library *and* a show that has finished. Every
 * season being unmonitored says the user already streams what exists; `ended`
 * says nothing more is coming, so there is no future episode the flag would
 * have to be monitored to catch. A *continuing* show in the same state keeps
 * its flag, because next season is exactly what it is for.
 *
 * **On** takes only a monitored season, with no status test. A show that leaves
 * streaming has its seasons turned back on by `planSeasons`, and leaving the
 * series flag off would silently stop every one of those grabs — the trap this
 * direction exists to close. Status has no bearing on it: an ended show can be
 * wanted again just as easily as a continuing one.
 *
 * Specials count. Sync never records season 0's episodes, so `planSeasons`
 * cannot speak for it, but Sonarr still reports its flag — and a user who
 * monitors specials wants specials, which unmonitoring the series would stop.
 * Reading the whole seasons array as Sonarr gives it is what keeps that intact.
 */
export function planSeriesMonitored(
  status: string | undefined,
  seasons: { monitored: boolean }[]
): boolean | null {
  if (seasons.some((s) => s.monitored)) return true;
  // No seasons at all is not evidence of a spent library — it is a series
  // Sonarr has not finished building yet.
  if (!seasons.length) return null;
  return status?.toLowerCase() === ENDED ? false : null;
}

/** One episode as the end-of-run search sees it. */
export interface SearchEpisode {
  arrEpisodeId: number;
  seasonNumber: number;
  monitored: boolean;
  hasFile: boolean;
  /** Null when Sonarr has no announced date — treated as "not aired yet". */
  airDateUtc: Date | null;
}

/** A season searched with one query instead of one per episode. */
export interface SeasonSearch {
  /** Sonarr's series id. */
  arrId: number;
  seasonNumber: number;
  /** How many episodes this single query stands in for, for the run counts. */
  episodes: number;
}

/** What the end-of-run search should ask one Sonarr instance for. */
export interface EpisodeSearchPlan {
  seasons: SeasonSearch[];
  /** Episodes searched one by one, by Sonarr episode id. */
  episodeIds: number[];
  /** Episodes covered either way — what `searchedItems` counts. */
  total: number;
}

/**
 * Decide how to search the episodes a sweep leaves monitored.
 *
 * `EpisodeSearch` costs **one indexer query per id** — Sonarr's handler loops
 * over `episodeIds` and searches each separately — so handing it every
 * monitored episode in a library asks the indexers for tens of thousands of
 * queries in one go, however few commands they are batched into. That is not a
 * search an indexer will serve; it is a search that gets the user rate-limited.
 * Two filters and one grouping rule cut it down.
 *
 * **Episodes that already have a file are not searched.** For those a search
 * can only find an upgrade, and "go and get what is no longer on streaming" is
 * not an upgrade run — Sonarr does upgrades on its own schedule, via
 * `CutoffUnmetEpisodeSearch`. On a settled library this removes almost the
 * whole list, and it is the single biggest saving here.
 *
 * **Unaired episodes are not searched either**, reading `airDateUtc` exactly as
 * `planSeasons` does. Nothing exists to find yet, and Sonarr's own RSS sync
 * picks the episode up when it airs.
 *
 * What survives is grouped by season, and a season is searched **as a season
 * only when every episode of it is monitored**. That is stricter than Sonarr's
 * own bulk search, which groups whenever a season contributes more than one
 * episode, and the extra condition is the load-bearing part: monitoring gates
 * *grabbing*, not *importing*, so a season pack accepted for a half-monitored
 * season is imported in full — including the episodes this sweep unmonitored
 * and deleted **because they are on streaming**. Grouping on Sonarr's rule
 * would hand back the library the sweep had just cleared. A mixed season
 * therefore falls back to episode ids, which name exactly what may be fetched.
 *
 * A season contributing a single episode stays an episode search too: one query
 * either way, and the narrower one cannot pull in a pack.
 *
 * Season 0 never reaches this — sync drops specials before they are recorded.
 */
export function planEpisodeSearch(
  series: { arrId: number; episodes: SearchEpisode[] }[],
  now: Date
): EpisodeSearchPlan {
  const hasAired = (e: SearchEpisode) =>
    e.airDateUtc !== null && e.airDateUtc.getTime() <= now.getTime();

  const seasons: SeasonSearch[] = [];
  const episodeIds: number[] = [];

  for (const s of series) {
    const bySeason = new Map<number, SearchEpisode[]>();
    for (const ep of s.episodes) {
      const list = bySeason.get(ep.seasonNumber);
      if (list) list.push(ep);
      else bySeason.set(ep.seasonNumber, [ep]);
    }

    // Season order, so the commands and the run log follow the show.
    for (const [seasonNumber, eps] of [...bySeason.entries()].sort(([a], [b]) => a - b)) {
      const wanted = eps.filter((e) => e.monitored && !e.hasFile && hasAired(e));
      if (!wanted.length) continue;
      if (wanted.length > 1 && eps.every((e) => e.monitored)) {
        seasons.push({ arrId: s.arrId, seasonNumber, episodes: wanted.length });
      } else {
        for (const e of wanted) episodeIds.push(e.arrEpisodeId);
      }
    }
  }

  return {
    seasons,
    episodeIds,
    total: episodeIds.length + seasons.reduce((n, s) => n + s.episodes, 0),
  };
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
  errors: ErrorCollector,
  checkAbort: CheckAbort,
  arrIds?: number[]
) {
  const client = new RadarrClient(conn.baseUrl, conn.apiKey);
  const movies = await prisma.mediaItem.findMany({
    where: { connectionId: conn.id, type: "MOVIE", skipped: false, ...arrIdFilter(arrIds) },
  });

  // Decide everything first, then act in batches. Planning is pure and cannot
  // fail, so a Radarr outage can only cost us the apply step — never leave the
  // library half-planned.
  const toUnmonitor: { rowId: number; arrId: number; title: string }[] = [];
  const toRemonitor: { rowId: number; arrId: number; title: string }[] = [];
  const filesToDelete: PendingFileDelete[] = [];
  const missingFileId: string[] = [];

  for (const m of movies) {
    await checkAbort();
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

  await applyRadarrMonitoring(client, conn, toUnmonitor, false, errors, checkAbort);
  await applyRadarrMonitoring(client, conn, toRemonitor, true, errors, checkAbort);

  for (const batch of chunk(filesToDelete, BATCH)) {
    await checkAbort();
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
  errors: ErrorCollector,
  checkAbort: CheckAbort
) {
  const verb = monitored ? "re-monitor" : "unmonitor";
  for (const batch of chunk(items, BATCH)) {
    // Between batches, never inside one: a batch is a single Radarr call plus
    // the snapshot write that records it, and stopping between those two would
    // leave the database describing a library it no longer matches.
    await checkAbort();
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
  errors: ErrorCollector,
  checkAbort: CheckAbort,
  arrIds?: number[]
) {
  const client = new SonarrClient(conn.baseUrl, conn.apiKey);
  // Select rather than include: `include: { episodes: true }` pulls every
  // column of every episode, and `streamingInfo` is a JSON blob per episode —
  // a six-figure episode table arrives in memory in one go, almost all of it
  // for fields the sweep never reads. The decision only needs planItem's four
  // flags plus the ids used to act on them. (lib/sync.ts and searchSonarr both
  // avoid the eager join for the same reason.)
  const series = await prisma.mediaItem.findMany({
    where: { connectionId: conn.id, type: "TV", skipped: false, ...arrIdFilter(arrIds) },
    select: {
      id: true,
      arrId: true,
      title: true,
      monitored: true,
      episodes: {
        select: {
          id: true,
          arrEpisodeId: true,
          seasonNumber: true,
          episodeNumber: true,
          episodeFileId: true,
          airDateUtc: true,
          monitored: true,
          hasFile: true,
          onStreaming: true,
          streamingUnknown: true,
        },
      },
    },
  });

  // A show Sonarr has only just added often has no episode list yet — the
  // refresh that builds it runs on Sonarr's own schedule. Saying so beats a
  // silent no-op, because the next full sweep is what will actually cover it.
  if (arrIds) {
    for (const s of series) {
      if (!s.episodes.length) {
        push(
          "warn",
          `[${conn.name}] "${s.title}" has no episodes in Sonarr yet, so there is nothing to ` +
            `sweep. It will be covered by the next full sweep.`
        );
      }
    }
  }

  const now = new Date();

  for (const s of series) {
    // One series is one unit of work: it is planned, applied and has its season
    // flags reconciled before the next one starts, so this is the point where
    // stopping leaves nothing half-done.
    await checkAbort();
    const toUnmonitor: number[] = [];
    const toRemonitor: number[] = [];
    const filesToDelete: PendingFileDelete[] = [];
    const seasonEpisodes: SeasonEpisode[] = [];

    for (const ep of s.episodes) {
      const plan = planItem(ep, settings);

      if (plan.monitor === "unmonitor") toUnmonitor.push(ep.arrEpisodeId);
      else if (plan.monitor === "remonitor") toRemonitor.push(ep.arrEpisodeId);

      seasonEpisodes.push({
        seasonNumber: ep.seasonNumber,
        arrEpisodeId: ep.arrEpisodeId,
        // The state this sweep is steering the episode towards, not the one it
        // is in — the season question is "what will this season look like when
        // the sweep is done", and in a dry-run that is the whole answer.
        monitored:
          plan.monitor === "none" ? ep.monitored : plan.monitor === "remonitor",
        airDateUtc: ep.airDateUtc,
      });

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

    // Last, so it sees the episode state this sweep just settled on. A series
    // with no episodes is skipped entirely rather than read: Sonarr has not
    // built its list yet, so every flag above it would be decided on nothing.
    if (s.episodes.length) {
      await errors.attempt(`[${conn.name}] update seasons of "${s.title}"`, () =>
        reconcileSeasons(client, conn, s, planSeasons(seasonEpisodes, now), dryRun, push)
      );
    }
  }
}

/** Why a season flag is being written, for the run log. */
const SEASON_REASON = {
  false: "every aired episode is unmonitored",
  true: "it still holds monitored episodes",
} as const;

/** Why the series' own flag is being written, for the run log. */
const SERIES_REASON = {
  false: "the show has ended and every season is unmonitored",
  true: "it still holds a monitored season",
} as const;

/**
 * Write `plans`' season flags — and the series' own flag — to Sonarr, and
 * repair what the write flattens.
 *
 * Costs one GET per series with episodes, plus a PUT when anything actually
 * disagrees — local *arr calls, not metered provider ones. The GET is
 * unavoidable: `monitored`, `status` and `seasons[]` all live on the series
 * resource and Sonarr wants the whole resource back, so there is nothing to
 * write without reading first. It also tells us what already holds the value we
 * were going to write, which is what keeps a steady-state sweep down to that
 * single read. Both flags then go back in the *same* PUT, since they are the
 * same resource.
 *
 * The write cascades — see `SonarrClient.updateSeries` — rewriting every episode
 * of a changed season to the season's new value. `correct` is every episode the
 * sweep settled on the other value, and putting those back is the whole reason
 * this is safe to do in both directions:
 *
 *   - Turning a season **off** would clear the unaired episodes that are
 *     monitored on purpose. They go straight back.
 *   - Turning one **on** would monitor the episodes that are on streaming —
 *     undoing the sweep's entire point. They are unmonitored straight back.
 *
 * The second is the riskier way round, because between the two calls Sonarr
 * could grab something the user already streams. It is one request wide, it
 * ends the run FAILED if it does not land (the caller collects the throw), and
 * the next sweep unmonitors those episodes again — a monitored episode that is
 * on streaming is exactly what `planItem` unmonitors. The end-of-run search
 * cannot widen it either: that reads the snapshot, where those episodes are
 * still unmonitored.
 */
async function reconcileSeasons(
  client: SonarrClient,
  conn: { name: string },
  s: { id: number; arrId: number; title: string; monitored: boolean },
  plans: SeasonPlan[],
  dryRun: boolean,
  push: Push
) {
  const series = await client.getSeriesById(s.arrId);
  const seasons = series.seasons ?? [];

  // Only a season Sonarr disagrees with is worth writing — and only a real
  // change cascades, so filtering here is also what keeps `correct` honest.
  const wanted = new Map(plans.map((p) => [p.seasonNumber, p.monitored]));
  const changing = plans.filter((p) =>
    seasons.some((sea) => sea.seasonNumber === p.seasonNumber && sea.monitored !== p.monitored)
  );

  // The series flag answers to the seasons this sweep is leaving behind, not
  // the ones it found — otherwise the show it just emptied would have to wait
  // for the next run to be unmonitored, and a show whose seasons it just turned
  // back on would spend that run unable to grab any of them.
  const after = seasons.map((sea) => ({ monitored: wanted.get(sea.seasonNumber) ?? sea.monitored }));
  const wantSeries = planSeriesMonitored(series.status, after);
  const seriesChanging = wantSeries !== null && wantSeries !== series.monitored;

  if (!changing.length && !seriesChanging) return;

  for (const monitored of [false, true] as const) {
    const group = changing.filter((p) => p.monitored === monitored);
    if (!group.length) continue;
    push(
      "action",
      `[${conn.name}] ${dryRun ? "Would mark" : "Mark"} season ` +
        `${group.map((p) => `S${p.seasonNumber}`).join(", ")} of "${s.title}" ` +
        `${monitored ? "monitored" : "unmonitored"} (${SEASON_REASON[`${monitored}`]}).`
    );
  }
  if (seriesChanging) {
    push(
      "action",
      `[${conn.name}] ${dryRun ? "Would mark" : "Mark"} series "${s.title}" ` +
        `${wantSeries ? "monitored" : "unmonitored"} (${SERIES_REASON[`${wantSeries}`]}).`
    );
  }
  if (dryRun) return;

  for (const sea of seasons) {
    const want = wanted.get(sea.seasonNumber);
    if (want !== undefined) sea.monitored = want;
  }
  // One PUT carries both: `monitored` and `seasons[]` live on the same resource,
  // and sending the series flag on its own would mean writing the seasons twice.
  if (seriesChanging) series.monitored = wantSeries;
  await client.updateSeries(series);
  if (seriesChanging) {
    // Unlike the season flags, this one *is* in the snapshot, so it has to move
    // with Sonarr or the dashboard reports the show as the sweep found it.
    await prisma.mediaItem.update({ where: { id: s.id }, data: { monitored: wantSeries } });
  }

  // Repair the cascade. No snapshot write goes with this: these episodes are
  // already recorded at the value being restored, because the sweep either put
  // them there itself or left them alone. A failure therefore shows up as
  // Sonarr and the database disagreeing, which the next sync and sweep settle.
  for (const monitored of [false, true] as const) {
    const ids = changing.filter((p) => p.monitored !== monitored).flatMap((p) => p.correct);
    if (!ids.length) continue;
    push(
      "info",
      `[${conn.name}] Putting ${ids.length} episode(s) of "${s.title}" back to ` +
        `${monitored ? "monitored" : "unmonitored"} after the season change.`
    );
    for (const batch of chunk(ids, BATCH)) {
      await client.setEpisodeMonitored(batch, monitored);
    }
  }
}

async function searchRadarr(
  conn: { id: number; name: string; baseUrl: string; apiKey: string },
  dryRun: boolean,
  counts: RunCounts,
  push: Push,
  arrIds?: number[]
) {
  const client = new RadarrClient(conn.baseUrl, conn.apiKey);
  // `hasFile: false` for the reason planEpisodeSearch spells out: a movie that
  // is already on disk can only be searched for an upgrade, which is not what
  // this run is for. Radarr has no cheaper shape than one search per movie —
  // a movie is one query however it is asked for — so this filter is the whole
  // saving on this side.
  const monitored = await prisma.mediaItem.findMany({
    where: {
      connectionId: conn.id,
      type: "MOVIE",
      monitored: true,
      hasFile: false,
      skipped: false,
      ...arrIdFilter(arrIds),
    },
    select: { arrId: true },
  });
  const ids = monitored.map((m) => m.arrId);
  if (!ids.length) return;
  push("action", `[${conn.name}] Search ${ids.length} monitored movie(s) with no file.`);
  counts.searchedItems += ids.length;
  if (!dryRun) {
    // Chunked for the same reason the episode search is: a whole library's
    // worth of ids in one MoviesSearch command is a request big enough for a
    // proxy in front of Radarr to reject, and every other bulk call this sweep
    // makes is already batched.
    for (const batch of chunk(ids, BATCH)) {
      await client.searchMovies(batch);
    }
  }
}

async function searchSonarr(
  conn: { id: number; name: string; baseUrl: string; apiKey: string },
  dryRun: boolean,
  counts: RunCounts,
  push: Push,
  arrIds?: number[]
) {
  const client = new SonarrClient(conn.baseUrl, conn.apiKey);
  // Every episode of every in-scope series, not only the ones being searched:
  // whether a season may be searched as a season turns on the episodes left
  // *out* of the search as much as on the ones in it. Still a narrow select,
  // for the reason sweepSonarr gives — `streamingInfo` is a JSON blob per row,
  // and none of these decisions read it.
  //
  // Read afresh rather than reusing what sweepSonarr loaded: the sweep has
  // since written its own unmonitors, re-monitors and file deletions to these
  // rows, and searching from the pre-sweep picture would ask Sonarr for
  // episodes it was just told to stop wanting. In a dry-run nothing was
  // written, so what is counted here is the pre-sweep answer — the same
  // approximation every dry-run count carries.
  const series = await prisma.mediaItem.findMany({
    where: { connectionId: conn.id, type: "TV", skipped: false, ...arrIdFilter(arrIds) },
    orderBy: { arrId: "asc" },
    select: {
      arrId: true,
      episodes: {
        // Ordered so a season searched by id lists its episodes in the order
        // they aired; `planEpisodeSearch` puts the seasons themselves in order.
        orderBy: { episodeNumber: "asc" },
        select: {
          arrEpisodeId: true,
          seasonNumber: true,
          monitored: true,
          hasFile: true,
          airDateUtc: true,
        },
      },
    },
  });

  const plan = planEpisodeSearch(series, new Date());
  if (!plan.total) return;
  push(
    "action",
    `[${conn.name}] Search ${plan.total} monitored episode(s) with no file: ` +
      `${plan.seasons.length} season search(es), ${plan.episodeIds.length} episode search(es).`
  );
  // The episodes covered, not the commands sent — a season search stands in for
  // all of its own, and counting commands would read as a collapse in coverage.
  counts.searchedItems += plan.total;
  if (!dryRun) {
    for (const season of plan.seasons) {
      await client.searchSeason(season.arrId, season.seasonNumber);
    }
    // Chunk to avoid overly large command payloads.
    for (const batch of chunk(plan.episodeIds, BATCH)) {
      await client.searchEpisodes(batch);
    }
  }
}
