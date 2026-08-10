/**
 * Server side of Settings → Info: the probes that fill in `SystemInfo`.
 *
 * Two rules shape everything here.
 *
 * 1. **No secrets, ever.** The payload is meant to be pasted into a bug report,
 *    so credentials are reported as "set" / "not set" and `DATABASE_URL` goes
 *    through `describeDatabaseUrl`, which keeps only host and database name.
 * 2. **Nothing here may throw.** A page opened *because* the database is
 *    misbehaving is worthless if a failing query blanks it, so every probe is
 *    guarded on its own and reports its failure inline.
 */
import os from "node:os";
import { Prisma } from "@prisma/client";
import { prisma, getSettings, getRawSettings } from "./db";
import { hasUnreadableSecret } from "./secrets";
import { isOidcConfigured, effectiveLocalLoginEnabled } from "./loginOptions";
import { schedulerDisabledByEnv } from "./schedule";
import { syncConcurrency } from "./concurrency";
import {
  describeDatabaseUrl,
  shortPostgresVersion,
  type AppInfo,
  type ConfigInfo,
  type DatabaseInfo,
  type EnvInfo,
  type LibraryInfo,
  type SystemInfo,
} from "./systemInfo";

const isTruthyEnv = (v: string | undefined) => v === "true" || v === "1";

/** Raw scalars come back as bigint from `$queryRaw`. */
const asNumber = (v: unknown): number => (typeof v === "bigint" ? Number(v) : Number(v ?? 0));

function appInfo(): AppInfo {
  return {
    // Inlined at build time by next.config.mjs, so the running app reports what
    // it was *built* from: the image carries no git history, and reading
    // package.json at runtime only works for some deployment layouts.
    version: process.env.APP_VERSION || "unknown",
    commit: process.env.APP_COMMIT || "",
    builtAt: process.env.APP_BUILT_AT || "",
    nextVersion: process.env.APP_NEXT_VERSION || "unknown",
    nodeVersion: process.version,
    prismaVersion: Prisma.prismaVersion?.client ?? "unknown",
    environment: process.env.NODE_ENV || "unknown",
    platform: `${process.platform} ${process.arch}`,
    hostname: os.hostname(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown",
    serverTime: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    memoryRssBytes: process.memoryUsage().rss,
  };
}

async function databaseInfo(): Promise<DatabaseInfo> {
  const fromUrl = describeDatabaseUrl(process.env.DATABASE_URL);
  const info: DatabaseInfo = {
    reachable: false,
    latencyMs: null,
    serverVersion: null,
    host: fromUrl.host,
    database: fromUrl.database,
    schema: fromUrl.schema,
    connectionLimit: fromUrl.connectionLimit,
    poolTimeout: fromUrl.poolTimeout,
    sizeBytes: null,
    connectionsUsed: null,
    connectionsMax: null,
    migrationsApplied: null,
    latestMigration: null,
    latestMigrationAt: null,
    error: null,
  };

  const startedAt = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    info.reachable = true;
    info.latencyMs = Date.now() - startedAt;
  } catch (e) {
    info.error = (e as Error).message;
    return info;
  }

  // Everything below is best-effort: a locked-down database role can refuse any
  // of it without that being a reason to show the admin nothing.
  try {
    const rows = await prisma.$queryRaw<
      { version: string; db: string; size: bigint }[]
    >`SELECT version() AS version, current_database() AS db, pg_database_size(current_database()) AS size`;
    if (rows[0]) {
      info.serverVersion = shortPostgresVersion(rows[0].version);
      info.database = rows[0].db || info.database;
      info.sizeBytes = asNumber(rows[0].size);
    }
  } catch (e) {
    info.error = (e as Error).message;
  }

  try {
    const rows = await prisma.$queryRaw<{ used: bigint; max: string }[]>`
      SELECT (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()) AS used,
             current_setting('max_connections') AS max`;
    if (rows[0]) {
      info.connectionsUsed = asNumber(rows[0].used);
      info.connectionsMax = Number(rows[0].max) || null;
    }
  } catch {
    // pg_stat_activity is readable by default, but not on every managed host.
  }

  try {
    const rows = await prisma.$queryRaw<{ name: string; finished_at: Date | null }[]>`
      SELECT migration_name AS name, finished_at
      FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL
      ORDER BY finished_at DESC`;
    info.migrationsApplied = rows.length;
    info.latestMigration = rows[0]?.name ?? null;
    info.latestMigrationAt = rows[0]?.finished_at?.toISOString() ?? null;
  } catch {
    // A schema created with `prisma db push` has no migrations table at all.
  }

  return info;
}

const EMPTY_LIBRARY: LibraryInfo = {
  tvShows: 0,
  movies: 0,
  episodes: 0,
  titleMapRows: 0,
  users: 0,
  admins: 0,
  runs: 0,
  lastRun: null,
};

async function libraryInfo(): Promise<LibraryInfo> {
  try {
    const [byType, episodes, titleMapRows, byRole, runs, lastRun] = await Promise.all([
      prisma.mediaItem.groupBy({ by: ["type"], _count: { _all: true } }),
      prisma.episode.count(),
      prisma.titleIdMap.count(),
      prisma.user.groupBy({ by: ["role"], _count: { _all: true } }),
      prisma.runLog.count(),
      prisma.runLog.findFirst({
        orderBy: { startedAt: "desc" },
        select: {
          id: true,
          kind: true,
          status: true,
          dryRun: true,
          startedAt: true,
          finishedAt: true,
        },
      }),
    ]);
    return {
      tvShows: byType.find((t) => t.type === "TV")?._count._all ?? 0,
      movies: byType.find((t) => t.type === "MOVIE")?._count._all ?? 0,
      episodes,
      titleMapRows,
      users: byRole.reduce((n, r) => n + r._count._all, 0),
      admins: byRole.find((r) => r.role === "ADMIN")?._count._all ?? 0,
      runs,
      lastRun: lastRun
        ? {
            id: lastRun.id,
            kind: lastRun.kind,
            status: lastRun.status,
            dryRun: lastRun.dryRun,
            startedAt: lastRun.startedAt.toISOString(),
            finishedAt: lastRun.finishedAt?.toISOString() ?? null,
          }
        : null,
    };
  } catch {
    return EMPTY_LIBRARY;
  }
}

async function configInfo(): Promise<ConfigInfo | null> {
  try {
    const s = await getSettings();
    const raw = await getRawSettings();
    const enabled = s.connections.filter((c) => c.enabled);
    return {
      applyChanges: s.applyChanges,
      deleteFiles: s.deleteFiles,
      purgeUnmonitoredFiles: s.purgeUnmonitoredFiles,
      searchAtEnd: s.searchAtEnd,
      removeMissingTmdbMovies: s.removeMissingTmdbMovies,
      // Presence only — the decrypted values never leave this function.
      watchmodeApiKeySet: !!s.watchmodeApiKey,
      watchmodeApiKeyCount: s.watchmodeApiKeys.length,
      watchmodePlan: s.watchmodePlan ?? null,
      countries: s.countries.length,
      serviceIds: s.serviceIds.length,
      movieProvider: s.movieProvider,
      tmdbApiKeySet: !!s.tmdbApiKey,
      tmdbRegions: s.tmdbRegions.length,
      tmdbProviderIds: s.tmdbProviderIds.length,
      seerrConfigured: !!s.seerrUrl && !!s.seerrApiKey,
      connections: {
        sonarr: enabled.filter((c) => c.type === "SONARR").length,
        radarr: enabled.filter((c) => c.type === "RADARR").length,
        disabled: s.connections.length - enabled.length,
      },
      sweepScheduleEnabled: s.sweepScheduleEnabled,
      sweepIntervalHours: s.sweepIntervalHours,
      sweepNextRunAt: s.sweepNextRunAt?.toISOString() ?? null,
      sweepLastRunAt: s.sweepLastRunAt?.toISOString() ?? null,
      webhookEnabled: s.webhookEnabled,
      webhookTokenSet: !!s.webhookToken,
      // A queue that never empties is the symptom of a worker that isn't
      // running — SWEEP_SCHEDULER=off on the only replica, say — so the depth
      // is worth reporting next to the switch itself.
      webhookQueued: await prisma.queuedSweep.count().catch(() => 0),
      titleMapSyncedAt: s.titleMapSyncedAt?.toISOString() ?? null,
      localLoginEnabled: effectiveLocalLoginEnabled(s),
      oidcConfigured: isOidcConfigured(s),
      secretsUnreadable: raw ? hasUnreadableSecret(raw) : false,
    };
  } catch {
    return null;
  }
}

function envInfo(): EnvInfo {
  return {
    // Not a secret, and the single most common cause of a broken OIDC redirect.
    publicUrl: process.env.PUBLIC_URL || null,
    trustProxy: isTruthyEnv(process.env.TRUST_PROXY),
    ssrfAllowPrivate: isTruthyEnv(process.env.SSRF_ALLOW_PRIVATE),
    authCookieInsecure: isTruthyEnv(process.env.AUTH_COOKIE_INSECURE),
    syncConcurrency: syncConcurrency(),
    logLevel: process.env.LOG_LEVEL?.toLowerCase() || "info",
    sweepSchedulerDisabled: schedulerDisabledByEnv(),
    titleMapSchedulerDisabled: process.env.TITLE_MAP_SCHEDULER?.trim().toLowerCase() === "off",
  };
}

/** Everything the Info tab shows. Admin-only — see the route that calls it. */
export async function collectSystemInfo(): Promise<SystemInfo> {
  const [database, library, config] = await Promise.all([
    databaseInfo(),
    libraryInfo(),
    configInfo(),
  ]);
  return {
    app: appInfo(),
    database,
    library,
    config,
    env: envInfo(),
    collectedAt: new Date().toISOString(),
  };
}
