/**
 * Background job orchestration for sync/sweep runs.
 *
 * Runs are represented by a RunLog row which doubles as a concurrency lock:
 * only one run may be RUNNING at a time. A heartbeat lets us reclaim the lock
 * if a previous run's process died. Handlers return the runId immediately and
 * the actual work executes detached; clients poll GET /api/runs/{id}.
 *
 * Detached also means there is no handle to cancel, so stopping a run is
 * co-operative: an admin records the request (`requestRunAbort`) and the run
 * unwinds itself at its next checkpoint (`RunContext.checkAbort`), ending
 * ABORTED. Nothing is killed mid-request — see those two for why.
 */
import { prisma } from "./db";
import type { RunKind } from "@/generated/prisma/client";
import { logger } from "./logger";

const log = logger("run");

// A run whose heartbeat is older than this is considered dead and no longer
// holds the lock.
export const STALE_MS = 5 * 60 * 1000;

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

/**
 * How long a run may go between asking the database whether it has been told to
 * stop.
 *
 * Every checkpoint in a sweep or sync calls `checkAbort`, and a library-wide
 * pass hits thousands of them, so the poll is throttled rather than run per
 * item. Two seconds is short enough that "Abort" feels immediate and long
 * enough that the extra load is one primary-key select every couple of seconds.
 *
 * The cost of the throttle is the guarantee it weakens: a checkpoint reached
 * within the window of the last poll does not see a request made in between, so
 * "stops at the next checkpoint" is really "the next checkpoint this far past
 * the last poll". Exported so tests can wait it out rather than hardcode it.
 */
export const ABORT_POLL_MS = 2000;

export type LogLevel = "info" | "action" | "warn";
export interface LogLine {
  level: LogLevel;
  msg: string;
  at?: string;
}

/**
 * Thrown inside a run body once an admin has asked the run to stop.
 *
 * It travels like any other error — which is the point: every `await` between
 * the checkpoint and `startRun` unwinds, so nothing is left half-applied. The
 * machinery that deliberately swallows errors to keep a sweep going (sweep's
 * `ErrorCollector`, sync's per-connection catch) has to let this one past, or
 * an abort would be logged as an item failure and the run would carry on.
 */
export class RunAbortedError extends Error {
  constructor() {
    super("Run stopped at an administrator's request.");
    this.name = "RunAbortedError";
  }
}

/**
 * Called between units of work; throws {@link RunAbortedError} if the run has
 * been told to stop. Handed to sync and sweep so neither has to know how the
 * request is stored.
 */
export type CheckAbort = () => Promise<void>;

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
  // Set the moment the run starts finalising. After that the terminal write is
  // the last word on this row and progress writes must not be scheduled.
  private finished = false;
  // Latched once an abort request has been seen, so every later checkpoint
  // throws without going back to the database.
  private aborted = false;
  private lastAbortPoll = 0;

  constructor(public runId: number) {}

  /**
   * Stop the run here if an admin has asked it to.
   *
   * Call it between units of work — a title, a batch, a connection. Nothing
   * interrupts a request already in flight: the run finishes the item it is on
   * and unwinds at the next checkpoint, so Sonarr/Radarr are never left having
   * been told half of something. Work already applied stands; the run log is
   * the record of how far it got.
   *
   * The request is read from the database rather than held in this process
   * because the click can land on any replica. The poll is throttled (see
   * `ABORT_POLL_MS`) so this is safe to call inside a per-title loop, and a
   * failed poll is ignored — a database blip should not end a healthy run.
   */
  async checkAbort(now: number = Date.now()): Promise<void> {
    if (this.aborted) throw new RunAbortedError();
    if (now - this.lastAbortPoll < ABORT_POLL_MS) return;
    this.lastAbortPoll = now;

    const row = await prisma.runLog
      .findUnique({ where: { id: this.runId }, select: { abortRequestedAt: true } })
      .catch((e) => {
        log.warn(`could not check for an abort of run #${this.runId}: ${(e as Error).message}`);
        return null;
      });
    if (!row?.abortRequestedAt) return;

    this.aborted = true;
    throw new RunAbortedError();
  }

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
    // Once `finish` has been called the row is being closed out; a progress
    // write scheduled now could only undo it.
    if (this.finished) return Promise.resolve();
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

  /**
   * Write the run's terminal state — the last thing this row ever receives.
   *
   * It goes through the same queue as `flush` rather than issuing its own
   * update, and that is the whole point. `push` fires progress writes without
   * awaiting them, so when a body finishes there can still be an update in
   * flight that snapshotted the counts while they were zero. Issued
   * independently, the two updates travel on different pooled connections with
   * no ordering between them; when the progress write lands second it silently
   * resets the counts — and not `status`, which it does not set. The result is
   * a run marked SUCCESS that claims it changed nothing.
   *
   * That is not hypothetical: it is what made the sweep integration suite fail
   * roughly one run in twenty, and in production it would quietly under-report
   * what a sweep actually did.
   */
  finish(final: { status: "SUCCESS" | "FAILED" | "ABORTED"; error?: string }): Promise<void> {
    // Synchronous, so a `push` racing with finalisation cannot slip a write in
    // behind us.
    this.finished = true;
    const write = this.chain.then(async () => {
      this.queued = null;
      await prisma.runLog.update({
        where: { id: this.runId },
        data: {
          ...final,
          finishedAt: new Date(),
          log: this.snapshotLog() as unknown as object,
          ...this.counts,
        },
      });
    });
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
      // Stop the heartbeat before finalising: it flushes, and nothing should be
      // scheduling progress writes once the terminal write is queued.
      clearInterval(heartbeat);
      await ctx.finish({ status: "SUCCESS" });
    } catch (e) {
      clearInterval(heartbeat);
      // An abort is a deliberate stop, not a failure, and it gets its own
      // terminal status so the Runs page can say so. The counts written with it
      // are what the run had *decided* on, which is not the same as what it
      // managed to apply — hence the log line saying where it stopped.
      const aborted = e instanceof RunAbortedError;
      const status = aborted ? ("ABORTED" as const) : ("FAILED" as const);
      const error = aborted
        ? "Stopped from the Runs page. Anything already applied to Sonarr/Radarr stands; " +
          "the log shows how far the run got."
        : (e as Error).message;
      ctx.push("warn", aborted ? `Run aborted: ${error}` : `Run failed: ${error}`);
      await ctx.finish({ status, error }).catch((err) => {
        log.error(`could not record the end of run #${run.id}: ${(err as Error).message}`);
      });
      if (aborted) log.info(`run #${run.id} stopped at an administrator's request.`);
    } finally {
      clearInterval(heartbeat);
    }
  })();

  return run.id;
}

/** What asking a run to stop actually did. */
export type AbortRequest =
  /** Recorded; the run will unwind at its next checkpoint. */
  | { status: "requested" }
  /** An earlier request is still being acted on. */
  | { status: "already_requested" }
  /** The run had stopped responding, so it was closed out here and then. */
  | { status: "stopped" }
  /** It had already finished — there is nothing to stop. */
  | { status: "not_running" }
  | { status: "not_found" };

/**
 * Ask a running run to stop.
 *
 * Nothing is killed: the request is recorded and the run itself unwinds at its
 * next checkpoint (see `RunContext.checkAbort`), which is what keeps a sweep
 * from stopping midway through telling Radarr about a batch.
 *
 * A run whose heartbeat has gone quiet is the exception. There is no process
 * left to read the request, so recording one would leave the button doing
 * nothing and the row RUNNING — holding the run lock — until some later
 * `startRun` reaps it. That is exactly the verdict `startRun` would reach, so
 * reach it here instead and close the row out. It doubles as the escape hatch
 * for a lock stuck by a process that died, which previously needed a restart.
 */
export async function requestRunAbort(
  runId: number,
  now: Date = new Date()
): Promise<AbortRequest> {
  const run = await prisma.runLog.findUnique({
    where: { id: runId },
    select: { status: true, heartbeatAt: true },
  });
  if (!run) return { status: "not_found" };
  if (run.status !== "RUNNING") return { status: "not_running" };

  if (run.heartbeatAt.getTime() < now.getTime() - STALE_MS) {
    const closed = await prisma.runLog.updateMany({
      where: { id: runId, status: "RUNNING" },
      data: {
        status: "ABORTED",
        finishedAt: now,
        abortRequestedAt: now,
        error: "Stopped from the Runs page after the run had already stopped responding.",
      },
    });
    // Zero rows means the run finalised itself between the read and the write —
    // it was alive after all, and its own terminal status is the true one.
    return closed.count ? { status: "stopped" } : { status: "not_running" };
  }

  // Conditional so a second click cannot move the timestamp on a request the
  // run is already acting on.
  const claimed = await prisma.runLog.updateMany({
    where: { id: runId, status: "RUNNING", abortRequestedAt: null },
    data: { abortRequestedAt: now },
  });
  if (claimed.count) return { status: "requested" };

  const after = await prisma.runLog.findUnique({ where: { id: runId }, select: { status: true } });
  if (!after) return { status: "not_found" };
  return after.status === "RUNNING" ? { status: "already_requested" } : { status: "not_running" };
}

/**
 * Is a run currently alive — RUNNING, and heartbeating recently enough to
 * believe it?
 *
 * Only one run may be active at a time, so this doubles as "might some run
 * still be holding work in flight?". The webhook queue asks before reclaiming
 * a claim it thinks is stale: a claim's real lifetime is the sweep it is
 * waiting on, and a sweep has no maximum duration, so a fixed timeout is the
 * wrong instrument. A dead process self-heals here because `startRun` reaps
 * RUNNING rows whose heartbeat has gone quiet, which is the same threshold.
 */
export async function hasLiveRun(now: Date = new Date()): Promise<boolean> {
  const active = await prisma.runLog.findFirst({
    where: { status: "RUNNING", heartbeatAt: { gte: new Date(now.getTime() - STALE_MS) } },
    select: { id: true },
  });
  return active !== null;
}
