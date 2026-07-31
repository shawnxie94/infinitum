import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const dbPathArg = args[0];
const shouldReset = args.includes("--reset");

if (!dbPathArg) {
  throw new Error("Usage: node scripts/setup-sqlite.mjs <db-path> [--reset]");
}

const root = process.cwd();
const dbPath = path.resolve(root, dbPathArg);
const dbDir = path.dirname(dbPath);
const lockPath = `${dbPath}.setup.lock`;
const lockTimeoutMs = Number.parseInt(process.env.SQLITE_SETUP_LOCK_TIMEOUT_MS || "300000", 10);
const staleLockMs = Number.parseInt(process.env.SQLITE_SETUP_STALE_LOCK_MS || "120000", 10);
const testHoldMs = Number.parseInt(process.env.SQLITE_SETUP_LOCK_HOLD_MS || "0", 10);
const sqliteBusyTimeoutMs = Number.parseInt(process.env.SQLITE_BUSY_TIMEOUT_MS || "10000", 10);
const entityBackfillLimit = 500;
const sleepBuffer = new SharedArrayBuffer(4);
const sleepView = new Int32Array(sleepBuffer);
const itemAdminClusterIndexName = "items_clusterId_status_moderationStatus_updatedAt_idx";

const sqliteRuntimePragmas = [
  "PRAGMA journal_mode = WAL;",
  `PRAGMA busy_timeout = ${sqliteBusyTimeoutMs};`,
  "PRAGMA synchronous = NORMAL;",
  "PRAGMA foreign_keys = ON;",
].join("\n");
const removedPromptConfigTypes = [
  "daily_report_refinement_chat",
  "daily_report_refinement_generate",
  "item_summary",
  "item_analysis",
  "item_aggregation",
];

function resolvePrismaCliPath() {
  const cliFileName = process.platform === "win32" ? "prisma.cmd" : "prisma";
  const cliPath = path.resolve(root, "node_modules", ".bin", cliFileName);

  if (!existsSync(cliPath)) {
    throw new Error(`Prisma CLI not found at ${cliPath}`);
  }

  return cliPath;
}

function loadSchemaSql() {
  const prebuiltSchemaSqlPath = path.resolve(root, "prisma", "schema.sql");

  if (existsSync(prebuiltSchemaSqlPath)) {
    return readFileSync(prebuiltSchemaSqlPath, "utf8");
  }

  const prismaSchemaPath = path.resolve(root, "prisma", "schema.prisma");

  return execFileSync(
    resolvePrismaCliPath(),
    ["migrate", "diff", "--from-empty", "--to-schema-datamodel", prismaSchemaPath, "--script"],
    {
      cwd: root,
      encoding: "utf8",
      env: process.env,
    },
  );
}

function makeSqliteSchemaIdempotent(sql) {
  return sql
    .replace(/^CREATE INDEX "content_clusters_status_latestCreatedAt_idx".*;\n?/gm, "")
    .replace(/^CREATE INDEX "content_clusters_status_earliestCreatedAt_idx".*;\n?/gm, "")
    .replace(/^CREATE INDEX "content_clusters_status_displayQualityScore_idx".*;\n?/gm, "")
    .replace(/^CREATE INDEX "content_clusters_dominantGroupId_status_latestCreatedAt_idx".*;\n?/gm, "")
    .replace(/^CREATE INDEX "content_clusters_eventFingerprint_eventBucket_idx".*;\n?/gm, "")
    // These indexes depend on additive item columns. Create them only after
    // applyAdditiveSchemaUpgrades() ensures the columns exist on older volumes.
    .replace(/^CREATE INDEX "items_nextProcessingRetryAt_status_moderationStatus_idx".*;\n?/gm, "")
    .replace(/^CREATE INDEX "items_aggregationParseStatus_nextProcessingRetryAt_idx".*;\n?/gm, "")
    .replace(/^CREATE TABLE /gm, "CREATE TABLE IF NOT EXISTS ")
    .replace(/^CREATE UNIQUE INDEX /gm, "CREATE UNIQUE INDEX IF NOT EXISTS ")
    .replace(/^CREATE INDEX /gm, "CREATE INDEX IF NOT EXISTS ");
}

function runSqlite(commandArgs, options = {}) {
  const { input, ...execOptions } = options;
  const sqliteInput = typeof input === "string"
    ? `PRAGMA busy_timeout = ${sqliteBusyTimeoutMs};\n${input}`
    : input;

  return execFileSync("sqlite3", commandArgs, {
    stdio: ["pipe", "inherit", "inherit"],
    ...execOptions,
    input: sqliteInput,
  });
}

function ftsTableExists(tableName) {
  const result = execFileSync(
    "sqlite3",
    [dbPath, `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='${tableName}'`],
    {
      encoding: "utf8",
    },
  ).trim();

  return result === "1";
}

function indexStatsExist(indexName) {
  if (!ftsTableExists("sqlite_stat1")) {
    return false;
  }

  const result = execFileSync(
    "sqlite3",
    [dbPath, `SELECT COUNT(*) FROM sqlite_stat1 WHERE idx = '${indexName}'`],
    {
      encoding: "utf8",
    },
  ).trim();

  return Number(result) > 0;
}

function applyRuntimeSqliteObjects() {
  if (!indexStatsExist(itemAdminClusterIndexName)) {
    runSqlite([dbPath], {
      input: `ANALYZE "items";\n`,
    });
  }

  if (!ftsTableExists("items_fts")) {
    runSqlite([dbPath], {
      input: [
        `CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
          originalTitle,
          translatedTitle,
          author,
          rssExcerpt,
          rssContent,
          fullText,
          summaryText,
          tokenize='trigram'
        );`,
        `INSERT INTO items_fts(rowid, originalTitle, translatedTitle, author, rssExcerpt, rssContent, fullText, summaryText)
         SELECT rowid, originalTitle, COALESCE(translatedTitle, ''), COALESCE(author, ''), COALESCE(rssExcerpt, ''),
                COALESCE(rssContent, ''), COALESCE(fullText, ''), COALESCE(summaryText, '')
         FROM items;`,
        `CREATE TRIGGER IF NOT EXISTS items_fts_ai AFTER INSERT ON items BEGIN
          INSERT INTO items_fts(rowid, originalTitle, translatedTitle, author, rssExcerpt, rssContent, fullText, summaryText)
          VALUES (new.rowid, COALESCE(new.originalTitle, ''), COALESCE(new.translatedTitle, ''), COALESCE(new.author, ''),
                  COALESCE(new.rssExcerpt, ''), COALESCE(new.rssContent, ''), COALESCE(new.fullText, ''), COALESCE(new.summaryText, ''));
        END;`,
        `CREATE TRIGGER IF NOT EXISTS items_fts_au AFTER UPDATE ON items BEGIN
          UPDATE items_fts SET
            originalTitle = COALESCE(new.originalTitle, ''),
            translatedTitle = COALESCE(new.translatedTitle, ''),
            author = COALESCE(new.author, ''),
            rssExcerpt = COALESCE(new.rssExcerpt, ''),
            rssContent = COALESCE(new.rssContent, ''),
            fullText = COALESCE(new.fullText, ''),
            summaryText = COALESCE(new.summaryText, '')
          WHERE rowid = old.rowid;
        END;`,
        `CREATE TRIGGER IF NOT EXISTS items_fts_ad AFTER DELETE ON items BEGIN
          DELETE FROM items_fts WHERE rowid = old.rowid;
        END;`,
      ].join("\n"),
    });
  }
}

function tableColumnExists(tableName, columnName) {
  const escapedTableName = tableName.replace(/'/g, "''");
  const escapedColumnName = columnName.replace(/'/g, "''");
  const result = execFileSync(
    "sqlite3",
    [dbPath, `SELECT COUNT(*) FROM pragma_table_info('${escapedTableName}') WHERE name='${escapedColumnName}'`],
    {
      encoding: "utf8",
    },
  ).trim();

  return Number(result) > 0;
}

function addColumnIfMissing(tableName, columnName, definition) {
  if (!ftsTableExists(tableName) || tableColumnExists(tableName, columnName)) {
    return false;
  }

  runSqlite([dbPath], {
    input: `ALTER TABLE "${tableName}" ADD COLUMN "${columnName}" ${definition};\n`,
  });
  return true;
}

function dropColumnIfPresent(tableName, columnName, options = {}) {
  if (!ftsTableExists(tableName) || !tableColumnExists(tableName, columnName)) {
    return false;
  }

  const dropIndexes = (options.dropIndexes ?? [])
    .map((indexName) => `DROP INDEX IF EXISTS "${indexName}";`)
    .join("\n");

  runSqlite([dbPath], {
    input: `
      ${dropIndexes}
      ALTER TABLE "${tableName}" DROP COLUMN "${columnName}";
    `,
  });
  return true;
}

function renameColumnIfPresent(tableName, oldColumnName, newColumnName, options = {}) {
  if (!ftsTableExists(tableName) || !tableColumnExists(tableName, oldColumnName)) {
    return false;
  }

  const dropIndexes = (options.dropIndexes ?? [])
    .map((indexName) => `DROP INDEX IF EXISTS "${indexName}";`)
    .join("\n");

  if (tableColumnExists(tableName, newColumnName)) {
    runSqlite([dbPath], {
      input: `
        ${dropIndexes}
        ALTER TABLE "${tableName}" DROP COLUMN "${oldColumnName}";
      `,
    });
    return true;
  }

  runSqlite([dbPath], {
    input: `
      ${dropIndexes}
      ALTER TABLE "${tableName}" RENAME COLUMN "${oldColumnName}" TO "${newColumnName}";
    `,
  });
  return true;
}

function applyScoreFieldRenames() {
  renameColumnIfPresent("content_clusters", "displayRecommendScore", "displayQualityScore", {
    dropIndexes: ["content_clusters_status_displayRecommendScore_idx"],
  });
  renameColumnIfPresent("event_briefing_configs", "minAttentionScore", "minRankScore");

  if (
    ftsTableExists("content_clusters") &&
    tableColumnExists("content_clusters", "displayQualityScore") &&
    tableColumnExists("content_clusters", "displayAverageScore")
  ) {
    runSqlite([dbPath], {
      input: `
        UPDATE "content_clusters"
        SET "displayQualityScore" = CASE
          WHEN "displayAverageScore" > 100 THEN 100
          WHEN "displayAverageScore" < 0 THEN 0
          ELSE "displayAverageScore"
        END;
      `,
    });
  }
}

function querySqliteNumber(sql) {
  const result = execFileSync("sqlite3", [dbPath, sql], {
    encoding: "utf8",
  }).trim();

  return Number(result || "0");
}

function hasPendingClusterFeedStatsBackfill() {
  if (
    !ftsTableExists("content_clusters") ||
    !ftsTableExists("items") ||
    !ftsTableExists("sources") ||
    !tableColumnExists("content_clusters", "latestCreatedAt") ||
    !tableColumnExists("content_clusters", "feedStatsUpdatedAt")
  ) {
    return false;
  }

  return querySqliteNumber(`
    SELECT COUNT(*)
    FROM (
      SELECT c.id
      FROM "content_clusters" c
      LEFT JOIN "items" i ON i."clusterId" = c.id
      LEFT JOIN "sources" s ON s.id = i."sourceId"
      WHERE c."feedStatsUpdatedAt" IS NULL
        OR (
          i.id IS NOT NULL
          AND i.status = 'processed'
          AND i."moderationStatus" IN ('allowed', 'restored')
          AND i."isAggregation" = false
          AND s.enabled = true
        )
      GROUP BY c.id, c."feedStatsUpdatedAt", c."latestCreatedAt"
      HAVING c."feedStatsUpdatedAt" IS NULL
        OR MAX(i."createdAt") > COALESCE(c."latestCreatedAt", 0)
    )
  `) > 0;
}

function applyClusterFeedStatsBackfill() {
  if (!ftsTableExists("content_clusters") || !ftsTableExists("items") || !ftsTableExists("sources")) {
    return;
  }

  runSqlite([dbPath], {
    input: `
      DROP TABLE IF EXISTS "_cluster_feed_backfill_targets";
      CREATE TEMP TABLE "_cluster_feed_backfill_targets" AS
      SELECT c.id
      FROM "content_clusters" c
      LEFT JOIN "items" i ON i."clusterId" = c.id
      LEFT JOIN "sources" s ON s.id = i."sourceId"
      WHERE c."feedStatsUpdatedAt" IS NULL
        OR (
          i.id IS NOT NULL
          AND i.status = 'processed'
          AND i."moderationStatus" IN ('allowed', 'restored')
          AND i."isAggregation" = false
          AND s.enabled = true
        )
      GROUP BY c.id, c."feedStatsUpdatedAt", c."latestCreatedAt"
      HAVING c."feedStatsUpdatedAt" IS NULL
        OR MAX(i."createdAt") > COALESCE(c."latestCreatedAt", 0);
      CREATE INDEX "_cluster_feed_backfill_targets_id_idx" ON "_cluster_feed_backfill_targets"(id);

      DROP TABLE IF EXISTS "_cluster_feed_stats_backfill";
      CREATE TEMP TABLE "_cluster_feed_stats_backfill" AS
      SELECT
        i."clusterId" AS "clusterId",
        COUNT(*) AS "displayItemCount",
        COUNT(DISTINCT i."sourceId") AS "displaySourceCount",
        CAST(ROUND(AVG(i."qualityScore")) AS INTEGER) AS "displayAverageScore",
        MIN(i."createdAt") AS "earliestCreatedAt",
        MAX(i."createdAt") AS "latestCreatedAt",
        MAX(i."publishedAt") AS "latestPublishedAt"
      FROM "items" i
      INNER JOIN "_cluster_feed_backfill_targets" target ON target.id = i."clusterId"
      INNER JOIN "sources" s ON s.id = i."sourceId"
      WHERE i."clusterId" IS NOT NULL
        AND i.status = 'processed'
        AND i."moderationStatus" IN ('allowed', 'restored')
        AND i."isAggregation" = false
        AND s.enabled = true
      GROUP BY i."clusterId";
      CREATE INDEX "_cluster_feed_stats_backfill_clusterId_idx" ON "_cluster_feed_stats_backfill"("clusterId");

      DROP TABLE IF EXISTS "_cluster_feed_group_backfill";
      CREATE TEMP TABLE "_cluster_feed_group_backfill" AS
      SELECT "clusterId", "groupId"
      FROM (
        SELECT
          i."clusterId" AS "clusterId",
          s."groupId" AS "groupId",
          COUNT(*) AS count,
          MIN(i."createdAt") AS "firstCreatedAt",
          ROW_NUMBER() OVER (
            PARTITION BY i."clusterId"
            ORDER BY COUNT(*) DESC, MIN(i."createdAt") ASC, s."groupId" ASC
          ) AS rn
        FROM "items" i
        INNER JOIN "_cluster_feed_backfill_targets" target ON target.id = i."clusterId"
        INNER JOIN "sources" s ON s.id = i."sourceId"
        WHERE i."clusterId" IS NOT NULL
          AND i.status = 'processed'
          AND i."moderationStatus" IN ('allowed', 'restored')
          AND i."isAggregation" = false
          AND s.enabled = true
          AND s."groupId" IS NOT NULL
        GROUP BY i."clusterId", s."groupId"
      )
      WHERE rn = 1;
      CREATE INDEX "_cluster_feed_group_backfill_clusterId_idx" ON "_cluster_feed_group_backfill"("clusterId");

      DROP TABLE IF EXISTS "_cluster_feed_entity_backfill";
      CREATE TEMP TABLE "_cluster_feed_entity_backfill" AS
      SELECT
        i."clusterId" AS "clusterId",
        t.normalized AS normalized,
        MIN(t.name) AS name
      FROM "items" i
      INNER JOIN "_cluster_feed_backfill_targets" target ON target.id = i."clusterId"
      INNER JOIN "sources" s ON s.id = i."sourceId"
      INNER JOIN "item_entities" it ON it."itemId" = i.id
      INNER JOIN "entities" t ON t.id = it."entityId"
      WHERE i."clusterId" IS NOT NULL
        AND i.status = 'processed'
        AND i."moderationStatus" IN ('allowed', 'restored')
        AND i."isAggregation" = false
        AND s.enabled = true
      GROUP BY i."clusterId", t.normalized;

      DROP TABLE IF EXISTS "_cluster_feed_entity_json_backfill";
      CREATE TEMP TABLE "_cluster_feed_entity_json_backfill" AS
      SELECT
        "clusterId",
        json_group_array(json_object('name', name, 'normalized', normalized)) AS "feedEntitiesJson",
        GROUP_CONCAT(name, ' ') AS "entitySearchText"
      FROM (
        SELECT "clusterId", name, normalized
        FROM "_cluster_feed_entity_backfill"
        ORDER BY name ASC, normalized ASC
      )
      GROUP BY "clusterId";
      CREATE INDEX "_cluster_feed_entity_json_backfill_clusterId_idx" ON "_cluster_feed_entity_json_backfill"("clusterId");

      UPDATE "content_clusters"
      SET
        "displayItemCount" = COALESCE((SELECT "displayItemCount" FROM "_cluster_feed_stats_backfill" stats WHERE stats."clusterId" = "content_clusters".id), 0),
        "displaySourceCount" = COALESCE((SELECT "displaySourceCount" FROM "_cluster_feed_stats_backfill" stats WHERE stats."clusterId" = "content_clusters".id), 0),
        "displayAverageScore" = COALESCE((SELECT "displayAverageScore" FROM "_cluster_feed_stats_backfill" stats WHERE stats."clusterId" = "content_clusters".id), 0),
        "displayQualityScore" = COALESCE((SELECT "displayAverageScore" FROM "_cluster_feed_stats_backfill" stats WHERE stats."clusterId" = "content_clusters".id), 0),
        "earliestCreatedAt" = (SELECT "earliestCreatedAt" FROM "_cluster_feed_stats_backfill" stats WHERE stats."clusterId" = "content_clusters".id),
        "latestCreatedAt" = (SELECT "latestCreatedAt" FROM "_cluster_feed_stats_backfill" stats WHERE stats."clusterId" = "content_clusters".id),
        "latestPublishedAt" = COALESCE((SELECT "latestPublishedAt" FROM "_cluster_feed_stats_backfill" stats WHERE stats."clusterId" = "content_clusters".id), "latestPublishedAt"),
        "dominantGroupId" = (SELECT "groupId" FROM "_cluster_feed_group_backfill" groups WHERE groups."clusterId" = "content_clusters".id),
        "feedEntitiesJson" = COALESCE((SELECT "feedEntitiesJson" FROM "_cluster_feed_entity_json_backfill" entities WHERE entities."clusterId" = "content_clusters".id), '[]'),
        "feedSearchText" = TRIM(COALESCE(title, '') || ' ' || COALESCE(summary, '') || ' ' || COALESCE((SELECT "entitySearchText" FROM "_cluster_feed_entity_json_backfill" entities WHERE entities."clusterId" = "content_clusters".id), '')),
        "feedStatsUpdatedAt" = CURRENT_TIMESTAMP
      WHERE id IN (SELECT id FROM "_cluster_feed_backfill_targets");

      DROP TABLE IF EXISTS "_cluster_feed_backfill_targets";
      DROP TABLE IF EXISTS "_cluster_feed_stats_backfill";
      DROP TABLE IF EXISTS "_cluster_feed_group_backfill";
      DROP TABLE IF EXISTS "_cluster_feed_entity_backfill";
      DROP TABLE IF EXISTS "_cluster_feed_entity_json_backfill";
    `,
  });
}

function cleanupLegacyTagSchema() {
  runSqlite([dbPath], {
    input: `
      PRAGMA foreign_keys=OFF;
      DROP TABLE IF EXISTS "item_tags";
      DROP TABLE IF EXISTS "tag_aliases";
      DROP TABLE IF EXISTS "tag_suggestion_candidates";
      DROP TABLE IF EXISTS "tag_suggestion_decisions";
      DROP TABLE IF EXISTS "tags";
      PRAGMA foreign_keys=ON;
    `,
  });

  dropColumnIfPresent("content_clusters", "feedTagsJson");

  runSqlite([dbPath], {
    input: `
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
    `,
  });
}

function applyEntityItemBackfill() {
  runSqlite([dbPath], {
    input: `
      PRAGMA foreign_keys=OFF;
      DROP TABLE IF EXISTS "_entity_backfill_raw";
      DROP TABLE IF EXISTS "_entity_backfill_values";
      DROP TABLE IF EXISTS "_entity_backfill_clusters";
      DROP TABLE IF EXISTS "_entity_backfill_cluster_entities";
      DROP TABLE IF EXISTS "_entity_backfill_cluster_entity_json";

      UPDATE "content_clusters"
      SET "feedSearchText" = trim(
        COALESCE("title", '') || ' ' || COALESCE("summary", '')
      );

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
        ORDER BY "createdAt" DESC, "id" DESC
        LIMIT ${entityBackfillLimit}
      )
      WHERE "eventSubject" IS NOT NULL
      UNION ALL
      SELECT "id", "eventObject"
      FROM (
        SELECT "id", "eventSubject", "eventObject"
        FROM "items"
        WHERE "eventSubject" IS NOT NULL OR "eventObject" IS NOT NULL
        ORDER BY "createdAt" DESC, "id" DESC
        LIMIT ${entityBackfillLimit}
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
              trim("rawName", ' #＃"“”‘’\`.,，。:：;；!?！？、()[]{}【】<>《》'),
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
      INNER JOIN "_entity_backfill_clusters" clusters ON clusters."clusterId" = "items"."clusterId"
      INNER JOIN "item_entities" itemEntities ON itemEntities."itemId" = "items"."id"
      INNER JOIN "entities" entities ON entities."id" = itemEntities."entityId"
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
    `,
  });
}

function applyAdditiveSchemaUpgrades() {
  // Repair///bootstrap item processing recovery columns before any items rebuilds.
  runSqlite([dbPath], {
    input: `
      DROP INDEX IF EXISTS "items_nextProcessingRetryAt_status_moderationStatus_idx";
      DROP INDEX IF EXISTS "items_aggregationParseStatus_nextProcessingRetryAt_idx";
    `,
  });
  addColumnIfMissing("items", "processingAttemptCount", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing("items", "nextProcessingRetryAt", "DATETIME");
  addColumnIfMissing("items", "lastProcessingError", "TEXT");
  addColumnIfMissing("items", "publishedAtKnown", "BOOLEAN NOT NULL DEFAULT true");

  dropColumnIfPresent("items", "dedupeSignature", {
    dropIndexes: ["items_dedupeSignature_key", "items_dedupeSignature_idx"],
  });
  dropColumnIfPresent("item_dedupe_history", "dedupeSignature", {
    dropIndexes: ["item_dedupe_history_dedupeSignature_key", "item_dedupe_history_dedupeSignature_idx"],
  });

  if (ftsTableExists("prompt_configs") && !tableColumnExists("prompt_configs", "templateJson")) {
    runSqlite([dbPath], {
      input: `ALTER TABLE "prompt_configs" ADD COLUMN "templateJson" TEXT;\n`,
    });
  }

  addColumnIfMissing("task_schedules", "dailyReportChannelIdsJson", "TEXT NOT NULL DEFAULT '[\"important\"]'");
  dropColumnIfPresent("task_schedules", "dailyReportGroupIdsJson");

  if (!ftsTableExists("entities")) {
    runSqlite([dbPath], {
      input: `
        CREATE TABLE IF NOT EXISTS "entities" (
          "id" TEXT NOT NULL PRIMARY KEY,
          "name" TEXT NOT NULL,
          "normalized" TEXT NOT NULL,
          "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" DATETIME NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS "entities_normalized_key" ON "entities"("normalized");
        CREATE INDEX IF NOT EXISTS "entities_name_idx" ON "entities"("name");
      `,
    });
  }

  if (!ftsTableExists("item_entities")) {
    runSqlite([dbPath], {
      input: `
        CREATE TABLE IF NOT EXISTS "item_entities" (
          "id" TEXT NOT NULL PRIMARY KEY,
          "itemId" TEXT NOT NULL,
          "entityId" TEXT NOT NULL,
          "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "item_entities_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
          CONSTRAINT "item_entities_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entities" ("id") ON DELETE CASCADE ON UPDATE CASCADE
        );
        CREATE INDEX IF NOT EXISTS "item_entities_entityId_idx" ON "item_entities"("entityId");
        CREATE INDEX IF NOT EXISTS "item_entities_itemId_idx" ON "item_entities"("itemId");
        CREATE UNIQUE INDEX IF NOT EXISTS "item_entities_itemId_entityId_key" ON "item_entities"("itemId", "entityId");
      `,
    });
  }

  if (!ftsTableExists("entity_aliases")) {
    runSqlite([dbPath], {
      input: `
        CREATE TABLE IF NOT EXISTS "entity_aliases" (
          "id" TEXT NOT NULL PRIMARY KEY,
          "entityId" TEXT NOT NULL,
          "aliasName" TEXT NOT NULL,
          "aliasNormalized" TEXT NOT NULL,
          "createdBy" TEXT NOT NULL DEFAULT 'admin',
          "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" DATETIME NOT NULL,
          CONSTRAINT "entity_aliases_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entities" ("id") ON DELETE CASCADE ON UPDATE CASCADE
        );
        CREATE UNIQUE INDEX IF NOT EXISTS "entity_aliases_aliasNormalized_key" ON "entity_aliases"("aliasNormalized");
        CREATE INDEX IF NOT EXISTS "entity_aliases_entityId_idx" ON "entity_aliases"("entityId");
        CREATE INDEX IF NOT EXISTS "entity_aliases_aliasName_idx" ON "entity_aliases"("aliasName");
      `,
    });
  }

  if (!ftsTableExists("entity_suggestion_decisions")) {
    runSqlite([dbPath], {
      input: `
        CREATE TABLE IF NOT EXISTS "entity_suggestion_decisions" (
          "id" TEXT NOT NULL PRIMARY KEY,
          "sourceEntityNormalized" TEXT NOT NULL,
          "targetEntityNormalized" TEXT NOT NULL,
          "decision" TEXT NOT NULL,
          "decidedBy" TEXT NOT NULL DEFAULT 'admin',
          "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" DATETIME NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS "entity_suggestion_decisions_sourceEntityNormalized_targetEntityNormalized_key" ON "entity_suggestion_decisions"("sourceEntityNormalized", "targetEntityNormalized");
        CREATE INDEX IF NOT EXISTS "entity_suggestion_decisions_decision_idx" ON "entity_suggestion_decisions"("decision");
      `,
    });
  }

  if (!ftsTableExists("entity_suggestion_candidates")) {
    runSqlite([dbPath], {
      input: `
        CREATE TABLE IF NOT EXISTS "entity_suggestion_candidates" (
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
        CREATE UNIQUE INDEX IF NOT EXISTS "entity_suggestion_candidates_pairKey_key" ON "entity_suggestion_candidates"("pairKey");
        CREATE UNIQUE INDEX IF NOT EXISTS "entity_suggestion_candidates_sourceEntityNormalized_targetEntityNormalized_key" ON "entity_suggestion_candidates"("sourceEntityNormalized", "targetEntityNormalized");
        CREATE INDEX IF NOT EXISTS "entity_suggestion_candidates_status_confidence_idx" ON "entity_suggestion_candidates"("status", "confidence");
        CREATE INDEX IF NOT EXISTS "entity_suggestion_candidates_status_affectedItemCount_idx" ON "entity_suggestion_candidates"("status", "affectedItemCount");
        CREATE INDEX IF NOT EXISTS "entity_suggestion_candidates_expiresAt_idx" ON "entity_suggestion_candidates"("expiresAt");
        CREATE INDEX IF NOT EXISTS "entity_suggestion_candidates_sourceEntityId_idx" ON "entity_suggestion_candidates"("sourceEntityId");
        CREATE INDEX IF NOT EXISTS "entity_suggestion_candidates_targetEntityId_idx" ON "entity_suggestion_candidates"("targetEntityId");
      `,
    });
  }

  if (!ftsTableExists("header_links")) {
    runSqlite([dbPath], {
      input: `
        CREATE TABLE IF NOT EXISTS "header_links" (
          "id" TEXT NOT NULL PRIMARY KEY,
          "label" TEXT NOT NULL,
          "url" TEXT NOT NULL,
          "enabled" BOOLEAN NOT NULL DEFAULT true,
          "sortOrder" INTEGER NOT NULL DEFAULT 0,
          "openInNewTab" BOOLEAN NOT NULL DEFAULT true,
          "rel" TEXT NOT NULL DEFAULT 'noopener noreferrer',
          "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" DATETIME NOT NULL
        );
        CREATE INDEX IF NOT EXISTS "header_links_enabled_sortOrder_idx" ON "header_links"("enabled", "sortOrder");
        CREATE INDEX IF NOT EXISTS "header_links_sortOrder_label_idx" ON "header_links"("sortOrder", "label");
      `,
    });
  }

  if (!ftsTableExists("event_briefing_configs")) {
    runSqlite([dbPath], {
      input: `
        CREATE TABLE IF NOT EXISTS "event_briefing_configs" (
          "id" TEXT NOT NULL PRIMARY KEY,
          "minRankScore" INTEGER NOT NULL DEFAULT 0,
          "briefingChannelsJson" TEXT NOT NULL DEFAULT '[]',
          "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" DATETIME NOT NULL
        );
      `,
    });
  }
  dropColumnIfPresent("event_briefing_configs", "includeSingleItems");
  dropColumnIfPresent("items", "understandingInputHash");
  dropColumnIfPresent("items", "understandingVersion");
  runSqlite([dbPath], {
    input: `
      CREATE INDEX IF NOT EXISTS "items_nextProcessingRetryAt_status_moderationStatus_idx" ON "items"("nextProcessingRetryAt", "status", "moderationStatus");
      CREATE INDEX IF NOT EXISTS "items_aggregationParseStatus_nextProcessingRetryAt_idx" ON "items"("aggregationParseStatus", "nextProcessingRetryAt");
    `,
  });

  addColumnIfMissing("event_briefing_configs", "briefingChannelsJson", "TEXT NOT NULL DEFAULT '[]'");

  if (!ftsTableExists("briefing_preference_configs")) {
    runSqlite([dbPath], {
      input: `
        CREATE TABLE IF NOT EXISTS "briefing_preference_configs" (
          "id" TEXT NOT NULL PRIMARY KEY,
          "weightedRulesJson" TEXT NOT NULL DEFAULT '[]',
          "maxCuratorBoost" INTEGER NOT NULL DEFAULT 15,
          "maxCuratorPenalty" INTEGER NOT NULL DEFAULT 20,
          "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" DATETIME NOT NULL
        );
      `,
    });
  }
  addColumnIfMissing("briefing_preference_configs", "weightedRulesJson", "TEXT NOT NULL DEFAULT '[]'");

  const clusterFeedStatsColumnsAdded = [
    addColumnIfMissing("content_clusters", "eventFingerprint", "TEXT"),
    addColumnIfMissing("content_clusters", "eventBucket", "TEXT"),
    addColumnIfMissing("content_clusters", "displayItemCount", "INTEGER NOT NULL DEFAULT 0"),
    addColumnIfMissing("content_clusters", "displaySourceCount", "INTEGER NOT NULL DEFAULT 0"),
    addColumnIfMissing("content_clusters", "displayAverageScore", "INTEGER NOT NULL DEFAULT 0"),
    addColumnIfMissing("content_clusters", "displayQualityScore", "INTEGER NOT NULL DEFAULT 0"),
    addColumnIfMissing("content_clusters", "latestCreatedAt", "DATETIME"),
    addColumnIfMissing("content_clusters", "dominantGroupId", "TEXT"),
    addColumnIfMissing("content_clusters", "feedSearchText", "TEXT"),
    addColumnIfMissing("content_clusters", "feedEntitiesJson", "TEXT NOT NULL DEFAULT '[]'"),
    addColumnIfMissing("content_clusters", "feedStatsUpdatedAt", "DATETIME"),
  ].some(Boolean);
  addColumnIfMissing("content_clusters", "earliestCreatedAt", "DATETIME");
  applyScoreFieldRenames();

  runSqlite([dbPath], {
    input: `
      CREATE INDEX IF NOT EXISTS "content_clusters_status_latestCreatedAt_idx" ON "content_clusters"("status", "latestCreatedAt");
      CREATE INDEX IF NOT EXISTS "content_clusters_status_earliestCreatedAt_idx" ON "content_clusters"("status", "earliestCreatedAt");
      CREATE INDEX IF NOT EXISTS "content_clusters_status_displayQualityScore_idx" ON "content_clusters"("status", "displayQualityScore");
      CREATE INDEX IF NOT EXISTS "content_clusters_dominantGroupId_status_latestCreatedAt_idx" ON "content_clusters"("dominantGroupId", "status", "latestCreatedAt");
      CREATE INDEX IF NOT EXISTS "content_clusters_eventFingerprint_eventBucket_idx" ON "content_clusters"("eventFingerprint", "eventBucket");
      CREATE INDEX IF NOT EXISTS "items_sourceId_status_moderationStatus_isAggregation_createdAt_idx" ON "items"("sourceId", "status", "moderationStatus", "isAggregation", "createdAt");
    `,
  });

  if (clusterFeedStatsColumnsAdded || hasPendingClusterFeedStatsBackfill()) {
    applyClusterFeedStatsBackfill();
  }
}

function cleanupRemovedPromptConfigTypes() {
  if (!ftsTableExists("prompt_configs")) {
    return;
  }

  const quotedTypes = removedPromptConfigTypes
    .map((type) => `'${type.replace(/'/g, "''")}'`)
    .join(", ");

  runSqlite([dbPath], {
    input: `DELETE FROM "prompt_configs" WHERE "type" IN (${quotedTypes});\n`,
  });
}

function sleep(ms) {
  if (ms <= 0) {
    return;
  }

  Atomics.wait(sleepView, 0, 0, ms);
}

function acquireSetupLock() {
  const startedAt = Date.now();

  while (true) {
    try {
      mkdirSync(lockPath);
      writeFileSync(
        path.join(lockPath, "owner.json"),
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date().toISOString(),
        }),
        "utf8",
      );
      return;
    } catch (error) {
      const isAlreadyExists =
        error && typeof error === "object" && "code" in error && error.code === "EEXIST";

      if (!isAlreadyExists) {
        throw error;
      }

      try {
        const ageMs = Date.now() - statSync(lockPath).mtimeMs;
        if (ageMs > staleLockMs) {
          rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }

      if (Date.now() - startedAt >= lockTimeoutMs) {
        throw new Error(`Timed out waiting for SQLite setup lock: ${lockPath}`);
      }

      sleep(100);
    }
  }
}

function releaseSetupLock() {
  rmSync(lockPath, { recursive: true, force: true });
}

mkdirSync(dbDir, { recursive: true });

acquireSetupLock();

try {
  if (shouldReset) {
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
  }

  const shouldBackfillEntities = existsSync(dbPath) && ftsTableExists("items") && (
    !ftsTableExists("entities")
    || !ftsTableExists("item_entities")
    || ftsTableExists("tags")
    || ftsTableExists("tag_aliases")
    || ftsTableExists("item_tags")
    || (ftsTableExists("content_clusters") && tableColumnExists("content_clusters", "feedTagsJson"))
  );

  // For existing volumes, ensure recovery columns exist before any schema SQL
  // that might reference them indirectly after partial upgrades.
  if (existsSync(dbPath)) {
    addColumnIfMissing("items", "processingAttemptCount", "INTEGER NOT NULL DEFAULT 0");
    addColumnIfMissing("items", "nextProcessingRetryAt", "DATETIME");
    addColumnIfMissing("items", "lastProcessingError", "TEXT");
  }

  const sql = `${sqliteRuntimePragmas}\n${makeSqliteSchemaIdempotent(loadSchemaSql())}\n${sqliteRuntimePragmas}\n`;
  runSqlite([dbPath], {
    input: sql,
  });
  applyAdditiveSchemaUpgrades();
  if (shouldBackfillEntities) {
    applyEntityItemBackfill();
    console.log(`Entity item backfill applied: up to ${entityBackfillLimit} items`);
  }
  cleanupLegacyTagSchema();
  cleanupRemovedPromptConfigTypes();
  applyRuntimeSqliteObjects();

  if (testHoldMs > 0) {
    sleep(testHoldMs);
  }

  console.log(`Database initialized: ${dbPath}`);
} finally {
  releaseSetupLock();
}
