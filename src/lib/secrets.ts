/**
 * Encryption at rest for the credentials StreamSweeparr stores.
 *
 * The database holds working credentials — Watchmode/TMDB API keys, the Seerr
 * key, the OIDC client secret, and an API key per Sonarr/Radarr instance. Those
 * last ones are the sharp end: an *arr API key can delete media. A database
 * dump, a backup copied somewhere convenient, or a `SELECT * FROM "Settings"`
 * over a shared connection should not hand all of that over in the clear.
 *
 * ## What this does and does not protect
 *
 * The key is derived from AUTH_SECRET, which the app process must be able to
 * read — so this protects the *data at rest* (dumps, backups, replicas, an
 * attacker with read access to the database) and not the running process. Any
 * attacker who can read the app's environment can derive the key. That is the
 * usual trade for self-hosted software with no key-management service, and it
 * is worth making explicit rather than implying more than it delivers.
 *
 * ## Format
 *
 * Ciphertext is stored as a self-describing string:
 *
 *     enc:v1:<base64url( iv[12] || tag[16] || ciphertext )>
 *
 * The prefix is what makes the upgrade path work: a value without it is
 * plaintext from an older install, and is returned as-is. `encryptStoredSecrets`
 * rewrites those on boot, but reads never depend on it having run.
 *
 * ## AUTH_SECRET rotation
 *
 * AES-GCM authenticates, so a rotated secret makes stored values undecryptable
 * rather than silently wrong. Decryption failure returns null and logs loudly;
 * the affected key reads as "not configured" and must be entered again. Sync
 * refuses to run without an API key rather than doing anything destructive with
 * a missing one, so the failure mode is an inconvenience, not a hazard.
 *
 * Node-runtime only (node:crypto). Never import from the edge.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { logger } from "./logger";

const log = logger("secrets");

/** Marker + version for stored ciphertext. */
const PREFIX = "enc:v1:";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/**
 * Fixed salt for the key derivation.
 *
 * A random per-value salt would have to be stored alongside the ciphertext and
 * buys nothing here: HKDF's salt guards against a *shared* input key across
 * unrelated uses, and AUTH_SECRET is already unique to the deployment. The
 * `info` string is what separates this key from any other use of AUTH_SECRET
 * (session signing derives its own key material from the same secret).
 */
const HKDF_SALT = "streamsweeparr:secret-encryption:v1";
const HKDF_INFO = "settings-and-connection-credentials";

let cachedKey: { from: string; key: Buffer } | null = null;

/**
 * The encryption key, derived from AUTH_SECRET.
 *
 * Mirrors the fallback in `session.ts`: production refuses to run without a
 * real secret, development gets a fixed stand-in so the app still boots. Values
 * encrypted under the dev fallback are readable only under the dev fallback,
 * which is the intended behaviour — they are not secrets in any real sense.
 */
function encryptionKey(): Buffer {
  const secret = process.env.AUTH_SECRET;
  const material =
    secret && secret.length >= 16 ? secret : devFallbackSecret();

  if (cachedKey && cachedKey.from === material) return cachedKey.key;
  const key = Buffer.from(hkdfSync("sha256", material, HKDF_SALT, HKDF_INFO, KEY_BYTES));
  cachedKey = { from: material, key };
  return key;
}

function devFallbackSecret(): string {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "AUTH_SECRET is not set or is shorter than 16 characters. It is required to " +
        "encrypt stored credentials. Generate one with `openssl rand -hex 32`."
    );
  }
  return "streamsweeparr-insecure-dev-secret-change-me";
}

/** Whether a stored value is in the encrypted format. */
export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}

/**
 * Encrypt a secret for storage. Returns null for null/empty input, and returns
 * an already-encrypted value untouched so callers can be careless about
 * double-application.
 */
export function encryptSecret(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (isEncrypted(value)) return value;

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const payload = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  return PREFIX + payload.toString("base64url");
}

/**
 * Decrypt a stored secret.
 *
 * Plaintext (a value from before encryption existed) passes through unchanged.
 * A value that claims to be encrypted but cannot be decrypted — wrong
 * AUTH_SECRET, or tampering, both of which GCM detects — yields null and is
 * logged: silently treating it as plaintext would send a base64 blob to a
 * provider as if it were an API key.
 */
export function decryptSecret(
  value: string | null | undefined,
  label = "secret"
): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (!isEncrypted(value)) return value; // legacy plaintext

  try {
    const payload = Buffer.from(value.slice(PREFIX.length), "base64url");
    if (payload.length <= IV_BYTES + TAG_BYTES) throw new Error("payload too short");
    const iv = payload.subarray(0, IV_BYTES);
    const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = payload.subarray(IV_BYTES + TAG_BYTES);

    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    log.error(
      `could not decrypt ${label}. This normally means AUTH_SECRET changed since it ` +
        `was saved — stored credentials cannot be recovered, so re-enter it in Settings.`
    );
    return null;
  }
}

/* ------------------------- Row-level helpers ------------------------- */

/** Settings columns holding credentials. */
export const SETTINGS_SECRET_FIELDS = [
  "watchmodeApiKey",
  "seerrApiKey",
  "tmdbApiKey",
  "oidcClientSecret",
  // The shared secret Sonarr/Radarr present on the webhook endpoint. It is the
  // only thing guarding a route that starts sweeps, so it belongs here with the
  // rest of the credentials rather than sitting in the clear.
  "webhookToken",
] as const;

export type SettingsSecretField = (typeof SETTINGS_SECRET_FIELDS)[number];

/**
 * Settings columns holding a *list* of credentials. Each element is encrypted
 * on its own, so the list keeps its order and a key can be added or removed
 * without touching the others.
 */
export const SETTINGS_SECRET_ARRAY_FIELDS = ["watchmodeApiKeys"] as const;

export type SettingsSecretArrayField = (typeof SETTINGS_SECRET_ARRAY_FIELDS)[number];

type SettingsSecrets = Partial<Record<SettingsSecretField, string | null>> &
  Partial<Record<SettingsSecretArrayField, string[] | null>>;

/**
 * True when a row holds a credential that is present but unreadable, i.e.
 * AUTH_SECRET no longer matches what encrypted it. Worth distinguishing from
 * "never configured" so the UI can say why the key disappeared.
 */
export function hasUnreadableSecret<T extends SettingsSecrets>(row: T): boolean {
  const single = SETTINGS_SECRET_FIELDS.some(
    (f) => isEncrypted(row[f]) && decryptSecret(row[f], f) === null
  );
  if (single) return true;
  return SETTINGS_SECRET_ARRAY_FIELDS.some((f) =>
    (row[f] ?? []).some((v) => isEncrypted(v) && decryptSecret(v, f) === null)
  );
}

/**
 * Return a copy of a settings row with its credential columns decrypted.
 *
 * Elements of a list that cannot be decrypted are dropped rather than left as
 * ciphertext — sending a base64 blob to a provider as if it were an API key is
 * the one outcome worse than the key being missing. `hasUnreadableSecret` is
 * what tells the UI that this happened.
 */
export function decryptSettingsRow<T extends SettingsSecrets>(row: T): T {
  const out = { ...row };
  for (const field of SETTINGS_SECRET_FIELDS) {
    if (field in out) out[field] = decryptSecret(out[field], field) as T[typeof field];
  }
  for (const field of SETTINGS_SECRET_ARRAY_FIELDS) {
    const values = out[field];
    if (!Array.isArray(values)) continue;
    out[field] = values
      .map((v) => decryptSecret(v, field))
      .filter((v): v is string => !!v) as T[typeof field];
  }
  return out;
}

/** Encrypt whichever credential columns are present in an update payload. */
export function encryptSettingsData<T extends Record<string, unknown>>(data: T): T {
  const out = { ...data };
  for (const field of SETTINGS_SECRET_FIELDS) {
    const value = out[field];
    if (typeof value === "string") {
      (out as Record<string, unknown>)[field] = encryptSecret(value);
    }
  }
  for (const field of SETTINGS_SECRET_ARRAY_FIELDS) {
    const value = out[field];
    if (Array.isArray(value)) {
      (out as Record<string, unknown>)[field] = value
        .map((v) => (typeof v === "string" ? encryptSecret(v) : null))
        .filter((v): v is string => !!v);
    }
  }
  return out;
}

/** Return a copy of an *arr connection with its API key decrypted. */
export function decryptConnection<T extends { apiKey: string; name?: string }>(conn: T): T {
  return {
    ...conn,
    apiKey: decryptSecret(conn.apiKey, `API key for "${conn.name ?? "connection"}"`) ?? "",
  };
}

/* --------------------------- Upgrade path --------------------------- */

export interface SecretMigrationResult {
  settingsFields: number;
  connections: number;
}

/**
 * Rewrite any plaintext credentials in the database as ciphertext.
 *
 * Called once at boot. A SQL migration cannot do this — the key lives in the
 * application's environment, not the database — so the conversion has to happen
 * in the app, and reads tolerate both forms in the meantime. Idempotent: values
 * already encrypted are skipped, so running it on every start costs one query.
 */
export async function encryptStoredSecrets(): Promise<SecretMigrationResult> {
  // Imported lazily so this module stays usable without a database (tests, and
  // anything that only needs encrypt/decrypt).
  const { prisma, getRawSettings } = await import("./db");
  const result: SecretMigrationResult = { settingsFields: 0, connections: 0 };

  const settings = await getRawSettings();
  if (settings) {
    const data: Record<string, string | string[]> = {};
    for (const field of SETTINGS_SECRET_FIELDS) {
      const stored = settings[field];
      if (stored && !isEncrypted(stored)) {
        const encrypted = encryptSecret(stored);
        if (encrypted) {
          data[field] = encrypted;
          result.settingsFields++;
        }
      }
    }
    for (const field of SETTINGS_SECRET_ARRAY_FIELDS) {
      const stored = settings[field] ?? [];
      if (!stored.some((v) => v && !isEncrypted(v))) continue;
      const encrypted = stored
        .map((v) => encryptSecret(v))
        .filter((v): v is string => !!v);
      data[field] = encrypted;
      result.settingsFields++;
    }
    if (result.settingsFields) {
      await prisma.settings.update({ where: { id: 1 }, data });
    }
  }

  const connections = await prisma.arrConnection.findMany({
    select: { id: true, apiKey: true },
  });
  for (const conn of connections) {
    if (!conn.apiKey || isEncrypted(conn.apiKey)) continue;
    const encrypted = encryptSecret(conn.apiKey);
    if (!encrypted) continue;
    await prisma.arrConnection.update({ where: { id: conn.id }, data: { apiKey: encrypted } });
    result.connections++;
  }

  return result;
}
