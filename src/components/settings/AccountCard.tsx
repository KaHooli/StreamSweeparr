"use client";

import { useState } from "react";
import { useSyncedState } from "@/lib/useSyncedState";
import useSWR from "swr";
import { fetcher, postJson, sendJson } from "@/lib/fetcher";

interface SessionDto {
  user: { id: number; username: string; role: "ADMIN" | "USER"; method: string } | null;
}
export function AccountCard() {
  const { data: session, mutate: refreshSession } = useSWR<SessionDto>(
    "/api/auth/session",
    fetcher
  );
  // Follows the session once SWR resolves it, and again if it changes.
  const [username, setUsername] = useSyncedState(session?.user?.username ?? "");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState<null | "name" | "pw">(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const saveUsername = async () => {
    setBusy("name");
    setMsg(null);
    try {
      await sendJson("PATCH", "/api/auth/account", { username });
      setMsg({ kind: "ok", text: "Username updated." });
      refreshSession();
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const savePassword = async () => {
    if (next !== confirm) {
      setMsg({ kind: "err", text: "New passwords do not match." });
      return;
    }
    setBusy("pw");
    setMsg(null);
    try {
      await postJson("/api/auth/change-password", { currentPassword: current, newPassword: next });
      setCurrent("");
      setNext("");
      setConfirm("");
      setMsg({ kind: "ok", text: "Password updated." });
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const isOidcSession = session?.user?.method === "oidc";

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="section-title" style={{ marginTop: 0 }}>
        <h2 style={{ fontSize: 18 }}>Your account</h2>
        <span className="count">
          {session?.user ? `${session.user.username} · ${session.user.role.toLowerCase()}` : ""}
        </span>
      </div>

      <div className="group-head">Username</div>
      <div className="row">
        <div className="field">
          <label>Username</label>
          <input
            className="input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
          />
          <div className="hint">
            Letters, numbers and . _ @ - (min 3 characters). You can rename the default{" "}
            <code>admin</code> account here.
          </div>
        </div>
      </div>
      <button
        className="btn"
        onClick={saveUsername}
        disabled={!!busy || !username || username === session?.user?.username}
      >
        {busy === "name" ? <span className="spin" /> : null} Save username
      </button>

      <div className="group-head">Password</div>
      {isOidcSession ? (
        <p className="muted" style={{ marginTop: 0 }}>
          You signed in with single sign-on, so there is no password to change here.
        </p>
      ) : (
        <>
          <div className="row">
            <div className="field">
              <label>Current password</label>
              <input className="input" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
            </div>
          </div>
          <div className="row">
            <div className="field">
              <label>New password</label>
              <input className="input" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
              <div className="hint">At least 8 characters.</div>
            </div>
            <div className="field">
              <label>Confirm new password</label>
              <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
            </div>
          </div>
          <button className="btn primary" onClick={savePassword} disabled={!!busy || !next}>
            {busy === "pw" ? <span className="spin" /> : null} Update password
          </button>
        </>
      )}

      {msg && <div className={`banner ${msg.kind === "ok" ? "ok" : "err"}`} style={{ marginTop: 12 }}>{msg.text}</div>}
    </div>
  );
}
