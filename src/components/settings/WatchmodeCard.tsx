"use client";

import { useState } from "react";
import { postJson, sendJson } from "@/lib/fetcher";
import type { CardProps } from "./types";

export function WatchmodeCard({ settings, onChange }: CardProps) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      // Validate first (uses provided key or existing saved one).
      const test = await postJson<{ ok: boolean; quota: number; quotaUsed: number; error?: string }>(
        "/api/watchmode/test",
        key ? { apiKey: key } : {}
      );
      if (key) await sendJson("PATCH", "/api/settings", { watchmodeApiKey: key });
      setMsg({
        kind: "ok",
        text: `Watchmode OK — quota ${test.quotaUsed}/${test.quota} used.`,
      });
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
        <h2 style={{ fontSize: 18 }}>Watchmode API</h2>
        <span className="count">{settings.watchmodeApiKeySet ? "configured" : "not set"}</span>
      </div>
      <div className="field">
        <label>API Key</label>
        <input
          className="input"
          type="password"
          placeholder={settings.watchmodeApiKeySet ? "•••••••• (saved) — enter to replace" : "Your Watchmode API key"}
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        <div className="hint">
          Get one at api.watchmode.com. Used to look up streaming availability by country.
        </div>
      </div>
      <button className="btn primary" onClick={save} disabled={busy}>
        {busy ? <span className="spin" /> : null} Test &amp; save
      </button>

      {settings.watchmodeApiKeySet && settings.watchmodePlan && (
        <div className="hint" style={{ marginTop: 12 }}>
          Detected plan:{" "}
          <strong style={{ color: settings.watchmodePlan === "paid" ? "var(--ok)" : "var(--text)" }}>
            {settings.watchmodePlan === "paid"
              ? "Paid (premium Changes API)"
              : settings.watchmodePlan === "free"
              ? "Free / Developer"
              : "Unknown"}
          </strong>
          {settings.watchmodePlan === "paid"
            ? " — change-detection is enabled, minimising API usage."
            : " — using a 7-day refresh cache to limit API usage. A paid plan enables change-detection for near-zero ongoing usage."}
        </div>
      )}

      {msg && <div className={`banner ${msg.kind === "ok" ? "ok" : "err"}`} style={{ marginTop: 12 }}>{msg.text}</div>}
    </div>
  );
}
