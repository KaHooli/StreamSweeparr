/**
 * Background job orchestration for sync/sweep runs.
 *
 * Runs are represented by a RunLog row which doubles as a concurrency lock:
 * only one run may be RUNNING at a time. A heartbeat lets us reclaim the lock
 * if a previous run's process died. Handlers return the runId immediately and
 * the actual work executes detached; clients poll GET /api/runs/{id}.
 */
import { prisma } from "./db";
import type { RunKind } from "@prisma/client";

// A run whose heartbeat is older than this is considered dead and no longer
// holds the lock.
const STALE_MS = 5 * 60 * 1000;

export type LogLevel = "info" | "action" | "warn";
export interface LogLine {
  level: LogLevel;
  msg: string;
  at?: string;
}

export interface RunCounts {
  unmonitoredMovies: number;
  remonitoredMovies: number;
  unmonitoredEps: number;
  remonitoredEps: number;
  deletedFiles: number;
  searchedItems: number;
}

export class RunLockError extends Error {
  constructor(public runningId: number) {
    super("A sync or sweep is already running.");
    this.name = "RunLockError";
  }
}

/** Mark stale RUNNING rows as FAILED so they release the lock. */
async function reapStale() {
  const cutoff = new Date(Date.now() - STALE_MS);
  await prisma.runLog.updateMany({
    where: { status: "RUNNING", heartbeatAt: { lt: cutoff } },
    data: { status: "FAILED", finishedAt: new Date(), error: "Run timed out / process died." },
  });
}

/**
 * Progress handle passed to a job body. Buffers log lines and flushes them
 * (plus counts + heartbeat) to the DB periodically.
 */
export class RunContext {
  private log: LogLine[] = [];
  counts: RunCounts = {
    unmonitoredMovies: 0,
    remonitoredMovies: 0,
    unmonitoredEps: 0,
    remonitoredEps: 0,
    deletedFiles: 0,
    searchedItems: 0,
  };
  private lastFlush = 0;

  constructor(public runId: number) {}

  push(level: LogLevel, msg: string) {
    this.log.push({ level, msg, at: new Date().toISOString() });
    // Throttled flush so long runs surface progress without hammering the DB.
    if (Date.now() - this.lastFlush > 1500) void this.flush();
  }

  async flush() {
    this.lastFlush = Date.now();
    await prisma.runLog
      .update({
        where: { id: this.runId },
        data: {
          heartbeatAt: new Date(),
          log: this.log as unknown as object,
          ...this.counts,
        },
      })
      .catch(() => {});
  }

  snapshotLog() {
    return this.log;
  }
}

/**
 * Acquire the run lock (creating a RUNNING RunLog) and execute `body` detached.
 * Returns the runId immediately. Throws RunLockError if a run is already active.
 */
export async function startRun(
  kind: RunKind,
  dryRun: boolean,
  body: (ctx: RunContext) => Promise<void>
): Promise<number> {
  await reapStale();

  const active = await prisma.runLog.findFirst({
    where: { status: "RUNNING" },
    orderBy: { startedAt: "desc" },
  });
  if (active) throw new RunLockError(active.id);

  const run = await prisma.runLog.create({
    data: { kind, dryRun, status: "RUNNING", log: [] },
  });
  const ctx = new RunContext(run.id);

  // Heartbeat while the job runs.
  const heartbeat = setInterval(() => void ctx.flush(), 30_000);
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  // Detached execution — do not await.
  void (async () => {
    try {
      await body(ctx);
      await ctx.flush();
      await prisma.runLog.update({
        where: { id: run.id },
        data: { status: "SUCCESS", finishedAt: new Date(), log: ctx.snapshotLog() as unknown as object, ...ctx.counts },
      });
    } catch (e) {
      ctx.push("warn", `Run failed: ${(e as Error).message}`);
      await prisma.runLog.update({
        where: { id: run.id },
        data: {
          status: "FAILED",
          finishedAt: new Date(),
          error: (e as Error).message,
          log: ctx.snapshotLog() as unknown as object,
          ...ctx.counts,
        },
      });
    } finally {
      clearInterval(heartbeat);
    }
  })();

  return run.id;
}
