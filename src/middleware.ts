import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/session";

/**
 * Auth gate. Every route requires a valid session cookie except the login page
 * and the auth endpoints. Uses the edge-safe HMAC session verification.
 *
 * - Unauthenticated page requests -> redirect to /login?next=<path>.
 * - Unauthenticated API requests  -> 401 JSON.
 */
export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  const isPublic =
    pathname === "/login" ||
    pathname.startsWith("/api/auth/") || // login, logout, oidc, session
    pathname === "/api/health" || // container probe; exposes no data
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico";

  if (isPublic) return NextResponse.next();

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySession(token);

  if (!session) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }

  // Enforce a mandatory password change (e.g. the seeded default admin).
  // Until it is done, only the change-password flow, logout, and session
  // lookup are reachable.
  if (session.mustChangePassword) {
    const allowedWhilePwChange =
      pathname === "/change-password" ||
      pathname === "/api/auth/change-password" ||
      pathname === "/api/auth/logout" ||
      pathname === "/api/auth/session";
    if (!allowedWhilePwChange) {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json(
          { error: "Password change required before continuing." },
          { status: 403 }
        );
      }
      const url = req.nextUrl.clone();
      url.pathname = "/change-password";
      url.search = "";
      return NextResponse.redirect(url);
    }
  }

  return NextResponse.next();
}

export const config = {
  // Run on everything except Next internals & static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
