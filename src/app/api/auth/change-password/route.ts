import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { verifyPassword, hashPassword } from "@/lib/password";
import { SESSION_COOKIE, verifySession, createSession, sessionCookieOptions } from "@/lib/session";
import { resolveSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

const schema = z.object({
  currentPassword: z.string().optional(),
  newPassword: z.string().min(8, "New password must be at least 8 characters."),
});

export async function POST(req: NextRequest) {
  // This route is reachable while the mustChangePassword gate is up, so it does
  // its own check rather than using requireSession — but it must still honour
  // revocation, so the token is resolved against the stored account.
  const payload = await resolveSession(
    await verifySession((await cookies()).get(SESSION_COOKIE)?.value)
  );
  if (!payload) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input." },
      { status: 400 }
    );
  }

  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user) return NextResponse.json({ error: "User not found." }, { status: 404 });

  // Require the current password unless the account has no password yet
  // (pure OIDC user setting one) — but still verify when one exists.
  if (user.passwordHash) {
    const ok = await verifyPassword(parsed.data.currentPassword ?? "", user.passwordHash);
    if (!ok) return NextResponse.json({ error: "Current password is incorrect." }, { status: 400 });
  }

  // Bumping tokenVersion signs every other session for this account out — a
  // password change should not leave a stolen cookie working.
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(parsed.data.newPassword),
      mustChangePassword: false,
      tokenVersion: { increment: 1 },
    },
  });

  // Refresh this session's cookie so it carries the new tokenVersion and the
  // cleared mustChangePassword flag (the middleware reads the latter to lift
  // the change-password gate).
  const token = await createSession(
    {
      id: updated.id,
      username: updated.username,
      role: updated.role,
      mustChangePassword: false,
      tokenVersion: updated.tokenVersion,
    },
    payload.method
  );
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return res;
}
