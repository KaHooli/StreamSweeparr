import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma, getSettings } from "@/lib/db";
import { verifyPassword } from "@/lib/password";
import { ensureDefaultAdmin } from "@/lib/users";
import { effectiveLocalLoginEnabled } from "@/lib/loginOptions";
import { createSession, SESSION_COOKIE, sessionCookieOptions } from "@/lib/session";
import { checkRateLimit, registerFailure, resetRateLimit } from "@/lib/ratelimit";
import { clientIp } from "@/lib/request";

export const dynamic = "force-dynamic";

const schema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

function tooMany(retryAfter: number) {
  return NextResponse.json(
    { error: `Too many attempts. Try again in ${retryAfter}s.` },
    { status: 429, headers: { "Retry-After": String(retryAfter) } }
  );
}

export async function POST(req: NextRequest) {
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Username and password are required." }, { status: 400 });
  }

  const { username, password } = parsed.data;

  // Refuse password logins when the administrator has turned them off (only
  // possible while OIDC is usable). Enforced here, not just hidden in the UI.
  const settings = await getSettings();
  if (!effectiveLocalLoginEnabled(settings)) {
    return NextResponse.json(
      { error: "Username & password login is disabled. Use single sign-on." },
      { status: 403 }
    );
  }

  // Rate-limit per IP and per IP+username to blunt brute force.
  const ip = clientIp(req);
  const ipKey = `login:ip:${ip}`;
  const userKey = `login:user:${ip}:${username.toLowerCase()}`;
  for (const key of [ipKey, userKey]) {
    const rl = checkRateLimit(key);
    if (!rl.allowed) return tooMany(rl.retryAfterSeconds);
  }

  // Lazily seed the default admin so a fresh install can log in.
  await ensureDefaultAdmin();

  const user = await prisma.user.findUnique({ where: { username } });

  // Uniform failure to avoid leaking which usernames exist.
  const ok = user ? await verifyPassword(password, user.passwordHash) : false;
  if (!user || !ok) {
    let last = { allowed: true, retryAfterSeconds: 0 };
    registerFailure(ipKey);
    last = registerFailure(userKey);
    if (!last.allowed) return tooMany(last.retryAfterSeconds);
    return NextResponse.json({ error: "Invalid username or password." }, { status: 401 });
  }

  // Success — clear the counters.
  resetRateLimit(ipKey);
  resetRateLimit(userKey);

  const token = await createSession(
    {
      id: user.id,
      username: user.username,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
    },
    "local"
  );
  const res = NextResponse.json({
    ok: true,
    user: { id: user.id, username: user.username, role: user.role },
    mustChangePassword: user.mustChangePassword,
  });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return res;
}
