"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { postJson } from "@/lib/fetcher";

// Shared Sync / Sweep action bar used on the dashboard.
export function RunControls({ applyChanges }: { applyChanges: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | "sync" | "sweep">(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const doSync = async () => {
    setBusy("sync");
    setMsg(null);
    try {
      const r = await postJson<{ result: { movies: number; series: number } }>("/api/sync");
      setMsg({ kind: "ok", text: `Synced ${r.result.movies} movies and ${r.result.series} series.` });
      router.refresh();
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const doSweep = async () => {
    setBusy("sweep");
    setMsg(null);
    try {
      const r = await postJson<{ runId: number }>("/api/sweep");
      setMsg({
        kind: "ok",
        text: `Sweep #${r.runId} finished (${applyChanges ? "LIVE" : "dry-run"}).`,
      });
      router.push(`/runs?highlight=${r.runId}`);
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="btn" onClick={doSync} disabled={!!busy} style={{ flex: "0 0 auto" }}>
          {busy === "sync" ? <span className="spin" /> : "↻"} Sync now
        </button>
        <button
          className="btn primary"
          onClick={doSweep}
          disabled={!!busy}
          style={{ flex: "0 0 auto" }}
          title={applyChanges ? "Applies changes to Sonarr/Radarr" : "Preview only (dry-run)"}
        >
          {busy === "sweep" ? <span className="spin" /> : "≋"} Run sweep{applyChanges ? "" : " (dry-run)"}
        </button>
      </div>
      {msg && <div className={`banner ${msg.kind === "ok" ? "ok" : "err"}`}>{msg.text}</div>}
    </div>
  );
}
