-- Titles tagged "ss-skip" in Sonarr/Radarr are left entirely alone.
ALTER TABLE "MediaItem" ADD COLUMN "skipped" BOOLEAN NOT NULL DEFAULT false;
