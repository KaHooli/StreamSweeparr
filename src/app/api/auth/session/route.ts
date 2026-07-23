import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySession } from "@/lib/session";
import { getSettings } from "@/lib/db";
import { isOidcEnabled } from "@/lib/oidc";

export const dynamic = "force-dynamic";

// Returns the current session (or null) and whether OIDC is available.
export async function GET() {
  const token = cookies().get(SESSION_COOKIE)?.value;
  const payload = await verifySession(token);
  const s = await getSettings();
  return NextResponse.json({
    user: payload
      ? { id: payload.sub, username: payload.username, isAdmin: payload.isAdmin, method: payload.method }
      : null,
    oidcEnabled: isOidcEnabled(s),
  });
}
