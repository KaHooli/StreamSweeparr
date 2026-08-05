-- Sweep/sync performance work.
--
-- 1. Cache Radarr's movie file id on the snapshot. The sweep previously had to
--    GET each movie from Radarr purely to learn the id of the file it was about
--    to delete; sync already sees that id, so record it and delete in bulk.
ALTER TABLE "MediaItem" ADD COLUMN "movieFileId" INTEGER;

-- 2. Index the column pairs the hot queries actually filter on. The dashboard
--    always asks for (type, onStreaming) together, sync prunes by
--    (connectionId, type, lastSyncedAt), and the end-of-run search walks
--    monitored episodes per series.
DROP INDEX IF EXISTS "MediaItem_type_idx";
DROP INDEX IF EXISTS "MediaItem_onStreaming_idx";
CREATE INDEX "MediaItem_type_onStreaming_idx" ON "MediaItem"("type", "onStreaming");
CREATE INDEX "MediaItem_connectionId_type_lastSyncedAt_idx" ON "MediaItem"("connectionId", "type", "lastSyncedAt");
CREATE INDEX "Episode_mediaId_monitored_idx" ON "Episode"("mediaId", "monitored");
