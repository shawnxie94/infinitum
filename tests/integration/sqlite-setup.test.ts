import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

function runSqlite(dbPath: string, sql: string) {
  return execFileSync("sqlite3", [dbPath], {
    input: `${sql.trim().replace(/;?$/, ";")}\n`,
    encoding: "utf8",
  }).trim();
}

const tempDirs: string[] = [];

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
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('model_api_configs') WHERE "name" IN ('type', 'dimensions', 'batchSize', 'timeoutMs')`)).toBe("4");
  }, 30_000);

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
