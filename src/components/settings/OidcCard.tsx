"use client";

import { useState } from "react";
import { useSyncedState } from "@/lib/useSyncedState";
import useSWR from "swr";
import { fetcher, sendJson } from "@/lib/fetcher";
import type { CardProps } from "./types";

export function OidcCard({ settings, onChange }: CardProps) {
  const [enabled, setEnabled] = useSyncedState(settings.oidcEnabled);
  const [issuer, setIssuer] = useSyncedState(settings.oidcIssuer);
  const [clientId, setClientId] = useSyncedState(settings.oidcClientId);
  const [clientSecret, setClientSecret] = useState("");
  const [buttonLabel, setButtonLabel] = useSyncedState(settings.oidcButtonLabel);
  const [scopes, setScopes] = useSyncedState(settings.oidcScopes);
  const [authUrl, setAuthUrl] = useSyncedState(settings.oidcAuthUrl);
  const [tokenUrl, setTokenUrl] = useSyncedState(settings.oidcTokenUrl);
  const [userinfoUrl, setUserinfoUrl] = useSyncedState(settings.oidcUserinfoUrl);
  const [allowed, setAllowed] = useSyncedState(settings.oidcAllowedUsers.join(", "));
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await sendJson("PATCH", "/api/settings", {
        oidcEnabled: enabled,
        oidcIssuer: issuer,
        oidcClientId: clientId,
        ...(clientSecret ? { oidcClientSecret: clientSecret } : {}),
        oidcButtonLabel: buttonLabel,
        oidcScopes: scopes,
        oidcAuthUrl: authUrl,
        oidcTokenUrl: tokenUrl,
        oidcUserinfoUrl: userinfoUrl,
        oidcAllowedUsers: allowed
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
      });
      setClientSecret("");
      setMsg({ kind: "ok", text: "OIDC settings saved." });
      onChange();
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  // Authoritative redirect URI as the server will actually send it (accounts
  // for PUBLIC_URL / OIDC_REDIRECT_URI / reverse-proxy headers). Fall back to
  // the browser origin while loading.
  const { data: redirectData } = useSWR<{ redirectUri: string }>(
    "/api/auth/oidc/redirect-uri",
    fetcher
  );
  const redirectUri =
    redirectData?.redirectUri ||
    (typeof window !== "undefined" ? `${window.location.origin}/api/auth/oidc/callback` : "");

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="section-title" style={{ marginTop: 0 }}>
        <h2 style={{ fontSize: 18 }}>Single sign-on (OIDC)</h2>
        <span className="count">{settings.oidcEnabled ? "enabled" : "disabled"}</span>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Optional. When enabled and configured, a <strong>Sign in with SSO</strong> button appears on
        the login page. Endpoints are auto-discovered from the issuer&apos;s{" "}
        <code>/.well-known/openid-configuration</code>.
      </p>
      <p className="muted" style={{ marginTop: 0 }}>
        Register the <strong>exact</strong> Redirect URI below with your provider. If StreamSweeparr
        runs behind a reverse proxy, set the <code>PUBLIC_URL</code> environment variable to your
        public URL so this matches.
      </p>

      <div className="toggle-line" style={{ borderTop: "1px solid var(--border)" }}>
        <div className="txt">
          <strong>Enable OIDC</strong>
          <span>Show the SSO button and accept OIDC logins.</span>
        </div>
        <label className="switch">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span className="slider" />
        </label>
      </div>

      <div className="field" style={{ marginTop: 16 }}>
        <label>Redirect URI (register this with your provider)</label>
        <input className="input" readOnly value={redirectUri} onFocus={(e) => e.currentTarget.select()} />
      </div>

      <div className="field">
        <label>Issuer URL</label>
        <input className="input" placeholder="https://auth.example.com/realms/main" value={issuer} onChange={(e) => setIssuer(e.target.value)} />
      </div>
      <div className="row">
        <div className="field">
          <label>Client ID</label>
          <input className="input" value={clientId} onChange={(e) => setClientId(e.target.value)} />
        </div>
        <div className="field">
          <label>Client Secret</label>
          <input
            className="input"
            type="password"
            placeholder={settings.oidcClientSecretSet ? "•••••••• (saved)" : "Client secret"}
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
          />
        </div>
      </div>
      <div className="field">
        <label>Sign-in button label</label>
        <input
          className="input"
          value={buttonLabel}
          maxLength={64}
          placeholder={settings.oidcButtonLabelDefault}
          onChange={(e) => setButtonLabel(e.target.value)}
        />
        <div className="hint">
          Text shown on the login page button, e.g. &quot;Sign in with Authentik&quot;. Leave empty
          for the default (&quot;{settings.oidcButtonLabelDefault}&quot;).
        </div>
      </div>
      <div className="field">
        <label>Scopes</label>
        <input className="input" value={scopes} onChange={(e) => setScopes(e.target.value)} />
        <div className="hint">Space-separated. Default: openid profile email</div>
      </div>
      <div className="field">
        <label>Allowed users (optional)</label>
        <input
          className="input"
          placeholder="alice@example.com, bob"
          value={allowed}
          onChange={(e) => setAllowed(e.target.value)}
        />
        <div className="hint">
          Comma-separated emails / usernames. Leave empty to allow any authenticated OIDC user.
        </div>
      </div>

      <button className="btn ghost sm" onClick={() => setShowAdvanced((v) => !v)} type="button">
        {showAdvanced ? "Hide" : "Show"} endpoint overrides
      </button>
      {showAdvanced && (
        <div style={{ marginTop: 12 }}>
          <div className="field">
            <label>Authorization endpoint</label>
            <input className="input" value={authUrl} onChange={(e) => setAuthUrl(e.target.value)} placeholder="(auto-discovered)" />
          </div>
          <div className="field">
            <label>Token endpoint</label>
            <input className="input" value={tokenUrl} onChange={(e) => setTokenUrl(e.target.value)} placeholder="(auto-discovered)" />
          </div>
          <div className="field">
            <label>Userinfo endpoint</label>
            <input className="input" value={userinfoUrl} onChange={(e) => setUserinfoUrl(e.target.value)} placeholder="(auto-discovered)" />
          </div>
        </div>
      )}

      <div style={{ marginTop: 6 }}>
        <button className="btn primary" onClick={save} disabled={busy}>
          {busy ? <span className="spin" /> : null} Save OIDC settings
        </button>
      </div>
      {msg && <div className={`banner ${msg.kind === "ok" ? "ok" : "err"}`} style={{ marginTop: 12 }}>{msg.text}</div>}
    </div>
  );
}
