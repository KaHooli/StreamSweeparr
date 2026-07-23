import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma, getSettings } from "@/lib/db";
import { SonarrClient, RadarrClient } from "@/lib/arr";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  type: z.enum(["SONARR", "RADARR"]),
  name: z.string().min(1),
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  enabled: z.boolean().optional(),
});

export async function GET() {
  const connections = await prisma.arrConnection.findMany({ orderBy: { id: "asc" } });
  return NextResponse.json({
    connections: connections.map((c) => ({
      id: c.id,
      type: c.type,
      name: c.name,
      baseUrl: c.baseUrl,
      enabled: c.enabled,
      origin: c.origin,
    })),
  });
}

export async function POST(req: NextRequest) {
  const parsed = createSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  await getSettings();
  const { type, name, baseUrl, apiKey, enabled } = parsed.data;

  // Validate the connection before saving.
  try {
    if (type === "SONARR") await new SonarrClient(baseUrl, apiKey).ping();
    else await new RadarrClient(baseUrl, apiKey).ping();
  } catch (e) {
    return NextResponse.json({ error: `Could not connect: ${(e as Error).message}` }, { status: 502 });
  }

  const conn = await prisma.arrConnection.upsert({
    where: { type_baseUrl: { type, baseUrl } },
    create: { type, name, baseUrl, apiKey, enabled: enabled ?? true, origin: "manual", settingsId: 1 },
    update: { name, apiKey, enabled: enabled ?? true },
  });

  return NextResponse.json({ id: conn.id });
}
