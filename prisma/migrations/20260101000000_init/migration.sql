-- CreateEnum
CREATE TYPE "ArrType" AS ENUM ('SONARR', 'RADARR');

-- CreateEnum
CREATE TYPE "MediaType" AS ENUM ('MOVIE', 'TV');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('RUNNING', 'SUCCESS', 'FAILED');

-- CreateEnum
CREATE TYPE "RunKind" AS ENUM ('SWEEP', 'SYNC');

-- CreateTable
CREATE TABLE "Settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "watchmodeApiKey" TEXT,
    "seerrUrl" TEXT,
    "seerrApiKey" TEXT,
    "countries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "serviceIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "countedTypes" TEXT[] DEFAULT ARRAY['sub', 'free']::TEXT[],
    "deleteFiles" BOOLEAN NOT NULL DEFAULT true,
    "searchAtEnd" BOOLEAN NOT NULL DEFAULT true,
    "applyChanges" BOOLEAN NOT NULL DEFAULT false,
    "titleMapEtag" TEXT,
    "titleMapLastModified" TEXT,
    "titleMapSyncedAt" TIMESTAMP(3),
    "titleMapRowCount" INTEGER NOT NULL DEFAULT 0,
    "oidcEnabled" BOOLEAN NOT NULL DEFAULT false,
    "oidcIssuer" TEXT,
    "oidcClientId" TEXT,
    "oidcClientSecret" TEXT,
    "oidcScopes" TEXT NOT NULL DEFAULT 'openid profile email',
    "oidcAuthUrl" TEXT,
    "oidcTokenUrl" TEXT,
    "oidcUserinfoUrl" TEXT,
    "oidcAllowedUsers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT,
    "oidcSubject" TEXT,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TitleIdMap" (
    "watchmodeId" INTEGER NOT NULL,
    "imdbId" TEXT,
    "tmdbId" INTEGER,
    "tmdbType" TEXT,
    "title" TEXT,
    "year" INTEGER,

    CONSTRAINT "TitleIdMap_pkey" PRIMARY KEY ("watchmodeId")
);

-- CreateTable
CREATE TABLE "ArrConnection" (
    "id" SERIAL NOT NULL,
    "type" "ArrType" NOT NULL,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "origin" TEXT NOT NULL DEFAULT 'manual',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "settingsId" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "ArrConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaItem" (
    "id" SERIAL NOT NULL,
    "type" "MediaType" NOT NULL,
    "arrId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "year" INTEGER,
    "posterUrl" TEXT,
    "tmdbId" INTEGER,
    "imdbId" TEXT,
    "tvdbId" INTEGER,
    "watchmodeId" INTEGER,
    "monitored" BOOLEAN NOT NULL DEFAULT false,
    "hasFile" BOOLEAN NOT NULL DEFAULT false,
    "onStreaming" BOOLEAN NOT NULL DEFAULT false,
    "streamingUnknown" BOOLEAN NOT NULL DEFAULT false,
    "streamingInfo" JSONB,
    "totalEpisodes" INTEGER NOT NULL DEFAULT 0,
    "monitoredEpisodes" INTEGER NOT NULL DEFAULT 0,
    "streamingEpisodes" INTEGER NOT NULL DEFAULT 0,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "connectionId" INTEGER NOT NULL,

    CONSTRAINT "MediaItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Episode" (
    "id" SERIAL NOT NULL,
    "arrEpisodeId" INTEGER NOT NULL,
    "seasonNumber" INTEGER NOT NULL,
    "episodeNumber" INTEGER NOT NULL,
    "title" TEXT,
    "monitored" BOOLEAN NOT NULL DEFAULT false,
    "hasFile" BOOLEAN NOT NULL DEFAULT false,
    "episodeFileId" INTEGER,
    "onStreaming" BOOLEAN NOT NULL DEFAULT false,
    "streamingUnknown" BOOLEAN NOT NULL DEFAULT false,
    "streamingInfo" JSONB,
    "mediaId" INTEGER NOT NULL,

    CONSTRAINT "Episode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunLog" (
    "id" SERIAL NOT NULL,
    "kind" "RunKind" NOT NULL DEFAULT 'SWEEP',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "RunStatus" NOT NULL DEFAULT 'RUNNING',
    "dryRun" BOOLEAN NOT NULL DEFAULT true,
    "unmonitoredMovies" INTEGER NOT NULL DEFAULT 0,
    "remonitoredMovies" INTEGER NOT NULL DEFAULT 0,
    "unmonitoredEps" INTEGER NOT NULL DEFAULT 0,
    "remonitoredEps" INTEGER NOT NULL DEFAULT 0,
    "deletedFiles" INTEGER NOT NULL DEFAULT 0,
    "searchedItems" INTEGER NOT NULL DEFAULT 0,
    "log" JSONB,
    "error" TEXT,

    CONSTRAINT "RunLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_oidcSubject_key" ON "User"("oidcSubject");

-- CreateIndex
CREATE INDEX "TitleIdMap_tmdbId_tmdbType_idx" ON "TitleIdMap"("tmdbId", "tmdbType");

-- CreateIndex
CREATE INDEX "TitleIdMap_imdbId_idx" ON "TitleIdMap"("imdbId");

-- CreateIndex
CREATE UNIQUE INDEX "ArrConnection_type_baseUrl_key" ON "ArrConnection"("type", "baseUrl");

-- CreateIndex
CREATE INDEX "MediaItem_type_idx" ON "MediaItem"("type");

-- CreateIndex
CREATE INDEX "MediaItem_onStreaming_idx" ON "MediaItem"("onStreaming");

-- CreateIndex
CREATE UNIQUE INDEX "MediaItem_connectionId_type_arrId_key" ON "MediaItem"("connectionId", "type", "arrId");

-- CreateIndex
CREATE UNIQUE INDEX "Episode_mediaId_arrEpisodeId_key" ON "Episode"("mediaId", "arrEpisodeId");

-- CreateIndex
CREATE INDEX "RunLog_status_heartbeatAt_idx" ON "RunLog"("status", "heartbeatAt");

-- AddForeignKey
ALTER TABLE "ArrConnection" ADD CONSTRAINT "ArrConnection_settingsId_fkey" FOREIGN KEY ("settingsId") REFERENCES "Settings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaItem" ADD CONSTRAINT "MediaItem_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ArrConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Episode" ADD CONSTRAINT "Episode_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "MediaItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

