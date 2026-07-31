-- Consolidate the 2026-07-31 item-processing and entity-model changes into a
-- single migration because neither migration has been deployed.
--
-- Add ingestion retry state and preserve whether an RSS publication timestamp
-- was trustworthy.
ALTER TABLE "items" ADD COLUMN "processingAttemptCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "items" ADD COLUMN "nextProcessingRetryAt" DATETIME;
ALTER TABLE "items" ADD COLUMN "lastProcessingError" TEXT;
ALTER TABLE "items" ADD COLUMN "publishedAtKnown" BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX "items_nextProcessingRetryAt_status_moderationStatus_idx"
ON "items"("nextProcessingRetryAt", "status", "moderationStatus");

CREATE INDEX "items_aggregationParseStatus_nextProcessingRetryAt_idx"
ON "items"("aggregationParseStatus", "nextProcessingRetryAt");

-- Replace the legacy tag data model with the entity data model.
-- Historical tag data is intentionally discarded; entities are rebuilt from
-- eventSubject/eventObject by the migration backfill below.

PRAGMA foreign_keys=OFF;

DROP TABLE IF EXISTS "item_tags";
DROP TABLE IF EXISTS "tag_aliases";
DROP TABLE IF EXISTS "tag_suggestion_candidates";
DROP TABLE IF EXISTS "tag_suggestion_decisions";
DROP TABLE IF EXISTS "tags";

ALTER TABLE "content_clusters" DROP COLUMN "feedTagsJson";
ALTER TABLE "content_clusters" ADD COLUMN "feedEntitiesJson" TEXT NOT NULL DEFAULT '[]';

CREATE TABLE "entities" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "normalized" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "entity_aliases" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "entityId" TEXT NOT NULL,
    "aliasName" TEXT NOT NULL,
    "aliasNormalized" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL DEFAULT 'admin',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "entity_aliases_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entities" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "entity_suggestion_decisions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceEntityNormalized" TEXT NOT NULL,
    "targetEntityNormalized" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "decidedBy" TEXT NOT NULL DEFAULT 'admin',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "entity_suggestion_candidates" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pairKey" TEXT NOT NULL,
    "sourceEntityId" TEXT NOT NULL,
    "targetEntityId" TEXT NOT NULL,
    "sourceEntityNormalized" TEXT NOT NULL,
    "targetEntityNormalized" TEXT NOT NULL,
    "confidence" REAL NOT NULL,
    "affectedItemCount" INTEGER NOT NULL,
    "sharedItemCount" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "entity_suggestion_candidates_sourceEntityId_fkey" FOREIGN KEY ("sourceEntityId") REFERENCES "entities" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "entity_suggestion_candidates_targetEntityId_fkey" FOREIGN KEY ("targetEntityId") REFERENCES "entities" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "item_entities" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "itemId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "item_entities_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "item_entities_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entities" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "entities_normalized_key" ON "entities"("normalized");
CREATE INDEX "entities_name_idx" ON "entities"("name");
CREATE UNIQUE INDEX "entity_aliases_aliasNormalized_key" ON "entity_aliases"("aliasNormalized");
CREATE INDEX "entity_aliases_entityId_idx" ON "entity_aliases"("entityId");
CREATE INDEX "entity_aliases_aliasName_idx" ON "entity_aliases"("aliasName");
CREATE INDEX "entity_suggestion_decisions_decision_idx" ON "entity_suggestion_decisions"("decision");
CREATE UNIQUE INDEX "entity_suggestion_decisions_sourceEntityNormalized_targetEntityNormalized_key" ON "entity_suggestion_decisions"("sourceEntityNormalized", "targetEntityNormalized");
CREATE UNIQUE INDEX "entity_suggestion_candidates_pairKey_key" ON "entity_suggestion_candidates"("pairKey");
CREATE INDEX "entity_suggestion_candidates_status_confidence_idx" ON "entity_suggestion_candidates"("status", "confidence");
CREATE INDEX "entity_suggestion_candidates_status_affectedItemCount_idx" ON "entity_suggestion_candidates"("status", "affectedItemCount");
CREATE INDEX "entity_suggestion_candidates_expiresAt_idx" ON "entity_suggestion_candidates"("expiresAt");
CREATE INDEX "entity_suggestion_candidates_sourceEntityId_idx" ON "entity_suggestion_candidates"("sourceEntityId");
CREATE INDEX "entity_suggestion_candidates_targetEntityId_idx" ON "entity_suggestion_candidates"("targetEntityId");
CREATE UNIQUE INDEX "entity_suggestion_candidates_sourceEntityNormalized_targetEntityNormalized_key" ON "entity_suggestion_candidates"("sourceEntityNormalized", "targetEntityNormalized");
CREATE INDEX "item_entities_entityId_idx" ON "item_entities"("entityId");
CREATE INDEX "item_entities_itemId_idx" ON "item_entities"("itemId");
CREATE UNIQUE INDEX "item_entities_itemId_entityId_key" ON "item_entities"("itemId", "entityId");

-- Remove legacy tag-derived search text and preference rules even when an item
-- is outside the bounded entity backfill. The entity backfill below adds the
-- replacement entity text back for the clusters it can rebuild.
UPDATE "content_clusters"
SET "feedSearchText" = trim(
    COALESCE("title", '') || ' ' || COALESCE("summary", '')
);

UPDATE "briefing_preference_configs"
SET "weightedRulesJson" = COALESCE((
    SELECT json_group_array(json(rule."value"))
    FROM json_each(
        CASE
            WHEN json_valid("briefing_preference_configs"."weightedRulesJson")
            THEN "briefing_preference_configs"."weightedRulesJson"
            ELSE '[]'
        END
    ) AS rule
    WHERE json_extract(rule."value", '$.type') <> 'tag'
), '[]')
WHERE json_valid("weightedRulesJson")
  AND EXISTS (
      SELECT 1
      FROM json_each("briefing_preference_configs"."weightedRulesJson") AS rule
      WHERE json_extract(rule."value", '$.type') = 'tag'
  );

-- Rebuild entity associations for the first 500 historical items during the
-- schema migration. The Docker SQLite setup applies the same bounded block
-- when upgrading an existing volume because it does not run Prisma deploy.
DROP TABLE IF EXISTS "_entity_backfill_raw";
DROP TABLE IF EXISTS "_entity_backfill_values";
DROP TABLE IF EXISTS "_entity_backfill_clusters";
DROP TABLE IF EXISTS "_entity_backfill_cluster_entities";
DROP TABLE IF EXISTS "_entity_backfill_cluster_entity_json";

CREATE TEMP TABLE "_entity_backfill_raw" (
    "itemId" TEXT NOT NULL,
    "rawName" TEXT NOT NULL
);
INSERT INTO "_entity_backfill_raw" ("itemId", "rawName")
SELECT "id", "eventSubject"
FROM (
    SELECT "id", "eventSubject", "eventObject"
    FROM "items"
    WHERE "eventSubject" IS NOT NULL OR "eventObject" IS NOT NULL
    ORDER BY "id" ASC
    LIMIT 500
)
WHERE "eventSubject" IS NOT NULL
UNION ALL
SELECT "id", "eventObject"
FROM (
    SELECT "id", "eventSubject", "eventObject"
    FROM "items"
    WHERE "eventSubject" IS NOT NULL OR "eventObject" IS NOT NULL
    ORDER BY "id" ASC
    LIMIT 500
)
WHERE "eventObject" IS NOT NULL;

CREATE TEMP TABLE "_entity_backfill_values" (
    "itemId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalized" TEXT NOT NULL,
    UNIQUE ("itemId", "normalized")
);
INSERT OR IGNORE INTO "_entity_backfill_values" ("itemId", "name", "normalized")
SELECT "itemId", "name", lower("name")
FROM (
    SELECT
        "itemId",
        trim(
            replace(replace(replace(replace(replace(
                trim("rawName", ' #＃"“”‘’`.,，。:：;；!?！？、()[]{}【】<>《》'),
                char(9), ' '), char(10), ' '), char(13), ' '),
                '  ', ' '), '  ', ' ')
        ) AS "name"
    FROM "_entity_backfill_raw"
)
WHERE "name" <> ''
  AND length("name") <= 40
  AND lower("name") NOT IN (
      '公司', '机构', '产品', '平台', '服务', '功能', '能力', '产品能力', '方案', '项目',
      '工具', '模型', '版本', '政策', '漏洞', '论文', '行业', '市场', '多项更新',
      'roundup', '新闻', '资讯', '文章', '更新', '动态', '科技', '技术', '互联网',
      'news', 'article', 'update', 'updates', 'technology', 'tech'
  );

INSERT OR IGNORE INTO "entities" ("id", "name", "normalized", "createdAt", "updatedAt")
SELECT
    'migration-entity-' || lower(hex(randomblob(16))),
    MIN("name"),
    "normalized",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "_entity_backfill_values"
GROUP BY "normalized";

INSERT OR IGNORE INTO "item_entities" ("id", "itemId", "entityId", "createdAt")
SELECT
    'migration-item-entity-' || lower(hex(randomblob(16))),
    backfillValues."itemId",
    entities."id",
    CURRENT_TIMESTAMP
FROM "_entity_backfill_values" AS backfillValues
INNER JOIN "entities" AS entities ON entities."normalized" = backfillValues."normalized";

CREATE TEMP TABLE "_entity_backfill_clusters" AS
SELECT DISTINCT "clusterId"
FROM "items"
INNER JOIN "_entity_backfill_values" AS backfillValues ON backfillValues."itemId" = "items"."id"
WHERE "clusterId" IS NOT NULL;

CREATE TEMP TABLE "_entity_backfill_cluster_entities" AS
SELECT
    "items"."clusterId" AS "clusterId",
    "entities"."name" AS "name",
    "entities"."normalized" AS "normalized"
FROM "items"
INNER JOIN "_entity_backfill_clusters" AS clusters ON clusters."clusterId" = "items"."clusterId"
INNER JOIN "item_entities" AS itemEntities ON itemEntities."itemId" = "items"."id"
INNER JOIN "entities" AS entities ON entities."id" = itemEntities."entityId"
WHERE "items"."clusterId" IS NOT NULL
GROUP BY "items"."clusterId", "entities"."normalized";

CREATE TEMP TABLE "_entity_backfill_cluster_entity_json" AS
SELECT
    "clusterId",
    json_group_array(json_object('name', "name", 'normalized', "normalized")) AS "feedEntitiesJson",
    group_concat("name", ' ') AS "entitySearchText"
FROM (
    SELECT "clusterId", "name", "normalized"
    FROM "_entity_backfill_cluster_entities"
    ORDER BY "clusterId" ASC, "name" ASC, "normalized" ASC
)
GROUP BY "clusterId";

UPDATE "content_clusters"
SET
    "feedEntitiesJson" = COALESCE((
        SELECT "feedEntitiesJson"
        FROM "_entity_backfill_cluster_entity_json" AS clusterEntityJson
        WHERE clusterEntityJson."clusterId" = "content_clusters"."id"
    ), '[]'),
    "feedSearchText" = trim(
        COALESCE("content_clusters"."title", '') || ' ' ||
        COALESCE("content_clusters"."summary", '') || ' ' ||
        COALESCE((
            SELECT "entitySearchText"
            FROM "_entity_backfill_cluster_entity_json" AS clusterEntityJson
            WHERE clusterEntityJson."clusterId" = "content_clusters"."id"
        ), '')
    )
WHERE "id" IN (SELECT "clusterId" FROM "_entity_backfill_clusters");

DROP TABLE IF EXISTS "_entity_backfill_raw";
DROP TABLE IF EXISTS "_entity_backfill_values";
DROP TABLE IF EXISTS "_entity_backfill_clusters";
DROP TABLE IF EXISTS "_entity_backfill_cluster_entities";
DROP TABLE IF EXISTS "_entity_backfill_cluster_entity_json";

PRAGMA foreign_keys=ON;
