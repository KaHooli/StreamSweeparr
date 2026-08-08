// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { InfoCard } from "./InfoCard";
import type { SystemInfo } from "@/lib/systemInfo";

/**
 * The card is mostly a table, so what's worth testing is the behaviour around
 * it: that a broken database still renders (this being the tab you open when
 * things are broken), that a non-admin is told why they see nothing, and that
 * Copy puts the report on the clipboard.
 */

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
    uptimeSeconds: 7200,
    memoryRssBytes: 220_000_000,
  },
  database: {
    reachable: true,
    latencyMs: 3,
    serverVersion: "PostgreSQL 16.4",
    host: "db.internal:5432",
    database: "streamsweeparr",
    schema: "public",
    connectionLimit: null,
    poolTimeout: null,
    sizeBytes: 84_000_000,
    connectionsUsed: 4,
    connectionsMax: 100,
    migrationsApplied: 13,
    latestMigration: "20261202000000_sweep_performance",
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
    countries: 1,
    serviceIds: 4,
    tmdbApiKeySet: true,
    tmdbRegions: 1,
    tmdbProviderIds: 5,
    seerrConfigured: false,
    connections: { sonarr: 1, radarr: 1, disabled: 0 },
    sweepScheduleEnabled: true,
    sweepIntervalHours: 12,
    sweepNextRunAt: "2026-08-07T21:00:00.000Z",
    sweepLastRunAt: "2026-08-07T09:00:00.000Z",
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

/** Render with a fresh SWR cache so tests can't see each other's responses. */
const renderCard = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <InfoCard />
    </SWRConfig>
  );

const respondWith = (body: unknown, status = 200) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status }))
  );
};

let clipboard: string[] = [];

beforeEach(() => {
  clipboard = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async (t: string) => void clipboard.push(t)) },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("InfoCard", () => {
  it("shows the app, database, library, config and environment sections", async () => {
    respondWith(info);
    renderCard();

    expect(await screen.findByRole("heading", { name: "Application" })).toBeTruthy();
    for (const heading of ["Database", "Library", "Configuration", "Environment"]) {
      // By role: "Database" is also a row label inside the Database section.
      expect(screen.getByRole("heading", { name: heading })).toBeTruthy();
    }
    expect(screen.getByText("PostgreSQL 16.4")).toBeTruthy();
    expect(screen.getByText("Connected — 3 ms")).toBeTruthy();
    expect(screen.getByText("2h")).toBeTruthy(); // uptime
    expect(screen.getByText("84 MB")).toBeTruthy(); // database size
  });

  it("names the running version in the footer", async () => {
    respondWith(info);
    renderCard();

    const footer = (await screen.findByText(/Collected/)).closest("p");
    expect(footer?.textContent).toContain("StreamSweeparr 1.0.0");
    expect(footer?.textContent).toContain("abc1234");
  });

  it("omits the commit from the footer when the build didn't stamp one", async () => {
    respondWith({ ...info, app: { ...info.app, commit: "" } });
    renderCard();

    const footer = (await screen.findByText(/Collected/)).closest("p");
    expect(footer?.textContent).toContain("StreamSweeparr 1.0.0");
    expect(footer?.textContent).not.toContain("·  ");
  });

  it("reports an unreachable database instead of rendering nothing", async () => {
    respondWith({
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
    renderCard();

    expect(await screen.findByText("Unreachable")).toBeTruthy();
    expect(screen.getByText("connection refused")).toBeTruthy();
    // The half that doesn't need the database is still there.
    expect(screen.getByText("v24.4.0")).toBeTruthy();
  });

  it("explains a 403 rather than showing an empty page", async () => {
    respondWith({ error: "Administrator access required." }, 403);
    renderCard();
    expect(await screen.findByText(/not an administrator/i)).toBeTruthy();
  });

  it("copies the diagnostics report to the clipboard", async () => {
    respondWith(info);
    renderCard();

    fireEvent.click(await screen.findByRole("button", { name: "Copy diagnostics" }));
    await waitFor(() => expect(clipboard).toHaveLength(1));
    expect(clipboard[0]).toContain("# StreamSweeparr diagnostics");
    expect(clipboard[0]).toContain("Version: 1.0.0");
    expect(await screen.findByRole("button", { name: "Copied ✓" })).toBeTruthy();
  });

  it("says so when the clipboard is unavailable, e.g. over plain HTTP", async () => {
    respondWith(info);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn(async () => {
          throw new Error("not allowed");
        }),
      },
    });
    renderCard();

    fireEvent.click(await screen.findByRole("button", { name: "Copy diagnostics" }));
    expect(await screen.findByRole("button", { name: "Copy failed" })).toBeTruthy();
  });

  it("flags credentials that no longer decrypt", async () => {
    respondWith({ ...info, config: { ...info.config!, secretsUnreadable: true } });
    renderCard();
    expect(await screen.findByText(/AUTH_SECRET appears to have changed/)).toBeTruthy();
  });
});
