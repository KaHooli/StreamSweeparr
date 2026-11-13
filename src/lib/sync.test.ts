import { describe, it, expect } from "vitest";
import {
  providerLinkMap,
  applyProviderLinks,
  providerLinksAreStale,
  parseAirDate,
  newEpisodesAwaitingStreaming,
  newEpisodeRecheckDue,
  NEW_EPISODE_WINDOW_MS,
  NEW_EPISODE_RECHECK_MS,
  type NewEpisodeCandidate,
  type StreamingInfoEntry,
} from "./sync";

const entry = (sourceId: number, webUrl: string | null = null): StreamingInfoEntry => ({
  sourceId,
  name: `svc-${sourceId}`,
  type: "sub",
  region: "US",
  logo: null,
  webUrl,
});

describe("providerLinkMap", () => {
  it("maps source id -> web_url", () => {
    const links = providerLinkMap([
      { source_id: 203, web_url: "https://www.netflix.com/title/1" },
      { source_id: 26, web_url: "https://www.amazon.com/dp/2" },
    ]);
    expect(links.get(203)).toBe("https://www.netflix.com/title/1");
    expect(links.get(26)).toBe("https://www.amazon.com/dp/2");
  });

  it("ignores the free-plan placeholder and other non-URLs", () => {
    const links = providerLinkMap([
      { source_id: 203, web_url: "Episode links available for paid plans only." },
      { source_id: 26, web_url: "/relative/path" },
      { source_id: 57, web_url: undefined },
    ]);
    expect(links.size).toBe(0);
  });

  it("keeps the first region's link per source", () => {
    const links = providerLinkMap([
      { source_id: 203, web_url: "https://netflix.com/us" },
      { source_id: 203, web_url: "https://netflix.com/gb" },
    ]);
    expect(links.get(203)).toBe("https://netflix.com/us");
  });

  it("does not fall back to a source with no usable link", () => {
    const links = providerLinkMap([
      { source_id: 203, web_url: "not a url" },
      { source_id: 203, web_url: "https://netflix.com/us" },
    ]);
    // First entry is unusable, so the later real URL still wins.
    expect(links.get(203)).toBe("https://netflix.com/us");
  });
});

describe("providerLinksAreStale", () => {
  const now = Date.UTC(2026, 0, 30);
  const ttl = 7 * 24 * 60 * 60 * 1000;

  it("is stale when never checked (rows predating the column)", () => {
    expect(providerLinksAreStale(null, now, ttl)).toBe(true);
    expect(providerLinksAreStale(undefined, now, ttl)).toBe(true);
  });

  it("is fresh inside the TTL", () => {
    expect(providerLinksAreStale(new Date(now - ttl + 1000), now, ttl)).toBe(false);
  });

  it("is stale at and beyond the TTL", () => {
    expect(providerLinksAreStale(new Date(now - ttl), now, ttl)).toBe(true);
    expect(providerLinksAreStale(new Date(now - ttl * 2), now, ttl)).toBe(true);
  });
});

describe("applyProviderLinks", () => {
  it("fills only missing links and reports completeness", () => {
    const entries = [entry(203), entry(26, "https://existing.example/x")];
    const complete = applyProviderLinks(
      entries,
      new Map([
        [203, "https://netflix.com/title/1"],
        [26, "https://should-not-overwrite.example"],
      ])
    );
    expect(complete).toBe(true);
    expect(entries[0].webUrl).toBe("https://netflix.com/title/1");
    expect(entries[1].webUrl).toBe("https://existing.example/x");
  });

  it("reports incomplete when a source has no link anywhere", () => {
    const entries = [entry(203), entry(999)];
    const complete = applyProviderLinks(entries, new Map([[203, "https://netflix.com/1"]]));
    expect(complete).toBe(false);
    expect(entries[1].webUrl).toBeNull();
  });

  it("is a no-op for an empty provider list", () => {
    expect(applyProviderLinks([], new Map())).toBe(true);
  });
});

describe("parseAirDate", () => {
  it("reads an ISO timestamp from Sonarr", () => {
    expect(parseAirDate("2026-03-04T01:00:00Z")).toEqual(new Date("2026-03-04T01:00:00Z"));
  });

  it("returns null for an episode with no announced date", () => {
    expect(parseAirDate(undefined)).toBeNull();
    expect(parseAirDate("")).toBeNull();
  });

  it("returns null rather than an Invalid Date", () => {
    // The value goes straight into a timestamp column via createMany, so one
    // unparseable date would otherwise cost the whole series' episode snapshot.
    expect(parseAirDate("TBA")).toBeNull();
    expect(parseAirDate("0000-00-00")).toBeNull();
  });
});

describe("newEpisodesAwaitingStreaming", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.UTC(2026, 10, 13, 12);
  /** S23, one episode a week, E05 aired yesterday — the Grey's Anatomy case. */
  const weekly = (n: number, airedDaysAgo: number | null): NewEpisodeCandidate => ({
    seasonNumber: 23,
    episodeNumber: n,
    airDateUtc: airedDaysAgo === null ? null : new Date(now - airedDaysAgo * DAY),
  });
  const season = [weekly(1, 29), weekly(2, 22), weekly(3, 15), weekly(4, 8), weekly(5, 1), weekly(6, -6)];
  const confirmed = (...eps: number[]) => new Set(eps.map((n) => `23x${n}`));

  it("finds a newly aired episode whose predecessor is confirmed", () => {
    expect(newEpisodesAwaitingStreaming(season, confirmed(1, 2, 3, 4), now)).toEqual([
      { key: "23x5", airDateUtc: new Date(now - DAY), previousKey: "23x4" },
    ]);
  });

  it("ignores an episode Watchmode has already confirmed", () => {
    expect(newEpisodesAwaitingStreaming(season, confirmed(1, 2, 3, 4, 5), now)).toEqual([]);
  });

  it("ignores a show whose previous episode is not on the user's services", () => {
    // A service running a season behind, or a show the user does not stream:
    // nothing says the new episode is coming, so it earns neither a recheck
    // nor an assumption.
    expect(newEpisodesAwaitingStreaming(season, confirmed(1, 2, 3), now)).toEqual([]);
    expect(newEpisodesAwaitingStreaming(season, confirmed(), now)).toEqual([]);
  });

  it("does not let one unconfirmed episode vouch for the next", () => {
    const later = [...season.slice(0, 4), weekly(5, 6), weekly(6, 1)];
    expect(newEpisodesAwaitingStreaming(later, confirmed(1, 2, 3, 4), now).map((a) => a.key)).toEqual([
      "23x5",
    ]);
  });

  it("ignores an episode older than the window, and one not yet aired", () => {
    const old = [weekly(4, 20), { ...weekly(5, 0), airDateUtc: new Date(now - NEW_EPISODE_WINDOW_MS - 1) }];
    expect(newEpisodesAwaitingStreaming(old, confirmed(4), now)).toEqual([]);
    expect(newEpisodesAwaitingStreaming([weekly(4, 8), weekly(5, -1)], confirmed(4), now)).toEqual([]);
  });

  it("ignores an episode with no air date", () => {
    expect(newEpisodesAwaitingStreaming([weekly(4, 8), weekly(5, null)], confirmed(4), now)).toEqual([]);
  });

  it("covers a season premiere through the previous season's finale", () => {
    const eps: NewEpisodeCandidate[] = [
      { seasonNumber: 22, episodeNumber: 18, airDateUtc: new Date(now - 180 * DAY) },
      { seasonNumber: 23, episodeNumber: 1, airDateUtc: new Date(now - DAY) },
    ];
    expect(newEpisodesAwaitingStreaming(eps, new Set(["22x18"]), now).map((a) => a.key)).toEqual(["23x1"]);
  });

  it("orders by season and episode, whatever order Sonarr lists them in", () => {
    const shuffled = [weekly(5, 1), weekly(3, 15), weekly(4, 8)];
    expect(newEpisodesAwaitingStreaming(shuffled, confirmed(3, 4), now).map((a) => a.key)).toEqual([
      "23x5",
    ]);
  });

  it("ignores specials", () => {
    const eps: NewEpisodeCandidate[] = [
      { seasonNumber: 0, episodeNumber: 1, airDateUtc: new Date(now - 10 * DAY) },
      { seasonNumber: 1, episodeNumber: 1, airDateUtc: new Date(now - DAY) },
    ];
    expect(newEpisodesAwaitingStreaming(eps, new Set(["0x1"]), now)).toEqual([]);
  });
});

describe("newEpisodeRecheckDue", () => {
  const HOUR = 60 * 60 * 1000;
  const now = Date.UTC(2026, 10, 13, 12);
  const aired = new Date(now - 10 * HOUR);
  const awaiting = [{ key: "23x5", airDateUtc: aired, previousKey: "23x4" }];

  it("is due when the last lookup predates the episode airing", () => {
    expect(newEpisodeRecheckDue(awaiting, new Date(aired.getTime() - HOUR), now)).toBe(true);
  });

  it("is not due again until a day has passed since the last lookup", () => {
    expect(newEpisodeRecheckDue(awaiting, new Date(now - 2 * HOUR), now)).toBe(false);
    expect(newEpisodeRecheckDue(awaiting, new Date(now - NEW_EPISODE_RECHECK_MS), now)).toBe(true);
  });

  it("is never due with nothing awaiting", () => {
    expect(newEpisodeRecheckDue([], new Date(now - 30 * 24 * HOUR), now)).toBe(false);
  });
});
