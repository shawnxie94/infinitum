-- Rename score fields to match their current semantics.
DROP INDEX IF EXISTS "content_clusters_status_displayRecommendScore_idx";
ALTER TABLE "content_clusters" RENAME COLUMN "displayRecommendScore" TO "displayQualityScore";
UPDATE "content_clusters"
SET "displayQualityScore" = CASE
    WHEN "displayAverageScore" > 100 THEN 100
    WHEN "displayAverageScore" < 0 THEN 0
    ELSE "displayAverageScore"
END;
CREATE INDEX "content_clusters_status_displayQualityScore_idx" ON "content_clusters"("status", "displayQualityScore");

-- CreateTable
CREATE TABLE "event_briefing_configs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "minRankScore" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "briefing_preference_configs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "weightedRulesJson" TEXT NOT NULL DEFAULT '[]',
    "maxCuratorBoost" INTEGER NOT NULL DEFAULT 15,
    "maxCuratorPenalty" INTEGER NOT NULL DEFAULT 20,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
