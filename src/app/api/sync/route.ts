import { NextResponse } from "next/server";
import { runSync } from "@/lib/sync";
import { startRun, RunLockError } from "@/lib/jobs";
import { requireAdmin, withGuard } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Kick off a sync run in the background; returns the runId immediately.
// Poll GET /api/runs/{id} for progress.
export const POST = withGuard(requireAdmin, async () => {
  try {
    const runId = await startRun("SYNC", true, async (ctx) => {
      ctx.push("info", "Starting sync…");
      const result = await runSync((level, msg) => ctx.push(level, msg), {
        checkAbort: () => ctx.checkAbort(),
      });
      ctx.push(
        "info",
        `Synced ${result.movies} movies (${result.onStreamingMovies} on streaming), ` +
          `${result.series} series (${result.onStreamingSeries} on streaming).`
      );
      for (const e of result.errors) ctx.push("warn", e);
    });
    return NextResponse.json({ ok: true, runId });
  } catch (e) {
    if (e instanceof RunLockError) {
      return NextResponse.json(
        { ok: false, error: "A run is already in progress.", runId: e.runningId },
        { status: 409 }
      );
    }
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
});
