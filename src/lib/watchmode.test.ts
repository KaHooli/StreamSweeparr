import { describe, it, expect, vi, afterEach } from "vitest";
import {
  matchSources,
  WatchmodeClient,
  WatchmodeError,
  type WatchmodeTitleSource,
} from "./watchmode";

const src = (source_id: number, type: string, region = "US"): WatchmodeTitleSource => ({
  source_id,
  name: `svc-${source_id}`,
  type,
  region,
});

describe("matchSources", () => {
  const services = [203, 26]; // Netflix, Prime (example ids)
  const types = ["sub", "free"];

  it("returns empty for no sources", () => {
    expect(matchSources(undefined, services, types)).toEqual([]);
    expect(matchSources([], services, types)).toEqual([]);
  });

  it("matches only selected services", () => {
    const out = matchSources([src(203, "sub"), src(999, "sub")], services, types);
    expect(out.map((s) => s.source_id)).toEqual([203]);
  });

  it("matches only counted types", () => {
    const out = matchSources([src(203, "rent"), src(203, "sub")], services, types);
    expect(out.map((s) => s.type)).toEqual(["sub"]);
  });

  it("dedupes by source + region", () => {
    const out = matchSources([src(203, "sub", "US"), src(203, "sub", "US")], services, types);
    expect(out).toHaveLength(1);
  });

  it("keeps the same service across different regions", () => {
    const out = matchSources([src(203, "sub", "US"), src(203, "sub", "GB")], services, types);
    expect(out).toHaveLength(2);
  });

  it("excludes purchase/rent when not counted", () => {
    const out = matchSources([src(203, "purchase"), src(26, "free")], services, types);
    expect(out.map((s) => s.source_id)).toEqual([26]);
  });
});

/**
 * Key failover.
 *
 * A free Watchmode key is a small credit budget, so several can be configured.
 * The contract: every request starts at key 1, a key that answers 401/403/429
 * is retired for the life of the client, and any other failure is reported as
 * itself rather than burning credits on the next key.
 *
 * Responses are cached in-process by URL, so each test uses its own title id.
 */
describe("WatchmodeClient key failover", () => {
  let nextTitleId = 1000;
  const titleId = () => nextTitleId++;

  /** Keys seen by fetch, in call order. */
  const keysUsed: string[] = [];

  /** Answer each key with a status code, or 200 + body when not listed. */
  const mockFetch = (byKey: Record<string, number>, body: unknown = []) => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const key = new Headers(init.headers).get("X-API-Key") ?? "";
      keysUsed.push(key);
      const status = byKey[key] ?? 200;
      return new Response(status === 200 ? JSON.stringify(body) : "nope", { status });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  afterEach(() => {
    keysUsed.length = 0;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("requires at least one key", () => {
    expect(() => new WatchmodeClient([])).toThrow(WatchmodeError);
    expect(() => new WatchmodeClient("")).toThrow(WatchmodeError);
    expect(() => new WatchmodeClient(["  "])).toThrow(WatchmodeError);
  });

  it("collapses duplicate keys so failover can't land on a spent one", () => {
    expect(new WatchmodeClient(["a", "a", "b"]).keyCount).toBe(2);
  });

  it("starts at key 1", async () => {
    mockFetch({});
    const wm = new WatchmodeClient(["k1", "k2"]);
    expect(wm.activeKeyNumber).toBe(1);
    await wm.titleSources(titleId(), ["US"]);
    expect(keysUsed).toEqual(["k1"]);
  });

  it("moves to the next key when one is out of quota, and reports it", async () => {
    mockFetch({ k1: 401 }, [{ source_id: 203 }]);
    const exhausted: number[] = [];
    const wm = new WatchmodeClient(["k1", "k2"], {
      onKeyExhausted: ({ number, total }) => {
        exhausted.push(number);
        expect(total).toBe(2);
      },
    });

    const out = await wm.titleSources(titleId(), ["US"]);
    expect(out).toEqual([{ source_id: 203 }]);
    expect(keysUsed).toEqual(["k1", "k2"]);
    expect(exhausted).toEqual([1]);
    expect(wm.activeKeyNumber).toBe(2);
  });

  it("treats a rate-limited key as spent", async () => {
    mockFetch({ k1: 429 });
    const wm = new WatchmodeClient(["k1", "k2"]);
    await wm.titleSources(titleId(), ["US"]);
    expect(keysUsed).toEqual(["k1", "k2"]);
  });

  it("does not retry a retired key on later requests", async () => {
    mockFetch({ k1: 403 });
    const wm = new WatchmodeClient(["k1", "k2"]);
    await wm.titleSources(titleId(), ["US"]);
    keysUsed.length = 0;

    await wm.titleSources(titleId(), ["US"]);
    // Key 1 is spent; spending another request on it would be the whole cost
    // this feature exists to avoid.
    expect(keysUsed).toEqual(["k2"]);
  });

  it("fails with the last key's error once every key is spent", async () => {
    mockFetch({ k1: 401, k2: 429 });
    const wm = new WatchmodeClient(["k1", "k2"]);

    await expect(wm.titleSources(titleId(), ["US"])).rejects.toThrow(/rate limit .* key 2/i);
    expect(keysUsed).toEqual(["k1", "k2"]);
    expect(wm.activeKeyNumber).toBeNull();

    // And it stops calling out entirely rather than retrying spent keys.
    keysUsed.length = 0;
    await expect(wm.titleSources(titleId(), ["US"])).rejects.toThrow(WatchmodeError);
    expect(keysUsed).toEqual([]);
  });

  it("does not fail over on an error that isn't about the key", async () => {
    mockFetch({ k1: 500 });
    const wm = new WatchmodeClient(["k1", "k2"]);

    await expect(wm.titleSources(titleId(), ["US"])).rejects.toThrow(/failed \(500\)/);
    expect(keysUsed).toEqual(["k1"]);
    // A server-side failure says nothing about the key, so it stays in the ring.
    expect(wm.activeKeyNumber).toBe(1);
  });

  it("names the failing key only when there is more than one", async () => {
    mockFetch({ solo: 401 });
    const wm = new WatchmodeClient(["solo"]);
    await expect(wm.titleSources(titleId(), ["US"])).rejects.toThrow(
      "Watchmode rejected API key (invalid or over quota)."
    );
  });

  it("reads the plan from one key instead of probing them all", async () => {
    // Every key on a free account answers 403 here, so rotating would spend a
    // request per key to reach the same verdict.
    mockFetch({ k1: 403, k2: 403 });
    const wm = new WatchmodeClient(["k1", "k2"]);
    expect(await wm.detectPlan()).toBe("free");
    expect(keysUsed).toEqual(["k1"]);
  });

  it("reports the checked key's own status rather than failing over", async () => {
    mockFetch({ k1: 401 });
    const wm = new WatchmodeClient(["k1", "k2"]);
    await expect(wm.status()).rejects.toThrow(/rejected API key 1/);
    expect(keysUsed).toEqual(["k1"]);
  });
});
