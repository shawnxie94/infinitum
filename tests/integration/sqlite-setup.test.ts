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
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "sqlite_master" WHERE "type" = 'table' AND "name" = 'aggregation_split_links'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('task_schedules') WHERE "name" = 'sourceConcurrency'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('task_schedules') WHERE "name" = 'fullTextFetchThreshold'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('task_schedules') WHERE "name" = 'aggregationSplitMaxEvents'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('task_schedules') WHERE "name" = 'dailyReportPlanningBatchSize'`)).toBe("1");
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
      ), (
        'prompt-removed-chat', '旧日报微调对话提示词', 'daily_report_refinement_chat', '模板', '系统提示词', true, false, CURRENT_TIMESTAMP
      ), (
        'prompt-removed-generate', '旧日报微调生成提示词', 'daily_report_refinement_generate', '模板', '系统提示词', true, false, CURRENT_TIMESTAMP
      ), (
        'prompt-item-summary', '旧条目摘要提示词', 'item_summary', '模板', '系统提示词', true, false, CURRENT_TIMESTAMP
      ), (
        'prompt-item-analysis', '旧内容分析提示词', 'item_analysis', '模板', '系统提示词', true, false, CURRENT_TIMESTAMP
      ), (
        'prompt-item-aggregation', '旧聚合拆分提示词', 'item_aggregation', '模板', '系统提示词', true, false, CURRENT_TIMESTAMP
      );
      `,
    );

    execFileSync("node", ["scripts/setup-sqlite.mjs", dbPath], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('prompt_configs') WHERE "name" = 'templateJson'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT "name" FROM "prompt_configs" WHERE "id" = 'prompt-old'`)).toBe("旧日报提示词");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "prompt_configs" WHERE "type" IN ('daily_report_refinement_chat', 'daily_report_refinement_generate')`)).toBe("0");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "prompt_configs" WHERE "type" IN ('item_summary', 'item_analysis', 'item_aggregation')`)).toBe("0");
  }, 15_000);

  it("cleans legacy tag search text and preference rules during Docker SQLite setup", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "infinitum-sqlite-entity-cleanup-"));
    const dbPath = path.join(tempDir, "cleanup.db");

    tempDirs.push(tempDir);

    execFileSync("node", ["scripts/setup-sqlite.mjs", dbPath], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    runSqlite(
      dbPath,
      `
      CREATE TABLE "tags" ("id" TEXT NOT NULL PRIMARY KEY);
      INSERT INTO "content_clusters" (
        "id", "kind", "title", "summary", "score", "itemCount", "latestPublishedAt", "status",
        "fingerprint", "feedSearchText", "feedEntitiesJson", "updatedAt"
      ) VALUES (
        'cluster-legacy-setup', 'topic', 'Setup title', 'Setup summary', 50, 1, CURRENT_TIMESTAMP,
        'active', 'legacy-setup-fingerprint', 'Setup title Setup summary OldTag', '[]', CURRENT_TIMESTAMP
      );
      INSERT INTO "briefing_preference_configs" (
        "id", "weightedRulesJson", "maxCuratorBoost", "maxCuratorPenalty", "updatedAt"
      ) VALUES (
        'preference-legacy-setup',
        '[{"type":"tag","value":"oldtag","weight":8},{"type":"keyword","value":"AI","weight":3}]',
        15, 20, CURRENT_TIMESTAMP
      );
      `,
    );

    execFileSync("node", ["scripts/setup-sqlite.mjs", dbPath], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(runSqlite(dbPath, `SELECT "feedSearchText" FROM "content_clusters" WHERE "id" = 'cluster-legacy-setup'`)).toBe(
      "Setup title Setup summary",
    );
    expect(runSqlite(dbPath, `SELECT "weightedRulesJson" FROM "briefing_preference_configs" WHERE "id" = 'preference-legacy-setup'`)).toBe(
      '[{"type":"keyword","value":"AI","weight":3}]',
    );
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "sqlite_master" WHERE "type" = 'table' AND "name" = 'tags'`)).toBe("0");
  }, 30_000);

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
  }, 20_000);

  it("drops obsolete understanding cache columns without dropping items", () => {
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
      ALTER TABLE "items" ADD COLUMN "understandingInputHash" TEXT;
      ALTER TABLE "items" ADD COLUMN "understandingVersion" TEXT;
      `,
    );

    execFileSync("node", ["scripts/setup-sqlite.mjs", dbPath], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(runSqlite(dbPath, `SELECT "originalTitle" FROM "items" WHERE "id" = 'item-understanding-upgrade'`)).toBe("Existing item");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('items') WHERE "name" = 'understandingInputHash'`)).toBe("0");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('items') WHERE "name" = 'understandingVersion'`)).toBe("0");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "sqlite_master" WHERE "type" = 'trigger' AND "name" LIKE 'items_fts_%'`)).toBe("3");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "items_fts" WHERE "rowid" = (SELECT "rowid" FROM "items" WHERE "id" = 'item-understanding-upgrade')`)).toBe("1");
  }, 20_000);

  it("drops legacy dedupeSignature columns during setup", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "infinitum-sqlite-dedupe-cleanup-"));
    const dbPath = path.join(tempDir, "dedupe-cleanup.db");

    tempDirs.push(tempDir);

    execFileSync("node", ["scripts/setup-sqlite.mjs", dbPath], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    runSqlite(
      dbPath,
      `
      ALTER TABLE "items" ADD COLUMN "dedupeSignature" TEXT;
      CREATE INDEX "items_dedupeSignature_idx" ON "items"("dedupeSignature");
      ALTER TABLE "item_dedupe_history" ADD COLUMN "dedupeSignature" TEXT;
      CREATE INDEX "item_dedupe_history_dedupeSignature_idx" ON "item_dedupe_history"("dedupeSignature");
      `,
    );

    execFileSync("node", ["scripts/setup-sqlite.mjs", dbPath], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('items') WHERE "name" = 'dedupeSignature'`)).toBe("0");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('item_dedupe_history') WHERE "name" = 'dedupeSignature'`)).toBe("0");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='items_dedupeSignature_idx'`)).toBe("0");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='item_dedupe_history_dedupeSignature_idx'`)).toBe("0");
  }, 20_000);

  it("drops the retired daily report retry column without dropping the schedule", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "infinitum-sqlite-daily-report-retry-cleanup-"));
    const dbPath = path.join(tempDir, "daily-report-retry-cleanup.db");

    tempDirs.push(tempDir);

    execFileSync("node", ["scripts/setup-sqlite.mjs", dbPath], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    runSqlite(
      dbPath,
      `
      ALTER TABLE "task_schedules" ADD COLUMN "dailyReportMaxRetries" INTEGER NOT NULL DEFAULT 0;
      UPDATE "task_schedules" SET "dailyReportMaxRetries" = 9;
      `,
    );

    execFileSync("node", ["scripts/setup-sqlite.mjs", dbPath], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM "sqlite_master" WHERE type = 'table' AND name = 'task_schedules'`)).toBe("1");
    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_table_info('task_schedules') WHERE "name" = 'dailyReportMaxRetries'`)).toBe("0");
  }, 20_000);

  it("adds the restore-source foreign key to legacy daily report revision tables", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "infinitum-sqlite-daily-report-revision-fk-"));
    const dbPath = path.join(tempDir, "daily-report-revision-fk.db");

    tempDirs.push(tempDir);

    execFileSync("node", ["scripts/setup-sqlite.mjs", dbPath], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    runSqlite(dbPath, `
      PRAGMA foreign_keys=OFF;
      ALTER TABLE "daily_report_revisions" RENAME TO "legacy_daily_report_revisions";
      CREATE TABLE "daily_report_revisions" AS SELECT * FROM "legacy_daily_report_revisions";
      DROP TABLE "legacy_daily_report_revisions";
      PRAGMA foreign_keys=ON;
    `);

    execFileSync("node", ["scripts/setup-sqlite.mjs", dbPath], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(runSqlite(dbPath, `SELECT COUNT(*) FROM pragma_foreign_key_list('daily_report_revisions') WHERE "table" = 'daily_report_revisions' AND "from" = 'restoredFromRevisionId' AND "to" = 'id'`)).toBe("1");
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
    expect(runSqlite(dbPath, `SELECT "displayQualityScore" FROM "content_clusters" WHERE id = 'cluster-backfilled'`)).toBe("88");
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
