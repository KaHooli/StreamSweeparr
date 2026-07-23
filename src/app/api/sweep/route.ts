import { NextResponse } from "next/server";
import { runSweep } from "@/lib/sweep";
import { RunLockError } from "@/lib/jobs";
import { requireAdmin, withGuard } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Kick off a sweep run in the background. Returns the runId immediately;
// poll GET /api/runs/{id} for live progress.
export const POST = withGuard(requireAdmin, async () => {
  try {
    const runId = await runSweep();
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
