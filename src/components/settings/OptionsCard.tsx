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
        title="Cancel downloads in progress"
        desc="If a title being unmonitored is already downloading, remove it from the Sonarr/Radarr queue and tell the download client to delete it. With “Remove files for all unmonitored items” also on, this covers every unmonitored title, not just the ones this sweep unmonitored. A download covering several episodes is only cancelled when every one of them is in scope."
        checked={settings.cancelQueuedDownloads}
        danger
        onChange={(v) => set({ cancelQueuedDownloads: v })}
      />
      <Toggle
        title="Remove files for all unmonitored items"
        desc="At the end of a sweep, delete files for every unmonitored movie and episode — not just the ones this sweep unmonitored. Clears an existing unmonitored back-catalogue."
        checked={settings.purgeUnmonitoredFiles}
        danger
        onChange={(v) => set({ purgeUnmonitoredFiles: v })}
      />
      <Toggle
        title="Re-check newly aired episodes"
        desc="Watchmode usually takes a few days to list a new episode's streaming services. While an episode that aired in the last week is still unlisted, and the episode before it is on your services, look the series up again once a day instead of waiting out the Watchmode cache window. Costs a few extra Watchmode credits per new episode."
        checked={settings.recheckNewEpisodes}
        onChange={(v) => set({ recheckNewEpisodes: v })}
      />
      <Toggle
        title="Assume newly aired episodes are on streaming"
        desc="Until Watchmode lists it, treat an episode that aired in the last week as being on the same services as the episode before it, so it is unmonitored straight away instead of grabbed. It is then treated like any other episode on streaming, so the file and download options above apply to it too. The assumption lapses after a week if Watchmode still hasn't confirmed it, and the episode is re-monitored and searched for again."
        checked={settings.assumeNewEpisodesStream}
        onChange={(v) => set({ assumeNewEpisodesStream: v })}
      />
      <Toggle
        title="Remove movies deleted from TMDB"
        // Nothing consults TMDB while Watchmode answers for movies, so no movie
        // is ever flagged and this switch has nothing to act on. Say so rather
        // than leave a destructive-looking option reading as if it were armed.
        desc={
          settings.movieProvider === "WATCHMODE"
            ? "If TMDB reports a movie's id no longer exists, remove it from Radarr. Not in use: movies are being looked up on Watchmode."
            : "If TMDB reports a movie's id no longer exists, remove it from Radarr. Media files are kept."
        }
        checked={settings.removeMissingTmdbMovies}
        danger
        onChange={(v) => set({ removeMissingTmdbMovies: v })}
      />
      <Toggle
        title="Search monitored items at end of run"
        desc="After sweeping, trigger a search for every monitored movie/episode that is missing its file. Episodes are grouped into season searches where a season is fully monitored, to keep the load off your indexers."
        checked={settings.searchAtEnd}
        onChange={(v) => set({ searchAtEnd: v })}
      />
    </div>
  );
}
