import { NextRequest } from "next/server";

/**
 * Whether `X-Forwarded-*` headers may be believed.
 *
 * They are trivially spoofable by any client that can reach the app directly,
 * and `clientIp` feeds the login rate limiter — so an untrusted forwarded
 * header means an attacker picks their own bucket and never gets locked out.
 * Only a reverse proxy that *overwrites* these headers makes them meaningful,
 * so trusting them is opt-in via TRUST_PROXY=true.
 */
export function trustProxy(): boolean {
  return process.env.TRUST_PROXY === "true";
}

/**
 * Best-effort client IP for rate-limiting / logging.
 *
 * Honours proxy headers only when TRUST_PROXY is set. Otherwise every direct
 * client collapses into one bucket, which is deliberately conservative: the
 * per-username and global limiters in the login route still bound brute force,
 * whereas an attacker-chosen bucket would bound nothing.
 */
export function clientIp(req: NextRequest): string {
  if (trustProxy()) {
    const xff = req.headers.get("x-forwarded-for");
    if (xff) return xff.split(",")[0].trim();
    const real = req.headers.get("x-real-ip");
    if (real) return real.trim();
  }
  // `req.ip` is populated by some hosts; self-hosted Node usually leaves it
  // undefined, in which case all direct clients share the "unknown" bucket.
  return req.ip?.trim() || "unknown";
}

/**
 * A syntactically valid HTTP host (`example.com`, `host:3000`, `[::1]:3000`).
 * Anything else is a header the app should not echo into a redirect.
 */
function isPlausibleHost(host: string): boolean {
  if (host.length > 255) return false;
  return /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9._-]+)(:\d{1,5})?$/.test(host);
}

/**
 * The public-facing origin of the app (e.g. "https://sweep.example.com"),
 * used to build absolute URLs that external systems (OIDC providers, browsers)
 * must see — NOT the internal container/localhost address.
 *
 * Resolution order:
 *   1. PUBLIC_URL env var (explicit; the only source an attacker cannot
 *      influence, and therefore what you want set in production).
 *   2. Standard proxy forwarding headers, when TRUST_PROXY is set.
 *   3. The Host header.
 *   4. req.nextUrl.origin (last resort — may be the internal address).
 *
 * Host values that are not syntactically valid hosts are discarded rather than
 * interpolated into a redirect URL.
 */
export function publicOrigin(req: NextRequest): string {
  const explicit = process.env.PUBLIC_URL;
  if (explicit) return explicit.replace(/\/+$/, "");

  const forwardedProto = trustProxy() ? firstHeader(req, "x-forwarded-proto") : null;
  const proto =
    forwardedProto ||
    (req.nextUrl.protocol ? req.nextUrl.protocol.replace(/:$/, "") : "http");

  const forwardedHost = trustProxy() ? firstHeader(req, "x-forwarded-host") : null;
  const host = [forwardedHost, req.headers.get("host"), req.nextUrl.host]
    .map((h) => h?.trim())
    .find((h): h is string => !!h && isPlausibleHost(h));

  if (host) return `${proto}://${host}`;
  return req.nextUrl.origin;
}

function firstHeader(req: NextRequest, name: string): string | null {
  const v = req.headers.get(name);
  if (!v) return null;
  // These headers may be comma-separated when passing through multiple proxies.
  return v.split(",")[0].trim() || null;
}

/** The OIDC redirect/callback URL. Must be identical in authorize + callback. */
export function oidcRedirectUri(req: NextRequest): string {
  // Allow a fully explicit override for tricky proxy setups.
  const override = process.env.OIDC_REDIRECT_URI;
  if (override) return override;
  return `${publicOrigin(req)}/api/auth/oidc/callback`;
}
