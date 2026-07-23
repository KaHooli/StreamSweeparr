import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma, getSettings } from "@/lib/db";
import { requireAdmin, withGuard } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Accepts an http(s) URL, or an empty string / null (to clear the value).
const urlOrEmpty = z
  .string()
  .nullable()
  .optional()
  .refine(
    (v) => !v || /^https?:\/\/.+/i.test(v),
    "Must be an http(s) URL."
  );

const COUNTED_TYPES = ["sub", "free", "purchase", "rent", "tv_everywhere"] as const;
const TMDB_COUNTED_TYPES = ["flatrate", "free", "ads", "rent", "buy"] as const;

const settingsSchema = z.object({
  watchmodeApiKey: z.string().nullable().optional(),
  seerrUrl: urlOrEmpty,
  seerrApiKey: z.string().nullable().optional(),
  countries: z.array(z.string().regex(/^[A-Za-z]{2}$/, "Invalid country code.")).optional(),
  serviceIds: z.array(z.number().int().positive()).optional(),
  countedTypes: z.array(z.enum(COUNTED_TYPES)).optional(),
  // TMDB (movies)
  tmdbApiKey: z.string().nullable().optional(),
  tmdbRegions: z.array(z.string().regex(/^[A-Za-z]{2}$/, "Invalid region code.")).optional(),
  tmdbProviderIds: z.array(z.number().int().positive()).optional(),
  tmdbCountedTypes: z.array(z.enum(TMDB_COUNTED_TYPES)).optional(),
  deleteFiles: z.boolean().optional(),
  searchAtEnd: z.boolean().optional(),
  applyChanges: z.boolean().optional(),
  // OIDC
  oidcEnabled: z.boolean().optional(),
  oidcIssuer: urlOrEmpty,
  oidcClientId: z.string().nullable().optional(),
  oidcClientSecret: z.string().nullable().optional(),
  oidcScopes: z.string().optional(),
  oidcAuthUrl: urlOrEmpty,
  oidcTokenUrl: urlOrEmpty,
  oidcUserinfoUrl: urlOrEmpty,
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
    tmdbApiKeySet: !!s.tmdbApiKey,
    tmdbRegions: s.tmdbRegions,
    tmdbProviderIds: s.tmdbProviderIds,
    tmdbCountedTypes: s.tmdbCountedTypes,
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

export const GET = withGuard(requireAdmin, async () => {
  const s = await getSettings();
  return NextResponse.json(serialize(s));
});

export const PATCH = withGuard(requireAdmin, async (_session, req: NextRequest) => {
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
  // TMDB (movies)
  if (p.tmdbApiKey !== undefined && p.tmdbApiKey !== null && p.tmdbApiKey !== "")
    data.tmdbApiKey = p.tmdbApiKey;
  if (p.tmdbRegions !== undefined) data.tmdbRegions = p.tmdbRegions;
  if (p.tmdbProviderIds !== undefined) data.tmdbProviderIds = p.tmdbProviderIds;
  if (p.tmdbCountedTypes !== undefined) data.tmdbCountedTypes = p.tmdbCountedTypes;
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
});
