import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

function runSqlite(dbPath: string, sql: string) {
  // 每个 sqlite3 连接独立进程，必须逐连接打开 FK，
  // 否则 legacy drop 顺序不会被真实约束校验。
  return execFileSync("sqlite3", [dbPath], {
    input: `PRAGMA foreign_keys=ON;\n${sql.trim().replace(/;?$/, ";")}\n`,
    encoding: "utf8",
  }).trim();
}

const tempDirs: string[] = [];

// 受保护行内容快照：只取 setup 升级不会重写的语义字段（允许 setup 正常
// 升级派生字段如 display* / feed*，但不允许删数据或改这些核心语义）。
function snapshotProtectedData(dbPath: string) {
  return runSqlite(
    dbPath,
    `
    SELECT 'source' || '|' || "id" || '|' || "name" || '|' || "rssUrl" FROM "sources" WHERE "id" = 'source-legacy';
    SELECT 'item' || '|' || "id" || '|' || "originalTitle" || '|' || "status" || '|' || "moderationStatus" FROM "items" WHERE "id" = 'item-legacy';
    SELECT 'cluster' || '|' || "id" || '|' || "title" || '|' || "summary" || '|' || "status" || '|' || "fingerprint" FROM "content_clusters" WHERE "id" = 'cluster-legacy';
    SELECT 'hidden-cluster' || '|' || "id" || '|' || "title" || '|' || "status" FROM "content_clusters" WHERE "id" = 'cluster-legacy-hidden';
    SELECT 'decision' || '|' || "id" || '|' || "verdict" || '|' || "source" || '|' || "pairKey" FROM "cluster_decisions" WHERE "id" = 'decision-legacy';
    SELECT 'constraint' || '|' || "id" || '|' || "kind" || '|' || "scope" || '|' || "pairKey" FROM "cluster_constraints" WHERE "id" = 'constraint-legacy';
    SELECT 'feedback' || '|' || "id" || '|' || "clusterId" || '|' || "status" || '|' || "note" FROM "cluster_feedback" WHERE "id" = 'feedback-legacy';
    SELECT 'entity' || '|' || "id" || '|' || "name" || '|' || "normalized" FROM "entities" WHERE "id" = 'entity-legacy';
    SELECT 'alias' || '|' || "id" || '|' || "entityId" || '|' || "aliasNormalized" FROM "entity_aliases" WHERE "id" = 'alias-legacy';
    SELECT 'item-entity' || '|' || "itemId" || '|' || "entityId" FROM "item_entities" WHERE "id" = 'item-entity-legacy';
    SELECT 'report' || '|' || "id" || '|' || "title" || '|' || "status" || '|' || "renderedMarkdown" || '|' || "currentRevisionId" FROM "daily_reports" WHERE "id" = 'report-legacy';
    SELECT 'revision' || '|' || "id" || '|' || "dailyReportId" || '|' || "action" || '|' || "renderedMarkdown" FROM "daily_report_revisions" WHERE "id" = 'revision-legacy';
    SELECT 'fetchrun' || '|' || "id" || '|' || "status" || '|' || "itemCount" || '|' || "itemsAdded" || '|' || "successCount" || '|' || "failureCount" FROM "fetch_runs" WHERE "id" = 'fetchrun-legacy';
    SELECT 'pageview' || '|' || "path" || '|' || "visitorId" || '|' || "date" FROM "page_views" WHERE "id" = 'pageview-legacy';
    `,
  );
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();

    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

describe("sqlite setup", () => {
  it("initializes the current schema and runtime objects from the Prisma snapshot", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "infinitum-sqlite-snapshot-"));
    const dbPath = path.join(tempDir, "fresh.db");

    tempDirs.push(tempDir);

    execFileSync("node", ["scripts/setup-sqlite.mjs", dbPath, "--reset"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "sqlite_master" WHERE type = 'table' AND name = 'items'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "sqlite_master" WHERE type = 'table' AND name = 'items_fts'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "sqlite_master" WHERE type = 'table' AND name = '_prisma_migrations'`)).toBe("0");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "sqlite_master" WHERE type = 'table' AND name IN ('briefing_preference_configs', 'briefing_preference_suggestions', 'curator_behavior_events', 'curator_behavior_dimensions')`)).toBe("0");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('model_api_configs') WHERE "name" IN ('type', 'dimensions', 'batchSize', 'timeoutMs')`)).toBe("4");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('cluster_merge_clean_pair_candidates') WHERE "name" IN ('recallSource', 'bm25Score', 'vectorSimilarity')`)).toBe("3");
  }, 30_000);

  it("migrates legacy ISO and Prisma epoch-millisecond dates once, preserving legacy values", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "infinitum-sqlite-window-upgrade-"));
    const dbPath = path.join(tempDir, "legacy-window.db");
    tempDirs.push(tempDir);
    execFileSync("node", ["scripts/setup-sqlite.mjs", dbPath], { cwd: process.cwd(), encoding: "utf8" });

    const dayMs = 24 * 60 * 60 * 1000;
    const isoPast = new Date(Date.now() - 2.1 * dayMs).toISOString();
    const epochPast = Date.now() - 5.1 * dayMs;
    const future = new Date(Date.now() + dayMs).toISOString();
    const ancient = new Date(Date.now() - 4000 * dayMs).toISOString();
    runSqlite(dbPath, `
      ALTER TABLE "task_schedules" DROP COLUMN "processingWindowDays";
      INSERT INTO "task_schedules" ("id", "key", "enabled", "cronExpression", "sourceConcurrency", "fullTextFetchThreshold", "perSourceItemLimit", "processingStartAt", "timezone", "nextRunAt", "updatedAt")
      VALUES ('window-iso', 'window-iso', 0, '0 * * * *', 2, 80, 20, '${isoPast}', 'UTC', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
             ('window-epoch', 'window-epoch', 0, '0 * * * *', 2, 80, 20, ${epochPast}, 'UTC', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
             ('window-null', 'window-null', 0, '0 * * * *', 2, 80, 20, NULL, 'UTC', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
             ('window-future', 'window-future', 0, '0 * * * *', 2, 80, 20, '${future}', 'UTC', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
             ('window-ancient', 'window-ancient', 0, '0 * * * *', 2, 80, 20, '${ancient}', 'UTC', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
             ('window-invalid', 'window-invalid', 0, '0 * * * *', 2, 80, 20, 'not-a-date', 'UTC', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    `);

    execFileSync("node", ["scripts/setup-sqlite.mjs", dbPath], { cwd: process.cwd(), encoding: "utf8" });
    const migrated = runSqlite(dbPath, `SELECT "id" || '|' || "processingWindowDays" || '|' || COALESCE(CAST("processingStartAt" AS TEXT), 'NULL') FROM "task_schedules" WHERE "id" LIKE 'window-%' ORDER BY "id"`);
    expect(migrated).toContain(`window-iso|3|${isoPast}`);
    expect(migrated).toContain(`window-epoch|6|${epochPast}`);
    expect(migrated).toContain("window-null|14|NULL");
    expect(migrated).toContain(`window-future|1|${future}`);
    expect(migrated).toContain(`window-ancient|3650|${ancient}`);
    expect(migrated).toContain("window-invalid|14|not-a-date");
    expect(runSqlite(dbPath, `SELECT "status" FROM "_runtime_schema_migrations" WHERE "key"='task_schedules_processing_window_days_v1'`)).toBe("completed");

    runSqlite(dbPath, `UPDATE "task_schedules" SET "processingWindowDays" = 30 WHERE "id" = 'window-iso';`);
    execFileSync("node", ["scripts/setup-sqlite.mjs", dbPath], { cwd: process.cwd(), encoding: "utf8" });
    expect(runSqlite(dbPath, `SELECT "processingWindowDays" || '|' || "processingStartAt" FROM "task_schedules" WHERE "id"='window-iso'`)).toBe(`30|${isoPast}`);
  }, 30_000);

  it("recovers a defaulted column whose epoch-millisecond backfill was interrupted", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "infinitum-sqlite-window-retry-"));
    const dbPath = path.join(tempDir, "partial-window.db");
    tempDirs.push(tempDir);
    execFileSync("node", ["scripts/setup-sqlite.mjs", dbPath], { cwd: process.cwd(), encoding: "utf8" });

    const legacyEpoch = Date.now() - 4.1 * 24 * 60 * 60 * 1000;
    const selectedAt = Date.now();
    const selectedLegacyEpoch = selectedAt - 14 * 24 * 60 * 60 * 1000;
    runSqlite(dbPath, `
      INSERT INTO "task_schedules" ("id", "key", "enabled", "cronExpression", "sourceConcurrency", "fullTextFetchThreshold", "perSourceItemLimit", "processingStartAt", "processingWindowDays", "timezone", "nextRunAt", "updatedAt")
      VALUES ('partial-window', 'partial-window', 0, '0 * * * *', 2, 80, 20, ${legacyEpoch}, 14, 'UTC', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
             ('selected-14', 'selected-14', 0, '0 * * * *', 2, 80, 20, ${selectedLegacyEpoch}, 14, 'UTC', ${selectedAt}, ${selectedAt});
    `);

    // Simulates the old partial upgrade: the additive column/default survived, but no completion marker/backfill did.
    expect(runSqlite(dbPath, `SELECT "status" FROM "_runtime_schema_migrations" WHERE "key"='task_schedules_processing_window_days_v1'`)).toBe("");
    execFileSync("node", ["scripts/setup-sqlite.mjs", dbPath], { cwd: process.cwd(), encoding: "utf8" });
    expect(runSqlite(dbPath, `SELECT "processingWindowDays" FROM "task_schedules" WHERE "id"='partial-window'`)).toBe("5");
    expect(runSqlite(dbPath, `SELECT "status" FROM "_runtime_schema_migrations" WHERE "key"='task_schedules_processing_window_days_v1'`)).toBe("completed");
    expect(runSqlite(dbPath, `SELECT "processingWindowDays" || '|' || "processingStartAt" FROM "task_schedules" WHERE "id"='selected-14'`)).toBe(`14|${selectedLegacyEpoch}`);

    runSqlite(dbPath, `UPDATE "task_schedules" SET "processingWindowDays"=30 WHERE "id"='partial-window';`);
    execFileSync("node", ["scripts/setup-sqlite.mjs", dbPath], { cwd: process.cwd(), encoding: "utf8" });
    expect(runSqlite(dbPath, `SELECT "processingWindowDays" FROM "task_schedules" WHERE "id"='partial-window'`)).toBe("30");
  }, 30_000);

  it("upgrades legacy merge candidate cache rows without inferring their provenance", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "infinitum-sqlite-merge-cache-upgrade-"));
    const dbPath = path.join(tempDir, "legacy-merge-cache.db");

    tempDirs.push(tempDir);

    execFileSync("node", ["scripts/setup-sqlite.mjs", dbPath], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    runSqlite(
      dbPath,
      `
      ALTER TABLE "cluster_merge_clean_pair_candidates" DROP COLUMN "recallSource";
      ALTER TABLE "cluster_merge_clean_pair_candidates" DROP COLUMN "bm25Score";
      ALTER TABLE "cluster_merge_clean_pair_candidates" DROP COLUMN "vectorSimilarity";
      PRAGMA foreign_keys=OFF;
      INSERT INTO "cluster_merge_clean_pair_candidates" (
        "id", "pairKey", "leftClusterId", "rightClusterId", "leftInputHash", "rightInputHash",
        "score", "attemptCount", "expiresAt", "createdAt", "updatedAt"
      ) VALUES (
        'legacy-candidate', 'legacy-pair', 'left-cluster', 'right-cluster', 'left-hash', 'right-hash',
        123, 2, '2026-10-01T00:00:00.000Z', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
      PRAGMA foreign_keys=ON;
      `,
    );

    for (let attempt = 0; attempt < 2; attempt += 1) {
      execFileSync("node", ["scripts/setup-sqlite.mjs", dbPath], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
    }

    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('cluster_merge_clean_pair_candidates') WHERE "name" IN ('recallSource', 'bm25Score', 'vectorSimilarity')`)).toBe("3");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "cluster_merge_clean_pair_candidates" WHERE "id" = 'legacy-candidate' AND "recallSource" IS NULL AND "bm25Score" IS NULL AND "vectorSimilarity" IS NULL AND "score" = 123 AND "attemptCount" = 2`)).toBe("1");
  }, 30_000);

  it("drops legacy curator preference tables idempotently and keeps protected business data", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "infinitum-sqlite-curator-drop-"));
    const dbPath = path.join(tempDir, "legacy-curator.db");

    tempDirs.push(tempDir);

    execFileSync("node", ["scripts/setup-sqlite.mjs", dbPath], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    // Simulate a legacy volume that still carries the four dedicated curator
    // preference tables (real FK between dimensions and behavior events) next
    // to protected business and governance data.
    runSqlite(
      dbPath,
      `
      PRAGMA trusted_schema = ON;
      CREATE TABLE "briefing_preference_configs" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "weightedRulesJson" TEXT NOT NULL DEFAULT '[]',
        "maxCuratorBoost" INTEGER NOT NULL DEFAULT 15,
        "maxCuratorPenalty" INTEGER NOT NULL DEFAULT 20,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL
      );
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
      INSERT INTO "curator_behavior_events" ("id", "eventType", "targetType", "targetId", "score")
        VALUES ('behavior-1', 'manual_boost', 'item', 'item-1', 2);
      INSERT INTO "curator_behavior_dimensions" ("id", "eventId", "ruleType", "value", "score", "targetDedupKey")
        VALUES ('dimension-1', 'behavior-1', 'entity', 'ai-coding', 2, 'entity:ai-coding:behavior-1');
      INSERT INTO "briefing_preference_configs" ("id", "weightedRulesJson", "createdAt", "updatedAt")
        VALUES ('preference-1', '[{"type":"entity","value":"ai-coding","weight":3}]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO "briefing_preference_suggestions" (
        "id", "suggestionKey", "ruleType", "value", "suggestedWeight", "confidence",
        "positiveScore", "negativeScore", "sampleCount", "reason", "status", "createdAt", "updatedAt"
      ) VALUES (
        'suggestion-1', 'entity:ai-coding', 'entity', 'ai-coding', 3, 0.7,
        8, 0, 3, '历史建议', 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );

      INSERT INTO "source_groups" ("id", "name", "color", "sortOrder", "createdAt", "updatedAt")
        VALUES ('group-legacy', 'AI', '#000000', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO "sources" (
        "id", "name", "rssUrl", "siteUrl", "enabled", "aiParsingEnabled", "aggregationEnabled",
        "aggregationDetectionEnabled", "groupId", "createdAt", "updatedAt"
      ) VALUES (
        'source-legacy', 'AI Blog', 'https://legacy.example.com/feed.xml', 'https://legacy.example.com',
        1, 1, 1, 1, 'group-legacy', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
      INSERT INTO "items" (
        "id", "sourceId", "originalUrl", "canonicalUrl", "urlHash", "originalTitle",
        "publishedAt", "publishedAtKnown", "status", "moderationStatus", "qualityScore", "createdAt", "updatedAt"
      ) VALUES (
        'item-legacy', 'source-legacy', 'https://legacy.example.com/a', 'https://legacy.example.com/a',
        'hash-legacy', 'Legacy item', '2026-06-30T07:00:00.000Z', 1, 'filtered', 'filtered', 90,
        '2026-06-30T08:00:00.000Z', CURRENT_TIMESTAMP
      );
      INSERT INTO "content_clusters" (
        "id", "title", "summary", "score", "itemCount", "status",
        "latestPublishedAt", "fingerprint", "createdAt", "updatedAt"
      ) VALUES (
        'cluster-legacy', 'Legacy cluster', 'Legacy cluster summary', 80, 1, 'published',
        '2026-06-30T07:30:00.000Z', 'cluster-legacy', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
      UPDATE "items" SET "clusterId" = 'cluster-legacy' WHERE "id" = 'item-legacy';
      INSERT INTO "event_briefing_configs" ("id", "minRankScore", "briefingChannelsJson", "createdAt", "updatedAt")
        VALUES ('briefing-config-legacy', 0, '[]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

      -- hidden 是 content_clusters 的合法治理状态；治理表行（决策/约束/反馈）为真实合法语义。
      INSERT INTO "content_clusters" (
        "id", "title", "summary", "score", "itemCount", "status",
        "latestPublishedAt", "fingerprint", "feedStatsUpdatedAt", "createdAt", "updatedAt"
      ) VALUES (
        'cluster-legacy-hidden', 'Hidden legacy cluster', 'Hidden legacy summary', 40, 0, 'hidden',
        '2026-06-29T07:00:00.000Z', 'cluster-legacy-hidden', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
      INSERT INTO "cluster_decisions" (
        "id", "kind", "source", "verdict", "leftClusterId", "rightClusterId",
        "pairKey", "inputHash", "createdAt", "updatedAt"
      ) VALUES (
        'decision-legacy', 'cluster_pair', 'manual', 'declined',
        'cluster-legacy', 'cluster-legacy-hidden', 'legacy-pair', 'legacy-input-hash',
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
      INSERT INTO "cluster_constraints" (
        "id", "kind", "scope", "leftId", "rightId", "pairKey", "createdBy", "createdAt", "updatedAt"
      ) VALUES (
        'constraint-legacy', 'cannot_link', 'cluster_cluster',
        'cluster-legacy', 'cluster-legacy-hidden', 'legacy-pair', 'admin', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
      INSERT INTO "cluster_feedback" (
        "id", "clusterId", "clusterTitle", "status", "note", "createdAt"
      ) VALUES (
        'feedback-legacy', 'cluster-legacy', 'Legacy cluster', 'open', '遗留反馈意见', CURRENT_TIMESTAMP
      );

      -- 实体及关联：entities ← entity_aliases / item_entities → items（真实 FK）。
      INSERT INTO "entities" ("id", "name", "normalized", "createdAt", "updatedAt")
        VALUES ('entity-legacy', 'Legacy Entity', 'legacy entity', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO "entity_aliases" (
        "id", "entityId", "aliasName", "aliasNormalized", "createdBy", "createdAt", "updatedAt"
      ) VALUES (
        'alias-legacy', 'entity-legacy', 'Legacy Alias', 'legacy alias', 'admin', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
      INSERT INTO "item_entities" ("id", "itemId", "entityId", "createdAt")
        VALUES ('item-entity-legacy', 'item-legacy', 'entity-legacy', CURRENT_TIMESTAMP);

      -- 日报实际表：daily_reports ← daily_report_revisions（真实 FK，含 currentRevisionId 回链）。
      INSERT INTO "daily_reports" (
        "id", "date", "timezone", "status", "title", "openingSummary", "closingThought",
        "summaryJson", "renderedMarkdown", "inputHash", "createdAt", "updatedAt"
      ) VALUES (
        'report-legacy', '2026-06-30', 'Asia/Shanghai', 'published', 'Legacy daily report',
        'Legacy opening', 'Legacy closing', '[]', '# Legacy daily report',
        'report-hash-legacy', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
      INSERT INTO "daily_report_revisions" (
        "id", "dailyReportId", "revisionNo", "action", "status", "title", "openingSummary", "closingThought",
        "summaryJson", "renderedMarkdown", "inputHash", "actorType", "createdAt"
      ) VALUES (
        'revision-legacy', 'report-legacy', 1, 'baseline', 'published', 'Legacy daily report',
        'Legacy opening', 'Legacy closing', '[]', '# Legacy revision markdown',
        'report-hash-legacy', 'system', CURRENT_TIMESTAMP
      );
      UPDATE "daily_reports" SET "currentRevisionId" = 'revision-legacy' WHERE "id" = 'report-legacy';

      -- 非偏好通用统计的实际模型：schema 中没有通用偏好统计表，通用统计落在
      -- fetch_runs（采集统计字段）与 page_views（通用访问统计），此处一并保护。
      INSERT INTO "fetch_runs" (
        "id", "triggerType", "status", "sourceCount", "itemCount",
        "successCount", "failureCount", "itemsAdded", "startedAt"
      ) VALUES (
        'fetchrun-legacy', 'scheduled', 'succeeded', 1, 1, 1, 0, 1, CURRENT_TIMESTAMP
      );
      INSERT INTO "page_views" ("id", "path", "visitorId", "date", "createdAt")
        VALUES ('pageview-legacy', '/', 'visitor-legacy', '2026-06-30', CURRENT_TIMESTAMP);
      `,
    );

    const snapshotBefore = snapshotProtectedData(dbPath);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      execFileSync("node", ["scripts/setup-sqlite.mjs", dbPath], {
        cwd: process.cwd(),
        encoding: "utf8",
      });

      expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "sqlite_master" WHERE type = 'table' AND name IN ('briefing_preference_configs', 'briefing_preference_suggestions', 'curator_behavior_events', 'curator_behavior_dimensions')`)).toBe("0");
      expect(runSqlite(dbPath, "PRAGMA foreign_key_check")).toBe("");
      // 内容级一致：不只是行数，快照包含受保护行的关键字段值。
      expect(snapshotProtectedData(dbPath)).toBe(snapshotBefore);
      expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "sources" WHERE "id" = 'source-legacy'`)).toBe("1");
      expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "items" WHERE "id" = 'item-legacy' AND "status" = 'filtered' AND "moderationStatus" = 'filtered'`)).toBe("1");
      expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "content_clusters" WHERE "id" = 'cluster-legacy' AND "status" = 'published'`)).toBe("1");
      expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "event_briefing_configs" WHERE "id" = 'briefing-config-legacy'`)).toBe("1");
      expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "source_groups" WHERE "id" = 'group-legacy'`)).toBe("1");
    }
  }, 60_000);

  it("serializes concurrent setup runs with a lock", { timeout: 30000 }, async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "infinitum-sqlite-lock-"));
    const dbPath = path.join(tempDir, "concurrent.db");
    const root = process.cwd();

    tempDirs.push(tempDir);

    const runSetup = (holdMs: number) =>
      new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
        const child = spawn("node", ["scripts/setup-sqlite.mjs", dbPath], {
          cwd: root,
          env: {
            ...process.env,
            SQLITE_SETUP_LOCK_HOLD_MS: String(holdMs),
            SQLITE_SETUP_LOCK_TIMEOUT_MS: "10000",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });

        let stderr = "";

        child.stderr.on("data", (chunk) => {
          stderr += chunk.toString();
        });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stderr }));
      });

    const firstRun = runSetup(400);
    const secondRun = runSetup(0);
    const [firstResult, secondResult] = await Promise.all([firstRun, secondRun]);

    expect(firstResult.code).toBe(0);
    expect(secondResult.code).toBe(0);
    expect(firstResult.stderr).not.toContain("Error");
    expect(secondResult.stderr).not.toContain("Error");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "sqlite_master" WHERE "type" = 'table' AND "name" = 'model_api_configs'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "sqlite_master" WHERE "type" = 'table' AND "name" = 'prompt_configs'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('prompt_configs') WHERE "name" = 'templateJson'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('prompt_configs') WHERE "name" = 'userPrompt'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "sqlite_master" WHERE "type" = 'table' AND "name" = 'aggregation_split_links'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('task_schedules') WHERE "name" = 'sourceConcurrency'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('task_schedules') WHERE "name" = 'fullTextFetchThreshold'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('task_schedules') WHERE "name" = 'aggregationSplitMaxEvents'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('task_schedules') WHERE "name" = 'dailyReportPlanningBatchSize'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('task_schedules') WHERE "name" = 'dailyReportRecentTopicLookbackDays'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT dflt_value FROM pragma_table_info('task_schedules') WHERE name = 'dailyReportRecentTopicLookbackDays'`)).toBe("7");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('task_schedules') WHERE "name" = 'dailyReportMaxRetries'`)).toBe("0");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('background_task_runs') WHERE "name" = 'fullTextFetchedCount'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('background_task_runs') WHERE "name" = 'aiCallBreakdownJson'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('background_task_runs') WHERE "name" = 'stageTimingsJson'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('background_task_runs') WHERE "name" = 'taskTimelineJson'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('background_task_runs') WHERE "name" = 'pipelineCheckpointJson'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('prompt_configs') WHERE "name" = 'templateMigrationAuditJson'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "sqlite_master" WHERE "type" = 'table' AND "name" = 'content_extraction_configs'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "sqlite_master" WHERE "type" = 'table' AND "name" = 'entity_aliases'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "sqlite_master" WHERE "type" = 'table' AND "name" = 'entity_suggestion_candidates'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "sqlite_master" WHERE "type" = 'table' AND "name" = 'header_links'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "sqlite_master" WHERE "type" = 'table' AND "name" = 'cluster_merge_clean_pair_candidates'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "sqlite_master" WHERE "type" = 'table' AND "name" = 'cluster_decisions'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "sqlite_master" WHERE "type" = 'table' AND "name" = 'cluster_constraints'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('source_groups') WHERE "name" = 'sortOrder'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('items') WHERE "name" = 'summaryStatus'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('items') WHERE "name" = 'analysisStatus'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('items') WHERE "name" = 'publishedAtKnown'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('items') WHERE "name" = 'manualClusterAssignedAt'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('items') WHERE "name" = 'understandingInputHash'`)).toBe("0");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('items') WHERE "name" = 'understandingVersion'`)).toBe("0");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('daily_reports') WHERE "name" = 'candidateSnapshot'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('daily_reports') WHERE "name" = 'currentRevisionId'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "sqlite_master" WHERE "type" = 'table' AND "name" = 'daily_report_revisions'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "sqlite_master" WHERE "type" = 'table' AND "name" = 'daily_report_revision_sources'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "sqlite_master" WHERE "type" = 'table' AND "name" = 'daily_report_operation_locks'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_foreign_key_list('daily_report_revisions') WHERE "table" = 'daily_report_revisions' AND "from" = 'restoredFromRevisionId' AND "to" = 'id'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('sources') WHERE "name" = 'healthStatus'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('content_clusters') WHERE "name" = 'displayItemCount'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('content_clusters') WHERE "name" = 'displaySourceCount'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('content_clusters') WHERE "name" = 'displayAverageScore'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('content_clusters') WHERE "name" = 'displayQualityScore'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('content_clusters') WHERE "name" = 'displayRecommendScore'`)).toBe("0");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('event_briefing_configs') WHERE "name" = 'minRankScore'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('event_briefing_configs') WHERE "name" = 'minAttentionScore'`)).toBe("0");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('event_briefing_configs') WHERE "name" = 'includeSingleItems'`)).toBe("0");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('content_clusters') WHERE "name" = 'earliestCreatedAt'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('content_clusters') WHERE "name" = 'latestCreatedAt'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('content_clusters') WHERE "name" = 'dominantGroupId'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('content_clusters') WHERE "name" = 'feedSearchText'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('content_clusters') WHERE "name" = 'feedEntitiesJson'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('content_clusters') WHERE "name" = 'feedStatsUpdatedAt'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('content_clusters') WHERE "name" = 'eventFingerprint'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('content_clusters') WHERE "name" = 'eventBucket'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "sqlite_master" WHERE "type" = 'index' AND "name" = 'sources_enabled_healthStatus_idx'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "sqlite_master" WHERE "type" = 'index' AND "name" = 'items_status_moderationStatus_updatedAt_idx'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "sqlite_master" WHERE "type" = 'index' AND "name" = 'content_clusters_status_latestCreatedAt_idx'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "sqlite_master" WHERE "type" = 'index' AND "name" = 'content_clusters_status_earliestCreatedAt_idx'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "sqlite_master" WHERE "type" = 'index' AND "name" = 'content_clusters_status_displayQualityScore_idx'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "sqlite_master" WHERE "type" = 'index' AND "name" = 'content_clusters_dominantGroupId_status_latestCreatedAt_idx'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "sqlite_master" WHERE "type" = 'index' AND "name" = 'cluster_merge_clean_pair_candidates_pairKey_key'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "sqlite_master" WHERE "type" = 'index' AND "name" = 'cluster_merge_clean_pair_candidates_expiresAt_idx'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "sqlite_master" WHERE "type" = 'index' AND "name" = 'cluster_decisions_kind_pairKey_inputHash_idx'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "sqlite_master" WHERE "type" = 'index' AND "name" = 'cluster_constraints_kind_scope_pairKey_key'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "sqlite_master" WHERE "type" = 'index' AND "name" = 'entity_aliases_aliasNormalized_key'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "sqlite_master" WHERE "type" = 'index' AND "name" = 'entity_suggestion_candidates_status_confidence_idx'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "sqlite_master" WHERE "type" = 'index' AND "name" = 'entity_suggestion_candidates_status_affectedItemCount_idx'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "sqlite_master" WHERE "type" = 'index' AND "name" = 'header_links_enabled_sortOrder_idx'`)).toBe("1");
    expect(runSqlite(dbPath, "PRAGMA journal_mode")).toBe("wal");
  });

  it("adds templateJson to existing prompt config tables without dropping rows", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "infinitum-sqlite-upgrade-"));
    const dbPath = path.join(tempDir, "upgrade.db");

    tempDirs.push(tempDir);

    runSqlite(
      dbPath,
      `
      CREATE TABLE "prompt_configs" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "name" TEXT NOT NULL,
        "type" TEXT NOT NULL,
        "prompt" TEXT NOT NULL,
        "systemPrompt" TEXT,
        "temperature" REAL,
        "maxTokens" INTEGER,
        "topP" REAL,
        "modelApiConfigId" TEXT,
        "isEnabled" BOOLEAN NOT NULL DEFAULT true,
        "isDefault" BOOLEAN NOT NULL DEFAULT false,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL
      );
      INSERT INTO "prompt_configs" (
        "id", "name", "type", "prompt", "systemPrompt", "isEnabled", "isDefault", "updatedAt"
      ) VALUES (
        'prompt-old', '旧日报提示词', 'daily_report', '模板', '系统提示词', true, true, CURRENT_TIMESTAMP
      );
      `,
    );

    execFileSync("node", ["scripts/setup-sqlite.mjs", dbPath], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('prompt_configs') WHERE "name" = 'templateJson'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT "userPrompt" FROM "prompt_configs" WHERE "id" = 'prompt-old'`)).toBe("模板");
    expect(runSqlite(dbPath, `SELECT "name" FROM "prompt_configs" WHERE "id" = 'prompt-old'`)).toBe("旧日报提示词");
  }, 15_000);

  it("adds publishedAtKnown to an existing items table without dropping item data", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "infinitum-sqlite-published-at-upgrade-"));
    const dbPath = path.join(tempDir, "published-at-upgrade.db");

    tempDirs.push(tempDir);

    execFileSync("node", ["scripts/setup-sqlite.mjs", dbPath], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    runSqlite(
      dbPath,
      `
      PRAGMA trusted_schema = ON;
      ALTER TABLE "items" DROP COLUMN "publishedAtKnown";
      INSERT INTO "sources" (
        "id", "name", "rssUrl", "siteUrl", "updatedAt"
      ) VALUES (
        'source-published-at-upgrade', 'Upgrade Source', 'https://upgrade.example.com/published-at.xml',
        'https://upgrade.example.com', CURRENT_TIMESTAMP
      );
      INSERT INTO "items" (
        "id", "sourceId", "originalUrl", "canonicalUrl", "urlHash", "originalTitle", "publishedAt",
        "status", "moderationStatus", "qualityScore", "qualityRationale", "language", "createdAt", "updatedAt"
      ) VALUES (
        'item-published-at-upgrade', 'source-published-at-upgrade', 'https://upgrade.example.com/published-at',
        'https://upgrade.example.com/published-at', 'published-at-upgrade-hash', 'Existing item', CURRENT_TIMESTAMP,
        'processed', 'allowed', 50, 'existing', 'en', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
      `,
    );

    execFileSync("node", ["scripts/setup-sqlite.mjs", dbPath], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(runSqlite(dbPath, `SELECT "originalTitle" FROM "items" WHERE "id" = 'item-published-at-upgrade'`)).toBe("Existing item");
    expect(runSqlite(dbPath, `SELECT "publishedAtKnown" FROM "items" WHERE "id" = 'item-published-at-upgrade'`)).toBe("1");
  }, 30_000);

  it("keeps items data and FTS sync when setup runs against an existing volume", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "infinitum-sqlite-understanding-upgrade-"));
    const dbPath = path.join(tempDir, "understanding-upgrade.db");

    tempDirs.push(tempDir);
    execFileSync("node", ["scripts/setup-sqlite.mjs", dbPath], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    runSqlite(
      dbPath,
      `
      PRAGMA trusted_schema = ON;
      INSERT INTO "sources" (
        "id", "name", "rssUrl", "siteUrl", "enabled", "aiParsingEnabled", "aggregationEnabled", "aggregationDetectionEnabled", "updatedAt"
      ) VALUES (
        'source-understanding-upgrade', 'Upgrade Source', 'https://upgrade.example.com/feed.xml', 'https://upgrade.example.com',
        true, true, true, false, CURRENT_TIMESTAMP
      );
      INSERT INTO "items" (
        "id", "sourceId", "originalUrl", "canonicalUrl", "urlHash", "originalTitle", "publishedAt",
        "status", "moderationStatus", "qualityScore", "qualityRationale", "language", "createdAt", "updatedAt"
      ) VALUES (
        'item-understanding-upgrade', 'source-understanding-upgrade', 'https://upgrade.example.com/item',
        'https://upgrade.example.com/item', 'item-understanding-upgrade', 'Existing item', CURRENT_TIMESTAMP,
        'processed', 'allowed', 50, 'existing', 'en', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
      `,
    );

    execFileSync("node", ["scripts/setup-sqlite.mjs", dbPath], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(runSqlite(dbPath, `SELECT "originalTitle" FROM "items" WHERE "id" = 'item-understanding-upgrade'`)).toBe("Existing item");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "sqlite_master" WHERE "type" = 'trigger' AND "name" LIKE 'items_fts_%'`)).toBe("3");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "items_fts" WHERE "rowid" = (SELECT "rowid" FROM "items" WHERE "id" = 'item-understanding-upgrade')`)).toBe("1");
  }, 20_000);

  it("restores lost FTS triggers and backfills missing index rows on an existing volume", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "infinitum-sqlite-fts-repair-"));
    const dbPath = path.join(tempDir, "fts-repair.db");

    tempDirs.push(tempDir);

    execFileSync("node", ["scripts/setup-sqlite.mjs", dbPath], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    // 模拟存量卷的失步状态：触发器丢失 + 触发器缺位期间新增的条目没有进索引
    runSqlite(dbPath, `
      DROP TRIGGER "items_fts_ai";
      DROP TRIGGER "items_fts_au";
      DROP TRIGGER "items_fts_ad";
      INSERT INTO "sources" (
        "id", "name", "rssUrl", "siteUrl", "enabled", "aiParsingEnabled", "aggregationEnabled", "aggregationDetectionEnabled", "updatedAt"
      ) VALUES (
        'source-fts-repair', 'Repair Source', 'https://repair.example.com/feed.xml', 'https://repair.example.com',
        true, true, true, false, CURRENT_TIMESTAMP
      );
      INSERT INTO "items" (
        "id", "sourceId", "originalUrl", "canonicalUrl", "urlHash", "originalTitle", "publishedAt",
        "status", "moderationStatus", "qualityScore", "qualityRationale", "language", "createdAt", "updatedAt"
      ) VALUES (
        'item-fts-repair', 'source-fts-repair', 'https://repair.example.com/item',
        'https://repair.example.com/item', 'item-fts-repair', 'QuantumLeap Release', CURRENT_TIMESTAMP,
        'processed', 'allowed', 50, 'existing', 'en', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
      DELETE FROM "items_fts" WHERE rowid NOT IN (SELECT rowid FROM "items_fts" LIMIT 1);
    `);

    execFileSync("node", ["scripts/setup-sqlite.mjs", dbPath], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "sqlite_master" WHERE "type" = 'trigger' AND "name" LIKE 'items_fts_%'`)).toBe("3");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "items_fts"`)).toBe(
      runSqlite(dbPath, `SELECT COUNT(*) FROM "items"`),
    );
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "items_fts" WHERE "originalTitle" = 'QuantumLeap Release'`)).toBe("1");
  }, 20_000);

  it("does not rerun cluster feed stats backfill or earliestCreatedAt backfill after clusters have been initialized", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "infinitum-sqlite-cluster-backfill-"));
    const dbPath = path.join(tempDir, "cluster-backfill.db");

    tempDirs.push(tempDir);

    execFileSync("node", ["scripts/setup-sqlite.mjs", dbPath], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    runSqlite(
      dbPath,
      `
      PRAGMA trusted_schema = ON;

      INSERT INTO "sources" (
        "id", "name", "rssUrl", "siteUrl", "enabled", "aiParsingEnabled", "aggregationEnabled", "aggregationDetectionEnabled", "updatedAt"
      ) VALUES (
        'source-backfilled', 'Backfilled Source', 'https://backfilled.example.com/feed.xml', 'https://backfilled.example.com',
        true, true, true, false, CURRENT_TIMESTAMP
      );

      INSERT INTO "content_clusters" (
        "id", "kind", "title", "summary", "score", "itemCount", "latestPublishedAt", "status", "fingerprint",
        "displayItemCount", "displaySourceCount", "displayAverageScore", "displayQualityScore", "earliestCreatedAt", "latestCreatedAt",
        "feedSearchText", "feedEntitiesJson", "feedStatsUpdatedAt", "updatedAt"
      ) VALUES (
        'cluster-backfilled', 'topic', 'Backfilled Cluster', 'Backfilled summary', 50, 1, '2026-04-10T10:00:00.000Z', 'active', 'cluster-backfilled',
        7, 3, 88, 91, NULL, '2026-04-10T10:05:00.000Z', 'precomputed text', '[]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );

      INSERT INTO "items" (
        "id", "sourceId", "clusterId", "originalUrl", "canonicalUrl", "urlHash", "originalTitle",
        "publishedAt", "status", "moderationStatus", "qualityScore", "qualityRationale", "language", "createdAt", "updatedAt"
      ) VALUES (
        'item-backfilled', 'source-backfilled', 'cluster-backfilled', 'https://backfilled.example.com/item',
        'https://backfilled.example.com/item', 'item-backfilled', 'Backfilled Item',
        '2026-04-10T10:00:00.000Z', 'processed', 'allowed', 50, 'ok', 'en', '2026-04-10T10:05:00.000Z', CURRENT_TIMESTAMP
      );
      `,
    );

    execFileSync("node", ["scripts/setup-sqlite.mjs", dbPath], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(runSqlite(dbPath, `SELECT "displayItemCount" FROM "content_clusters" WHERE id = 'cluster-backfilled'`)).toBe("7");
    // displayAverageScore=88 ≠ displayQualityScore=91：重跑 setup 不得把质量分 v4 的
    // 持久化精选分覆盖回平均分（旧行为会在容器每次重启时清掉校准值）。
    expect(runSqlite(dbPath, `SELECT "displayQualityScore" FROM "content_clusters" WHERE id = 'cluster-backfilled'`)).toBe("91");
    expect(runSqlite(dbPath, `SELECT COALESCE("earliestCreatedAt", '') FROM "content_clusters" WHERE id = 'cluster-backfilled'`)).toBe("");
  }, 20_000);

  it("repairs stale cluster feed stats when a newer visible item exists after initialization", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "infinitum-sqlite-cluster-stale-backfill-"));
    const dbPath = path.join(tempDir, "cluster-stale-backfill.db");

    tempDirs.push(tempDir);

    execFileSync("node", ["scripts/setup-sqlite.mjs", dbPath], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    runSqlite(
      dbPath,
      `
      PRAGMA trusted_schema = ON;

      INSERT INTO "sources" (
        "id", "name", "rssUrl", "siteUrl", "enabled", "aiParsingEnabled", "aggregationEnabled", "aggregationDetectionEnabled", "updatedAt"
      ) VALUES (
        'source-stale-backfilled', 'Stale Backfilled Source', 'https://stale-backfilled.example.com/feed.xml', 'https://stale-backfilled.example.com',
        true, true, true, false, CURRENT_TIMESTAMP
      );

      INSERT INTO "content_clusters" (
        "id", "kind", "title", "summary", "score", "itemCount", "latestPublishedAt", "status", "fingerprint",
        "displayItemCount", "displaySourceCount", "displayAverageScore", "displayQualityScore", "earliestCreatedAt", "latestCreatedAt",
        "feedSearchText", "feedEntitiesJson", "feedStatsUpdatedAt", "updatedAt"
      ) VALUES (
        'cluster-stale-backfilled', 'topic', 'Stale Backfilled Cluster', 'Stale backfilled summary', 50, 1, '2026-04-10T10:00:00.000Z', 'active', 'cluster-stale-backfilled',
        1, 1, 50, 50, '2026-04-10T10:05:00.000Z', '2026-04-10T10:05:00.000Z', 'stale text', '[]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );

      INSERT INTO "items" (
        "id", "sourceId", "clusterId", "originalUrl", "canonicalUrl", "urlHash", "originalTitle",
        "publishedAt", "status", "moderationStatus", "qualityScore", "qualityRationale", "language", "createdAt", "updatedAt"
      ) VALUES
      (
        'item-stale-old', 'source-stale-backfilled', 'cluster-stale-backfilled', 'https://stale-backfilled.example.com/old',
        'https://stale-backfilled.example.com/old', 'item-stale-old', 'Stale Old Item',
        '2026-04-10T10:00:00.000Z', 'processed', 'allowed', 50, 'ok', 'en', '2026-04-10T10:05:00.000Z', CURRENT_TIMESTAMP
      ),
      (
        'item-stale-new', 'source-stale-backfilled', 'cluster-stale-backfilled', 'https://stale-backfilled.example.com/new',
        'https://stale-backfilled.example.com/new', 'item-stale-new', 'Stale New Item',
        '2026-04-11T10:00:00.000Z', 'processed', 'allowed', 90, 'ok', 'en', '2026-04-11T10:05:00.000Z', CURRENT_TIMESTAMP
      );
      `,
    );

    execFileSync("node", ["scripts/setup-sqlite.mjs", dbPath], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(runSqlite(dbPath, `SELECT "displayItemCount" FROM "content_clusters" WHERE id = 'cluster-stale-backfilled'`)).toBe("2");
    expect(runSqlite(dbPath, `SELECT "displayQualityScore" FROM "content_clusters" WHERE id = 'cluster-stale-backfilled'`)).toBe("70");
    expect(runSqlite(dbPath, `SELECT "latestCreatedAt" FROM "content_clusters" WHERE id = 'cluster-stale-backfilled'`)).toBe("2026-04-11T10:05:00.000Z");
  }, 30_000);

  it("backfills the latest 500 historical item entities once during the entity upgrade", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "infinitum-sqlite-entity-backfill-"));
    const dbPath = path.join(tempDir, "entity-backfill.db");

    tempDirs.push(tempDir);

    execFileSync("node", ["scripts/setup-sqlite.mjs", dbPath], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    const itemValues = Array.from({ length: 501 }, (_, index) => {
      const itemId = `item-entity-backfill-${String(index).padStart(3, "0")}`;
      const timestamp = new Date(Date.UTC(2026, 0, 1 + index)).toISOString();
      return `(
        '${itemId}', 'source-entity-backfill', 'cluster-entity-backfill', 'https://entity-backfill.example.com/${itemId}',
        'https://entity-backfill.example.com/${itemId}', '${itemId}', 'Entity Backfill Item ${index}', '${timestamp}',
        'processed', 'allowed', 50, 'ok', 'en', 'Entity ${index}', NULL, '${timestamp}', '${timestamp}'
      )`;
    }).join(",\n");

    runSqlite(
      dbPath,
      `
      PRAGMA trusted_schema = ON;

      INSERT INTO "sources" (
        "id", "name", "rssUrl", "siteUrl", "enabled", "aiParsingEnabled", "aggregationEnabled", "aggregationDetectionEnabled", "updatedAt"
      ) VALUES (
        'source-entity-backfill', 'Entity Backfill Source', 'https://entity-backfill.example.com/feed.xml', 'https://entity-backfill.example.com',
        true, true, true, false, CURRENT_TIMESTAMP
      );

      INSERT INTO "content_clusters" (
        "id", "kind", "title", "summary", "score", "itemCount", "latestPublishedAt", "status", "fingerprint",
        "feedEntitiesJson", "updatedAt"
      ) VALUES (
        'cluster-entity-backfill', 'topic', 'Entity Backfill Cluster', 'Entity backfill summary', 50, 1, CURRENT_TIMESTAMP, 'active', 'cluster-entity-backfill',
        '[]', CURRENT_TIMESTAMP
      );

      INSERT INTO "items" (
        "id", "sourceId", "clusterId", "originalUrl", "canonicalUrl", "urlHash", "originalTitle",
        "publishedAt", "status", "moderationStatus", "qualityScore", "qualityRationale", "language",
        "eventSubject", "eventObject", "createdAt", "updatedAt"
      ) VALUES ${itemValues};

      PRAGMA foreign_keys=OFF;
      DROP TABLE "item_entities";
      DROP TABLE "entity_suggestion_candidates";
      DROP TABLE "entity_suggestion_decisions";
      DROP TABLE "entity_aliases";
      DROP TABLE "entities";
      PRAGMA foreign_keys=ON;
      `,
    );

    execFileSync("node", ["scripts/setup-sqlite.mjs", dbPath], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "entities"`)).toBe("500");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "item_entities"`)).toBe("500");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "item_entities" WHERE "itemId" = 'item-entity-backfill-500'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "item_entities" WHERE "itemId" = 'item-entity-backfill-000'`)).toBe("0");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "entities" WHERE "normalized" = 'entity 500'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT "feedEntitiesJson" FROM "content_clusters" WHERE "id" = 'cluster-entity-backfill'`)).toContain("Entity 500");

    runSqlite(
      dbPath,
      `
      PRAGMA trusted_schema = ON;
      INSERT INTO "items" (
        "id", "sourceId", "originalUrl", "canonicalUrl", "urlHash", "originalTitle",
        "publishedAt", "status", "moderationStatus", "qualityScore", "qualityRationale", "language",
        "eventSubject", "createdAt", "updatedAt"
      ) VALUES (
        'item-entity-backfill-later', 'source-entity-backfill', 'https://entity-backfill.example.com/later',
        'https://entity-backfill.example.com/later', 'item-entity-backfill-later', 'Later Item', CURRENT_TIMESTAMP,
        'processed', 'allowed', 50, 'ok', 'en', 'Later Entity', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
      `,
    );

    execFileSync("node", ["scripts/setup-sqlite.mjs", dbPath], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "item_entities" WHERE "itemId" = 'item-entity-backfill-later'`)).toBe("0");
  }, 30_000);

});
