-- Catching newly aired episodes sooner.
--
-- Watchmode usually lists a new episode's streaming sources a few days after
-- it airs. Until then it answers for the episode with no matching sources, so
-- the sweep reads it as "not on your services", and once the series has been
-- looked up the cache window (7 days by default) keeps that answer even after
-- Watchmode has caught up. A show released weekly on a service the user pays
-- for was therefore routinely a week or more behind.
--
-- `recheckNewEpisodes` looks such a series up again at most daily while a
-- newly aired episode is still unconfirmed. `assumeNewEpisodesStream` treats
-- that episode as on the same services as the one before it in the meantime.
-- Both apply only when the previous episode is confirmed on the user's
-- services and the new one aired within the last week.
--
-- Both default to TRUE. The recheck only shortens how long a stale answer is
-- believed. The assumption can unmonitor an episode but, by design, never
-- deletes a file, purges, or cancels a download over it, and it lapses on its
-- own — so an upgrade switching it on cannot cost anyone data.
--
-- `Episode.streamingInferred` marks a row whose `onStreaming` came from that
-- assumption rather than from Watchmode. Existing rows correctly read false.
ALTER TABLE "Settings" ADD COLUMN "recheckNewEpisodes" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "assumeNewEpisodesStream" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Episode" ADD COLUMN "streamingInferred" BOOLEAN NOT NULL DEFAULT false;
