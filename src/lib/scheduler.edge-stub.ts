/**
 * Edge-runtime stub for lib/scheduler.
 *
 * The real scheduler pulls in the sweep engine (Prisma, `pg`, node streams via
 * the Title ID map importer). Next.js compiles the instrumentation hook for the
 * edge runtime as well, so webpack is pointed at this stub there (see
 * next.config.mjs). Nothing here is ever called: instrumentation only starts the
 * scheduler when NEXT_RUNTIME === "nodejs", where the real module is used.
 */

export const SCHEDULER_TICK_MS = 60_000;

export function startSweepScheduler(): () => void {
  return () => {};
}

export async function tickScheduler(): Promise<{ status: "disabled" }> {
  return { status: "disabled" };
}
