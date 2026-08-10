"use client";

import { useState } from "react";
import { useSyncedState } from "@/lib/useSyncedState";
import useSWR from "swr";
import { fetcher, sendJson } from "@/lib/fetcher";
import type { CardProps, ServiceGroup } from "./types";
import { TYPE_LABELS } from "./types";

export function ServicesCard({ settings, onChange }: CardProps) {
  const key =
    settings.watchmodeApiKeySet && settings.countries.length
      ? `/api/watchmode/sources?countries=${settings.countries.join(",")}`
      : null;
  const { data, error } = useSWR<{ groups: ServiceGroup[] }>(key, fetcher);
  const [selected, setSelected] = useSyncedState<number[]>(settings.serviceIds);
  const [types, setTypes] = useSyncedState<string[]>(settings.countedTypes);
  const [saving, setSaving] = useState(false);

  const toggle = (id: number) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const toggleType = (t: string) =>
    setTypes((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));

  const save = async () => {
    setSaving(true);
    await sendJson("PATCH", "/api/settings", { serviceIds: selected, countedTypes: types });
    setSaving(false);
    onChange();
  };

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="section-title" style={{ marginTop: 0 }}>
        <h2 style={{ fontSize: 18 }}>
          Streaming services ({settings.movieProvider === "WATCHMODE" ? "TV & movies" : "TV"})
        </h2>
        <span className="count">{selected.length} selected</span>
      </div>
      {!settings.countries.length && <div className="muted">Select at least one country first.</div>}
      {error && <div className="banner err">{(error as Error).message}</div>}

      <div className="field">
        <label>Count a title as &quot;on streaming&quot; when available via:</label>
        <div className="chips">
          {Object.entries(TYPE_LABELS).map(([t, label]) => (
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
          <div key={g.country}>
            <div className="group-head">Streaming in {g.country}</div>
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
                  <span className="svc-type">{s.type}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      {data && (
        <button className="btn primary" style={{ marginTop: 14 }} onClick={save} disabled={saving}>
          {saving ? <span className="spin" /> : null} Save services
        </button>
      )}
    </div>
  );
}
