/**
 * SSRF-hardened fetch for URLs that originate from user input (Sonarr/Radarr
 * base URLs, Seerr, OIDC endpoints).
 *
 * Protections:
 *   - Only http/https schemes are allowed.
 *   - The hostname is DNS-resolved and every resolved IP is checked; requests
 *     to loopback, link-local (incl. the 169.254.169.254 cloud-metadata
 *     address), unspecified and multicast ranges are ALWAYS blocked.
 *   - Private/LAN ranges (10/8, 172.16/12, 192.168/16, IPv6 ULA) are blocked
 *     unless SSRF_ALLOW_PRIVATE=true — self-hosted users whose *arr apps live on
 *     a private LAN must opt in explicitly.
 *   - A request timeout is enforced via AbortController (default 15s).
 *
 * Node-runtime only (uses node:dns / node:net). Never import from the edge.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

const allowPrivate = () => process.env.SSRF_ALLOW_PRIVATE === "true";

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

function inCidr4(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

// Ranges that must never be reachable, regardless of SSRF_ALLOW_PRIVATE.
function isAlwaysBlocked4(ip: string): boolean {
  return (
    inCidr4(ip, "127.0.0.0", 8) || // loopback
    inCidr4(ip, "0.0.0.0", 8) || // "this host"
    inCidr4(ip, "169.254.0.0", 16) || // link-local incl. cloud metadata
    inCidr4(ip, "224.0.0.0", 4) || // multicast
    inCidr4(ip, "255.255.255.255", 32) // broadcast
  );
}

// Private/LAN ranges, blocked unless explicitly allowed.
function isPrivate4(ip: string): boolean {
  return (
    inCidr4(ip, "10.0.0.0", 8) ||
    inCidr4(ip, "172.16.0.0", 12) ||
    inCidr4(ip, "192.168.0.0", 16) ||
    inCidr4(ip, "100.64.0.0", 10) // CGNAT
  );
}

function normalizeV6(ip: string): string {
  return ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
}

function isAlwaysBlocked6(ip: string): boolean {
  const a = normalizeV6(ip);
  if (a === "::1" || a === "::") return true; // loopback / unspecified
  if (a.startsWith("fe80")) return true; // link-local
  if (a.startsWith("ff")) return true; // multicast
  // IPv4-mapped (::ffff:127.0.0.1 etc.) — check the embedded v4.
  const mapped = a.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isAlwaysBlocked4(mapped[1]);
  return false;
}

function isPrivate6(ip: string): boolean {
  const a = normalizeV6(ip);
  if (a.startsWith("fc") || a.startsWith("fd")) return true; // ULA fc00::/7
  const mapped = a.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivate4(mapped[1]);
  return false;
}

function assertIpAllowed(ip: string) {
  const fam = isIP(ip);
  if (fam === 4) {
    if (isAlwaysBlocked4(ip)) throw new SsrfError(`Blocked address ${ip} (loopback/link-local/metadata).`);
    if (!allowPrivate() && isPrivate4(ip))
      throw new SsrfError(`Blocked private address ${ip}. Set SSRF_ALLOW_PRIVATE=true to allow LAN hosts.`);
  } else if (fam === 6) {
    if (isAlwaysBlocked6(ip)) throw new SsrfError(`Blocked address ${ip} (loopback/link-local/metadata).`);
    if (!allowPrivate() && isPrivate6(ip))
      throw new SsrfError(`Blocked private address ${ip}. Set SSRF_ALLOW_PRIVATE=true to allow LAN hosts.`);
  } else {
    throw new SsrfError(`Unresolvable address: ${ip}`);
  }
}

/** Validate a user-supplied URL and its resolved IP(s). Returns parsed URL. */
export async function assertUrlAllowed(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError("Invalid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfError(`Unsupported scheme: ${url.protocol}`);
  }
  const host = url.hostname;

  // If the host is already a literal IP, check it directly.
  if (isIP(host)) {
    assertIpAllowed(host);
    return url;
  }

  // Resolve all A/AAAA records and check each (defends against DNS rebinding
  // to some extent — we check what the resolver returns at request time).
  const results = await lookup(host, { all: true }).catch(() => {
    throw new SsrfError(`Could not resolve host: ${host}`);
  });
  if (!results.length) throw new SsrfError(`Could not resolve host: ${host}`);
  for (const r of results) assertIpAllowed(r.address);
  return url;
}

export interface SafeFetchOptions extends RequestInit {
  timeoutMs?: number;
}

/**
 * Fetch a user-supplied URL with SSRF checks + a hard timeout.
 * Redirects are disabled to prevent a first-hop-allowed URL redirecting to a
 * blocked internal address.
 */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<Response> {
  await assertUrlAllowed(rawUrl);
  const { timeoutMs = 15_000, ...init } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(rawUrl, {
      ...init,
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      throw new SsrfError(`Request to ${rawUrl} timed out after ${timeoutMs}ms.`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
