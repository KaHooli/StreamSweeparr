-- Replace User.isAdmin with a proper Role enum, and add the local-login toggle.

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'USER');

-- Add the new column with a safe default.
ALTER TABLE "User" ADD COLUMN "role" "Role" NOT NULL DEFAULT 'USER';

-- Backfill from the old boolean so existing admins keep their access.
UPDATE "User" SET "role" = 'ADMIN' WHERE "isAdmin" = true;

-- Safety net: if the backfill left no admin at all (e.g. isAdmin was never set),
-- promote the oldest local (password) account so the instance stays usable.
UPDATE "User" SET "role" = 'ADMIN'
WHERE "id" = (
  SELECT "id" FROM "User"
  WHERE "passwordHash" IS NOT NULL
  ORDER BY "id" ASC
  LIMIT 1
)
AND NOT EXISTS (SELECT 1 FROM "User" WHERE "role" = 'ADMIN');

-- Drop the superseded column.
ALTER TABLE "User" DROP COLUMN "isAdmin";

-- Login options.
ALTER TABLE "Settings" ADD COLUMN "localLoginEnabled" BOOLEAN NOT NULL DEFAULT true;
