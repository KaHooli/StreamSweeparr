-- Track movies whose TMDB id no longer resolves (TMDB 404 / status_code 34) so
-- the sweep can remove them from Radarr.
ALTER TABLE "MediaItem" ADD COLUMN "tmdbMissing" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN "removeMissingTmdbMovies" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "RunLog" ADD COLUMN "removedMovies" INTEGER NOT NULL DEFAULT 0;
