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
import {
  isArrKind,
  mediaTypeFor,
  parseArrWebhook,
  resolveWebhookConnection,
  tokenMatches,
  webhookTokenFromRequest,
} from "@/lib/webhook";
import { enqueueSweep } from "@/lib/sweepQueue";

/**
 * Sonarr / Radarr webhook receiver: `POST /api/webhook/sonarr` (Sonarr's
 * "On Series Add") and `POST /api/webhook/radarr` (Radarr's "On Movie Added").
 *
 * This is the one endpoint in the app that answers without a session — an *arr
 * has no way to hold one — so it authenticates with the shared secret from
 * Settings instead, and `proxy.ts` lets exactly this path through the session
 * gate. Everything it will act on is decided in `lib/webhook.ts`.
 *
 * It never sweeps inline. The title is queued and the response returns at once:
 * a Sonarr notification that waits on a full sweep times out and is recorded as
 * a failure, and only one run may be active anyway. `lib/sweepQueue.ts` is what
 * turns the queue into runs.
 */

export const dynamic = "force-dynamic";

const log = logger("webhook");

type Ctx = { params: Promise<{ arr: string }> };

/**
 * Rate limit on rejected calls, keyed per client and instance-wide.
 *
 * The endpoint is public and guarded by one secret, so this is what stops it
 * from being an unlimited guessing oracle. Only failures count, so a busy
 * instance with the right token is never throttled. The global backstop
 * matters more than usual here: with TRUST_PROXY off every caller shares the
 * "unknown" bucket anyway (see lib/request.ts).
 */
function rateKeys(req: NextRequest): { client: string; global: string } {
  return { client: `webhook:${clientIp(req)}`, global: "webhook:global" };
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const kind = (await ctx.params).arr?.toLowerCase() ?? "";
  if (!isArrKind(kind)) {
    return NextResponse.json({ ok: false, error: "Unknown webhook endpoint." }, { status: 404 });
  }

  const keys = rateKeys(req);
  for (const key of [keys.client, keys.global]) {
    const limit = checkRateLimit(key);
    if (!limit.allowed) {
      return NextResponse.json(
        { ok: false, error: "Too many rejected webhook calls." },
        { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
      );
    }
  }

  const settings = await getSettings();

  // Rejected before the token is even looked at: while webhooks are off there
  // is no secret to compare against, and saying "disabled" tells the operator
  // exactly which switch is missing.
  if (!settings.webhookEnabled) {
    return NextResponse.json(
      {
        ok: false,
        error: "Webhook-triggered sweeps are switched off. Enable them in Settings → Run options.",
      },
      { status: 503 }
    );
  }
  // Switched on but no usable token: either it was never generated, or
  // AUTH_SECRET changed and it can no longer be decrypted. Both are fixed by
  // regenerating, and calling this "switched off" would send the operator to
  // the wrong control.
  if (!settings.webhookToken) {
    log.error(`rejected ${kind} webhook: no usable webhook token is stored.`);
    return NextResponse.json(
      {
        ok: false,
        error:
          "No webhook token is stored (it may no longer be readable after an AUTH_SECRET " +
          "change). Regenerate it in Settings → Run options and update this URL.",
      },
      { status: 503 }
    );
  }

  if (!tokenMatches(webhookTokenFromRequest(req), settings.webhookToken)) {
    registerFailure(keys.client);
    registerFailure(keys.global, GLOBAL_POLICY);
    log.warn(`rejected ${kind} webhook: bad or missing token.`);
    return NextResponse.json({ ok: false, error: "Invalid webhook token." }, { status: 401 });
  }
  resetRateLimit(keys.client);

  // Only now is the body worth reading. An *arr always sends JSON; anything
  // else is a misconfigured client rather than something to act on.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Expected a JSON body." }, { status: 400 });
  }

  const event = parseArrWebhook(kind, body);

  const requestedConnection = req.nextUrl.searchParams.get("connection");
  const connectionId = requestedConnection ? Number(requestedConnection) : null;
  if (requestedConnection && !Number.isInteger(connectionId)) {
    return NextResponse.json(
      { ok: false, error: "The connection parameter must be a connection id." },
      { status: 400 }
    );
  }

  const match = resolveWebhookConnection(kind, settings.connections, {
    connectionId,
    instanceName: event.instanceName,
  });
  if (!match.ok) {
    return NextResponse.json({ ok: false, error: match.error }, { status: match.status });
  }

  // The Test button. Resolving the connection first is the point of answering
  // it at all: it proves the URL, the token and the addressing all work before
  // the user saves the connection.
  if (event.kind === "test") {
    return NextResponse.json({
      ok: true,
      message: `Webhook reached StreamSweeparr and matched "${match.connection.name}".`,
      connection: match.connection.name,
    });
  }

  if (event.kind !== "added") {
    // Every other trigger the user may have ticked. A quiet 200 keeps their
    // *arr log clean; a 4xx here would look like a broken connection.
    return NextResponse.json({ ok: true, ignored: true, eventType: event.eventType });
  }

  await enqueueSweep({
    connectionId: match.connection.id,
    mediaType: mediaTypeFor(kind),
    arrId: event.arrId!,
    title: event.title!,
    eventType: event.eventType,
  });
  log.info(`queued a sweep for "${event.title}" from "${match.connection.name}".`);

  // 202: accepted, not yet done. The sweep starts once the title has settled.
  return NextResponse.json(
    { ok: true, queued: true, title: event.title, connection: match.connection.name },
    { status: 202 }
  );
}
