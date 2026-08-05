import { describe, it, expect, vi, beforeEach } from "vitest";

// The scheduler is all about the database claim, so stub the DB and the sweep
// itself and assert on what it would do.
const settingsRow = {
  sweepScheduleEnabled: true,
  sweepIntervalHours: 12,
  sweepNextRunAt: null as Date | null,
  sweepLastRunAt: null as Date | null,
};

interface PrismaArgs {
  where?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

const update = vi.fn(async (_args: PrismaArgs) => settingsRow);
const updateMany = vi.fn(async (_args: PrismaArgs) => ({ count: 1 }));
const getSettings = vi.fn(async () => settingsRow);
const runSweep = vi.fn(async (_trigger?: string) => 42);

vi.mock("./db", () => ({
  prisma: {
    settings: {
      update: (args: PrismaArgs) => update(args),
      updateMany: (args: PrismaArgs) => updateMany(args),
    },
  },
  getSettings: () => getSettings(),
}));
vi.mock("./sweep", () => ({ runSweep: (trigger?: string) => runSweep(trigger) }));

import { tickScheduler } from "./scheduler";
import { RunLockError } from "./jobs";

const now = new Date("2026-08-05T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

beforeEach(() => {
  update.mockClear();
  updateMany.mockClear();
  runSweep.mockClear();
  updateMany.mockResolvedValue({ count: 1 });
  runSweep.mockResolvedValue(42);
  Object.assign(settingsRow, {
    sweepScheduleEnabled: true,
    sweepIntervalHours: 12,
    sweepNextRunAt: null,
    sweepLastRunAt: null,
  });
});

describe("tickScheduler", () => {
  it("does nothing while the schedule is off", async () => {
    settingsRow.sweepScheduleEnabled = false;
    expect(await tickScheduler(now)).toEqual({ status: "disabled" });
    expect(update).not.toHaveBeenCalled();
    expect(runSweep).not.toHaveBeenCalled();
  });

  it("records a first slot when the schedule has none", async () => {
    const r = await tickScheduler(now);
    expect(r.status).toBe("scheduled");
    expect(r.nextRunAt).toEqual(new Date(now.getTime() + 12 * HOUR));
    expect(update).toHaveBeenCalledOnce();
    expect(runSweep).not.toHaveBeenCalled();
  });

  it("waits until the slot is due", async () => {
    settingsRow.sweepNextRunAt = new Date(now.getTime() + 60_000);
    expect((await tickScheduler(now)).status).toBe("idle");
    expect(runSweep).not.toHaveBeenCalled();
  });

  it("claims the slot then starts a sweep when due", async () => {
    const due = new Date(now.getTime() - 1000);
    settingsRow.sweepNextRunAt = due;

    const r = await tickScheduler(now);

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 1, sweepNextRunAt: due },
      data: { sweepNextRunAt: new Date(now.getTime() + 12 * HOUR), sweepLastRunAt: now },
    });
    expect(runSweep).toHaveBeenCalledWith("schedule");
    expect(r).toMatchObject({ status: "started", runId: 42 });
  });

  it("skips the missed slots after an outage instead of catching up", async () => {
    settingsRow.sweepNextRunAt = new Date(now.getTime() - 5 * 12 * HOUR);
    await tickScheduler(now);
    expect(updateMany.mock.calls[0][0]).toMatchObject({
      data: { sweepNextRunAt: new Date(now.getTime() + 12 * HOUR) },
    });
    expect(runSweep).toHaveBeenCalledOnce();
  });

  it("does not run when another replica claimed the same slot", async () => {
    settingsRow.sweepNextRunAt = new Date(now.getTime() - 1000);
    updateMany.mockResolvedValue({ count: 0 });

    expect((await tickScheduler(now)).status).toBe("claimed_elsewhere");
    expect(runSweep).not.toHaveBeenCalled();
  });

  it("skips (does not queue) when a run is already in progress", async () => {
    settingsRow.sweepNextRunAt = new Date(now.getTime() - 1000);
    runSweep.mockRejectedValue(new RunLockError(7) as never);

    const r = await tickScheduler(now);
    // The slot stays claimed, so the next attempt is a full interval away.
    expect(r).toMatchObject({ status: "locked", nextRunAt: new Date(now.getTime() + 12 * HOUR) });
  });

  it("reports a failure to start without throwing", async () => {
    settingsRow.sweepNextRunAt = new Date(now.getTime() - 1000);
    runSweep.mockRejectedValue(new Error("database is on fire") as never);

    const r = await tickScheduler(now);
    expect(r).toMatchObject({ status: "error", error: "database is on fire" });
  });
});
