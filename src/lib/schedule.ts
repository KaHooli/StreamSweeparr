/**
 * Scheduled sweeps — pure logic (no I/O) so it can be reused by the API route,
 * the background scheduler and the UI, and unit-tested directly.
 *
 * The schedule is stored on the Settings row as an interval plus the timestamp
 * of the next due run. Keeping "next due" in the database (rather than in a
 * process-local timer) means a restart doesn't reset the countdown, and two
 * replicas can't both fire the same slot — claiming a slot is a conditional
 * update of `sweepNextRunAt`.
 */

/** Interval choices offered in the UI, in hours. */
export const SWEEP_INTERVAL_CHOICES = [1, 2, 3, 4, 6, 8, 12, 24, 48, 72, 168] as const;

export const MIN_SWEEP_INTERVAL_HOURS = 1;
/** One week. Longer than this and a cron/webhook is the better tool. */
export const MAX_SWEEP_INTERVAL_HOURS = 168;

export const DEFAULT_SWEEP_INTERVAL_HOURS = 12;

const HOUR_MS = 60 * 60 * 1000;

export interface SweepScheduleShape {
  sweepScheduleEnabled: boolean;
  sweepIntervalHours: number;
  sweepNextRunAt: Date | null;
}

/** Whether an interval is one we accept (whole hours, 1h – 7 days). */
export function isValidSweepInterval(hours: number): boolean {
  return (
    Number.isInteger(hours) &&
    hours >= MIN_SWEEP_INTERVAL_HOURS &&
    hours <= MAX_SWEEP_INTERVAL_HOURS
  );
}

/** Clamp an arbitrary number of hours into the accepted range. */
export function clampSweepInterval(hours: number): number {
  if (!Number.isFinite(hours)) return DEFAULT_SWEEP_INTERVAL_HOURS;
  const whole = Math.round(hours);
  if (whole < MIN_SWEEP_INTERVAL_HOURS) return MIN_SWEEP_INTERVAL_HOURS;
  if (whole > MAX_SWEEP_INTERVAL_HOURS) return MAX_SWEEP_INTERVAL_HOURS;
  return whole;
}

/** `from` + `hours`. */
export function addInterval(from: Date, hours: number): Date {
  return new Date(from.getTime() + clampSweepInterval(hours) * HOUR_MS);
}

/**
 * The next due time after a settings change.
 *
 * Rules:
 *  - Disabled -> no next run at all (cleared, so re-enabling starts fresh).
 *  - Just enabled, or enabled with nothing scheduled -> one full interval from
 *    now, so turning the schedule on never fires a sweep immediately.
 *  - Interval changed -> re-anchor on the last scheduled run (or now if there
 *    hasn't been one), never earlier than now, so shortening the interval takes
 *    effect straight away without firing mid-save.
 *  - Otherwise -> keep the pending slot untouched; saving unrelated options must
 *    not push the schedule out.
 */
export function nextRunAfterChange(
  prev: SweepScheduleShape & { sweepLastRunAt: Date | null },
  next: { sweepScheduleEnabled: boolean; sweepIntervalHours: number },
  now: Date = new Date()
): Date | null {
  if (!next.sweepScheduleEnabled) return null;

  const interval = clampSweepInterval(next.sweepIntervalHours);

  if (!prev.sweepScheduleEnabled || !prev.sweepNextRunAt) return addInterval(now, interval);

  if (clampSweepInterval(prev.sweepIntervalHours) !== interval) {
    const anchored = addInterval(prev.sweepLastRunAt ?? now, interval);
    return anchored.getTime() < now.getTime() ? now : anchored;
  }

  return prev.sweepNextRunAt;
}

/** Whether a scheduled sweep is due to start. */
export function isSweepDue(s: SweepScheduleShape, now: Date = new Date()): boolean {
  if (!s.sweepScheduleEnabled || !s.sweepNextRunAt) return false;
  return s.sweepNextRunAt.getTime() <= now.getTime();
}

/**
 * The slot to schedule after firing at `now`. Always in the future, even if the
 * process was asleep for several intervals — we skip the missed slots rather
 * than running a burst of catch-up sweeps.
 */
export function nextRunAfterFiring(hours: number, now: Date = new Date()): Date {
  return addInterval(now, hours);
}

/** "12 hours" / "1 hour" / "2 days" — used in the UI and run logs. */
export function describeInterval(hours: number): string {
  const h = clampSweepInterval(hours);
  if (h % 24 === 0) {
    const days = h / 24;
    return days === 1 ? "1 day" : `${days} days`;
  }
  return h === 1 ? "1 hour" : `${h} hours`;
}

/** Human-readable summary for logs and the UI, e.g. "every 12 hours". */
export function describeSchedule(hours: number): string {
  return `every ${describeInterval(hours)}`;
}

/** Whether the background scheduler is switched off for this instance. */
export function schedulerDisabledByEnv(
  env: Record<string, string | undefined> = process.env
): boolean {
  const flag = env.SWEEP_SCHEDULER?.trim().toLowerCase();
  return flag === "off" || flag === "false" || flag === "0";
}
