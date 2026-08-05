-- Scheduled sweeps: run a sweep automatically every N hours.
--
-- Off by default so upgrading never starts running sweeps unattended. The next
-- due time is stored in the database (not in the process) so a restart does not
-- reset the countdown and multiple replicas can claim a slot atomically.
ALTER TABLE "Settings" ADD COLUMN "sweepScheduleEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN "sweepIntervalHours" INTEGER NOT NULL DEFAULT 12;
ALTER TABLE "Settings" ADD COLUMN "sweepNextRunAt" TIMESTAMP(3);
ALTER TABLE "Settings" ADD COLUMN "sweepLastRunAt" TIMESTAMP(3);
