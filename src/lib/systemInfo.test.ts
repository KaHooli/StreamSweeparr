import { describe, it, expect } from "vitest";
import {
  buildDiagnosticsText,
  describeDatabaseUrl,
  formatBytes,
  formatUptime,
  formatWhen,
  shortPostgresVersion,
  type SystemInfo,
} from "./systemInfo";

describe("describeDatabaseUrl", () => {
  it("keeps host, database and schema", () => {
    // Pool sizing is deliberately not reported from here — see dbConfig.test.ts,
    // which pins the mapping that actually governs it.
    const d = describeDatabaseUrl(
      "postgresql://sweep:hunter2@db.internal:5433/streamsweeparr?schema=public&connection_limit=10&pool_timeout=20"
    );
    expect(d).toEqual({
      host: "db.internal:5433",
      database: "streamsweeparr",
      schema: "public",
    });
  });

  it("never lets the credentials through", () => {
    // The whole point of this page is that it can be pasted into a bug report.
    const d = describeDatabaseUrl("postgresql://sweep:hunter2@db.internal:5432/app");
    const serialized = JSON.stringify(d);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("sweep");
  });

  it("returns nulls for a missing or unparseable value rather than throwing", () => {
    const empty = {
      host: null,
      database: null,
      schema: null,
    };
    expect(describeDatabaseUrl(undefined)).toEqual(empty);
    expect(describeDatabaseUrl("")).toEqual(empty);
    expect(describeDatabaseUrl("not a url")).toEqual(empty);
  });
});

describe("shortPostgresVersion", () => {
  it("trims the build noise off the version banner", () => {
    expect(
      shortPostgresVersion(
        "PostgreSQL 16.4 (Debian 16.4-1.pgdg120+1) on x86_64-pc-linux-gnu, compiled by gcc"
      )
    ).toBe("PostgreSQL 16.4");
  });

  it("falls back to the part before 'on' for anything else", () => {
    expect(shortPostgresVersion("CockroachDB CCL v23.1 on linux")).toBe("CockroachDB CCL v23.1");
  });

  it("returns null when there's nothing to report", () => {
    expect(shortPostgresVersion(null)).toBeNull();
    expect(shortPostgresVersion("   ")).toBeNull();
  });
});

describe("formatUptime", () => {
  it("reads as days/hours/minutes, dropping empty leading units", () => {
    expect(formatUptime(3 * 86400 + 4 * 3600 + 12 * 60)).toBe("3d 4h 12m");
    expect(formatUptime(5 * 60)).toBe("5m");
    expect(formatUptime(9)).toBe("9s");
    expect(formatUptime(0)).toBe("0s");
  });

  it("says so rather than printing nonsense for a bad value", () => {
    expect(formatUptime(-1)).toBe("unknown");
    expect(formatUptime(NaN)).toBe("unknown");
  });
});

describe("formatBytes", () => {
  it("scales to a readable unit", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1500)).toBe("1.5 kB");
    expect(formatBytes(1_400_000_000)).toBe("1.4 GB");
    expect(formatBytes(45_000_000)).toBe("45 MB");
  });

  it("handles the absent case", () => {
    expect(formatBytes(null)).toBe("unknown");
    expect(formatBytes(undefined)).toBe("unknown");
  });
});

describe("formatWhen", () => {
  it("renders an em dash for never", () => {
    expect(formatWhen(null)).toBe("—");
    expect(formatWhen("")).toBe("—");
  });

  it("passes through an unparseable value instead of showing 'Invalid Date'", () => {
    expect(formatWhen("whenever")).toBe("whenever");
  });
});

const info: SystemInfo = {
  app: {
    version: "1.0.0",
    commit: "abc1234",
    builtAt: "2026-08-07T00:00:00.000Z",
    nextVersion: "16.2.12",
    nodeVersion: "v24.4.0",
    prismaVersion: "5.18.0",
    environment: "production",
    platform: "linux x64",
    hostname: "streamsweeparr",
    timeZone: "Australia/Sydney",
    serverTime: "2026-08-07T10:00:00.000Z",
    uptimeSeconds: 3600,
    memoryRssBytes: 220_000_000,
  },
  database: {
    reachable: true,
    latencyMs: 3,
    serverVersion: "PostgreSQL 16.4",
    host: "db.internal:5432",
    database: "streamsweeparr",
    schema: "public",
    poolMax: 9,
    poolTimeoutMs: 10_000,
    poolMaxFromUrl: false,
    poolTimeoutFromUrl: false,
    sizeBytes: 84_000_000,
    connectionsUsed: 4,
    connectionsMax: 100,
    migrationsApplied: 7,
    latestMigration: "20260901000000_provider_deep_links",
    latestMigrationAt: "2026-08-01T00:00:00.000Z",
    error: null,
  },
  library: {
    tvShows: 120,
    movies: 340,
    episodes: 9000,
    titleMapRows: 500000,
    users: 3,
    admins: 1,
    runs: 42,
    lastRun: {
      id: 42,
      kind: "SWEEP",
      status: "SUCCESS",
      dryRun: true,
      startedAt: "2026-08-07T09:00:00.000Z",
      finishedAt: "2026-08-07T09:05:00.000Z",
    },
  },
  config: {
    applyChanges: false,
    deleteFiles: true,
    purgeUnmonitoredFiles: false,
    searchAtEnd: true,
    removeMissingTmdbMovies: false,
    watchmodeApiKeySet: true,
    watchmodeApiKeyCount: 2,
    watchmodePlan: "free",
    watchmodeCacheDays: 7,
    countries: 1,
    serviceIds: 4,
    movieProvider: "TMDB",
    tmdbApiKeySet: true,
    tmdbRegions: 1,
    tmdbProviderIds: 5,
    seerrConfigured: false,
    connections: { sonarr: 1, radarr: 1, disabled: 0 },
    sweepScheduleEnabled: true,
    sweepIntervalHours: 12,
    sweepNextRunAt: "2026-08-07T21:00:00.000Z",
    sweepLastRunAt: "2026-08-07T09:00:00.000Z",
    webhookEnabled: true,
    webhookTokenSet: true,
    webhookQueued: 2,
    titleMapSyncedAt: "2026-08-07T02:00:00.000Z",
    localLoginEnabled: true,
    oidcConfigured: false,
    secretsUnreadable: false,
  },
  env: {
    publicUrl: "https://sweep.example.com",
    trustProxy: true,
    ssrfAllowPrivate: true,
    authCookieInsecure: false,
    syncConcurrency: 4,
    logLevel: "info",
    sweepSchedulerDisabled: false,
    titleMapSchedulerDisabled: false,
  },
  collectedAt: "2026-08-07T10:00:00.000Z",
};

describe("buildDiagnosticsText", () => {
  it("covers every section, so a paste answers the usual first questions", () => {
    const text = buildDiagnosticsText(info);
    for (const heading of [
      "## Application",
      "## Database",
      "## Library",
      "## Configuration",
      "## Environment",
    ]) {
      expect(text).toContain(heading);
    }
    expect(text).toContain("Version: 1.0.0");
    expect(text).toContain("Commit: abc1234");
    expect(text).toContain("Server: PostgreSQL 16.4");
    expect(text).toContain("Mode: Dry-run");
    expect(text).toContain("Uptime: 1h");
    // A queue that never drains is the symptom of a worker that isn't running,
    // so the depth has to survive into a pasted report.
    expect(text).toContain("Webhook sweeps: on, token set, 2 title(s) queued");
  });

  it("reports credentials as presence, never as values", () => {
    const text = buildDiagnosticsText(info);
    expect(text).toContain("key set");
    expect(text).not.toMatch(/apikey|password|secret[=:]/i);
  });

  it("renders an unreachable database without losing the rest of the report", () => {
    const text = buildDiagnosticsText({
      ...info,
      database: {
        ...info.database,
        reachable: false,
        latencyMs: null,
        serverVersion: null,
        sizeBytes: null,
        error: "connection refused",
      },
    });
    expect(text).toContain("Reachable: No");
    expect(text).toContain("Error: connection refused");
    expect(text).toContain("## Application");
  });

  it("says settings were unreadable rather than printing an empty section", () => {
    const text = buildDiagnosticsText({ ...info, config: null });
    expect(text).toContain("Settings: could not be read");
  });

  it("uses an em dash for values that are simply absent", () => {
    const text = buildDiagnosticsText({
      ...info,
      app: { ...info.app, commit: "", builtAt: "" },
    });
    expect(text).toContain("Commit: —");
    expect(text).toContain("Built: —");
  });
});
