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
import { providerSearchUrl } from "./providerSites";
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
  tmdbId: number | null;
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
        tmdbId: true,
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
      tmdbId: s.tmdbId,
      // Link each logo to the show on that service, preferring Watchmode's
      // `web_url` deep link. `ios_url`/`android_url` are deliberately ignored:
      // they're app-scheme links a browser can't open.
      services: dedupeServices(s.streamingInfo, tmdbWatchUrl("tv", s.tmdbId), s.title),
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
    // Movie availability comes from TMDB, which gives no per-provider link, so
    // every logo here resolves through the service search / TMDB fallbacks.
    services: dedupeServices(m.streamingInfo, tmdbWatchUrl("movie", m.tmdbId), m.title),
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
 *
 * The link is resolved in descending order of usefulness, so a logo is only
 * left unlinked when we have nothing at all to point it at:
 *  1. the stored deep link to the title on that service (Watchmode `web_url`);
 *  2. that service's own search page for `title` — one click from the title,
 *     and still on the service the badge claims it's streaming on;
 *  3. `fallbackUrl` — the TMDB "where to watch" page, which at least lists the
 *     providers — for services we have no known search URL for.
 */
export function dedupeServices(
  info: unknown,
  fallbackUrl: string | null = null,
  title = ""
): DashboardService[] {
  if (!Array.isArray(info)) return [];
  const seen = new Set<string>();
  const out: DashboardService[] = [];
  for (const s of info as {
    name: string;
    type: string;
    region?: string | null;
    logo?: string | null;
    webUrl?: string | null;
  }[]) {
    if (!s?.name || seen.has(s.name)) continue;
    seen.add(s.name);
    out.push({
      name: s.name,
      type: s.type,
      logo: s.logo ?? null,
      url:
        // Guard against non-URL values already persisted by earlier syncs.
        sanitizeExternalUrl(s.webUrl) ??
        providerSearchUrl(s.name, title, s.region) ??
        fallbackUrl,
    });
  }
  return out;
}
