import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getSettings } from "@/lib/db";
import { logger } from "@/lib/logger";
import { clientIp } from "@/lib/request";
import {
  checkRateLimit,
  registerFailure,
  resetRateLimit,
  GLOBAL_POLICY,
} from "@/lib/ratelimit";
import { feedTokenFromRequest, getFeed, parseTmdbIds } from "@/lib/feed";
import { isFeedKind } from "@/lib/feedUrl";
import { tokenMatches } from "@/lib/sharedSecret";

/**
 * The streaming-link feed: `GET /api/feed/tv` and `GET /api/feed/movies`.
 *
 * Read by another self-hosted program, which has no way to hold a session, so
 * — like the webhook receiver — this route is let through the session gate by
 * `proxy.ts` and authenticates itself: a kill switch (`feedEnabled`, off by
 * default), its own key (`feedToken`, compared in constant time) and a rate
 * limit on rejected calls. What it returns is decided in `lib/feed.ts`.
 *
 * It never calls a provider: the answer is the snapshot the last sync wrote.
 */

export const dynamic = "force-dynamic";

const log = logger("feed");

type Ctx = { params: Promise<{ kind: string }> };

/**
 * Rate limit on rejected calls, per client and instance-wide — the same shape
 * as the webhook's, and for the same reason: one secret guards a public route,
 * so this is what stops it being an unlimited guessing oracle. Separate keys
 * from the webhook's, so a misconfigured feed consumer hammering away with an
 * old key cannot lock Sonarr out of reporting new series.
 */
function rateKeys(req: NextRequest): { client: string; global: string } {
  return { client: `feed:${clientIp(req)}`, global: "feed:global" };
}

/**
 * A strong validator over the payload *minus* `generatedAt`, which changes on
 * every call and would otherwise make every response look new. A consumer
 * polling with `If-None-Match` then gets a bodiless 304 until a sync actually
 * changes something.
 */
function etagFor(body: unknown): string {
  return `"${createHash("sha256").update(JSON.stringify(body)).digest("base64url")}"`;
}

function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  return header
    .split(",")
    .map((t) => t.trim().replace(/^W\//, ""))
    .includes(etag);
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const kind = (await ctx.params).kind?.toLowerCase() ?? "";
  if (!isFeedKind(kind)) {
    return NextResponse.json({ ok: false, error: "Unknown feed." }, { status: 404 });
  }

  const keys = rateKeys(req);
  for (const key of [keys.client, keys.global]) {
    const limit = checkRateLimit(key);
    if (!limit.allowed) {
      return NextResponse.json(
        { ok: false, error: "Too many rejected feed requests." },
        { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
      );
    }
  }

  const settings = await getSettings();

  if (!settings.feedEnabled) {
    return NextResponse.json(
      {
        ok: false,
        error: "The streaming-link feed is switched off. Enable it in Settings → Connections.",
      },
      { status: 503 }
    );
  }
  // On, but no usable key: never minted, or AUTH_SECRET changed and it can no
  // longer be decrypted. Regenerating fixes both, and "switched off" would
  // send the admin to the wrong control.
  if (!settings.feedToken) {
    log.error(`rejected ${kind} feed request: no usable feed key is stored.`);
    return NextResponse.json(
      {
        ok: false,
        error:
          "No feed key is stored (it may no longer be readable after an AUTH_SECRET change). " +
          "Regenerate it in Settings → Connections and update the app reading the feed.",
      },
      { status: 503 }
    );
  }

  if (!tokenMatches(feedTokenFromRequest(req), settings.feedToken)) {
    registerFailure(keys.client);
    registerFailure(keys.global, GLOBAL_POLICY);
    log.warn(`rejected ${kind} feed request: bad or missing key.`);
    return NextResponse.json({ ok: false, error: "Invalid feed key." }, { status: 401 });
  }
  resetRateLimit(keys.client);

  const tmdbIds = parseTmdbIds(req.nextUrl.searchParams);
  if (tmdbIds && !Array.isArray(tmdbIds)) {
    return NextResponse.json({ ok: false, error: tmdbIds.error }, { status: 400 });
  }

  const feed = await getFeed(kind, { tmdbIds });
  const { generatedAt: _generatedAt, ...stable } = feed;
  const etag = etagFor(stable);
  const headers = {
    ETag: etag,
    // Revalidate every time, but let the consumer keep its copy for the 304.
    // `private`: it is one install's library, never for a shared cache.
    "Cache-Control": "private, no-cache",
  };

  if (etagMatches(req.headers.get("if-none-match"), etag)) {
    return new NextResponse(null, { status: 304, headers });
  }
  return NextResponse.json(feed, { headers });
}
