import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma, getSettings } from "@/lib/db";

export const dynamic = "force-dynamic";

const settingsSchema = z.object({
  watchmodeApiKey: z.string().nullable().optional(),
  seerrUrl: z.string().nullable().optional(),
  seerrApiKey: z.string().nullable().optional(),
  countries: z.array(z.string()).optional(),
  serviceIds: z.array(z.number().int()).optional(),
  countedTypes: z.array(z.string()).optional(),
  deleteFiles: z.boolean().optional(),
  searchAtEnd: z.boolean().optional(),
  applyChanges: z.boolean().optional(),
  // OIDC
  oidcEnabled: z.boolean().optional(),
  oidcIssuer: z.string().nullable().optional(),
  oidcClientId: z.string().nullable().optional(),
  oidcClientSecret: z.string().nullable().optional(),
  oidcScopes: z.string().optional(),
  oidcAuthUrl: z.string().nullable().optional(),
  oidcTokenUrl: z.string().nullable().optional(),
  oidcUserinfoUrl: z.string().nullable().optional(),
  oidcAllowedUsers: z.array(z.string()).optional(),
});

/** Mask secrets before returning to the client. */
function serialize(s: Awaited<ReturnType<typeof getSettings>>) {
  return {
    watchmodeApiKeySet: !!s.watchmodeApiKey,
    seerrUrl: s.seerrUrl ?? "",
    seerrApiKeySet: !!s.seerrApiKey,
    countries: s.countries,
    serviceIds: s.serviceIds,
    countedTypes: s.countedTypes,
    deleteFiles: s.deleteFiles,
    searchAtEnd: s.searchAtEnd,
    applyChanges: s.applyChanges,
    oidcEnabled: s.oidcEnabled,
    oidcIssuer: s.oidcIssuer ?? "",
    oidcClientId: s.oidcClientId ?? "",
    oidcClientSecretSet: !!s.oidcClientSecret,
    oidcScopes: s.oidcScopes,
    oidcAuthUrl: s.oidcAuthUrl ?? "",
    oidcTokenUrl: s.oidcTokenUrl ?? "",
    oidcUserinfoUrl: s.oidcUserinfoUrl ?? "",
    oidcAllowedUsers: s.oidcAllowedUsers,
    connections: s.connections.map((c) => ({
      id: c.id,
      type: c.type,
      name: c.name,
      baseUrl: c.baseUrl,
      enabled: c.enabled,
      origin: c.origin,
    })),
  };
}

export async function GET() {
  const s = await getSettings();
  return NextResponse.json(serialize(s));
}

export async function PATCH(req: NextRequest) {
  const body = await req.json();
  const parsed = settingsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  await getSettings(); // ensure row exists

  const data: Record<string, unknown> = {};
  const p = parsed.data;
  // Only overwrite secrets when a non-empty value is provided.
  if (p.watchmodeApiKey !== undefined && p.watchmodeApiKey !== null && p.watchmodeApiKey !== "")
    data.watchmodeApiKey = p.watchmodeApiKey;
  if (p.seerrUrl !== undefined) data.seerrUrl = p.seerrUrl || null;
  if (p.seerrApiKey !== undefined && p.seerrApiKey !== null && p.seerrApiKey !== "")
    data.seerrApiKey = p.seerrApiKey;
  if (p.countries !== undefined) data.countries = p.countries;
  if (p.serviceIds !== undefined) data.serviceIds = p.serviceIds;
  if (p.countedTypes !== undefined) data.countedTypes = p.countedTypes;
  if (p.deleteFiles !== undefined) data.deleteFiles = p.deleteFiles;
  if (p.searchAtEnd !== undefined) data.searchAtEnd = p.searchAtEnd;
  if (p.applyChanges !== undefined) data.applyChanges = p.applyChanges;
  // OIDC (only overwrite the secret when a non-empty value is provided).
  if (p.oidcEnabled !== undefined) data.oidcEnabled = p.oidcEnabled;
  if (p.oidcIssuer !== undefined) data.oidcIssuer = p.oidcIssuer || null;
  if (p.oidcClientId !== undefined) data.oidcClientId = p.oidcClientId || null;
  if (p.oidcClientSecret !== undefined && p.oidcClientSecret !== null && p.oidcClientSecret !== "")
    data.oidcClientSecret = p.oidcClientSecret;
  if (p.oidcScopes !== undefined) data.oidcScopes = p.oidcScopes || "openid profile email";
  if (p.oidcAuthUrl !== undefined) data.oidcAuthUrl = p.oidcAuthUrl || null;
  if (p.oidcTokenUrl !== undefined) data.oidcTokenUrl = p.oidcTokenUrl || null;
  if (p.oidcUserinfoUrl !== undefined) data.oidcUserinfoUrl = p.oidcUserinfoUrl || null;
  if (p.oidcAllowedUsers !== undefined) data.oidcAllowedUsers = p.oidcAllowedUsers;

  await prisma.settings.update({ where: { id: 1 }, data });
  const s = await getSettings();
  return NextResponse.json(serialize(s));
}
