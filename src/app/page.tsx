import Link from "next/link";
import { headers } from "next/headers";
import { getSettings } from "@/lib/db";
import { Poster } from "@/components/Poster";
import { RunControls } from "@/components/RunControls";

export const dynamic = "force-dynamic";

interface TvShow {
  id: number;
  title: string;
  year: number | null;
  posterUrl: string | null;
  monitored: boolean;
  totalEpisodes: number;
  monitoredEpisodes: number;
  unmonitoredEpisodes: number;
  streamingEpisodes: number;
  unmonitoredPct: number;
  services: { name: string; type: string }[];
}
interface Movie {
  id: number;
  title: string;
  year: number | null;
  posterUrl: string | null;
  monitored: boolean;
  hasFile: boolean;
  services: { name: string; type: string }[];
}
interface DashboardData {
  tvShows: TvShow[];
  movies: Movie[];
  counts: { movies: number; tv: number };
  lastRun: { id: number; status: string; startedAt: string; dryRun: boolean } | null;
}

async function getData(): Promise<DashboardData> {
  const h = headers();
  const host = h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  // Forward the session cookie so the auth middleware lets this internal
  // server-to-server request through.
  const cookie = h.get("cookie") ?? "";
  const res = await fetch(`${proto}://${host}/api/dashboard`, {
    cache: "no-store",
    headers: { cookie },
  });
  return res.json();
}

export default async function DashboardPage() {
  const settings = await getSettings();
  const configured =
    !!settings.watchmodeApiKey &&
    settings.countries.length > 0 &&
    settings.serviceIds.length > 0 &&
    settings.connections.some((c) => c.enabled);

  if (!configured) {
    return (
      <main>
        <div className="banner warn">
          Finish setup to start sweeping. You need a Watchmode API key, at least one country and
          streaming service, and one Sonarr/Radarr connection.
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

  const data = await getData();

  return (
    <main>
      <div className="stats">
        <div className="stat">
          <div className="label">TV on streaming</div>
          <div className="value">{data.tvShows.length}</div>
        </div>
        <div className="stat">
          <div className="label">Movies on streaming</div>
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

      {/* -------- TV shows -------- */}
      <div className="section-title">
        <h2>TV shows on streaming</h2>
        <span className="count">{data.tvShows.length} shows</span>
      </div>
      {data.tvShows.length === 0 ? (
        <div className="empty card">No TV episodes found on your selected services yet. Run a sync.</div>
      ) : (
        <div className="grid">
          {data.tvShows.map((s) => (
            <div className="poster-card" key={s.id}>
              <Poster src={s.posterUrl} title={s.title} />
              <div className="poster-body">
                <p className="poster-title">{s.title}</p>
                <span className="poster-year">{s.year ?? ""}</span>
                <div className="progress">
                  <div className="row">
                    <span>{s.unmonitoredEpisodes} unmonitored</span>
                    <span>{s.unmonitoredPct}%</span>
                  </div>
                  <div className="track">
                    <div className="fill" style={{ width: `${s.unmonitoredPct}%` }} />
                  </div>
                  <div className="row" style={{ marginTop: 4 }}>
                    <span>
                      {s.streamingEpisodes}/{s.totalEpisodes} on streaming
                    </span>
                  </div>
                </div>
                <div className="chips">
                  {s.services.slice(0, 3).map((sv) => (
                    <span className="chip" key={sv.name}>
                      {sv.name}
                    </span>
                  ))}
                  {s.services.length > 3 && <span className="chip">+{s.services.length - 3}</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* -------- Movies -------- */}
      <div className="section-title">
        <h2>Movies on streaming</h2>
        <span className="count">{data.movies.length} movies</span>
      </div>
      {data.movies.length === 0 ? (
        <div className="empty card">No movies found on your selected services yet. Run a sync.</div>
      ) : (
        <div className="grid">
          {data.movies.map((m) => (
            <div className="poster-card" key={m.id}>
              <Poster src={m.posterUrl} title={m.title} />
              <div className="poster-body">
                <p className="poster-title">{m.title}</p>
                <span className="poster-year">{m.year ?? ""}</span>
                <div>
                  <span className={`badge ${m.monitored ? "unmon" : "mon"}`}>
                    <span className="dot" />
                    {m.monitored ? "Monitored" : "Unmonitored"}
                  </span>
                </div>
                <div className="chips">
                  {m.services.slice(0, 3).map((sv) => (
                    <span className="chip" key={sv.name}>
                      {sv.name}
                    </span>
                  ))}
                  {m.services.length > 3 && <span className="chip">+{m.services.length - 3}</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
