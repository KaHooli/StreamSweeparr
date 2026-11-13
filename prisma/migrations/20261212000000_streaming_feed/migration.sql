-- A read-only feed of streaming links for other self-hosted apps.
--
-- `GET /api/feed/tv` and `GET /api/feed/movies` list every title on the
-- user's services with one link per service, so a portal such as Hearthport
-- can show "watch on …" without knowing anything about Watchmode or TMDB.
-- Those programs cannot hold a session, so the feed authenticates with its own
-- key and has its own switch.
--
-- `feedEnabled` defaults to FALSE: an upgrade must not open an endpoint
-- reachable without a session. `feedToken` starts NULL and is minted (and
-- encrypted with AUTH_SECRET) by the app when the feed is switched on — SQL
-- has no access to the key, so there is nothing to backfill here.
ALTER TABLE "Settings" ADD COLUMN "feedEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN "feedToken" TEXT;
