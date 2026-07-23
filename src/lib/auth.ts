/**
 * Server-side auth guards for API route handlers (Node runtime).
 *
 * The middleware already blocks unauthenticated requests, but routes that
 * mutate configuration or trigger destructive actions must additionally verify
 * the session server-side (defence in depth) and require admin.
 */
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE, verifySession, type SessionPayload } from "./session";

export class AuthError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "AuthError";
  }
}

/** Return the current session or throw AuthError(401). */
export async function requireSession(): Promise<SessionPayload> {
  const payload = await verifySession(cookies().get(SESSION_COOKIE)?.value);
  if (!payload) throw new AuthError("Not authenticated.", 401);
  return payload;
}

/** Return the current session or throw AuthError(403) if not an admin. */
export async function requireAdmin(): Promise<SessionPayload> {
  const payload = await requireSession();
  if (!payload.isAdmin) throw new AuthError("Administrator access required.", 403);
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
