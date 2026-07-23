import { NextRequest, NextResponse } from "next/server";
import { TmdbClient } from "@/lib/tmdb";
import { getSettings } from "@/lib/db";
import { requireAdmin, withGuard } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Verify a TMDB API key (from body, else saved).
export const POST = withGuard(requireAdmin, async (_session, req: NextRequest) => {
  const body = await req.json().catch(() => ({}));
  let key = body?.apiKey as string | undefined;
  if (!key) {
    const s = await getSettings();
    key = s.tmdbApiKey ?? undefined;
  }
  if (!key) return NextResponse.json({ error: "No API key provided." }, { status: 400 });
  try {
    const tmdb = new TmdbClient(key);
    await tmdb.validate();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 });
  }
});
