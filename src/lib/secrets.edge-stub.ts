/**
 * Edge-runtime stub for lib/secrets.
 *
 * The real implementation is Node-only (node:crypto for AES-GCM and HKDF).
 * Next.js compiles the instrumentation hook for the edge runtime as well, so
 * webpack is pointed at this stub there (see next.config.mjs). Nothing here is
 * ever called: instrumentation only runs its logic when NEXT_RUNTIME ===
 * "nodejs", and every credential read goes through `getSettings`, which is
 * Prisma-backed and therefore Node-only too.
 *
 * The functions throw rather than returning a plausible value. A stub that
 * quietly returned the input would mean a credential written on the edge
 * landed in the database in plaintext — failing loudly is the only safe shape
 * for code that is not supposed to run.
 */

export const SETTINGS_SECRET_FIELDS = [
  "watchmodeApiKey",
  "seerrApiKey",
  "tmdbApiKey",
  "oidcClientSecret",
] as const;

export type SettingsSecretField = (typeof SETTINGS_SECRET_FIELDS)[number];

export interface SecretMigrationResult {
  settingsFields: number;
  connections: number;
}

const unavailable = (fn: string): never => {
  throw new Error(`${fn} is not available in the edge runtime.`);
};

export function isEncrypted(): boolean {
  return unavailable("isEncrypted");
}

export function encryptSecret(): string | null {
  return unavailable("encryptSecret");
}

export function decryptSecret(): string | null {
  return unavailable("decryptSecret");
}

export function hasUnreadableSecret(): boolean {
  return unavailable("hasUnreadableSecret");
}

export function decryptSettingsRow<T>(): T {
  return unavailable("decryptSettingsRow");
}

export function encryptSettingsData<T>(): T {
  return unavailable("encryptSettingsData");
}

export function decryptConnection<T>(): T {
  return unavailable("decryptConnection");
}

export async function encryptStoredSecrets(): Promise<SecretMigrationResult> {
  return unavailable("encryptStoredSecrets");
}
