import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Feed cache 失效写操作矩阵（AGENTS.md 硬约束 2 的可执行守卫）。
 *
 * 规则：src/lib 与 src/app/api 下任何触碰 feed 相关模型的 Prisma 写操作，
 * 要么在文件内调用 invalidateFeedCache()，要么在本文件的 DELEGATED 中登记
 * 失效责任方与理由；src/app/api 禁止直连 @/lib/db 或出现 Prisma 写操作。
 * 新写路径出现时，本测试会列出未覆盖文件并拒绝通过。
 */

const REPO_ROOT = process.cwd();
const SCAN_ROOTS = ["src/lib", "src/app/api"];

const FEED_AFFECTING_MODELS = [
  "contentCluster",
  "sourceGroup",
  "entityAlias",
  "itemEntity",
  "entity",
  "source",
  "item",
];

const MUTATION_OPS = ["createMany", "deleteMany", "updateMany", "create", "delete", "update", "upsert"];

const MUTATION_PATTERN = new RegExp(
  `\\b(?:prisma|tx)\\.(${FEED_AFFECTING_MODELS.join("|")})\\.(${MUTATION_OPS.join("|")})\\b`,
);

function hasMutationCall(content: string) {
  MUTATION_PATTERN.lastIndex = 0;

  return MUTATION_PATTERN.test(content);
}

function extractMutationCalls(content: string) {
  const globalPattern = new RegExp(MUTATION_PATTERN.source, "g");

  return [...content.matchAll(globalPattern)].map((match) => `${match[1]}.${match[2]}`);
}

/** 期望自带失效调用的写路径（漏写 invalidateFeedCache 会导致本测试失败）。 */
const EXPECTED_SELF_INVALIDATING: string[] = [
  "src/lib/clusters/service.ts",
  "src/lib/entities/service.ts",
  "src/lib/items/service.ts",
  "src/lib/settings/source-service.ts",
];

/** 写操作在别处统一失效或明确豁免的登记表（stale 条目会被断言拒绝）。 */
const DELEGATED: Record<string, { via: string; reason: string }> = {
  "src/lib/aggregation/persist.ts": {
    via: "src/lib/ingestion/item-processor.ts, src/lib/items/service.ts",
    reason: "聚合拆分/合并持久化发生在任务事务内，任务边界统一失效",
  },
  "src/lib/clusters/feed-stats.ts": {
    via: "src/lib/clusters/service.ts, src/lib/entities/service.ts, src/lib/ingestion/service.ts, src/lib/settings/source-service.ts",
    reason: "聚类统计刷新内部 helper，全部调用方（自带失效的写服务）在写路径末尾统一失效",
  },
  "src/lib/clusters/repository.ts": {
    via: "src/lib/clusters/service.ts",
    reason: "聚类仓储层，写路径由 service 层在操作末尾统一失效",
  },
  "src/lib/feed/repository.ts": {
    via: "src/lib/ingestion/service.ts",
    reason: "ingestion 写路径（落库/源健康/去重历史），由抓取任务末尾统一失效",
  },
  "src/lib/ingestion/item-processor.ts": {
    via: "src/lib/ingestion/service.ts",
    reason: "条目处理管线内部写入，由抓取任务末尾统一失效",
  },
  "src/lib/items/processing-state.ts": {
    via: "src/lib/items/service.ts, src/lib/items/processing-recovery.ts",
    reason: "AI 处理状态登记，调用方在任务边界统一失效",
  },
  "src/lib/settings/core.ts": {
    via: "(豁免)",
    reason: "仅 config 首次导入种子写入（空库初始化事务），无已发布 feed 需失效",
  },
};

function listTsFiles(rootDir: string): string[] {
  const entries = readdirSync(rootDir);

  return entries.flatMap((entry) => {
    const fullPath = join(rootDir, entry);

    if (statSync(fullPath).isDirectory()) {
      return listTsFiles(fullPath);
    }

    return entry.endsWith(".ts") && !entry.endsWith(".test.ts") ? [fullPath] : [];
  });
}

function toRepoRelative(filePath: string): string {
  return relative(REPO_ROOT, filePath).split(sep).join("/");
}

function findFeedAffectingWriteSites(): Map<string, string[]> {
  const writeSites = new Map<string, string[]>();

  for (const scanRoot of SCAN_ROOTS) {
    for (const filePath of listTsFiles(join(REPO_ROOT, scanRoot))) {
      const content = readFileSync(filePath, "utf8");
      const matches = extractMutationCalls(content);

      if (matches.length > 0) {
        writeSites.set(toRepoRelative(filePath), [...new Set(matches)]);
      }
    }
  }

  return writeSites;
}

describe("feed cache 失效写操作矩阵", () => {
  const writeSites = findFeedAffectingWriteSites();

  it("扫描到写路径（防止正则/目录配置失效导致矩阵空转）", () => {
    expect(writeSites.size).toBeGreaterThanOrEqual(
      EXPECTED_SELF_INVALIDATING.length + Object.keys(DELEGATED).length,
    );
  });

  it("每个 feed 相关写路径要么自带失效，要么已登记委托/豁免", () => {
    const uncovered = [...writeSites.keys()].filter(
      (file) =>
        !EXPECTED_SELF_INVALIDATING.includes(file) &&
        !Object.prototype.hasOwnProperty.call(DELEGATED, file),
    );

    const message = uncovered.length
      ? `以下文件存在 feed 相关 Prisma 写操作但未接入失效治理，请在文件内调用 invalidateFeedCache()，或在 tests/unit/feed-cache-write-matrix.test.ts 的 DELEGATED 登记责任方与理由：\n${uncovered
          .map((file) => `  - ${file} (${writeSites.get(file)?.join(", ")})`)
          .join("\n")}`
      : "";

    expect(message, message).toBe("");
  });

  it("自带失效的写路径确实调用了 invalidateFeedCache", () => {
    for (const file of EXPECTED_SELF_INVALIDATING) {
      expect(writeSites.keys(), `${file} 应仍是 feed 相关写路径`).toContain(file);

      const content = readFileSync(join(REPO_ROOT, file), "utf8");

      expect(content.includes("invalidateFeedCache("), `${file} 缺少 invalidateFeedCache() 调用`).toBe(true);
    }
  });

  it("委托/豁免登记不包含已消失的写路径（防 stale）", () => {
    const stale = Object.keys(DELEGATED).filter((file) => !writeSites.has(file));

    expect(stale, `以下登记对应的写操作已不存在，请从 DELEGATED 移除：\n${stale.join("\n")}`).toEqual([]);
  });

  it("API 层不直连 Prisma：不 import @/lib/db，也不出现写操作", () => {
    const apiFiles = listTsFiles(join(REPO_ROOT, "src/app/api"));
    const violations = apiFiles.filter((filePath) => {
      const content = readFileSync(filePath, "utf8");

      return content.includes('@/lib/db') || hasMutationCall(content);
    });

    expect(
      violations.map(toRepoRelative),
      "API route 应通过领域 service 读写数据，不要直接 import @/lib/db（读路径请走对应 feed/service 查询层）",
    ).toEqual([]);
  });
});
