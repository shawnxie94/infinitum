import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/db";

const requireAdmin = vi.fn();
const { restoreFilteredItemMock, enqueueItemReanalyzeTaskMock } = vi.hoisted(() => ({
  restoreFilteredItemMock: vi.fn(),
  enqueueItemReanalyzeTaskMock: vi.fn(),
}));

vi.mock("@/lib/items/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/items/service")>();
  return {
    ...actual,
    restoreFilteredItem: restoreFilteredItemMock,
    enqueueItemReanalyzeTask: enqueueItemReanalyzeTaskMock,
  };
});

vi.mock("@/lib/admin/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admin/session")>();

  return {
    ...actual,
    requireAdmin,
  };
});

afterEach(() => {
  vi.clearAllMocks();
  restoreFilteredItemMock.mockReset();
  enqueueItemReanalyzeTaskMock.mockReset();
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

  it("过滤内容批量空选择与超过上限时整批拒绝", async () => {
    requireAdmin.mockResolvedValue(undefined);
    const { POST } = await import("@/app/api/admin/items/filtered/batch/route");

    const emptyResponse = await POST(
      postBatch("/api/admin/items/filtered/batch", { action: "restore", ids: [] }),
    );
    expect(emptyResponse.status).toBe(400);

    const ids = Array.from({ length: 51 }, (_, index) => `filtered-${index}`);
    const overLimitResponse = await POST(
      postBatch("/api/admin/items/filtered/batch", { action: "reanalyze", ids }),
    );
    expect(overLimitResponse.status).toBe(400);
    expect(await overLimitResponse.json()).toMatchObject({ error: expect.stringContaining("50") });
  });

  it("过滤内容批量恢复与重新判定逐项执行并保留部分失败", async () => {
    requireAdmin.mockResolvedValue(undefined);
    const serviceCalls: string[] = [];
    restoreFilteredItemMock.mockImplementation(async (id: string) => {
      serviceCalls.push(`restore:${id}`);
      if (id === "filtered-missing") throw new Error("Item not found");
      return {};
    });
    enqueueItemReanalyzeTaskMock.mockImplementation(async (id: string) => {
      serviceCalls.push(`reanalyze:${id}`);
      return { id: `task-${id}` };
    });

    const { POST } = await import("@/app/api/admin/items/filtered/batch/route");
    const restoreResponse = await POST(
      postBatch("/api/admin/items/filtered/batch", {
        action: "restore",
        ids: ["filtered-1", "filtered-missing"],
      }),
    );
    const restoreJson = await restoreResponse.json();
    expect(restoreResponse.status).toBe(200);
    expect(restoreJson).toMatchObject({
      success: false,
      succeeded: ["filtered-1"],
      failed: [{ id: "filtered-missing", error: "Item not found" }],
      total: 2,
    });

    const reanalyzeResponse = await POST(
      postBatch("/api/admin/items/filtered/batch", {
        action: "reanalyze",
        ids: ["filtered-2", "filtered-3"],
      }),
    );
    expect(reanalyzeResponse.status).toBe(200);
    expect(await reanalyzeResponse.json()).toMatchObject({
      success: true,
      succeeded: ["filtered-2", "filtered-3"],
      failed: [],
      total: 2,
    });
    expect(serviceCalls).toEqual([
      "restore:filtered-1",
      "restore:filtered-missing",
      "reanalyze:filtered-2",
      "reanalyze:filtered-3",
    ]);
  });

  it("过滤内容批量拒绝非法动作", async () => {
    requireAdmin.mockResolvedValue(undefined);
    const { POST } = await import("@/app/api/admin/items/filtered/batch/route");
    const response = await POST(
      postBatch("/api/admin/items/filtered/batch", { action: "delete", ids: ["filtered-1"] }),
    );
    expect(response.status).toBe(400);
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
