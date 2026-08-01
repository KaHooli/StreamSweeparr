-- Run option: delete files for every item that is unmonitored at the end of a
-- sweep, not only the titles that sweep just unmonitored. This clears a
-- pre-existing unmonitored back-catalogue that `deleteFiles` never touches.
--
-- Defaults to false so upgrading does not retroactively wipe files for a
-- library that was already unmonitored.
ALTER TABLE "Settings" ADD COLUMN "purgeUnmonitoredFiles" BOOLEAN NOT NULL DEFAULT false;
