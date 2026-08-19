"use client";

import { useState } from "react";
import useSWR from "swr";
import { fetcher, postJson } from "@/lib/fetcher";

interface RunLog {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  status: "RUNNING" | "SUCCESS" | "FAILED" | "ABORTED";
  dryRun: boolean;
  abortRequestedAt: string | null;
  unmonitoredMovies: number;
  remonitoredMovies: number;
  unmonitoredEps: number;
  remonitoredEps: number;
  deletedFiles: number;
  removedMovies: number;
  searchedItems: number;
  error: string | null;
  log: { level: string; msg: string }[] | null;
}

const STATUS_COLOUR: Record<RunLog["status"], string> = {
  SUCCESS: "var(--ok)",
  FAILED: "var(--danger)",
  // A stopped run is neither a success nor a fault, and the amber says so at a
  // glance — the same colour a partial result carries everywhere else.
  ABORTED: "var(--warn)",
  RUNNING: "var(--info)",
};

export default function RunsPage() {
  const { data, mutate } = useSWR<{ runs: RunLog[] }>("/api/runs", fetcher, {
    refreshInterval: 4000,
  });
  // Stopping a run mutates Sonarr/Radarr state indirectly, so it is admin-only
  // like the buttons that start one. Hide it rather than let a user click into
  // a 403.
  const { data: session } = useSWR<{ user: { role: "ADMIN" | "USER" } | null }>(
    "/api/auth/session",
    fetcher
  );
  const isAdmin = session?.user?.role === "ADMIN";
  const [open, setOpen] = useState<number | null>(null);
  // Which run is showing its "are you sure?" box. At most one at a time, so a
  // list refresh cannot leave several half-answered prompts behind.
  const [confirming, setConfirming] = useState<number | null>(null);
  const [aborting, setAborting] = useState<number | null>(null);
  const [abortError, setAbortError] = useState<{ id: number; text: string } | null>(null);

  const abort = async (id: number) => {
    setAborting(id);
    setAbortError(null);
    try {
      await postJson(`/api/runs/${id}/abort`);
      setConfirming(null);
      // Pull the run straight away so the row shows "Stopping…" without waiting
      // out the poll interval.
      await mutate();
    } catch (e) {
      setAbortError({ id, text: (e as Error).message });
    } finally {
      setAborting(null);
    }
  };

  return (
    <main>
      <div className="section-title">
        <h2>Sweep runs</h2>
        <span className="count">last 20</span>
      </div>
      {!data ? (
        <div className="card">Loading…</div>
      ) : data.runs.length === 0 ? (
        <div className="empty card">No runs yet. Start one from the dashboard.</div>
      ) : (
        <div className="conn-list">
          {data.runs.map((r) => {
            const stopping = r.status === "RUNNING" && !!r.abortRequestedAt;
            return (
            <div className="card" key={r.id} style={{ padding: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <span
                  className="type"
                  style={{ color: STATUS_COLOUR[r.status], background: "var(--surface-2)" }}
                >
                  {stopping ? "STOPPING" : r.status}
                </span>
                <strong>Run #{r.id}</strong>
                <span className="chip">{r.dryRun ? "dry-run" : "LIVE"}</span>
                <span className="muted">{new Date(r.startedAt).toLocaleString()}</span>
                <span className="spacer" style={{ flex: 1 }} />
                {isAdmin && r.status === "RUNNING" && (
                  <button
                    className="btn sm danger"
                    onClick={() => {
                      setAbortError(null);
                      setConfirming(confirming === r.id ? null : r.id);
                    }}
                    disabled={stopping || aborting === r.id}
                  >
                    {stopping ? "Stopping…" : "Abort run"}
                  </button>
                )}
                <button className="btn sm ghost" onClick={() => setOpen(open === r.id ? null : r.id)}>
                  {open === r.id ? "Hide log" : "View log"}
                </button>
              </div>

              {confirming === r.id && (
                <div className="banner warn" style={{ marginTop: 12 }}>
                  <div>
                    <strong>Abort run #{r.id}?</strong> It stops once it finishes the title it is
                    working on.{" "}
                    {r.dryRun
                      ? "Nothing has been changed in Sonarr/Radarr — this run is a dry-run."
                      : "Changes it has already applied to Sonarr/Radarr stay applied; they are not undone."}{" "}
                    The next sweep picks up where this one left off.
                  </div>
                  <div className="row" style={{ marginTop: 10 }}>
                    <button
                      className="btn sm danger"
                      onClick={() => abort(r.id)}
                      disabled={aborting === r.id}
                      style={{ flex: "0 0 auto" }}
                    >
                      {aborting === r.id ? <span className="spin" /> : null} Yes, abort it
                    </button>
                    <button
                      className="btn sm ghost"
                      onClick={() => setConfirming(null)}
                      disabled={aborting === r.id}
                      style={{ flex: "0 0 auto" }}
                    >
                      Keep running
                    </button>
                  </div>
                </div>
              )}

              {abortError?.id === r.id && (
                <div className="banner err" style={{ marginTop: 12 }}>
                  {abortError.text}
                </div>
              )}

              <div className="stats" style={{ marginTop: 14 }}>
                <Metric label="Unmon. movies" value={r.unmonitoredMovies} />
                <Metric label="Re-mon. movies" value={r.remonitoredMovies} />
                <Metric label="Unmon. episodes" value={r.unmonitoredEps} />
                <Metric label="Re-mon. episodes" value={r.remonitoredEps} />
                <Metric label="Files deleted" value={r.deletedFiles} />
                <Metric label="Movies removed" value={r.removedMovies} />
                <Metric label="Searched" value={r.searchedItems} />
              </div>

              {r.error && (
                <div
                  className={`banner ${r.status === "ABORTED" ? "warn" : "err"}`}
                  style={{ marginTop: 12 }}
                >
                  {r.error}
                </div>
              )}

              {open === r.id && r.log && (
                <div className="log" style={{ marginTop: 12 }}>
                  {r.log.map((l, i) => (
                    <div key={i} className={l.level}>
                      {l.level === "action" ? "» " : l.level === "warn" ? "! " : "· "}
                      {l.msg}
                    </div>
                  ))}
                </div>
              )}
            </div>
            );
          })}
        </div>
      )}
    </main>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat" style={{ padding: 12 }}>
      <div className="label">{label}</div>
      <div className="value" style={{ fontSize: 22 }}>
        {value}
      </div>
    </div>
  );
}
