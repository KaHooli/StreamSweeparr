/**
 * Server-side auth guards for API route handlers (Node runtime).
 *
 * The middleware runs on the edge and can only check the cookie's signature —
 * it has no database. That is enough to turn anonymous traffic away, but it
 * cannot tell a valid signature from a session whose account has since been
 * deleted, demoted, or had its password changed.
 *
 * These guards are the authority. Every call re-reads the account and:
 *   - rejects tokens whose user no longer exists,
 *   - rejects tokens minted before the account's current `tokenVersion`
 *     (bumped on role change, password change, or explicit revocation),
 *   - returns the role as it is stored *now*, not as it was when the token was
 *     signed, so an admin demoted a second ago is a plain user immediately.
 */
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { prisma } from "./db";
import { SESSION_COOKIE, verifySession, type SessionPayload } from "./session";

export class AuthError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "AuthError";
  }
}

/**
 * Reconcile a signature-verified token against the stored account.
 *
 * Returns null when the session must no longer be honoured. Exported for tests;
 * route handlers should use `requireSession`.
 */
export async function resolveSession(
  payload: SessionPayload | null
): Promise<SessionPayload | null> {
  if (!payload) return null;

  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: {
      id: true,
      username: true,
      role: true,
      tokenVersion: true,
      mustChangePassword: true,
    },
  });
  // Account deleted since the token was issued.
  if (!user) return null;
  // Tokens predating the tokenVersion column carry no `ver`; treat them as 0,
  // so existing sessions survive the upgrade but a single bump still ends them.
  if ((payload.ver ?? 0) !== user.tokenVersion) return null;

  return {
    ...payload,
    username: user.username,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
  };
}

/** Return the current session or throw AuthError(401). */
export async function requireSession(): Promise<SessionPayload> {
  const token = await verifySession(cookies().get(SESSION_COOKIE)?.value);
  const payload = await resolveSession(token);
  if (!payload) throw new AuthError("Not authenticated.", 401);
  return payload;
}

/** Return the current session or throw AuthError(403) if not an admin. */
export async function requireAdmin(): Promise<SessionPayload> {
  const payload = await requireSession();
  if (payload.role !== "ADMIN") throw new AuthError("Administrator access required.", 403);
  return payload;
}

/** Convert an AuthError to a JSON response (or null if not an AuthError). */
export function toAuthResponse(e: unknown): NextResponse | null {
  if (e instanceof AuthError) {
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
  return null;
}

/**
 * Wrap a route handler, running an auth check first and translating AuthError
 * (and any thrown Error) into a JSON response.
 *
 *   export const POST = withGuard(requireAdmin, async (session, req) => {...});
 */
export function withGuard<Args extends unknown[]>(
  guard: () => Promise<SessionPayload>,
  handler: (session: SessionPayload, ...args: Args) => Promise<NextResponse> | NextResponse
) {
  return async (...args: Args): Promise<NextResponse> => {
    let session: SessionPayload;
    try {
      session = await guard();
    } catch (e) {
      const r = toAuthResponse(e);
      if (r) return r;
      throw e;
    }
    return handler(session, ...args);
  };
}
