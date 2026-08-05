/**
 * Background scheduler for recurring sweeps.
 *
 * A timer ticks once a minute and asks the database whether a sweep is due.
 * Nothing is kept in process memory: the due time lives on the Settings row, so
 * restarts resume the countdown and a slot can only be claimed once.
 *
 * Claiming is an atomic conditional update — `UPDATE Settings SET
 * sweepNextRunAt = <next> WHERE sweepNextRunAt = <the value we read>`. If two
 * replicas tick at the same moment, exactly one update matches a row and only
 * that replica starts the sweep.
 *
 * The sweep itself still goes through the normal run lock, so a scheduled sweep
 * that lands while a manual run is in progress is skipped (and retried at the
 * next slot) rather than queued.
 */

import { prisma, getSettings } from "./db";
import { logger } from "./logger";
import { runSweep } from "./sweep";
import { RunLockError } from "./jobs";
import {
  isSweepDue,
  nextRunAfterFiring,
  addInterval,
  schedulerDisabledByEnv,
} from "./schedule";

const log = logger("schedule");

/** How often the scheduler asks the database whether a sweep is due. */
export const SCHEDULER_TICK_MS = 60_000;

export type SchedulerTickStatus =
  | "disabled" // schedule turned off in Settings
  | "scheduled" // schedule on but nothing was due yet — first slot recorded
  | "idle" // not due yet
  | "claimed_elsewhere" // another replica took this slot
  | "locked" // a run was already in progress
  | "started" // sweep kicked off
  | "error";

export interface SchedulerTickResult {
  status: SchedulerTickStatus;
  runId?: number;
  nextRunAt?: Date | null;
  error?: string;
}

/**
 * One scheduler pass. Exported so it can be driven directly (tests, a manual
 * poke) instead of only by the timer.
 */
export async function tickScheduler(now: Date = new Date()): Promise<SchedulerTickResult> {
  const settings = await getSettings();

  if (!settings.sweepScheduleEnabled) return { status: "disabled" };

  // Schedule turned on out-of-band (or an upgrade left the slot empty): record
  // the first slot and wait for it.
  if (!settings.sweepNextRunAt) {
    const first = addInterval(now, settings.sweepIntervalHours);
    await prisma.settings.update({ where: { id: 1 }, data: { sweepNextRunAt: first } });
    return { status: "scheduled", nextRunAt: first };
  }

  if (!isSweepDue(settings, now)) {
    return { status: "idle", nextRunAt: settings.sweepNextRunAt };
  }

  // Claim the slot before doing any work. Missed slots are skipped rather than
  // replayed — the next run is always a full interval from now.
  const next = nextRunAfterFiring(settings.sweepIntervalHours, now);
  const claim = await prisma.settings.updateMany({
    where: { id: 1, sweepNextRunAt: settings.sweepNextRunAt },
    data: { sweepNextRunAt: next, sweepLastRunAt: now },
  });
  if (claim.count === 0) return { status: "claimed_elsewhere" };

  try {
    const runId = await runSweep("schedule");
    return { status: "started", runId, nextRunAt: next };
  } catch (e) {
    // A manual run holds the lock — leave the claimed slot in place and try
    // again at the next one.
    if (e instanceof RunLockError) return { status: "locked", nextRunAt: next };
    return { status: "error", error: (e as Error).message, nextRunAt: next };
  }
}

/**
 * Start the recurring timer. Safe to call once per server process; returns a
 * stop function. No-op when SWEEP_SCHEDULER is off.
 */
export function startSweepScheduler(): () => void {
  if (schedulerDisabledByEnv()) {
    log.info("sweep scheduler disabled by SWEEP_SCHEDULER env var.");
    return () => {};
  }

  const tick = async () => {
    try {
      const r = await tickScheduler();
      if (r.status === "started") {
        log.info(`started scheduled sweep #${r.runId}.`);
      } else if (r.status === "locked") {
        log.info("scheduled sweep skipped — a run is already in progress.");
      } else if (r.status === "error") {
        log.error(`scheduled sweep failed to start: ${r.error}`);
      }
    } catch (e) {
      log.error(`scheduler tick failed: ${(e as Error).message}`);
    }
  };

  // Give the database a moment to become reachable after boot.
  const first = setTimeout(tick, 15_000);
  const timer = setInterval(tick, SCHEDULER_TICK_MS);
  // Do not keep the event loop alive solely for these timers.
  if (typeof first.unref === "function") first.unref();
  if (typeof timer.unref === "function") timer.unref();

  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
