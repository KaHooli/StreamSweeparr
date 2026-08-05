import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAdmin, withGuard } from "@/lib/auth";

export const dynamic = "force-dynamic";

const schema = z.object({ role: z.enum(["ADMIN", "USER"]) });

type Ctx = { params: { id: string } };

// Change a user's role (admins only).
export const PATCH = withGuard(requireAdmin, async (_session, req: NextRequest, ctx: Ctx) => {
  const id = Number(ctx.params.id);
  if (Number.isNaN(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "role must be ADMIN or USER." }, { status: 400 });
  }
  const { role } = parsed.data;

  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) return NextResponse.json({ error: "User not found." }, { status: 404 });
  if (target.role === role) return NextResponse.json({ ok: true, role });

  // The local username/password account is always an administrator.
  if (role === "USER" && target.passwordHash) {
    return NextResponse.json(
      { error: "The username & password account must remain an administrator." },
      { status: 400 }
    );
  }

  // Never leave the instance without an administrator.
  if (role === "USER") {
    const admins = await prisma.user.count({ where: { role: "ADMIN" } });
    if (admins <= 1) {
      return NextResponse.json(
        { error: "There must be at least one administrator." },
        { status: 400 }
      );
    }
  }

  // Bump tokenVersion so the change takes effect on the target's *existing*
  // sessions. Without it a demoted admin would keep admin rights until their
  // session token expired, because the role is baked into the signed cookie.
  await prisma.user.update({
    where: { id },
    data: { role, tokenVersion: { increment: 1 } },
  });
  return NextResponse.json({ ok: true, role });
});

// Remove an account (admins only). The local account cannot be deleted.
export const DELETE = withGuard(requireAdmin, async (session, _req: NextRequest, ctx: Ctx) => {
  const id = Number(ctx.params.id);
  if (Number.isNaN(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) return NextResponse.json({ error: "User not found." }, { status: 404 });
  if (target.passwordHash) {
    return NextResponse.json(
      { error: "The username & password account cannot be deleted." },
      { status: 400 }
    );
  }
  if (target.id === session.sub) {
    return NextResponse.json({ error: "You cannot delete your own account." }, { status: 400 });
  }

  await prisma.user.delete({ where: { id } });
  return NextResponse.json({ ok: true });
});
