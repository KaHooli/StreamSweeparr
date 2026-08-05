"use client";

import { useState, useEffect } from "react";
import { sendJson } from "@/lib/fetcher";
import { describeInterval } from "@/lib/schedule";
import type { CardProps } from "./types";
import { Toggle } from "./Toggle";

/** "in 4h 12m" / "due now" for the next scheduled run. */
function untilLabel(iso: string | null): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "due now";
  const mins = Math.round(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `in ${h > 0 ? `${h}h ` : ""}${m}m`;
}

export function ScheduleCard({ settings, onChange }: CardProps) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  // Re-render once a minute so the "in 4h 12m" countdown stays honest.
  const [, setNow] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setNow((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  const save = async (patch: { sweepScheduleEnabled?: boolean; sweepIntervalHours?: number }) => {
    setBusy(true);
    setMsg(null);
    try {
      await sendJson("PATCH", "/api/settings", patch);
      onChange();
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const choices = settings.sweepIntervalChoices?.length
    ? settings.sweepIntervalChoices
    : [1, 2, 3, 4, 6, 8, 12, 24, 48, 72, 168];

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="section-title" style={{ marginTop: 0 }}>
        <h2 style={{ fontSize: 18 }}>Scheduled sweeps</h2>
        <span className="count">
          {settings.sweepScheduleEnabled
            ? `every ${describeInterval(settings.sweepIntervalHours)}`
            : "off"}
        </span>
      </div>

      <Toggle
        title="Run sweep at regular intervals"
        desc="Automatically start a sweep every so often, without anyone pressing Run sweep."
        checked={settings.sweepScheduleEnabled}
        onChange={(v) => save({ sweepScheduleEnabled: v })}
      />

      {settings.sweepScheduleEnabled && (
        <>
          <div className="row">
            <div className="field">
              <label>Interval</label>
              <select
                className="select"
                value={settings.sweepIntervalHours}
                disabled={busy}
                onChange={(e) => save({ sweepIntervalHours: Number(e.target.value) })}
              >
                {choices.map((h) => (
                  <option key={h} value={h}>
                    Every {describeInterval(h)}
                  </option>
                ))}
              </select>
              <div className="hint">
                Counted from the last scheduled run. Changing the interval reschedules
                immediately; the first run is one full interval away.
              </div>
            </div>
          </div>

          <div className="muted" style={{ marginBottom: 12 }}>
            {settings.sweepNextRunAt ? (
              <>
                Next run: <strong>{new Date(settings.sweepNextRunAt).toLocaleString()}</strong>{" "}
                ({untilLabel(settings.sweepNextRunAt)})
              </>
            ) : (
              "Next run: scheduling…"
            )}
            {settings.sweepLastRunAt && (
              <>
                {" · "}Last scheduled run: {new Date(settings.sweepLastRunAt).toLocaleString()}
              </>
            )}
          </div>

          {!settings.applyChanges && (
            <div className="banner warn" style={{ marginBottom: 12 }}>
              Apply changes (LIVE mode) is off, so scheduled sweeps are dry-runs — they log what
              they would do without touching Sonarr/Radarr.
            </div>
          )}

          {settings.sweepSchedulerDisabledByEnv && (
            <div className="banner err" style={{ marginBottom: 12 }}>
              This instance has <code>SWEEP_SCHEDULER=off</code> set, so it will not run the
              schedule. Another replica must run it.
            </div>
          )}
        </>
      )}

      <div className="muted" style={{ fontSize: 12 }}>
        Scheduled sweeps run on the server, so nobody needs to be signed in. One is skipped (not
        queued) if a sync or sweep is already running, and picks up again at the next interval.
      </div>

      {msg && <div className={`banner ${msg.kind === "ok" ? "ok" : "err"}`} style={{ marginTop: 12 }}>{msg.text}</div>}
    </div>
  );
}
