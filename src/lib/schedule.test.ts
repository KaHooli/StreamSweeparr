import { describe, it, expect } from "vitest";
import {
  isValidSweepInterval,
  clampSweepInterval,
  addInterval,
  nextRunAfterChange,
  isSweepDue,
  nextRunAfterFiring,
  describeInterval,
  describeSchedule,
  schedulerDisabledByEnv,
  SWEEP_INTERVAL_CHOICES,
  MAX_SWEEP_INTERVAL_HOURS,
} from "./schedule";

const now = new Date("2026-08-05T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

const off = {
  sweepScheduleEnabled: false,
  sweepIntervalHours: 12,
  sweepNextRunAt: null,
  sweepLastRunAt: null,
};

describe("isValidSweepInterval", () => {
  it("accepts whole hours from 1 to 168", () => {
    expect(isValidSweepInterval(1)).toBe(true);
    expect(isValidSweepInterval(12)).toBe(true);
    expect(isValidSweepInterval(168)).toBe(true);
    expect(isValidSweepInterval(0)).toBe(false);
    expect(isValidSweepInterval(169)).toBe(false);
    expect(isValidSweepInterval(1.5)).toBe(false);
    expect(isValidSweepInterval(NaN)).toBe(false);
  });

  it("accepts every choice offered in the UI", () => {
    for (const h of SWEEP_INTERVAL_CHOICES) expect(isValidSweepInterval(h)).toBe(true);
  });
});

describe("clampSweepInterval", () => {
  it("clamps out-of-range values and rounds fractions", () => {
    expect(clampSweepInterval(0)).toBe(1);
    expect(clampSweepInterval(-5)).toBe(1);
    expect(clampSweepInterval(1000)).toBe(MAX_SWEEP_INTERVAL_HOURS);
    expect(clampSweepInterval(11.6)).toBe(12);
    expect(clampSweepInterval(Number.NaN)).toBe(12);
  });
});

describe("nextRunAfterChange", () => {
  it("clears the slot when the schedule is turned off", () => {
    const prev = { ...off, sweepScheduleEnabled: true, sweepNextRunAt: new Date(now.getTime() + HOUR) };
    expect(
      nextRunAfterChange(prev, { sweepScheduleEnabled: false, sweepIntervalHours: 12 }, now)
    ).toBeNull();
  });

  it("schedules one full interval out when first enabled", () => {
    const next = nextRunAfterChange(
      off,
      { sweepScheduleEnabled: true, sweepIntervalHours: 12 },
      now
    );
    expect(next).toEqual(new Date(now.getTime() + 12 * HOUR));
  });

  it("fills in a missing slot for an already-enabled schedule", () => {
    const prev = { ...off, sweepScheduleEnabled: true, sweepNextRunAt: null };
    expect(
      nextRunAfterChange(prev, { sweepScheduleEnabled: true, sweepIntervalHours: 6 }, now)
    ).toEqual(new Date(now.getTime() + 6 * HOUR));
  });

  it("keeps the pending slot when the schedule is unchanged", () => {
    const pending = new Date(now.getTime() + 3 * HOUR);
    const prev = { ...off, sweepScheduleEnabled: true, sweepNextRunAt: pending };
    expect(
      nextRunAfterChange(prev, { sweepScheduleEnabled: true, sweepIntervalHours: 12 }, now)
    ).toEqual(pending);
  });

  it("re-anchors on the last run when the interval changes", () => {
    const lastRun = new Date(now.getTime() - 2 * HOUR);
    const prev = {
      sweepScheduleEnabled: true,
      sweepIntervalHours: 12,
      sweepNextRunAt: new Date(now.getTime() + 10 * HOUR),
      sweepLastRunAt: lastRun,
    };
    // 6h after the last run, i.e. 4h from now.
    expect(
      nextRunAfterChange(prev, { sweepScheduleEnabled: true, sweepIntervalHours: 6 }, now)
    ).toEqual(new Date(lastRun.getTime() + 6 * HOUR));
  });

  it("never re-anchors into the past", () => {
    const lastRun = new Date(now.getTime() - 20 * HOUR);
    const prev = {
      sweepScheduleEnabled: true,
      sweepIntervalHours: 48,
      sweepNextRunAt: new Date(now.getTime() + 28 * HOUR),
      sweepLastRunAt: lastRun,
    };
    // lastRun + 1h is long past, so it becomes due now rather than overdue.
    expect(
      nextRunAfterChange(prev, { sweepScheduleEnabled: true, sweepIntervalHours: 1 }, now)
    ).toEqual(now);
  });
});

describe("isSweepDue", () => {
  it("is false when disabled or unscheduled", () => {
    expect(isSweepDue({ ...off, sweepNextRunAt: new Date(now.getTime() - HOUR) }, now)).toBe(false);
    expect(isSweepDue({ ...off, sweepScheduleEnabled: true }, now)).toBe(false);
  });

  it("is true only once the slot has arrived", () => {
    const s = (offsetMs: number) => ({
      sweepScheduleEnabled: true,
      sweepIntervalHours: 12,
      sweepNextRunAt: new Date(now.getTime() + offsetMs),
    });
    expect(isSweepDue(s(60_000), now)).toBe(false);
    expect(isSweepDue(s(0), now)).toBe(true);
    expect(isSweepDue(s(-60_000), now)).toBe(true);
  });
});

describe("nextRunAfterFiring", () => {
  it("always lands a full interval in the future, skipping missed slots", () => {
    expect(nextRunAfterFiring(12, now)).toEqual(new Date(now.getTime() + 12 * HOUR));
    // Even after a long outage the next slot is one interval from now, not a
    // backlog of catch-up runs.
    expect(addInterval(now, 12)).toEqual(nextRunAfterFiring(12, now));
  });
});

describe("describeInterval", () => {
  it("reads naturally in hours and days", () => {
    expect(describeInterval(1)).toBe("1 hour");
    expect(describeInterval(12)).toBe("12 hours");
    expect(describeInterval(24)).toBe("1 day");
    expect(describeInterval(72)).toBe("3 days");
    expect(describeSchedule(12)).toBe("every 12 hours");
  });
});

describe("schedulerDisabledByEnv", () => {
  it("honours off/false/0 and ignores anything else", () => {
    expect(schedulerDisabledByEnv({})).toBe(false);
    expect(schedulerDisabledByEnv({ SWEEP_SCHEDULER: "off" })).toBe(true);
    expect(schedulerDisabledByEnv({ SWEEP_SCHEDULER: " OFF " })).toBe(true);
    expect(schedulerDisabledByEnv({ SWEEP_SCHEDULER: "false" })).toBe(true);
    expect(schedulerDisabledByEnv({ SWEEP_SCHEDULER: "on" })).toBe(false);
  });
});
