import { describe, it, expect, beforeEach } from "vitest";
import { collectSystemInfo } from "./collectSystemInfo";
import { resetDatabase, makeSettings, makeConnection } from "@/test/dbHelpers";
import { prisma } from "./db";

/**
 * The Info tab's value is that its numbers are real, and every interesting one
 * comes from SQL a unit test can only mock: `version()`, `pg_database_size`,
 * `pg_stat_activity`, the `_prisma_migrations` table. So they run for real here.
 */

beforeEach(async () => {
  await resetDatabase();
});

describe("collectSystemInfo", () => {
  it("reports a reachable database with its version, size and connections", async () => {
    const info = await collectSystemInfo();

    expect(info.database.reachable).toBe(true);
    expect(info.database.latencyMs).toBeGreaterThanOrEqual(0);
    expect(info.database.serverVersion).toMatch(/^PostgreSQL \d+/);
    expect(info.database.error).toBeNull();
    expect(info.database.database).toBeTruthy();
    expect(info.database.sizeBytes ?? 0).toBeGreaterThan(0);
    // We are ourselves a connection, so this can never be zero.
    expect(info.database.connectionsUsed ?? 0).toBeGreaterThan(0);
    expect(info.database.connectionsMax ?? 0).toBeGreaterThan(0);
  });

  it("reads the applied migrations from the schema history", async () => {
    const info = await collectSystemInfo();

    // CI applies migrations with `migrate deploy`, so the table is there. A
    // database built with `db push` has none, which is why this is nullable.
    if (info.database.migrationsApplied === null) {
      expect(info.database.latestMigration).toBeNull();
      return;
    }
    expect(info.database.migrationsApplied).toBeGreaterThan(0);
    expect(info.database.latestMigration).toBeTruthy();
    expect(info.database.latestMigrationAt).toBeTruthy();
  });

  it("counts what is actually in the library", async () => {
    await makeSettings();
    const conn = await makeConnection({ type: "SONARR", enabled: true });
    await prisma.mediaItem.create({
      data: {
        connectionId: conn.id,
        type: "TV",
        arrId: 1,
        title: "Andor",
        lastSyncedAt: new Date(),
      },
    });
    await prisma.mediaItem.create({
      data: {
        connectionId: conn.id,
        type: "MOVIE",
        arrId: 2,
        title: "Dune",
        lastSyncedAt: new Date(),
      },
    });
    await prisma.user.create({
      data: { username: "root", role: "ADMIN", passwordHash: "x" },
    });
    await prisma.runLog.create({ data: { status: "SUCCESS", dryRun: true } });

    const info = await collectSystemInfo();

    expect(info.library.tvShows).toBe(1);
    expect(info.library.movies).toBe(1);
    expect(info.library.users).toBe(1);
    expect(info.library.admins).toBe(1);
    expect(info.library.runs).toBe(1);
    expect(info.library.lastRun?.status).toBe("SUCCESS");
    expect(info.library.lastRun?.dryRun).toBe(true);
  });

  it("summarises configuration without ever emitting a credential", async () => {
    await makeSettings({
      applyChanges: true,
      countries: ["AU"],
      serviceIds: [203, 26],
      sweepScheduleEnabled: true,
      sweepIntervalHours: 12,
    });
    await makeConnection({ type: "SONARR", enabled: true, apiKey: "super-secret-key" });
    await makeConnection({ type: "RADARR", enabled: false, apiKey: "another-secret" });

    const info = await collectSystemInfo();

    expect(info.config?.applyChanges).toBe(true);
    expect(info.config?.countries).toBe(1);
    expect(info.config?.serviceIds).toBe(2);
    expect(info.config?.connections).toEqual({ sonarr: 1, radarr: 0, disabled: 1 });
    expect(info.config?.sweepScheduleEnabled).toBe(true);

    // The guarantee the whole screen rests on: stored credentials are reported
    // as presence, never as values.
    const serialized = JSON.stringify(info);
    expect(serialized).not.toContain("super-secret-key");
    expect(serialized).not.toContain("another-secret");
  });

  it("drops the DATABASE_URL credentials from what it reports", async () => {
    // Point the *display* path at a distinctive URL. Prisma is already
    // connected by now, so this changes what gets parsed for the payload and
    // nothing about where the queries go.
    const real = process.env.DATABASE_URL;
    process.env.DATABASE_URL =
      "postgresql://reportinguser:leak-canary-password@db.internal:5433/appdb?schema=reporting&connection_limit=10";
    try {
      const info = await collectSystemInfo();
      const serialized = JSON.stringify(info);
      expect(serialized).not.toContain("leak-canary-password");
      expect(serialized).not.toContain("reportinguser");
      expect(info.database.host).toBe("db.internal:5433");
      expect(info.database.schema).toBe("reporting");
      expect(info.database.connectionLimit).toBe("10");
      // The live connection still answers, and its own database name wins over
      // the one in the (now fictional) URL.
      expect(info.database.reachable).toBe(true);
      expect(info.database.database).not.toBe("appdb");
    } finally {
      process.env.DATABASE_URL = real;
    }
  });

  it("still reports the app and environment when there is no settings row", async () => {
    // resetDatabase leaves Settings empty; getSettings creates it on demand, so
    // the point here is that the app half never depends on the config half.
    const info = await collectSystemInfo();

    expect(info.app.nodeVersion).toBe(process.version);
    expect(info.app.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(info.app.memoryRssBytes).toBeGreaterThan(0);
    expect(info.env.syncConcurrency).toBeGreaterThan(0);
    expect(info.collectedAt).toBeTruthy();
  });
});
