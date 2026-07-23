import { NextResponse } from "next/server";
import { prisma, getSettings } from "@/lib/db";
import { SeerrClient } from "@/lib/arr";

export const dynamic = "force-dynamic";

// Discover Sonarr/Radarr instances from the configured Seerr server and
// upsert them as connections (origin = "seerr").
export async function POST() {
  const s = await getSettings();
  if (!s.seerrUrl || !s.seerrApiKey) {
    return NextResponse.json({ error: "Seerr URL / API key not configured." }, { status: 400 });
  }
  try {
    const seerr = new SeerrClient(s.seerrUrl, s.seerrApiKey);
    const [sonarr, radarr] = await Promise.all([seerr.getSonarr(), seerr.getRadarr()]);
    let added = 0;

    for (const inst of sonarr) {
      if (!inst.baseUrl || !inst.apiKey) continue;
      await prisma.arrConnection.upsert({
        where: { type_baseUrl: { type: "SONARR", baseUrl: inst.baseUrl } },
        create: { type: "SONARR", name: inst.name, baseUrl: inst.baseUrl, apiKey: inst.apiKey, origin: "seerr", settingsId: 1 },
        update: { name: inst.name, apiKey: inst.apiKey, origin: "seerr" },
      });
      added++;
    }
    for (const inst of radarr) {
      if (!inst.baseUrl || !inst.apiKey) continue;
      await prisma.arrConnection.upsert({
        where: { type_baseUrl: { type: "RADARR", baseUrl: inst.baseUrl } },
        create: { type: "RADARR", name: inst.name, baseUrl: inst.baseUrl, apiKey: inst.apiKey, origin: "seerr", settingsId: 1 },
        update: { name: inst.name, apiKey: inst.apiKey, origin: "seerr" },
      });
      added++;
    }

    return NextResponse.json({ ok: true, discovered: added });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
