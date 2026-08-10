-- Webhook-triggered sweeps.
--
-- Sonarr ("On Series Add") and Radarr ("On Movie Added") call StreamSweeparr
-- when a title is added, and only that title is swept. Off by default: the
-- receiving endpoint is reachable without a session — it authenticates with its
-- own shared secret — so switching it on has to be a deliberate act.
ALTER TABLE "Settings" ADD COLUMN "webhookEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN "webhookToken" TEXT;

-- The pending queue. A webhook cannot start a sweep directly: only one run may
-- be active at a time, so adding ten shows at once would start one sweep and
-- reject nine. Queued titles are drained into a single targeted sweep instead.
--
-- The unique key is the title itself, so a webhook that fires twice queues one
-- sweep. "claimedBy" makes a claim exclusive across replicas.
CREATE TABLE "QueuedSweep" (
    "id" SERIAL NOT NULL,
    "mediaType" "MediaType" NOT NULL,
    "arrId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "eventType" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "claimedBy" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "connectionId" INTEGER NOT NULL,

    CONSTRAINT "QueuedSweep_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "QueuedSweep_connectionId_mediaType_arrId_key"
    ON "QueuedSweep"("connectionId", "mediaType", "arrId");

CREATE INDEX "QueuedSweep_claimedAt_queuedAt_idx" ON "QueuedSweep"("claimedAt", "queuedAt");

ALTER TABLE "QueuedSweep" ADD CONSTRAINT "QueuedSweep_connectionId_fkey"
    FOREIGN KEY ("connectionId") REFERENCES "ArrConnection"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
