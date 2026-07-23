import { NextRequest, NextResponse } from "next/server";
import { getOidcConfig, generatePkce, buildAuthUrl } from "@/lib/oidc";
import { cookieSecure } from "@/lib/session";

export const dynamic = "force-dynamic";

const STATE_COOKIE = "ss_oidc_state";
const VERIFIER_COOKIE = "ss_oidc_verifier";

function redirectUri(req: NextRequest): string {
  const origin = req.nextUrl.origin;
  return `${origin}/api/auth/oidc/callback`;
}

// Begin the OIDC Authorization Code + PKCE flow.
export async function GET(req: NextRequest) {
  const cfg = await getOidcConfig();
  if (!cfg) {
    return NextResponse.redirect(new URL("/login?error=oidc_disabled", req.nextUrl.origin));
  }

  try {
    const { state, verifier, challenge } = generatePkce();
    const url = buildAuthUrl(cfg, redirectUri(req), state, challenge);
    const res = NextResponse.redirect(url);
    const opts = {
      httpOnly: true,
      sameSite: "lax" as const,
      secure: cookieSecure(),
      path: "/",
      maxAge: 600, // 10 minutes to complete the flow
    };
    res.cookies.set(STATE_COOKIE, state, opts);
    res.cookies.set(VERIFIER_COOKIE, verifier, opts);
    return res;
  } catch (e) {
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent((e as Error).message)}`, req.nextUrl.origin)
    );
  }
}
