import { describe, it, expect } from "vitest";
import { matchSources, type WatchmodeTitleSource } from "./watchmode";

const src = (source_id: number, type: string, region = "US"): WatchmodeTitleSource => ({
  source_id,
  name: `svc-${source_id}`,
  type,
  region,
});

describe("matchSources", () => {
  const services = [203, 26]; // Netflix, Prime (example ids)
  const types = ["sub", "free"];

  it("returns empty for no sources", () => {
    expect(matchSources(undefined, services, types)).toEqual([]);
    expect(matchSources([], services, types)).toEqual([]);
  });

  it("matches only selected services", () => {
    const out = matchSources([src(203, "sub"), src(999, "sub")], services, types);
    expect(out.map((s) => s.source_id)).toEqual([203]);
  });

  it("matches only counted types", () => {
    const out = matchSources([src(203, "rent"), src(203, "sub")], services, types);
    expect(out.map((s) => s.type)).toEqual(["sub"]);
  });

  it("dedupes by source + region", () => {
    const out = matchSources([src(203, "sub", "US"), src(203, "sub", "US")], services, types);
    expect(out).toHaveLength(1);
  });

  it("keeps the same service across different regions", () => {
    const out = matchSources([src(203, "sub", "US"), src(203, "sub", "GB")], services, types);
    expect(out).toHaveLength(2);
  });

  it("excludes purchase/rent when not counted", () => {
    const out = matchSources([src(203, "purchase"), src(26, "free")], services, types);
    expect(out.map((s) => s.source_id)).toEqual([26]);
  });
});
