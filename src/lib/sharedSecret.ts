/**
 * Shared secrets for the endpoints that answer without a session.
 *
 * Two routes sit outside the session gate and authenticate the caller with a
 * token from Settings instead: the Sonarr/Radarr webhook (`lib/webhook.ts`)
 * and the streaming-link feed (`lib/feed.ts`). Minting and comparing those
 * tokens lives here so the constant-time comparison exists exactly once — a
 * second, hand-copied version is the one that would eventually grow an early
 * length check.
 *
 * Node-runtime only (node:crypto). Never import this from anything the edge
 * proxy can reach.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Mint a token.
 *
 * 24 bytes of randomness rendered base64url: URL-safe, so it can be pasted
 * straight into a query string, and long enough that guessing it is not a
 * strategy.
 */
export function generateToken(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * Constant-time comparison of a presented token against the stored one.
 *
 * Both sides are hashed first so the comparison is over two fixed-length
 * buffers. Comparing the raw strings would need a length check up front, and
 * that check returns early — leaking the token's length to anyone willing to
 * time the endpoint.
 */
export function tokenMatches(
  presented: string | null | undefined,
  expected: string | null | undefined
): boolean {
  if (!presented || !expected) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
