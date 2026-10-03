import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/db";

const requireAdmin = vi.fn();

vi.mock("@/lib/admin/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admin/session")>();

  return {
    ...actual,
    requireAdmin,
  };
});

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

function postBatch(url: string, body: unknown) {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("治理批量 API 上限与串行执行", () => {
  beforeEach(async () => {
    await prisma.aggregationSplitLink.deleteMany();
    await prisma.item.deleteMany();
    await prisma.contentCluster.deleteMany();
    await prisma.fetchRun.deleteMany();
    await prisma.source.deleteMany();
  });

  it("聚合拆分批量取消超过上限时整批拒绝", async () => {
    requireAdmin.mockResolvedValue(undefined);

    const { POST } = await import("@/app/api/admin/items/aggregation/batch/route");
    const ids = Array.from({ length: 51 }, (_, index) => `item-${index}`);
    const response = await POST(
      postBatch("/api/admin/items/aggregation/batch", { action: "cancel", ids }),
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error).toContain("50");
  });

  it("聚合拆分批量空选择被拒绝", async () => {
    requireAdmin.mockResolvedValue(undefined);

    const { POST } = await import("@/app/api/admin/items/aggregation/batch/route");
    const response = await POST(
      postBatch("/api/admin/items/aggregation/batch", { action: "cancel", ids: [] }),
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error).toContain("请先选择");
  });

  it("聚合拆分批量遇到非法动作被拒绝", async () => {
    requireAdmin.mockResolvedValue(undefined);

    const { POST } = await import("@/app/api/admin/items/aggregation/batch/route");
    const response = await POST(
      postBatch("/api/admin/items/aggregation/batch", { action: "drop-everything", ids: ["a"] }),
    );

    expect(response.status).toBe(400);
  });

  it("聚合拆分批量部分失败时返回成功与失败明细", async () => {
    requireAdmin.mockResolvedValue(undefined);

    const source = await prisma.source.create({
      data: {
        name: "Batch Split Feed",
        rssUrl: "https://batch-split.example.com/feed.xml",
        siteUrl: "https://batch-split.example.com",
        enabled: true,
        aiParsingEnabled: true,
      },
    });

    await prisma.item.create({
      data: {
        id: "batch-split-existing",
        sourceId: source.id,
        originalUrl: "https://batch-split.example.com/posts/existing",
        canonicalUrl: "https://batch-split.example.com/posts/existing",
        urlHash: "hash-batch-existing",
        originalTitle: "Batch Split Existing",
        publishedAt: new Date("2026-04-10T09:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        isAggregation: true,
        aggregationParseStatus: "parsed",
        aggregationCheckedAt: new Date("2026-04-10T10:00:00.000Z"),
        language: "en",
      },
    });

    const { POST } = await import("@/app/api/admin/items/aggregation/batch/route");
    const response = await POST(
      postBatch("/api/admin/items/aggregation/batch", {
        action: "cancel",
        // batch-split-missing 故意不存在，验证单项失败不中断整批
        ids: ["batch-split-existing", "batch-split-missing"],
      }),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.succeeded).toEqual(["batch-split-existing"]);
    expect(json.failed).toHaveLength(1);
    expect(json.failed[0].id).toBe("batch-split-missing");
    expect(json.success).toBe(false);
  });

  it("聚合待定批量超过上限时整批拒绝", async () => {
    requireAdmin.mockResolvedValue(undefined);

    const { POST } = await import("@/app/api/admin/clusters/review-candidates/batch/route");
    const ids = Array.from({ length: 51 }, (_, index) => `candidate-${index}`);
    const response = await POST(
      postBatch("/api/admin/clusters/review-candidates/batch", { action: "merge", ids }),
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error).toContain("50");
  });

  it("实体治理建议批量超过上限时整批拒绝", async () => {
    requireAdmin.mockResolvedValue(undefined);

    const { POST } = await import("@/app/api/admin/settings/entities/suggestions/batch/route");
    const suggestions = Array.from({ length: 51 }, (_, index) => ({
      sourceEntityId: `entity-${index}`,
      targetEntityId: "entity-target",
    }));
    const response = await POST(
      postBatch("/api/admin/settings/entities/suggestions/batch", { action: "merge", suggestions }),
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error).toContain("50");
  });
});

describe("assertBatchSize", () => {
  it("拒绝重复选择", async () => {
    const { assertBatchSize } = await import("@/lib/admin/batch");

    expect(() => assertBatchSize(["a", "a"])).toThrow("重复项");
  });

  it("允许上限内的唯一选择", async () => {
    const { assertBatchSize } = await import("@/lib/admin/batch");

    expect(assertBatchSize(["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });
});
