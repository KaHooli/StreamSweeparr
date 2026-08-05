/**
 * Dashboard data assembly.
 *
 * Lives here rather than in the route handler so the server-rendered page and
 * `GET /api/dashboard` share one implementation, and so the page can query
 * directly instead of making an HTTP request to itself — a self-request has to
 * guess its own address from the `Host` header and round-trip the caller's
 * cookie back through the auth middleware, both of which break behind a proxy
 * that rewrites Host.
 */
import { prisma } from "./db";
import { sanitizeExternalUrl, tmdbWatchUrl } from "./urls";

export interface DashboardService {
  name: string;
  type: string;
  logo: string | null;
  /** Deep link to the title on that service, when we have one. */
  url: string | null;
}

export interface DashboardTvShow {
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
  services: DashboardService[];
  lastSyncedAt: Date;
}

export interface DashboardMovie {
  id: number;
  title: string;
  year: number | null;
  posterUrl: string | null;
  monitored: boolean;
  hasFile: boolean;
  tmdbId: number | null;
  services: DashboardService[];
  lastSyncedAt: Date;
}

export interface DashboardData {
  tvShows: DashboardTvShow[];
  movies: DashboardMovie[];
  counts: { movies: number; tv: number };
  lastRun: {
    id: number;
    status: string;
    startedAt: Date;
    dryRun: boolean;
  } | null;
}

/**
 * Home screen data:
 *  - TV shows that have any episode on streaming, with unmonitored %.
 *  - Movies on streaming, with monitored/unmonitored flag.
 */
export async function getDashboardData(): Promise<DashboardData> {
  const [tv, movies, lastRun, totals] = await Promise.all([
    prisma.mediaItem.findMany({
      where: { type: "TV", onStreaming: true },
      orderBy: { title: "asc" },
      select: {
        id: true,
        title: true,
        year: true,
        posterUrl: true,
        monitored: true,
        totalEpisodes: true,
        monitoredEpisodes: true,
        streamingEpisodes: true,
        streamingInfo: true,
        lastSyncedAt: true,
      },
    }),
    prisma.mediaItem.findMany({
      where: { type: "MOVIE", onStreaming: true },
      orderBy: { title: "asc" },
      select: {
        id: true,
        title: true,
        year: true,
        posterUrl: true,
        monitored: true,
        hasFile: true,
        tmdbId: true,
        streamingInfo: true,
        lastSyncedAt: true,
      },
    }),
    prisma.runLog.findFirst({
      orderBy: { startedAt: "desc" },
      select: { id: true, status: true, startedAt: true, dryRun: true },
    }),
    prisma.mediaItem.groupBy({
      by: ["type"],
      _count: { _all: true },
    }),
  ]);

  const tvShows: DashboardTvShow[] = tv.map((s) => {
    const unmonitored = Math.max(0, s.totalEpisodes - s.monitoredEpisodes);
    const unmonitoredPct = s.totalEpisodes ? Math.round((unmonitored / s.totalEpisodes) * 100) : 0;
    return {
      id: s.id,
      title: s.title,
      year: s.year,
      posterUrl: s.posterUrl,
      monitored: s.monitored,
      totalEpisodes: s.totalEpisodes,
      monitoredEpisodes: s.monitoredEpisodes,
      unmonitoredEpisodes: unmonitored,
      streamingEpisodes: s.streamingEpisodes,
      unmonitoredPct,
      // Link each logo to the show on that service using Watchmode's `web_url`
      // and nothing else: `ios_url`/`android_url` are app-scheme links a browser
      // can't open, and a TMDB "where to watch" page isn't the service. A source
      // Watchmode gives us no link for renders as a plain (unlinked) logo.
      services: dedupeServices(s.streamingInfo),
      lastSyncedAt: s.lastSyncedAt,
    };
  });

  const movieList: DashboardMovie[] = movies.map((m) => ({
    id: m.id,
    title: m.title,
    year: m.year,
    posterUrl: m.posterUrl,
    monitored: m.monitored,
    hasFile: m.hasFile,
    tmdbId: m.tmdbId,
    // Movie availability comes from TMDB, so link each provider logo to TMDB's
    // "where to watch" page for the title.
    services: dedupeServices(m.streamingInfo, tmdbWatchUrl("movie", m.tmdbId)),
    lastSyncedAt: m.lastSyncedAt,
  }));

  return {
    tvShows,
    movies: movieList,
    counts: {
      movies: totals.find((t) => t.type === "MOVIE")?._count._all ?? 0,
      tv: totals.find((t) => t.type === "TV")?._count._all ?? 0,
    },
    lastRun,
  };
}

/**
 * One entry per streaming service, with its logo and a link to the title.
 * `fallbackUrl` is used when the stored entry has no deep link of its own
 * (TMDB gives us availability but not per-provider links).
 */
export function dedupeServices(
  info: unknown,
  fallbackUrl: string | null = null
): DashboardService[] {
  if (!Array.isArray(info)) return [];
  const seen = new Set<string>();
  const out: DashboardService[] = [];
  for (const s of info as {
    name: string;
    type: string;
    logo?: string | null;
    webUrl?: string | null;
  }[]) {
    if (!s?.name || seen.has(s.name)) continue;
    seen.add(s.name);
    out.push({
      name: s.name,
      type: s.type,
      logo: s.logo ?? null,
      // Guard against non-URL values already persisted by earlier syncs.
      url: sanitizeExternalUrl(s.webUrl) ?? fallbackUrl,
    });
  }
  return out;
}
