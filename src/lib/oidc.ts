/**
 * OpenID Connect (Authorization Code + PKCE) helper.
 *
 * No external dependency: uses `fetch` for discovery / token exchange /
 * userinfo and Node crypto for PKCE + state. Node-runtime only (API routes).
 *
 * Enabled when Settings has oidcEnabled + issuer + clientId + clientSecret.
 * Endpoints are auto-discovered from `<issuer>/.well-known/openid-configuration`
 * unless explicitly overridden in Settings.
 *
 * On what is trusted, and why:
 *
 *  - The `id_token`'s **signature** is not verified. That is permitted by OIDC
 *    Core §3.1.3.7 for the authorization-code flow, where the token arrives
 *    over a direct, server-to-server TLS connection to the token endpoint
 *    rather than via the browser. `assertSecureEndpoint` is what makes that
 *    argument hold: the endpoints carrying the client secret and the tokens
 *    must be HTTPS, or the reasoning collapses and so does the check.
 *  - The `id_token`'s **claims** are always validated — issuer, audience and
 *    expiry — by `validateIdTokenClaims`. Skipping the signature does not
 *    licence skipping these: without them a token minted by a different
 *    provider, for a different client, or expired months ago is accepted as
 *    proof of identity.
 *  - When `userinfo` answers, its `sub` is checked against the `id_token`'s
 *    (OIDC Core §5.3.2), so a userinfo response cannot re-point an
 *    authenticated session at a different account.
 */
import { randomBytes, createHash } from "node:crypto";
import { getSettings } from "./db";
import { safeFetch } from "./safeFetch";

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  authUrl: string;
  tokenUrl: string;
  userinfoUrl: string | null;
  allowedUsers: string[];
}

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
}

// Short-lived cache of the discovery document keyed by issuer.
const discoveryCache = new Map<string, { doc: Discovery; expires: number }>();

/** Trailing slashes are not significant in an issuer identifier. */
function normaliseIssuer(issuer: string): string {
  return issuer.trim().replace(/\/+$/, "");
}

/**
 * Refuse an OIDC endpoint that is not HTTPS.
 *
 * These three URLs are the ones an active network attacker gains something
 * from: discovery decides where the other two point, the token endpoint
 * receives the client secret in a form body and returns the tokens, and
 * userinfo receives the access token as a bearer credential. Over plain HTTP
 * all of that is readable and rewritable in transit — and a rewritten token
 * response is a forged identity, which is why this is enforced rather than
 * warned about.
 *
 * The authorization URL is deliberately not checked here: it is a browser
 * redirect carrying no secret, and it is the browser's address bar (not this
 * process) that would have to make that judgement.
 */
export function assertSecureEndpoint(rawUrl: string, what: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`OIDC ${what} is not a valid URL.`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(
      `OIDC ${what} must use HTTPS (got "${parsed.protocol}//"). ` +
        `Over plain HTTP the client secret and the identity tokens travel in the clear, ` +
        `and anyone on the network path can rewrite them.`
    );
  }
}

async function discover(issuer: string): Promise<Discovery> {
  const cached = discoveryCache.get(issuer);
  if (cached && cached.expires > Date.now()) return cached.doc;
  const base = normaliseIssuer(issuer);
  const url = `${base}/.well-known/openid-configuration`;
  assertSecureEndpoint(url, "issuer");
  const res = await safeFetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`OIDC discovery failed (${res.status}) at ${url}`);
  const doc = (await res.json()) as Discovery;
  discoveryCache.set(issuer, { doc, expires: Date.now() + 60 * 60 * 1000 });
  return doc;
}

/** Resolve the effective OIDC config, or null if not fully configured. */
export async function getOidcConfig(): Promise<OidcConfig | null> {
  const s = await getSettings();
  if (!s.oidcEnabled || !s.oidcIssuer || !s.oidcClientId || !s.oidcClientSecret) return null;

  let authUrl = s.oidcAuthUrl ?? undefined;
  let tokenUrl = s.oidcTokenUrl ?? undefined;
  let userinfoUrl = s.oidcUserinfoUrl ?? undefined;

  // Discover any endpoints not explicitly overridden.
  if (!authUrl || !tokenUrl || !userinfoUrl) {
    try {
      const doc = await discover(s.oidcIssuer);
      authUrl = authUrl || doc.authorization_endpoint;
      tokenUrl = tokenUrl || doc.token_endpoint;
      userinfoUrl = userinfoUrl || doc.userinfo_endpoint;
    } catch (e) {
      if (!authUrl || !tokenUrl) throw e; // can't proceed without these
    }
  }
  if (!authUrl || !tokenUrl) return null;

  return {
    issuer: s.oidcIssuer,
    clientId: s.oidcClientId,
    clientSecret: s.oidcClientSecret,
    scopes: s.oidcScopes || "openid profile email",
    authUrl,
    tokenUrl,
    userinfoUrl: userinfoUrl ?? null,
    allowedUsers: s.oidcAllowedUsers ?? [],
  };
}

export { isOidcConfigured as isOidcEnabled } from "./loginOptions";

/* ------------------------------- PKCE ------------------------------- */
function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generatePkce() {
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { state, verifier, challenge };
}

/** Build the authorization redirect URL. */
export function buildAuthUrl(cfg: OidcConfig, redirectUri: string, state: string, challenge: string): string {
  const u = new URL(cfg.authUrl);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("scope", cfg.scopes);
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

interface TokenResponse {
  access_token?: string;
  id_token?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

/** Exchange an authorization code for tokens. */
export async function exchangeCode(
  cfg: OidcConfig,
  code: string,
  redirectUri: string,
  verifier: string
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code_verifier: verifier,
  });
  // The client secret is in this body and the tokens come back in the response.
  assertSecureEndpoint(cfg.tokenUrl, "token endpoint");
  const res = await safeFetch(cfg.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || json.error) {
    throw new Error(`Token exchange failed: ${json.error_description || json.error || res.status}`);
  }
  return json;
}

export interface OidcClaims {
  sub: string;
  email?: string;
  preferred_username?: string;
  name?: string;
}

/** Decode a JWT payload without verifying signature (used for id_token claims). */
function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  try {
    const pad = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(pad, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Tolerance for clock drift between this host and the provider, in seconds.
 *
 * Without it a correctly issued token is rejected whenever the two machines
 * disagree by a second, which is most of the time. A minute is the usual
 * allowance and is short enough that it does not meaningfully extend the life
 * of an expired token.
 */
const CLOCK_SKEW_SECONDS = 60;

/**
 * Check the claims an `id_token` asserts about itself, and return them.
 *
 * These are the checks that make an unverified-signature token usable at all
 * (see the module docblock). Each one closes a distinct hole:
 *
 *  - **`iss`** — a token from some other provider entirely, replayed here.
 *  - **`aud`** (and `azp` when the audience is shared) — a token this provider
 *    legitimately minted, but for a *different client*. Without this check any
 *    other application registered with the same IdP can hand over one of its
 *    own tokens and be signed in as that user here.
 *  - **`exp`** / **`nbf`** — a token that has expired, or is not yet valid.
 *
 * Throws with a specific message rather than returning null: every failure here
 * is something the admin needs to read in order to fix their configuration.
 */
export function validateIdTokenClaims(
  payload: Record<string, unknown> | null,
  cfg: { issuer: string; clientId: string },
  nowSeconds: number = Math.floor(Date.now() / 1000)
): OidcClaims {
  if (!payload) throw new Error("The id_token could not be decoded.");

  const sub = payload.sub;
  if (typeof sub !== "string" || !sub) throw new Error("The id_token has no subject (sub).");

  const iss = payload.iss;
  if (typeof iss !== "string" || normaliseIssuer(iss) !== normaliseIssuer(cfg.issuer)) {
    throw new Error(
      `The id_token was issued by "${String(iss)}", not the configured issuer ` +
        `"${cfg.issuer}".`
    );
  }

  // `aud` is a string or an array of strings; either must contain our client id.
  const aud = payload.aud;
  const audiences = typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud : [];
  if (!audiences.includes(cfg.clientId)) {
    throw new Error("The id_token is addressed to a different OIDC client.");
  }
  // With several audiences the spec requires `azp`, and it must be us —
  // otherwise a token shared across clients is accepted by all of them.
  if (audiences.length > 1 && payload.azp !== cfg.clientId) {
    throw new Error("The id_token has multiple audiences and is authorised for a different party.");
  }

  const exp = payload.exp;
  if (typeof exp !== "number") throw new Error("The id_token has no expiry (exp).");
  if (exp + CLOCK_SKEW_SECONDS < nowSeconds) throw new Error("The id_token has expired.");

  const nbf = payload.nbf;
  if (typeof nbf === "number" && nbf - CLOCK_SKEW_SECONDS > nowSeconds) {
    throw new Error("The id_token is not valid yet.");
  }

  return payload as unknown as OidcClaims;
}

/**
 * Resolve identity claims.
 *
 * The `id_token` is validated first whenever there is one, because it is what
 * binds this response to this client — and its `sub` is then the yardstick the
 * userinfo response has to agree with (OIDC Core §5.3.2). Userinfo is still
 * preferred for the *contents* of the identity: it is the authoritative and
 * current source for the username and email, which an id_token may carry only
 * a stale copy of.
 */
export async function fetchClaims(cfg: OidcConfig, tokens: TokenResponse): Promise<OidcClaims> {
  const verified = tokens.id_token
    ? validateIdTokenClaims(decodeJwtPayload(tokens.id_token), cfg)
    : null;

  if (cfg.userinfoUrl && tokens.access_token) {
    assertSecureEndpoint(cfg.userinfoUrl, "userinfo endpoint");
    const res = await safeFetch(cfg.userinfoUrl, {
      headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: "application/json" },
      cache: "no-store",
    });
    if (res.ok) {
      const c = (await res.json()) as OidcClaims;
      // A userinfo response naming a different subject is not a richer answer,
      // it is a contradiction — refuse rather than pick one.
      if (verified && c.sub !== verified.sub) {
        throw new Error("The userinfo response is for a different user than the id_token.");
      }
      if (c.sub) return c;
    }
  }

  if (verified) return verified;
  throw new Error("Could not resolve OIDC user identity (no userinfo/id_token).");
}

/** Pick a stable username from claims. */
export function usernameFromClaims(c: OidcClaims): string {
  return c.preferred_username || c.email || c.name || c.sub;
}

/** Check the allow-list (empty = allow all). */
export function isUserAllowed(cfg: OidcConfig, c: OidcClaims): boolean {
  if (!cfg.allowedUsers.length) return true;
  const candidates = [c.preferred_username, c.email, c.sub].filter(Boolean).map((x) => x!.toLowerCase());
  const allowed = cfg.allowedUsers.map((x) => x.toLowerCase());
  return candidates.some((x) => allowed.includes(x));
}
