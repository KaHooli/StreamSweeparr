/**
 * Shared fixtures for the integration suite.
 *
 * Every test starts from an empty database and builds only the rows it cares
 * about, so a failure points at one behaviour rather than at shared state.
 */
import { prisma } from "@/lib/db";
import type { ArrType, MediaType } from "@prisma/client";

/** Empty every table the suite touches. */
export async function resetDatabase() {
  // Order matters only where cascades do not cover us; TRUNCATE ... CASCADE in
  // one statement keeps it simple and fast.
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Episode", "MediaItem", "QueuedSweep", "ArrConnection", "RunLog", "User", "TitleIdMap", "Settings" RESTART IDENTITY CASCADE'
  );
}

/** The singleton settings row, with any overrides applied. */
export async function makeSettings(over: Record<string, unknown> = {}) {
  return prisma.settings.upsert({
    where: { id: 1 },
    create: { id: 1, ...over },
    update: over,
  });
}

export async function makeConnection(
  over: Partial<{ type: ArrType; name: string; baseUrl: string; apiKey: string; enabled: boolean }> = {}
) {
  await makeSettings();
  return prisma.arrConnection.create({
    data: {
      type: over.type ?? "RADARR",
      name: over.name ?? "Test Radarr",
      baseUrl: over.baseUrl ?? "http://radarr.test:7878",
      apiKey: over.apiKey ?? "key",
      enabled: over.enabled ?? true,
      settingsId: 1,
    },
  });
}

export async function makeMediaItem(
  connectionId: number,
  over: Partial<{
    type: MediaType;
    arrId: number;
    title: string;
    monitored: boolean;
    hasFile: boolean;
    movieFileId: number | null;
    onStreaming: boolean;
    streamingUnknown: boolean;
    tmdbMissing: boolean;
    skipped: boolean;
    tmdbId: number | null;
    providerSyncedAt: Date | null;
    lastSyncedAt: Date;
  }> = {}
) {
  return prisma.mediaItem.create({
    data: {
      connectionId,
      type: over.type ?? "MOVIE",
      arrId: over.arrId ?? 1,
      title: over.title ?? "A Movie",
      monitored: over.monitored ?? true,
      hasFile: over.hasFile ?? true,
      movieFileId: over.movieFileId === undefined ? 500 : over.movieFileId,
      onStreaming: over.onStreaming ?? false,
      streamingUnknown: over.streamingUnknown ?? false,
      tmdbMissing: over.tmdbMissing ?? false,
      skipped: over.skipped ?? false,
      tmdbId: over.tmdbId === undefined ? 100 : over.tmdbId,
      ...(over.providerSyncedAt !== undefined ? { providerSyncedAt: over.providerSyncedAt } : {}),
      ...(over.lastSyncedAt !== undefined ? { lastSyncedAt: over.lastSyncedAt } : {}),
    },
  });
}

export async function makeEpisode(
  mediaId: number,
  over: Partial<{
    arrEpisodeId: number;
    seasonNumber: number;
    episodeNumber: number;
    monitored: boolean;
    hasFile: boolean;
    episodeFileId: number | null;
    onStreaming: boolean;
    streamingUnknown: boolean;
  }> = {}
) {
  return prisma.episode.create({
    data: {
      mediaId,
      arrEpisodeId: over.arrEpisodeId ?? 1,
      seasonNumber: over.seasonNumber ?? 1,
      episodeNumber: over.episodeNumber ?? 1,
      monitored: over.monitored ?? true,
      hasFile: over.hasFile ?? true,
      episodeFileId: over.episodeFileId === undefined ? 900 : over.episodeFileId,
      onStreaming: over.onStreaming ?? false,
      streamingUnknown: over.streamingUnknown ?? false,
    },
  });
}

/** Poll until `check` passes or the budget runs out (for detached run bodies). */
export async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition.");
    await new Promise((r) => setTimeout(r, 50));
  }
}
