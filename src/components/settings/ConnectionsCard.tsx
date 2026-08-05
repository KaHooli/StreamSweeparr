"use client";

import { useState } from "react";
import { postJson, sendJson } from "@/lib/fetcher";
import type { CardProps } from "./types";

export function ConnectionsCard({ settings, onChange }: CardProps) {
  const [type, setType] = useState("SONARR");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const add = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await postJson("/api/connections", { type, name, baseUrl, apiKey });
      setName("");
      setBaseUrl("");
      setApiKey("");
      setMsg({ kind: "ok", text: "Connection added & verified." });
      onChange();
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: number) => {
    await sendJson("DELETE", `/api/connections/${id}`);
    onChange();
  };
  const toggleEnabled = async (id: number, enabled: boolean) => {
    await sendJson("PATCH", `/api/connections/${id}`, { enabled });
    onChange();
  };

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="section-title" style={{ marginTop: 0 }}>
        <h2 style={{ fontSize: 18 }}>Sonarr / Radarr connections</h2>
        <span className="count">{settings.connections.length} configured</span>
      </div>

      <div className="conn-list" style={{ marginBottom: 18 }}>
        {settings.connections.length === 0 && <div className="muted">No connections yet.</div>}
        {settings.connections.map((c) => (
          <div className="conn" key={c.id}>
            <span className={`type ${c.type}`}>{c.type}</span>
            <div style={{ flex: 1 }}>
              <strong>{c.name}</strong>
              <div className="muted">{c.baseUrl} · {c.origin}</div>
            </div>
            <label className="switch" title={c.enabled ? "Enabled" : "Disabled"}>
              <input type="checkbox" checked={c.enabled} onChange={(e) => toggleEnabled(c.id, e.target.checked)} />
              <span className="slider" />
            </label>
            <button className="btn danger sm" onClick={() => remove(c.id)}>
              Remove
            </button>
          </div>
        ))}
      </div>

      <div className="group-head">Add manually</div>
      <div className="row">
        <div className="field">
          <label>Type</label>
          <select className="select" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="SONARR">Sonarr (TV)</option>
            <option value="RADARR">Radarr (Movies)</option>
          </select>
        </div>
        <div className="field">
          <label>Name</label>
          <input className="input" placeholder="Main Sonarr" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
      </div>
      <div className="row">
        <div className="field">
          <label>URL</label>
          <input className="input" placeholder="http://localhost:8989" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </div>
        <div className="field">
          <label>API Key</label>
          <input className="input" type="password" placeholder="API key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        </div>
      </div>
      <button className="btn primary" onClick={add} disabled={busy || !name || !baseUrl || !apiKey}>
        {busy ? <span className="spin" /> : null} Add &amp; test connection
      </button>
      {msg && <div className={`banner ${msg.kind === "ok" ? "ok" : "err"}`} style={{ marginTop: 12 }}>{msg.text}</div>}
    </div>
  );
}
