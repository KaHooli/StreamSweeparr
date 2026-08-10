import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

/**
 * Sync against a real database with the provider HTTP layer stubbed.
 *
 * The interesting behaviour is all persistence-shaped and invisible to a unit
 * test: which titles get pruned, which lookups are skipped as still fresh, and
 * what a failed lookup leaves behind in the snapshot (a wrong answer here makes
 * the sweep re-monitor a library).
 */

let radarrMovies: unknown[] = [];
let sonarrSeries: unknown[] = [];
let sonarrEpisodes: Record<number, unknown[]> = {};
/** tmdbId -> availability, or the string "404" / "error" to fail the lookup. */
let tmdbAvailability: Record<number, unknown> = {};
let tmdbCalls: number[] = [];
/** How often the whole Radarr library was listed — a scoped sync must not. */
let radarrListCalls = 0;

class TmdbNotFound extends Error {
  status = 404;
}

vi.mock("./arr", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./arr")>();
  return {
    ...actual,
    RadarrClient: class {
      async getMovies() {
        radarrListCalls++;
        return radarrMovies;
      }
      async getMovie(id: number) {
        return byId(radarrMovies, id, actual.ArrError);
      }
      async getTags() {
        return [{ id: 1, label: "ss-skip" }];
      }
    },
    SonarrClient: class {
      async getSeries() {
        return sonarrSeries;
      }
      async getSeriesById(id: number) {
        return byId(sonarrSeries, id, actual.ArrError);
      }
      async getTags() {
        return [{ id: 1, label: "ss-skip" }];
      }
      async getEpisodes(seriesId: number) {
        return sonarrEpisodes[seriesId] ?? [];
      }
    },
  };
});

/** A scoped sync asks for one title at a time; an unknown id is a 404. */
function byId(
  items: unknown[],
  id: number,
  ArrErrorClass: new (message: string, status?: number) => Error
) {
  const found = items.find((i) => (i as { id: number }).id === id);
  if (!found) throw new ArrErrorClass(`no such title ${id}`, 404);
  return found;
}

vi.mock("./tmdb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tmdb")>();
  return {
    ...actual,
    isTmdbNotFound: (e: unknown) => e instanceof TmdbNotFound,
    TmdbClient: class {
      async movieWatchProviders(tmdbId: number) {
        tmdbCalls.push(tmdbId);
        const entry = tmdbAvailability[tmdbId];
        if (entry === "404") throw new TmdbNotFound("gone");
        if (entry === "error") throw new Error("tmdb unreachable");
        return entry ?? {};
      }
    },
  };
});

// The Watchmode title-map import downloads ~78MB; never in a test.
vi.mock("./titlemap", () => ({
  refreshTitleMap: async () => ({ status: "skipped_recent", rowCount: 0 }),
  lookupWatchmodeId: async () => null,
  TITLE_MAP_TTL_MS: 1,
}));

import { prisma } from "@/lib/db";
import { runSync, MOVIE_TTL_MS } from "@/lib/sync";
import { resetDatabase, makeSettings, makeConnection, makeMediaItem } from "@/test/dbHelpers";

const NETFLIX = 8;

/** TMDB availability payload placing a title on Netflix in the US. */
const onNetflix = {
  US: { flatrate: [{ provider_id: NETFLIX, provider_name: "Netflix", logo_path: "/n.jpg" }] },
};

const movie = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  title: `Movie ${id}`,
  year: 2020,
  monitored: true,
  hasFile: true,
  tmdbId: 1000 + id,
  movieFile: { id: 500 + id },
  images: [],
  tags: [],
  ...over,
});

async function radarrSettings() {
  return makeSettings({
    tmdbApiKey: "tmdb-key",
    tmdbRegions: ["US"],
    tmdbProviderIds: [NETFLIX],
    tmdbCountedTypes: ["flatrate"],
  });
}

beforeEach(async () => {
  await resetDatabase();
  radarrMovies = [];
  sonarrSeries = [];
  sonarrEpisodes = {};
  tmdbAvailability = {};
  tmdbCalls = [];
  radarrListCalls = 0;
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe("syncRadarr — snapshot", () => {
  it("records availability and the file id for each movie", async () => {
    await radarrSettings();
    await makeConnection();
    radarrMovies = [movie(1), movie(2)];
    tmdbAvailability = { 1001: onNetflix };

    const result = await runSync();
    expect(result.movies).toBe(2);
    expect(result.onStreamingMovies).toBe(1);
    expect(result.movieProviderCalls).toBe(2);

    const rows = await prisma.mediaItem.findMany({ orderBy: { arrId: "asc" } });
    expect(rows.map((r) => r.onStreaming)).toEqual([true, false]);
    expect(rows.map((r) => r.movieFileId)).toEqual([501, 502]);
    expect(rows[0].providerSyncedAt).not.toBeNull();
    expect(rows[0].streamingInfo).toMatchObject([{ name: "Netflix", type: "flatrate" }]);
  });

  it("marks a failed lookup unknown rather than 'not on streaming'", async () => {
    await radarrSettings();
    await makeConnection();
    radarrMovies = [movie(1)];
    tmdbAvailability = { 1001: "error" };

    const result = await runSync();
    const row = await prisma.mediaItem.findFirstOrThrow();
    // streamingUnknown is what stops the sweep re-monitoring the library during
    // a TMDB outage, and the freshness clock must not start on a non-answer.
    expect(row.streamingUnknown).toBe(true);
    expect(row.onStreaming).toBe(false);
    expect(row.providerSyncedAt).toBeNull();
    expect(result.errors.length).toBe(1);
  });

  it("flags a movie TMDB no longer knows about, without deleting it", async () => {
    await radarrSettings();
    await makeConnection();
    radarrMovies = [movie(1)];
    tmdbAvailability = { 1001: "404" };

    const result = await runSync();
    expect(result.tmdbMissingMovies).toBe(1);
    const row = await prisma.mediaItem.findFirstOrThrow();
    expect(row.tmdbMissing).toBe(true);
    // Sync stays read-only; removal is the sweep's decision.
    expect(await prisma.mediaItem.count()).toBe(1);
  });

  it("never looks up a title carrying the skip tag", async () => {
    await radarrSettings();
    await makeConnection();
    radarrMovies = [movie(1, { tags: [1] })];

    const result = await runSync();
    expect(result.taggedSkipped).toBe(1);
    expect(tmdbCalls).toEqual([]);
    const row = await prisma.mediaItem.findFirstOrThrow();
    expect(row.skipped).toBe(true);
    expect(row.streamingUnknown).toBe(true);
  });

  it("records a movie with no TMDB id as unknown", async () => {
    await radarrSettings();
    await makeConnection();
    radarrMovies = [movie(1, { tmdbId: undefined })];

    await runSync();
    expect(tmdbCalls).toEqual([]);
    expect((await prisma.mediaItem.findFirstOrThrow()).streamingUnknown).toBe(true);
  });
});

describe("syncRadarr — freshness window", () => {
  it("serves a recently-looked-up movie from cache instead of calling TMDB", async () => {
    await radarrSettings();
    const conn = await makeConnection();
    await makeMediaItem(conn.id, {
      arrId: 1,
      tmdbId: 1001,
      onStreaming: true,
      providerSyncedAt: new Date(Date.now() - 60 * 1000),
    });
    radarrMovies = [movie(1, { monitored: false })];

    const result = await runSync();
    expect(tmdbCalls).toEqual([]);
    expect(result.movieSkipped).toBe(1);
    expect(result.onStreamingMovies).toBe(1);

    // Metadata still refreshes even when availability is reused.
    const row = await prisma.mediaItem.findFirstOrThrow();
    expect(row.monitored).toBe(false);
    expect(row.onStreaming).toBe(true);
  });

  it("re-checks once the window has passed", async () => {
    await radarrSettings();
    const conn = await makeConnection();
    await makeMediaItem(conn.id, {
      arrId: 1,
      tmdbId: 1001,
      providerSyncedAt: new Date(Date.now() - MOVIE_TTL_MS - 1000),
    });
    radarrMovies = [movie(1)];

    await runSync();
    expect(tmdbCalls).toEqual([1001]);
  });

  it("re-checks a title whose last lookup failed, however recent", async () => {
    await radarrSettings();
    const conn = await makeConnection();
    await makeMediaItem(conn.id, {
      arrId: 1,
      tmdbId: 1001,
      streamingUnknown: true,
      providerSyncedAt: new Date(),
    });
    radarrMovies = [movie(1)];

    await runSync();
    expect(tmdbCalls).toEqual([1001]);
  });

  it("re-checks a title that has just had its skip tag removed", async () => {
    await radarrSettings();
    const conn = await makeConnection();
    await makeMediaItem(conn.id, {
      arrId: 1,
      tmdbId: 1001,
      skipped: true,
      providerSyncedAt: new Date(),
    });
    radarrMovies = [movie(1)];

    await runSync();
    expect(tmdbCalls).toEqual([1001]);
    expect((await prisma.mediaItem.findFirstOrThrow()).skipped).toBe(false);
  });
});

describe("syncRadarr — pruning", () => {
  it("removes rows for titles no longer in Radarr, and keeps the rest", async () => {
    await radarrSettings();
    const conn = await makeConnection();
    await makeMediaItem(conn.id, { arrId: 1, tmdbId: 1001, title: "Still there" });
    await makeMediaItem(conn.id, { arrId: 2, tmdbId: 1002, title: "Deleted from Radarr" });
    radarrMovies = [movie(1)];

    await runSync();
    const rows = await prisma.mediaItem.findMany();
    expect(rows.map((r) => r.arrId)).toEqual([1]);
  });

  it("keeps rows belonging to another connection", async () => {
    await radarrSettings();
    const a = await makeConnection({ name: "A", baseUrl: "http://a:7878" });
    const b = await makeConnection({ name: "B", baseUrl: "http://b:7878" });
    await makeMediaItem(a.id, { arrId: 1, tmdbId: 1001 });
    await makeMediaItem(b.id, { arrId: 1, tmdbId: 1001 });
    radarrMovies = [movie(1)];

    await runSync();
    // Both connections are enabled and both report movie 1, so both survive.
    expect(await prisma.mediaItem.count()).toBe(2);
  });

  it("empties the snapshot when Radarr reports an empty library", async () => {
    await radarrSettings();
    const conn = await makeConnection();
    await makeMediaItem(conn.id, { arrId: 1, tmdbId: 1001 });
    radarrMovies = [];

    await runSync();
    expect(await prisma.mediaItem.count()).toBe(0);
  });
});

describe("runSync — configuration guards", () => {
  it("refuses to run for Radarr without TMDB configured", async () => {
    await makeSettings({ tmdbApiKey: null, tmdbRegions: [], tmdbProviderIds: [] });
    await makeConnection();
    await expect(runSync()).rejects.toThrow(/TMDB API key/);
  });

  it("ignores disabled connections", async () => {
    await radarrSettings();
    await makeConnection({ enabled: false });
    radarrMovies = [movie(1)];

    const result = await runSync();
    expect(result.connections).toBe(0);
    expect(await prisma.mediaItem.count()).toBe(0);
  });
});

describe("runSync — scoped to named titles", () => {
  it("fetches only the named title, not the whole library", async () => {
    await radarrSettings();
    const conn = await makeConnection();
    radarrMovies = [movie(1), movie(2), movie(3)];
    tmdbAvailability = { 1002: onNetflix };

    const result = await runSync(undefined, {
      targets: [{ connectionId: conn.id, type: "MOVIE", arrId: 2 }],
    });

    expect(result.movies).toBe(1);
    expect(radarrListCalls).toBe(0);
    // One TMDB call for one title, rather than one per movie in the library.
    expect(tmdbCalls).toEqual([1002]);
    const rows = await prisma.mediaItem.findMany();
    expect(rows.map((r) => r.arrId)).toEqual([2]);
    expect(rows[0].onStreaming).toBe(true);
  });

  it("does not prune the rest of the library it never looked at", async () => {
    await radarrSettings();
    const conn = await makeConnection();
    // A snapshot from an earlier full sync.
    await makeMediaItem(conn.id, { arrId: 1, title: "Old" });
    await makeMediaItem(conn.id, { arrId: 2, title: "Also Old" });
    radarrMovies = [movie(1), movie(2), movie(3)];

    await runSync(undefined, { targets: [{ connectionId: conn.id, type: "MOVIE", arrId: 3 }] });

    const rows = await prisma.mediaItem.findMany({ orderBy: { arrId: "asc" } });
    expect(rows.map((r) => r.arrId)).toEqual([1, 2, 3]);
  });

  it("ignores the freshness window when told to force", async () => {
    await radarrSettings();
    const conn = await makeConnection();
    radarrMovies = [movie(1)];
    tmdbAvailability = { 1001: onNetflix };
    // Looked up a moment ago, so an ordinary sync would serve it from cache.
    await makeMediaItem(conn.id, { arrId: 1, tmdbId: 1001, providerSyncedAt: new Date() });

    const targets = [{ connectionId: conn.id, type: "MOVIE" as const, arrId: 1 }];
    await runSync(undefined, { targets });
    expect(tmdbCalls).toEqual([]);

    await runSync(undefined, { targets, force: true });
    expect(tmdbCalls).toEqual([1001]);
  });

  it("skips connections none of the targets live on", async () => {
    await radarrSettings();
    const first = await makeConnection({ baseUrl: "http://r1:7878" });
    const second = await makeConnection({ baseUrl: "http://r2:7878" });
    radarrMovies = [movie(1)];

    const result = await runSync(undefined, {
      targets: [{ connectionId: second.id, type: "MOVIE", arrId: 1 }],
    });

    expect(result.connections).toBe(1);
    const rows = await prisma.mediaItem.findMany();
    expect(rows.map((r) => r.connectionId)).toEqual([second.id]);
    expect(rows.every((r) => r.connectionId !== first.id)).toBe(true);
  });

  it("shrugs off a title that has already been removed again", async () => {
    await radarrSettings();
    const conn = await makeConnection();
    radarrMovies = [movie(1)];

    const result = await runSync(undefined, {
      targets: [
        { connectionId: conn.id, type: "MOVIE", arrId: 1 },
        { connectionId: conn.id, type: "MOVIE", arrId: 99 },
      ],
    });

    expect(result.movies).toBe(1);
    expect(result.errors).toEqual([]);
  });
});
