import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { verifyPassword } from "@/lib/password";
import { ensureDefaultAdmin } from "@/lib/users";
import { createSession, SESSION_COOKIE, sessionCookieOptions } from "@/lib/session";

export const dynamic = "force-dynamic";

const schema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export async function POST(req: NextRequest) {
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Username and password are required." }, { status: 400 });
  }

  // Lazily seed the default admin so a fresh install can log in.
  await ensureDefaultAdmin();

  const { username, password } = parsed.data;
  const user = await prisma.user.findUnique({ where: { username } });

  // Uniform failure to avoid leaking which usernames exist.
  const ok = user ? await verifyPassword(password, user.passwordHash) : false;
  if (!user || !ok) {
    return NextResponse.json({ error: "Invalid username or password." }, { status: 401 });
  }

  const token = await createSession(
    { id: user.id, username: user.username, isAdmin: user.isAdmin },
    "local"
  );
  const res = NextResponse.json({
    ok: true,
    user: { id: user.id, username: user.username, isAdmin: user.isAdmin },
    mustChangePassword: user.mustChangePassword,
  });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return res;
}
