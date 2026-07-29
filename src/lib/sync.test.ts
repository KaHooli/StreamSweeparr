import { describe, it, expect } from "vitest";
import { providerLinkMap, applyProviderLinks, type StreamingInfoEntry } from "./sync";

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
