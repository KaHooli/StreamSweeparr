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
import { encryptSecret, encryptStoredSecrets, isEncrypted } from "@/lib/secrets";
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
    { watchmodeApiKey: string | null; tmdbApiKey: string | null }[]
  >`SELECT "watchmodeApiKey", "tmdbApiKey" FROM "Settings" WHERE id = 1`;
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
