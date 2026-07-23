import { NextRequest, NextResponse } from "next/server";
import { getSettings } from "@/lib/db";
import { WatchmodeClient } from "@/lib/watchmode";
import { requireAdmin, withGuard } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Streaming services for the requested (or selected) countries, grouped by
 * country, alphabetical, each with its logo. Query: ?countries=US,GB
 */
export const GET = withGuard(requireAdmin, async (_session, req: NextRequest) => {
  const s = await getSettings();
  if (!s.watchmodeApiKey) {
    return NextResponse.json({ error: "Watchmode API key not configured." }, { status: 400 });
  }
  const param = req.nextUrl.searchParams.get("countries");
  const countries = (param ? param.split(",") : s.countries).filter(Boolean);
  if (!countries.length) {
    return NextResponse.json({ groups: [] });
  }

  try {
    const wm = new WatchmodeClient(s.watchmodeApiKey);
    const all = await wm.sources(countries);

    // Build per-country groups. A source appears in a country if its `regions`
    // array contains that country code.
    const groups = countries.map((cc) => {
      const services = all
        .filter((src) => (src.regions ?? []).includes(cc))
        .map((src) => ({
          id: src.id,
          name: src.name,
          type: src.type,
          logo: src.logo_100px ?? null,
        }))
        // De-dupe by id (a service can appear once per type).
        .reduce<Record<number, { id: number; name: string; type: string; logo: string | null }>>(
          (acc, cur) => {
            if (!acc[cur.id]) acc[cur.id] = cur;
            return acc;
          },
          {}
        );
      return {
        country: cc,
        services: Object.values(services).sort((a, b) => a.name.localeCompare(b.name)),
      };
    });

    return NextResponse.json({ groups });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
});
