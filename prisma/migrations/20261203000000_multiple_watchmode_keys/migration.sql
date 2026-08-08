-- Multiple Watchmode API keys.
--
-- A single free-tier Watchmode key is a small monthly credit budget. Allowing
-- several keys lets a user pool them: requests start at the first key and move
-- to the next one when a key is rejected or has run out of quota.
--
-- The existing single key becomes key #1. The stored value is copied verbatim
-- because array elements use exactly the same encryption format as the old
-- column, so no re-encryption (and therefore no access to AUTH_SECRET) is
-- needed here. "watchmodeApiKey" is left in place as a mirror of the first key
-- for older code paths and for the boot-time plaintext migration.
ALTER TABLE "Settings" ADD COLUMN "watchmodeApiKeys" TEXT[] DEFAULT ARRAY[]::TEXT[];

UPDATE "Settings"
SET "watchmodeApiKeys" = ARRAY["watchmodeApiKey"]
WHERE "watchmodeApiKey" IS NOT NULL
  AND "watchmodeApiKey" <> ''
  AND COALESCE(cardinality("watchmodeApiKeys"), 0) = 0;
