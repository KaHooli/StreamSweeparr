import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

/**
 * The settings route against a real database — the Watchmode key ring, and the
 * movie provider choice.
 *
 * The ring is edited without the browser ever seeing a stored key: a field the
 * user did not retype is sent as the position it occupies. These tests check
 * that round trip against a real database — that positions resolve to the right
 * keys, that the stored form is ciphertext, and that a stale edit is refused
 * rather than quietly deleting a key. The provider tests are here for the same
 * reason: what matters is that the switch persists and that it leaves the other
 * provider's stored configuration intact.
 */

let cookieValue: string | undefined;

vi.mock("next/headers", () => ({
  cookies: () => ({ get: () => (cookieValue ? { value: cookieValue } : undefined) }),
}));

import { NextRequest } from "next/server";
import { prisma, getSettings } from "@/lib/db";
import { createSession } from "@/lib/session";
import { isEncrypted } from "@/lib/secrets";
import { GET, PATCH } from "./route";
import { resetDatabase, makeSettings } from "@/test/dbHelpers";

beforeEach(async () => {
  await resetDatabase();
  cookieValue = undefined;
  process.env.AUTH_SECRET = "integration-test-secret-that-is-long-enough";
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function signInAsAdmin() {
  const user = await prisma.user.create({
    data: { username: "admin-user", role: "ADMIN", passwordHash: "x" },
  });
  cookieValue = await createSession(user, "local");
  return user;
}

const patch = (body: unknown) =>
  PATCH(
    new NextRequest("http://localhost/api/settings", {
      method: "PATCH",
      body: JSON.stringify(body),
    })
  );

/** The stored (still encrypted) ring. */
async function storedRing(): Promise<string[]> {
  const rows = await prisma.$queryRaw<
    { watchmodeApiKeys: string[] }[]
  >`SELECT "watchmodeApiKeys" FROM "Settings" WHERE id = 1`;
  return rows[0].watchmodeApiKeys;
}

describe("PATCH /api/settings — Watchmode key ring", () => {
  it("refuses anonymous callers", async () => {
    expect((await patch({ watchmodeApiKeys: [{ value: "k1" }] })).status).toBe(401);
  });

  it("stores several keys in order, encrypted, and never echoes them back", async () => {
    await signInAsAdmin();
    await makeSettings();

    const res = await patch({ watchmodeApiKeys: [{ value: "k1" }, { value: "k2" }] });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.watchmodeApiKeyCount).toBe(2);
    expect(body.watchmodeApiKeySet).toBe(true);
    expect(JSON.stringify(body)).not.toContain("k1");

    expect((await storedRing()).every(isEncrypted)).toBe(true);
    expect((await getSettings()).watchmodeApiKeys).toEqual(["k1", "k2"]);
  });

  it("adds a key without the client having to resend the ones already stored", async () => {
    await signInAsAdmin();
    await makeSettings();
    await patch({ watchmodeApiKeys: [{ value: "k1" }] });

    // Exactly what the card sends: key 1 untouched, key 2 newly typed.
    await patch({ watchmodeApiKeys: [{ keep: 1 }, { value: "k2" }] });

    expect((await getSettings()).watchmodeApiKeys).toEqual(["k1", "k2"]);
  });

  it("replaces one key in place and leaves the rest alone", async () => {
    await signInAsAdmin();
    await makeSettings();
    await patch({ watchmodeApiKeys: [{ value: "k1" }, { value: "k2" }] });

    await patch({ watchmodeApiKeys: [{ keep: 1 }, { value: "k2-replacement" }] });

    expect((await getSettings()).watchmodeApiKeys).toEqual(["k1", "k2-replacement"]);
  });

  it("removes a key, renumbering the survivors", async () => {
    await signInAsAdmin();
    await makeSettings();
    await patch({ watchmodeApiKeys: [{ value: "k1" }, { value: "k2" }, { value: "k3" }] });

    await patch({ watchmodeApiKeys: [{ keep: 2 }, { keep: 3 }] });

    const s = await getSettings();
    expect(s.watchmodeApiKeys).toEqual(["k2", "k3"]);
    // The mirrored single-key column follows the head of the ring.
    expect(s.watchmodeApiKey).toBe("k2");
  });

  it("can clear the ring entirely", async () => {
    await signInAsAdmin();
    await makeSettings();
    await patch({ watchmodeApiKeys: [{ value: "k1" }] });

    const res = await patch({ watchmodeApiKeys: [] });
    expect((await res.json()).watchmodeApiKeyCount).toBe(0);

    const s = await getSettings();
    expect(s.watchmodeApiKeys).toEqual([]);
    expect(s.watchmodeApiKey).toBeNull();
  });

  it("refuses an edit built from a stale view instead of dropping a key", async () => {
    await signInAsAdmin();
    await makeSettings();
    await patch({ watchmodeApiKeys: [{ value: "k1" }] });

    // Two browser tabs: this one still believes there are two keys.
    const res = await patch({ watchmodeApiKeys: [{ keep: 1 }, { keep: 2 }] });
    expect(res.status).toBe(409);
    expect((await getSettings()).watchmodeApiKeys).toEqual(["k1"]);
  });

  it("keeps the legacy single-key form working, replacing key 1 only", async () => {
    await signInAsAdmin();
    await makeSettings();
    await patch({ watchmodeApiKeys: [{ value: "k1" }, { value: "k2" }] });

    await patch({ watchmodeApiKey: "k1-replacement" });

    expect((await getSettings()).watchmodeApiKeys).toEqual(["k1-replacement", "k2"]);
  });

  it("folds a pre-existing single key into the ring on first edit", async () => {
    await signInAsAdmin();
    // A row from before the ring existed: only the legacy column is populated.
    await makeSettings({ watchmodeApiKey: "legacy-key" });

    const res = await GET();
    expect((await res.json()).watchmodeApiKeyCount).toBe(1);

    await patch({ watchmodeApiKeys: [{ keep: 1 }, { value: "k2" }] });
    expect((await getSettings()).watchmodeApiKeys).toEqual(["legacy-key", "k2"]);
  });

  it("rejects a ring longer than the maximum", async () => {
    await signInAsAdmin();
    await makeSettings();

    const tooMany = Array.from({ length: 11 }, (_, i) => ({ value: `k${i}` }));
    expect((await patch({ watchmodeApiKeys: tooMany })).status).toBe(400);
    expect((await getSettings()).watchmodeApiKeys).toEqual([]);
  });
});

describe("PATCH /api/settings — movie availability provider", () => {
  it("defaults to TMDB, so an upgrade never starts spending Watchmode credits", async () => {
    await signInAsAdmin();
    await makeSettings();

    expect((await (await GET()).json()).movieProvider).toBe("TMDB");
  });

  it("switches movies to Watchmode without disturbing the TMDB configuration", async () => {
    await signInAsAdmin();
    await makeSettings({
      tmdbApiKey: "tmdb-key",
      tmdbRegions: ["US"],
      tmdbProviderIds: [8],
    });

    const res = await patch({ movieProvider: "WATCHMODE" });
    expect(res.status).toBe(200);
    expect((await res.json()).movieProvider).toBe("WATCHMODE");

    // Switching is not a reset: everything TMDB needs is still there, so
    // switching back costs nothing but the click.
    const stored = await getSettings();
    expect(stored.movieProvider).toBe("WATCHMODE");
    expect(stored.tmdbApiKey).toBe("tmdb-key");
    expect(stored.tmdbRegions).toEqual(["US"]);
    expect(stored.tmdbProviderIds).toEqual([8]);
  });

  it("rejects a provider it has never heard of", async () => {
    await signInAsAdmin();
    await makeSettings();

    expect((await patch({ movieProvider: "JUSTWATCH" })).status).toBe(400);
    expect((await getSettings()).movieProvider).toBe("TMDB");
  });
});

describe("PATCH /api/settings — Watchmode cache window", () => {
  it("defaults to the 7 days a free / developer key is sized for", async () => {
    await signInAsAdmin();
    await makeSettings();

    const body = await (await GET()).json();
    expect(body.watchmodeCacheDays).toBe(7);
    expect(body.watchmodeCacheChoices).toContain(7);
  });

  it("stores a new window", async () => {
    await signInAsAdmin();
    await makeSettings();

    const res = await patch({ watchmodeCacheDays: 30 });
    expect(res.status).toBe(200);
    expect((await res.json()).watchmodeCacheDays).toBe(30);
    expect((await getSettings()).watchmodeCacheDays).toBe(30);
  });

  it("rejects a window outside the accepted range instead of clamping it", async () => {
    await signInAsAdmin();
    await makeSettings({ watchmodeCacheDays: 14 });

    // Silently storing something else would leave the card showing one window
    // and the sync engine using another.
    expect((await patch({ watchmodeCacheDays: 0 })).status).toBe(400);
    expect((await patch({ watchmodeCacheDays: 365 })).status).toBe(400);
    expect((await patch({ watchmodeCacheDays: 2.5 })).status).toBe(400);
    expect((await getSettings()).watchmodeCacheDays).toBe(14);
  });

  it("reports an out-of-range stored value as the one actually in force", async () => {
    await signInAsAdmin();
    // Only reachable by editing the row by hand; the sync engine clamps it, so
    // the card must show the same number rather than the stored one.
    await makeSettings({ watchmodeCacheDays: 400 });

    expect((await (await GET()).json()).watchmodeCacheDays).toBe(90);
  });
});
