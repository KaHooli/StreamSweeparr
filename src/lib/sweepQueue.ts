/**
 * The queue between a Sonarr/Radarr webhook and a targeted sweep.
 *
 * A webhook cannot simply start a sweep. Only one run may be active at a time,
 * so importing a season of shows would start one sweep and reject the rest —
 * and the endpoint has to answer immediately either way, because an *arr that
 * waits on us marks the notification as failed. So the endpoint only records
 * the title, and a worker turns whatever has accumulated into one sweep.
 *
 * Two properties fall out of that, and both matter:
 *
 *  - **Duplicates collapse.** The queue's key is the title, so a webhook that
 *    fires twice queues one sweep.
 *  - **Titles settle first.** Sonarr fires "On Series Add" the instant the show
 *    is added — before it has fetched the episode list. Sweeping right then
 *    would find nothing to act on, so a title waits `settleMs` before it is
 *    eligible. `WEBHOOK_SWEEP_DELAY_SECONDS` tunes that for slower instances.
 *
 * The queue lives in the database, like the sweep schedule and for the same
 * reasons: a restart mid-flight must not drop the titles, and two replicas must
 * not both sweep them. Claims are exclusive via `claimedBy`.
 */

import { randomUUID } from "node:crypto";
import type { MediaType } from "@/generated/prisma/client";
import { prisma, getSettings } from "./db";
import { logger } from "./logger";
import { runTargetedSweep, type SweepTarget } from "./sweep";
import { RunAbortedError, RunLockError, hasLiveRun } from "./jobs";
import { schedulerDisabledByEnv } from "./schedule";

const log = logger("webhook");

/** How often the worker looks for titles that are ready to sweep. */
export const QUEUE_TICK_MS = 15_000;

/**
 * How long a title waits after being queued before it is swept.
 *
 * Long enough for Sonarr to have pulled the series' episode list, which is what
 * a sweep needs and which does not exist at the moment "On Series Add" fires.
 * It also coalesces a burst of additions into one run.
 */
export const DEFAULT_SETTLE_MS = 60_000;

/** Titles per targeted sweep. Beyond this the rest wait for the next tick. */
const MAX_BATCH = 50;

/**
 * Failed drains before a title is given up on. It is not lost — the next full
 * sweep covers it — so retrying forever only means failing forever.
 */
const MAX_ATTEMPTS = 5;

/**
 * How long a claim may sit untouched before it is a candidate for reclaiming.
 *
 * Only a candidate: the claim is released solely when no run is alive as well
 * (see `hasLiveRun`). A claim's real lifetime is the sweep it is waiting on,
 * and a sweep has no maximum duration — a batch of MAX_BATCH series, each
 * pulling episode availability and then searching, can comfortably outlive any
 * constant put here.
 *
 * This once read purely as a timeout, justified by the run lock's five-minute
 * window. That reasoning confused two different things: five minutes is how
 * long a run may go without a *heartbeat*, not how long it may run. A sweep
 * that took longer than this had its rows reclaimed underneath it, re-claimed
 * under a new token by the next tick, and swept a second time — while the
 * original sweep's `settleClaim` deleted by a token no row carried any more and
 * removed nothing. Duplicated work, and Watchmode credits are the one resource
 * this app is careful with.
 */
const CLAIM_STALE_MS = 10 * 60 * 1000;

/** The settle delay, honouring WEBHOOK_SWEEP_DELAY_SECONDS. */
export function settleMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.WEBHOOK_SWEEP_DELAY_SECONDS?.trim();
  if (!raw) return DEFAULT_SETTLE_MS;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_SETTLE_MS;
  return Math.min(seconds, 3600) * 1000;
}

export interface QueueRequest {
  connectionId: number;
  mediaType: MediaType;
  arrId: number;
  title: string;
  eventType?: string | null;
}

/**
 * Record a title for a sweep of its own.
 *
 * Idempotent: a second webhook for a title already waiting refreshes its label
 * and nothing else. In particular it does not restart the settle timer, so a
 * chatty instance cannot keep pushing a title out of reach of the worker.
 */
export async function enqueueSweep(req: QueueRequest): Promise<{ queued: boolean }> {
  const key = {
    connectionId_mediaType_arrId: {
      connectionId: req.connectionId,
      mediaType: req.mediaType,
      arrId: req.arrId,
    },
  };
  const update = { title: req.title, eventType: req.eventType ?? null };
  try {
    await prisma.queuedSweep.upsert({
      where: key,
      create: {
        connectionId: req.connectionId,
        mediaType: req.mediaType,
        arrId: req.arrId,
        title: req.title,
        eventType: req.eventType ?? null,
      },
      update,
    });
  } catch (e) {
    // Upsert is not atomic against a concurrent insert of the same key, and a
    // bulk import fires webhooks in parallel — so two calls for one title can
    // both find nothing and both try to create it. The loser gets P2002, which
    // means the row it wanted now exists: update it and move on.
    if ((e as { code?: string }).code !== "P2002") throw e;
    await prisma.queuedSweep.update({ where: key, data: update });
  }
  return { queued: true };
}

export type DrainStatus =
  /** Webhook sweeps are switched off in Settings. */
  | "disabled"
  /** Nothing waiting. */
  | "empty"
  /** Titles are queued but still settling. */
  | "waiting"
  /** Another replica claimed everything that was ready. */
  | "claimed_elsewhere"
  /** A run was already in progress; the titles stay queued. */
  | "locked"
  /** A targeted sweep was started. */
  | "started"
  | "error";

export interface DrainResult {
  status: DrainStatus;
  runId?: number;
  /** How many titles the started sweep covers. */
  targets?: number;
  error?: string;
}

/**
 * One pass of the worker: claim what has settled and sweep it.
 *
 * Exported so it can be driven directly (tests, a manual poke) rather than only
 * by the timer.
 */
export async function drainSweepQueue(now: Date = new Date()): Promise<DrainResult> {
  const settings = await getSettings();
  if (!settings.webhookEnabled) return { status: "disabled" };

  // Reclaim rows whose claimer never came back — but only once nothing is
  // running. A live run is the one thing that says an old-looking claim may
  // still be in flight, and deferring costs the queued titles nothing but a
  // tick or two. If the claiming process really did die, its run stops
  // heartbeating and `hasLiveRun` goes false within the same five minutes
  // `startRun` uses to reap the run itself, so this cannot wedge.
  if (!(await hasLiveRun(now))) {
    await prisma.queuedSweep.updateMany({
      where: { claimedAt: { lt: new Date(now.getTime() - CLAIM_STALE_MS) } },
      data: { claimedAt: null, claimedBy: null },
    });
  }

  const readyBefore = new Date(now.getTime() - settleMs());
  const ready = await prisma.queuedSweep.findMany({
    where: { claimedAt: null, queuedAt: { lte: readyBefore } },
    orderBy: { queuedAt: "asc" },
    take: MAX_BATCH,
    select: { id: true },
  });

  if (!ready.length) {
    const stillWaiting = await prisma.queuedSweep.count({ where: { claimedAt: null } });
    return { status: stillWaiting ? "waiting" : "empty" };
  }

  // Claim, then re-read by claim id. Two replicas ticking together both see the
  // same rows here; the conditional update is what splits them, and the token is
  // how we learn which ones we actually got.
  const claimedBy = randomUUID();
  await prisma.queuedSweep.updateMany({
    where: { id: { in: ready.map((r) => r.id) }, claimedAt: null },
    data: { claimedAt: now, claimedBy },
  });
  const claimed = await prisma.queuedSweep.findMany({
    where: { claimedBy },
    include: { connection: { select: { id: true, name: true, enabled: true } } },
  });
  if (!claimed.length) return { status: "claimed_elsewhere" };

  // A connection disabled since the webhook arrived has nothing to sweep, and
  // leaving its titles queued would only have them reclaimed every tick.
  const dropped = claimed.filter((row) => !row.connection.enabled);
  if (dropped.length) {
    await prisma.queuedSweep.deleteMany({ where: { id: { in: dropped.map((r) => r.id) } } });
    log.info(
      `dropped ${dropped.length} queued title(s): their Sonarr/Radarr connection is disabled.`
    );
  }

  const live = claimed.filter((row) => row.connection.enabled);
  if (!live.length) return { status: "empty" };

  const targets: SweepTarget[] = live.map((row) => ({
    connectionId: row.connectionId,
    type: row.mediaType,
    arrId: row.arrId,
    title: row.title,
  }));

  try {
    const runId = await runTargetedSweep(targets, {
      trigger: "webhook",
      onFinished: ({ ok, error }) => settleClaim(claimedBy, ok, error),
    });
    return { status: "started", runId, targets: targets.length };
  } catch (e) {
    // The sweep never started, so nothing has been done for these titles: put
    // them back. A held run lock is not the queue's fault and is not counted
    // against the titles' attempts.
    const locked = e instanceof RunLockError;
    await release(claimedBy, { countAttempt: !locked });
    if (locked) return { status: "locked" };
    return { status: "error", error: (e as Error).message };
  }
}

/**
 * Close out a claim once its sweep has finished.
 *
 * A sweep that ran is the end of the road for those titles whether or not every
 * item in it succeeded — the run log records what happened, and re-running the
 * same titles would repeat the same failure. Only a sweep that could not run at
 * all is retried, and only until MAX_ATTEMPTS.
 */
async function settleClaim(claimedBy: string, ok: boolean, error?: Error): Promise<void> {
  if (ok) {
    await prisma.queuedSweep.deleteMany({ where: { claimedBy } });
    return;
  }
  // An admin stopping the sweep is the one failure that must not be retried:
  // the titles would go back on the queue and the next tick — seconds later —
  // would start the very sweep that was just stopped. Drop them; the next full
  // sweep covers them, which is the same fallback an exhausted title gets.
  if (error instanceof RunAbortedError) {
    const dropped = await prisma.queuedSweep.deleteMany({ where: { claimedBy } });
    if (dropped.count) {
      log.info(
        `targeted sweep was stopped by an administrator; dropped ${dropped.count} queued ` +
          `title(s) rather than re-queueing them. The next full sweep will cover them.`
      );
    }
    return;
  }
  log.warn(`targeted sweep failed: ${error?.message ?? "unknown error"}`);
  await release(claimedBy, { countAttempt: true });
}

/** Put claimed rows back on the queue, dropping any that have failed too often. */
async function release(claimedBy: string, opts: { countAttempt: boolean }): Promise<void> {
  if (opts.countAttempt) {
    await prisma.queuedSweep.updateMany({
      where: { claimedBy },
      data: { attempts: { increment: 1 } },
    });
    const exhausted = await prisma.queuedSweep.deleteMany({
      where: { claimedBy, attempts: { gte: MAX_ATTEMPTS } },
    });
    if (exhausted.count) {
      log.error(
        `gave up on ${exhausted.count} queued title(s) after ${MAX_ATTEMPTS} failed attempts; ` +
          `the next full sweep will cover them.`
      );
    }
  }
  await prisma.queuedSweep.updateMany({
    where: { claimedBy },
    data: { claimedAt: null, claimedBy: null },
  });
}

/**
 * Start the queue worker. Safe to call once per server process; returns a stop
 * function. Shares SWEEP_SCHEDULER with the sweep schedule: both are "this
 * replica may start sweeps on its own", and an instance opted out of one has no
 * business doing the other.
 */
export function startSweepQueueWorker(): () => void {
  if (schedulerDisabledByEnv()) {
    log.info("webhook sweep queue worker disabled by SWEEP_SCHEDULER env var.");
    return () => {};
  }

  const tick = async () => {
    try {
      const r = await drainSweepQueue();
      if (r.status === "started") {
        log.info(`started webhook sweep #${r.runId} covering ${r.targets} title(s).`);
      } else if (r.status === "error") {
        log.error(`webhook sweep failed to start: ${r.error}`);
      }
    } catch (e) {
      log.error(`sweep queue tick failed: ${(e as Error).message}`);
    }
  };

  // Give the database a moment to become reachable after boot.
  const first = setTimeout(tick, 20_000);
  const timer = setInterval(tick, QUEUE_TICK_MS);
  // Do not keep the event loop alive solely for these timers.
  if (typeof first.unref === "function") first.unref();
  if (typeof timer.unref === "function") timer.unref();

  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
