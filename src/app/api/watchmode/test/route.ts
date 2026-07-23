import { NextRequest, NextResponse } from "next/server";
import { WatchmodeClient } from "@/lib/watchmode";
import { getSettings } from "@/lib/db";

export const dynamic = "force-dynamic";

// Verify a Watchmode API key (from body, else saved) and return quota.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  let key = body?.apiKey as string | undefined;
  if (!key) {
    const s = await getSettings();
    key = s.watchmodeApiKey ?? undefined;
  }
  if (!key) return NextResponse.json({ error: "No API key provided." }, { status: 400 });
  try {
    const wm = new WatchmodeClient(key);
    const status = await wm.status();
    return NextResponse.json({ ok: true, ...status });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 });
  }
}
