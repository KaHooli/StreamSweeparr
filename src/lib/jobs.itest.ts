import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { startRun, RunLockError, RunContext, MAX_LOG_LINES } from "@/lib/jobs";
import { resetDatabase, waitFor } from "@/test/dbHelpers";

/**
 * The run lock is the one piece of concurrency control in the app: it is what
 * stops two sweeps from mutating Sonarr/Radarr at the same time. It can only be
 * tested against a real database, because its correctness lives entirely in a
 * Postgres advisory lock and a conditional read.
 */

beforeEach(resetDatabase);

/**
 * Drain any run still executing before the next test truncates the tables.
 *
 * `startRun` runs its body detached by design, so a test can finish while its
 * run is still writing. The next test's TRUNCATE then lands mid-write, which at
 * best logs a swallowed "record to update not found" and at worst leaves a row
 * behind for a later assertion to trip over. Waiting for the lock to clear
 * keeps each test's writes inside its own test.
 */
afterEach(async () => {
  await waitFor(
    async () => (await prisma.runLog.count({ where: { status: "RUNNING" } })) === 0,
    5_000
  ).catch(() => {
    // A test that deliberately leaves a run RUNNING (the stale-heartbeat and
    // lock-held cases) is fine; beforeEach clears it.
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** A run body that blocks until we let it finish. */
function heldRun() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  return { gate, release };
}

describe("startRun — mutual exclusion", () => {
  it("lets exactly one of many simultaneous callers acquire the lock", async () => {
    const { gate, release } = heldRun();

    // Fire ten at once. Before the advisory lock, several would read "no active
    // run" in the same instant and each create their own RUNNING row.
    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, () => startRun("SWEEP", true, () => gate))
    );

    const started = attempts.filter((a) => a.status === "fulfilled");
    const rejected = attempts.filter((a) => a.status === "rejected");
    expect(started).toHaveLength(1);
    expect(rejected).toHaveLength(9);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(RunLockError);
    }

    expect(await prisma.runLog.count()).toBe(1);
    expect(await prisma.runLog.count({ where: { status: "RUNNING" } })).toBe(1);

    release();
    await waitFor(async () => (await prisma.runLog.count({ where: { status: "SUCCESS" } })) === 1);
  });

  it("reports the id of the run already holding the lock", async () => {
    const { gate, release } = heldRun();
    const firstId = await startRun("SYNC", true, () => gate);

    const err = await startRun("SWEEP", false, async () => {}).catch((e) => e as RunLockError);
    expect(err).toBeInstanceOf(RunLockError);
    expect((err as RunLockError).runningId).toBe(firstId);

    release();
    await waitFor(async () => (await prisma.runLog.count({ where: { status: "SUCCESS" } })) === 1);
  });

  it("reclaims the lock from a run whose heartbeat went stale", async () => {
    const dead = await prisma.runLog.create({
      data: {
        kind: "SWEEP",
        status: "RUNNING",
        dryRun: true,
        heartbeatAt: new Date(Date.now() - 10 * 60 * 1000),
        log: [],
      },
    });

    const newId = await startRun("SWEEP", true, async () => {});
    expect(newId).not.toBe(dead.id);

    await waitFor(async () => (await prisma.runLog.count({ where: { status: "SUCCESS" } })) === 1);
    const reaped = await prisma.runLog.findUniqueOrThrow({ where: { id: dead.id } });
    expect(reaped.status).toBe("FAILED");
    expect(reaped.error).toMatch(/timed out/i);
    expect(reaped.finishedAt).not.toBeNull();
  });

  it("does not reclaim a run that is still heartbeating", async () => {
    await prisma.runLog.create({
      data: { kind: "SWEEP", status: "RUNNING", dryRun: true, heartbeatAt: new Date(), log: [] },
    });
    await expect(startRun("SWEEP", true, async () => {})).rejects.toBeInstanceOf(RunLockError);
  });

  it("releases the lock when the body throws, and records the failure", async () => {
    const id = await startRun("SWEEP", false, async () => {
      throw new Error("radarr unreachable");
    });
    await waitFor(async () => {
      const r = await prisma.runLog.findUnique({ where: { id } });
      return r?.status === "FAILED";
    });
    const run = await prisma.runLog.findUniqueOrThrow({ where: { id } });
    expect(run.error).toBe("radarr unreachable");
    expect(run.finishedAt).not.toBeNull();

    // The lock is free again.
    await expect(startRun("SYNC", true, async () => {})).resolves.toBeTypeOf("number");
  });

  it("persists counts accumulated before a failure", async () => {
    const id = await startRun("SWEEP", false, async (ctx) => {
      ctx.counts.deletedFiles = 7;
      ctx.counts.unmonitoredMovies = 3;
      throw new Error("stopped halfway");
    });
    await waitFor(async () => {
      const r = await prisma.runLog.findUnique({ where: { id } });
      return r?.status === "FAILED";
    });
    const run = await prisma.runLog.findUniqueOrThrow({ where: { id } });
    expect(run.deletedFiles).toBe(7);
    expect(run.unmonitoredMovies).toBe(3);
  });
});

describe("RunContext logging", () => {
  it("writes log lines and counts to the row", async () => {
    const run = await prisma.runLog.create({
      data: { kind: "SYNC", status: "RUNNING", dryRun: true, log: [] },
    });
    const ctx = new RunContext(run.id);
    ctx.push("info", "starting");
    ctx.push("action", "unmonitored something");
    ctx.counts.unmonitoredMovies = 1;
    await ctx.flush();

    const stored = await prisma.runLog.findUniqueOrThrow({ where: { id: run.id } });
    const lines = stored.log as { level: string; msg: string }[];
    expect(lines.map((l) => l.msg)).toEqual(["starting", "unmonitored something"]);
    expect(stored.unmonitoredMovies).toBe(1);
  });

  it("caps a runaway log instead of rewriting an ever-growing blob", async () => {
    const run = await prisma.runLog.create({
      data: { kind: "SWEEP", status: "RUNNING", dryRun: true, log: [] },
    });
    const ctx = new RunContext(run.id);
    const total = MAX_LOG_LINES + 500;
    for (let i = 0; i < total; i++) ctx.push("action", `line ${i}`);
    await ctx.flush();

    const stored = await prisma.runLog.findUniqueOrThrow({ where: { id: run.id } });
    const lines = stored.log as { level: string; msg: string }[];
    // Capped, and the elision is visible rather than silent.
    expect(lines.length).toBeLessThanOrEqual(MAX_LOG_LINES + 1);
    expect(lines[0].msg).toBe("line 0"); // the opening steps survive
    expect(lines[lines.length - 1].msg).toBe(`line ${total - 1}`); // so does the tail
    expect(lines.some((l) => l.msg.includes("omitted"))).toBe(true);
  });

  it("collapses overlapping flushes rather than interleaving them", async () => {
    const run = await prisma.runLog.create({
      data: { kind: "SYNC", status: "RUNNING", dryRun: true, log: [] },
    });
    const ctx = new RunContext(run.id);
    ctx.push("info", "one");
    // Several flushes racing: the last state written must be the newest one.
    const flushes = [ctx.flush(), ctx.flush(), ctx.flush()];
    ctx.push("info", "two");
    await Promise.all([...flushes, ctx.flush()]);

    const stored = await prisma.runLog.findUniqueOrThrow({ where: { id: run.id } });
    const lines = stored.log as { msg: string }[];
    expect(lines.map((l) => l.msg)).toEqual(["one", "two"]);
  });
});
