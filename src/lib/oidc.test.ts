import { describe, it, expect } from "vitest";
import {
  assertSecureEndpoint,
  validateIdTokenClaims,
  usernameFromClaims,
  isUserAllowed,
  generatePkce,
  buildAuthUrl,
  type OidcConfig,
} from "./oidc";

const ISSUER = "https://idp.example.com";
const CLIENT_ID = "streamsweeparr";

/** A payload that passes every check; each test spoils exactly one thing. */
function payload(over: Record<string, unknown> = {}) {
  return {
    sub: "user-1",
    iss: ISSUER,
    aud: CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 300,
    preferred_username: "ada",
    ...over,
  };
}

const cfg = { issuer: ISSUER, clientId: CLIENT_ID };

describe("assertSecureEndpoint", () => {
  it("accepts HTTPS", () => {
    expect(() => assertSecureEndpoint("https://idp.example.com/token", "token endpoint")).not.toThrow();
  });

  it("refuses plain HTTP, because the client secret travels on it", () => {
    expect(() => assertSecureEndpoint("http://idp.example.com/token", "token endpoint")).toThrow(
      /must use HTTPS/
    );
  });

  it("refuses a non-URL", () => {
    expect(() => assertSecureEndpoint("not a url", "issuer")).toThrow(/not a valid URL/);
  });
});

describe("validateIdTokenClaims", () => {
  it("accepts a well-formed token", () => {
    expect(validateIdTokenClaims(payload(), cfg).sub).toBe("user-1");
  });

  it("rejects a payload that would not decode", () => {
    expect(() => validateIdTokenClaims(null, cfg)).toThrow(/could not be decoded/);
  });

  it("rejects a token with no subject", () => {
    expect(() => validateIdTokenClaims(payload({ sub: undefined }), cfg)).toThrow(/no subject/);
  });

  // A token minted by some other provider, replayed here.
  it("rejects a token from a different issuer", () => {
    expect(() => validateIdTokenClaims(payload({ iss: "https://evil.example" }), cfg)).toThrow(
      /not the configured issuer/
    );
  });

  it("ignores a trailing slash on the issuer", () => {
    expect(() => validateIdTokenClaims(payload({ iss: `${ISSUER}/` }), cfg)).not.toThrow();
  });

  // The important one: a real token from the right IdP, minted for a different
  // application registered with it.
  it("rejects a token addressed to another client", () => {
    expect(() => validateIdTokenClaims(payload({ aud: "some-other-app" }), cfg)).toThrow(
      /different OIDC client/
    );
  });

  it("accepts an audience array containing our client id", () => {
    expect(() =>
      validateIdTokenClaims(payload({ aud: [CLIENT_ID], azp: CLIENT_ID }), cfg)
    ).not.toThrow();
  });

  it("requires azp to be us when the audience is shared", () => {
    expect(() =>
      validateIdTokenClaims(payload({ aud: [CLIENT_ID, "other"], azp: "other" }), cfg)
    ).toThrow(/authorised for a different party/);
    expect(() =>
      validateIdTokenClaims(payload({ aud: [CLIENT_ID, "other"], azp: CLIENT_ID }), cfg)
    ).not.toThrow();
  });

  it("rejects an expired token", () => {
    const expired = payload({ exp: Math.floor(Date.now() / 1000) - 3600 });
    expect(() => validateIdTokenClaims(expired, cfg)).toThrow(/expired/);
  });

  it("rejects a token with no expiry at all", () => {
    expect(() => validateIdTokenClaims(payload({ exp: undefined }), cfg)).toThrow(/no expiry/);
  });

  it("allows a minute of clock skew either side", () => {
    const now = 1_000_000;
    // Expired thirty seconds ago by our clock — still inside the allowance.
    expect(() => validateIdTokenClaims(payload({ exp: now - 30 }), cfg, now)).not.toThrow();
    // Two minutes past is beyond it.
    expect(() => validateIdTokenClaims(payload({ exp: now - 120 }), cfg, now)).toThrow(/expired/);
  });

  it("rejects a token that is not valid yet", () => {
    const now = 1_000_000;
    const future = payload({ exp: now + 3600, nbf: now + 600 });
    expect(() => validateIdTokenClaims(future, cfg, now)).toThrow(/not valid yet/);
  });
});

describe("usernameFromClaims", () => {
  it("prefers preferred_username, then email, then name, then sub", () => {
    expect(usernameFromClaims({ sub: "s", preferred_username: "ada", email: "a@b.c" })).toBe("ada");
    expect(usernameFromClaims({ sub: "s", email: "a@b.c" })).toBe("a@b.c");
    expect(usernameFromClaims({ sub: "s", name: "Ada L" })).toBe("Ada L");
    expect(usernameFromClaims({ sub: "s" })).toBe("s");
  });
});

describe("isUserAllowed", () => {
  const base = { allowedUsers: [] as string[] } as OidcConfig;

  it("allows everyone when the list is empty", () => {
    expect(isUserAllowed(base, { sub: "anyone" })).toBe(true);
  });

  it("matches on username, email or subject, case-insensitively", () => {
    const cfgWith = { ...base, allowedUsers: ["Ada@Example.com"] } as OidcConfig;
    expect(isUserAllowed(cfgWith, { sub: "s", email: "ada@example.com" })).toBe(true);
    expect(isUserAllowed(cfgWith, { sub: "s", email: "eve@example.com" })).toBe(false);
  });
});

describe("generatePkce / buildAuthUrl", () => {
  it("mints a distinct state and verifier each time", () => {
    const a = generatePkce();
    const b = generatePkce();
    expect(a.state).not.toBe(b.state);
    expect(a.verifier).not.toBe(b.verifier);
    // base64url only — these travel in a query string.
    expect(a.state).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("builds an authorization URL carrying PKCE and state", () => {
    const full = {
      issuer: ISSUER,
      clientId: CLIENT_ID,
      clientSecret: "shh",
      scopes: "openid profile",
      authUrl: `${ISSUER}/authorize`,
      tokenUrl: `${ISSUER}/token`,
      userinfoUrl: null,
      allowedUsers: [],
    } satisfies OidcConfig;
    const url = new URL(buildAuthUrl(full, "https://app.example/cb", "st8", "chal"));
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example/cb");
    expect(url.searchParams.get("state")).toBe("st8");
    expect(url.searchParams.get("code_challenge")).toBe("chal");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    // The secret must never reach the browser.
    expect(url.search).not.toContain("shh");
  });
});
