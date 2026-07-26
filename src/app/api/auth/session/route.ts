import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySession } from "@/lib/session";
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
  const token = cookies().get(SESSION_COOKIE)?.value;
  const payload = await verifySession(token);
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
