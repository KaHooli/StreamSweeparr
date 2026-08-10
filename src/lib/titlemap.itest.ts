import { describe, it, expect, beforeEach, afterAll } from "vitest";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { lookupWatchmodeId } from "@/lib/titlemap";
import { resetDatabase } from "@/test/dbHelpers";

/**
 * The local id lookup is what keeps a sync off Watchmode's metered `/search`
 * endpoint, so its fallback order is a credit-spending decision, not a detail.
 * It is all `findFirst` against real indexes, hence an integration test.
 */

beforeEach(resetDatabase);

afterAll(async () => {
  await prisma.$disconnect();
});

async function seed(rows: Prisma.TitleIdMapCreateManyInput[]) {
  await prisma.titleIdMap.createMany({ data: rows });
}

describe("lookupWatchmodeId", () => {
  it("finds a title by TMDB id and type", async () => {
    await seed([{ watchmodeId: 111, tmdbId: 1396, tmdbType: "tv", title: "Breaking Bad" }]);
    expect(await lookupWatchmodeId({ tmdbId: 1396, type: "tv" })).toBe(111);
  });

  it("prefers the row whose type matches", async () => {
    // The same TMDB id can exist as both a film and a series in the dataset.
    await seed([
      { watchmodeId: 222, tmdbId: 500, tmdbType: "movie", title: "Ambiguous" },
      { watchmodeId: 333, tmdbId: 500, tmdbType: "tv", title: "Ambiguous" },
    ]);
    expect(await lookupWatchmodeId({ tmdbId: 500, type: "tv" })).toBe(333);
    expect(await lookupWatchmodeId({ tmdbId: 500, type: "movie" })).toBe(222);
  });

  it("falls back to a type-agnostic TMDB match", async () => {
    // Watchmode's dataset labels some series "movie"; a miss on type is still
    // a better answer than spending a search credit.
    await seed([{ watchmodeId: 444, tmdbId: 777, tmdbType: "movie", title: "Mislabelled" }]);
    expect(await lookupWatchmodeId({ tmdbId: 777, type: "tv" })).toBe(444);
  });

  it("falls back to the IMDB id when TMDB does not resolve", async () => {
    await seed([{ watchmodeId: 555, imdbId: "tt0111161", tmdbType: "movie", title: "Shawshank" }]);
    expect(await lookupWatchmodeId({ tmdbId: 999, imdbId: "tt0111161", type: "movie" })).toBe(555);
  });

  it("returns null when nothing matches, so the caller can decide to search", async () => {
    await seed([{ watchmodeId: 666, tmdbId: 1, tmdbType: "tv", title: "Something" }]);
    expect(await lookupWatchmodeId({ tmdbId: 2, imdbId: "tt999", type: "tv" })).toBeNull();
  });

  it("returns null when given no ids at all", async () => {
    expect(await lookupWatchmodeId({ type: "tv" })).toBeNull();
    expect(await lookupWatchmodeId({ tmdbId: null, imdbId: null, type: "movie" })).toBeNull();
  });
});
