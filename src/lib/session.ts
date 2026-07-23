/**
 * Stateless session tokens (a compact HMAC-signed JWT-like token).
 *
 * Uses the Web Crypto API (HMAC-SHA256) so it can be verified inside Next.js
 * middleware, which runs on the edge runtime and has no access to Node crypto.
 *
 * The signing secret comes from AUTH_SECRET; if unset we derive a stable
 * fallback so the app still boots (a warning is logged). Set AUTH_SECRET in
 * production so sessions survive restarts and can't be forged.
 */

export const SESSION_COOKIE = "ss_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export interface SessionPayload {
  sub: number; // user id
  username: string;
  isAdmin: boolean;
  method: "local" | "oidc";
  exp: number; // unix seconds
}

function getSecret(): string {
  const s = process.env.AUTH_SECRET;
  if (s && s.length >= 16) return s;
  if (process.env.NODE_ENV === "production") {
    // eslint-disable-next-line no-console
    console.warn(
      "[auth] AUTH_SECRET is not set (or too short). Using an insecure fallback — set AUTH_SECRET!"
    );
  }
  return "streamsweeparr-insecure-dev-secret-change-me";
}

/* ---------------------- base64url helpers (edge-safe) ---------------------- */
function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(str: string): Uint8Array {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const enc = new TextEncoder();

async function hmacKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(getSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Create a signed session token for the given user. */
export async function createSession(
  user: { id: number; username: string; isAdmin: boolean },
  method: "local" | "oidc"
): Promise<string> {
  const payload: SessionPayload = {
    sub: user.id,
    username: user.username,
    isAdmin: user.isAdmin,
    method,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const key = await hmacKey();
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return `${body}.${b64urlEncode(new Uint8Array(sig))}`;
}

/** Verify a token and return its payload, or null if invalid/expired. */
export async function verifySession(token: string | undefined | null): Promise<SessionPayload | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  try {
    const key = await hmacKey();
    const expected = b64urlEncode(
      new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)))
    );
    if (!timingSafeEqual(sig, expected)) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as SessionPayload;
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}
