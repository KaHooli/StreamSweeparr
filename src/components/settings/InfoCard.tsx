"use client";

import { useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import {
  buildDiagnosticsText,
  formatBytes,
  formatPool,
  formatUptime,
  formatWhen,
  watchmodeKeySummary,
  yesNo,
  type SystemInfo,
} from "@/lib/systemInfo";
import { watchmodeCacheSummary } from "@/lib/watchmodeCache";

/**
 * Settings → Info: what's running, what it's talking to, and how it's set up.
 *
 * Read-only by design. Everything here exists to answer "why isn't this
 * working?" without an SSH session — and the **Copy diagnostics** button turns
 * the whole page into text for a bug report, which is why the payload carries
 * no credentials (see lib/systemInfo.ts).
 */

/** One label/value row. `mono` for identifiers you'd compare character by character. */
function Row({
  label,
  value,
  mono,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  hint?: string;
}) {
  return (
    <>
      <dt title={hint}>{label}</dt>
      <dd className={mono ? "mono" : undefined}>{value === "" || value === null ? "—" : value}</dd>
    </>
  );
}

function InfoSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card info-card">
      <h3>{title}</h3>
      <dl className="kv">{children}</dl>
    </div>
  );
}

export function InfoCard() {
  const { data, error, mutate, isValidating } = useSWR<SystemInfo>(
    "/api/system",
    fetcher
  );
  const [copied, setCopied] = useState<"ok" | "err" | null>(null);

  const copy = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(buildDiagnosticsText(data));
      setCopied("ok");
    } catch {
      // Clipboard access needs a secure context; over plain HTTP it just fails.
      setCopied("err");
    }
    setTimeout(() => setCopied(null), 2500);
  };

  if (error) {
    const status = (error as { status?: number }).status;
    return (
      <div className="card">
        <div className="banner err">
          {status === 403
            ? "This account is not an administrator, so system info can't be shown."
            : `Couldn't load system info: ${(error as Error).message}`}
        </div>
        <button className="btn primary" onClick={() => mutate()}>
          Retry
        </button>
      </div>
    );
  }
  // Keyed on the data, not `isLoading`, so a Refresh redraws the numbers in
  // place instead of blanking the page back to "Loading…".
  if (!data) return <div className="card">Loading…</div>;

  const { app, database: db, library: lib, config: cfg, env } = data;

  return (
    <>
      <div className="card info-actions">
        <div>
          <strong>Diagnostics</strong>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            A read-only snapshot for troubleshooting. It contains no API keys or
            passwords, so it&rsquo;s safe to paste into a bug report.
          </p>
        </div>
        <div className="row" style={{ flex: "0 0 auto" }}>
          <button className="btn" onClick={() => mutate()} disabled={isValidating}>
            {isValidating ? "Refreshing…" : "Refresh"}
          </button>
          <button className="btn primary" onClick={copy}>
            {copied === "ok" ? "Copied ✓" : copied === "err" ? "Copy failed" : "Copy diagnostics"}
          </button>
        </div>
      </div>

      <InfoSection title="Application">
        <Row label="Version" value={app.version} mono />
        <Row label="Commit" value={app.commit || "—"} mono hint="Set when built by CI" />
        <Row label="Built" value={app.builtAt ? formatWhen(app.builtAt) : "—"} />
        <Row label="Next.js" value={app.nextVersion} mono />
        <Row label="Node" value={app.nodeVersion} mono />
        <Row label="Prisma" value={app.prismaVersion} mono />
        <Row label="Environment" value={app.environment} />
        <Row label="Platform" value={app.platform} />
        <Row label="Hostname" value={app.hostname} mono />
        <Row label="Time zone" value={`${app.timeZone} — ${formatWhen(app.serverTime)}`} />
        <Row label="Uptime" value={formatUptime(app.uptimeSeconds)} />
        <Row label="Memory (RSS)" value={formatBytes(app.memoryRssBytes)} />
      </InfoSection>

      <InfoSection title="Database">
        <Row
          label="Status"
          value={
            <span className={`badge ${db.reachable ? "mon" : "unmon"}`}>
              <span className="dot" />
              {db.reachable ? `Connected — ${db.latencyMs} ms` : "Unreachable"}
            </span>
          }
        />
        <Row label="Server" value={db.serverVersion ?? "—"} />
        <Row label="Host" value={db.host ?? "—"} mono />
        <Row label="Database" value={db.database ?? "—"} mono />
        <Row label="Schema" value={db.schema ?? "public"} mono />
        <Row label="Size" value={db.sizeBytes === null ? "—" : formatBytes(db.sizeBytes)} />
        <Row
          label="Connections"
          value={
            db.connectionsUsed === null
              ? "—"
              : `${db.connectionsUsed} of ${db.connectionsMax ?? "?"} server-wide`
          }
        />
        <Row
          label="Pool"
          hint="sized by connection_limit / pool_timeout in DATABASE_URL"
          value={formatPool(db)}
        />
        <Row
          label="Migrations"
          value={
            db.migrationsApplied === null
              ? "no _prisma_migrations table (schema pushed, not migrated)"
              : `${db.migrationsApplied} applied`
          }
        />
        <Row
          label="Latest migration"
          mono
          value={
            db.latestMigration
              ? `${db.latestMigration} (${formatWhen(db.latestMigrationAt)})`
              : "—"
          }
        />
        {db.error && <Row label="Error" value={<span className="err-text">{db.error}</span>} />}
      </InfoSection>

      <InfoSection title="Library">
        <Row label="TV shows" value={lib.tvShows.toLocaleString()} />
        <Row label="Movies" value={lib.movies.toLocaleString()} />
        <Row label="Episodes" value={lib.episodes.toLocaleString()} />
        <Row label="Title ID map rows" value={lib.titleMapRows.toLocaleString()} />
        <Row label="Users" value={`${lib.users} (${lib.admins} admin)`} />
        <Row label="Runs recorded" value={lib.runs.toLocaleString()} />
        <Row
          label="Last run"
          value={
            lib.lastRun
              ? `#${lib.lastRun.id} · ${lib.lastRun.kind.toLowerCase()} · ${lib.lastRun.status.toLowerCase()}` +
                `${lib.lastRun.dryRun ? " (dry-run)" : ""} · ${formatWhen(lib.lastRun.startedAt)}`
              : "never"
          }
        />
      </InfoSection>

      <InfoSection title="Configuration">
        {!cfg ? (
          <Row label="Settings" value={<span className="err-text">could not be read</span>} />
        ) : (
          <>
            <Row
              label="Mode"
              value={
                <span className={`badge ${cfg.applyChanges ? "unmon" : "mon"}`}>
                  <span className="dot" />
                  {cfg.applyChanges ? "LIVE" : "Dry-run"}
                </span>
              }
            />
            <Row label="Delete files" value={yesNo(cfg.deleteFiles)} />
            <Row label="Purge unmonitored files" value={yesNo(cfg.purgeUnmonitoredFiles)} />
            <Row label="Search at end" value={yesNo(cfg.searchAtEnd)} />
            <Row label="Remove missing TMDB movies" value={yesNo(cfg.removeMissingTmdbMovies)} />
            <Row
              label="Watchmode"
              value={`${watchmodeKeySummary(cfg)} · plan ${
                cfg.watchmodePlan ?? "unknown"
              } · ${cfg.countries} country/ies · ${cfg.serviceIds} service(s) · ${watchmodeCacheSummary(
                cfg.watchmodeCacheDays
              )}`}
            />
            <Row
              label="TMDB"
              value={`key ${cfg.tmdbApiKeySet ? "set" : "not set"} · ${cfg.tmdbRegions} region(s) · ${
                cfg.tmdbProviderIds
              } provider(s)`}
            />
            <Row label="Seerr" value={yesNo(cfg.seerrConfigured)} />
            <Row
              label="Connections"
              value={`${cfg.connections.sonarr} Sonarr · ${cfg.connections.radarr} Radarr${
                cfg.connections.disabled ? ` · ${cfg.connections.disabled} disabled` : ""
              }`}
            />
            <Row
              label="Scheduled sweeps"
              value={
                cfg.sweepScheduleEnabled
                  ? `every ${cfg.sweepIntervalHours}h · next ${formatWhen(
                      cfg.sweepNextRunAt
                    )} · last ${formatWhen(cfg.sweepLastRunAt)}`
                  : "off"
              }
            />
            <Row
              label="Webhook sweeps"
              hint="Sonarr/Radarr sweeping each title as it's added"
              value={
                cfg.webhookEnabled
                  ? `on · token ${cfg.webhookTokenSet ? "set" : "missing"} · ${
                      cfg.webhookQueued
                    } queued`
                  : "off"
              }
            />
            <Row label="Title ID map refreshed" value={formatWhen(cfg.titleMapSyncedAt)} />
            <Row label="Local login" value={yesNo(cfg.localLoginEnabled)} />
            <Row label="OIDC configured" value={yesNo(cfg.oidcConfigured)} />
            <Row
              label="Secrets readable"
              hint="Stored API keys decrypt with the current AUTH_SECRET"
              value={
                cfg.secretsUnreadable ? (
                  <span className="err-text">No — AUTH_SECRET appears to have changed</span>
                ) : (
                  "Yes"
                )
              }
            />
          </>
        )}
      </InfoSection>

      <InfoSection title="Environment">
        <Row label="PUBLIC_URL" value={env.publicUrl ?? "not set"} mono />
        <Row label="TRUST_PROXY" value={yesNo(env.trustProxy)} />
        <Row label="SSRF_ALLOW_PRIVATE" value={yesNo(env.ssrfAllowPrivate)} />
        <Row label="AUTH_COOKIE_INSECURE" value={yesNo(env.authCookieInsecure)} />
        <Row label="SYNC_CONCURRENCY" value={env.syncConcurrency} />
        <Row label="LOG_LEVEL" value={env.logLevel} mono />
        <Row label="Sweep scheduler" value={env.sweepSchedulerDisabled ? "disabled here" : "enabled"} />
        <Row
          label="Title map scheduler"
          value={env.titleMapSchedulerDisabled ? "disabled here" : "enabled"}
        />
      </InfoSection>

      {/* The one line worth reading without scrolling up — "what version am I
          on?" is the first question of most support threads. */}
      <p className="muted info-footer">
        <span>
          StreamSweeparr <strong>{app.version}</strong>
          {app.commit && <span className="mono"> · {app.commit}</span>}
        </span>
        <span>Collected {formatWhen(data.collectedAt)}</span>
      </p>
    </>
  );
}
