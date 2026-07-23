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
