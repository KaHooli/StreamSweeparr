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
import { logger } from "./logger";

const log = logger("run");

// A run whose heartbeat is older than this is considered dead and no longer
// holds the lock.
const STALE_MS = 5 * 60 * 1000;

/**
 * Advisory-lock key guarding lock *acquisition* (not the run itself).
 *
 * "Is a run active? No → create one" is a read followed by a write, and two
 * requests arriving together both read "no" and both start a run. Taking a
 * transaction-scoped advisory lock around that pair serialises it. The lock is
 * released when the transaction commits — a session-scoped lock would be wrong
 * here because Prisma pools connections and the run outlives the request.
 *
 * Arbitrary constant; it only has to be stable and unique within the database.
 */
const RUN_LOCK_KEY = 8_274_531_900_123;

export type LogLevel = "info" | "action" | "warn";
export interface LogLine {
  level: LogLevel;
  msg: string;
  at?: string;
}

/**
 * Cap on log lines retained for one run.
 *
 * The whole log is re-serialised into the RunLog row on every flush, so an
 * uncapped log makes a big sweep write O(n²) bytes — a library-wide purge would
 * rewrite a multi-megabyte JSON blob every 1.5 seconds. Past the cap the
 * middle is dropped: the opening steps and the most recent activity are what
 * anyone reads, and a marker records how much was elided.
 */
export const MAX_LOG_LINES = 2000;
const HEAD_LINES = 200;

export interface RunCounts {
  unmonitoredMovies: number;
  remonitoredMovies: number;
  unmonitoredEps: number;
  remonitoredEps: number;
  deletedFiles: number;
  removedMovies: number;
  searchedItems: number;
}

export class RunLockError extends Error {
  constructor(public runningId: number) {
    super("A sync or sweep is already running.");
    this.name = "RunLockError";
  }
}

/**
 * Progress handle passed to a job body. Buffers log lines and flushes them
 * (plus counts + heartbeat) to the DB periodically.
 */
export class RunContext {
  private head: LogLine[] = [];
  private tail: LogLine[] = [];
  private dropped = 0;
  counts: RunCounts = {
    unmonitoredMovies: 0,
    remonitoredMovies: 0,
    unmonitoredEps: 0,
    remonitoredEps: 0,
    deletedFiles: 0,
    removedMovies: 0,
    searchedItems: 0,
  };
  private lastFlush = 0;
  // Serialises writes: `push` fires flushes without awaiting them, and two
  // in-flight updates to the same row can otherwise land out of order.
  // `chain` is the tail of the write queue; `queued` is a write that has been
  // scheduled but has not started reading state yet, so further callers can
  // ride along with it instead of adding another round trip.
  private chain: Promise<void> = Promise.resolve();
  private queued: Promise<void> | null = null;

  constructor(public runId: number) {}

  push(level: LogLevel, msg: string) {
    const line: LogLine = { level, msg, at: new Date().toISOString() };
    if (this.head.length < HEAD_LINES) {
      this.head.push(line);
    } else {
      this.tail.push(line);
      if (this.head.length + this.tail.length > MAX_LOG_LINES) {
        this.tail.shift();
        this.dropped++;
      }
    }
    // Throttled flush so long runs surface progress without hammering the DB.
    if (Date.now() - this.lastFlush > 1500) void this.flush();
  }

  /**
   * Persist the log, counts and heartbeat.
   *
   * Writes never overlap, and a burst of callers collapses into a single one:
   * at most one write is in flight and one queued behind it. The returned
   * promise always resolves *after* a write that captured the state as of the
   * call — joining the in-flight write instead would let `await flush()` return
   * having persisted a snapshot older than the caller's own changes.
   */
  flush(): Promise<void> {
    // A queued-but-not-yet-started write will read state at least as new as
    // ours, so there is nothing to gain from scheduling another.
    if (this.queued) return this.queued;

    const write = this.chain.then(() => {
      // From here the write is reading state; later callers need a fresh one.
      this.queued = null;
      return this.writeOnce();
    });
    this.queued = write;
    this.chain = write.catch(() => {});
    return write;
  }

  private async writeOnce(): Promise<void> {
    this.lastFlush = Date.now();
    await prisma.runLog
      .update({
        where: { id: this.runId },
        data: {
          heartbeatAt: new Date(),
          log: this.snapshotLog() as unknown as object,
          ...this.counts,
        },
      })
      .catch((e) => {
        log.warn(`could not persist progress for run #${this.runId}: ${(e as Error).message}`);
      });
  }

  snapshotLog(): LogLine[] {
    if (!this.dropped) return [...this.head, ...this.tail];
    return [
      ...this.head,
      {
        level: "info" as const,
        msg: `… ${this.dropped} earlier line(s) omitted to keep the run log a sane size …`,
      },
      ...this.tail,
    ];
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
  // Reap-check-create runs inside one transaction holding the advisory lock, so
  // simultaneous callers queue up and exactly one of them sees "no active run".
  const run = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${RUN_LOCK_KEY}::bigint)`;

    // Mark stale RUNNING rows as FAILED so they release the lock.
    await tx.runLog.updateMany({
      where: { status: "RUNNING", heartbeatAt: { lt: new Date(Date.now() - STALE_MS) } },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        error: "Run timed out / process died.",
      },
    });

    const active = await tx.runLog.findFirst({
      where: { status: "RUNNING" },
      orderBy: { startedAt: "desc" },
    });
    if (active) throw new RunLockError(active.id);

    return tx.runLog.create({ data: { kind, dryRun, status: "RUNNING", log: [] } });
  });

  const ctx = new RunContext(run.id);

  // Heartbeat while the job runs.
  const heartbeat = setInterval(() => void ctx.flush(), 30_000);
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  // Detached execution — do not await.
  void (async () => {
    try {
      await body(ctx);
      await prisma.runLog.update({
        where: { id: run.id },
        data: {
          status: "SUCCESS",
          finishedAt: new Date(),
          log: ctx.snapshotLog() as unknown as object,
          ...ctx.counts,
        },
      });
    } catch (e) {
      ctx.push("warn", `Run failed: ${(e as Error).message}`);
      await prisma.runLog
        .update({
          where: { id: run.id },
          data: {
            status: "FAILED",
            finishedAt: new Date(),
            error: (e as Error).message,
            log: ctx.snapshotLog() as unknown as object,
            ...ctx.counts,
          },
        })
        .catch((err) => {
          log.error(`could not record failure for run #${run.id}: ${(err as Error).message}`);
        });
    } finally {
      clearInterval(heartbeat);
    }
  })();

  return run.id;
}
