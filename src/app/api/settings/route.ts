import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma, getSettings, getRawSettings } from "@/lib/db";
import { hasUnreadableSecret, encryptSettingsData } from "@/lib/secrets";
import { requireAdmin, withGuard } from "@/lib/auth";
import {
  effectiveLocalLoginEnabled,
  localLoginToggleLocked,
  DEFAULT_SSO_BUTTON_LABEL,
} from "@/lib/loginOptions";
import {
  watchmodeKeyEntriesSchema,
  resolveWatchmodeKeyEntries,
  normalizeWatchmodeKeys,
  WatchmodeKeyEntryError,
  MAX_WATCHMODE_KEYS,
} from "@/lib/watchmodeKeys";
import {
  MIN_SWEEP_INTERVAL_HOURS,
  MAX_SWEEP_INTERVAL_HOURS,
  SWEEP_INTERVAL_CHOICES,
  nextRunAfterChange,
  schedulerDisabledByEnv,
} from "@/lib/schedule";
import { generateWebhookToken } from "@/lib/webhook";
import { settleMs } from "@/lib/sweepQueue";

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
  // Legacy single-key form: sets (or replaces) key 1 and leaves the rest alone.
  watchmodeApiKey: z.string().nullable().optional(),
  // The Watchmode key ring in full — see lib/watchmodeKeys.ts for why an entry
  // can refer to a stored key by position instead of carrying its value.
  watchmodeApiKeys: watchmodeKeyEntriesSchema.optional(),
  seerrUrl: urlOrEmpty,
  seerrApiKey: z.string().nullable().optional(),
  countries: z.array(z.string().regex(/^[A-Za-z]{2}$/, "Invalid country code.")).optional(),
  serviceIds: z.array(z.number().int().positive()).optional(),
  countedTypes: z.array(z.enum(COUNTED_TYPES)).optional(),
  // Which provider answers movie availability. TV is always Watchmode.
  movieProvider: z.enum(["TMDB", "WATCHMODE"]).optional(),
  // TMDB (movies, unless movieProvider says Watchmode)
  tmdbApiKey: z.string().nullable().optional(),
  tmdbRegions: z.array(z.string().regex(/^[A-Za-z]{2}$/, "Invalid region code.")).optional(),
  tmdbProviderIds: z.array(z.number().int().positive()).optional(),
  tmdbCountedTypes: z.array(z.enum(TMDB_COUNTED_TYPES)).optional(),
  deleteFiles: z.boolean().optional(),
  purgeUnmonitoredFiles: z.boolean().optional(),
  searchAtEnd: z.boolean().optional(),
  removeMissingTmdbMovies: z.boolean().optional(),
  applyChanges: z.boolean().optional(),
  // Scheduled sweeps.
  sweepScheduleEnabled: z.boolean().optional(),
  sweepIntervalHours: z
    .number()
    .int("Interval must be a whole number of hours.")
    .min(MIN_SWEEP_INTERVAL_HOURS, `Interval must be at least ${MIN_SWEEP_INTERVAL_HOURS} hour.`)
    .max(MAX_SWEEP_INTERVAL_HOURS, `Interval must be at most ${MAX_SWEEP_INTERVAL_HOURS} hours.`)
    .optional(),
  // Webhook-triggered sweeps. The token is never sent by the client: it is
  // minted here when the feature is switched on, and replaced on request.
  webhookEnabled: z.boolean().optional(),
  regenerateWebhookToken: z.boolean().optional(),
  localLoginEnabled: z.boolean().optional(),
  // OIDC
  oidcEnabled: z.boolean().optional(),
  oidcButtonLabel: z.string().max(64, "Label must be at most 64 characters.").nullable().optional(),
  oidcIssuer: urlOrEmpty,
  oidcClientId: z.string().nullable().optional(),
  oidcClientSecret: z.string().nullable().optional(),
  oidcScopes: z.string().optional(),
  oidcAuthUrl: urlOrEmpty,
  oidcTokenUrl: urlOrEmpty,
  oidcUserinfoUrl: urlOrEmpty,
  oidcAllowedUsers: z.array(z.string()).optional(),
});

/**
 * Mask secrets before returning to the client.
 *
 * `secretsUnreadable` distinguishes "no key configured" from "a key is stored
 * but cannot be decrypted" — the latter means AUTH_SECRET changed, and without
 * saying so the keys simply appear to have vanished.
 */
function serialize(
  s: Awaited<ReturnType<typeof getSettings>>,
  secretsUnreadable = false
) {
  return {
    secretsUnreadable,
    watchmodeApiKeySet: !!s.watchmodeApiKey,
    // How many keys are in the ring. The values never leave the server; the
    // Settings card renders one numbered (masked) field per stored key.
    watchmodeApiKeyCount: s.watchmodeApiKeys.length,
    watchmodeApiKeyMax: MAX_WATCHMODE_KEYS,
    watchmodePlan: s.watchmodePlan ?? null,
    seerrUrl: s.seerrUrl ?? "",
    seerrApiKeySet: !!s.seerrApiKey,
    countries: s.countries,
    serviceIds: s.serviceIds,
    countedTypes: s.countedTypes,
    movieProvider: s.movieProvider,
    tmdbApiKeySet: !!s.tmdbApiKey,
    tmdbRegions: s.tmdbRegions,
    tmdbProviderIds: s.tmdbProviderIds,
    tmdbCountedTypes: s.tmdbCountedTypes,
    deleteFiles: s.deleteFiles,
    purgeUnmonitoredFiles: s.purgeUnmonitoredFiles,
    searchAtEnd: s.searchAtEnd,
    removeMissingTmdbMovies: s.removeMissingTmdbMovies,
    applyChanges: s.applyChanges,
    // Scheduled sweeps: the stored schedule plus when it will next fire, and
    // whether this instance's scheduler has been switched off by env var.
    sweepScheduleEnabled: s.sweepScheduleEnabled,
    sweepIntervalHours: s.sweepIntervalHours,
    sweepIntervalChoices: [...SWEEP_INTERVAL_CHOICES],
    sweepNextRunAt: s.sweepNextRunAt ? s.sweepNextRunAt.toISOString() : null,
    sweepLastRunAt: s.sweepLastRunAt ? s.sweepLastRunAt.toISOString() : null,
    sweepSchedulerDisabledByEnv: schedulerDisabledByEnv(),
    // Webhook-triggered sweeps. Unlike every other credential the token is
    // returned in full: it only has a use once it is pasted into Sonarr/Radarr,
    // so a masked one would be useless. This endpoint is admin-only, and the
    // token is stored encrypted like the rest.
    webhookEnabled: s.webhookEnabled,
    webhookToken: s.webhookToken ?? "",
    webhookSettleSeconds: Math.round(settleMs() / 1000),
    // Login options: the stored preference, the value actually in force, and
    // whether the UI control must be locked (OIDC unusable or env override).
    localLoginEnabled: s.localLoginEnabled,
    localLoginEffective: effectiveLocalLoginEnabled(s),
    localLoginLock: localLoginToggleLocked(s),
    oidcEnabled: s.oidcEnabled,
    oidcButtonLabel: s.oidcButtonLabel ?? "",
    oidcButtonLabelDefault: DEFAULT_SSO_BUTTON_LABEL,
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
  // The stored form is needed to tell an unset credential from an unreadable
  // one; getSettings has already decrypted (and blanked) the latter.
  const raw = await getRawSettings();
  return NextResponse.json(serialize(s, raw ? hasUnreadableSecret(raw) : false));
});

export const PATCH = withGuard(requireAdmin, async (_session, req: NextRequest) => {
  const body = await req.json();
  const parsed = settingsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const prev = await getSettings(); // ensure row exists

  const data: Record<string, unknown> = {};
  const p = parsed.data;
  // Watchmode keys are an ordered ring; `watchmodeApiKey` mirrors the first one
  // for older readers. The ring form wins when both are sent.
  if (p.watchmodeApiKeys !== undefined) {
    let keys: string[];
    try {
      keys = resolveWatchmodeKeyEntries(p.watchmodeApiKeys, prev.watchmodeApiKeys);
    } catch (e) {
      if (e instanceof WatchmodeKeyEntryError) {
        return NextResponse.json({ error: e.message }, { status: 409 });
      }
      throw e;
    }
    data.watchmodeApiKeys = keys;
    data.watchmodeApiKey = keys[0] ?? null;
  } else if (p.watchmodeApiKey !== undefined && p.watchmodeApiKey !== null && p.watchmodeApiKey !== "") {
    // Only overwrite secrets when a non-empty value is provided.
    const keys = normalizeWatchmodeKeys([p.watchmodeApiKey, ...prev.watchmodeApiKeys.slice(1)]);
    data.watchmodeApiKeys = keys;
    data.watchmodeApiKey = keys[0];
  }
  if (p.seerrUrl !== undefined) data.seerrUrl = p.seerrUrl || null;
  if (p.seerrApiKey !== undefined && p.seerrApiKey !== null && p.seerrApiKey !== "")
    data.seerrApiKey = p.seerrApiKey;
  if (p.countries !== undefined) data.countries = p.countries;
  if (p.serviceIds !== undefined) data.serviceIds = p.serviceIds;
  if (p.countedTypes !== undefined) data.countedTypes = p.countedTypes;
  if (p.movieProvider !== undefined) data.movieProvider = p.movieProvider;
  // TMDB (movies). The values are kept even while Watchmode answers movies, so
  // switching back does not mean re-entering a key and re-picking providers.
  if (p.tmdbApiKey !== undefined && p.tmdbApiKey !== null && p.tmdbApiKey !== "")
    data.tmdbApiKey = p.tmdbApiKey;
  if (p.tmdbRegions !== undefined) data.tmdbRegions = p.tmdbRegions;
  if (p.tmdbProviderIds !== undefined) data.tmdbProviderIds = p.tmdbProviderIds;
  if (p.tmdbCountedTypes !== undefined) data.tmdbCountedTypes = p.tmdbCountedTypes;
  if (p.deleteFiles !== undefined) data.deleteFiles = p.deleteFiles;
  if (p.purgeUnmonitoredFiles !== undefined)
    data.purgeUnmonitoredFiles = p.purgeUnmonitoredFiles;
  if (p.searchAtEnd !== undefined) data.searchAtEnd = p.searchAtEnd;
  if (p.removeMissingTmdbMovies !== undefined)
    data.removeMissingTmdbMovies = p.removeMissingTmdbMovies;
  if (p.applyChanges !== undefined) data.applyChanges = p.applyChanges;
  // Scheduled sweeps: whenever the schedule itself is touched, recompute when
  // it next fires (see nextRunAfterChange for the rules).
  if (p.sweepScheduleEnabled !== undefined || p.sweepIntervalHours !== undefined) {
    const enabled = p.sweepScheduleEnabled ?? prev.sweepScheduleEnabled;
    const hours = p.sweepIntervalHours ?? prev.sweepIntervalHours;
    data.sweepScheduleEnabled = enabled;
    data.sweepIntervalHours = hours;
    data.sweepNextRunAt = nextRunAfterChange(prev, {
      sweepScheduleEnabled: enabled,
      sweepIntervalHours: hours,
    });
  }
  // Webhook sweeps are unusable without a token, so switching them on mints one
  // rather than leaving the user to notice a second, empty field.
  if (p.webhookEnabled !== undefined) data.webhookEnabled = p.webhookEnabled;
  if (p.regenerateWebhookToken || (p.webhookEnabled && !prev.webhookToken)) {
    data.webhookToken = generateWebhookToken();
  }
  if (p.localLoginEnabled !== undefined) data.localLoginEnabled = p.localLoginEnabled;
  // OIDC (only overwrite the secret when a non-empty value is provided).
  if (p.oidcEnabled !== undefined) data.oidcEnabled = p.oidcEnabled;
  // Empty string clears the override so the default label is used again.
  if (p.oidcButtonLabel !== undefined)
    data.oidcButtonLabel = p.oidcButtonLabel?.trim() ? p.oidcButtonLabel.trim() : null;
  if (p.oidcIssuer !== undefined) data.oidcIssuer = p.oidcIssuer || null;
  if (p.oidcClientId !== undefined) data.oidcClientId = p.oidcClientId || null;
  if (p.oidcClientSecret !== undefined && p.oidcClientSecret !== null && p.oidcClientSecret !== "")
    data.oidcClientSecret = p.oidcClientSecret;
  if (p.oidcScopes !== undefined) data.oidcScopes = p.oidcScopes || "openid profile email";
  if (p.oidcAuthUrl !== undefined) data.oidcAuthUrl = p.oidcAuthUrl || null;
  if (p.oidcTokenUrl !== undefined) data.oidcTokenUrl = p.oidcTokenUrl || null;
  if (p.oidcUserinfoUrl !== undefined) data.oidcUserinfoUrl = p.oidcUserinfoUrl || null;
  if (p.oidcAllowedUsers !== undefined) data.oidcAllowedUsers = p.oidcAllowedUsers;

  // Credentials are encrypted at rest; everything else is stored as-is.
  await prisma.settings.update({ where: { id: 1 }, data: encryptSettingsData(data) });
  const s = await getSettings();
  const raw = await getRawSettings();
  return NextResponse.json(serialize(s, raw ? hasUnreadableSecret(raw) : false));
});
