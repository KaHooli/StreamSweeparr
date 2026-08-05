"use client";

import { useState, useEffect } from "react";
import { postJson, sendJson } from "@/lib/fetcher";
import type { CardProps } from "./types";

export function SeerrCard({ settings, onChange }: CardProps) {
  const [url, setUrl] = useState(settings.seerrUrl);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<null | "save" | "discover">(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => setUrl(settings.seerrUrl), [settings.seerrUrl]);

  const save = async () => {
    setBusy("save");
    setMsg(null);
    try {
      await sendJson("PATCH", "/api/settings", {
        seerrUrl: url,
        ...(apiKey ? { seerrApiKey: apiKey } : {}),
      });
      setApiKey("");
      setMsg({ kind: "ok", text: "Saved Seerr connection." });
      onChange();
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const discover = async () => {
    setBusy("discover");
    setMsg(null);
    try {
      const r = await postJson<{ discovered: number }>("/api/connections/discover");
      setMsg({ kind: "ok", text: `Discovered ${r.discovered} instance(s) from Seerr.` });
      onChange();
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="section-title" style={{ marginTop: 0 }}>
        <h2 style={{ fontSize: 18 }}>Seerr (optional)</h2>
        <span className="count">{settings.seerrApiKeySet ? "configured" : "not set"}</span>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Point at your Seerr server to auto-discover its Sonarr/Radarr instances. You can also add
        instances manually below.
      </p>
      <div className="row">
        <div className="field">
          <label>Seerr URL</label>
          <input className="input" placeholder="https://seerr.example.com" value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>
        <div className="field">
          <label>Seerr API Key</label>
          <input
            className="input"
            type="password"
            placeholder={settings.seerrApiKeySet ? "•••••••• (saved)" : "API key"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </div>
      </div>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <button className="btn" style={{ flex: "0 0 auto" }} onClick={save} disabled={!!busy}>
          {busy === "save" ? <span className="spin" /> : null} Save
        </button>
        <button className="btn primary" style={{ flex: "0 0 auto" }} onClick={discover} disabled={!!busy || !settings.seerrApiKeySet}>
          {busy === "discover" ? <span className="spin" /> : null} Discover instances
        </button>
      </div>
      {msg && <div className={`banner ${msg.kind === "ok" ? "ok" : "err"}`} style={{ marginTop: 12 }}>{msg.text}</div>}
    </div>
  );
}
