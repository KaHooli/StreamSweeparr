/**
 * Webhook-triggered sweeps — payload parsing and authentication.
 *
 * Sonarr's "On Series Add" and Radarr's "On Movie Added" connections POST a
 * small JSON body the moment a title is added. This module turns that body into
 * "sweep title N on instance M", and decides whether the caller was allowed to
 * ask. Everything here is pure (no database, no network) so the decision matrix
 * — which event types count, which credential positions are honoured, how an
 * instance is matched to a connection — is unit-testable on its own.
 *
 * Node-runtime only (node:crypto). The receiving route is not behind the
 * session gate, so the shared secret below is the *only* thing standing in
 * front of it. Addressing lives in `lib/webhookUrl.ts` instead, because the
 * Settings card has to build the same URLs in the browser.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { connectionTypeFor, type ArrKind } from "./webhookUrl";

export type { ArrKind };
export { ARR_KINDS, connectionTypeFor, isArrKind, mediaTypeFor, webhookUrl } from "./webhookUrl";

/* ----------------------------- Shared secret ---------------------------- */

/**
 * Mint a webhook token.
 *
 * 24 bytes of randomness rendered base64url: URL-safe, so it can be pasted
 * straight into the query string of the URL the user gives Sonarr, and long
 * enough that guessing it is not a strategy.
 */
export function generateWebhookToken(): string {
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

/**
 * Pull the shared secret out of a request.
 *
 * Sonarr and Radarr differ in what they can send, and both have changed across
 * versions, so all four of the places a token can plausibly arrive are
 * accepted:
 *
 *   1. `?token=` / `?apikey=` in the URL — works on every version of both apps,
 *      and is what the Settings card hands you.
 *   2. `X-Webhook-Token` — for versions with custom webhook headers.
 *   3. `Authorization: Bearer <token>`.
 *   4. `Authorization: Basic <user:token>` — the Username/Password fields on
 *      the Connect screen. The password is the token; the username is ignored.
 */
export function webhookTokenFromRequest(req: {
  url: string;
  headers: Headers;
}): string | null {
  const query = new URL(req.url).searchParams;
  const fromQuery = query.get("token") ?? query.get("apikey");
  if (fromQuery) return fromQuery;

  const header = req.headers.get("x-webhook-token");
  if (header) return header.trim();

  const auth = req.headers.get("authorization");
  if (auth) {
    const bearer = /^Bearer\s+(.+)$/i.exec(auth);
    if (bearer) return bearer[1].trim();
    const basic = /^Basic\s+(.+)$/i.exec(auth);
    if (basic) {
      const decoded = Buffer.from(basic[1].trim(), "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      if (colon >= 0) return decoded.slice(colon + 1) || null;
    }
  }

  return null;
}

/* ------------------------------- Payloads ------------------------------- */

/** What a payload turned out to be asking for. */
export type WebhookEventKind =
  /** A title was added — sweep it. */
  | "added"
  /** The Test button on the Connect screen. Answer, but sweep nothing. */
  | "test"
  /** Some other event (import, upgrade, health check) — nothing to do. */
  | "ignored";

export interface ParsedWebhook {
  kind: WebhookEventKind;
  /** The event type exactly as the *arr spelled it, for logs. */
  eventType: string;
  /** Set for "added": the title's id on the instance. */
  arrId?: number;
  title?: string;
  /** The instance's own name, used to disambiguate multiple connections. */
  instanceName?: string;
}

/**
 * Event types that mean "a title was just added".
 *
 * Sonarr sends `SeriesAdd`; Radarr sends `MovieAdded`. The near-miss spellings
 * are accepted too because the two apps have never agreed on the tense and it
 * costs nothing to tolerate either.
 */
const ADDED_EVENTS: Record<ArrKind, string[]> = {
  sonarr: ["seriesadd", "seriesadded"],
  radarr: ["movieadd", "movieadded"],
};

function readTitleBlock(
  kind: ArrKind,
  body: Record<string, unknown>
): { arrId?: number; title?: string } {
  const block = body[kind === "sonarr" ? "series" : "movie"];
  if (!block || typeof block !== "object") return {};
  const record = block as Record<string, unknown>;
  const id = record.id;
  const title = record.title;
  return {
    arrId: typeof id === "number" && Number.isInteger(id) && id > 0 ? id : undefined,
    title: typeof title === "string" && title.trim() ? title.trim() : undefined,
  };
}

/**
 * Interpret a Sonarr/Radarr webhook body.
 *
 * Anything unrecognised comes back as "ignored" rather than an error: a user
 * who ticks every notification trigger on the Connect screen should get a quiet
 * 200 for the events we don't act on, not a wall of failures in their *arr log.
 */
export function parseArrWebhook(kind: ArrKind, body: unknown): ParsedWebhook {
  if (!body || typeof body !== "object") return { kind: "ignored", eventType: "" };
  const record = body as Record<string, unknown>;

  const eventType = typeof record.eventType === "string" ? record.eventType : "";
  const normalised = eventType.trim().toLowerCase();
  const instanceName =
    typeof record.instanceName === "string" && record.instanceName.trim()
      ? record.instanceName.trim()
      : undefined;

  // Checked before the title block: a Test payload carries a fake series/movie
  // ("Test Title", id 1), and acting on it would sweep whatever really has id 1.
  if (normalised === "test") return { kind: "test", eventType, instanceName };

  if (!ADDED_EVENTS[kind].includes(normalised)) {
    return { kind: "ignored", eventType, instanceName };
  }

  const { arrId, title } = readTitleBlock(kind, record);
  if (!arrId) return { kind: "ignored", eventType, instanceName };

  return { kind: "added", eventType, arrId, title: title ?? `#${arrId}`, instanceName };
}

/* ------------------------------ Addressing ------------------------------ */

export interface WebhookConnection {
  id: number;
  type: string;
  name: string;
  enabled: boolean;
}

export type ConnectionMatch<T extends WebhookConnection> =
  | { ok: true; connection: T }
  | { ok: false; status: 404 | 409; error: string };

/**
 * Work out which configured instance a webhook came from.
 *
 * The Settings card hands out a URL carrying `connection=<id>`, so the usual
 * path is exact. The fallbacks exist for a URL typed by hand: a single instance
 * of that kind is unambiguous, and beyond that the payload's `instanceName` is
 * matched against the connection names. Anything still ambiguous is refused
 * with an explanation rather than guessed at — picking the wrong instance would
 * sweep the wrong library.
 */
export function resolveWebhookConnection<T extends WebhookConnection>(
  kind: ArrKind,
  connections: T[],
  opts: { connectionId?: number | null; instanceName?: string | null } = {}
): ConnectionMatch<T> {
  const wanted = connectionTypeFor(kind);
  const candidates = connections.filter((c) => c.type === wanted && c.enabled);

  if (opts.connectionId != null) {
    const exact = candidates.find((c) => c.id === opts.connectionId);
    if (exact) return { ok: true, connection: exact };
    return {
      ok: false,
      status: 404,
      error:
        `No enabled ${wanted} connection with id ${opts.connectionId}. ` +
        `Re-copy the webhook URL from Settings → Run options.`,
    };
  }

  if (!candidates.length) {
    return { ok: false, status: 404, error: `No enabled ${wanted} connection is configured.` };
  }
  if (candidates.length === 1) return { ok: true, connection: candidates[0] };

  const named = opts.instanceName?.trim().toLowerCase();
  if (named) {
    const byName = candidates.filter((c) => c.name.trim().toLowerCase() === named);
    if (byName.length === 1) return { ok: true, connection: byName[0] };
  }

  return {
    ok: false,
    status: 409,
    error:
      `${candidates.length} ${wanted} connections are configured, so the webhook URL must say ` +
      `which one it is. Use the per-connection URL from Settings → Run options ` +
      `(it ends with "&connection=<id>").`,
  };
}
