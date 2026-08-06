import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession, withGuard } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Next 16 delivers route params as a Promise, and this type is written by hand
// rather than inferred — so it has to say so. Left as a plain object, the
// handler reads a property off a Promise, gets undefined, and every request
// 400s on an "invalid id" that was perfectly valid.
type Ctx = { params: Promise<{ id: string }> };

export const GET = withGuard(requireSession, async (_session, _req: Request, ctx: Ctx) => {
  const id = Number((await ctx.params).id);
  if (Number.isNaN(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  const run = await prisma.runLog.findUnique({ where: { id } });
  if (!run) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ run });
});
