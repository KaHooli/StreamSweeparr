"use client";

import { sendJson } from "@/lib/fetcher";
import type { CardProps, SettingsDto } from "./types";
import { Toggle } from "./Toggle";

export function OptionsCard({ settings, onChange }: CardProps) {
  const set = async (patch: Partial<SettingsDto>) => {
    await sendJson("PATCH", "/api/settings", patch);
    onChange();
  };
  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="section-title" style={{ marginTop: 0 }}>
        <h2 style={{ fontSize: 18 }}>Run options</h2>
      </div>
      <Toggle
        title="Apply changes (LIVE mode)"
        desc="When off, sweeps are a dry-run and never modify Sonarr/Radarr."
        checked={settings.applyChanges}
        danger
        onChange={(v) => set({ applyChanges: v })}
      />
      <Toggle
        title="Delete files when unmonitoring"
        desc="Delete the episode/movie file after unmonitoring a title that's on streaming."
        checked={settings.deleteFiles}
        onChange={(v) => set({ deleteFiles: v })}
      />
      <Toggle
        title="Remove files for all unmonitored items"
        desc="At the end of a sweep, delete files for every unmonitored movie and episode — not just the ones this sweep unmonitored. Clears an existing unmonitored back-catalogue."
        checked={settings.purgeUnmonitoredFiles}
        danger
        onChange={(v) => set({ purgeUnmonitoredFiles: v })}
      />
      <Toggle
        title="Remove movies deleted from TMDB"
        desc="If TMDB reports a movie's id no longer exists, remove it from Radarr. Media files are kept."
        checked={settings.removeMissingTmdbMovies}
        danger
        onChange={(v) => set({ removeMissingTmdbMovies: v })}
      />
      <Toggle
        title="Search monitored items at end of run"
        desc="Trigger a search for every monitored movie/episode after sweeping."
        checked={settings.searchAtEnd}
        onChange={(v) => set({ searchAtEnd: v })}
      />
    </div>
  );
}
