"use client";

import { useState } from "react";
import useSWR from "swr";
import { fetcher, sendJson } from "@/lib/fetcher";

interface UserRow {
  id: number;
  username: string;
  role: "ADMIN" | "USER";
  provider: "oidc" | "local";
  isLocalAccount: boolean;
  createdAt: string;
  isSelf: boolean;
}
export function UsersCard() {
  const { data, error, mutate } = useSWR<{ users: UserRow[] }>("/api/users", fetcher);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const setRole = async (u: UserRow, role: "ADMIN" | "USER") => {
    setBusyId(u.id);
    setMsg(null);
    try {
      await sendJson("PATCH", `/api/users/${u.id}`, { role });
      setMsg({ kind: "ok", text: `${u.username} is now ${role.toLowerCase()}.` });
      mutate();
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (u: UserRow) => {
    setBusyId(u.id);
    setMsg(null);
    try {
      await sendJson("DELETE", `/api/users/${u.id}`);
      setMsg({ kind: "ok", text: `Removed ${u.username}.` });
      mutate();
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusyId(null);
    }
  };

  const users = data?.users ?? [];

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="section-title" style={{ marginTop: 0 }}>
        <h2 style={{ fontSize: 18 }}>Users</h2>
        <span className="count">{users.length} account(s)</span>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Accounts created by single sign-on start as <strong>user</strong>. Promote them to
        <strong> admin</strong> to let them change settings and run sweeps.
      </p>

      {error && <div className="banner err">{(error as Error).message}</div>}
      {!data && !error && <div className="muted">Loading…</div>}

      <div className="conn-list">
        {users.map((u) => (
          <div className="conn" key={u.id}>
            <span className={`type ${u.provider === "oidc" ? "SONARR" : "RADARR"}`}>
              {u.provider === "oidc" ? "SSO" : "LOCAL"}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <strong>
                {u.username}
                {u.isSelf && <span className="chip" style={{ marginLeft: 8 }}>you</span>}
              </strong>
              <div className="muted">
                {u.isLocalAccount
                  ? "Username & password account (always admin)"
                  : `Added ${new Date(u.createdAt).toLocaleDateString()}`}
              </div>
            </div>
            <select
              className="select"
              style={{ width: "auto", flex: "0 0 auto" }}
              value={u.role}
              disabled={busyId === u.id || u.isLocalAccount}
              onChange={(e) => setRole(u, e.target.value as "ADMIN" | "USER")}
              title={u.isLocalAccount ? "The password account must stay an administrator." : "Change role"}
            >
              <option value="ADMIN">admin</option>
              <option value="USER">user</option>
            </select>
            {!u.isLocalAccount && !u.isSelf && (
              <button className="btn danger sm" onClick={() => remove(u)} disabled={busyId === u.id}>
                Remove
              </button>
            )}
          </div>
        ))}
      </div>

      {msg && <div className={`banner ${msg.kind === "ok" ? "ok" : "err"}`} style={{ marginTop: 12 }}>{msg.text}</div>}
    </div>
  );
}
