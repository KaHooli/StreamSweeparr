"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetcher, postJson } from "@/lib/fetcher";

interface RunProgress {
  id: number;
  kind: "SWEEP" | "SYNC";
  status: "RUNNING" | "SUCCESS" | "FAILED";
  error: string | null;
  log: { level: string; msg: string }[] | null;
  unmonitoredMovies: number;
  remonitoredMovies: number;
  unmonitoredEps: number;
  remonitoredEps: number;
  deletedFiles: number;
  searchedItems: number;
}

// Shared Sync / Sweep action bar. Runs execute in the background; this polls
// the run's progress and shows a live log until it finishes.
export function RunControls({ applyChanges }: { applyChanges: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | "sync" | "sweep">(null);
  const [runId, setRunId] = useState<number | null>(null);
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll the active run for live progress.
  useEffect(() => {
    if (runId == null) return;
    const stop = () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
    const tick = async () => {
      try {
        const { run } = await fetcher(`/api/runs/${runId}`);
        setProgress(run);
        if (run.status !== "RUNNING") {
          stop();
          setBusy(null);
          setMsg(
            run.status === "SUCCESS"
              ? { kind: "ok", text: `${run.kind === "SWEEP" ? "Sweep" : "Sync"} #${run.id} finished.` }
              : { kind: "err", text: run.error || "Run failed." }
          );
          router.refresh();
        }
      } catch {
        /* keep polling; transient */
      }
    };
    void tick();
    pollRef.current = setInterval(tick, 1500);
    return stop;
  }, [runId, router]);

  const start = async (kind: "sync" | "sweep") => {
    setBusy(kind);
    setMsg(null);
    setProgress(null);
    try {
      const r = await postJson<{ runId: number }>(`/api/${kind}`);
      setRunId(r.runId);
    } catch (e) {
      // 409 -> a run is already in progress; attach to it if we got an id.
      const anyErr = e as Error & { runId?: number };
      if (anyErr.runId) {
        setRunId(anyErr.runId);
        setMsg({ kind: "err", text: "A run was already in progress — attached to it." });
      } else {
        setMsg({ kind: "err", text: anyErr.message });
        setBusy(null);
      }
    }
  };

  const log = progress?.log ?? [];

  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="btn" onClick={() => start("sync")} disabled={!!busy} style={{ flex: "0 0 auto" }}>
          {busy === "sync" ? <span className="spin" /> : "↻"} Sync now
        </button>
        <button
          className="btn primary"
          onClick={() => start("sweep")}
          disabled={!!busy}
          style={{ flex: "0 0 auto" }}
          title={applyChanges ? "Applies changes to Sonarr/Radarr" : "Preview only (dry-run)"}
        >
          {busy === "sweep" ? <span className="spin" /> : "≋"} Run sweep{applyChanges ? "" : " (dry-run)"}
        </button>
      </div>

      {msg && <div className={`banner ${msg.kind === "ok" ? "ok" : "err"}`}>{msg.text}</div>}

      {busy && progress?.status === "RUNNING" && (
        <div className="muted" style={{ marginBottom: 8 }}>
          Running… this continues in the background if you navigate away.
        </div>
      )}

      {log.length > 0 && (
        <div className="log" style={{ maxHeight: 240 }}>
          {log.slice(-80).map((l, i) => (
            <div key={i} className={l.level}>
              {l.level === "action" ? "» " : l.level === "warn" ? "! " : "· "}
              {l.msg}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
