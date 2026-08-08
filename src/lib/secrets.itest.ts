import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

/**
 * Encryption at rest, verified against a real database.
 *
 * The unit tests prove the cipher round-trips. What matters here is the claim
 * the feature actually makes: that a `SELECT` against the stored rows does not
 * hand over working credentials, while the application keeps reading them
 * normally. That can only be checked by looking at what is really on disk.
 */

import { prisma, getSettings, getRawSettings } from "@/lib/db";
import {
  encryptSecret,
  encryptStoredSecrets,
  hasUnreadableSecret,
  isEncrypted,
} from "@/lib/secrets";
import { effectiveLocalLoginEnabled, isOidcConfigured } from "@/lib/loginOptions";
import { resetDatabase, makeSettings } from "@/test/dbHelpers";

const WATCHMODE_KEY = "wm_live_supersecret";
const TMDB_KEY = "tmdb_live_supersecret";
const ARR_KEY = "sonarr_supersecret";

beforeEach(async () => {
  await resetDatabase();
  process.env.AUTH_SECRET = "integration-test-secret-that-is-long-enough";
});
afterAll(async () => {
  await prisma.$disconnect();
});

/** Read the columns exactly as stored, bypassing every helper. */
async function rawRow() {
  const rows = await prisma.$queryRaw<
    {
      watchmodeApiKey: string | null;
      watchmodeApiKeys: string[];
      tmdbApiKey: string | null;
    }[]
  >`SELECT "watchmodeApiKey", "watchmodeApiKeys", "tmdbApiKey" FROM "Settings" WHERE id = 1`;
  return rows[0];
}

async function rawConnectionKeys() {
  const rows = await prisma.$queryRaw<
    { apiKey: string }[]
  >`SELECT "apiKey" FROM "ArrConnection" ORDER BY id`;
  return rows.map((r) => r.apiKey);
}

describe("credentials at rest", () => {
  it("stores ciphertext, and getSettings hands back the plaintext", async () => {
    await makeSettings({
      watchmodeApiKey: encryptSecret(WATCHMODE_KEY),
      tmdbApiKey: encryptSecret(TMDB_KEY),
    });

    const stored = await rawRow();
    expect(stored.watchmodeApiKey).not.toBe(WATCHMODE_KEY);
    expect(stored.watchmodeApiKey).not.toContain(WATCHMODE_KEY);
    expect(isEncrypted(stored.watchmodeApiKey)).toBe(true);

    const settings = await getSettings();
    expect(settings.watchmodeApiKey).toBe(WATCHMODE_KEY);
    expect(settings.tmdbApiKey).toBe(TMDB_KEY);
  });

  it("decrypts connection API keys through the settings relation", async () => {
    await makeSettings();
    await prisma.arrConnection.create({
      data: {
        type: "SONARR",
        name: "Main",
        baseUrl: "http://sonarr:8989",
        apiKey: encryptSecret(ARR_KEY)!,
        settingsId: 1,
      },
    });

    expect((await rawConnectionKeys())[0]).not.toBe(ARR_KEY);

    const settings = await getSettings();
    // sync/sweep build their *arr clients straight from this.
    expect(settings.connections[0].apiKey).toBe(ARR_KEY);
  });

  it("encrypts every key in the Watchmode ring, and hands the ring back in order", async () => {
    const keys = [WATCHMODE_KEY, "wm_live_second_key", "wm_live_third_key"];
    await makeSettings({
      watchmodeApiKeys: keys.map((k) => encryptSecret(k)!),
      watchmodeApiKey: encryptSecret(WATCHMODE_KEY),
    });

    const stored = await rawRow();
    expect(stored.watchmodeApiKeys).toHaveLength(3);
    expect(stored.watchmodeApiKeys.every(isEncrypted)).toBe(true);
    for (const key of keys) expect(stored.watchmodeApiKeys.join("|")).not.toContain(key);

    const settings = await getSettings();
    // Order is the failover order, so it has to survive the round trip exactly.
    expect(settings.watchmodeApiKeys).toEqual(keys);
    expect(settings.watchmodeApiKey).toBe(WATCHMODE_KEY);
  });

  it("folds a legacy single key into a one-key ring", async () => {
    // A row written before the ring existed, whose data migration has not run.
    await makeSettings({ watchmodeApiKeys: [], watchmodeApiKey: encryptSecret(WATCHMODE_KEY) });

    const settings = await getSettings();
    expect(settings.watchmodeApiKeys).toEqual([WATCHMODE_KEY]);
  });

  it("drops ring entries it cannot decrypt instead of returning ciphertext", async () => {
    await makeSettings({
      watchmodeApiKeys: [encryptSecret(WATCHMODE_KEY)!, "wm_live_plaintext_second"],
    });
    process.env.AUTH_SECRET = "a-completely-different-secret-value-here";
    vi.spyOn(console, "error").mockImplementation(() => {});

    const settings = await getSettings();
    // The unreadable key is gone; the plaintext one (from before encryption)
    // still works, so the ring is degraded rather than dead.
    expect(settings.watchmodeApiKeys).toEqual(["wm_live_plaintext_second"]);
    expect(hasUnreadableSecret((await getRawSettings())!)).toBe(true);
    vi.restoreAllMocks();
  });

  it("blanks a credential it cannot decrypt instead of returning ciphertext", async () => {
    await makeSettings({ watchmodeApiKey: encryptSecret(WATCHMODE_KEY) });
    process.env.AUTH_SECRET = "a-completely-different-secret-value-here";
    vi.spyOn(console, "error").mockImplementation(() => {});

    const settings = await getSettings();
    // Reads as "not configured", which makes sync refuse to run rather than
    // send a base64 blob to Watchmode as an API key.
    expect(settings.watchmodeApiKey).toBeNull();

    // The stored value is untouched, so restoring AUTH_SECRET recovers it.
    expect(isEncrypted((await rawRow()).watchmodeApiKey)).toBe(true);
    vi.restoreAllMocks();
  });
});

describe("AUTH_SECRET rotation cannot lock you out", () => {
  it("re-enables the password form when the OIDC secret becomes unreadable", async () => {
    // An SSO-only deployment: local login switched off because OIDC works.
    await makeSettings({
      oidcEnabled: true,
      oidcIssuer: "https://auth.example.com",
      oidcClientId: "streamsweeparr",
      oidcClientSecret: encryptSecret("oidc-client-secret"),
      localLoginEnabled: false,
    });
    expect(effectiveLocalLoginEnabled(await getSettings())).toBe(false);

    // Rotate the secret: the client secret can no longer be read, so OIDC is
    // not usable — and the password form must come back on its own, or the
    // instance would have no reachable way to sign in.
    process.env.AUTH_SECRET = "a-completely-different-secret-value-here";
    vi.spyOn(console, "error").mockImplementation(() => {});

    const settings = await getSettings();
    expect(settings.oidcClientSecret).toBeNull();
    expect(isOidcConfigured(settings)).toBe(false);
    expect(effectiveLocalLoginEnabled(settings)).toBe(true);
    vi.restoreAllMocks();
  });
});

describe("encryptStoredSecrets — upgrade from plaintext", () => {
  it("rewrites plaintext credentials left by an older version", async () => {
    // Exactly what an existing install looks like: no prefix, no ciphertext.
    await makeSettings({ watchmodeApiKey: WATCHMODE_KEY, tmdbApiKey: TMDB_KEY });
    await prisma.arrConnection.create({
      data: {
        type: "RADARR",
        name: "Main",
        baseUrl: "http://radarr:7878",
        apiKey: ARR_KEY,
        settingsId: 1,
      },
    });

    const migrated = await encryptStoredSecrets();
    expect(migrated).toEqual({ settingsFields: 2, connections: 1 });

    const stored = await rawRow();
    expect(isEncrypted(stored.watchmodeApiKey)).toBe(true);
    expect(isEncrypted(stored.tmdbApiKey)).toBe(true);
    expect(isEncrypted((await rawConnectionKeys())[0])).toBe(true);

    // The values still work afterwards.
    const settings = await getSettings();
    expect(settings.watchmodeApiKey).toBe(WATCHMODE_KEY);
    expect(settings.tmdbApiKey).toBe(TMDB_KEY);
    expect(settings.connections[0].apiKey).toBe(ARR_KEY);
  });

  it("rewrites a plaintext Watchmode ring, keeping its order", async () => {
    // What the SQL migration leaves behind on an install that never encrypted:
    // the old plaintext key copied verbatim into the array, plus keys added
    // since. A SQL migration cannot encrypt them — the key lives in the app's
    // environment — so the boot pass has to.
    const second = "wm_live_second_key";
    await makeSettings({
      watchmodeApiKey: WATCHMODE_KEY,
      watchmodeApiKeys: [WATCHMODE_KEY, second],
    });

    // The column and the array each count once.
    expect((await encryptStoredSecrets()).settingsFields).toBe(2);

    const stored = await rawRow();
    expect(stored.watchmodeApiKeys.every(isEncrypted)).toBe(true);
    expect((await getSettings()).watchmodeApiKeys).toEqual([WATCHMODE_KEY, second]);

    // Second pass finds nothing left to convert.
    expect((await encryptStoredSecrets()).settingsFields).toBe(0);
  });

  it("is idempotent — a second pass has nothing to do", async () => {
    await makeSettings({ watchmodeApiKey: WATCHMODE_KEY });
    expect((await encryptStoredSecrets()).settingsFields).toBe(1);

    const afterFirst = (await rawRow()).watchmodeApiKey;
    expect(await encryptStoredSecrets()).toEqual({ settingsFields: 0, connections: 0 });
    // Not re-encrypted under a new IV, so backups stay stable.
    expect((await rawRow()).watchmodeApiKey).toBe(afterFirst);
  });

  it("reads correctly mid-migration, with some values still plaintext", async () => {
    // A crash between the settings update and the connection loop leaves a
    // mixed database; both forms have to keep working.
    await makeSettings({
      watchmodeApiKey: encryptSecret(WATCHMODE_KEY),
      tmdbApiKey: TMDB_KEY, // not yet converted
    });

    const settings = await getSettings();
    expect(settings.watchmodeApiKey).toBe(WATCHMODE_KEY);
    expect(settings.tmdbApiKey).toBe(TMDB_KEY);
  });

  it("does nothing on an empty database", async () => {
    expect(await encryptStoredSecrets()).toEqual({ settingsFields: 0, connections: 0 });
  });

  it("leaves rows with no credentials alone", async () => {
    await makeSettings({ watchmodeApiKey: null, tmdbApiKey: null });
    expect(await encryptStoredSecrets()).toEqual({ settingsFields: 0, connections: 0 });
    expect((await getRawSettings())?.watchmodeApiKey).toBeNull();
  });
});
