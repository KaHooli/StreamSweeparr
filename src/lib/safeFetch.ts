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
 *   - IPv6 is judged on the sixteen bytes an address expands to, not on how it
 *     happens to be written, and the four formats that carry an IPv4 address
 *     inside an IPv6 one are judged by the IPv4 rules. Both matter: the same
 *     host has many spellings, and a rule that recognises only one of them
 *     blocks only one of them.
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

/** Strip the brackets of a URL host and any zone id, and lower-case it. */
function normalizeV6(ip: string): string {
  return ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
}

/**
 * Expand an IPv6 address to the sixteen bytes it stands for, or null if it is
 * not one.
 *
 * Classifying IPv6 by the *text* does not work, and the ways it fails are the
 * ways an SSRF guard gets walked past. Every address has many spellings — `::`
 * compresses a run of zero groups, the last four bytes may be written as a
 * dotted quad, hex digits may be either case — and they all reach the same
 * host. `::ffff:7f00:1` is 127.0.0.1 written in hex, and a prefix test looking
 * for `::ffff:127.` sees nothing to object to. Likewise a `fe80` prefix test
 * covers only the first quarter of `fe80::/10`, so `feb0::1` is link-local and
 * reads as public.
 *
 * So the text is parsed once, here, and every rule below is a check on bytes.
 */
function ipv6Bytes(raw: string): Uint8Array | null {
  let text = normalizeV6(raw);
  if (isIP(text) !== 6) return null;

  // A trailing dotted quad ("::ffff:127.0.0.1") spells out the final four
  // bytes. Lift it off and put two zero groups in its place, so what is left is
  // pure hex groups; the bytes are written back at the end.
  let embedded: number[] | null = null;
  if (text.includes(".")) {
    const cut = text.lastIndexOf(":") + 1;
    const quad = text.slice(cut).split(".");
    if (quad.length !== 4) return null;
    embedded = quad.map(Number);
    if (embedded.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    text = `${text.slice(0, cut)}0:0`;
  }

  // "::" stands for however many zero groups are needed to reach eight, and may
  // appear at most once.
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;
  if (tail === null ? head.length !== 8 : head.length + tail.length > 8) return null;

  const groups = new Array<number>(8).fill(0);
  const place = (parts: string[], offset: number) => {
    for (let i = 0; i < parts.length; i++) {
      const g = parseInt(parts[i], 16);
      if (!Number.isInteger(g) || g < 0 || g > 0xffff) return false;
      groups[offset + i] = g;
    }
    return true;
  };
  if (!place(head, 0)) return null;
  if (tail && !place(tail, 8 - tail.length)) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    bytes[i * 2] = groups[i] >> 8;
    bytes[i * 2 + 1] = groups[i] & 0xff;
  }
  if (embedded) bytes.set(embedded, 12);
  return bytes;
}

/**
 * The IPv4 address an IPv6 address stands for, or null if it stands for none.
 *
 * Four transition formats carry an IPv4 address inside an IPv6 one, and each is
 * a way of naming an IPv4 host that no IPv6 rule would look at. They are judged
 * by the IPv4 rules instead, which is what keeps `::ffff:169.254.169.254` and
 * `2002:a9fe:a9fe::` as far from the metadata service as `169.254.169.254` is.
 */
function embeddedIpv4(b: Uint8Array): string | null {
  const zeros = (from: number, to: number) => b.subarray(from, to).every((x) => x === 0);
  const last4 = () => `${b[12]}.${b[13]}.${b[14]}.${b[15]}`;

  // ::ffff:a.b.c.d — IPv4-mapped, what a dual-stack socket reports for an IPv4 peer.
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return last4();
  // ::a.b.c.d — the deprecated IPv4-compatible form. `::` and `::1` share the
  // shape and are addresses in their own right, so they are left to the caller.
  if (zeros(0, 12) && !(zeros(12, 15) && b[15] <= 1)) return last4();
  // 64:ff9b::/96 — the well-known NAT64 prefix.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) return last4();
  // 2002::/16 — 6to4 carries its IPv4 address in the two groups after the prefix.
  if (b[0] === 0x20 && b[1] === 0x02) return `${b[2]}.${b[3]}.${b[4]}.${b[5]}`;
  return null;
}

// Ranges that must never be reachable, regardless of SSRF_ALLOW_PRIVATE.
function isAlwaysBlocked6(b: Uint8Array): boolean {
  const v4 = embeddedIpv4(b);
  if (v4) return isAlwaysBlocked4(v4);
  if (b.every((x) => x === 0)) return true; // :: unspecified
  if (b.subarray(0, 15).every((x) => x === 0) && b[15] === 1) return true; // ::1 loopback
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b[0] === 0xff) return true; // ff00::/8 multicast
  return false;
}

// Private/LAN ranges, blocked unless explicitly allowed.
function isPrivate6(b: Uint8Array): boolean {
  const v4 = embeddedIpv4(b);
  if (v4) return isPrivate4(v4);
  return (b[0] & 0xfe) === 0xfc; // fc00::/7 ULA
}

function assertIpAllowed(ip: string) {
  // Normalised once, and every check below reads the normalised form. Handing
  // one of them the raw string is how a bracketed or zoned address gets
  // classified by a parser that does not understand it — `ipv4ToInt("[1")` is
  // NaN, and NaN masks to 0.0.0.0, which matches whatever the first rule tests.
  const addr = normalizeV6(ip);
  const fam = isIP(addr);
  if (fam === 4) {
    if (isAlwaysBlocked4(addr)) throw new SsrfError(`Blocked address ${addr} (loopback/link-local/metadata).`);
    if (!allowPrivate() && isPrivate4(addr))
      throw new SsrfError(`Blocked private address ${addr}. Set SSRF_ALLOW_PRIVATE=true to allow LAN hosts.`);
  } else if (fam === 6) {
    // `isIP` has already said this is an address, so a parse failure here means
    // the two disagree about what IPv6 is. Refuse it rather than let a spelling
    // neither of them classifies through unchecked.
    const bytes = ipv6Bytes(addr);
    if (!bytes) throw new SsrfError(`Unparseable address: ${addr}`);
    if (isAlwaysBlocked6(bytes)) throw new SsrfError(`Blocked address ${addr} (loopback/link-local/metadata).`);
    if (!allowPrivate() && isPrivate6(bytes))
      throw new SsrfError(`Blocked private address ${addr}. Set SSRF_ALLOW_PRIVATE=true to allow LAN hosts.`);
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
  // WHATWG `hostname` keeps the brackets an IPv6 literal is written with
  // ("[::1]"), and `isIP` does not recognise that spelling. Left as-is the
  // literal branch below never fires for IPv6: "[::1]" fell through to the
  // resolver, which cannot look up a bracketed host either, so *every* IPv6
  // literal — a public one included — was refused as "could not resolve" and
  // no address rule was ever consulted.
  const host = url.hostname.replace(/^\[|\]$/g, "");

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
