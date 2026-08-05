"use client";

import { useState } from "react";
import { useSyncedState } from "@/lib/useSyncedState";
import useSWR from "swr";
import { fetcher, sendJson } from "@/lib/fetcher";
import type { CardProps, Region } from "./types";

export function TmdbRegionsCard({ settings, onChange }: CardProps) {
  const { data, error } = useSWR<{ regions: Region[] }>(
    settings.tmdbApiKeySet ? "/api/tmdb/regions" : null,
    fetcher
  );
  const [selected, setSelected] = useSyncedState<string[]>(settings.tmdbRegions);
  const [saving, setSaving] = useState(false);

  const toggle = (code: string) =>
    setSelected((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));

  const save = async () => {
    setSaving(true);
    await sendJson("PATCH", "/api/settings", { tmdbRegions: selected });
    setSaving(false);
    onChange();
  };

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="section-title" style={{ marginTop: 0 }}>
        <h2 style={{ fontSize: 18 }}>Watch provider regions (Movies)</h2>
        <span className="count">{selected.length} selected</span>
      </div>
      {!settings.tmdbApiKeySet && <div className="muted">Add a TMDB API key first.</div>}
      {error && <div className="banner err">{(error as Error).message}</div>}
      {data && (
        <>
          <div className="pills">
            {data.regions.map((r) => (
              <div
                key={r.code}
                className={`pill ${selected.includes(r.code) ? "selected" : ""}`}
                onClick={() => toggle(r.code)}
                role="checkbox"
                aria-checked={selected.includes(r.code)}
              >
                <span className="flag">{r.flag}</span>
                <span>{r.name}</span>
              </div>
            ))}
          </div>
          <button className="btn primary" style={{ marginTop: 14 }} onClick={save} disabled={saving}>
            {saving ? <span className="spin" /> : null} Save regions
          </button>
        </>
      )}
    </div>
  );
}
