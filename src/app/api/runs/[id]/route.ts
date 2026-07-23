import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession, withGuard } from "@/lib/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

export const GET = withGuard(requireSession, async (_session, _req: Request, ctx: Ctx) => {
  const id = Number(ctx.params.id);
  if (Number.isNaN(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  const run = await prisma.runLog.findUnique({ where: { id } });
  if (!run) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ run });
});
