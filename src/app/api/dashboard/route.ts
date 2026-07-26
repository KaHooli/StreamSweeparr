import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession, withGuard } from "@/lib/auth";
import { sanitizeExternalUrl, tmdbWatchUrl } from "@/lib/urls";

export const dynamic = "force-dynamic";

/**
 * Home screen data:
 *  - TV shows that have any episode on streaming, with unmonitored %.
 *  - Movies on streaming, with monitored/unmonitored flag.
 */
export const GET = withGuard(requireSession, async () => {
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
        tmdbId: true,
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
    prisma.runLog.findFirst({ orderBy: { startedAt: "desc" } }),
    prisma.mediaItem.groupBy({
      by: ["type"],
      _count: { _all: true },
    }),
  ]);

  const tvShows = tv.map((s) => {
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
      // Prefer Watchmode's per-provider deep link; fall back to TMDB's
      // "where to watch" page (free Watchmode plans don't return episode links).
      services: dedupeServices(s.streamingInfo, tmdbWatchUrl("tv", s.tmdbId)),
      lastSyncedAt: s.lastSyncedAt,
    };
  });

  const movieList = movies.map((m) => ({
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

  const counts = {
    movies: totals.find((t) => t.type === "MOVIE")?._count._all ?? 0,
    tv: totals.find((t) => t.type === "TV")?._count._all ?? 0,
  };

  return NextResponse.json({
    tvShows,
    movies: movieList,
    counts,
    lastRun,
  });
});

interface ServiceOut {
  name: string;
  type: string;
  logo: string | null;
  /** Deep link to the title on that service, when we have one. */
  url: string | null;
}

/**
 * One entry per streaming service, with its logo and a link to the title.
 * `fallbackUrl` is used when the stored entry has no deep link of its own
 * (TMDB gives us availability but not per-provider links).
 */
function dedupeServices(info: unknown, fallbackUrl: string | null = null): ServiceOut[] {
  if (!Array.isArray(info)) return [];
  const seen = new Set<string>();
  const out: ServiceOut[] = [];
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
