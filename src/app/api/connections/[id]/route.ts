import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAdmin, withGuard } from "@/lib/auth";
import { encryptSecret } from "@/lib/secrets";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  name: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
});

// Next 16 delivers route params as a Promise, and this type is written by hand
// rather than inferred — so it has to say so. Left as a plain object, the
// handler reads a property off a Promise, gets undefined, and every request
// 400s on an "invalid id" that was perfectly valid.
type Ctx = { params: Promise<{ id: string }> };

export const PATCH = withGuard(requireAdmin, async (_session, req: NextRequest, ctx: Ctx) => {
  const id = Number((await ctx.params).id);
  if (Number.isNaN(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  const parsed = patchSchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const { apiKey, ...rest } = parsed.data;
  await prisma.arrConnection.update({
    where: { id },
    data: { ...rest, ...(apiKey ? { apiKey: encryptSecret(apiKey) ?? "" } : {}) },
  });
  return NextResponse.json({ ok: true });
});

export const DELETE = withGuard(requireAdmin, async (_session, _req: NextRequest, ctx: Ctx) => {
  const id = Number((await ctx.params).id);
  if (Number.isNaN(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  await prisma.arrConnection.delete({ where: { id } });
  return NextResponse.json({ ok: true });
});
