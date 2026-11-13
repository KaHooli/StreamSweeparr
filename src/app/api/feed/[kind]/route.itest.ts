import { describe, it, expect, beforeEach, afterAll } from "vitest";

/**
 * The streaming-link feed, driven end to end against a real database.
 *
 * Like the webhook, this route answers without a session, so much of what is
 * checked is what it refuses. The rest is what it lists: only titles on the
 * user's services, never skipped ones, one entry per title across instances.
 */

import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { encryptSecret } from "@/lib/secrets";
import { resetAllRateLimits } from "@/lib/ratelimit";
import { GET } from "./route";
import { resetDatabase, makeSettings, makeConnection, makeMediaItem } from "@/test/dbHelpers";

const KEY = "test-feed-key";

beforeEach(async () => {
  await resetDatabase();
  resetAllRateLimits();
  process.env.AUTH_SECRET = "integration-test-secret-that-is-long-enough";
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function feedOn() {
  return makeSettings({ feedEnabled: true, feedToken: encryptSecret(KEY) });
}

function get(
  kind: string,
  opts: { key?: string | null; query?: string; headers?: Record<string, string> } = {}
) {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.key !== null) headers["X-Api-Key"] = opts.key ?? KEY;
  return GET(new NextRequest(`http://localhost/api/feed/${kind}${opts.query ?? ""}`, { headers }), {
    params: Promise.resolve({ kind }),
  });
}

const netflix = (webUrl: string | null = null) => ({
  sourceId: 203,
  name: "Netflix",
  type: "sub",
  region: "AU",
  logo: null,
  webUrl,
});

/** A title with `streamingInfo` set, which the fixture helper does not take. */
async function makeTitle(
  connectionId: number,
  over: Parameters<typeof makeMediaItem>[1] & { streamingInfo?: unknown } = {}
) {
  const { streamingInfo, ...rest } = over;
  const item = await makeMediaItem(connectionId, rest);
  if (streamingInfo !== undefined) {
    await prisma.mediaItem.update({
      where: { id: item.id },
      data: { streamingInfo: streamingInfo as object },
    });
  }
  return item;
}

describe("feed — authentication", () => {
  it("refuses everything while the feed is switched off", async () => {
    await makeSettings({ feedEnabled: false, feedToken: encryptSecret(KEY) });
    expect((await get("tv")).status).toBe(503);
  });

  it("says the key is missing rather than blaming the switch", async () => {
    await makeSettings({ feedEnabled: true });
    const res = await get("tv");
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/No feed key is stored/);
  });

  it("refuses a wrong or missing key", async () => {
    await feedOn();
    expect((await get("tv", { key: "wrong" })).status).toBe(401);
    expect((await get("tv", { key: null })).status).toBe(401);
  });

  it("does not accept the webhook token in place of the feed key", async () => {
    await makeSettings({
      feedEnabled: true,
      feedToken: encryptSecret(KEY),
      webhookEnabled: true,
      webhookToken: encryptSecret("the-webhook-token"),
    });
    expect((await get("tv", { key: "the-webhook-token" })).status).toBe(401);
  });

  it("accepts the key as a bearer token or in the query string", async () => {
    await feedOn();
    expect((await get("tv", { key: null, headers: { Authorization: `Bearer ${KEY}` } })).status).toBe(
      200
    );
    expect((await get("tv", { key: null, query: `?apikey=${KEY}` })).status).toBe(200);
  });

  it("throttles a caller guessing at the key", async () => {
    await feedOn();
    for (let i = 0; i < 5; i++) {
      expect((await get("tv", { key: `guess-${i}` })).status).toBe(401);
    }
    const res = await get("tv", { key: "guess-6" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  it("404s an unknown feed", async () => {
    await feedOn();
    expect((await get("music")).status).toBe(404);
  });
});

describe("feed — contents", () => {
  it("lists only TV titles on the user's services, and not skipped ones", async () => {
    await feedOn();
    const sonarr = await makeConnection({ type: "SONARR", name: "Sonarr" });
    const radarr = await makeConnection({
      type: "RADARR",
      name: "Radarr",
      baseUrl: "http://radarr.test:7878",
    });
    await makeTitle(sonarr.id, {
      type: "TV",
      arrId: 1,
      title: "Andor",
      tmdbId: 83867,
      onStreaming: true,
      streamingInfo: [netflix("https://www.netflix.com/title/1")],
    });
    await makeTitle(sonarr.id, { type: "TV", arrId: 2, title: "Not Streaming", tmdbId: 2 });
    await makeTitle(sonarr.id, {
      type: "TV",
      arrId: 3,
      title: "Skipped",
      tmdbId: 3,
      onStreaming: true,
      skipped: true,
      streamingInfo: [netflix()],
    });
    await makeTitle(radarr.id, {
      type: "MOVIE",
      arrId: 1,
      title: "Heat",
      tmdbId: 949,
      onStreaming: true,
      streamingInfo: [netflix()],
    });

    const tv = await (await get("tv")).json();
    expect(tv.type).toBe("tv");
    expect(tv.count).toBe(1);
    expect(tv.items[0]).toMatchObject({
      title: "Andor",
      tmdbId: 83867,
      episodes: { streaming: 0, total: 0 },
      services: [{ name: "Netflix", url: "https://www.netflix.com/title/1", linkKind: "direct" }],
    });

    const movies = await (await get("movies")).json();
    expect(movies.items.map((i: { title: string }) => i.title)).toEqual(["Heat"]);
    expect(movies.items[0].services[0].linkKind).toBe("search");
    expect(movies.items[0]).not.toHaveProperty("episodes");
  });

  it("merges one title held by two instances into one entry", async () => {
    await feedOn();
    const main = await makeConnection({ type: "SONARR", name: "Sonarr" });
    const uhd = await makeConnection({
      type: "SONARR",
      name: "Sonarr 4K",
      baseUrl: "http://sonarr4k.test:8989",
    });
    for (const conn of [main, uhd]) {
      await makeTitle(conn.id, {
        type: "TV",
        title: "Andor",
        tmdbId: 83867,
        onStreaming: true,
        streamingInfo: [netflix(conn.id === uhd.id ? "https://www.netflix.com/title/1" : null)],
      });
    }

    const tv = await (await get("tv")).json();
    expect(tv.count).toBe(1);
    expect(tv.items[0].services).toHaveLength(1);
    expect(tv.items[0].services[0].linkKind).toBe("direct");
  });

  it("narrows to the requested tmdbIds, and rejects a malformed one", async () => {
    await feedOn();
    const radarr = await makeConnection({ type: "RADARR" });
    for (const [arrId, tmdbId, title] of [
      [1, 949, "Heat"],
      [2, 680, "Pulp Fiction"],
      [3, 603, "The Matrix"],
    ] as const) {
      await makeTitle(radarr.id, {
        type: "MOVIE",
        arrId,
        title,
        tmdbId,
        onStreaming: true,
        streamingInfo: [netflix()],
      });
    }

    const some = await (await get("movies", { query: "?tmdbId=949,603" })).json();
    expect(some.items.map((i: { tmdbId: number }) => i.tmdbId).sort()).toEqual([603, 949]);

    expect((await get("movies", { query: "?tmdbId=heat" })).status).toBe(400);
  });

  it("answers a repeat request with 304 until the snapshot changes", async () => {
    await feedOn();
    const radarr = await makeConnection({ type: "RADARR" });
    const heat = await makeTitle(radarr.id, {
      type: "MOVIE",
      title: "Heat",
      tmdbId: 949,
      onStreaming: true,
      streamingInfo: [netflix()],
    });

    const first = await get("movies");
    const etag = first.headers.get("ETag");
    expect(etag).toBeTruthy();
    expect(first.headers.get("Cache-Control")).toBe("private, no-cache");

    const again = await get("movies", { headers: { "If-None-Match": etag! } });
    expect(again.status).toBe(304);

    await prisma.mediaItem.update({
      where: { id: heat.id },
      data: { streamingInfo: [netflix("https://www.netflix.com/title/2")] },
    });
    const changed = await get("movies", { headers: { "If-None-Match": etag! } });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("ETag")).not.toBe(etag);
  });
});
