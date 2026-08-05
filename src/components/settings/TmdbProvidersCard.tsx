"use client";

import { useState, useEffect } from "react";
import useSWR from "swr";
import { fetcher, sendJson } from "@/lib/fetcher";
import type { CardProps } from "./types";
import { TMDB_TYPE_LABELS } from "./types";

interface TmdbProviderGroup {
  region: string;
  services: { id: number; name: string; logo: string | null }[];
}
export function TmdbProvidersCard({ settings, onChange }: CardProps) {
  const key =
    settings.tmdbApiKeySet && settings.tmdbRegions.length
      ? `/api/tmdb/providers?regions=${settings.tmdbRegions.join(",")}`
      : null;
  const { data, error } = useSWR<{ groups: TmdbProviderGroup[] }>(key, fetcher);
  const [selected, setSelected] = useState<number[]>(settings.tmdbProviderIds);
  const [types, setTypes] = useState<string[]>(settings.tmdbCountedTypes);
  const [saving, setSaving] = useState(false);

  useEffect(() => setSelected(settings.tmdbProviderIds), [settings.tmdbProviderIds]);
  useEffect(() => setTypes(settings.tmdbCountedTypes), [settings.tmdbCountedTypes]);

  const toggle = (id: number) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const toggleType = (t: string) =>
    setTypes((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));

  const save = async () => {
    setSaving(true);
    await sendJson("PATCH", "/api/settings", {
      tmdbProviderIds: selected,
      tmdbCountedTypes: types,
    });
    setSaving(false);
    onChange();
  };

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="section-title" style={{ marginTop: 0 }}>
        <h2 style={{ fontSize: 18 }}>Movie providers</h2>
        <span className="count">{selected.length} selected</span>
      </div>
      {!settings.tmdbRegions.length && <div className="muted">Select at least one region first.</div>}
      {error && <div className="banner err">{(error as Error).message}</div>}

      <div className="field">
        <label>Count a movie as &quot;on streaming&quot; when available via:</label>
        <div className="chips">
          {Object.entries(TMDB_TYPE_LABELS).map(([t, label]) => (
            <span
              key={t}
              className="chip"
              style={{
                cursor: "pointer",
                borderColor: types.includes(t) ? "var(--accent)" : undefined,
                color: types.includes(t) ? "var(--accent)" : undefined,
              }}
              onClick={() => toggleType(t)}
            >
              {types.includes(t) ? "✓ " : ""}
              {label}
            </span>
          ))}
        </div>
      </div>

      {data &&
        data.groups.map((g) => (
          <div key={g.region}>
            <div className="group-head">Available in {g.region}</div>
            <div className="pills">
              {g.services.map((s) => (
                <div
                  key={s.id}
                  className={`pill ${selected.includes(s.id) ? "selected" : ""}`}
                  onClick={() => toggle(s.id)}
                  role="checkbox"
                  aria-checked={selected.includes(s.id)}
                >
                  {s.logo ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="logo" src={s.logo} alt={s.name} />
                  ) : (
                    <span className="flag">▦</span>
                  )}
                  <span>{s.name}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      {data && (
        <button className="btn primary" style={{ marginTop: 14 }} onClick={save} disabled={saving}>
          {saving ? <span className="spin" /> : null} Save providers
        </button>
      )}
    </div>
  );
}
