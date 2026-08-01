-- Track when we last asked Watchmode's title-level sources endpoint for the
-- per-provider `web_url` deep links the dashboard logos point at. This is
-- separate from providerSyncedAt (per-episode availability), because episode
-- links are a paid-plan feature: on free plans they come back as a placeholder,
-- so the show-level links have to be fetched on their own schedule.
--
-- Left NULL for existing rows so the next sync backfills their links.
ALTER TABLE "MediaItem" ADD COLUMN "providerLinksSyncedAt" TIMESTAMP(3);
