"use client";

import { useState } from "react";
import { sendJson } from "@/lib/fetcher";
import { webhookUrl, type ArrKind } from "@/lib/webhookUrl";
import type { CardProps } from "./types";
import { Toggle } from "./Toggle";

/**
 * Webhook-triggered sweeps.
 *
 * The card's real job is handing over a URL that works. A webhook URL is four
 * things the user must not have to assemble by hand — origin, endpoint, token,
 * and which instance it is for — so each connection gets its own line with a
 * Copy button, built from the browser's own origin.
 */

/** How long a queued title waits, in words. */
function describeDelay(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const mins = Math.round(seconds / 60);
  return `${mins} minute${mins === 1 ? "" : "s"}`;
}

const TRIGGER_LABEL: Record<ArrKind, string> = {
  sonarr: "On Series Add",
  radarr: "On Movie Added",
};

function kindFor(type: string): ArrKind {
  return type === "SONARR" ? "sonarr" : "radarr";
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState<"ok" | "err" | null>(null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied("ok");
    } catch {
      // Clipboard access needs a secure context; over plain HTTP it just fails,
      // which is why the value stays selectable on screen either way.
      setCopied("err");
    }
    setTimeout(() => setCopied(null), 2500);
  };

  return (
    <div className="field" style={{ marginBottom: 12 }}>
      <label>{label}</label>
      <div className="row" style={{ alignItems: "stretch" }}>
        <input className="input" readOnly value={value} onFocus={(e) => e.target.select()} />
        <button className="btn" style={{ flex: "0 0 auto" }} onClick={copy}>
          {copied === "ok" ? "Copied ✓" : copied === "err" ? "Copy failed" : "Copy"}
        </button>
      </div>
    </div>
  );
}

export function WebhookCard({ settings, onChange }: CardProps) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [revealed, setRevealed] = useState(false);

  const save = async (patch: { webhookEnabled?: boolean; regenerateWebhookToken?: boolean }) => {
    setBusy(true);
    setMsg(null);
    try {
      await sendJson("PATCH", "/api/settings", patch);
      onChange();
      if (patch.regenerateWebhookToken) {
        setMsg({
          kind: "ok",
          text: "New token generated. Update the URL in every Sonarr/Radarr connection — the old one no longer works.",
        });
      }
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  // Built in the browser so the URL carries whatever address the user actually
  // reaches the app on. Sonarr and Radarr have to reach that same address.
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const enabledConnections = settings.connections.filter((c) => c.enabled);

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="section-title" style={{ marginTop: 0 }}>
        <h2 style={{ fontSize: 18 }}>Sweep new titles as they&rsquo;re added</h2>
        <span className="count">{settings.webhookEnabled ? "on" : "off"}</span>
      </div>

      <Toggle
        title="Let Sonarr and Radarr trigger a sweep"
        desc="When a series or movie is added, sweep just that title instead of waiting for the next full run."
        checked={settings.webhookEnabled}
        onChange={(v) => save({ webhookEnabled: v })}
      />

      {settings.webhookEnabled && (
        <>
          <div className="muted" style={{ marginBottom: 12 }}>
            Add a <strong>Webhook</strong> connection in each instance under{" "}
            <strong>Settings → Connect</strong>, set the method to <strong>POST</strong>, tick
            only <strong>On Series Add</strong> (Sonarr) or <strong>On Movie Added</strong>{" "}
            (Radarr), and paste the matching URL below. <strong>Test</strong> should come back
            green.
          </div>

          {!origin.startsWith("https://") && (
            <div className="banner warn" style={{ marginBottom: 12 }}>
              This URL carries the token in plain sight. Over HTTP anything on the network
              between your *arr and StreamSweeparr can read it — fine on a LAN, worth fixing
              if the traffic leaves one.
            </div>
          )}

          {enabledConnections.length === 0 ? (
            <div className="banner warn" style={{ marginBottom: 12 }}>
              No enabled Sonarr or Radarr connections yet. Add one under{" "}
              <strong>Settings → Connections</strong> and its webhook URL appears here.
            </div>
          ) : (
            enabledConnections.map((c) => (
              <CopyRow
                key={c.id}
                label={`${c.name} — ${TRIGGER_LABEL[kindFor(c.type)]}`}
                value={webhookUrl(origin, kindFor(c.type), {
                  token: settings.webhookToken,
                  connectionId: c.id,
                })}
              />
            ))
          )}

          <div className="field" style={{ marginBottom: 12 }}>
            <label>Token</label>
            <div className="row" style={{ alignItems: "stretch" }}>
              <input
                className="input"
                readOnly
                type={revealed ? "text" : "password"}
                value={settings.webhookToken}
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
                onClick={() => save({ regenerateWebhookToken: true })}
              >
                Regenerate
              </button>
            </div>
            <div className="hint">
              The same token works for every instance. Regenerating it invalidates the URLs
              already pasted into Sonarr and Radarr.
            </div>
          </div>

          {!settings.applyChanges && (
            <div className="banner warn" style={{ marginBottom: 12 }}>
              Apply changes (LIVE mode) is off, so these sweeps are dry-runs — they log what
              they would do without touching Sonarr/Radarr.
            </div>
          )}

          {settings.sweepSchedulerDisabledByEnv && (
            <div className="banner err" style={{ marginBottom: 12 }}>
              This instance has <code>SWEEP_SCHEDULER=off</code> set, so it will accept
              webhooks but never sweep what they queue. Another replica must run them.
            </div>
          )}
        </>
      )}

      <div className="muted" style={{ fontSize: 12 }}>
        A newly added title waits about {describeDelay(settings.webhookSettleSeconds)} before its
        sweep starts, so Sonarr has time to fetch the episode list and a batch of additions
        becomes one run. Titles added while another run is in progress are swept when it
        finishes, not dropped.
      </div>

      {msg && (
        <div className={`banner ${msg.kind === "ok" ? "ok" : "err"}`} style={{ marginTop: 12 }}>
          {msg.text}
        </div>
      )}
    </div>
  );
}
