import { describe, it, expect } from "vitest";
import { setupStatus, type SetupSettingsShape } from "./setupState";

/** A fully configured install; each test knocks out only what it is about. */
function settings(over: Partial<SetupSettingsShape> = {}): SetupSettingsShape {
  return {
    watchmodeApiKeys: ["wm-key"],
    countries: ["US"],
    serviceIds: [203],
    tmdbApiKey: "tmdb-key",
    tmdbRegions: ["US"],
    tmdbProviderIds: [8],
    connections: [
      { type: "SONARR", enabled: true },
      { type: "RADARR", enabled: true },
    ],
    ...over,
  };
}

describe("setupStatus", () => {
  it("is ready when both stacks are configured", () => {
    expect(setupStatus(settings())).toEqual({ ready: true, missing: [] });
  });

  it("asks for a connection before anything else", () => {
    const status = setupStatus(settings({ connections: [] }));
    expect(status.ready).toBe(false);
    expect(status.missing).toEqual(["a Sonarr or Radarr connection"]);
  });

  it("ignores disabled connections when deciding what is needed", () => {
    const status = setupStatus(
      settings({ connections: [{ type: "SONARR", enabled: false }] })
    );
    expect(status.missing).toEqual(["a Sonarr or Radarr connection"]);
  });

  // The regression this module exists for: a movies-only install has no use
  // for Watchmode, and demanding it left the dashboard unreachable for good.
  it("does not require Watchmode for a Radarr-only install", () => {
    const status = setupStatus(
      settings({
        watchmodeApiKeys: [],
        countries: [],
        serviceIds: [],
        connections: [{ type: "RADARR", enabled: true }],
      })
    );
    expect(status).toEqual({ ready: true, missing: [] });
  });

  it("does not require TMDB for a Sonarr-only install", () => {
    const status = setupStatus(
      settings({
        tmdbApiKey: null,
        tmdbRegions: [],
        tmdbProviderIds: [],
        connections: [{ type: "SONARR", enabled: true }],
      })
    );
    expect(status).toEqual({ ready: true, missing: [] });
  });

  it("names the missing TV credentials when Sonarr is enabled", () => {
    const status = setupStatus(
      settings({
        watchmodeApiKeys: [],
        countries: [],
        serviceIds: [],
        connections: [{ type: "SONARR", enabled: true }],
      })
    );
    expect(status.ready).toBe(false);
    expect(status.missing).toEqual([
      "a Watchmode API key (for TV)",
      "at least one Watchmode country (for TV)",
      "at least one streaming service (for TV)",
    ]);
  });

  it("names the missing movie credentials when Radarr is enabled", () => {
    const status = setupStatus(
      settings({
        tmdbApiKey: null,
        tmdbRegions: [],
        tmdbProviderIds: [],
        connections: [{ type: "RADARR", enabled: true }],
      })
    );
    expect(status.ready).toBe(false);
    expect(status.missing).toEqual([
      "a TheMovieDB API key (for movies)",
      "at least one TMDB region (for movies)",
      "at least one TMDB movie provider (for movies)",
    ]);
  });

  it("reports both stacks when both kinds of connection are enabled", () => {
    const status = setupStatus(
      settings({ watchmodeApiKeys: [], tmdbApiKey: null })
    );
    expect(status.missing).toEqual([
      "a Watchmode API key (for TV)",
      "a TheMovieDB API key (for movies)",
    ]);
  });
});
