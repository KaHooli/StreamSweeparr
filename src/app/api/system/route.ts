import { NextResponse } from "next/server";
import { requireAdmin, withGuard } from "@/lib/auth";
import { collectSystemInfo } from "@/lib/collectSystemInfo";

export const dynamic = "force-dynamic";

/**
 * Diagnostics for the Settings → Info tab.
 *
 * Administrators only. `/api/health` stays the unauthenticated probe: it says
 * only "up" or "down", while this reports versions, database internals and the
 * whole configuration — a reconnaissance surface if it were public. The payload
 * carries no credentials (see systemInfo.ts), so an admin can copy it straight
 * into a bug report.
 */
export const GET = withGuard(requireAdmin, async () => {
  return NextResponse.json(await collectSystemInfo(), {
    headers: { "Cache-Control": "no-store" },
  });
});
