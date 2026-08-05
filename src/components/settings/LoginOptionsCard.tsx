"use client";

import { useState } from "react";
import { sendJson } from "@/lib/fetcher";
import type { CardProps } from "./types";

export function LoginOptionsCard({ settings, onChange }: CardProps) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const locked = settings.localLoginLock.locked;

  const set = async (v: boolean) => {
    setBusy(true);
    setMsg(null);
    try {
      await sendJson("PATCH", "/api/settings", { localLoginEnabled: v });
      onChange();
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="section-title" style={{ marginTop: 0 }}>
        <h2 style={{ fontSize: 18 }}>Login options</h2>
        <span className="count">
          {settings.localLoginEffective ? "password login on" : "SSO only"}
        </span>
      </div>

      <div className="toggle-line">
        <div className="txt">
          <strong>Allow username &amp; password login</strong>
          <span>
            When off, the login page only offers single sign-on. Requires OIDC to be enabled and
            configured.
          </span>
        </div>
        <label className="switch" title={settings.localLoginLock.reason ?? undefined}>
          <input
            type="checkbox"
            checked={settings.localLoginEffective}
            disabled={locked || busy}
            onChange={(e) => set(e.target.checked)}
          />
          <span className="slider" style={locked ? { opacity: 0.5, cursor: "not-allowed" } : undefined} />
        </label>
      </div>

      {settings.localLoginLock.reason && (
        <div className="hint" style={{ marginTop: 10 }}>{settings.localLoginLock.reason}</div>
      )}
      {!locked && (
        <div className="hint" style={{ marginTop: 10 }}>
          Careful: if single sign-on stops working while this is off you could be locked out. Set
          <code> LOCAL_LOGIN_DISABLED=false</code> in the environment to force the password form back
          on.
        </div>
      )}
      {msg && <div className={`banner err`} style={{ marginTop: 12 }}>{msg.text}</div>}
    </div>
  );
}
