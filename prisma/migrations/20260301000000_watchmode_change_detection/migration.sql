-- Watchmode credit reduction: per-item provider-sync timestamp + a changes-feed
-- cursor on Settings, so syncs only re-pull episodes for series that changed
-- (via /changes/titles_episodes_changed) or that are older than the TTL.

ALTER TABLE "MediaItem" ADD COLUMN "providerSyncedAt" TIMESTAMP(3);
ALTER TABLE "Settings" ADD COLUMN "watchmodeChangesCursor" TIMESTAMP(3);
