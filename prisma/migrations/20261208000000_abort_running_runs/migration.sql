-- Let an admin stop a run that is already under way.
--
-- The abort is recorded as a request rather than applied as a status, because
-- only the process executing the run can unwind it without leaving Sonarr or
-- Radarr half-told — and with several replicas sharing one database, that is
-- not necessarily the process that received the click. The run polls this
-- column between units of work and finalises itself.
--
-- ABORTED is its own terminal status. Reusing FAILED would make a deliberate
-- stop indistinguishable from a broken instance on the Runs page, and reusing
-- SUCCESS would claim a half-swept library was fully swept.
--
-- ADD VALUE inside a transaction is fine from PostgreSQL 12 onward (the app
-- requires 13+) so long as the new value is not *used* in the same
-- transaction. This migration only declares it; the first row written with it
-- comes long after this has committed.
ALTER TYPE "RunStatus" ADD VALUE IF NOT EXISTS 'ABORTED';

ALTER TABLE "RunLog" ADD COLUMN "abortRequestedAt" TIMESTAMP(3);
