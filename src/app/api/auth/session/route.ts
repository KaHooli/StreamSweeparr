import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySession } from "@/lib/session";
import { resolveSession } from "@/lib/auth";
import { getSettings } from "@/lib/db";
import {
  isOidcConfigured,
  effectiveLocalLoginEnabled,
  ssoButtonLabel,
} from "@/lib/loginOptions";

export const dynamic = "force-dynamic";

// Returns the current session (or null) plus which login methods are offered.
// The login page is public, so this must not require authentication.
export async function GET() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  // Resolved against the database, not just the cookie: the UI hides the
  // admin-only controls based on this, so it should agree with what the API
  // will actually allow rather than with a role frozen at sign-in.
  const payload = await resolveSession(await verifySession(token));
  const s = await getSettings();
  return NextResponse.json({
    user: payload
      ? {
          id: payload.sub,
          username: payload.username,
          role: payload.role,
          isAdmin: payload.role === "ADMIN",
          method: payload.method,
        }
      : null,
    oidcEnabled: isOidcConfigured(s),
    oidcButtonLabel: ssoButtonLabel(s.oidcButtonLabel),
    localLoginEnabled: effectiveLocalLoginEnabled(s),
  });
}
