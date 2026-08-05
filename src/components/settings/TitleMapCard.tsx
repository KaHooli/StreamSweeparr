"use client";

import { useState } from "react";
import useSWR from "swr";
import { fetcher, postJson } from "@/lib/fetcher";

interface TitleMapDto {
  syncedAt: string | null;
  etag: string | null;
  lastModified: string | null;
  rowCount: number;
}
export function TitleMapCard({ enabled }: { enabled: boolean }) {
  const { data, mutate } = useSWR<TitleMapDto>("/api/titlemap", fetcher);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const refresh = async (force: boolean) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await postJson<{ result: { status: string; rowCount: number } }>(
        "/api/titlemap",
        { force }
      );
      setMsg({
        kind: "ok",
        text: `${r.result.status} — ${r.result.rowCount.toLocaleString()} titles in map.`,
      });
      mutate();
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="section-title" style={{ marginTop: 0 }}>
        <h2 style={{ fontSize: 18 }}>Title ID map</h2>
        <span className="count">{data?.rowCount ? `${data.rowCount.toLocaleString()} titles` : "empty"}</span>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Local copy of Watchmode&apos;s TMDB/IMDB → Watchmode ID dataset. Auto-refreshes every 12
        hours (only re-imports when the dataset&apos;s ETag changes) so lookups don&apos;t spend
        Watchmode search quota.
      </p>
      <div className="stats" style={{ marginBottom: 12 }}>
        <div className="stat" style={{ padding: 12 }}>
          <div className="label">Last import</div>
          <div className="value" style={{ fontSize: 15 }}>
            {data?.syncedAt ? new Date(data.syncedAt).toLocaleString() : "never"}
          </div>
        </div>
        <div className="stat" style={{ padding: 12 }}>
          <div className="label">Dataset date</div>
          <div className="value" style={{ fontSize: 15 }}>
            {data?.lastModified ? new Date(data.lastModified).toLocaleString() : "—"}
          </div>
        </div>
      </div>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <button className="btn" style={{ flex: "0 0 auto" }} onClick={() => refresh(false)} disabled={busy || !enabled}>
          {busy ? <span className="spin" /> : null} Refresh (if changed)
        </button>
        <button className="btn primary" style={{ flex: "0 0 auto" }} onClick={() => refresh(true)} disabled={busy || !enabled}>
          {busy ? <span className="spin" /> : null} Force re-import
        </button>
      </div>
      {!enabled && <div className="muted" style={{ marginTop: 8 }}>Add a Watchmode API key first.</div>}
      {msg && <div className={`banner ${msg.kind === "ok" ? "ok" : "err"}`} style={{ marginTop: 12 }}>{msg.text}</div>}
    </div>
  );
}
