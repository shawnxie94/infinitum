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

      DROP TABLE IF EXISTS "_cluster_feed_tag_backfill";
      CREATE TEMP TABLE "_cluster_feed_tag_backfill" AS
      SELECT
        i."clusterId" AS "clusterId",
        t.normalized AS normalized,
        MIN(t.name) AS name
      FROM "items" i
      INNER JOIN "_cluster_feed_backfill_targets" target ON target.id = i."clusterId"
      INNER JOIN "sources" s ON s.id = i."sourceId"
      INNER JOIN "item_tags" it ON it."itemId" = i.id
      INNER JOIN "tags" t ON t.id = it."tagId"
      WHERE i."clusterId" IS NOT NULL
        AND i.status = 'processed'
        AND i."moderationStatus" IN ('allowed', 'restored')
        AND i."isAggregation" = false
        AND s.enabled = true
      GROUP BY i."clusterId", t.normalized;

      DROP TABLE IF EXISTS "_cluster_feed_tag_json_backfill";
      CREATE TEMP TABLE "_cluster_feed_tag_json_backfill" AS
      SELECT
        "clusterId",
        json_group_array(json_object('name', name, 'normalized', normalized)) AS "feedTagsJson",
        GROUP_CONCAT(name, ' ') AS "tagSearchText"
      FROM (
        SELECT "clusterId", name, normalized
        FROM "_cluster_feed_tag_backfill"
        ORDER BY name ASC, normalized ASC
      )
      GROUP BY "clusterId";
      CREATE INDEX "_cluster_feed_tag_json_backfill_clusterId_idx" ON "_cluster_feed_tag_json_backfill"("clusterId");

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
        "feedTagsJson" = COALESCE((SELECT "feedTagsJson" FROM "_cluster_feed_tag_json_backfill" tags WHERE tags."clusterId" = "content_clusters".id), '[]'),
        "feedSearchText" = TRIM(COALESCE(title, '') || ' ' || COALESCE(summary, '') || ' ' || COALESCE((SELECT "tagSearchText" FROM "_cluster_feed_tag_json_backfill" tags WHERE tags."clusterId" = "content_clusters".id), '')),
        "feedStatsUpdatedAt" = CURRENT_TIMESTAMP
      WHERE id IN (SELECT id FROM "_cluster_feed_backfill_targets");

      DROP TABLE IF EXISTS "_cluster_feed_backfill_targets";
      DROP TABLE IF EXISTS "_cluster_feed_stats_backfill";
      DROP TABLE IF EXISTS "_cluster_feed_group_backfill";
      DROP TABLE IF EXISTS "_cluster_feed_tag_backfill";
      DROP TABLE IF EXISTS "_cluster_feed_tag_json_backfill";
    `,
  });
}

function applyAdditiveSchemaUpgrades() {
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

  if (!ftsTableExists("tags")) {
    runSqlite([dbPath], {
      input: `
        CREATE TABLE IF NOT EXISTS "tags" (
          "id" TEXT NOT NULL PRIMARY KEY,
          "name" TEXT NOT NULL,
          "normalized" TEXT NOT NULL,
          "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" DATETIME NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS "tags_normalized_key" ON "tags"("normalized");
        CREATE INDEX IF NOT EXISTS "tags_name_idx" ON "tags"("name");
      `,
    });
  }

  if (!ftsTableExists("item_tags")) {
    runSqlite([dbPath], {
      input: `
        CREATE TABLE IF NOT EXISTS "item_tags" (
          "id" TEXT NOT NULL PRIMARY KEY,
          "itemId" TEXT NOT NULL,
          "tagId" TEXT NOT NULL,
          "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "item_tags_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "items" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
          CONSTRAINT "item_tags_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "tags" ("id") ON DELETE CASCADE ON UPDATE CASCADE
        );
        CREATE INDEX IF NOT EXISTS "item_tags_tagId_idx" ON "item_tags"("tagId");
        CREATE INDEX IF NOT EXISTS "item_tags_itemId_idx" ON "item_tags"("itemId");
        CREATE UNIQUE INDEX IF NOT EXISTS "item_tags_itemId_tagId_key" ON "item_tags"("itemId", "tagId");
      `,
    });
  }

  if (!ftsTableExists("tag_aliases")) {
    runSqlite([dbPath], {
      input: `
        CREATE TABLE IF NOT EXISTS "tag_aliases" (
          "id" TEXT NOT NULL PRIMARY KEY,
          "tagId" TEXT NOT NULL,
          "aliasName" TEXT NOT NULL,
          "aliasNormalized" TEXT NOT NULL,
          "createdBy" TEXT NOT NULL DEFAULT 'admin',
          "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" DATETIME NOT NULL,
          CONSTRAINT "tag_aliases_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "tags" ("id") ON DELETE CASCADE ON UPDATE CASCADE
        );
        CREATE UNIQUE INDEX IF NOT EXISTS "tag_aliases_aliasNormalized_key" ON "tag_aliases"("aliasNormalized");
        CREATE INDEX IF NOT EXISTS "tag_aliases_tagId_idx" ON "tag_aliases"("tagId");
        CREATE INDEX IF NOT EXISTS "tag_aliases_aliasName_idx" ON "tag_aliases"("aliasName");
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
          "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" DATETIME NOT NULL
        );
      `,
    });
  }
  dropColumnIfPresent("event_briefing_configs", "includeSingleItems");

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
    addColumnIfMissing("content_clusters", "feedTagsJson", "TEXT NOT NULL DEFAULT '[]'"),
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

  const sql = `${sqliteRuntimePragmas}\n${makeSqliteSchemaIdempotent(loadSchemaSql())}\n${sqliteRuntimePragmas}\n`;
  runSqlite([dbPath], {
    input: sql,
  });
  applyAdditiveSchemaUpgrades();
  cleanupRemovedPromptConfigTypes();
  applyRuntimeSqliteObjects();

  if (testHoldMs > 0) {
    sleep(testHoldMs);
  }

  console.log(`Database initialized: ${dbPath}`);
} finally {
  releaseSetupLock();
}
