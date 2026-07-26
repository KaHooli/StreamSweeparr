import { describe, it, expect } from "vitest";
import {
  matchTmdbProviders,
  isTmdbNotFound,
  TmdbError,
  type TmdbRegionAvailability,
} from "./tmdb";

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

  it("exposes an absolute logo URL, or null when TMDB has no logo", () => {
    const avail: Record<string, TmdbRegionAvailability> = {
      US: {
        flatrate: [
          { ...prov(8), logo_path: "/abc.jpg" },
          prov(9), // no logo_path
        ],
      },
    };
    const out = matchTmdbProviders(avail, regions, providerIds, types);
    const byId = new Map(out.map((m) => [m.providerId, m.logo]));
    expect(byId.get(8)).toBe("https://image.tmdb.org/t/p/original/abc.jpg");
    expect(byId.get(9)).toBeNull();
  });

  it("dedupes duplicate provider/region/category", () => {
    const avail: Record<string, TmdbRegionAvailability> = {
      US: { flatrate: [prov(8), prov(8)] },
    };
    expect(matchTmdbProviders(avail, regions, providerIds, types)).toHaveLength(1);
  });
});

describe("isTmdbNotFound", () => {
  it("is true only for a 404 from TMDB", () => {
    expect(isTmdbNotFound(new TmdbError("TMDB request failed (404): ...", 404))).toBe(true);
  });

  it("is false for transient failures we must not act on", () => {
    expect(isTmdbNotFound(new TmdbError("TMDB rate limit exceeded.", 429))).toBe(false);
    expect(isTmdbNotFound(new TmdbError("TMDB request timed out.", 408))).toBe(false);
    expect(isTmdbNotFound(new TmdbError("server error", 500))).toBe(false);
    expect(isTmdbNotFound(new TmdbError("no status"))).toBe(false);
  });

  it("is false for unrelated errors", () => {
    expect(isTmdbNotFound(new Error("404"))).toBe(false);
    expect(isTmdbNotFound(null)).toBe(false);
    expect(isTmdbNotFound("404")).toBe(false);
  });
});
