import { NextResponse } from "next/server";
import { getSettings } from "@/lib/db";
import { WatchmodeClient } from "@/lib/watchmode";
import { flagEmoji } from "@/lib/flags";
import { requireAdmin, withGuard } from "@/lib/auth";

export const dynamic = "force-dynamic";

// All countries supported by Watchmode, alphabetical, with flags.
export const GET = withGuard(requireAdmin, async () => {
  const s = await getSettings();
  if (!s.watchmodeApiKeys.length) {
    return NextResponse.json({ error: "Watchmode API key not configured." }, { status: 400 });
  }
  try {
    const wm = new WatchmodeClient(s.watchmodeApiKeys);
    const regions = await wm.regions();
    const list = regions
      .map((r) => ({ code: r.country, name: r.name, flag: flagEmoji(r.country) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return NextResponse.json({ regions: list });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
});
