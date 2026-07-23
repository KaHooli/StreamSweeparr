/**
 * OpenID Connect (Authorization Code + PKCE) helper.
 *
 * No external dependency: uses `fetch` for discovery / token exchange /
 * userinfo and Node crypto for PKCE + state. Node-runtime only (API routes).
 *
 * Enabled when Settings has oidcEnabled + issuer + clientId + clientSecret.
 * Endpoints are auto-discovered from `<issuer>/.well-known/openid-configuration`
 * unless explicitly overridden in Settings.
 */
import { randomBytes, createHash } from "node:crypto";
import { getSettings } from "./db";

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

async function discover(issuer: string): Promise<Discovery> {
  const cached = discoveryCache.get(issuer);
  if (cached && cached.expires > Date.now()) return cached.doc;
  const base = issuer.replace(/\/+$/, "");
  const url = `${base}/.well-known/openid-configuration`;
  const res = await fetch(url, { cache: "no-store" });
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

export function isOidcEnabled(s: { oidcEnabled: boolean; oidcIssuer: string | null; oidcClientId: string | null; oidcClientSecret: string | null }) {
  return !!(s.oidcEnabled && s.oidcIssuer && s.oidcClientId && s.oidcClientSecret);
}

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
  const res = await fetch(cfg.tokenUrl, {
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
 * Resolve identity claims. Prefers the userinfo endpoint (authoritative);
 * falls back to id_token claims.
 */
export async function fetchClaims(cfg: OidcConfig, tokens: TokenResponse): Promise<OidcClaims> {
  if (cfg.userinfoUrl && tokens.access_token) {
    const res = await fetch(cfg.userinfoUrl, {
      headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: "application/json" },
      cache: "no-store",
    });
    if (res.ok) {
      const c = (await res.json()) as OidcClaims;
      if (c.sub) return c;
    }
  }
  if (tokens.id_token) {
    const p = decodeJwtPayload(tokens.id_token);
    if (p && typeof p.sub === "string") return p as unknown as OidcClaims;
  }
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
