"use client";

import { useState } from "react";
import { sendJson } from "@/lib/fetcher";
import { feedUrl } from "@/lib/feedUrl";
import type { CardProps } from "./types";
import { Toggle } from "./Toggle";
import { CopyRow } from "./CopyRow";

/**
 * The streaming-link feed: lets another app (a portal such as Hearthport, a
 * home dashboard) read where each title is streaming, with a link per service.
 *
 * Like the webhook card, its real job is handing over values that work — the
 * two feed URLs and the key — each with a Copy button. Unlike the webhook URL,
 * the key is kept out of the URL: a feed consumer has a separate key field, and
 * a key in a URL ends up in access logs.
 */
export function FeedCard({ settings, onChange }: CardProps) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [revealed, setRevealed] = useState(false);

  const save = async (patch: { feedEnabled?: boolean; regenerateFeedToken?: boolean }) => {
    if (
      patch.regenerateFeedToken &&
      !window.confirm("Generate a new feed key? Apps using the current key will stop working.")
    ) {
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await sendJson("PATCH", "/api/settings", patch);
      onChange();
      if (patch.regenerateFeedToken) {
        setMsg({
          kind: "ok",
          text: "New key generated. Update it in every app reading the feed — the old one no longer works.",
        });
      }
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  // Built in the browser so the URLs carry whatever address the admin actually
  // reaches the app on. The consuming app has to reach that same address.
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="section-title" style={{ marginTop: 0 }}>
        <h2 style={{ fontSize: 18 }}>Share streaming links with other apps</h2>
        <span className="count">{settings.feedEnabled ? "on" : "off"}</span>
      </div>

      <Toggle
        title="Serve the streaming-link feed"
        desc="Another app can read which of your services each title is on, with a link to watch it there. Read-only: the feed cannot change anything."
        checked={settings.feedEnabled}
        onChange={(v) => save({ feedEnabled: v })}
      />

      {settings.feedEnabled && (
        <>
          <div className="muted" style={{ marginBottom: 12 }}>
            Give the app the URL for each feed and the key below. It sends the key as an{" "}
            <code>X-Api-Key</code> header (or <code>Authorization: Bearer</code>). TV shows and
            movies are separate feeds; each lists the titles on your services, the same ones the
            dashboard shows.
          </div>

          {!origin.startsWith("https://") && (
            <div className="banner warn" style={{ marginBottom: 12 }}>
              Over HTTP the key travels in plain sight. Fine on a LAN, worth fixing if the
              traffic leaves one.
            </div>
          )}

          <CopyRow label="TV shows feed" value={feedUrl(origin, "tv")} />
          <CopyRow label="Movies feed" value={feedUrl(origin, "movies")} />

          <div className="field" style={{ marginBottom: 12 }}>
            <label>Key</label>
            <div className="row" style={{ alignItems: "stretch" }}>
              <input
                className="input"
                readOnly
                type={revealed ? "text" : "password"}
                value={settings.feedToken}
                onFocus={(e) => e.target.select()}
              />
              <button
                className="btn"
                style={{ flex: "0 0 auto" }}
                onClick={() => setRevealed((v) => !v)}
              >
                {revealed ? "Hide" : "Show"}
              </button>
              <button
                className="btn"
                style={{ flex: "0 0 auto" }}
                disabled={busy}
                onClick={() => save({ regenerateFeedToken: true })}
              >
                Regenerate
              </button>
            </div>
            <div className="hint">
              Separate from the webhook token, so either can be replaced without breaking the
              other. Anyone holding this key can list your library&rsquo;s streaming titles.
            </div>
          </div>
        </>
      )}

      <div className="muted" style={{ fontSize: 12 }}>
        Serving the feed uses no Watchmode or TMDB credits — it hands out what the last sync
        found, so links are as fresh as that sync. Add <code>?tmdbId=</code> to fetch just one
        title.
      </div>

      {msg && (
        <div className={`banner ${msg.kind === "ok" ? "ok" : "err"}`} style={{ marginTop: 12 }}>
          {msg.text}
        </div>
      )}
    </div>
  );
}
