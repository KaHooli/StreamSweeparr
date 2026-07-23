import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession, withGuard } from "@/lib/auth";

export const dynamic = "force-dynamic";

export const GET = withGuard(requireSession, async () => {
  const runs = await prisma.runLog.findMany({
    orderBy: { startedAt: "desc" },
    take: 20,
  });
  return NextResponse.json({ runs });
});
