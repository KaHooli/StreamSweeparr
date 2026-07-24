import { NextRequest } from "next/server";

/**
 * Best-effort client IP for rate-limiting / logging. Honours common proxy
 * headers. Not authoritative for security decisions, but adequate for
 * per-client login throttling in a self-hosted setup.
 */
export function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}

/**
 * The public-facing origin of the app (e.g. "https://sweep.example.com"),
 * used to build absolute URLs that external systems (OIDC providers, browsers)
 * must see — NOT the internal container/localhost address.
 *
 * Resolution order:
 *   1. PUBLIC_URL env var (explicit; most reliable behind a reverse proxy).
 *   2. Standard proxy forwarding headers (X-Forwarded-Proto / -Host).
 *   3. The Host header.
 *   4. req.nextUrl.origin (last resort — may be the internal address).
 */
export function publicOrigin(req: NextRequest): string {
  const explicit = process.env.PUBLIC_URL;
  if (explicit) return explicit.replace(/\/+$/, "");

  const proto =
    firstHeader(req, "x-forwarded-proto") ||
    (req.nextUrl.protocol ? req.nextUrl.protocol.replace(/:$/, "") : "http");
  const host =
    firstHeader(req, "x-forwarded-host") ||
    req.headers.get("host") ||
    req.nextUrl.host;

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
