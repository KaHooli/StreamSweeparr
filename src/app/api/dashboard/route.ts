import { NextResponse } from "next/server";
import { requireSession, withGuard } from "@/lib/auth";
import { getDashboardData } from "@/lib/dashboard";

export const dynamic = "force-dynamic";

// The dashboard payload. The server-rendered page calls getDashboardData()
// directly; this endpoint serves client-side refreshes of the same data.
export const GET = withGuard(requireSession, async () => {
  return NextResponse.json(await getDashboardData());
});
