import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  encryptSecret,
  decryptSecret,
  isEncrypted,
  decryptSettingsRow,
  encryptSettingsData,
  decryptConnection,
  hasUnreadableSecret,
  SETTINGS_SECRET_FIELDS,
} from "./secrets";

const SECRET_A = "test-auth-secret-that-is-long-enough-aaaa";
const SECRET_B = "test-auth-secret-that-is-long-enough-bbbb";

beforeEach(() => {
  process.env.AUTH_SECRET = SECRET_A;
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** Silence the expected error log while asserting a decryption failure. */
function withQuietFailure<T>(fn: () => T): T {
  vi.spyOn(console, "error").mockImplementation(() => {});
  return fn();
}

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a value", () => {
    const cipher = encryptSecret("wm_live_abc123");
    expect(decryptSecret(cipher)).toBe("wm_live_abc123");
  });

  it("produces something that does not contain the plaintext", () => {
    const cipher = encryptSecret("wm_live_abc123")!;
    expect(cipher).not.toContain("wm_live_abc123");
    expect(isEncrypted(cipher)).toBe(true);
  });

  it("uses a fresh IV, so the same input encrypts differently each time", () => {
    const a = encryptSecret("same-key");
    const b = encryptSecret("same-key");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("same-key");
    expect(decryptSecret(b)).toBe("same-key");
  });

  it("treats null, undefined and empty string as absent", () => {
    for (const v of [null, undefined, ""]) {
      expect(encryptSecret(v)).toBeNull();
      expect(decryptSecret(v)).toBeNull();
    }
  });

  it("is idempotent — encrypting ciphertext returns it unchanged", () => {
    const once = encryptSecret("key")!;
    expect(encryptSecret(once)).toBe(once);
    expect(decryptSecret(encryptSecret(once))).toBe("key");
  });

  it("round-trips unicode and long values", () => {
    const value = "clé-☃-" + "x".repeat(4000);
    expect(decryptSecret(encryptSecret(value))).toBe(value);
  });

  it("passes legacy plaintext through untouched", () => {
    // Values stored before encryption existed carry no prefix.
    expect(isEncrypted("plain-api-key")).toBe(false);
    expect(decryptSecret("plain-api-key")).toBe("plain-api-key");
  });

  it("returns null when AUTH_SECRET has changed", () => {
    const cipher = encryptSecret("wm_live_abc123");
    process.env.AUTH_SECRET = SECRET_B;
    expect(withQuietFailure(() => decryptSecret(cipher))).toBeNull();
    // …and works again once the original secret is restored.
    process.env.AUTH_SECRET = SECRET_A;
    expect(decryptSecret(cipher)).toBe("wm_live_abc123");
  });

  it("detects tampering with the ciphertext", () => {
    const cipher = encryptSecret("wm_live_abc123")!;
    // Flip a character in the payload; GCM's tag must reject it.
    const body = cipher.slice("enc:v1:".length);
    const flipped = (body[10] === "A" ? "B" : "A") + body.slice(1);
    expect(withQuietFailure(() => decryptSecret("enc:v1:" + flipped))).toBeNull();
  });

  it("rejects a truncated payload rather than throwing", () => {
    expect(withQuietFailure(() => decryptSecret("enc:v1:AAAA"))).toBeNull();
    expect(withQuietFailure(() => decryptSecret("enc:v1:"))).toBeNull();
  });

  it("logs which credential failed, so the message is actionable", () => {
    const cipher = encryptSecret("k");
    process.env.AUTH_SECRET = SECRET_B;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    decryptSecret(cipher, "watchmodeApiKey");
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("watchmodeApiKey"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("AUTH_SECRET"));
  });
});

describe("row helpers", () => {
  it("encrypts exactly the credential columns of an update payload", () => {
    const data = encryptSettingsData({
      watchmodeApiKey: "wm",
      tmdbApiKey: "tmdb",
      seerrApiKey: "seerr",
      oidcClientSecret: "oidc",
      seerrUrl: "http://seerr:5055",
      countries: ["US"],
      deleteFiles: true,
    });

    for (const field of SETTINGS_SECRET_FIELDS) {
      expect(isEncrypted(data[field] as string)).toBe(true);
    }
    // Non-credentials are untouched.
    expect(data.seerrUrl).toBe("http://seerr:5055");
    expect(data.countries).toEqual(["US"]);
    expect(data.deleteFiles).toBe(true);
  });

  it("leaves absent credential columns out of the payload", () => {
    const data = encryptSettingsData({ countries: ["GB"] });
    expect("watchmodeApiKey" in data).toBe(false);
  });

  it("decrypts a settings row back to usable values", () => {
    const stored = encryptSettingsData({
      watchmodeApiKey: "wm",
      tmdbApiKey: "tmdb",
      seerrApiKey: null,
      oidcClientSecret: "oidc",
    });
    const row = decryptSettingsRow(stored as Record<string, string | null>);
    expect(row.watchmodeApiKey).toBe("wm");
    expect(row.tmdbApiKey).toBe("tmdb");
    expect(row.oidcClientSecret).toBe("oidc");
    expect(row.seerrApiKey).toBeNull();
  });

  it("decrypts a connection's API key", () => {
    const stored = { id: 1, name: "Main Sonarr", apiKey: encryptSecret("sonarr-key")! };
    expect(decryptConnection(stored).apiKey).toBe("sonarr-key");
  });

  it("yields an empty API key rather than ciphertext when it cannot decrypt", () => {
    const stored = { id: 1, name: "Main Sonarr", apiKey: encryptSecret("sonarr-key")! };
    process.env.AUTH_SECRET = SECRET_B;
    // An empty key produces a clean 401 from the *arr instance; leaking the
    // ciphertext into an X-Api-Key header would be worse in every way.
    expect(withQuietFailure(() => decryptConnection(stored).apiKey)).toBe("");
  });
});

describe("hasUnreadableSecret", () => {
  it("is false when everything decrypts", () => {
    const row = encryptSettingsData({ watchmodeApiKey: "wm" }) as Record<string, string | null>;
    expect(hasUnreadableSecret(row)).toBe(false);
  });

  it("is false for a row with no credentials at all", () => {
    expect(hasUnreadableSecret({ watchmodeApiKey: null, tmdbApiKey: null })).toBe(false);
  });

  it("is false for legacy plaintext, which is readable", () => {
    expect(hasUnreadableSecret({ watchmodeApiKey: "plain" })).toBe(false);
  });

  it("is true once AUTH_SECRET no longer matches", () => {
    const row = encryptSettingsData({ watchmodeApiKey: "wm" }) as Record<string, string | null>;
    process.env.AUTH_SECRET = SECRET_B;
    expect(withQuietFailure(() => hasUnreadableSecret(row))).toBe(true);
  });
});
