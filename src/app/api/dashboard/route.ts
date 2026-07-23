import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession, withGuard } from "@/lib/auth";

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
      services: dedupeServices(s.streamingInfo),
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
    services: dedupeServices(m.streamingInfo),
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

function dedupeServices(info: unknown): { name: string; type: string }[] {
  if (!Array.isArray(info)) return [];
  const seen = new Set<string>();
  const out: { name: string; type: string }[] = [];
  for (const s of info as { name: string; type: string }[]) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    out.push({ name: s.name, type: s.type });
  }
  return out;
}
