"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import useSWR from "swr";
import { fetcher, postJson } from "@/lib/fetcher";

export const dynamic = "force-dynamic";

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/";
  const urlError = params.get("error");

  const { data: session } = useSWR<{
    user: unknown;
    oidcEnabled: boolean;
    oidcButtonLabel: string;
    localLoginEnabled: boolean;
  }>("/api/auth/session", fetcher);
  const oidcEnabled = session?.oidcEnabled;
  const ssoLabel = session?.oidcButtonLabel || "Sign in with SSO";
  // Default to showing the form until we know otherwise, so a slow/failed
  // lookup can never leave the page with no way to sign in.
  const localLoginEnabled = session ? session.localLoginEnabled : true;

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(urlError);

  // If already authenticated, bounce to the target.
  useEffect(() => {
    if (session?.user) router.replace(next);
  }, [session, next, router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await postJson<{ mustChangePassword?: boolean }>("/api/auth/login", {
        username,
        password,
      });
      // Send straight to the forced password-change screen if required,
      // otherwise to the originally requested page.
      router.replace(res.mustChangePassword ? "/change-password" : next);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="login-card card">
        <div className="brand" style={{ justifyContent: "center", marginBottom: 6 }}>
          <span className="mark">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icons/favicon-48x48.png" alt="" width={30} height={30} />
        </span>
          <span>
            <span className="sweep">Stream</span>
            <span className="arr">Sweeparr</span>
          </span>
        </div>
        <p className="muted" style={{ textAlign: "center", marginTop: 0 }}>
          Sign in to continue
        </p>

        {error && <div className="banner err">{error}</div>}

        {localLoginEnabled && (
          <form onSubmit={submit}>
            <div className="field">
              <label>Username</label>
              <input
                className="input"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoFocus
                required
              />
            </div>
            <div className="field">
              <label>Password</label>
              <input
                className="input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </div>
            <button className="btn primary" type="submit" disabled={busy} style={{ width: "100%", justifyContent: "center" }}>
              {busy ? <span className="spin" /> : null} Sign in
            </button>
          </form>
        )}

        {oidcEnabled && (
          <>
            {localLoginEnabled && (
              <div className="or">
                <span>or</span>
              </div>
            )}
            <a
              className={`btn ${localLoginEnabled ? "" : "primary"}`}
              href="/api/auth/oidc/authorize"
              style={{ width: "100%", justifyContent: "center" }}
            >
              {ssoLabel}
            </a>
          </>
        )}
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="login-wrap" />}>
      <LoginInner />
    </Suspense>
  );
}
