import { NextResponse } from "next/server";
import { runSweep } from "@/lib/sweep";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Kick off a sweep run. Returns the run id; poll /api/runs/{id} for progress.
export async function POST() {
  try {
    const runId = await runSweep();
    return NextResponse.json({ ok: true, runId });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
