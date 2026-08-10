import Link from "next/link";
import { getSettings } from "@/lib/db";
import { getDashboardData } from "@/lib/dashboard";
import { setupStatus } from "@/lib/setupState";
import { DashboardBrowser } from "@/components/DashboardBrowser";
import { RunControls } from "@/components/RunControls";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const settings = await getSettings();
  // Per media type, mirroring what runSync actually validates — a Radarr-only
  // install needs whichever provider answers for movies, and nothing else.
  // See lib/setupState.ts.
  const setup = setupStatus(settings);

  if (!setup.ready) {
    return (
      <main>
        <div className="banner warn">
          Finish setup to start sweeping. You still need{" "}
          {setup.missing.map((item, i) => (
            <span key={item}>
              {i > 0 ? (i === setup.missing.length - 1 ? " and " : ", ") : ""}
              {item}
            </span>
          ))}
          .
        </div>
        <div className="empty card">
          <div className="big">≋</div>
          <h2>Welcome to StreamSweeparr</h2>
          <p className="muted">
            Connect your services and pick the streaming providers you subscribe to. StreamSweeparr
            will unmonitor &amp; delete anything already on streaming, re-monitor anything that
            leaves, and search the rest.
          </p>
          <div style={{ marginTop: 16 }}>
            <Link href="/settings" className="btn primary">
              Open Settings →
            </Link>
          </div>
        </div>
      </main>
    );
  }

  const data = await getDashboardData();

  return (
    <main>
      <div className="stats">
        <div className="stat">
          <div className="label">
            <a href="#tv-on-streaming" className="stat-link">
              TV on streaming
            </a>
          </div>
          <div className="value">{data.tvShows.length}</div>
        </div>
        <div className="stat">
          <div className="label">
            <a href="#movies-on-streaming" className="stat-link">
              Movies on streaming
            </a>
          </div>
          <div className="value">{data.movies.length}</div>
        </div>
        <div className="stat">
          <div className="label">Total library</div>
          <div className="value">{data.counts.tv + data.counts.movies}</div>
        </div>
        <div className="stat">
          <div className="label">Mode</div>
          <div className="value" style={{ fontSize: 20, color: settings.applyChanges ? "var(--danger)" : "var(--ok)" }}>
            {settings.applyChanges ? "LIVE" : "Dry-run"}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <RunControls applyChanges={settings.applyChanges} />
        <p className="muted" style={{ margin: 0 }}>
          {settings.applyChanges
            ? "LIVE mode: changes are applied to Sonarr/Radarr and files may be deleted."
            : "Dry-run: the sweep only previews actions. Enable LIVE mode in Settings to apply."}
          {data.lastRun && (
            <>
              {" · "}Last run: <Link href="/runs">#{data.lastRun.id} ({data.lastRun.status})</Link>
            </>
          )}
        </p>
      </div>

      <DashboardBrowser tvShows={data.tvShows} movies={data.movies} />
    </main>
  );
}
