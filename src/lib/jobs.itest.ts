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

/** Statements currently parked waiting for a lock on the RunLog table. */
async function blockedRunLogWrites(): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND state = 'active'
      AND wait_event_type = 'Lock'
      AND query ILIKE '%RunLog%'
  `;
  return Number(rows[0].n);
}

/** Connections sitting inside an open transaction — how we know a lock is held. */
async function idleInTransaction(): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n
    FROM pg_stat_activity
    WHERE datname = current_database() AND state = 'idle in transaction'
  `;
  return Number(rows[0].n);
}

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

  it("does not issue the final write while a progress write is still in flight", async () => {
    // The bug this guards against: `push` fires a flush without awaiting it,
    // capturing the counts while they are still zero. When the terminal write
    // was issued independently rather than queued behind that flush, the two
    // raced on separate pooled connections — and a flush landing second reset
    // the counts without touching `status`, leaving a run marked SUCCESS that
    // reported having done nothing. It failed the sweep suite about one run in
    // twenty, most often the first test against a cold connection pool.
    //
    // Asserting on the resulting row cannot catch this: whether the race is
    // lost depends on connection timing, so a passing run proves nothing. What
    // *is* deterministic is the invariant underneath — the terminal write must
    // never be in flight at the same time as a progress write. So hold a lock
    // on the row, park both writes against it, and count them.
    const run = await prisma.runLog.create({
      data: { kind: "SWEEP", status: "RUNNING", dryRun: false, log: [] },
    });
    const ctx = new RunContext(run.id);

    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));

    // A second connection holds the row, so any UPDATE to it blocks where
    // pg_stat_activity can see it.
    const locker = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT 1 FROM "RunLog" WHERE id = ${run.id} FOR UPDATE`;
        await held;
      },
      { timeout: 20_000 }
    );
    await waitFor(async () => (await idleInTransaction()) > 0);

    ctx.push("info", "progress"); // the first push always flushes
    ctx.counts.unmonitoredMovies = 2;
    const finishing = ctx.finish({ status: "SUCCESS" });

    await waitFor(async () => (await blockedRunLogWrites()) >= 1);
    // A second statement, had one been issued, would have arrived long ago.
    await new Promise((r) => setTimeout(r, 500));
    expect(await blockedRunLogWrites()).toBe(1);

    release();
    await locker;
    await finishing;

    const stored = await prisma.runLog.findUniqueOrThrow({ where: { id: run.id } });
    expect(stored.status).toBe("SUCCESS");
    expect(stored.unmonitoredMovies).toBe(2);
    expect(stored.finishedAt).not.toBeNull();
  });

  it("ignores progress writes scheduled after the run has finished", async () => {
    const run = await prisma.runLog.create({
      data: { kind: "SWEEP", status: "RUNNING", dryRun: false, log: [] },
    });
    const ctx = new RunContext(run.id);
    ctx.counts.unmonitoredMovies = 2;
    await ctx.finish({ status: "SUCCESS" });

    // A late heartbeat or a straggling `push` must not reopen the row.
    ctx.counts.unmonitoredMovies = 99;
    ctx.push("info", "too late");
    await ctx.flush();

    const stored = await prisma.runLog.findUniqueOrThrow({ where: { id: run.id } });
    expect(stored.status).toBe("SUCCESS");
    expect(stored.unmonitoredMovies).toBe(2);
  });

  it("records a failure with the counts accumulated before it", async () => {
    const run = await prisma.runLog.create({
      data: { kind: "SWEEP", status: "RUNNING", dryRun: false, log: [] },
    });
    const ctx = new RunContext(run.id);
    ctx.push("info", "starting");
    ctx.counts.deletedFiles = 5;
    await ctx.finish({ status: "FAILED", error: "radarr went away" });

    const stored = await prisma.runLog.findUniqueOrThrow({ where: { id: run.id } });
    expect(stored.status).toBe("FAILED");
    expect(stored.error).toBe("radarr went away");
    expect(stored.deletedFiles).toBe(5);
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
