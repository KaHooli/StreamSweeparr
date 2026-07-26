/**
 * Which login methods the app offers. Pure logic (no I/O) so it can be reused
 * by API routes and unit-tested directly.
 */

export interface OidcSettingsShape {
  oidcEnabled: boolean;
  oidcIssuer: string | null;
  oidcClientId: string | null;
  oidcClientSecret: string | null;
}

/** OIDC is usable only when enabled AND fully configured. */
export function isOidcConfigured(s: OidcSettingsShape): boolean {
  return !!(s.oidcEnabled && s.oidcIssuer && s.oidcClientId && s.oidcClientSecret);
}

/**
 * Whether the username/password form is available.
 *
 * Rules:
 *  - If OIDC is not usable, local login is ALWAYS enabled — otherwise nobody
 *    could sign in. (The UI greys out the toggle in this case.)
 *  - Otherwise the LOCAL_LOGIN_DISABLED env var wins when set:
 *      "true"  -> hidden
 *      "false" -> shown (escape hatch if OIDC breaks and you're locked out)
 *  - Otherwise the saved setting applies.
 */
export function effectiveLocalLoginEnabled(
  s: OidcSettingsShape & { localLoginEnabled: boolean },
  env: Record<string, string | undefined> = process.env
): boolean {
  if (!isOidcConfigured(s)) return true;

  const flag = env.LOCAL_LOGIN_DISABLED?.trim().toLowerCase();
  if (flag === "true" || flag === "1") return false;
  if (flag === "false" || flag === "0") return true;

  return s.localLoginEnabled;
}

/**
 * Whether the "disable local login" control should be locked in the UI.
 * It is locked when OIDC isn't usable (nothing else to log in with), or when an
 * environment variable is dictating the value.
 */
export function localLoginToggleLocked(
  s: OidcSettingsShape,
  env: Record<string, string | undefined> = process.env
): { locked: boolean; reason: string | null } {
  if (!isOidcConfigured(s)) {
    return {
      locked: true,
      reason: "Username & password login can't be disabled until OIDC is enabled and configured.",
    };
  }
  const flag = env.LOCAL_LOGIN_DISABLED?.trim().toLowerCase();
  if (flag !== undefined && flag !== "") {
    return {
      locked: true,
      reason: `Controlled by the LOCAL_LOGIN_DISABLED environment variable (${flag}).`,
    };
  }
  return { locked: false, reason: null };
}
