import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Liveness/readiness probe for container orchestrators.
 *
 * Public by design (the middleware allows it through) so a probe does not need
 * credentials, and deliberately thin: it reports only whether the process is up
 * and whether PostgreSQL answers. Nothing about configuration, versions or the
 * library is exposed, since an unauthenticated endpoint should not become a
 * reconnaissance surface.
 */
export async function GET() {
  const startedAt = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json(
      { status: "ok", database: "up", latencyMs: Date.now() - startedAt },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return NextResponse.json(
      { status: "degraded", database: "down" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
