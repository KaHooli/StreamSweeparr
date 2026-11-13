import { describe, it, expect } from "vitest";
import { buildFeedItems, feedTokenFromRequest, parseTmdbIds, type FeedRow } from "@/lib/feed";
import { feedUrl, isFeedKind } from "@/lib/feedUrl";

const entry = (over: Record<string, unknown> = {}) => ({
  sourceId: 203,
  name: "Netflix",
  type: "sub",
  region: "AU",
  logo: "https://cdn.example/netflix.png",
  webUrl: null,
  ...over,
});

const row = (over: Partial<FeedRow> = {}): FeedRow => ({
  title: "Andor",
  year: 2022,
  tmdbId: 83867,
  tvdbId: 393189,
  imdbId: "tt9253284",
  posterUrl: null,
  totalEpisodes: 24,
  streamingEpisodes: 24,
  providerSyncedAt: new Date("2026-11-01T00:00:00Z"),
  streamingInfo: [entry()],
  ...over,
});

describe("buildFeedItems", () => {
  it("shapes a TV row, with episode counts and a tvdbId", () => {
    const [item] = buildFeedItems([row()], "tv");
    expect(item).toEqual({
      title: "Andor",
      year: 2022,
      tmdbId: 83867,
      tvdbId: 393189,
      imdbId: "tt9253284",
      posterUrl: null,
      episodes: { streaming: 24, total: 24 },
      checkedAt: "2026-11-01T00:00:00.000Z",
      services: [
        {
          name: "Netflix",
          type: "sub",
          region: "AU",
          logo: "https://cdn.example/netflix.png",
          url: "https://www.netflix.com/search?q=Andor",
          linkKind: "search",
        },
      ],
    });
  });

  it("leaves episode counts and tvdbId off a movie", () => {
    const [item] = buildFeedItems([row({ title: "Heat", tmdbId: 949 })], "movies");
    expect(item).not.toHaveProperty("episodes");
    expect(item).not.toHaveProperty("tvdbId");
  });

  it("labels each rung of the link chain", () => {
    const [item] = buildFeedItems(
      [
        row({
          streamingInfo: [
            entry({ webUrl: "https://www.netflix.com/title/1" }),
            entry({ name: "Stan", sourceId: 1 }),
            entry({ name: "Some Regional Broadcaster", sourceId: 2 }),
          ],
        }),
      ],
      "tv"
    );
    expect(item.services.map((s) => [s.name, s.linkKind])).toEqual([
      ["Netflix", "direct"],
      ["Stan", "search"],
      ["Some Regional Broadcaster", "tmdb"],
    ]);
    // The TMDB rung points at the right media type's page.
    expect(item.services[2].url).toBe("https://www.themoviedb.org/tv/83867/watch");
  });

  it("merges two instances' copies of one title, keeping the best link per service", () => {
    // A 4K Sonarr alongside the main one: same show, two rows.
    const items = buildFeedItems(
      [
        row({ streamingEpisodes: 10, providerSyncedAt: new Date("2026-11-01T00:00:00Z") }),
        row({
          streamingEpisodes: 12,
          totalEpisodes: 20,
          providerSyncedAt: new Date("2026-11-05T00:00:00Z"),
          streamingInfo: [
            entry({ webUrl: "https://www.netflix.com/title/1" }),
            entry({ name: "Disney+", sourceId: 372 }),
          ],
        }),
      ],
      "tv"
    );
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item.services.map((s) => [s.name, s.linkKind])).toEqual([
      ["Disney+", "search"],
      ["Netflix", "direct"],
    ]);
    expect(item.episodes).toEqual({ streaming: 12, total: 24 });
    expect(item.checkedAt).toBe("2026-11-05T00:00:00.000Z");
  });

  it("never merges rows without a tmdbId — a shared title is not proof of one film", () => {
    const items = buildFeedItems(
      [row({ title: "Heat", tmdbId: null }), row({ title: "Heat", tmdbId: null })],
      "movies"
    );
    expect(items).toHaveLength(2);
  });

  it("tolerates a missing streamingInfo blob", () => {
    const [item] = buildFeedItems([row({ streamingInfo: null })], "tv");
    expect(item.services).toEqual([]);
  });
});

describe("parseTmdbIds", () => {
  const parse = (qs: string) => parseTmdbIds(new URLSearchParams(qs));

  it("is no filter when absent", () => {
    expect(parse("")).toBeNull();
  });

  it("accepts repeated and comma-separated ids alike", () => {
    expect(parse("tmdbId=1&tmdbId=2,3")).toEqual([1, 2, 3]);
  });

  it("rejects anything that is not a positive integer rather than dropping it", () => {
    for (const bad of ["tmdbId=abc", "tmdbId=0", "tmdbId=-1", "tmdbId=1.5", "tmdbId=1,,2"]) {
      expect(parse(bad)).toHaveProperty("error");
    }
  });
});

describe("feedTokenFromRequest", () => {
  const req = (url: string, headers: Record<string, string> = {}) => ({
    url: `http://ss.test${url}`,
    headers: new Headers(headers),
  });

  it("reads X-Api-Key", () => {
    expect(feedTokenFromRequest(req("/api/feed/tv", { "X-Api-Key": " k1 " }))).toBe("k1");
  });

  it("reads a bearer token", () => {
    expect(feedTokenFromRequest(req("/api/feed/tv", { Authorization: "Bearer k2" }))).toBe("k2");
  });

  it("reads ?apikey= and ?token=", () => {
    expect(feedTokenFromRequest(req("/api/feed/tv?apikey=k3"))).toBe("k3");
    expect(feedTokenFromRequest(req("/api/feed/tv?token=k4"))).toBe("k4");
  });

  it("does not take basic auth, which only the webhook needs", () => {
    const basic = `Basic ${Buffer.from("user:k5").toString("base64")}`;
    expect(feedTokenFromRequest(req("/api/feed/tv", { Authorization: basic }))).toBeNull();
  });

  it("is null when nothing is presented", () => {
    expect(feedTokenFromRequest(req("/api/feed/tv"))).toBeNull();
  });
});

describe("feedUrl", () => {
  it("builds each feed's URL from an origin, with or without a trailing slash", () => {
    expect(feedUrl("http://ss.local:3000", "tv")).toBe("http://ss.local:3000/api/feed/tv");
    expect(feedUrl("https://ss.example/", "movies")).toBe("https://ss.example/api/feed/movies");
  });

  it("knows exactly two kinds", () => {
    expect(isFeedKind("tv")).toBe(true);
    expect(isFeedKind("movies")).toBe(true);
    expect(isFeedKind("movie")).toBe(false);
  });
});
