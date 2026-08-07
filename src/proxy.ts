import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/session";

/**
 * Auth gate. Every route requires a valid session cookie except the login page
 * and the auth endpoints. Uses the edge-safe HMAC session verification.
 *
 * - Unauthenticated page requests -> redirect to /login?next=<path>.
 * - Unauthenticated API requests  -> 401 JSON.
 *
 * This runs on the edge runtime and can only check the cookie's signature. It
 * turns anonymous traffic away; `lib/auth` is what decides whether a signed
 * cookie still carries any authority (see resolveSession).
 *
 * Named `proxy` in a `proxy.ts` file: Next 16 renamed the middleware file
 * convention, and the old name is deprecated.
 */
/**
 * The static files that make the app installable, plus the offline fallback.
 *
 * These have to be readable without a session. The browser fetches the manifest
 * without credentials unless the link carries `crossorigin="use-credentials"`,
 * which the Next metadata API does not emit — so a gated manifest is answered
 * with a redirect to `/login`, fails to parse, and the install prompt never
 * appears, signed in or not. The icons and the offline page are needed on the
 * login screen itself, before any session exists.
 *
 * Nothing here is account data: they are the same bytes for every visitor, and
 * the login page already tells an anonymous caller what this app is.
 */
function isPwaAsset(pathname: string): boolean {
  return (
    pathname === "/manifest.webmanifest" ||
    pathname === "/sw.js" ||
    pathname === "/offline.html" ||
    pathname.startsWith("/icons/")
  );
}

export async function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  const isPublic =
    pathname === "/login" ||
    pathname.startsWith("/api/auth/") || // login, logout, oidc, session
    pathname === "/api/health" || // container probe; exposes no data
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico" ||
    isPwaAsset(pathname);

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
