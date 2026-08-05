"use client";

import { useState } from "react";
import { postJson, sendJson } from "@/lib/fetcher";
import type { CardProps } from "./types";

export function TmdbCard({ settings, onChange }: CardProps) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await postJson<{ ok: boolean; error?: string }>(
        "/api/tmdb/test",
        key ? { apiKey: key } : {}
      );
      if (key) await sendJson("PATCH", "/api/settings", { tmdbApiKey: key });
      setMsg({ kind: "ok", text: "TMDB key is valid and saved." });
      setKey("");
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
        <h2 style={{ fontSize: 18 }}>TheMovieDB API</h2>
        <span className="count">{settings.tmdbApiKeySet ? "configured" : "not set"}</span>
      </div>
      <div className="field">
        <label>API Key (v3)</label>
        <input
          className="input"
          type="password"
          placeholder={settings.tmdbApiKeySet ? "•••••••• (saved) — enter to replace" : "Your TMDB API key"}
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        <div className="hint">
          Create one for free at themoviedb.org → Settings → API. Used for movie streaming
          availability (JustWatch data).
        </div>
      </div>
      <button className="btn primary" onClick={save} disabled={busy}>
        {busy ? <span className="spin" /> : null} Test &amp; save
      </button>
      {msg && <div className={`banner ${msg.kind === "ok" ? "ok" : "err"}`} style={{ marginTop: 12 }}>{msg.text}</div>}
    </div>
  );
}
