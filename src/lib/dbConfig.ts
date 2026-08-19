/**
 * `DATABASE_URL` → pg driver adapter configuration.
 *
 * Three of the parameters this app documents in its connection string are
 * Prisma's own inventions, not PostgreSQL's: `connection_limit`, `pool_timeout`
 * and `schema`. Until Prisma 7 the Rust engine read all three out of the URL.
 * Driver adapters hand the connection to `pg` instead, which understands none
 * of them — it silently ignores unknown query parameters — so anything the app
 * still wants honoured has to be translated into adapter options here.
 *
 * Left alone, each one fails quietly rather than loudly:
 *
 *   - `connection_limit` is the one knob the README offers for "pages time out
 *     on a small NAS", and the Settings → Info row displaying it would have
 *     gone on reporting a number that no longer did anything.
 *   - `pool_timeout` is worse than inert if dropped. `pg` defaults
 *     `connectionTimeoutMillis` to 0, meaning *wait forever*, where Prisma 6
 *     gave up and raised an error naming the pool. On exactly the small hosts
 *     that troubleshooting row is written for, that is the difference between a
 *     page that reports a saturated pool and one that hangs.
 *   - `schema` decides which schema the queries even address. An install that
 *     set it to anything but the search_path default would read and write the
 *     wrong tables, and find an empty library rather than an error.
 *
 * So the URL stays the interface it always was; only the code behind it moved.
 * Every value is set explicitly rather than left to the driver's defaults.
 *
 * This module is deliberately free of imports so the mapping can be unit
 * tested without a database, a client, or a `pg` install.
 */

/** What `PrismaPg` is handed, and what Settings → Info reports. */
export interface AdapterConfig {
  /** Maximum connections held open. Prisma 6 called this `connection_limit`. */
  max: number;
  /**
   * How long a caller waits for a free connection before erroring, in ms.
   * Prisma 6 called this `pool_timeout` and counted in seconds. 0 disables the
   * timeout in both systems.
   */
  connectionTimeoutMillis: number;
  /** How long an unused connection is kept before being closed, in ms. */
  idleTimeoutMillis: number;
  /**
   * The schema queries are addressed to. `undefined` leaves it to the
   * connection's search_path, which is what an install with no `?schema=` has
   * always got.
   */
  schema: string | undefined;
  /** True when the value came from the URL rather than from the default. */
  maxFromUrl: boolean;
  connectionTimeoutFromUrl: boolean;
}

/**
 * Prisma 6's default pool timeout was 10 seconds. `pg` would default to 0 —
 * no timeout at all — which turns pool exhaustion from an error into a hang.
 */
const DEFAULT_POOL_TIMEOUT_MS = 10_000;

/**
 * Prisma 6 held idle connections for 5 minutes. `pg` defaults to 10 seconds,
 * which on an app that syncs on a timer means reconnecting from cold on almost
 * every run. Nothing here is latency-critical enough to care about the extra
 * sockets, and reconnect storms against a small Postgres are a real cost.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 300_000;

/**
 * Prisma 6 sized the pool at `cpus * 2 + 1` when `connection_limit` was absent.
 * Keeping that formula means an install that never touched the URL sees the
 * same pool it had before the upgrade.
 */
export function defaultPoolMax(cpuCount: number): number {
  return Math.max(1, Math.floor(cpuCount)) * 2 + 1;
}

/** Parse a query parameter that must be a non-negative integer. */
function readInt(params: URLSearchParams, name: string): number | null {
  const raw = params.get(name);
  if (raw === null || raw.trim() === "") return null;
  // Number() rather than parseInt(): "10abc" should be rejected, not read as 10.
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

/**
 * Translate the Prisma-specific parameters in a connection string into the
 * adapter options that now govern them.
 *
 * A URL that cannot be parsed is not an error here — `PrismaPg` is about to be
 * handed the same string and will produce a far better message than anything
 * this function could invent, so an unparseable URL simply yields the defaults.
 *
 * `cpuCount` is a parameter rather than an `os.cpus()` call so the mapping
 * stays pure and the tests can pin a machine size.
 */
export function resolveAdapterConfig(
  rawUrl: string | undefined,
  cpuCount: number,
): AdapterConfig {
  const fallback: AdapterConfig = {
    max: defaultPoolMax(cpuCount),
    connectionTimeoutMillis: DEFAULT_POOL_TIMEOUT_MS,
    idleTimeoutMillis: DEFAULT_IDLE_TIMEOUT_MS,
    schema: undefined,
    maxFromUrl: false,
    connectionTimeoutFromUrl: false,
  };
  if (!rawUrl) return fallback;

  let params: URLSearchParams;
  try {
    params = new URL(rawUrl).searchParams;
  } catch {
    return fallback;
  }

  // A pool of zero can never hand out a connection, so it is treated as absent
  // rather than faithfully translated into a deadlock.
  const limit = readInt(params, "connection_limit");
  const timeoutSeconds = readInt(params, "pool_timeout");
  const schema = params.get("schema")?.trim();

  return {
    max: limit && limit > 0 ? limit : fallback.max,
    // 0 is meaningful — both Prisma and pg read it as "no timeout" — so it is
    // passed through rather than falling back to the default.
    connectionTimeoutMillis:
      timeoutSeconds === null ? fallback.connectionTimeoutMillis : timeoutSeconds * 1000,
    idleTimeoutMillis: fallback.idleTimeoutMillis,
    schema: schema ? schema : undefined,
    maxFromUrl: Boolean(limit && limit > 0),
    connectionTimeoutFromUrl: timeoutSeconds !== null,
  };
}
