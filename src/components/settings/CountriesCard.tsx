"use client";

import { useState, useEffect } from "react";
import useSWR from "swr";
import { fetcher, sendJson } from "@/lib/fetcher";
import type { CardProps, Region } from "./types";

export function CountriesCard({ settings, onChange }: CardProps) {
  const { data, error } = useSWR<{ regions: Region[] }>(
    settings.watchmodeApiKeySet ? "/api/watchmode/regions" : null,
    fetcher
  );
  const [selected, setSelected] = useState<string[]>(settings.countries);
  const [saving, setSaving] = useState(false);

  useEffect(() => setSelected(settings.countries), [settings.countries]);

  const toggle = (code: string) =>
    setSelected((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));

  const save = async () => {
    setSaving(true);
    await sendJson("PATCH", "/api/settings", { countries: selected });
    setSaving(false);
    onChange();
  };

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="section-title" style={{ marginTop: 0 }}>
        <h2 style={{ fontSize: 18 }}>Countries (TV)</h2>
        <span className="count">{selected.length} selected</span>
      </div>
      {!settings.watchmodeApiKeySet && <div className="muted">Add a Watchmode API key first.</div>}
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
            {saving ? <span className="spin" /> : null} Save countries
          </button>
        </>
      )}
    </div>
  );
}
