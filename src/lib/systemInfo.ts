/**
 * The shape of the Settings → Info payload, plus the pure helpers for reading
 * it. Deliberately free of database and Node imports so the client card can
 * share the formatters with the server that fills them in — the collector lives
 * next door in `collectSystemInfo.ts`.
 *
 * One rule governs the payload: **no secrets, ever.** This is the one screen
 * whose whole purpose is to be pasted into a forum post or a GitHub issue.
 * Credentials appear as "set" / "not set", never as values, and `DATABASE_URL`
 * is reduced to host, port and database name — see `describeDatabaseUrl`, which
 * is where the password stops.
 */

import { describeWatchmodeCache } from "./watchmodeCache";

export interface AppInfo {
  version: string;
  /** Commit the image was built from; empty when built outside CI. */
  commit: string;
  builtAt: string;
  nextVersion: string;
  nodeVersion: string;
  prismaVersion: string;
  environment: string;
  platform: string;
  hostname: string;
  timeZone: string;
  serverTime: string;
  uptimeSeconds: number;
  memoryRssBytes: number;
}

export interface DatabaseInfo {
  reachable: boolean;
  /** Round-trip time of a `SELECT 1`, in ms. */
  latencyMs: number | null;
  serverVersion: string | null;
  host: string | null;
  database: string | null;
  schema: string | null;
  /** Prisma pool sizing from the connection string, when set explicitly. */
  connectionLimit: string | null;
  poolTimeout: string | null;
  sizeBytes: number | null;
  connectionsUsed: number | null;
  connectionsMax: number | null;
  migrationsApplied: number | null;
  latestMigration: string | null;
  latestMigrationAt: string | null;
  /** Why a probe came back empty, when one did. */
  error: string | null;
}

export interface LibraryInfo {
  tvShows: number;
  movies: number;
  episodes: number;
  titleMapRows: number;
  users: number;
  admins: number;
  runs: number;
  lastRun: {
    id: number;
    kind: string;
    status: string;
    dryRun: boolean;
    startedAt: string;
    finishedAt: string | null;
  } | null;
}

export interface ConfigInfo {
  applyChanges: boolean;
  deleteFiles: boolean;
  purgeUnmonitoredFiles: boolean;
  searchAtEnd: boolean;
  removeMissingTmdbMovies: boolean;
  watchmodeApiKeySet: boolean;
  /** How many Watchmode keys are in the failover ring (0 when none are set). */
  watchmodeApiKeyCount: number;
  watchmodePlan: string | null;
  /**
   * The configured Watchmode cache window in days. In a bug report about credit
   * usage this is the first number worth knowing, and on a free plan it is the
   * only thing rationing the budget.
   */
  watchmodeCacheDays: number;
  countries: number;
  serviceIds: number;
  /** Which provider answers movie availability ("TMDB" | "WATCHMODE"). */
  movieProvider: string;
  tmdbApiKeySet: boolean;
  tmdbRegions: number;
  tmdbProviderIds: number;
  seerrConfigured: boolean;
  connections: { sonarr: number; radarr: number; disabled: number };
  sweepScheduleEnabled: boolean;
  sweepIntervalHours: number;
  sweepNextRunAt: string | null;
  sweepLastRunAt: string | null;
  /** Webhook-triggered sweeps: switched on, and does a token exist to use? */
  webhookEnabled: boolean;
  webhookTokenSet: boolean;
  /** Titles waiting for a webhook sweep — a number stuck above zero is a clue. */
  webhookQueued: number;
  titleMapSyncedAt: string | null;
  localLoginEnabled: boolean;
  oidcConfigured: boolean;
  secretsUnreadable: boolean;
}

/** Environment knobs, reported as read — values only, never credentials. */
export interface EnvInfo {
  publicUrl: string | null;
  trustProxy: boolean;
  ssrfAllowPrivate: boolean;
  authCookieInsecure: boolean;
  syncConcurrency: number;
  logLevel: string;
  sweepSchedulerDisabled: boolean;
  titleMapSchedulerDisabled: boolean;
}

export interface SystemInfo {
  app: AppInfo;
  database: DatabaseInfo;
  library: LibraryInfo;
  /** Null when the settings row itself couldn't be read. */
  config: ConfigInfo | null;
  env: EnvInfo;
  collectedAt: string;
}

/**
 * Host, port, database and pool settings from a connection string — and
 * nothing else. Returns nulls rather than throwing on a malformed value, since
 * "the URL is unparseable" is itself a useful thing for this page to show.
 */
export function describeDatabaseUrl(raw: string | undefined | null): {
  host: string | null;
  database: string | null;
  schema: string | null;
  connectionLimit: string | null;
  poolTimeout: string | null;
} {
  const empty = {
    host: null,
    database: null,
    schema: null,
    connectionLimit: null,
    poolTimeout: null,
  };
  if (!raw) return empty;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return empty;
  }
  // `url.host` is host:port and never the userinfo, so the password is dropped
  // here and cannot reach the response.
  return {
    host: url.host || null,
    database: url.pathname.replace(/^\//, "") || null,
    schema: url.searchParams.get("schema"),
    connectionLimit: url.searchParams.get("connection_limit"),
    poolTimeout: url.searchParams.get("pool_timeout"),
  };
}

/**
 * "PostgreSQL 16.4 (Debian 16.4-1.pgdg120+1) on x86_64…" -> "PostgreSQL 16.4".
 * The rest is build noise that pushes the useful part off the line.
 */
export function shortPostgresVersion(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const m = /^(PostgreSQL\s+[\d.]+)/i.exec(trimmed);
  return m ? m[1] : trimmed.split(/\s+on\s+/i)[0];
}

/** Seconds -> "3d 4h 12m" / "5m" / "9s". Compact enough for a value column. */
export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "unknown";
  const s = Math.floor(seconds);
  const parts: string[] = [];
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (!parts.length) parts.push(`${s % 60}s`);
  return parts.join(" ");
}

/** Bytes -> "1.4 GB". Decimal units, matching what `pg_size_pretty` implies. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "unknown";
  const units = ["B", "kB", "MB", "GB", "TB"];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${unit === 0 ? Math.round(value) : value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** ISO timestamp -> local string, or an em dash for "never". */
export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export const yesNo = (v: boolean): string => (v ? "Yes" : "No");

/**
 * "key not set" / "key set" / "3 keys set" — Watchmode can hold a ring of keys
 * that requests fail over through, and how many there are is worth knowing in a
 * bug report. Values are never included; this is a count.
 */
export function watchmodeKeySummary(cfg: {
  watchmodeApiKeySet: boolean;
  watchmodeApiKeyCount: number;
}): string {
  if (!cfg.watchmodeApiKeySet) return "key not set";
  return cfg.watchmodeApiKeyCount > 1 ? `${cfg.watchmodeApiKeyCount} keys set` : "key set";
}

/**
 * The whole payload as plain text, for the "Copy diagnostics" button.
 *
 * Built from the DTO and nothing else, so it inherits the no-secrets guarantee:
 * there is no path by which a credential could appear here without first
 * appearing on screen.
 */
export function buildDiagnosticsText(info: SystemInfo): string {
  const { app, database: db, library: lib, config: cfg, env } = info;
  const lines: string[] = [];
  const section = (title: string) => lines.push("", `## ${title}`);
  const row = (label: string, value: string | number | null | undefined) =>
    lines.push(`${label}: ${value === null || value === undefined || value === "" ? "—" : value}`);

  lines.push("# StreamSweeparr diagnostics", `Collected: ${info.collectedAt}`);

  section("Application");
  row("Version", app.version);
  row("Commit", app.commit);
  row("Built", app.builtAt);
  row("Next.js", app.nextVersion);
  row("Node", app.nodeVersion);
  row("Prisma", app.prismaVersion);
  row("Environment", app.environment);
  row("Platform", app.platform);
  row("Hostname", app.hostname);
  row("Time zone", `${app.timeZone} (server time ${app.serverTime})`);
  row("Uptime", formatUptime(app.uptimeSeconds));
  row("Memory (RSS)", formatBytes(app.memoryRssBytes));

  section("Database");
  row("Reachable", yesNo(db.reachable));
  row("Ping", db.latencyMs === null ? null : `${db.latencyMs} ms`);
  row("Server", db.serverVersion);
  row("Host", db.host);
  row("Database", db.database);
  row("Schema", db.schema);
  row("Size", db.sizeBytes === null ? null : formatBytes(db.sizeBytes));
  row(
    "Connections",
    db.connectionsUsed === null ? null : `${db.connectionsUsed} of ${db.connectionsMax ?? "?"}`
  );
  row("Pool (connection_limit / pool_timeout)", `${db.connectionLimit ?? "default"} / ${db.poolTimeout ?? "default"}`);
  row("Migrations applied", db.migrationsApplied);
  row("Latest migration", db.latestMigration && `${db.latestMigration} (${db.latestMigrationAt ?? "?"})`);
  if (db.error) row("Error", db.error);

  section("Library");
  row("TV shows", lib.tvShows);
  row("Movies", lib.movies);
  row("Episodes", lib.episodes);
  row("Title ID map rows", lib.titleMapRows);
  row("Users", `${lib.users} (${lib.admins} admin)`);
  row("Runs recorded", lib.runs);
  row(
    "Last run",
    lib.lastRun
      ? `#${lib.lastRun.id} ${lib.lastRun.kind} ${lib.lastRun.status}` +
          `${lib.lastRun.dryRun ? " (dry-run)" : ""} started ${lib.lastRun.startedAt}`
      : null
  );

  section("Configuration");
  if (!cfg) {
    row("Settings", "could not be read");
  } else {
    row("Mode", cfg.applyChanges ? "LIVE (changes applied)" : "Dry-run");
    row("Delete files", yesNo(cfg.deleteFiles));
    row("Purge unmonitored files", yesNo(cfg.purgeUnmonitoredFiles));
    row("Search at end", yesNo(cfg.searchAtEnd));
    row("Remove missing TMDB movies", yesNo(cfg.removeMissingTmdbMovies));
    row(
      "Watchmode",
      `${watchmodeKeySummary(cfg)}, plan ${cfg.watchmodePlan ?? "unknown"}, ` +
        `${cfg.countries} country/ies, ${cfg.serviceIds} service(s), ` +
        `${describeWatchmodeCache(cfg.watchmodeCacheDays)} cache`
    );
    row("Movie availability", cfg.movieProvider === "WATCHMODE" ? "Watchmode" : "TheMovieDB");
    row(
      "TMDB",
      `key ${cfg.tmdbApiKeySet ? "set" : "not set"}, ${cfg.tmdbRegions} region(s), ` +
        `${cfg.tmdbProviderIds} provider(s)` +
        // Say so rather than leaving a plausible-looking row to be read as the
        // configuration in force — this is a diagnostics screen.
        (cfg.movieProvider === "WATCHMODE" ? " (not in use)" : "")
    );
    row("Seerr", yesNo(cfg.seerrConfigured));
    row(
      "Connections",
      `${cfg.connections.sonarr} Sonarr, ${cfg.connections.radarr} Radarr, ` +
        `${cfg.connections.disabled} disabled`
    );
    row(
      "Scheduled sweeps",
      cfg.sweepScheduleEnabled
        ? `every ${cfg.sweepIntervalHours}h, next ${cfg.sweepNextRunAt ?? "?"}, last ${cfg.sweepLastRunAt ?? "never"}`
        : "off"
    );
    row(
      "Webhook sweeps",
      cfg.webhookEnabled
        ? `on, token ${cfg.webhookTokenSet ? "set" : "MISSING"}, ${cfg.webhookQueued} title(s) queued`
        : "off"
    );
    row("Title ID map refreshed", cfg.titleMapSyncedAt);
    row("Local login", yesNo(cfg.localLoginEnabled));
    row("OIDC configured", yesNo(cfg.oidcConfigured));
    row("Secrets unreadable", yesNo(cfg.secretsUnreadable));
  }

  section("Environment");
  row("PUBLIC_URL", env.publicUrl);
  row("TRUST_PROXY", yesNo(env.trustProxy));
  row("SSRF_ALLOW_PRIVATE", yesNo(env.ssrfAllowPrivate));
  row("AUTH_COOKIE_INSECURE", yesNo(env.authCookieInsecure));
  row("SYNC_CONCURRENCY", env.syncConcurrency);
  row("LOG_LEVEL", env.logLevel);
  row("Sweep scheduler disabled", yesNo(env.sweepSchedulerDisabled));
  row("Title map scheduler disabled", yesNo(env.titleMapSchedulerDisabled));

  return lines.join("\n");
}
