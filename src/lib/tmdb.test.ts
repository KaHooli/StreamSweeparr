import { describe, it, expect } from "vitest";
import { matchTmdbProviders, type TmdbRegionAvailability } from "./tmdb";

const prov = (provider_id: number, provider_name = `p${provider_id}`) => ({
  provider_id,
  provider_name,
});

describe("matchTmdbProviders", () => {
  const regions = ["US"];
  const providerIds = [8, 9]; // e.g. Netflix, Prime
  const types = ["flatrate", "free"];

  it("returns empty when nothing matches", () => {
    const avail: Record<string, TmdbRegionAvailability> = {
      US: { flatrate: [prov(999)] },
    };
    expect(matchTmdbProviders(avail, regions, providerIds, types)).toEqual([]);
  });

  it("matches selected providers in selected regions and categories", () => {
    const avail: Record<string, TmdbRegionAvailability> = {
      US: { flatrate: [prov(8)], buy: [prov(9)] },
      GB: { flatrate: [prov(9)] },
    };
    const out = matchTmdbProviders(avail, regions, providerIds, types);
    // Only US flatrate provider 8 counts (buy not in types; GB not in regions).
    expect(out.map((m) => m.providerId)).toEqual([8]);
    expect(out[0].type).toBe("flatrate");
    expect(out[0].region).toBe("US");
  });

  it("respects the counted-type filter", () => {
    const avail: Record<string, TmdbRegionAvailability> = {
      US: { rent: [prov(8)], flatrate: [prov(9)] },
    };
    const out = matchTmdbProviders(avail, regions, providerIds, ["flatrate"]);
    expect(out.map((m) => m.providerId)).toEqual([9]);
  });

  it("only considers selected regions", () => {
    const avail: Record<string, TmdbRegionAvailability> = {
      GB: { flatrate: [prov(8)] },
    };
    expect(matchTmdbProviders(avail, ["US"], providerIds, types)).toEqual([]);
    expect(matchTmdbProviders(avail, ["GB"], providerIds, types)).toHaveLength(1);
  });

  it("dedupes duplicate provider/region/category", () => {
    const avail: Record<string, TmdbRegionAvailability> = {
      US: { flatrate: [prov(8), prov(8)] },
    };
    expect(matchTmdbProviders(avail, regions, providerIds, types)).toHaveLength(1);
  });
});
