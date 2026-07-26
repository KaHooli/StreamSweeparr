import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireSession, withGuard } from "@/lib/auth";
import { createSession, SESSION_COOKIE, sessionCookieOptions } from "@/lib/session";

export const dynamic = "force-dynamic";

const schema = z.object({
  username: z
    .string()
    .trim()
    .min(3, "Username must be at least 3 characters.")
    .max(64, "Username must be at most 64 characters.")
    .regex(/^[A-Za-z0-9._@-]+$/, "Use letters, numbers and . _ @ - only."),
});

// Change the signed-in user's own username.
export const PATCH = withGuard(requireSession, async (session, req: NextRequest) => {
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid username." },
      { status: 400 }
    );
  }
  const { username } = parsed.data;

  const me = await prisma.user.findUnique({ where: { id: session.sub } });
  if (!me) return NextResponse.json({ error: "User not found." }, { status: 404 });

  if (username !== me.username) {
    const taken = await prisma.user.findUnique({ where: { username } });
    if (taken) return NextResponse.json({ error: "That username is taken." }, { status: 409 });
  }

  const updated = await prisma.user.update({
    where: { id: me.id },
    data: { username },
  });

  // The username is part of the signed session, so re-issue the cookie.
  const token = await createSession(
    {
      id: updated.id,
      username: updated.username,
      role: updated.role,
      mustChangePassword: updated.mustChangePassword,
    },
    session.method
  );
  const res = NextResponse.json({ ok: true, username: updated.username });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return res;
});
