import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

/**
 * Sweep against a real database, with only the *arr HTTP layer stubbed.
 *
 * `planItem` is unit-tested exhaustively elsewhere; what is exercised here is
 * everything downstream of the decision — the batching, the DB writes that keep
 * the snapshot honest, and the error isolation that decides whether one bad
 * title costs you the rest of the library.
 */

interface ArrCall {
  client: "sonarr" | "radarr";
  method: string;
  args: unknown[];
}

const arrCalls: ArrCall[] = [];
/** Methods set here throw when called, to simulate a failing instance. */
const failing = new Set<string>();
/**
 * Methods parked here block until the test releases them. A sweep body runs
 * detached and a test-sized library is swept in milliseconds, so holding one
 * *arr call open is the only way to catch a run in flight — which is what
 * asking it to stop mid-run requires.
 */
const held = new Map<string, Promise<void>>();
/** The series resource `getSeriesById` reports back. */
interface MockSeries {
  id: number;
  monitored: boolean;
  status: string;
  seasons: { seasonNumber: number; monitored: boolean }[];
}

/**
 * What `getSeriesById` reports, keyed by Sonarr series id. The series flag, its
 * status and season monitoring all live on this one resource, so these tests
 * need a Sonarr with an opinion about it rather than the blanket `undefined`
 * everything else gets.
 */
const sonarrSeries = new Map<number, MockSeries>();

/** A series nothing has been said about: monitored, still running, no seasons. */
const defaultSeries = (id: number): MockSeries => ({
  id,
  monitored: true,
  status: "continuing",
  seasons: [],
});

function record(client: "sonarr" | "radarr", method: string, result?: (args: unknown[]) => unknown) {
  return async (...args: unknown[]) => {
    arrCalls.push({ client, method, args });
    const hold = held.get(`${client}.${method}`);
    if (hold) await hold;
    if (failing.has(`${client}.${method}`)) throw new Error(`${method} failed`);
    return result ? result(args) : undefined;
  };
}

vi.mock("./arr", () => ({
  RadarrClient: class {
    getMovie = record("radarr", "getMovie");
    setMoviesMonitored = record("radarr", "setMoviesMonitored");
    deleteMovieFiles = record("radarr", "deleteMovieFiles");
    deleteMovieFile = record("radarr", "deleteMovieFile");
    deleteMovie = record("radarr", "deleteMovie");
    searchMovies = record("radarr", "searchMovies");
  },
  SonarrClient: class {
    setEpisodeMonitored = record("sonarr", "setEpisodeMonitored");
    deleteEpisodeFiles = record("sonarr", "deleteEpisodeFiles");
    searchEpisodes = record("sonarr", "searchEpisodes");
    getSeriesById = record("sonarr", "getSeriesById", ([id]) =>
      sonarrSeries.get(id as number) ?? defaultSeries(id as number)
    );
    updateSeries = record("sonarr", "updateSeries");
  },
}));

/** How the sweep asked sync to scope itself, for the targeted-sweep tests. */
const syncOptions: unknown[] = [];

// The sweep syncs first; that path has its own tests, so stub it out here.
vi.mock("./sync", () => ({
  runSync: async (_progress: unknown, options: unknown) => (syncOptions.push(options), {
    connections: 1,
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
    errors: [],
  }),
}));

import { prisma } from "@/lib/db";
import { runSweep, runTargetedSweep, type SweepTarget } from "@/lib/sweep";
import { requestRunAbort, ABORT_POLL_MS } from "@/lib/jobs";
import {
  resetDatabase,
  makeSettings,
  makeConnection,
  makeMediaItem,
  makeEpisode,
  waitFor,
} from "@/test/dbHelpers";

beforeEach(async () => {
  await resetDatabase();
  arrCalls.length = 0;
  syncOptions.length = 0;
  failing.clear();
  held.clear();
  sonarrSeries.clear();
});
afterAll(async () => {
  await prisma.$disconnect();
});

/** Wait for a detached run body to settle, then read the row back. */
async function awaitRun(id: number) {
  await waitFor(async () => {
    const run = await prisma.runLog.findUnique({ where: { id } });
    return !!run && run.status !== "RUNNING";
  });
  return prisma.runLog.findUniqueOrThrow({ where: { id } });
}

/** Kick off a sweep and wait for the detached body to settle. */
async function sweepAndWait() {
  return awaitRun(await runSweep());
}

/** Kick off a targeted sweep (the webhook path) and wait for it. */
async function targetedSweepAndWait(targets: SweepTarget[]) {
  return awaitRun(await runTargetedSweep(targets));
}

const callsTo = (method: string) => arrCalls.filter((c) => c.method === method);

describe("sweepRadarr", () => {
  it("unmonitors on-streaming movies in one batched request and updates the snapshot", async () => {
    await makeSettings({ applyChanges: true, deleteFiles: false, searchAtEnd: false });
    const conn = await makeConnection();
    await makeMediaItem(conn.id, { arrId: 1, title: "On Netflix", monitored: true, onStreaming: true });
    await makeMediaItem(conn.id, { arrId: 2, title: "Also On", monitored: true, onStreaming: true });

    const run = await sweepAndWait();
    expect(run.status).toBe("SUCCESS");
    expect(run.unmonitoredMovies).toBe(2);

    // One request for both titles, not one per title.
    const edits = callsTo("setMoviesMonitored");
    expect(edits).toHaveLength(1);
    expect(edits[0].args).toEqual([[1, 2], false]);
    expect(callsTo("getMovie")).toHaveLength(0);

    const rows = await prisma.mediaItem.findMany({ orderBy: { arrId: "asc" } });
    expect(rows.every((r) => !r.monitored)).toBe(true);
  });

  it("re-monitors titles that have left streaming", async () => {
    await makeSettings({ applyChanges: true, searchAtEnd: false });
    const conn = await makeConnection();
    await makeMediaItem(conn.id, { arrId: 3, monitored: false, onStreaming: false });

    const run = await sweepAndWait();
    expect(run.remonitoredMovies).toBe(1);
    expect(callsTo("setMoviesMonitored")[0].args).toEqual([[3], true]);
    expect((await prisma.mediaItem.findFirstOrThrow()).monitored).toBe(true);
  });

  it("deletes files in bulk using the cached file id", async () => {
    await makeSettings({ applyChanges: true, deleteFiles: true, searchAtEnd: false });
    const conn = await makeConnection();
    await makeMediaItem(conn.id, { arrId: 1, monitored: true, onStreaming: true, movieFileId: 11 });
    await makeMediaItem(conn.id, { arrId: 2, monitored: true, onStreaming: true, movieFileId: 12 });

    const run = await sweepAndWait();
    expect(run.deletedFiles).toBe(2);
    expect(callsTo("deleteMovieFiles")).toHaveLength(1);
    expect(callsTo("deleteMovieFiles")[0].args).toEqual([[11, 12]]);

    const rows = await prisma.mediaItem.findMany();
    expect(rows.every((r) => !r.hasFile && r.movieFileId === null)).toBe(true);
  });

  it("falls back to a per-movie lookup when no file id was cached", async () => {
    await makeSettings({ applyChanges: true, deleteFiles: true, searchAtEnd: false });
    const conn = await makeConnection();
    await makeMediaItem(conn.id, { arrId: 5, monitored: true, onStreaming: true, movieFileId: null });

    // The stub resolves undefined, so no file id is found and nothing is deleted
    // — but the sweep must not fall over.
    const run = await sweepAndWait();
    expect(run.status).toBe("SUCCESS");
    expect(callsTo("getMovie")).toHaveLength(1);
  });

  it("removes movies whose TMDB id no longer exists, one at a time", async () => {
    await makeSettings({ applyChanges: true, removeMissingTmdbMovies: true, searchAtEnd: false });
    const conn = await makeConnection();
    await makeMediaItem(conn.id, { arrId: 7, tmdbMissing: true });

    const run = await sweepAndWait();
    expect(run.removedMovies).toBe(1);
    expect(callsTo("deleteMovie")[0].args).toEqual([7]);
    expect(await prisma.mediaItem.count()).toBe(0);
  });

  it("leaves TMDB-missing movies alone when removal is disabled", async () => {
    await makeSettings({ applyChanges: true, removeMissingTmdbMovies: false, searchAtEnd: false });
    const conn = await makeConnection();
    await makeMediaItem(conn.id, { arrId: 7, tmdbMissing: true });

    const run = await sweepAndWait();
    expect(run.removedMovies).toBe(0);
    expect(callsTo("deleteMovie")).toHaveLength(0);
    expect(await prisma.mediaItem.count()).toBe(1);
  });

  it("skips ss-skip titles entirely", async () => {
    await makeSettings({ applyChanges: true, deleteFiles: true, searchAtEnd: false });
    const conn = await makeConnection();
    await makeMediaItem(conn.id, { arrId: 9, monitored: true, onStreaming: true, skipped: true });

    const run = await sweepAndWait();
    expect(run.unmonitoredMovies).toBe(0);
    expect(arrCalls).toHaveLength(0);
    expect((await prisma.mediaItem.findFirstOrThrow()).monitored).toBe(true);
  });
});

describe("dry-run", () => {
  it("counts what it would do and touches neither Radarr nor the snapshot", async () => {
    await makeSettings({ applyChanges: false, deleteFiles: true, searchAtEnd: true });
    const conn = await makeConnection();
    await makeMediaItem(conn.id, { arrId: 1, monitored: true, onStreaming: true, movieFileId: 11 });

    const run = await sweepAndWait();
    expect(run.dryRun).toBe(true);
    expect(run.unmonitoredMovies).toBe(1);
    expect(run.deletedFiles).toBe(1);
    expect(run.searchedItems).toBe(1);
    expect(arrCalls).toHaveLength(0);

    const row = await prisma.mediaItem.findFirstOrThrow();
    expect(row.monitored).toBe(true);
    expect(row.hasFile).toBe(true);
  });
});

describe("sweepSonarr", () => {
  it("batches episode monitoring and file deletion per series", async () => {
    await makeSettings({ applyChanges: true, deleteFiles: true, searchAtEnd: false });
    const conn = await makeConnection({ type: "SONARR", baseUrl: "http://sonarr.test:8989" });
    const show = await makeMediaItem(conn.id, { type: "TV", arrId: 1, title: "Show" });
    await makeEpisode(show.id, { arrEpisodeId: 101, episodeNumber: 1, monitored: true, onStreaming: true, episodeFileId: 901 });
    await makeEpisode(show.id, { arrEpisodeId: 102, episodeNumber: 2, monitored: true, onStreaming: true, episodeFileId: 902 });
    await makeEpisode(show.id, { arrEpisodeId: 103, episodeNumber: 3, monitored: false, onStreaming: false, hasFile: false, episodeFileId: null });

    const run = await sweepAndWait();
    expect(run.unmonitoredEps).toBe(2);
    expect(run.remonitoredEps).toBe(1);
    expect(run.deletedFiles).toBe(2);

    expect(callsTo("setEpisodeMonitored").map((c) => c.args)).toEqual([
      [[101, 102], false],
      [[103], true],
    ]);
    expect(callsTo("deleteEpisodeFiles")).toHaveLength(1);
    expect(callsTo("deleteEpisodeFiles")[0].args).toEqual([[901, 902]]);

    const eps = await prisma.episode.findMany({ orderBy: { arrEpisodeId: "asc" } });
    expect(eps.map((e) => e.monitored)).toEqual([false, false, true]);
    expect(eps.slice(0, 2).every((e) => !e.hasFile && e.episodeFileId === null)).toBe(true);
  });

  it("never re-monitors an episode whose streaming status is unknown", async () => {
    await makeSettings({ applyChanges: true, searchAtEnd: false });
    const conn = await makeConnection({ type: "SONARR" });
    const show = await makeMediaItem(conn.id, { type: "TV", arrId: 1 });
    await makeEpisode(show.id, {
      arrEpisodeId: 201,
      monitored: false,
      onStreaming: false,
      streamingUnknown: true,
    });

    const run = await sweepAndWait();
    expect(run.remonitoredEps).toBe(0);
    // Nothing about the episode is touched. The season is still read, because
    // that decision turns on how Sonarr has the episodes monitored — a fact —
    // rather than on a streaming answer we did not get.
    expect(callsTo("setEpisodeMonitored")).toHaveLength(0);
    expect(callsTo("deleteEpisodeFiles")).toHaveLength(0);
    expect(callsTo("updateSeries")).toHaveLength(0);
  });

  it("purges files for a pre-existing unmonitored back-catalogue when asked", async () => {
    await makeSettings({
      applyChanges: true,
      deleteFiles: false,
      purgeUnmonitoredFiles: true,
      searchAtEnd: false,
    });
    const conn = await makeConnection({ type: "SONARR" });
    const show = await makeMediaItem(conn.id, { type: "TV", arrId: 1 });
    // Unmonitored, on streaming (so it stays unmonitored), and holding a file.
    await makeEpisode(show.id, {
      arrEpisodeId: 301,
      monitored: false,
      onStreaming: true,
      episodeFileId: 950,
    });

    const run = await sweepAndWait();
    expect(run.deletedFiles).toBe(1);
    expect(callsTo("deleteEpisodeFiles")[0].args).toEqual([[950]]);
  });
});

describe("sweepSonarr — season monitoring", () => {
  const PAST = new Date("2020-01-01T00:00:00Z");
  const FUTURE = new Date("2099-01-01T00:00:00Z");

  /** A Sonarr that reports `seasons` as monitored for series `arrId`. */
  const sonarrHasSeasons = (arrId: number, ...seasons: number[]) =>
    sonarrSeries.set(arrId, {
      ...defaultSeries(arrId),
      seasons: seasons.map((seasonNumber) => ({ seasonNumber, monitored: true })),
    });

  /** The same, with the seasons already unmonitored — the on-write's starting point. */
  const sonarrHasOffSeasons = (arrId: number, ...seasons: number[]) =>
    sonarrSeries.set(arrId, {
      ...defaultSeries(arrId),
      seasons: seasons.map((seasonNumber) => ({ seasonNumber, monitored: false })),
    });

  /** The series resource sent back in the one updateSeries call. */
  const put = () => callsTo("updateSeries")[0].args[0] as MockSeries;

  /** The seasons array on it. */
  const putSeasons = () => put().seasons;

  it("marks a season unmonitored once the sweep has unmonitored its whole run", async () => {
    await makeSettings({ applyChanges: true, deleteFiles: false, searchAtEnd: false });
    const conn = await makeConnection({ type: "SONARR" });
    const show = await makeMediaItem(conn.id, { type: "TV", arrId: 7, title: "Show" });
    await makeEpisode(show.id, { arrEpisodeId: 101, episodeNumber: 1, monitored: true, onStreaming: true });
    await makeEpisode(show.id, { arrEpisodeId: 102, episodeNumber: 2, monitored: true, onStreaming: true });
    sonarrHasSeasons(7, 1);

    const run = await sweepAndWait();
    expect(run.status).toBe("SUCCESS");
    expect(putSeasons()).toEqual([{ seasonNumber: 1, monitored: false }]);
    // The season is settled after the episodes, never instead of them.
    expect(callsTo("setEpisodeMonitored")[0].args).toEqual([[101, 102], false]);
  });

  it("leaves the season alone while one aired episode is still monitored", async () => {
    await makeSettings({ applyChanges: true, searchAtEnd: false });
    const conn = await makeConnection({ type: "SONARR" });
    const show = await makeMediaItem(conn.id, { type: "TV", arrId: 7 });
    await makeEpisode(show.id, { arrEpisodeId: 101, episodeNumber: 1, monitored: false, onStreaming: true });
    // Not on streaming and monitored, so the sweep leaves it monitored.
    await makeEpisode(show.id, { arrEpisodeId: 102, episodeNumber: 2, monitored: true, onStreaming: false });
    sonarrHasSeasons(7, 1);

    await sweepAndWait();
    expect(callsTo("updateSeries")).toHaveLength(0);
  });

  it("puts back the unaired episodes Sonarr's cascade clears", async () => {
    await makeSettings({ applyChanges: true, searchAtEnd: false });
    const conn = await makeConnection({ type: "SONARR" });
    const show = await makeMediaItem(conn.id, { type: "TV", arrId: 7 });
    await makeEpisode(show.id, { arrEpisodeId: 101, episodeNumber: 1, monitored: true, onStreaming: true, airDateUtc: PAST });
    // Still to air, monitored so Sonarr grabs it — the season write would
    // otherwise unmonitor it along with the rest of the season.
    await makeEpisode(show.id, { arrEpisodeId: 102, episodeNumber: 2, monitored: true, onStreaming: false, airDateUtc: FUTURE });
    sonarrHasSeasons(7, 1);

    await sweepAndWait();
    expect(putSeasons()).toEqual([{ seasonNumber: 1, monitored: false }]);

    // Order matters: the restore has to land *after* the season write, or the
    // cascade would simply clear it again.
    const sonarrCalls = arrCalls.filter((c) => c.client === "sonarr");
    const restoreAt = sonarrCalls.map((c) => c.method).lastIndexOf("setEpisodeMonitored");
    expect(restoreAt).toBeGreaterThan(sonarrCalls.map((c) => c.method).indexOf("updateSeries"));
    expect(sonarrCalls[restoreAt].args).toEqual([[102], true]);
    // And the snapshot still has it monitored, because it ends up monitored.
    const future = await prisma.episode.findFirstOrThrow({ where: { arrEpisodeId: 102 } });
    expect(future.monitored).toBe(true);
  });

  it("writes nothing when Sonarr already has the season unmonitored", async () => {
    await makeSettings({ applyChanges: true, searchAtEnd: false });
    const conn = await makeConnection({ type: "SONARR" });
    const show = await makeMediaItem(conn.id, { type: "TV", arrId: 7 });
    await makeEpisode(show.id, { arrEpisodeId: 101, monitored: false, onStreaming: true });
    sonarrSeries.set(7, {
      ...defaultSeries(7),
      seasons: [{ seasonNumber: 1, monitored: false }],
    });

    await sweepAndWait();
    expect(callsTo("getSeriesById")).toHaveLength(1);
    expect(callsTo("updateSeries")).toHaveLength(0);
  });

  it("changes only the qualifying seasons of a series", async () => {
    await makeSettings({ applyChanges: true, searchAtEnd: false });
    const conn = await makeConnection({ type: "SONARR" });
    const show = await makeMediaItem(conn.id, { type: "TV", arrId: 7 });
    await makeEpisode(show.id, { arrEpisodeId: 101, seasonNumber: 1, monitored: true, onStreaming: true });
    await makeEpisode(show.id, { arrEpisodeId: 201, seasonNumber: 2, monitored: true, onStreaming: false });
    sonarrHasSeasons(7, 1, 2);

    await sweepAndWait();
    expect(putSeasons()).toEqual([
      { seasonNumber: 1, monitored: false },
      { seasonNumber: 2, monitored: true },
    ]);
  });

  it("previews the season change in a dry-run without writing it", async () => {
    await makeSettings({ applyChanges: false, searchAtEnd: false });
    const conn = await makeConnection({ type: "SONARR" });
    const show = await makeMediaItem(conn.id, { type: "TV", arrId: 7, title: "Show" });
    await makeEpisode(show.id, { arrEpisodeId: 101, monitored: true, onStreaming: true });
    sonarrHasSeasons(7, 1);

    const run = await sweepAndWait();
    expect(callsTo("updateSeries")).toHaveLength(0);
    expect(callsTo("setEpisodeMonitored")).toHaveLength(0);
    const lines = (run.log as { level: string; msg: string }[]).map((l) => l.msg);
    expect(lines.some((m) => m.includes('Would mark season S1 of "Show" unmonitored'))).toBe(true);
  });

  it("marks a season monitored again once the sweep re-monitors an episode in it", async () => {
    await makeSettings({ applyChanges: true, searchAtEnd: false });
    const conn = await makeConnection({ type: "SONARR" });
    const show = await makeMediaItem(conn.id, { type: "TV", arrId: 7, title: "Show" });
    // Left streaming, so the sweep re-monitors it.
    await makeEpisode(show.id, { arrEpisodeId: 101, monitored: false, onStreaming: false });
    sonarrHasOffSeasons(7, 1);

    const run = await sweepAndWait();
    expect(run.status).toBe("SUCCESS");
    expect(run.remonitoredEps).toBe(1);
    expect(putSeasons()).toEqual([{ seasonNumber: 1, monitored: true }]);
  });

  it("keeps the still-streaming episodes unmonitored when it turns a season on", async () => {
    await makeSettings({ applyChanges: true, deleteFiles: false, searchAtEnd: false });
    const conn = await makeConnection({ type: "SONARR" });
    const show = await makeMediaItem(conn.id, { type: "TV", arrId: 7, title: "Show" });
    // One episode left streaming and comes back; the other is still on it.
    await makeEpisode(show.id, { arrEpisodeId: 101, monitored: false, onStreaming: false });
    await makeEpisode(show.id, { arrEpisodeId: 102, monitored: false, onStreaming: true });
    sonarrHasOffSeasons(7, 1);

    await sweepAndWait();
    expect(putSeasons()).toEqual([{ seasonNumber: 1, monitored: true }]);

    // Sonarr's cascade monitors the whole season, so 102 has to be put back —
    // after the season write, or it would simply be flattened again.
    const sonarrCalls = arrCalls.filter((c) => c.client === "sonarr");
    const methods = sonarrCalls.map((c) => c.method);
    expect(methods.lastIndexOf("setEpisodeMonitored")).toBeGreaterThan(methods.indexOf("updateSeries"));
    expect(sonarrCalls[methods.lastIndexOf("setEpisodeMonitored")].args).toEqual([[102], false]);

    // The snapshot already had it unmonitored and still does.
    const streaming = await prisma.episode.findFirstOrThrow({ where: { arrEpisodeId: 102 } });
    expect(streaming.monitored).toBe(false);
  });

  it("turns a stale season on even when this sweep changed no episode", async () => {
    await makeSettings({ applyChanges: true, searchAtEnd: false });
    const conn = await makeConnection({ type: "SONARR" });
    const show = await makeMediaItem(conn.id, { type: "TV", arrId: 7 });
    // Monitored and not on streaming, so the sweep leaves the episode alone.
    // The season flag still disagrees with it, and that is what gets fixed.
    await makeEpisode(show.id, { arrEpisodeId: 101, monitored: true, onStreaming: false });
    sonarrHasOffSeasons(7, 1);

    await sweepAndWait();
    expect(putSeasons()).toEqual([{ seasonNumber: 1, monitored: true }]);
    expect(callsTo("setEpisodeMonitored")).toHaveLength(0);
  });

  it("writes nothing when Sonarr already has a monitored season monitored", async () => {
    // The steady state for most of a library: one read, no write, no churn.
    await makeSettings({ applyChanges: true, searchAtEnd: false });
    const conn = await makeConnection({ type: "SONARR" });
    const show = await makeMediaItem(conn.id, { type: "TV", arrId: 7 });
    await makeEpisode(show.id, { arrEpisodeId: 101, monitored: true, onStreaming: false });
    sonarrHasSeasons(7, 1);

    await sweepAndWait();
    expect(callsTo("getSeriesById")).toHaveLength(1);
    expect(callsTo("updateSeries")).toHaveLength(0);
  });

  it("settles a series with one season going off and another coming on", async () => {
    await makeSettings({ applyChanges: true, deleteFiles: false, searchAtEnd: false });
    const conn = await makeConnection({ type: "SONARR" });
    const show = await makeMediaItem(conn.id, { type: "TV", arrId: 7, title: "Show" });
    await makeEpisode(show.id, { arrEpisodeId: 101, seasonNumber: 1, monitored: true, onStreaming: true });
    await makeEpisode(show.id, { arrEpisodeId: 201, seasonNumber: 2, monitored: false, onStreaming: false });
    sonarrSeries.set(7, {
      ...defaultSeries(7),
      seasons: [
        { seasonNumber: 1, monitored: true },
        { seasonNumber: 2, monitored: false },
      ],
    });

    const run = await sweepAndWait();
    expect(run.status).toBe("SUCCESS");
    expect(putSeasons()).toEqual([
      { seasonNumber: 1, monitored: false },
      { seasonNumber: 2, monitored: true },
    ]);
  });

  it("unmonitors an ended show once its last season goes", async () => {
    await makeSettings({ applyChanges: true, deleteFiles: false, searchAtEnd: false });
    const conn = await makeConnection({ type: "SONARR" });
    const show = await makeMediaItem(conn.id, { type: "TV", arrId: 7, title: "Show", monitored: true });
    await makeEpisode(show.id, { arrEpisodeId: 101, monitored: true, onStreaming: true });
    sonarrSeries.set(7, {
      id: 7,
      monitored: true,
      status: "ended",
      seasons: [{ seasonNumber: 1, monitored: true }],
    });

    const run = await sweepAndWait();
    expect(run.status).toBe("SUCCESS");
    // The season this sweep is turning off counts towards "every season is
    // unmonitored" — waiting for the next run would be a wasted pass.
    expect(putSeasons()).toEqual([{ seasonNumber: 1, monitored: false }]);
    expect(put().monitored).toBe(false);
    // One PUT carries both flags.
    expect(callsTo("updateSeries")).toHaveLength(1);
    // And the snapshot follows, because the dashboard reads it.
    expect((await prisma.mediaItem.findFirstOrThrow({ where: { arrId: 7 } })).monitored).toBe(false);
  });

  it("unmonitors an ended show whose seasons were already off", async () => {
    // The upgrade case: a previous release turned the seasons off, and there is
    // no episode change left to hang the series decision on.
    await makeSettings({ applyChanges: true, searchAtEnd: false });
    const conn = await makeConnection({ type: "SONARR" });
    const show = await makeMediaItem(conn.id, { type: "TV", arrId: 7, title: "Show", monitored: true });
    await makeEpisode(show.id, { arrEpisodeId: 101, monitored: false, onStreaming: true });
    sonarrSeries.set(7, {
      id: 7,
      monitored: true,
      status: "ended",
      seasons: [{ seasonNumber: 1, monitored: false }],
    });

    await sweepAndWait();
    expect(put().monitored).toBe(false);
    expect(putSeasons()).toEqual([{ seasonNumber: 1, monitored: false }]);
  });

  it("leaves a continuing show monitored however spent its seasons are", async () => {
    await makeSettings({ applyChanges: true, searchAtEnd: false });
    const conn = await makeConnection({ type: "SONARR" });
    const show = await makeMediaItem(conn.id, { type: "TV", arrId: 7, title: "Show", monitored: true });
    await makeEpisode(show.id, { arrEpisodeId: 101, monitored: false, onStreaming: true });
    sonarrSeries.set(7, {
      id: 7,
      monitored: true,
      status: "continuing",
      seasons: [{ seasonNumber: 1, monitored: false }],
    });

    await sweepAndWait();
    expect(callsTo("updateSeries")).toHaveLength(0);
    expect((await prisma.mediaItem.findFirstOrThrow({ where: { arrId: 7 } })).monitored).toBe(true);
  });

  it("keeps an ended show whose specials are still monitored", async () => {
    await makeSettings({ applyChanges: true, searchAtEnd: false });
    const conn = await makeConnection({ type: "SONARR" });
    const show = await makeMediaItem(conn.id, { type: "TV", arrId: 7, title: "Show", monitored: true });
    await makeEpisode(show.id, { arrEpisodeId: 101, monitored: false, onStreaming: true });
    sonarrSeries.set(7, {
      id: 7,
      monitored: true,
      status: "ended",
      // Sync never records season 0's episodes, but Sonarr still reports its
      // flag — and someone monitoring specials wants specials.
      seasons: [
        { seasonNumber: 0, monitored: true },
        { seasonNumber: 1, monitored: false },
      ],
    });

    await sweepAndWait();
    expect(callsTo("updateSeries")).toHaveLength(0);
  });

  it("puts an ended show back on when a season comes back", async () => {
    // The trap the on-direction closes: without it the re-monitored season
    // would never be grabbed, because Sonarr checks the series flag first.
    await makeSettings({ applyChanges: true, searchAtEnd: false });
    const conn = await makeConnection({ type: "SONARR" });
    const show = await makeMediaItem(conn.id, { type: "TV", arrId: 7, title: "Show", monitored: false });
    await makeEpisode(show.id, { arrEpisodeId: 101, monitored: false, onStreaming: false });
    sonarrSeries.set(7, {
      id: 7,
      monitored: false,
      status: "ended",
      seasons: [{ seasonNumber: 1, monitored: false }],
    });

    const run = await sweepAndWait();
    expect(run.remonitoredEps).toBe(1);
    expect(putSeasons()).toEqual([{ seasonNumber: 1, monitored: true }]);
    expect(put().monitored).toBe(true);
    expect((await prisma.mediaItem.findFirstOrThrow({ where: { arrId: 7 } })).monitored).toBe(true);
  });

  it("previews the series change in a dry-run without writing it", async () => {
    await makeSettings({ applyChanges: false, searchAtEnd: false });
    const conn = await makeConnection({ type: "SONARR" });
    const show = await makeMediaItem(conn.id, { type: "TV", arrId: 7, title: "Show", monitored: true });
    await makeEpisode(show.id, { arrEpisodeId: 101, monitored: true, onStreaming: true });
    sonarrSeries.set(7, {
      id: 7,
      monitored: true,
      status: "ended",
      seasons: [{ seasonNumber: 1, monitored: true }],
    });

    const run = await sweepAndWait();
    expect(callsTo("updateSeries")).toHaveLength(0);
    const lines = (run.log as { level: string; msg: string }[]).map((l) => l.msg);
    expect(lines.some((m) => m.includes('Would mark series "Show" unmonitored'))).toBe(true);
    expect((await prisma.mediaItem.findFirstOrThrow({ where: { arrId: 7 } })).monitored).toBe(true);
  });

  it("says nothing about a series Sonarr lists no seasons for", async () => {
    // Not a spent library — a series Sonarr has not finished building.
    await makeSettings({ applyChanges: true, searchAtEnd: false });
    const conn = await makeConnection({ type: "SONARR" });
    const show = await makeMediaItem(conn.id, { type: "TV", arrId: 7, title: "Show", monitored: true });
    await makeEpisode(show.id, { arrEpisodeId: 101, monitored: false, onStreaming: true });
    sonarrSeries.set(7, { id: 7, monitored: true, status: "ended", seasons: [] });

    await sweepAndWait();
    expect(callsTo("updateSeries")).toHaveLength(0);
  });

  it("keeps sweeping the rest of the library when a season write fails", async () => {
    await makeSettings({ applyChanges: true, searchAtEnd: false });
    const conn = await makeConnection({ type: "SONARR" });
    const a = await makeMediaItem(conn.id, { type: "TV", arrId: 7, title: "Broken" });
    await makeEpisode(a.id, { arrEpisodeId: 101, monitored: true, onStreaming: true });
    const b = await makeMediaItem(conn.id, { type: "TV", arrId: 8, title: "Fine" });
    await makeEpisode(b.id, { arrEpisodeId: 201, monitored: true, onStreaming: true });
    sonarrHasSeasons(7, 1);
    sonarrHasSeasons(8, 1);
    failing.add("sonarr.updateSeries");

    const run = await sweepAndWait();
    expect(run.status).toBe("FAILED");
    // Both series were still attempted, and the episode work stands.
    expect(callsTo("updateSeries")).toHaveLength(2);
    expect(run.unmonitoredEps).toBe(2);
    expect(run.error).toContain('update seasons of "Broken"');
  });
});

describe("error isolation", () => {
  it("keeps sweeping other connections when one instance fails", async () => {
    await makeSettings({ applyChanges: true, searchAtEnd: false });
    const radarr = await makeConnection({ type: "RADARR", baseUrl: "http://r:7878" });
    const sonarr = await makeConnection({ type: "SONARR", baseUrl: "http://s:8989" });
    await makeMediaItem(radarr.id, { arrId: 1, monitored: true, onStreaming: true });
    const show = await makeMediaItem(sonarr.id, { type: "TV", arrId: 2 });
    await makeEpisode(show.id, { arrEpisodeId: 401, monitored: true, onStreaming: true });

    failing.add("radarr.setMoviesMonitored");

    const run = await sweepAndWait();

    // Radarr's failure is reported…
    expect(run.status).toBe("FAILED");
    expect(run.error).toMatch(/setMoviesMonitored failed/);
    // …but Sonarr was still swept, and its snapshot updated.
    expect(callsTo("setEpisodeMonitored")).toHaveLength(1);
    expect((await prisma.episode.findFirstOrThrow()).monitored).toBe(false);
  });

  it("still searches at the end after a sweep failure", async () => {
    await makeSettings({ applyChanges: true, searchAtEnd: true });
    const conn = await makeConnection();
    await makeMediaItem(conn.id, { arrId: 1, monitored: true, onStreaming: true });
    failing.add("radarr.setMoviesMonitored");

    await sweepAndWait();
    // The movie stayed monitored (the edit failed), so it is still searchable.
    expect(callsTo("searchMovies")).toHaveLength(1);
  });

  it("records a summary naming the failures, and does not claim success", async () => {
    await makeSettings({ applyChanges: true, deleteFiles: true, searchAtEnd: false });
    const conn = await makeConnection();
    await makeMediaItem(conn.id, { arrId: 1, monitored: true, onStreaming: true, movieFileId: 11 });
    failing.add("radarr.setMoviesMonitored");
    failing.add("radarr.deleteMovieFiles");

    const run = await sweepAndWait();
    expect(run.status).toBe("FAILED");
    expect(run.error).toMatch(/2 error\(s\)/);
    const lines = (run.log as { level: string; msg: string }[]).map((l) => l.msg);
    expect(lines.some((m) => m.includes("setMoviesMonitored failed"))).toBe(true);
    expect(lines.some((m) => m.includes("deleteMovieFiles failed"))).toBe(true);
  });
});

describe("targeted sweep", () => {
  it("acts on the named movie and leaves the rest of the library alone", async () => {
    await makeSettings({ applyChanges: true, deleteFiles: true, searchAtEnd: false });
    const conn = await makeConnection();
    await makeMediaItem(conn.id, {
      arrId: 1,
      title: "Just Added",
      monitored: true,
      onStreaming: true,
      movieFileId: 11,
    });
    // Equally sweepable, but nobody asked about it.
    await makeMediaItem(conn.id, {
      arrId: 2,
      title: "Untouched",
      monitored: true,
      onStreaming: true,
      movieFileId: 12,
    });

    const run = await targetedSweepAndWait([
      { connectionId: conn.id, type: "MOVIE", arrId: 1, title: "Just Added" },
    ]);

    expect(run.status).toBe("SUCCESS");
    expect(run.unmonitoredMovies).toBe(1);
    expect(callsTo("setMoviesMonitored")[0].args).toEqual([[1], false]);
    expect(callsTo("deleteMovieFiles")[0].args).toEqual([[11]]);

    const untouched = await prisma.mediaItem.findFirstOrThrow({ where: { arrId: 2 } });
    expect(untouched.monitored).toBe(true);
    expect(untouched.hasFile).toBe(true);
  });

  it("tells sync which titles to refresh, and to ignore its freshness windows", async () => {
    await makeSettings({ applyChanges: true, searchAtEnd: false });
    const conn = await makeConnection();
    await makeMediaItem(conn.id, { arrId: 1, monitored: true, onStreaming: true });

    await targetedSweepAndWait([
      { connectionId: conn.id, type: "MOVIE", arrId: 1, title: "Just Added" },
    ]);

    // toMatchObject, not toEqual: the sweep also hands sync its abort check,
    // which is not what this test is about.
    expect(syncOptions[0]).toMatchObject({
      targets: [{ connectionId: conn.id, type: "MOVIE", arrId: 1 }],
      force: true,
    });
  });

  it("gives sync a way to be stopped, on a full sweep as well as a targeted one", async () => {
    await makeSettings({ applyChanges: true, searchAtEnd: false });
    const conn = await makeConnection();
    await makeMediaItem(conn.id, { arrId: 1, monitored: true, onStreaming: true });

    await sweepAndWait();
    await targetedSweepAndWait([
      { connectionId: conn.id, type: "MOVIE", arrId: 1, title: "Just Added" },
    ]);

    // The sync phase is the long half of a sweep, so "Abort" that only took
    // effect once it was over would be no use on the run most worth stopping.
    for (const options of syncOptions) {
      expect((options as { checkAbort?: unknown }).checkAbort).toBeTypeOf("function");
    }
  });

  it("searches only the titles it covered", async () => {
    await makeSettings({ applyChanges: true, deleteFiles: false, searchAtEnd: true });
    const conn = await makeConnection();
    await makeMediaItem(conn.id, { arrId: 1, title: "Wanted", monitored: true, onStreaming: false });
    await makeMediaItem(conn.id, { arrId: 2, title: "Other", monitored: true, onStreaming: false });

    const run = await targetedSweepAndWait([
      { connectionId: conn.id, type: "MOVIE", arrId: 1, title: "Wanted" },
    ]);

    expect(run.searchedItems).toBe(1);
    expect(callsTo("searchMovies")[0].args).toEqual([[1]]);
  });

  it("skips connections none of the targets live on", async () => {
    await makeSettings({ applyChanges: true, searchAtEnd: true });
    const radarr = await makeConnection({ type: "RADARR", baseUrl: "http://r:7878" });
    const sonarr = await makeConnection({ type: "SONARR", baseUrl: "http://s:8989" });
    const show = await makeMediaItem(sonarr.id, { type: "TV", arrId: 9 });
    await makeEpisode(show.id, { arrEpisodeId: 901, monitored: true, onStreaming: true });
    await makeMediaItem(radarr.id, { arrId: 1, monitored: true, onStreaming: true });

    const run = await targetedSweepAndWait([
      { connectionId: sonarr.id, type: "TV", arrId: 9, title: "New Show" },
    ]);

    expect(run.unmonitoredEps).toBe(1);
    expect(run.unmonitoredMovies).toBe(0);
    // Nothing at all was asked of Radarr — not even the end-of-run search.
    expect(arrCalls.every((c) => c.client === "sonarr")).toBe(true);
  });

  it("sweeps several newly added titles in one run", async () => {
    await makeSettings({ applyChanges: true, deleteFiles: false, searchAtEnd: false });
    const conn = await makeConnection();
    await makeMediaItem(conn.id, { arrId: 1, monitored: true, onStreaming: true });
    await makeMediaItem(conn.id, { arrId: 2, monitored: true, onStreaming: true });
    await makeMediaItem(conn.id, { arrId: 3, monitored: true, onStreaming: true });

    const run = await targetedSweepAndWait([
      { connectionId: conn.id, type: "MOVIE", arrId: 1, title: "One" },
      { connectionId: conn.id, type: "MOVIE", arrId: 3, title: "Three" },
    ]);

    expect(run.unmonitoredMovies).toBe(2);
    expect(callsTo("setMoviesMonitored")[0].args).toEqual([[1, 3], false]);
    expect((await prisma.mediaItem.findFirstOrThrow({ where: { arrId: 2 } })).monitored).toBe(true);
  });

  it("says so when Sonarr has not built the episode list yet", async () => {
    await makeSettings({ applyChanges: true, searchAtEnd: false });
    const conn = await makeConnection({ type: "SONARR" });
    await makeMediaItem(conn.id, { type: "TV", arrId: 9, title: "Brand New" });

    const run = await targetedSweepAndWait([
      { connectionId: conn.id, type: "TV", arrId: 9, title: "Brand New" },
    ]);

    expect(run.status).toBe("SUCCESS");
    const lines = (run.log as { level: string; msg: string }[]).map((l) => l.msg);
    expect(lines.some((m) => m.includes("has no episodes in Sonarr yet"))).toBe(true);
  });

  it("opens the run log by naming what it is sweeping and why", async () => {
    await makeSettings({ applyChanges: true, searchAtEnd: false });
    const conn = await makeConnection();
    await makeMediaItem(conn.id, { arrId: 1, monitored: true, onStreaming: true });

    const run = await targetedSweepAndWait([
      { connectionId: conn.id, type: "MOVIE", arrId: 1, title: "Just Added" },
    ]);

    const first = (run.log as { msg: string }[])[0].msg;
    expect(first).toContain("webhook-triggered");
    expect(first).toContain('"Just Added"');
  });

  it("reports the outcome to the caller once the detached body is done", async () => {
    await makeSettings({ applyChanges: true, searchAtEnd: false });
    const conn = await makeConnection();
    await makeMediaItem(conn.id, { arrId: 1, monitored: true, onStreaming: true });

    const outcomes: { ok: boolean }[] = [];
    const id = await runTargetedSweep(
      [{ connectionId: conn.id, type: "MOVIE", arrId: 1, title: "Just Added" }],
      { onFinished: async (o) => void outcomes.push(o) }
    );
    await awaitRun(id);
    await waitFor(async () => outcomes.length > 0);
    expect(outcomes[0].ok).toBe(true);

    // A sweep that hit item failures is reported as a failure, so the queue can
    // decide whether the titles are worth another attempt.
    failing.add("radarr.setMoviesMonitored");
    await prisma.mediaItem.updateMany({ data: { monitored: true } });
    const second = await runTargetedSweep(
      [{ connectionId: conn.id, type: "MOVIE", arrId: 1, title: "Just Added" }],
      { onFinished: async (o) => void outcomes.push(o) }
    );
    await awaitRun(second);
    await waitFor(async () => outcomes.length > 1);
    expect(outcomes[1].ok).toBe(false);
  });

  it("refuses a targeted sweep with nothing to target", async () => {
    await makeSettings();
    await expect(runTargetedSweep([])).rejects.toThrow(/at least one title/);
  });
});

describe("aborting a sweep in flight", () => {
  it("stops at the next title instead of filing the abort as an item failure", async () => {
    await makeSettings({ applyChanges: true, removeMissingTmdbMovies: true, searchAtEnd: true });
    const conn = await makeConnection();
    // The first title takes the one-at-a-time removal path, which runs inside
    // ErrorCollector.attempt — so the abort is noticed where every other error
    // is recorded and swallowed. If it were swallowed too, the sweep would carry
    // straight on to the second title.
    await makeMediaItem(conn.id, { arrId: 7, title: "Gone from TMDB", tmdbMissing: true });
    await makeMediaItem(conn.id, { arrId: 8, title: "On Netflix", monitored: true, onStreaming: true });

    let release!: () => void;
    held.set("radarr.deleteMovie", new Promise<void>((r) => (release = r)));

    const id = await runSweep();
    await waitFor(async () => callsTo("deleteMovie").length === 1);
    expect(await requestRunAbort(id)).toEqual({ status: "requested" });
    // Checkpoints poll no more often than this, so the next one to actually look
    // is the first one this far past the last.
    await new Promise((r) => setTimeout(r, ABORT_POLL_MS + 200));
    release();

    const run = await awaitRun(id);
    expect(run.status).toBe("ABORTED");
    expect(run.error).toMatch(/stopped from the runs page/i);
    // The abort travelled past the collector rather than being logged as one
    // more broken title and counted into a partial-failure summary.
    expect(run.error).not.toMatch(/error\(s\)/i);

    // The first title's removal stands; the second was never touched, and the
    // end-of-run search — several checkpoints later — never started.
    expect(run.removedMovies).toBe(1);
    expect(callsTo("setMoviesMonitored")).toHaveLength(0);
    expect(callsTo("searchMovies")).toHaveLength(0);
    expect(await prisma.mediaItem.findFirst({ where: { arrId: 8 } })).toMatchObject({
      monitored: true,
    });
  });

  it("drops the queued titles of an aborted webhook sweep instead of re-queueing them", async () => {
    // Releasing the claim would put them straight back, and the queue worker
    // would start the very sweep the admin just stopped.
    await makeSettings({ applyChanges: true, removeMissingTmdbMovies: true, searchAtEnd: false });
    const conn = await makeConnection();
    await makeMediaItem(conn.id, { arrId: 7, title: "Gone from TMDB", tmdbMissing: true });
    await makeMediaItem(conn.id, { arrId: 8, title: "On Netflix", monitored: true, onStreaming: true });

    const outcomes: { ok: boolean; error?: Error }[] = [];
    let release!: () => void;
    held.set("radarr.deleteMovie", new Promise<void>((r) => (release = r)));

    const id = await runTargetedSweep(
      [
        { connectionId: conn.id, type: "MOVIE", arrId: 7, title: "Gone from TMDB" },
        { connectionId: conn.id, type: "MOVIE", arrId: 8, title: "On Netflix" },
      ],
      { onFinished: async (o) => void outcomes.push(o) }
    );
    await waitFor(async () => callsTo("deleteMovie").length === 1);
    await requestRunAbort(id);
    await new Promise((r) => setTimeout(r, ABORT_POLL_MS + 200));
    release();

    expect((await awaitRun(id)).status).toBe("ABORTED");
    await waitFor(async () => outcomes.length > 0);
    // The queue is told it failed — and told *why*, which is what lets it tell
    // "stopped on purpose" apart from "this sweep is worth another go".
    expect(outcomes[0].ok).toBe(false);
    expect(outcomes[0].error?.name).toBe("RunAbortedError");
  });
});
