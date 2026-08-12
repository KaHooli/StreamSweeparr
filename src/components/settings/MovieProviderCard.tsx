"use client";

import { useState } from "react";
import { sendJson } from "@/lib/fetcher";
import { describeWatchmodeCache } from "@/lib/watchmodeCache";
import type { CardProps, SettingsDto } from "./types";

/**
 * Which provider answers "is this movie on streaming?".
 *
 * TV is not part of the choice — Watchmode is the only provider with
 * per-episode availability — so this card lives on the Movies tab and decides
 * which of the cards below it are relevant at all.
 *
 * The default is TMDB and the copy says why in the card rather than in the
 * README alone: the cost of picking Watchmode here is invisible until a month
 * later, when the credit budget that was sized for a TV library has been spent
 * on films too.
 */
export function MovieProviderCard({ settings, onChange }: CardProps) {
  const [busy, setBusy] = useState<SettingsDto["movieProvider"] | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const current = settings.movieProvider;

  const choose = async (movieProvider: SettingsDto["movieProvider"]) => {
    if (movieProvider === current) return;
    setBusy(movieProvider);
    setMsg(null);
    try {
      await sendJson("PATCH", "/api/settings", { movieProvider });
      setMsg({
        kind: "ok",
        text:
          movieProvider === "WATCHMODE"
            ? "Movies will use Watchmode from the next sync, with the countries and services from the Watchmode tab."
            : "Movies will use TheMovieDB from the next sync.",
      });
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
        <h2 style={{ fontSize: 18 }}>Movie availability source</h2>
        <span className="count">{current === "WATCHMODE" ? "Watchmode" : "TheMovieDB"}</span>
      </div>

      <div className="choices">
        <Choice
          selected={current === "TMDB"}
          busy={busy === "TMDB"}
          title="TheMovieDB (recommended)"
          desc="Free and unmetered, JustWatch-powered. Keeps your Watchmode credits for TV, where they can't be avoided. Configured below."
          onSelect={() => choose("TMDB")}
        />
        <Choice
          selected={current === "WATCHMODE"}
          busy={busy === "WATCHMODE"}
          title="Watchmode"
          desc="One provider for the whole library: movies reuse the countries, services and counted types from the Watchmode (TV) tab. Costs one credit per movie looked up."
          onSelect={() => choose("WATCHMODE")}
        />
      </div>

      {current === "WATCHMODE" && !settings.watchmodeApiKeySet && (
        <div className="banner err" style={{ marginTop: 12, marginBottom: 0 }}>
          No Watchmode API key is set, so movie availability can&rsquo;t be looked up. Add one
          under <strong>Settings → Watchmode</strong>.
        </div>
      )}
      {current === "WATCHMODE" && settings.watchmodeApiKeySet && (
        <div className="hint" style={{ marginTop: 12 }}>
          A movie is re-checked at most once every{" "}
          {describeWatchmodeCache(settings.watchmodeCacheDays)} — the same window as TV, set
          under <strong>Settings → Watchmode</strong> — because every lookup spends a credit.
          Your TheMovieDB settings are kept as they are, so switching back needs no re-entry.
        </div>
      )}

      {msg && (
        <div className={`banner ${msg.kind}`} style={{ marginTop: 12, marginBottom: 0 }}>
          {msg.text}
        </div>
      )}
    </div>
  );
}

function Choice({
  selected,
  busy,
  title,
  desc,
  onSelect,
}: {
  selected: boolean;
  busy: boolean;
  title: string;
  desc: string;
  onSelect: () => void;
}) {
  return (
    <label className={`choice ${selected ? "selected" : ""}`}>
      <input type="radio" name="movieProvider" checked={selected} onChange={onSelect} />
      <div className="txt">
        <strong>
          {title} {busy ? <span className="spin" /> : null}
        </strong>
        <span>{desc}</span>
      </div>
    </label>
  );
}
