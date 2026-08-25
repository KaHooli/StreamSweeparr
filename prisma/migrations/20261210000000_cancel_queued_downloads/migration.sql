-- Cancelling in-progress downloads for titles a sweep unmonitors.
--
-- Until now a sweep that unmonitored a title already on streaming left any
-- download of it running: Sonarr/Radarr stop *starting* new grabs for an
-- unmonitored title but do not abandon one already handed to the download
-- client, so the file arrived anyway and sat there until the next sweep's
-- purge — having spent the bandwidth and, on a private tracker, the ratio.
--
-- `cancelQueuedDownloads` opts into removing those queue entries and telling
-- the download client to drop the data. It defaults to FALSE for the same
-- reason `purgeUnmonitoredFiles` does: it is destructive, it destroys work in
-- progress rather than a file that can be re-grabbed at leisure, and an
-- install upgrading into it must not find that behaviour switched on by
-- itself.
--
-- `RunLog.cancelledDownloads` records what each run did, alongside the other
-- per-run counters. Existing rows correctly read 0 — no earlier run could have
-- cancelled anything.
ALTER TABLE "Settings" ADD COLUMN "cancelQueuedDownloads" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "RunLog" ADD COLUMN "cancelledDownloads" INTEGER NOT NULL DEFAULT 0;
