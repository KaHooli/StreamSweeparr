import { NextRequest, NextResponse } from "next/server";
import { getSettings } from "@/lib/db";
import { TmdbClient, TMDB_IMAGE_BASE } from "@/lib/tmdb";
import { requireAdmin, withGuard } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Movie providers for the requested (or selected) regions, grouped by region,
 * alphabetical, each with its logo. Query: ?regions=US,GB
 */
export const GET = withGuard(requireAdmin, async (_session, req: NextRequest) => {
  const s = await getSettings();
  if (!s.tmdbApiKey) {
    return NextResponse.json({ error: "TMDB API key not configured." }, { status: 400 });
  }
  const param = req.nextUrl.searchParams.get("regions");
  const regions = (param ? param.split(",") : s.tmdbRegions).filter(Boolean);
  if (!regions.length) {
    return NextResponse.json({ groups: [] });
  }

  try {
    const tmdb = new TmdbClient(s.tmdbApiKey);
    const groups = await Promise.all(
      regions.map(async (region) => {
        const providers = await tmdb.movieProviders(region);
        const services = providers
          .map((p) => ({
            id: p.provider_id,
            name: p.provider_name,
            logo: p.logo_path ? `${TMDB_IMAGE_BASE}${p.logo_path}` : null,
            priority: p.display_priorities?.[region] ?? p.display_priority ?? 9999,
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return { region, services };
      })
    );
    return NextResponse.json({ groups });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
});
