import { NextResponse } from "next/server";
import { getSettings } from "@/lib/db";
import { TmdbClient } from "@/lib/tmdb";
import { flagEmoji } from "@/lib/flags";
import { requireAdmin, withGuard } from "@/lib/auth";

export const dynamic = "force-dynamic";

// TMDB watch-provider regions, alphabetical, with flags.
export const GET = withGuard(requireAdmin, async () => {
  const s = await getSettings();
  if (!s.tmdbApiKey) {
    return NextResponse.json({ error: "TMDB API key not configured." }, { status: 400 });
  }
  try {
    const tmdb = new TmdbClient(s.tmdbApiKey);
    const regions = await tmdb.regions();
    const list = regions
      .map((r) => ({ code: r.iso_3166_1, name: r.english_name, flag: flagEmoji(r.iso_3166_1) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return NextResponse.json({ regions: list });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
});
