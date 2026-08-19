import { NextResponse } from "next/server";
import { requestRunAbort, type AbortRequest } from "@/lib/jobs";
import { requireAdmin, withGuard } from "@/lib/auth";

export const dynamic = "force-dynamic";

// See ../route.ts: Next 16 hands route params over as a Promise.
type Ctx = { params: Promise<{ id: string }> };

/**
 * What each outcome means over HTTP.
 *
 * "stopped" is a 200 like "requested": from the caller's side both mean "your
 * click did what you asked", and only the message differs. "not_running" is a
 * 409 rather than an error, because the usual way to reach it is two admins —
 * or two tabs — clicking on a run that has since finished.
 */
const RESPONSES: Record<AbortRequest["status"], { status: number; message: string }> = {
  requested: { status: 200, message: "Stopping — the run finishes what it is on and then stops." },
  already_requested: { status: 200, message: "Already stopping." },
  stopped: {
    status: 200,
    message: "Run marked as stopped; it had already stopped responding.",
  },
  not_running: { status: 409, message: "That run has already finished." },
  not_found: { status: 404, message: "Run not found." },
};

// Ask a running sync/sweep to stop. Admin-only, like the buttons that start one.
export const POST = withGuard(requireAdmin, async (_session, _req: Request, ctx: Ctx) => {
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const outcome = await requestRunAbort(id);
  const { status, message } = RESPONSES[outcome.status];
  return NextResponse.json(
    status === 200
      ? { ok: true, status: outcome.status, message }
      : { ok: false, status: outcome.status, error: message },
    { status }
  );
});
