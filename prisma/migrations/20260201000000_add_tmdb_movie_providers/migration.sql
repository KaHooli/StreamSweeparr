-- Add TheMovieDB (TMDB) movie streaming-availability settings.
-- TV episodes continue to use Watchmode; movies now use TMDB watch providers.

ALTER TABLE "Settings" ADD COLUMN "tmdbApiKey" TEXT;
ALTER TABLE "Settings" ADD COLUMN "tmdbRegions" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Settings" ADD COLUMN "tmdbProviderIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[];
ALTER TABLE "Settings" ADD COLUMN "tmdbCountedTypes" TEXT[] DEFAULT ARRAY['flatrate', 'free']::TEXT[];
