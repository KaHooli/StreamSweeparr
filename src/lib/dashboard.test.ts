import { describe, it, expect } from "vitest";
import { dedupeServices } from "./dashboard";

const service = (over: Record<string, unknown> = {}) => ({
  sourceId: 203,
  name: "Netflix",
  type: "sub",
  region: "AU",
  logo: "https://cdn.example/netflix.png",
  webUrl: null,
  ...over,
});

describe("dedupeServices", () => {
  it("keeps one entry per service name", () => {
    const out = dedupeServices([
      service({ region: "AU" }),
      service({ region: "US" }),
      service({ name: "Stan", sourceId: 400 }),
    ]);
    expect(out.map((s) => s.name)).toEqual(["Netflix", "Stan"]);
  });

  it("prefers the stored deep link to the title", () => {
    const [out] = dedupeServices(
      [service({ webUrl: "https://www.netflix.com/title/80192098" })],
      "https://www.themoviedb.org/tv/1/watch",
      "A Christmas Carol"
    );
    expect(out.url).toBe("https://www.netflix.com/title/80192098");
  });

  it("falls back to the service's own search page when there is no deep link", () => {
    // The reason this exists: Watchmode returns no per-episode web_url on free
    // plans, which used to leave these logos unlinked.
    const [out] = dedupeServices(
      [service()],
      "https://www.themoviedb.org/tv/1/watch",
      "A Christmas Carol"
    );
    expect(out.url).toBe("https://www.netflix.com/search?q=A%20Christmas%20Carol");
  });

  it("ignores a placeholder web_url persisted by an earlier sync", () => {
    const [out] = dedupeServices(
      [service({ webUrl: "Episode links available for paid plans only." })],
      null,
      "A Christmas Carol"
    );
    expect(out.url).toBe("https://www.netflix.com/search?q=A%20Christmas%20Carol");
  });

  it("uses the TMDB fallback for a service we know no search URL for", () => {
    const [out] = dedupeServices(
      [service({ name: "Some Regional Broadcaster" })],
      "https://www.themoviedb.org/tv/1/watch",
      "A Christmas Carol"
    );
    expect(out.url).toBe("https://www.themoviedb.org/tv/1/watch");
  });

  it("leaves the link null only when nothing at all resolves", () => {
    const [out] = dedupeServices([service({ name: "Some Regional Broadcaster" })], null, "Andor");
    expect(out.url).toBeNull();
  });

  it("returns an empty list for a missing or malformed streamingInfo blob", () => {
    expect(dedupeServices(null)).toEqual([]);
    expect(dedupeServices("not-an-array")).toEqual([]);
  });
});
