import { describe, it, expect, vi, afterEach } from "vitest";
import {
  matchTmdbProviders,
  isTmdbNotFound,
  TmdbClient,
  TmdbError,
  type TmdbRegionAvailability,
} from "./tmdb";
import { ProviderThrottle } from "./providerThrottle";

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
    expect(isTmdbNotFound(new TmdbError("TMDB is rate limiting requests.", 429))).toBe(false);
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

/**
 * Rate limits.
 *
 * TMDB has no key ring and its calls are free, so the only thing a 429 can cost
 * is the answer itself: refused once and given up on, the movie is recorded as
 * `streamingUnknown` for that sync even though TMDB would have answered a second
 * later. Retrying it — and pacing what follows, so the queue behind it does not
 * trip the same limit — is the whole of the fix.
 *
 * Responses are cached in-process, so each test uses its own movie id.
 */
describe("TmdbClient rate limits", () => {
  let nextMovieId = 5000;
  const movieId = () => nextMovieId++;

  /**
   * Answer with each status in turn; the last entry answers every call after it.
   */
  const mockFetch = (statuses: number[], headers: Record<string, string> = {}) => {
    let n = 0;
    const fetchMock = vi.fn(async () => {
      const status = statuses[Math.min(n++, statuses.length - 1)];
      return new Response(status === 200 ? JSON.stringify({ results: { US: {} } }) : "nope", {
        status,
        headers: status === 429 ? headers : undefined,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  /** A throttle whose waiting advances a fake clock rather than real time. */
  const fakeThrottle = () => {
    let clock = 1_000_000;
    const throttle = new ProviderThrottle({
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    return { throttle, elapsed: () => clock - 1_000_000 };
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("waits and retries rather than losing the title to one refusal", async () => {
    const fetchMock = mockFetch([429, 200]);
    const { throttle, elapsed } = fakeThrottle();
    const tmdb = new TmdbClient("key", { throttle });

    await expect(tmdb.movieWatchProviders(movieId())).resolves.toEqual({ US: {} });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(elapsed()).toBe(1_000);
  });

  it("honours Retry-After instead of its own backoff", async () => {
    mockFetch([429, 200], { "retry-after": "3" });
    const { throttle, elapsed } = fakeThrottle();
    const tmdb = new TmdbClient("key", { throttle });

    await tmdb.movieWatchProviders(movieId());
    expect(elapsed()).toBe(3_000);
  });

  it("paces the requests that follow, and reports that it is doing so", async () => {
    mockFetch([429, 200]);
    const { throttle } = fakeThrottle();
    const paced: number[] = [];
    const tmdb = new TmdbClient("key", {
      throttle,
      onRateLimited: ({ intervalMs, escalated }) => {
        if (escalated) paced.push(intervalMs);
      },
    });

    await tmdb.movieWatchProviders(movieId());
    expect(paced).toEqual([250]);
    expect(throttle.intervalMs).toBe(250);
  });

  it("gives up after a bounded number of attempts, saying what would help", async () => {
    const fetchMock = mockFetch([429]);
    const { throttle } = fakeThrottle();
    const tmdb = new TmdbClient("key", { throttle });

    await expect(tmdb.movieWatchProviders(movieId())).rejects.toThrow(/SYNC_CONCURRENCY/);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not retry anything that isn't a rate limit", async () => {
    const fetchMock = mockFetch([404]);
    const { throttle } = fakeThrottle();
    const tmdb = new TmdbClient("key", { throttle });

    // A dead TMDB id is an answer, not a hiccup — Radarr keeps them around and
    // re-asking three more times would only slow every sync down.
    await expect(tmdb.movieWatchProviders(movieId())).rejects.toSatisfy(isTmdbNotFound);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
