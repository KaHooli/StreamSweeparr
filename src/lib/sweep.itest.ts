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

function record(client: "sonarr" | "radarr", method: string) {
  return async (...args: unknown[]) => {
    arrCalls.push({ client, method, args });
    if (failing.has(`${client}.${method}`)) throw new Error(`${method} failed`);
    return undefined;
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
  },
}));

// The sweep syncs first; that path has its own tests, so stub it out here.
vi.mock("./sync", () => ({
  runSync: async () => ({
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
import { runSweep } from "@/lib/sweep";
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
  failing.clear();
});
afterAll(async () => {
  await prisma.$disconnect();
});

/** Kick off a sweep and wait for the detached body to settle. */
async function sweepAndWait() {
  const id = await runSweep();
  await waitFor(async () => {
    const run = await prisma.runLog.findUnique({ where: { id } });
    return !!run && run.status !== "RUNNING";
  });
  return prisma.runLog.findUniqueOrThrow({ where: { id } });
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
    expect(arrCalls).toHaveLength(0);
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
