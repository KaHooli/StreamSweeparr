import { NextRequest, NextResponse } from "next/server";
import {
  getOidcConfig,
  exchangeCode,
  fetchClaims,
  usernameFromClaims,
  isUserAllowed,
} from "@/lib/oidc";
import { upsertOidcUser } from "@/lib/users";
import { createSession, SESSION_COOKIE, sessionCookieOptions } from "@/lib/session";
import { oidcRedirectUri, publicOrigin } from "@/lib/request";

export const dynamic = "force-dynamic";

const STATE_COOKIE = "ss_oidc_state";
const VERIFIER_COOKIE = "ss_oidc_verifier";

function fail(req: NextRequest, message: string) {
  const res = NextResponse.redirect(
    new URL(`/login?error=${encodeURIComponent(message)}`, publicOrigin(req))
  );
  res.cookies.set(STATE_COOKIE, "", { path: "/", maxAge: 0 });
  res.cookies.set(VERIFIER_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}

// Complete the OIDC flow: validate state, exchange code, provision user, sign in.
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const err = params.get("error");
  if (err) return fail(req, params.get("error_description") || err);

  const code = params.get("code");
  const state = params.get("state");
  const savedState = req.cookies.get(STATE_COOKIE)?.value;
  const verifier = req.cookies.get(VERIFIER_COOKIE)?.value;

  if (!code || !state) return fail(req, "Missing authorization code.");
  if (!savedState || state !== savedState) return fail(req, "Invalid state (possible CSRF).");
  if (!verifier) return fail(req, "Missing PKCE verifier; restart the login.");

  const cfg = await getOidcConfig();
  if (!cfg) return fail(req, "OIDC is not configured.");

  try {
    // Must match the redirect_uri sent in the authorize step exactly.
    const redirectUri = oidcRedirectUri(req);
    const tokens = await exchangeCode(cfg, code, redirectUri, verifier);
    const claims = await fetchClaims(cfg, tokens);

    if (!isUserAllowed(cfg, claims)) {
      return fail(req, "Your account is not permitted to sign in.");
    }

    const user = await upsertOidcUser({
      subject: claims.sub,
      username: usernameFromClaims(claims),
    });

    const token = await createSession(
      {
        id: user.id,
        username: user.username,
        role: user.role,
        tokenVersion: user.tokenVersion,
      },
      "oidc"
    );
    const res = NextResponse.redirect(new URL("/", publicOrigin(req)));
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
    // Clear transient OIDC cookies.
    res.cookies.set(STATE_COOKIE, "", { path: "/", maxAge: 0 });
    res.cookies.set(VERIFIER_COOKIE, "", { path: "/", maxAge: 0 });
    return res;
  } catch (e) {
    return fail(req, (e as Error).message);
  }
}
