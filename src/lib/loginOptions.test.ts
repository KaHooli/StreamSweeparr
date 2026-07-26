import { describe, it, expect } from "vitest";
import {
  isOidcConfigured,
  effectiveLocalLoginEnabled,
  localLoginToggleLocked,
  ssoButtonLabel,
  DEFAULT_SSO_BUTTON_LABEL,
} from "./loginOptions";

const oidcOff = {
  oidcEnabled: false,
  oidcIssuer: null,
  oidcClientId: null,
  oidcClientSecret: null,
};
const oidcOn = {
  oidcEnabled: true,
  oidcIssuer: "https://auth.example.com",
  oidcClientId: "id",
  oidcClientSecret: "secret",
};

describe("isOidcConfigured", () => {
  it("requires enabled + issuer + client id + secret", () => {
    expect(isOidcConfigured(oidcOff)).toBe(false);
    expect(isOidcConfigured(oidcOn)).toBe(true);
    expect(isOidcConfigured({ ...oidcOn, oidcEnabled: false })).toBe(false);
    expect(isOidcConfigured({ ...oidcOn, oidcClientSecret: null })).toBe(false);
    expect(isOidcConfigured({ ...oidcOn, oidcIssuer: null })).toBe(false);
  });
});

describe("effectiveLocalLoginEnabled", () => {
  it("forces local login on when OIDC is unusable, even if disabled", () => {
    expect(effectiveLocalLoginEnabled({ ...oidcOff, localLoginEnabled: false }, {})).toBe(true);
    // Partially configured OIDC also counts as unusable.
    expect(
      effectiveLocalLoginEnabled(
        { ...oidcOn, oidcClientSecret: null, localLoginEnabled: false },
        {}
      )
    ).toBe(true);
  });

  it("honours the saved setting when OIDC is usable", () => {
    expect(effectiveLocalLoginEnabled({ ...oidcOn, localLoginEnabled: true }, {})).toBe(true);
    expect(effectiveLocalLoginEnabled({ ...oidcOn, localLoginEnabled: false }, {})).toBe(false);
  });

  it("lets the env var hide the password form", () => {
    const s = { ...oidcOn, localLoginEnabled: true };
    expect(effectiveLocalLoginEnabled(s, { LOCAL_LOGIN_DISABLED: "true" })).toBe(false);
    expect(effectiveLocalLoginEnabled(s, { LOCAL_LOGIN_DISABLED: "1" })).toBe(false);
  });

  it("lets the env var force the password form back on (lock-out escape hatch)", () => {
    const s = { ...oidcOn, localLoginEnabled: false };
    expect(effectiveLocalLoginEnabled(s, { LOCAL_LOGIN_DISABLED: "false" })).toBe(true);
    expect(effectiveLocalLoginEnabled(s, { LOCAL_LOGIN_DISABLED: "0" })).toBe(true);
  });

  it("ignores an empty env var", () => {
    expect(
      effectiveLocalLoginEnabled({ ...oidcOn, localLoginEnabled: false }, { LOCAL_LOGIN_DISABLED: "" })
    ).toBe(false);
  });
});

describe("ssoButtonLabel", () => {
  it("uses a custom label when provided", () => {
    expect(ssoButtonLabel("Sign in with Authentik")).toBe("Sign in with Authentik");
  });

  it("trims whitespace", () => {
    expect(ssoButtonLabel("  Login with Keycloak  ")).toBe("Login with Keycloak");
  });

  it("falls back to the default when empty/whitespace/null", () => {
    expect(ssoButtonLabel(null)).toBe(DEFAULT_SSO_BUTTON_LABEL);
    expect(ssoButtonLabel(undefined)).toBe(DEFAULT_SSO_BUTTON_LABEL);
    expect(ssoButtonLabel("")).toBe(DEFAULT_SSO_BUTTON_LABEL);
    expect(ssoButtonLabel("   ")).toBe(DEFAULT_SSO_BUTTON_LABEL);
  });
});

describe("localLoginToggleLocked", () => {
  it("locks when OIDC is not usable", () => {
    const r = localLoginToggleLocked(oidcOff, {});
    expect(r.locked).toBe(true);
    expect(r.reason).toMatch(/OIDC/i);
  });

  it("locks when the env var dictates the value", () => {
    const r = localLoginToggleLocked(oidcOn, { LOCAL_LOGIN_DISABLED: "true" });
    expect(r.locked).toBe(true);
    expect(r.reason).toMatch(/LOCAL_LOGIN_DISABLED/);
  });

  it("is unlocked when OIDC is usable and no env override", () => {
    expect(localLoginToggleLocked(oidcOn, {})).toEqual({ locked: false, reason: null });
  });
});
