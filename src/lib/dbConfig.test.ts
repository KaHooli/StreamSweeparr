import { describe, it, expect } from "vitest";
import { resolveAdapterConfig, defaultPoolMax } from "./dbConfig";

/**
 * The URL parameters that survived the move to a driver adapter.
 *
 * Prisma 6 read `connection_limit`, `pool_timeout` and `schema` out of the
 * connection string itself. `pg` ignores all three, so this mapping is the only
 * thing keeping them working — and every case below is one an install could
 * really be in, since the README tells users to add two of them by hand.
 */

const URL_BASE = "postgresql://sweep:hunter2@db.internal:5432/streamsweeparr";

describe("resolveAdapterConfig", () => {
  it("translates the documented parameters into pg's names", () => {
    const c = resolveAdapterConfig(
      `${URL_BASE}?schema=public&connection_limit=10&pool_timeout=20`,
      4,
    );
    expect(c.max).toBe(10);
    // pool_timeout is seconds; pg counts milliseconds.
    expect(c.connectionTimeoutMillis).toBe(20_000);
    expect(c.schema).toBe("public");
    expect(c.maxFromUrl).toBe(true);
    expect(c.connectionTimeoutFromUrl).toBe(true);
  });

  it("falls back to Prisma 6's pool size when connection_limit is absent", () => {
    // An install that never touched the URL should see the pool it had before
    // the upgrade, not whatever pg would have picked.
    const c = resolveAdapterConfig(URL_BASE, 4);
    expect(c.max).toBe(defaultPoolMax(4));
    expect(c.max).toBe(9);
    expect(c.maxFromUrl).toBe(false);
  });

  it("defaults the wait to 10s rather than pg's wait-forever", () => {
    // This is the one that matters most: pg's own default is 0, meaning a
    // saturated pool hangs the request instead of reporting itself.
    const c = resolveAdapterConfig(URL_BASE, 4);
    expect(c.connectionTimeoutMillis).toBe(10_000);
    expect(c.connectionTimeoutFromUrl).toBe(false);
  });

  it("passes pool_timeout=0 through as 'no timeout', which is what it means", () => {
    const c = resolveAdapterConfig(`${URL_BASE}?pool_timeout=0`, 4);
    expect(c.connectionTimeoutMillis).toBe(0);
    expect(c.connectionTimeoutFromUrl).toBe(true);
  });

  it("ignores a connection_limit of 0, which could never serve a query", () => {
    const c = resolveAdapterConfig(`${URL_BASE}?connection_limit=0`, 4);
    expect(c.max).toBe(defaultPoolMax(4));
    expect(c.maxFromUrl).toBe(false);
  });

  it("ignores values that are not whole numbers instead of half-reading them", () => {
    // Number(), not parseInt(): "10abc" is a typo, and silently running with a
    // pool of 10 would hide it.
    for (const bad of ["10abc", "abc", "-1", "1.5", ""]) {
      const c = resolveAdapterConfig(`${URL_BASE}?connection_limit=${bad}`, 4);
      expect(c.max, `connection_limit=${bad}`).toBe(defaultPoolMax(4));
    }
  });

  it("leaves schema undefined when absent or blank, deferring to search_path", () => {
    expect(resolveAdapterConfig(URL_BASE, 4).schema).toBeUndefined();
    expect(resolveAdapterConfig(`${URL_BASE}?schema=`, 4).schema).toBeUndefined();
    expect(resolveAdapterConfig(`${URL_BASE}?schema=%20`, 4).schema).toBeUndefined();
  });

  it("holds idle connections for 5 minutes, as Prisma 6 did", () => {
    // pg would close them after 10s, so a scheduled sync would reconnect from
    // cold nearly every run.
    expect(resolveAdapterConfig(URL_BASE, 4).idleTimeoutMillis).toBe(300_000);
  });

  it("yields usable defaults for a missing or unparseable URL rather than throwing", () => {
    // PrismaPg is handed the same string moments later and reports it far
    // better than this function could.
    for (const bad of [undefined, "", "not-a-url"]) {
      const c = resolveAdapterConfig(bad, 4);
      expect(c.max).toBe(defaultPoolMax(4));
      expect(c.connectionTimeoutMillis).toBe(10_000);
      expect(c.schema).toBeUndefined();
    }
  });

  it("never returns a pool smaller than one connection", () => {
    // os.cpus() has been observed to return an empty array in containers.
    expect(defaultPoolMax(0)).toBeGreaterThanOrEqual(1);
    expect(resolveAdapterConfig(URL_BASE, 0).max).toBeGreaterThanOrEqual(1);
  });
});
