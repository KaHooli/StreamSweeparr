import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { verifyPassword, hashPassword } from "@/lib/password";
import { SESSION_COOKIE, verifySession, createSession, sessionCookieOptions } from "@/lib/session";

export const dynamic = "force-dynamic";

const schema = z.object({
  currentPassword: z.string().optional(),
  newPassword: z.string().min(8, "New password must be at least 8 characters."),
});

export async function POST(req: NextRequest) {
  const payload = await verifySession(cookies().get(SESSION_COOKIE)?.value);
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

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(parsed.data.newPassword),
      mustChangePassword: false,
    },
  });

  // Refresh the session cookie so mustChangePassword is cleared in the token
  // (the middleware reads this to lift the change-password gate).
  const token = await createSession(
    { id: user.id, username: user.username, role: user.role, mustChangePassword: false },
    payload.method
  );
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return res;
}
