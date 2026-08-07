/**
 * Behavioural tests for `public/sw.js`.
 *
 * The worker ships as a plain classic script — it cannot import from `src/`,
 * and the browser is the only thing that normally runs it — so this file loads
 * the real file and calls its event handlers against a stand-in
 * ServiceWorkerGlobalScope. Testing the shipped artefact rather than a copy of
 * its logic is the point: the rules that matter here are the ones about what is
 * *not* cached, and a re-implementation would happily agree with itself.
 *
 * It lives under `src/test/` because the unit suite only collects tests from
 * `src/`, and the subject sits in `public/`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SW_PATH = fileURLToPath(new URL("../../public/sw.js", import.meta.url));
const ORIGIN = "https://sweep.test";

interface FakeResponse {
  url: string;
  ok: boolean;
  type: string;
  redirected: boolean;
  clone(): FakeResponse;
}

function response(url: string, overrides: Partial<FakeResponse> = {}): FakeResponse {
  const res: FakeResponse = {
    url,
    ok: true,
    type: "basic",
    redirected: false,
    clone: () => ({ ...res }),
    ...overrides,
  };
  return res;
}

/** Minimal CacheStorage: a map of cache name -> (url -> response). */
function fakeCaches() {
  const store = new Map<string, Map<string, FakeResponse>>();
  const keyOf = (req: unknown) =>
    typeof req === "string" ? req : ((req as { url: string }).url as string);

  return {
    store,
    open: async (name: string) => {
      if (!store.has(name)) store.set(name, new Map());
      const entries = store.get(name)!;
      return {
        match: async (req: unknown) => entries.get(keyOf(req)),
        put: async (req: unknown, res: FakeResponse) => void entries.set(keyOf(req), res),
      };
    },
    keys: async () => [...store.keys()],
    delete: async (name: string) => store.delete(name),
  };
}

function loadWorker() {
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const caches = fakeCaches();

  const self = {
    location: { origin: ORIGIN },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn() },
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), handler]);
    },
  };

  // `fetch` answers with a basic 200 unless a test overrides it.
  const fetchMock = vi.fn(async (req: { url: string }) => response(req.url));

  class FakeRequest {
    url: string;
    init: unknown;
    constructor(url: string, init?: unknown) {
      this.url = url;
      this.init = init;
    }
  }

  const source = readFileSync(SW_PATH, "utf8");
  // The worker's globals are handed in as parameters, which is what makes the
  // real file runnable outside a browser without editing it for testability.
  new Function("self", "caches", "fetch", "Request", source)(self, caches, fetchMock, FakeRequest);

  const fire = async (type: string, event: Record<string, unknown>) => {
    const handlers = listeners.get(type);
    if (!handlers?.length) throw new Error(`no ${type} listener registered`);
    for (const handler of handlers) handler(event);
  };

  return {
    self,
    caches,
    fetchMock,
    /** Run install/activate and settle whatever they passed to waitUntil. */
    lifecycle: async (type: "install" | "activate") => {
      const pending: Promise<unknown>[] = [];
      await fire(type, { waitUntil: (p: Promise<unknown>) => pending.push(p) });
      await Promise.all(pending);
    },
    /**
     * Dispatch a fetch event. Resolves to the response the worker took over
     * with, or `undefined` when it declined to handle the request at all.
     */
    request: async (
      url: string,
      { method = "GET", mode = "no-cors" }: { method?: string; mode?: string } = {}
    ) => {
      let handled: Promise<FakeResponse> | undefined;
      await fire("fetch", {
        request: { url: new URL(url, ORIGIN).toString(), method, mode },
        respondWith: (p: Promise<FakeResponse>) => {
          handled = p;
        },
      });
      return handled ? await handled : undefined;
    },
  };
}

let sw: ReturnType<typeof loadWorker>;

beforeEach(() => {
  sw = loadWorker();
});

describe("service worker lifecycle", () => {
  it("precaches the offline page and the install assets", async () => {
    await sw.lifecycle("install");

    const cache = [...sw.caches.store.values()][0];
    expect([...cache.keys()]).toContain("/offline.html");
    expect([...cache.keys()]).toContain("/manifest.webmanifest");
    expect(sw.self.skipWaiting).toHaveBeenCalled();
  });

  it("still installs when an asset cannot be fetched", async () => {
    sw.fetchMock.mockRejectedValue(new Error("offline"));
    await expect(sw.lifecycle("install")).resolves.toBeUndefined();
  });

  it("drops caches from older versions and leaves other apps' caches alone", async () => {
    await sw.lifecycle("install");
    const current = [...sw.caches.store.keys()][0];
    sw.caches.store.set("streamsweeparr-static-v0", new Map());
    sw.caches.store.set("some-other-app", new Map());

    await sw.lifecycle("activate");

    expect([...sw.caches.store.keys()].sort()).toEqual([current, "some-other-app"].sort());
    expect(sw.self.clients.claim).toHaveBeenCalled();
  });
});

describe("service worker request routing", () => {
  it("never intercepts API traffic", async () => {
    expect(await sw.request("/api/dashboard")).toBeUndefined();
    expect(await sw.request("/api/settings", { mode: "cors" })).toBeUndefined();
  });

  it("never intercepts non-GET requests or other origins", async () => {
    expect(await sw.request("/", { method: "POST", mode: "navigate" })).toBeUndefined();
    expect(await sw.request("https://api.watchmode.com/v1/title")).toBeUndefined();
  });

  it("passes RSC and other unrecognised requests straight through", async () => {
    expect(await sw.request("/runs?_rsc=1a2b3")).toBeUndefined();
  });

  it("serves hashed build assets from the cache on the second request", async () => {
    const url = "/_next/static/chunks/main-abc123.js";
    await sw.request(url);
    expect(sw.fetchMock).toHaveBeenCalledTimes(1);

    const again = await sw.request(url);
    expect(again).toBeDefined();
    expect(sw.fetchMock).toHaveBeenCalledTimes(1); // served from cache
  });

  it("does not cache a redirect — an expired session must not pin the login page", async () => {
    sw.fetchMock.mockResolvedValue(
      response(`${ORIGIN}/login`, { redirected: true, ok: true, type: "basic" })
    );
    const url = "/icons/pwa-192x192.png";

    await sw.request(url);
    await sw.request(url);

    expect(sw.fetchMock).toHaveBeenCalledTimes(2);
    const cache = [...sw.caches.store.values()][0];
    expect(cache?.has(url)).toBeFalsy();
  });

  it("does not cache error responses", async () => {
    sw.fetchMock.mockResolvedValue(response(`${ORIGIN}/icons/x.png`, { ok: false }));
    await sw.request("/icons/x.png");
    await sw.request("/icons/x.png");
    expect(sw.fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("service worker navigation handling", () => {
  it("goes to the network for documents and keeps nothing", async () => {
    await sw.lifecycle("install");
    sw.fetchMock.mockClear();

    const res = await sw.request("/runs", { mode: "navigate" });
    expect(res?.url).toBe(`${ORIGIN}/runs`);

    const cache = [...sw.caches.store.values()][0];
    expect([...cache.keys()]).not.toContain(`${ORIGIN}/runs`);

    // A second visit still asks the server — no cached page for a signed-out
    // browser (or a different user) to find.
    await sw.request("/runs", { mode: "navigate" });
    expect(sw.fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to the offline page when the server is unreachable", async () => {
    await sw.lifecycle("install");
    sw.fetchMock.mockRejectedValue(new Error("network down"));

    const res = await sw.request("/runs", { mode: "navigate" });
    expect(res?.url).toBe("/offline.html");
  });

  it("propagates the failure when there is no offline page cached", async () => {
    sw.fetchMock.mockRejectedValue(new Error("network down"));
    await expect(sw.request("/", { mode: "navigate" })).rejects.toThrow("network down");
  });
});
