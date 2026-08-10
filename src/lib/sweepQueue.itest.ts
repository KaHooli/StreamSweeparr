import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

/**
 * The queue's interlock with the run lock, against a real database.
 *
 * `sweepQueue.test.ts` already pins the decision — it stubs `hasLiveRun` and
 * checks the drain defers to it. What it cannot check is the half that made the
 * original bug possible: whether "a run is alive" and "a run is reapable" are
 * actually complementary *as SQL*. Both sides are mocked there, so a threshold
 * changed on one side and not the other would leave that suite green.
 *
 * That gap is the whole failure mode. A sweep outliving its claim had the rows
 * reclaimed underneath it, re-claimed by the next tick, and swept a second time
 * — burning the Watchmode credits this app is otherwise careful with. So these
 * run the real queries against real rows, and assert the two agree at the
 * boundary rather than merely that each behaves in isolation.
 *
 * Only the sweep itself is stubbed: what a claim protects is orthogonal to what
 * it protects it *from*.
 */

const runTargetedSweep = vi.fn(async () => 1);
vi.mock("./sweep", () => ({
  runTargetedSweep: () => runTargetedSweep(),
}));

import { prisma } from "@/lib/db";
import { STALE_MS, hasLiveRun } from "@/lib/jobs";
import { drainSweepQueue, enqueueSweep } from "@/lib/sweepQueue";
import { resetDatabase, makeSettings, makeConnection } from "@/test/dbHelpers";

const NOW = new Date("2026-08-10T12:00:00.000Z");
const MINUTE = 60_000;
/** Comfortably past CLAIM_STALE_MS, so only `hasLiveRun` can save the claim. */
const OLD_CLAIM = new Date(NOW.getTime() - 30 * MINUTE);

let connectionId: number;

beforeEach(async () => {
  await resetDatabase();
  runTargetedSweep.mockClear();
  await makeSettings({ webhookEnabled: true, webhookToken: "itest-token" });
  const conn = await makeConnection({ type: "RADARR" });
  connectionId = conn.id;
});
afterAll(async () => {
  await prisma.$disconnect();
});

/** A RunLog row in the state a real run would be in. */
function makeRun(over: { status?: "RUNNING" | "SUCCESS"; heartbeatAgoMs?: number } = {}) {
  return prisma.runLog.create({
    data: {
      kind: "SWEEP",
      status: over.status ?? "RUNNING",
      dryRun: false,
      log: [],
      heartbeatAt: new Date(NOW.getTime() - (over.heartbeatAgoMs ?? 0)),
    },
  });
}

/** A queued title, already claimed long enough ago to look abandoned. */
async function claimedTitle(claimedBy = "the-slow-sweep") {
  await enqueueSweep({
    connectionId,
    mediaType: "MOVIE",
    arrId: 1,
    title: "Long Sweep",
    eventType: "MovieAdded",
  });
  await prisma.queuedSweep.updateMany({
    data: { claimedAt: OLD_CLAIM, claimedBy, queuedAt: new Date(NOW.getTime() - 60 * MINUTE) },
  });
}

describe("drainSweepQueue — the run-lock interlock", () => {
  it("leaves a claim alone while its sweep is genuinely still running", async () => {
    // The shape that used to double-sweep: a claim far past CLAIM_STALE_MS, but
    // the run holding it is alive and heartbeating.
    await makeRun({ heartbeatAgoMs: 10_000 });
    await claimedTitle();

    expect(await drainSweepQueue(NOW)).toEqual({ status: "empty" });

    const row = await prisma.queuedSweep.findFirstOrThrow();
    expect(row.claimedBy).toBe("the-slow-sweep");
    expect(row.claimedAt).toEqual(OLD_CLAIM);
    expect(runTargetedSweep).not.toHaveBeenCalled();
  });

  it("reclaims once the run holding it has stopped heartbeating", async () => {
    // Same row, but the claiming process died: its run has gone quiet, which is
    // exactly when startRun would reap it too.
    await makeRun({ heartbeatAgoMs: STALE_MS + MINUTE });
    await claimedTitle();

    expect(await drainSweepQueue(NOW)).toMatchObject({ status: "started", targets: 1 });
    expect(runTargetedSweep).toHaveBeenCalledTimes(1);
  });

  it("reclaims when the run that held it has finished", async () => {
    await makeRun({ status: "SUCCESS", heartbeatAgoMs: 10_000 });
    await claimedTitle();

    expect(await drainSweepQueue(NOW)).toMatchObject({ status: "started", targets: 1 });
  });

  it("does not defer to a run that was never there", async () => {
    await claimedTitle();
    expect(await drainSweepQueue(NOW)).toMatchObject({ status: "started", targets: 1 });
  });
});

describe("hasLiveRun and the run reaper agree", () => {
  /**
   * The invariant the fix rests on: every RUNNING row is either live — so the
   * queue waits and `startRun` leaves it holding the lock — or reapable, so the
   * queue reclaims and `startRun` clears it. Never both, never neither.
   *
   * Neither state is safe to be in twice over. "Live and reapable" means the
   * lock is released while the queue still defers; "neither" means the queue
   * reclaims rows from a run that still holds the lock — which is the original
   * double-sweep, arrived at from the other direction.
   */
  const reapable = (heartbeatAgoMs: number) =>
    prisma.runLog.count({
      where: {
        status: "RUNNING",
        heartbeatAt: { lt: new Date(NOW.getTime() - STALE_MS) },
      },
    });

  for (const heartbeatAgoMs of [0, MINUTE, STALE_MS - 1000, STALE_MS + 1000, 30 * MINUTE]) {
    it(`is exactly one of live/reapable with a ${heartbeatAgoMs}ms-old heartbeat`, async () => {
      await makeRun({ heartbeatAgoMs });

      const live = await hasLiveRun(NOW);
      const canReap = (await reapable(heartbeatAgoMs)) > 0;

      expect(live).toBe(!canReap);
    });
  }

  it("treats a run whose heartbeat is exactly at the threshold as live", async () => {
    // The two queries split on `lt` versus `gte`, so the boundary instant
    // belongs to exactly one of them. Pinning which one stops a later `lte`/`gt`
    // slip from opening a window where a run is neither.
    await makeRun({ heartbeatAgoMs: STALE_MS });
    expect(await hasLiveRun(NOW)).toBe(true);
    expect(await reapable(STALE_MS)).toBe(0);
  });
});

describe("a claim's lifecycle survives the database", () => {
  it("hands the same rows back under one token, and clears them on success", async () => {
    await enqueueSweep({
      connectionId,
      mediaType: "MOVIE",
      arrId: 7,
      title: "Settled",
      eventType: "MovieAdded",
    });
    await prisma.queuedSweep.updateMany({
      data: { queuedAt: new Date(NOW.getTime() - 10 * MINUTE) },
    });

    expect(await drainSweepQueue(NOW)).toMatchObject({ status: "started", targets: 1 });

    // The drain claims before handing off, so the row is spoken for while the
    // (stubbed) sweep runs — this is what a second replica would see.
    const claimed = await prisma.queuedSweep.findFirstOrThrow();
    expect(claimed.claimedBy).toBeTruthy();
    expect(claimed.claimedAt).not.toBeNull();

    // A second drain must not hand the same title to a second sweep.
    await makeRun({ heartbeatAgoMs: 0 });
    expect(await drainSweepQueue(NOW)).toEqual({ status: "empty" });
    expect(runTargetedSweep).toHaveBeenCalledTimes(1);
  });
});
