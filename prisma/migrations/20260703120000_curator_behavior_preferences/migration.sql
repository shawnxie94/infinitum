-- CreateTable
CREATE TABLE "curator_behavior_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventType" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "entryType" TEXT,
    "entryId" TEXT,
    "itemId" TEXT,
    "clusterId" TEXT,
    "score" INTEGER NOT NULL,
    "metadataJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "curator_behavior_dimensions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventId" TEXT NOT NULL,
    "ruleType" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "label" TEXT,
    "score" INTEGER NOT NULL,
    "targetDedupKey" TEXT NOT NULL,
    "occurredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "curator_behavior_dimensions_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "curator_behavior_events" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "briefing_preference_suggestions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "suggestionKey" TEXT NOT NULL,
    "ruleType" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "label" TEXT,
    "suggestedWeight" INTEGER NOT NULL,
    "confidence" REAL NOT NULL,
    "positiveScore" INTEGER NOT NULL DEFAULT 0,
    "negativeScore" INTEGER NOT NULL DEFAULT 0,
    "sampleCount" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "dismissedAt" DATETIME,
    "acceptedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "curator_behavior_events_eventType_createdAt_idx" ON "curator_behavior_events"("eventType", "createdAt");

-- CreateIndex
CREATE INDEX "curator_behavior_events_targetType_targetId_createdAt_idx" ON "curator_behavior_events"("targetType", "targetId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "curator_behavior_dimensions_targetDedupKey_key" ON "curator_behavior_dimensions"("targetDedupKey");

-- CreateIndex
CREATE INDEX "curator_behavior_dimensions_occurredAt_idx" ON "curator_behavior_dimensions"("occurredAt");

-- CreateIndex
CREATE INDEX "curator_behavior_dimensions_ruleType_value_occurredAt_idx" ON "curator_behavior_dimensions"("ruleType", "value", "occurredAt");

-- CreateIndex
CREATE INDEX "curator_behavior_dimensions_targetDedupKey_occurredAt_idx" ON "curator_behavior_dimensions"("targetDedupKey", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "briefing_preference_suggestions_suggestionKey_key" ON "briefing_preference_suggestions"("suggestionKey");

-- CreateIndex
CREATE INDEX "briefing_preference_suggestions_status_confidence_idx" ON "briefing_preference_suggestions"("status", "confidence");

-- CreateIndex
CREATE INDEX "briefing_preference_suggestions_ruleType_value_idx" ON "briefing_preference_suggestions"("ruleType", "value");
