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

describe("/api/admin/items", () => {
  beforeEach(async () => {
    await prisma.item.deleteMany();
    await prisma.contentCluster.deleteMany();
    await prisma.fetchRun.deleteMany();
    await prisma.source.deleteMany();

    const source = await prisma.source.create({
      data: {
        name: "Review Feed",
        rssUrl: "https://review.example.com/feed.xml",
        siteUrl: "https://review.example.com",
        enabled: true,
        aiParsingEnabled: false,
      },
    });

    await prisma.contentCluster.create({
      data: {
        id: "cluster-1",
        kind: "topic",
        title: "Agent toolkit launch",
        summary: "聚合摘要",
        score: 78,
        itemCount: 1,
        latestPublishedAt: new Date("2026-04-10T09:00:00.000Z"),
        status: "active",
        fingerprint: "agent-toolkit-launch",
      },
    });

    await prisma.item.create({
      data: {
        id: "item-filtered",
        sourceId: source.id,
        clusterId: "cluster-1",
        originalUrl: "https://review.example.com/posts/1",
        canonicalUrl: "https://review.example.com/posts/1",
        urlHash: "hash-filtered",
        originalTitle: "Sponsored AI roundup",
        translatedTitle: "赞助 AI 汇总",
        publishedAt: new Date("2026-04-10T09:00:00.000Z"),
        summaryText: "疑似营销内容",
        status: "processed",
        moderationStatus: "filtered",
        moderationReason: "marketing",
        moderationDetail: "标题和摘要明显带有营销措辞",
        qualityScore: 18,
        qualityRationale: "营销导向且信息密度低",
        language: "en",
      },
    });

    await prisma.item.create({
      data: {
        id: "item-visible",
        sourceId: source.id,
        clusterId: "cluster-1",
        originalUrl: "https://review.example.com/posts/2",
        canonicalUrl: "https://review.example.com/posts/2",
        urlHash: "hash-visible",
        originalTitle: "OpenAI ships a new agent tool",
        translatedTitle: "OpenAI 发布新的 agent 工具",
        publishedAt: new Date("2026-04-11T09:00:00.000Z"),
        summaryText: "正常内容",
        status: "processed",
        moderationStatus: "allowed",
        moderationReason: null,
        moderationDetail: "信息有效",
        qualityScore: 86,
        qualityRationale: "信息密度高",
        language: "en",
      },
    });

    await prisma.contentCluster.create({
      data: {
        id: "cluster-singleton",
        kind: "topic",
        title: "Singleton cluster",
        summary: "单条聚合摘要",
        score: 68,
        itemCount: 1,
        latestPublishedAt: new Date("2026-04-12T09:00:00.000Z"),
        status: "active",
        fingerprint: "singleton-cluster",
      },
    });

    await prisma.item.create({
      data: {
        id: "item-singleton",
        sourceId: source.id,
        clusterId: "cluster-singleton",
        originalUrl: "https://review.example.com/posts/3",
        canonicalUrl: "https://review.example.com/posts/3",
        urlHash: "hash-singleton",
        originalTitle: "Singleton cluster item",
        translatedTitle: "单条聚合内容",
        publishedAt: new Date("2026-04-12T09:00:00.000Z"),
        summaryText: "单条聚合内容摘要",
        status: "processed",
        moderationStatus: "allowed",
        moderationReason: null,
        moderationDetail: "信息有效",
        qualityScore: 68,
        qualityRationale: "质量尚可",
        language: "en",
      },
    });
  });

  it("lists filtered items for admins", async () => {
    requireAdmin.mockResolvedValue(undefined);

    const { GET } = await import("@/app/api/admin/items/route");
    const response = await GET(new Request("http://localhost/api/admin/items?moderationStatus=filtered"));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.items).toHaveLength(1);
    expect(json.items[0]).toMatchObject({
      id: "item-filtered",
      moderationStatus: "filtered",
      moderationReason: "marketing",
      qualityScore: 18,
    });
    expect(json.items[0]).not.toHaveProperty("topicLabel");
  });

  it("filters filtered items by recent range", async () => {
    requireAdmin.mockResolvedValue(undefined);

    const source = await prisma.source.findFirstOrThrow({
      where: { name: "Review Feed" },
    });
    await prisma.item.create({
      data: {
        id: "item-filtered-old",
        sourceId: source.id,
        originalUrl: "https://example.com/old-filtered",
        canonicalUrl: "https://example.com/old-filtered",
        urlHash: "hash-filtered-old",
        originalTitle: "Old filtered item",
        translatedTitle: "较早过滤内容",
        publishedAt: new Date("2026-04-10T09:00:00.000Z"),
        status: "filtered",
        moderationStatus: "filtered",
        moderationReason: "low_quality",
        moderationDetail: "较早过滤",
        qualityScore: 22,
        qualityRationale: "低质量",
        createdAt: new Date("2026-04-10T10:00:00.000Z"),
        updatedAt: new Date("2026-04-10T10:00:00.000Z"),
      },
    });

    const { GET } = await import("@/app/api/admin/items/route");
    const response = await GET(
      new Request("http://localhost/api/admin/items?moderationStatus=filtered&rangeDays=7"),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.items.map((item: { id: string }) => item.id)).toContain("item-filtered");
    expect(json.items.map((item: { id: string }) => item.id)).not.toContain("item-filtered-old");
  });

  it("filters filtered items by moderation reason, including stale_content", async () => {
    requireAdmin.mockResolvedValue(undefined);

    const source = await prisma.source.findFirstOrThrow({
      where: { name: "Review Feed" },
    });
    await prisma.item.create({
      data: {
        id: "item-filtered-stale",
        sourceId: source.id,
        originalUrl: "https://example.com/stale-filtered",
        canonicalUrl: "https://example.com/stale-filtered",
        urlHash: "hash-filtered-stale",
        originalTitle: "Stale filtered item",
        translatedTitle: "时效过时内容",
        publishedAt: new Date("2026-04-10T09:00:00.000Z"),
        status: "filtered",
        moderationStatus: "filtered",
        moderationReason: "stale_content",
        filterReason: "stale_event_content",
        moderationDetail: "事件时间距发布时间已有 30 天",
        qualityScore: 40,
        qualityRationale: "时效过时",
        createdAt: new Date("2026-04-10T10:00:00.000Z"),
        updatedAt: new Date("2026-04-10T10:00:00.000Z"),
      },
    });

    const { GET } = await import("@/app/api/admin/items/route");
    const response = await GET(
      new Request("http://localhost/api/admin/items?moderationStatus=filtered&reason=stale_content"),
    );
    const json = await response.json();
    const ids = json.items.map((item: { id: string }) => item.id);

    expect(response.status).toBe(200);
    expect(ids).toContain("item-filtered-stale");
    // 原因筛选必须真正生效：不能退化成返回全部过滤内容
    expect(ids).not.toContain("item-filtered");
  });

  it("restores a filtered item for admins", async () => {
    requireAdmin.mockResolvedValue(undefined);

    const { POST } = await import("@/app/api/admin/items/[id]/restore/route");
    const response = await POST(
      new Request("http://localhost/api/admin/items/item-filtered/restore", { method: "POST" }),
      {
        params: Promise.resolve({ id: "item-filtered" }),
      },
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.item.moderationStatus).toBe("restored");

    const stored = await prisma.item.findUniqueOrThrow({
      where: { id: "item-filtered" },
    });
    expect(stored.moderationStatus).toBe("restored");
    expect(stored.restoredByAdminAt).not.toBeNull();
  });

  it("manually filters a visible item for admins", async () => {
    requireAdmin.mockResolvedValue(undefined);

    const { POST } = await import("@/app/api/admin/items/[id]/filter/route");
    const response = await POST(
      new Request("http://localhost/api/admin/items/item-visible/filter", { method: "POST" }),
      {
        params: Promise.resolve({ id: "item-visible" }),
      },
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.item.moderationStatus).toBe("filtered");
    expect(json.item.moderationReason).toBe("other");

    const stored = await prisma.item.findUniqueOrThrow({
      where: { id: "item-visible" },
    });
    expect(stored.moderationStatus).toBe("filtered");
    expect(stored.status).toBe("filtered");
    expect(stored.clusterId).toBeNull();
  });

  it("moves an item into the selected cluster for admins, including singleton clusters", async () => {
    requireAdmin.mockResolvedValue(undefined);

    const { POST } = await import("@/app/api/admin/items/[id]/join-cluster/route");
    const response = await POST(
      new Request("http://localhost/api/admin/items/item-visible/join-cluster", {
        method: "POST",
        body: JSON.stringify({ clusterId: "cluster-singleton" }),
        headers: { "content-type": "application/json" },
      }),
      {
        params: Promise.resolve({ id: "item-visible" }),
      },
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.cluster.id).toBe("cluster-singleton");

    const stored = await prisma.item.findUniqueOrThrow({
      where: { id: "item-visible" },
    });
    expect(stored.clusterId).toBe("cluster-singleton");
    expect(stored.manualClusterAssignedAt).toBeInstanceOf(Date);

    const updatedCluster = await prisma.contentCluster.findUniqueOrThrow({
      where: { id: "cluster-singleton" },
    });
    expect(updatedCluster.itemCount).toBe(2);
  });
});
