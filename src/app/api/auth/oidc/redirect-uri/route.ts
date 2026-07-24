import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, withGuard } from "@/lib/auth";
import { oidcRedirectUri } from "@/lib/request";

export const dynamic = "force-dynamic";

// Returns the exact redirect_uri the server will send to the OIDC provider,
// so the Settings UI shows the value that must be registered (accounts for
// PUBLIC_URL / OIDC_REDIRECT_URI / reverse-proxy headers).
export const GET = withGuard(requireAdmin, async (_session, req: NextRequest) => {
  return NextResponse.json({ redirectUri: oidcRedirectUri(req) });
});
