import { NextRequest, NextResponse } from "next/server";
import { refreshTitleMap } from "@/lib/titlemap";
import { getSettings } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Current Title ID map status.
export async function GET() {
  const s = await getSettings();
  return NextResponse.json({
    syncedAt: s.titleMapSyncedAt,
    etag: s.titleMapEtag,
    lastModified: s.titleMapLastModified,
    rowCount: s.titleMapRowCount,
  });
}

// Manually refresh the Title ID map. POST { "force": true } to bypass the 12h
// window and the etag short-circuit.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  try {
    const result = await refreshTitleMap({ force: !!body?.force });
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
