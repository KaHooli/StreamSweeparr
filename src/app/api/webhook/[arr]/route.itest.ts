import { describe, it, expect, beforeEach, afterAll } from "vitest";

/**
 * The webhook receiver, driven end to end against a real database.
 *
 * This is the one route that answers without a session, so what is checked here
 * is mostly what it *refuses*: a wrong token, a switched-off feature, an
 * ambiguous instance. The happy path is checked by what it leaves behind — a
 * queued title, and nothing else.
 */

import { NextRequest } from "next/server";
import { prisma, getSettings } from "@/lib/db";
import { encryptSecret } from "@/lib/secrets";
import { resetAllRateLimits } from "@/lib/ratelimit";
import { POST } from "./route";
import { resetDatabase, makeSettings, makeConnection } from "@/test/dbHelpers";

const TOKEN = "test-webhook-token";

beforeEach(async () => {
  await resetDatabase();
  resetAllRateLimits();
  process.env.AUTH_SECRET = "integration-test-secret-that-is-long-enough";
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function webhooksOn() {
  return makeSettings({ webhookEnabled: true, webhookToken: encryptSecret(TOKEN) });
}

function post(
  arr: string,
  body: unknown,
  opts: { token?: string | null; connectionId?: number; headers?: Record<string, string> } = {}
) {
  const url = new URL(`http://localhost/api/webhook/${arr}`);
  if (opts.token !== null) url.searchParams.set("token", opts.token ?? TOKEN);
  if (opts.connectionId != null) url.searchParams.set("connection", String(opts.connectionId));
  return POST(
    new NextRequest(url, {
      method: "POST",
      body: JSON.stringify(body),
      headers: opts.headers,
    }),
    { params: Promise.resolve({ arr }) }
  );
}

const seriesAdd = (id: number, title = "Severance") => ({
  eventType: "SeriesAdd",
  instanceName: "Sonarr",
  series: { id, title, tvdbId: 371980 },
});

const movieAdded = (id: number, title = "Arrival") => ({
  eventType: "MovieAdded",
  instanceName: "Radarr",
  movie: { id, title, year: 2016 },
});

describe("webhook receiver — authentication", () => {
  it("refuses everything while webhook sweeps are switched off", async () => {
    await makeSettings({ webhookEnabled: false });
    await makeConnection({ type: "SONARR" });

    const res = await post("sonarr", seriesAdd(42));
    expect(res.status).toBe(503);
    expect(await prisma.queuedSweep.count()).toBe(0);
  });

  it("refuses a wrong or missing token", async () => {
    await webhooksOn();
    await makeConnection({ type: "SONARR" });

    expect((await post("sonarr", seriesAdd(42), { token: "wrong" })).status).toBe(401);
    expect((await post("sonarr", seriesAdd(42), { token: null })).status).toBe(401);
    expect(await prisma.queuedSweep.count()).toBe(0);
  });

  it("accepts the token as a bearer header or a basic-auth password", async () => {
    await webhooksOn();
    const conn = await makeConnection({ type: "SONARR" });

    const bearer = await post("sonarr", seriesAdd(1), {
      token: null,
      connectionId: conn.id,
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(bearer.status).toBe(202);

    const basic = await post("sonarr", seriesAdd(2), {
      token: null,
      connectionId: conn.id,
      headers: { Authorization: `Basic ${Buffer.from(`user:${TOKEN}`).toString("base64")}` },
    });
    expect(basic.status).toBe(202);
    expect(await prisma.queuedSweep.count()).toBe(2);
  });

  it("throttles a caller guessing at the token", async () => {
    await webhooksOn();
    await makeConnection({ type: "SONARR" });

    for (let i = 0; i < 5; i++) {
      expect((await post("sonarr", seriesAdd(1), { token: `guess-${i}` })).status).toBe(401);
    }
    const res = await post("sonarr", seriesAdd(1), { token: "guess-6" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  it("says the token is missing rather than blaming the switch", async () => {
    // Switched on, but the stored token can no longer be decrypted — the shape
    // an AUTH_SECRET change leaves behind.
    await makeSettings({ webhookEnabled: true, webhookToken: null });
    await makeConnection({ type: "SONARR" });

    const res = await post("sonarr", seriesAdd(42));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/no webhook token is stored/i);
  });

  it("does not answer for an *arr it has no endpoint for", async () => {
    await webhooksOn();
    expect((await post("lidarr", { eventType: "AlbumAdd" })).status).toBe(404);
  });
});

describe("webhook receiver — queueing", () => {
  it("queues a newly added series and answers immediately", async () => {
    await webhooksOn();
    const conn = await makeConnection({ type: "SONARR" });

    const res = await post("sonarr", seriesAdd(42), { connectionId: conn.id });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ ok: true, queued: true, title: "Severance" });

    const queued = await prisma.queuedSweep.findMany();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      connectionId: conn.id,
      mediaType: "TV",
      arrId: 42,
      title: "Severance",
      eventType: "SeriesAdd",
      claimedAt: null,
    });
  });

  it("queues a newly added movie", async () => {
    await webhooksOn();
    const conn = await makeConnection({ type: "RADARR" });

    expect((await post("radarr", movieAdded(7), { connectionId: conn.id })).status).toBe(202);
    const queued = await prisma.queuedSweep.findFirstOrThrow();
    expect(queued).toMatchObject({ mediaType: "MOVIE", arrId: 7, title: "Arrival" });
  });

  it("collapses a repeated webhook into one queued sweep", async () => {
    await webhooksOn();
    const conn = await makeConnection({ type: "SONARR" });

    await post("sonarr", seriesAdd(42), { connectionId: conn.id });
    await post("sonarr", seriesAdd(42, "Severance (2022)"), { connectionId: conn.id });

    const queued = await prisma.queuedSweep.findMany();
    expect(queued).toHaveLength(1);
    expect(queued[0].title).toBe("Severance (2022)");
  });

  it("survives two webhooks for the same title racing each other", async () => {
    await webhooksOn();
    const conn = await makeConnection({ type: "SONARR" });

    // A bulk import fires these in parallel, and the queue's unique key is what
    // collapses them — but only if the losing insert is handled.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => post("sonarr", seriesAdd(42), { connectionId: conn.id }))
    );
    expect(results.every((r) => r.status === 202)).toBe(true);
    expect(await prisma.queuedSweep.count()).toBe(1);
  });

  it("answers the Test button without queueing anything", async () => {
    await webhooksOn();
    const conn = await makeConnection({ type: "SONARR", name: "Sonarr HD" });

    const res = await post(
      "sonarr",
      { eventType: "Test", series: { id: 1, title: "Test Title" } },
      { connectionId: conn.id }
    );
    expect(res.status).toBe(200);
    expect((await res.json()).message).toContain("Sonarr HD");
    expect(await prisma.queuedSweep.count()).toBe(0);
  });

  it("acknowledges triggers it does not act on, so the *arr log stays clean", async () => {
    await webhooksOn();
    const conn = await makeConnection({ type: "SONARR" });

    const res = await post(
      "sonarr",
      { eventType: "Download", series: { id: 42, title: "Severance" } },
      { connectionId: conn.id }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, ignored: true });
    expect(await prisma.queuedSweep.count()).toBe(0);
  });

  it("rejects a body that is not JSON", async () => {
    await webhooksOn();
    await makeConnection({ type: "SONARR" });
    const res = await POST(
      new NextRequest(`http://localhost/api/webhook/sonarr?token=${TOKEN}`, {
        method: "POST",
        body: "not json",
      }),
      { params: Promise.resolve({ arr: "sonarr" }) }
    );
    expect(res.status).toBe(400);
  });
});

describe("webhook receiver — addressing", () => {
  it("finds the only instance of that kind without being told", async () => {
    await webhooksOn();
    const conn = await makeConnection({ type: "SONARR" });

    expect((await post("sonarr", seriesAdd(42))).status).toBe(202);
    expect((await prisma.queuedSweep.findFirstOrThrow()).connectionId).toBe(conn.id);
  });

  it("refuses to guess between two instances", async () => {
    await webhooksOn();
    await makeConnection({ type: "SONARR", name: "A", baseUrl: "http://a:8989" });
    await makeConnection({ type: "SONARR", name: "B", baseUrl: "http://b:8989" });

    const res = await post("sonarr", { ...seriesAdd(42), instanceName: "Neither" });
    expect(res.status).toBe(409);
    expect(await prisma.queuedSweep.count()).toBe(0);
  });

  it("uses the connection id from the URL when there are several", async () => {
    await webhooksOn();
    await makeConnection({ type: "SONARR", name: "A", baseUrl: "http://a:8989" });
    const b = await makeConnection({ type: "SONARR", name: "B", baseUrl: "http://b:8989" });

    expect((await post("sonarr", seriesAdd(42), { connectionId: b.id })).status).toBe(202);
    expect((await prisma.queuedSweep.findFirstOrThrow()).connectionId).toBe(b.id);
  });

  it("refuses a connection id that names the other *arr", async () => {
    await webhooksOn();
    const radarr = await makeConnection({ type: "RADARR" });

    const res = await post("sonarr", seriesAdd(42), { connectionId: radarr.id });
    expect(res.status).toBe(404);
  });

  it("rejects a connection parameter that is not an id", async () => {
    await webhooksOn();
    await makeConnection({ type: "SONARR" });
    const res = await POST(
      new NextRequest(`http://localhost/api/webhook/sonarr?token=${TOKEN}&connection=abc`, {
        method: "POST",
        body: JSON.stringify(seriesAdd(42)),
      }),
      { params: Promise.resolve({ arr: "sonarr" }) }
    );
    expect(res.status).toBe(400);
  });
});

describe("webhook token storage", () => {
  it("is stored encrypted and read back through getSettings", async () => {
    await webhooksOn();
    const stored = await prisma.settings.findUniqueOrThrow({ where: { id: 1 } });
    expect(stored.webhookToken).not.toBe(TOKEN);
    expect(stored.webhookToken?.startsWith("enc:v1:")).toBe(true);
    expect((await getSettings()).webhookToken).toBe(TOKEN);
  });
});
