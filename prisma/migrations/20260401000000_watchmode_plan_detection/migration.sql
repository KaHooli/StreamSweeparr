-- Cache the detected Watchmode plan so we auto-enable the premium Changes API
-- for paid keys and fall back to the 7-day TTL for free keys, without probing
-- on every sync.

ALTER TABLE "Settings" ADD COLUMN "watchmodePlan" TEXT;
ALTER TABLE "Settings" ADD COLUMN "watchmodePlanCheckedAt" TIMESTAMP(3);
