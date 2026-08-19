import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The queue's job is deciding *when* a webhook turns into a sweep, so the
 * database and the sweep itself are stubbed and the assertions are about the
 * decision: has the title settled, was the claim ours, and what happens to a
 * claim once its sweep is over.
 */

interface Row {
  id: number;
  connectionId: number;
  mediaType: "TV" | "MOVIE";
  arrId: number;
  title: string;
  queuedAt: Date;
  claimedAt: Date | null;
  claimedBy: string | null;
  attempts: number;
  connection: { id: number; name: string; enabled: boolean };
}

interface Args {
  where?: Record<string, unknown>;
  data?: Record<string, unknown>;
  take?: number;
}

let rows: Row[] = [];
const settingsRow = { webhookEnabled: true };
// Whether a run is currently alive. The drain only reclaims stale claims when
// nothing is running, so this gates that half of the behaviour.
let liveRun: { id: number } | null = null;

/** The subset of Prisma filtering the drain actually relies on. */
function matches(row: Row, where: Record<string, unknown> = {}): boolean {
  for (const [field, condition] of Object.entries(where)) {
    const value = (row as unknown as Record<string, unknown>)[field];
    if (condition !== null && typeof condition === "object") {
      const c = condition as Record<string, unknown>;
      if ("in" in c && !(c.in as unknown[]).includes(value)) return false;
      if ("lt" in c && !(value !== null && (value as Date) < (c.lt as Date))) return false;
      if ("lte" in c && !(value !== null && (value as Date) <= (c.lte as Date))) return false;
      if ("gte" in c && !((value as number) >= (c.gte as number))) return false;
    } else if (value !== condition) {
      return false;
    }
  }
  return true;
}

function applyData(row: Row, data: Record<string, unknown>) {
  for (const [field, value] of Object.entries(data)) {
    if (value !== null && typeof value === "object" && "increment" in (value as object)) {
      const current = (row as unknown as Record<string, number>)[field];
      (row as unknown as Record<string, number>)[field] =
        current + (value as { increment: number }).increment;
    } else {
      (row as unknown as Record<string, unknown>)[field] = value;
    }
  }
}

const queuedSweep = {
  findMany: vi.fn(async (args: Args = {}) => {
    const found = rows.filter((r) => matches(r, args.where));
    return args.take ? found.slice(0, args.take) : found;
  }),
  count: vi.fn(async (args: Args = {}) => rows.filter((r) => matches(r, args.where)).length),
  updateMany: vi.fn(async (args: Args) => {
    const hit = rows.filter((r) => matches(r, args.where));
    for (const r of hit) applyData(r, args.data ?? {});
    return { count: hit.length };
  }),
  deleteMany: vi.fn(async (args: Args) => {
    const hit = rows.filter((r) => matches(r, args.where));
    rows = rows.filter((r) => !hit.includes(r));
    return { count: hit.length };
  }),
  upsert: vi.fn(async () => ({})),
};

// The factory is hoisted above the declarations above, so every method is
// wrapped in an arrow that resolves `queuedSweep` at call time rather than now.
vi.mock("./db", () => ({
  prisma: {
    queuedSweep: {
      findMany: (a: Args) => queuedSweep.findMany(a),
      count: (a: Args) => queuedSweep.count(a),
      updateMany: (a: Args) => queuedSweep.updateMany(a),
      deleteMany: (a: Args) => queuedSweep.deleteMany(a),
      upsert: () => queuedSweep.upsert(),
    },
    // `hasLiveRun` reads this; the drain asks it before reclaiming anything.
    runLog: { findFirst: async () => liveRun },
  },
  getSettings: async () => settingsRow,
}));

const runTargetedSweep = vi.fn(
  async (
    _targets: unknown[],
    _opts: { onFinished?: (o: { ok: boolean; error?: Error }) => Promise<void> } = {}
  ) => 99
);
vi.mock("./sweep", () => ({
  runTargetedSweep: (t: unknown[], o?: Record<string, unknown>) => runTargetedSweep(t, o),
}));

import { drainSweepQueue, settleMs, DEFAULT_SETTLE_MS } from "./sweepQueue";
import { RunAbortedError, RunLockError } from "./jobs";

const now = new Date("2026-08-10T12:00:00.000Z");
const MINUTE = 60_000;

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: 1,
    connectionId: 10,
    mediaType: "TV",
    arrId: 500,
    title: "Severance",
    // Comfortably past the settle window unless a test says otherwise.
    queuedAt: new Date(now.getTime() - 10 * MINUTE),
    claimedAt: null,
    claimedBy: null,
    attempts: 0,
    connection: { id: 10, name: "Sonarr", enabled: true },
    ...overrides,
  };
}

beforeEach(() => {
  rows = [];
  settingsRow.webhookEnabled = true;
  liveRun = null;
  runTargetedSweep.mockClear();
  runTargetedSweep.mockResolvedValue(99);
  delete process.env.WEBHOOK_SWEEP_DELAY_SECONDS;
});

describe("settleMs", () => {
  it("defaults to a minute", () => {
    expect(settleMs({})).toBe(DEFAULT_SETTLE_MS);
  });

  it("honours WEBHOOK_SWEEP_DELAY_SECONDS", () => {
    expect(settleMs({ WEBHOOK_SWEEP_DELAY_SECONDS: "120" })).toBe(120_000);
    expect(settleMs({ WEBHOOK_SWEEP_DELAY_SECONDS: "0" })).toBe(0);
  });

  it("ignores nonsense and caps the wait at an hour", () => {
    expect(settleMs({ WEBHOOK_SWEEP_DELAY_SECONDS: "soon" })).toBe(DEFAULT_SETTLE_MS);
    expect(settleMs({ WEBHOOK_SWEEP_DELAY_SECONDS: "-5" })).toBe(DEFAULT_SETTLE_MS);
    expect(settleMs({ WEBHOOK_SWEEP_DELAY_SECONDS: "99999" })).toBe(3_600_000);
  });
});

describe("drainSweepQueue", () => {
  it("does nothing while webhook sweeps are switched off", async () => {
    settingsRow.webhookEnabled = false;
    rows = [row()];
    expect(await drainSweepQueue(now)).toEqual({ status: "disabled" });
    expect(runTargetedSweep).not.toHaveBeenCalled();
  });

  it("reports an empty queue", async () => {
    expect(await drainSweepQueue(now)).toEqual({ status: "empty" });
  });

  it("leaves a title that has not settled yet", async () => {
    rows = [row({ queuedAt: new Date(now.getTime() - 5_000) })];
    expect(await drainSweepQueue(now)).toEqual({ status: "waiting" });
    expect(runTargetedSweep).not.toHaveBeenCalled();
  });

  it("sweeps everything that has settled, in one run", async () => {
    rows = [
      row({ id: 1, arrId: 500, title: "Severance" }),
      row({ id: 2, arrId: 501, title: "Andor" }),
    ];
    const result = await drainSweepQueue(now);
    expect(result).toMatchObject({ status: "started", runId: 99, targets: 2 });
    expect(runTargetedSweep).toHaveBeenCalledTimes(1);
    expect(runTargetedSweep.mock.calls[0][0]).toEqual([
      { connectionId: 10, type: "TV", arrId: 500, title: "Severance" },
      { connectionId: 10, type: "TV", arrId: 501, title: "Andor" },
    ]);
  });

  it("drops the claimed titles once their sweep succeeds", async () => {
    rows = [row()];
    await drainSweepQueue(now);
    const onFinished = runTargetedSweep.mock.calls[0][1]?.onFinished;
    await onFinished!({ ok: true });
    expect(rows).toHaveLength(0);
  });

  it("re-queues the titles when their sweep fails, counting the attempt", async () => {
    rows = [row()];
    await drainSweepQueue(now);
    const onFinished = runTargetedSweep.mock.calls[0][1]?.onFinished;
    await onFinished!({ ok: false, error: new Error("Radarr unreachable") });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ claimedAt: null, claimedBy: null, attempts: 1 });
  });

  it("drops the titles when an admin stops their sweep, rather than retrying it", async () => {
    rows = [row()];
    await drainSweepQueue(now);
    const onFinished = runTargetedSweep.mock.calls[0][1]?.onFinished;
    await onFinished!({ ok: false, error: new RunAbortedError() });
    // Re-queued, the next tick — seconds away — would start the very sweep that
    // was just stopped. The next full sweep covers these titles instead.
    expect(rows).toHaveLength(0);
  });

  it("gives up on a title that keeps failing", async () => {
    rows = [row({ attempts: 4 })];
    await drainSweepQueue(now);
    const onFinished = runTargetedSweep.mock.calls[0][1]?.onFinished;
    await onFinished!({ ok: false, error: new Error("still broken") });
    expect(rows).toHaveLength(0);
  });

  it("puts the titles back untouched when a run already holds the lock", async () => {
    rows = [row()];
    runTargetedSweep.mockRejectedValueOnce(new RunLockError(7));
    expect(await drainSweepQueue(now)).toEqual({ status: "locked" });
    // A held lock is not the title's fault, so it must not burn an attempt.
    expect(rows[0]).toMatchObject({ claimedAt: null, claimedBy: null, attempts: 0 });
  });

  it("re-queues and counts an attempt when the sweep could not start at all", async () => {
    rows = [row()];
    runTargetedSweep.mockRejectedValueOnce(new Error("database is down"));
    expect(await drainSweepQueue(now)).toMatchObject({ status: "error" });
    expect(rows[0]).toMatchObject({ claimedAt: null, attempts: 1 });
  });

  it("reclaims a title whose claimer died", async () => {
    rows = [row({ claimedAt: new Date(now.getTime() - 30 * MINUTE), claimedBy: "gone" })];
    expect(await drainSweepQueue(now)).toMatchObject({ status: "started", targets: 1 });
  });

  // A sweep has no maximum duration, so an old claim is not evidence its sweep
  // is gone. Reclaiming one out from under a running sweep is what used to make
  // the same titles sweep twice.
  it("does not reclaim an old claim while a run is still alive", async () => {
    liveRun = { id: 42 };
    rows = [row({ claimedAt: new Date(now.getTime() - 30 * MINUTE), claimedBy: "slow-sweep" })];
    expect(await drainSweepQueue(now)).toEqual({ status: "empty" });
    expect(rows[0]).toMatchObject({ claimedBy: "slow-sweep" });
    expect(runTargetedSweep).not.toHaveBeenCalled();
  });

  it("reclaims once the run that held the claim has gone quiet", async () => {
    liveRun = null;
    rows = [row({ claimedAt: new Date(now.getTime() - 30 * MINUTE), claimedBy: "slow-sweep" })];
    expect(await drainSweepQueue(now)).toMatchObject({ status: "started", targets: 1 });
  });

  it("leaves a title claimed by a live drain alone", async () => {
    rows = [row({ claimedAt: new Date(now.getTime() - MINUTE), claimedBy: "busy" })];
    expect(await drainSweepQueue(now)).toEqual({ status: "empty" });
    expect(runTargetedSweep).not.toHaveBeenCalled();
  });

  it("drops titles whose connection has since been disabled", async () => {
    rows = [row({ connection: { id: 10, name: "Sonarr", enabled: false } })];
    expect(await drainSweepQueue(now)).toEqual({ status: "empty" });
    expect(rows).toHaveLength(0);
    expect(runTargetedSweep).not.toHaveBeenCalled();
  });
});
