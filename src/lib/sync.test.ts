import { describe, it, expect } from "vitest";
import {
  providerLinkMap,
  applyProviderLinks,
  providerLinksAreStale,
  parseAirDate,
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
