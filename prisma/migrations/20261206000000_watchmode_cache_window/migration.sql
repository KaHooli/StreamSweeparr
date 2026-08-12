-- Make the Watchmode freshness window a setting.
--
-- Until now the window was a constant in the sync engine: seven days for
-- series episodes, for the title-level provider-link call, and for movies when
-- Watchmode answers them. That number is only right for one kind of install.
-- On a free / developer key it is the *only* thing rationing credits (those
-- plans have no Changes API), so a large library may need a longer window to
-- stay inside the monthly budget; a paid key already gets change detection and
-- can afford a shorter one, because the TTL is merely its safety net.
--
-- Every existing row takes 7, the value the code has been using all along, so
-- an upgrade changes nothing about how many credits a sync spends. Values are
-- clamped to 1..90 in the application (lib/watchmodeCache.ts) rather than by a
-- CHECK constraint, so a bound change does not need another migration.
ALTER TABLE "Settings"
  ADD COLUMN "watchmodeCacheDays" INTEGER NOT NULL DEFAULT 7;
