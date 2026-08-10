-- Choose which provider answers movie streaming availability.
--
-- Movies have always gone to TheMovieDB and TV to Watchmode. That split exists
-- because TV needs per-episode data (only Watchmode has it) and because TMDB's
-- API is free and unmetered, so spending Watchmode credits on movies is
-- spending them twice. Some installs would still rather run one provider than
-- two, so this makes the movie half a setting.
--
-- The default is TMDB, and every existing row takes it: an upgrade must not
-- silently start charging a Watchmode budget that was sized for TV alone. The
-- TMDB columns stay put either way — switching to Watchmode leaves them unused,
-- not discarded, so switching back needs no reconfiguration.
CREATE TYPE "MovieProvider" AS ENUM ('TMDB', 'WATCHMODE');

ALTER TABLE "Settings"
  ADD COLUMN "movieProvider" "MovieProvider" NOT NULL DEFAULT 'TMDB';
