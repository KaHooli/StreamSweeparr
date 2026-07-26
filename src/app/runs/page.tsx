"use client";

import { useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";

interface RunLog {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  status: "RUNNING" | "SUCCESS" | "FAILED";
  dryRun: boolean;
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

export default function RunsPage() {
  const { data } = useSWR<{ runs: RunLog[] }>("/api/runs", fetcher, { refreshInterval: 4000 });
  const [open, setOpen] = useState<number | null>(null);

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
          {data.runs.map((r) => (
            <div className="card" key={r.id} style={{ padding: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <span
                  className="type"
                  style={{
                    color:
                      r.status === "SUCCESS" ? "var(--ok)" : r.status === "FAILED" ? "var(--danger)" : "var(--info)",
                    background: "var(--surface-2)",
                  }}
                >
                  {r.status}
                </span>
                <strong>Run #{r.id}</strong>
                <span className="chip">{r.dryRun ? "dry-run" : "LIVE"}</span>
                <span className="muted">{new Date(r.startedAt).toLocaleString()}</span>
                <span className="spacer" style={{ flex: 1 }} />
                <button className="btn sm ghost" onClick={() => setOpen(open === r.id ? null : r.id)}>
                  {open === r.id ? "Hide log" : "View log"}
                </button>
              </div>

              <div className="stats" style={{ marginTop: 14 }}>
                <Metric label="Unmon. movies" value={r.unmonitoredMovies} />
                <Metric label="Re-mon. movies" value={r.remonitoredMovies} />
                <Metric label="Unmon. episodes" value={r.unmonitoredEps} />
                <Metric label="Re-mon. episodes" value={r.remonitoredEps} />
                <Metric label="Files deleted" value={r.deletedFiles} />
                <Metric label="Movies removed" value={r.removedMovies} />
                <Metric label="Searched" value={r.searchedItems} />
              </div>

              {r.error && <div className="banner err" style={{ marginTop: 12 }}>{r.error}</div>}

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
          ))}
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
