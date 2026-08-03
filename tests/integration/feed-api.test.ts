import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { refreshAllClusterFeedStats, refreshClusterFeedStats } from "@/lib/clusters/feed-stats";
import { resolveFeedFilters } from "@/lib/feed/range";
import { listFeedItems } from "@/lib/feed/repository";
import { replaceItemEntities } from "@/lib/entities/service";

describe("/api/feed", () => {
  beforeEach(async () => {
    await prisma.item.deleteMany();
    await prisma.entity.deleteMany();
    await prisma.contentCluster.deleteMany();
    await prisma.fetchRun.deleteMany();
    await prisma.source.deleteMany();
    await prisma.sourceGroup.deleteMany();

    const source = await prisma.source.create({
      data: {
        name: "API Feed",
        rssUrl: "https://api.example.com/feed.xml",
        siteUrl: "https://api.example.com",
        enabled: true,
        aiParsingEnabled: true,
      },
    });

    await prisma.contentCluster.createMany({
      data: [
        {
          id: "cluster-a",
          kind: "topic",
          title: "OpenAI Agent 发布",
          summary: "聚合摘要 A",
          score: 90,
          itemCount: 2,
          latestPublishedAt: new Date("2026-04-10T09:00:00.000Z"),
          status: "active",
          fingerprint: "openai-agent",
        },
        {
          id: "cluster-b",
          kind: "topic",
          title: "独立内容",
          summary: "单条摘要",
          score: 62,
          itemCount: 1,
          latestPublishedAt: new Date("2026-04-09T09:00:00.000Z"),
          status: "active",
          fingerprint: "single-story",
        },
        {
          id: "cluster-c",
          kind: "topic",
          title: "高分旧内容",
          summary: "高分摘要",
          score: 98,
          itemCount: 1,
          latestPublishedAt: new Date("2026-04-08T09:00:00.000Z"),
          status: "active",
          fingerprint: "high-score-story",
        },
      ],
    });

    await prisma.item.createMany({
      data: [
        {
          id: "item-a1",
          sourceId: source.id,
          clusterId: "cluster-a",
          originalUrl: "https://api.example.com/a",
          canonicalUrl: "https://api.example.com/a",
          urlHash: "hash-a",
          originalTitle: "Story A",
          translatedTitle: "故事 A",
          author: "Author A",
          publishedAt: new Date("2026-04-10T09:00:00.000Z"),
          summaryText: "摘要 A",
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 92,
          qualityRationale: "高质量",
          language: "en",
          createdAt: new Date("2026-04-10T09:05:00.000Z"),
        },
        {
          id: "item-a2",
          sourceId: source.id,
          clusterId: "cluster-a",
          originalUrl: "https://api.example.com/a-2",
          canonicalUrl: "https://api.example.com/a-2",
          urlHash: "hash-a2",
          originalTitle: "Story A 2",
          translatedTitle: "故事 A2",
          author: "Author A2",
          publishedAt: new Date("2026-04-10T08:30:00.000Z"),
          summaryText: "摘要 A2",
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 88,
          qualityRationale: "高质量",
          language: "en",
          createdAt: new Date("2026-04-10T08:35:00.000Z"),
        },
        {
          id: "item-b1",
          sourceId: source.id,
          clusterId: "cluster-b",
          originalUrl: "https://api.example.com/b",
          canonicalUrl: "https://api.example.com/b",
          urlHash: "hash-b",
          originalTitle: "Story B",
          translatedTitle: "故事 B",
          author: "Author B",
          publishedAt: new Date("2026-04-09T09:00:00.000Z"),
          summaryText: "摘要 B",
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 62,
          qualityRationale: "一般质量",
          language: "en",
          createdAt: new Date("2026-04-09T09:05:00.000Z"),
        },
        {
          id: "item-c1",
          sourceId: source.id,
          clusterId: "cluster-c",
          originalUrl: "https://api.example.com/c1",
          canonicalUrl: "https://api.example.com/c1",
          urlHash: "hash-c1",
          originalTitle: "Story C1",
          translatedTitle: "故事 C1",
          author: "Author C1",
          publishedAt: new Date("2026-04-08T09:00:00.000Z"),
          summaryText: "摘要 C1",
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 98,
          qualityRationale: "非常高质量",
          language: "en",
          createdAt: new Date("2026-04-08T09:05:00.000Z"),
        },
        {
          id: "item-d1",
          sourceId: source.id,
          originalUrl: "https://api.example.com/c",
          canonicalUrl: "https://api.example.com/c",
          urlHash: "hash-c",
          originalTitle: "Story C",
          publishedAt: new Date("2026-04-10T08:00:00.000Z"),
          summaryText: "摘要 C",
          status: "filtered",
          moderationStatus: "filtered",
          moderationReason: "low_quality",
          qualityScore: 20,
          qualityRationale: "低质量",
          language: "en",
          createdAt: new Date("2026-04-10T08:05:00.000Z"),
        },
        {
          id: "item-timezone-created",
          sourceId: source.id,
          originalUrl: "https://api.example.com/timezone-created",
          canonicalUrl: "https://api.example.com/timezone-created",
          urlHash: "hash-timezone-created",
          originalTitle: "Timezone Created",
          translatedTitle: "按创建时间归档",
          author: "Author TZ",
          publishedAt: new Date("2026-04-01T00:00:00.000Z"),
          summaryText: "创建时间落在东八区当天",
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 75,
          qualityRationale: "测试创建时间筛选",
          language: "en",
          createdAt: new Date("2026-04-09T18:00:00.000Z"),
        },
        {
          id: "item-created-too-old",
          sourceId: source.id,
          originalUrl: "https://api.example.com/created-too-old",
          canonicalUrl: "https://api.example.com/created-too-old",
          urlHash: "hash-created-too-old",
          originalTitle: "Created Too Old",
          translatedTitle: "发布时间新但创建时间旧",
          author: "Author Old",
          publishedAt: new Date("2026-04-10T11:00:00.000Z"),
          summaryText: "应该被创建时间筛掉",
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 66,
          qualityRationale: "测试创建时间优先",
          language: "en",
          createdAt: new Date("2026-04-01T11:00:00.000Z"),
        },
      ],
    });
    await refreshAllClusterFeedStats();
  });

  it("returns a mixed feed with clusters and single items for the selected range", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));

    const { GET } = await import("@/app/api/feed/route");
    const response = await GET(
      new Request("http://localhost/api/feed?range=7d"),
    );

    const json = await response.json();

    expect(response.headers.get("cache-control")).toBe("public, s-maxage=30, stale-while-revalidate=300");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(json.items).toHaveLength(4);
    expect(json.items[0]).toMatchObject({
      type: "cluster",
      id: "cluster-a",
      title: "OpenAI Agent 发布",
      itemCount: 2,
      score: 90,
    });
    expect(json.items[1]).toMatchObject({
      type: "single",
      id: "item-timezone-created",
      title: "按创建时间归档",
      itemCount: 1,
      score: 75,
    });
    expect(json.items[2]).toMatchObject({
      type: "single",
      id: "item-b1",
      title: "故事 B",
      itemCount: 1,
      score: 62,
    });
    expect(json.items[3]).toMatchObject({
      type: "single",
      id: "item-c1",
      title: "故事 C1",
      itemCount: 1,
      score: 98,
    });
    expect(json.pagination).toMatchObject({
      page: 1,
      size: 50,
      total: 4,
      totalPages: 1,
    });
    expect(json.sort).toBe("time_desc");

    vi.useRealTimers();
  });

  it("returns an explicitly requested singleton cluster by entry key", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));

    const { GET } = await import("@/app/api/feed/route");
    const response = await GET(
      new Request("http://localhost/api/feed?entryKeys=cluster:cluster-b"),
    );

    const json = await response.json();

    expect(json.range).toBe("all");
    expect(json.items).toHaveLength(1);
    expect(json.items[0]).toMatchObject({
      type: "cluster",
      id: "cluster-b",
      title: "独立内容",
      itemCount: 1,
    });
    expect(json.pagination).toMatchObject({
      page: 1,
      size: 50,
      total: 1,
      totalPages: 1,
    });

    vi.useRealTimers();
  });

  it("filters feed entries by entity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));
    await replaceItemEntities("item-a1", ["OpenAI", "AI Agent"]);
    await replaceItemEntities("item-a2", ["OpenAI"]);
    await replaceItemEntities("item-b1", ["Robotics"]);

    const { GET } = await import("@/app/api/feed/route");
    const response = await GET(
      new Request("http://localhost/api/feed?range=7d&entity=openai"),
    );
    const json = await response.json();

    expect(json.entity).toBe("openai");
    expect(json.items).toHaveLength(1);
    expect(json.items[0]).toMatchObject({
      type: "cluster",
      id: "cluster-a",
      title: "OpenAI Agent 发布",
    });
    expect(json).not.toHaveProperty("popularEntities");

    vi.useRealTimers();
  });

  it("filters single feed items by entity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));
    await replaceItemEntities("item-b1", ["Robotics"]);

    const { GET } = await import("@/app/api/feed/route");
    const response = await GET(
      new Request("http://localhost/api/feed?range=7d&entity=robotics"),
    );
    const json = await response.json();

    expect(json.items).toHaveLength(1);
    expect(json.items[0]).toMatchObject({
      type: "single",
      id: "item-b1",
      title: "故事 B",
    });

    vi.useRealTimers();
  });


  it("omits aggregation parent metadata from the public feed list", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));

    try {
      const source = await prisma.source.findFirstOrThrow({
        where: { rssUrl: "https://api.example.com/feed.xml" },
      });
      const parent = await prisma.item.create({
        data: {
          id: "aggregation-parent-feed",
          sourceId: source.id,
          originalUrl: "https://api.example.com/roundup",
          canonicalUrl: "https://api.example.com/roundup",
          urlHash: "aggregation-parent-feed",
          originalTitle: "AI Roundup Parent",
          translatedTitle: "AI 简报父条目",
          publishedAt: new Date("2026-04-10T09:00:00.000Z"),
          summaryText: "父聚合摘要",
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 80,
          qualityRationale: "聚合父条目",
          isAggregation: true,
          aggregationParseStatus: "parsed",
          createdAt: new Date("2026-04-10T09:00:00.000Z"),
        },
      });
      await prisma.item.create({
        data: {
          id: "aggregation-child-feed",
          sourceId: source.id,
          parentItemId: parent.id,
          originalUrl: "https://api.example.com/roundup#event-child",
          canonicalUrl: "https://api.example.com/roundup",
          urlHash: "aggregation-child-feed",
          originalTitle: "Split Child Feed Story",
          translatedTitle: "拆条子事件",
          publishedAt: new Date("2026-04-10T09:00:00.000Z"),
          summaryText: "拆条子事件摘要",
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 85,
          qualityRationale: "由聚合内容拆出",
          isAggregation: false,
          createdAt: new Date("2026-04-10T09:01:00.000Z"),
        },
      });

      const { GET } = await import("@/app/api/feed/route");
      const response = await GET(
        new Request("http://localhost/api/feed?range=7d&title=Split%20Child"),
      );
      const json = await response.json();

      expect(json.items).toHaveLength(1);
      expect(json.items[0]).toMatchObject({
        id: "aggregation-child-feed",
      });
      expect(json.items[0]).not.toHaveProperty("aggregationParent");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a multi-item cluster as a cluster when only one item matches the time range", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));

    try {
      const source = await prisma.source.findFirstOrThrow({
        where: { rssUrl: "https://api.example.com/feed.xml" },
      });

      await prisma.contentCluster.create({
        data: {
          id: "cluster-temporal",
          kind: "topic",
          title: "Temporal Cluster",
          summary: "Temporal cluster summary",
          score: 82,
          itemCount: 2,
          latestPublishedAt: new Date("2026-04-10T11:00:00.000Z"),
          status: "active",
          fingerprint: "temporal-cluster",
        },
      });

      await prisma.item.createMany({
        data: [
          {
            id: "item-temporal-today",
            sourceId: source.id,
            clusterId: "cluster-temporal",
            originalUrl: "https://api.example.com/temporal-today",
            canonicalUrl: "https://api.example.com/temporal-today",
            urlHash: "hash-temporal-today",
            originalTitle: "Temporal Story Today",
            translatedTitle: "时间范围内事件",
            publishedAt: new Date("2026-04-10T11:00:00.000Z"),
            summaryText: "今天命中的摘要",
            status: "processed",
            moderationStatus: "allowed",
            qualityScore: 82,
            qualityRationale: "时间范围测试",
            language: "en",
            createdAt: new Date("2026-04-10T11:05:00.000Z"),
          },
          {
            id: "item-temporal-old",
            sourceId: source.id,
            clusterId: "cluster-temporal",
            originalUrl: "https://api.example.com/temporal-old",
            canonicalUrl: "https://api.example.com/temporal-old",
            urlHash: "hash-temporal-old",
            originalTitle: "Temporal Story Old",
            translatedTitle: "时间范围外事件",
            publishedAt: new Date("2026-04-08T11:00:00.000Z"),
            summaryText: "旧摘要",
            status: "processed",
            moderationStatus: "allowed",
            qualityScore: 50,
            qualityRationale: "时间范围测试",
            language: "en",
            createdAt: new Date("2026-04-08T11:05:00.000Z"),
          },
        ],
      });
      await refreshClusterFeedStats(["cluster-temporal"]);

      const { GET } = await import("@/app/api/feed/route");
      const response = await GET(new Request("http://localhost/api/feed?range=today&title=Temporal"));
      const json = await response.json();

      expect(json.items).toHaveLength(1);
      expect(json.items[0]).toMatchObject({
        type: "cluster",
        id: "cluster-temporal",
        title: "Temporal Cluster",
        itemCount: 2,
        score: 66,
        hasMoreItems: false,
      });
      expect(json.items[0].itemsPreview).toHaveLength(2);
      expect(json.items[0].itemsPreview[0]).toMatchObject({
        id: "item-temporal-today",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores disabled sources when computing visible cluster stats", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));

    try {
      const enabledSource = await prisma.source.findFirstOrThrow({
        where: { rssUrl: "https://api.example.com/feed.xml" },
      });
      const disabledSource = await prisma.source.create({
        data: {
          name: "Disabled Feed",
          rssUrl: "https://disabled.example.com/feed.xml",
          siteUrl: "https://disabled.example.com",
          enabled: false,
          aiParsingEnabled: true,
        },
      });

      await prisma.contentCluster.create({
        data: {
          id: "cluster-disabled-source",
          kind: "topic",
          title: "Disabled Source Cluster",
          summary: "Disabled source summary",
          score: 50,
          itemCount: 3,
          latestPublishedAt: new Date("2026-04-10T12:00:00.000Z"),
          status: "active",
          fingerprint: "disabled-source-cluster",
        },
      });

      await prisma.item.createMany({
        data: [
          {
            id: "item-enabled-visible-1",
            sourceId: enabledSource.id,
            clusterId: "cluster-disabled-source",
            originalUrl: "https://api.example.com/enabled-visible-1",
            canonicalUrl: "https://api.example.com/enabled-visible-1",
            urlHash: "hash-enabled-visible-1",
            originalTitle: "Enabled Visible 1",
            translatedTitle: "启用来源 1",
            publishedAt: new Date("2026-04-10T12:00:00.000Z"),
            summaryText: "启用来源摘要 1",
            status: "processed",
            moderationStatus: "allowed",
            qualityScore: 50,
            qualityRationale: "可见统计测试",
            language: "en",
            createdAt: new Date("2026-04-10T12:00:00.000Z"),
          },
          {
            id: "item-enabled-visible-2",
            sourceId: enabledSource.id,
            clusterId: "cluster-disabled-source",
            originalUrl: "https://api.example.com/enabled-visible-2",
            canonicalUrl: "https://api.example.com/enabled-visible-2",
            urlHash: "hash-enabled-visible-2",
            originalTitle: "Enabled Visible 2",
            translatedTitle: "启用来源 2",
            publishedAt: new Date("2026-04-10T11:00:00.000Z"),
            summaryText: "启用来源摘要 2",
            status: "processed",
            moderationStatus: "allowed",
            qualityScore: 50,
            qualityRationale: "可见统计测试",
            language: "en",
            createdAt: new Date("2026-04-10T11:00:00.000Z"),
          },
          {
            id: "item-disabled-hidden",
            sourceId: disabledSource.id,
            clusterId: "cluster-disabled-source",
            originalUrl: "https://disabled.example.com/hidden",
            canonicalUrl: "https://disabled.example.com/hidden",
            urlHash: "hash-disabled-hidden",
            originalTitle: "Disabled Hidden",
            translatedTitle: "禁用来源",
            publishedAt: new Date("2026-04-10T10:00:00.000Z"),
            summaryText: "禁用来源摘要",
            status: "processed",
            moderationStatus: "allowed",
            qualityScore: 100,
            qualityRationale: "不应参与前台统计",
            language: "en",
            createdAt: new Date("2026-04-10T10:00:00.000Z"),
          },
        ],
      });
      await refreshClusterFeedStats(["cluster-disabled-source"]);

      const filters = resolveFeedFilters(
        {
          range: "7d",
          sort: "score_desc",
          start: null,
          end: null,
          groupId: null,
          sourceId: null,
          title: null,
        },
        new Date("2026-04-10T12:00:00.000Z"),
      );
      const result = await listFeedItems(filters, { page: 1, size: 20 });
      const entry = result.items.find((item) => item.id === "cluster-disabled-source");

      expect(entry).toMatchObject({
        type: "cluster",
        itemCount: 2,
        sourceCount: 1,
        score: 50,
      });
      expect(entry?.type === "cluster" ? entry.itemsPreview.map((item) => item.id) : []).toEqual([
        "item-enabled-visible-1",
        "item-enabled-visible-2",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("supports page and size parameters for feed pagination", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));

    try {
      const { GET } = await import("@/app/api/feed/route");
      const response = await GET(new Request("http://localhost/api/feed?range=7d&page=2&size=2"));

      const json = await response.json();

      expect(json.items).toHaveLength(2);
      expect(json.items[0]).toMatchObject({
        type: "single",
        id: "item-b1",
      });
      expect(json.items[1]).toMatchObject({
        type: "single",
        id: "item-c1",
      });
      expect(json.pagination).toMatchObject({
        page: 2,
        size: 2,
        total: 4,
        totalPages: 2,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("paginates aggregated entries without materializing the full feed item set", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));

    const findManySpy = vi.spyOn(prisma.item, "findMany");

    try {
      const filters = resolveFeedFilters(
        {
          range: "7d",
          sort: "time_desc",
          start: null,
          end: null,
          groupId: null,
          sourceId: null,
          title: null,
        },
        new Date("2026-04-10T12:00:00.000Z"),
      );

      const result = await listFeedItems(filters, { page: 1, size: 2 });

      expect(result.pagination).toMatchObject({
        page: 1,
        size: 2,
        total: 4,
        totalPages: 2,
      });
      expect(result.items).toHaveLength(2);
      expect(findManySpy).not.toHaveBeenCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({
            cluster: true,
          }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("filters the mixed feed by a custom start and end date range", async () => {
    const { GET } = await import("@/app/api/feed/route");
    const response = await GET(new Request("http://localhost/api/feed?range=7d&start=2026-04-10&end=2026-04-10"));

    const json = await response.json();

    expect(json.items).toHaveLength(2);
    expect(json.items[0]).toMatchObject({
      type: "cluster",
      id: "cluster-a",
      itemCount: 2,
    });
    expect(json.items[1]).toMatchObject({
      type: "single",
      id: "item-timezone-created",
    });
    expect(json.start).toBe("2026-04-10");
    expect(json.end).toBe("2026-04-10");
  });

  it("filters by item createdAt using the default Asia/Shanghai day boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));

    try {
      const { GET } = await import("@/app/api/feed/route");
      const response = await GET(new Request("http://localhost/api/feed?range=today"));

      const json = await response.json();
      const itemIds = json.items.map((item: { id: string }) => item.id);

      expect(itemIds).toContain("cluster-a");
      expect(itemIds).toContain("item-timezone-created");
      expect(itemIds).not.toContain("item-created-too-old");
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns group badges for single entries and cluster majority groups", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));

    try {
      const [aiGroup, researchGroup] = await Promise.all([
        prisma.sourceGroup.create({ data: { id: "group-ai", name: "AI", sortOrder: 1 } }),
        prisma.sourceGroup.create({ data: { id: "group-research", name: "研究", sortOrder: 2 } }),
      ]);
      const baseSource = await prisma.source.findFirstOrThrow({
        where: { rssUrl: "https://api.example.com/feed.xml" },
      });
      await prisma.source.update({
        where: { id: baseSource.id },
        data: { groupId: aiGroup.id },
      });
      const researchSource = await prisma.source.create({
        data: {
          id: "source-research",
          name: "Research Feed",
          rssUrl: "https://research.example.com/feed.xml",
          siteUrl: "https://research.example.com",
          groupId: researchGroup.id,
          enabled: true,
          aiParsingEnabled: true,
        },
      });
      await prisma.contentCluster.create({
        data: {
          id: "cluster-dominant-group",
          kind: "topic",
          title: "Dominant Group Cluster",
          summary: "Dominant group summary",
          score: 80,
          itemCount: 5,
          latestPublishedAt: new Date("2026-04-10T11:00:00.000Z"),
          status: "active",
          fingerprint: "dominant-group-cluster",
        },
      });
      await prisma.item.createMany({
        data: [
          {
            id: "dominant-ai-1",
            sourceId: baseSource.id,
            clusterId: "cluster-dominant-group",
            originalUrl: "https://api.example.com/dominant-ai-1",
            canonicalUrl: "https://api.example.com/dominant-ai-1",
            urlHash: "hash-dominant-ai-1",
            originalTitle: "Dominant AI 1",
            publishedAt: new Date("2026-04-10T11:00:00.000Z"),
            summaryText: "AI 1",
            status: "processed",
            moderationStatus: "allowed",
            qualityScore: 81,
            qualityRationale: "测试",
            language: "en",
            createdAt: new Date("2026-04-10T11:00:00.000Z"),
          },
          {
            id: "dominant-ai-2",
            sourceId: baseSource.id,
            clusterId: "cluster-dominant-group",
            originalUrl: "https://api.example.com/dominant-ai-2",
            canonicalUrl: "https://api.example.com/dominant-ai-2",
            urlHash: "hash-dominant-ai-2",
            originalTitle: "Dominant AI 2",
            publishedAt: new Date("2026-04-10T10:59:00.000Z"),
            summaryText: "AI 2",
            status: "processed",
            moderationStatus: "allowed",
            qualityScore: 80,
            qualityRationale: "测试",
            language: "en",
            createdAt: new Date("2026-04-10T10:59:00.000Z"),
          },
          {
            id: "dominant-research-1",
            sourceId: researchSource.id,
            clusterId: "cluster-dominant-group",
            originalUrl: "https://research.example.com/dominant-1",
            canonicalUrl: "https://research.example.com/dominant-1",
            urlHash: "hash-dominant-research-1",
            originalTitle: "Dominant Research 1",
            publishedAt: new Date("2026-04-10T10:58:00.000Z"),
            summaryText: "Research 1",
            status: "processed",
            moderationStatus: "allowed",
            qualityScore: 82,
            qualityRationale: "测试",
            language: "en",
            createdAt: new Date("2026-04-10T10:58:00.000Z"),
          },
          {
            id: "dominant-research-2",
            sourceId: researchSource.id,
            clusterId: "cluster-dominant-group",
            originalUrl: "https://research.example.com/dominant-2",
            canonicalUrl: "https://research.example.com/dominant-2",
            urlHash: "hash-dominant-research-2",
            originalTitle: "Dominant Research 2",
            publishedAt: new Date("2026-04-10T10:57:00.000Z"),
            summaryText: "Research 2",
            status: "processed",
            moderationStatus: "allowed",
            qualityScore: 83,
            qualityRationale: "测试",
            language: "en",
            createdAt: new Date("2026-04-10T10:57:00.000Z"),
          },
          {
            id: "dominant-research-3",
            sourceId: researchSource.id,
            clusterId: "cluster-dominant-group",
            originalUrl: "https://research.example.com/dominant-3",
            canonicalUrl: "https://research.example.com/dominant-3",
            urlHash: "hash-dominant-research-3",
            originalTitle: "Dominant Research 3",
            publishedAt: new Date("2026-04-10T10:56:00.000Z"),
            summaryText: "Research 3",
            status: "processed",
            moderationStatus: "allowed",
            qualityScore: 84,
            qualityRationale: "测试",
            language: "en",
            createdAt: new Date("2026-04-10T10:56:00.000Z"),
          },
        ],
      });
      await refreshClusterFeedStats(["cluster-dominant-group", "cluster-a", "cluster-b", "cluster-c"]);

      const { GET } = await import("@/app/api/feed/route");
      const [defaultResponse, aiResponse, researchResponse] = await Promise.all([
        GET(new Request("http://localhost/api/feed?range=all")),
        GET(new Request(`http://localhost/api/feed?range=all&groupId=${aiGroup.id}`)),
        GET(new Request(`http://localhost/api/feed?range=all&groupId=${researchGroup.id}`)),
      ]);
      const defaultJson = await defaultResponse.json();
      const aiJson = await aiResponse.json();
      const researchJson = await researchResponse.json();
      const defaultCluster = defaultJson.items.find((item: { id: string }) => item.id === "cluster-dominant-group");
      const aiFilteredCluster = aiJson.items.find((item: { id: string }) => item.id === "cluster-dominant-group");
      const researchFilteredCluster = researchJson.items.find(
        (item: { id: string }) => item.id === "cluster-dominant-group",
      );

      expect(defaultCluster).toMatchObject({
        type: "cluster",
        group: {
          id: researchGroup.id,
          name: "研究",
        },
      });
      expect(aiFilteredCluster).toBeUndefined();
      expect(researchFilteredCluster).toMatchObject({
        type: "cluster",
        group: {
          id: researchGroup.id,
          name: "研究",
        },
      });
      expect(defaultJson.items.find((item: { id: string }) => item.id === "item-timezone-created")).toMatchObject({
        group: {
          id: aiGroup.id,
          name: "AI",
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts cross-group clusters only under their dominant group", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));

    try {
      const [aiGroup, researchGroup] = await Promise.all([
        prisma.sourceGroup.create({ data: { id: "group-count-ai", name: "AI", sortOrder: 1 } }),
        prisma.sourceGroup.create({ data: { id: "group-count-research", name: "研究", sortOrder: 2 } }),
      ]);
      const baseSource = await prisma.source.findFirstOrThrow({
        where: { rssUrl: "https://api.example.com/feed.xml" },
      });
      await prisma.source.update({
        where: { id: baseSource.id },
        data: { groupId: aiGroup.id },
      });
      const researchSource = await prisma.source.create({
        data: {
          id: "source-count-research",
          name: "Research Count Feed",
          rssUrl: "https://research-count.example.com/feed.xml",
          siteUrl: "https://research-count.example.com",
          groupId: researchGroup.id,
          enabled: true,
          aiParsingEnabled: true,
        },
      });
      await prisma.contentCluster.create({
        data: {
          id: "cluster-cross-group-count",
          kind: "topic",
          title: "Cross Group Count Cluster",
          summary: "Cross group count summary",
          score: 80,
          itemCount: 3,
          latestPublishedAt: new Date("2026-04-10T11:00:00.000Z"),
          status: "active",
          fingerprint: "cross-group-count-cluster",
        },
      });
      await prisma.item.createMany({
        data: [
          {
            id: "cross-count-ai-1",
            sourceId: baseSource.id,
            clusterId: "cluster-cross-group-count",
            originalUrl: "https://api.example.com/cross-count-ai-1",
            canonicalUrl: "https://api.example.com/cross-count-ai-1",
            urlHash: "hash-cross-count-ai-1",
            originalTitle: "Cross Count AI 1",
            publishedAt: new Date("2026-04-10T11:00:00.000Z"),
            summaryText: "AI 1",
            status: "processed",
            moderationStatus: "allowed",
            qualityScore: 81,
            qualityRationale: "测试",
            language: "en",
            createdAt: new Date("2026-04-10T11:00:00.000Z"),
          },
          {
            id: "cross-count-ai-2",
            sourceId: baseSource.id,
            clusterId: "cluster-cross-group-count",
            originalUrl: "https://api.example.com/cross-count-ai-2",
            canonicalUrl: "https://api.example.com/cross-count-ai-2",
            urlHash: "hash-cross-count-ai-2",
            originalTitle: "Cross Count AI 2",
            publishedAt: new Date("2026-04-10T10:59:00.000Z"),
            summaryText: "AI 2",
            status: "processed",
            moderationStatus: "allowed",
            qualityScore: 80,
            qualityRationale: "测试",
            language: "en",
            createdAt: new Date("2026-04-10T10:59:00.000Z"),
          },
          {
            id: "cross-count-research-1",
            sourceId: researchSource.id,
            clusterId: "cluster-cross-group-count",
            originalUrl: "https://research-count.example.com/cross-count-research-1",
            canonicalUrl: "https://research-count.example.com/cross-count-research-1",
            urlHash: "hash-cross-count-research-1",
            originalTitle: "Cross Count Research 1",
            publishedAt: new Date("2026-04-10T10:58:00.000Z"),
            summaryText: "Research 1",
            status: "processed",
            moderationStatus: "allowed",
            qualityScore: 82,
            qualityRationale: "测试",
            language: "en",
            createdAt: new Date("2026-04-10T10:58:00.000Z"),
          },
        ],
      });
      await refreshClusterFeedStats(["cluster-cross-group-count", "cluster-a", "cluster-b", "cluster-c"]);

      const { GET } = await import("@/app/api/feed/route");
      const [defaultResponse, aiResponse, researchResponse] = await Promise.all([
        GET(new Request("http://localhost/api/feed?range=today&title=Cross%20Group%20Count")),
        GET(new Request(`http://localhost/api/feed?range=today&title=Cross%20Group%20Count&groupId=${aiGroup.id}`)),
        GET(new Request(`http://localhost/api/feed?range=today&title=Cross%20Group%20Count&groupId=${researchGroup.id}`)),
      ]);
      const defaultJson = await defaultResponse.json();
      const aiJson = await aiResponse.json();
      const researchJson = await researchResponse.json();
      const aiOption = defaultJson.groups.find((group: { id: string }) => group.id === aiGroup.id);
      const researchOption = defaultJson.groups.find((group: { id: string }) => group.id === researchGroup.id);

      expect(defaultJson.pagination.total).toBe(1);
      expect(aiJson.pagination.total).toBe(1);
      expect(researchJson.pagination.total).toBe(0);
      expect(aiOption).toMatchObject({
        id: aiGroup.id,
        count: 1,
      });
      expect(researchOption).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("defaults rss to the latest items without a time filter", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));

    try {
      const { GET } = await import("@/app/api/feed/rss/route");
      const response = await GET(new Request("http://localhost/api/feed/rss"));

      const xml = await response.text();

      expect(xml).toContain("<title>OpenAI Agent 发布</title>");
      expect(xml).toContain("<title>按创建时间归档</title>");
      expect(xml).toContain("<title>发布时间新但创建时间旧</title>");
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses 100 entries as the default rss page size", async () => {
    const { DEFAULT_RSS_FEED_PAGE_SIZE } = await import("@/lib/feed/rss");

    expect(DEFAULT_RSS_FEED_PAGE_SIZE).toBe(100);
  });

  it("sorts the mixed feed by score when requested", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));

    try {
      const { GET } = await import("@/app/api/feed/route");
      const response = await GET(new Request("http://localhost/api/feed?range=7d&sort=score_desc"));

      const json = await response.json();

      expect(json.items).toHaveLength(4);
      expect(json.items[0]).toMatchObject({
        type: "single",
        id: "item-c1",
        score: 98,
      });
      expect(json.items[1]).toMatchObject({
        type: "cluster",
        id: "cluster-a",
        score: 90,
      });
      expect(json.items[2]).toMatchObject({
        type: "single",
        id: "item-timezone-created",
        score: 75,
      });
      expect(json.items[3]).toMatchObject({
        type: "single",
        id: "item-b1",
        score: 62,
      });
      expect(json.sort).toBe("score_desc");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps score sorting tied to content quality instead of multi-source boosts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));

    try {
      const [firstSource, secondSource, thirdSource] = await Promise.all([
        prisma.source.create({
          data: {
            name: "Boost Feed 1",
            rssUrl: "https://boost-1.example.com/feed.xml",
            siteUrl: "https://boost-1.example.com",
            enabled: true,
            aiParsingEnabled: true,
          },
        }),
        prisma.source.create({
          data: {
            name: "Boost Feed 2",
            rssUrl: "https://boost-2.example.com/feed.xml",
            siteUrl: "https://boost-2.example.com",
            enabled: true,
            aiParsingEnabled: true,
          },
        }),
        prisma.source.create({
          data: {
            name: "Boost Feed 3",
            rssUrl: "https://boost-3.example.com/feed.xml",
            siteUrl: "https://boost-3.example.com",
            enabled: true,
            aiParsingEnabled: true,
          },
        }),
      ]);

      await prisma.contentCluster.create({
        data: {
          id: "cluster-boosted",
          kind: "topic",
          title: "多来源聚合内容",
          summary: "多来源聚合摘要",
          score: 93,
          itemCount: 3,
          latestPublishedAt: new Date("2026-04-07T09:00:00.000Z"),
          status: "active",
          fingerprint: "boosted-cluster",
        },
      });

      await prisma.item.createMany({
        data: [firstSource, secondSource, thirdSource].map((source, index) => ({
          id: `item-boosted-${index + 1}`,
          sourceId: source.id,
          clusterId: "cluster-boosted",
          originalUrl: `https://boost-${index + 1}.example.com/story`,
          canonicalUrl: `https://boost-${index + 1}.example.com/story`,
          urlHash: `hash-boosted-${index + 1}`,
          originalTitle: `Boosted Story ${index + 1}`,
          translatedTitle: `加权内容 ${index + 1}`,
          publishedAt: new Date(`2026-04-07T09:0${index}:00.000Z`),
          summaryText: `加权摘要 ${index + 1}`,
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 93,
          qualityRationale: "多来源高质量",
          language: "zh",
          createdAt: new Date(`2026-04-07T09:1${index}:00.000Z`),
        })),
      });
      await refreshClusterFeedStats(["cluster-boosted"]);

      const { GET } = await import("@/app/api/feed/route");
      const response = await GET(new Request("http://localhost/api/feed?range=7d&sort=score_desc"));
      const json = await response.json();

      expect(json.items[0]).toMatchObject({
        type: "single",
        id: "item-c1",
        score: 98,
      });
      expect(json.items[1]).toMatchObject({
        type: "cluster",
        id: "cluster-boosted",
        score: 93,
        sourceCount: 3,
        itemCount: 3,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("filters clusters by entity search text instead of child item titles", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));

    try {
      const { GET } = await import("@/app/api/feed/route");
      const childOnlyResponse = await GET(new Request("http://localhost/api/feed?range=7d&title=Story"));
      const response = await GET(new Request("http://localhost/api/feed?range=7d&title=OpenAI"));

      const childOnlyJson = await childOnlyResponse.json();
      const json = await response.json();

      expect(json.items.length).toBeGreaterThan(0);
      expect(json.items.some((item: { type: string }) => item.type === "cluster")).toBe(true);
      expect(childOnlyJson.items.some((item: { id: string }) => item.id === "cluster-a")).toBe(false);
      expect(json.title).toBe("OpenAI");
    } finally {
      vi.useRealTimers();
    }
  });

  it("finds items by searching summary body text", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));

    try {
      const { GET } = await import("@/app/api/feed/route");
      // timezone-item has summaryText="创建时间落在东八区当天", search for "东八区" (3 chars)
      const response = await GET(new Request("http://localhost/api/feed?range=7d&title=东八区"));

      const json = await response.json();

      expect(json.items.length).toBeGreaterThan(0);
      // timezone-item has translatedTitle "按创建时间归档", should appear as single entry
      expect(json.items.some((item: { title: string }) => item.title === "按创建时间归档")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("matches CJK text with trigram tokenizer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));

    try {
      const { GET } = await import("@/app/api/feed/route");
      // timezone-item has translatedTitle="按创建时间归档", search for substring "创建时间"
      const response = await GET(new Request("http://localhost/api/feed?range=7d&title=创建时间"));

      const json = await response.json();
      expect(json.items.length).toBeGreaterThan(0);
      expect(json.items.some((item: { title: string }) => item.title === "按创建时间归档")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("matches short CJK keywords that are below the trigram token length", async () => {
    const source = await prisma.source.findFirstOrThrow({
      where: { rssUrl: "https://api.example.com/feed.xml" },
    });

    await prisma.item.create({
      data: {
        id: "item-ant-group",
        sourceId: source.id,
        originalUrl: "https://api.example.com/ant-group",
        canonicalUrl: "https://api.example.com/ant-group",
        urlHash: "hash-ant-group",
        originalTitle: "Ant Group AI update",
        translatedTitle: "蚂蚁集团发布 AI 助手",
        author: "Author Ant",
        publishedAt: new Date("2026-04-10T10:00:00.000Z"),
        summaryText: "蚂蚁集团发布新的企业 AI 助手。",
        status: "processed",
        moderationStatus: "allowed",
        qualityScore: 80,
        qualityRationale: "高质量",
        language: "en",
        createdAt: new Date("2026-04-10T10:05:00.000Z"),
      },
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));

    try {
      const { GET } = await import("@/app/api/feed/route");
      const response = await GET(new Request("http://localhost/api/feed?range=7d&title=蚂蚁"));

      const json = await response.json();

      expect(json.items.some((item: { title: string }) => item.title === "蚂蚁集团发布 AI 助手")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns unfiltered results when search term is empty", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));

    try {
      const { GET } = await import("@/app/api/feed/route");
      const withSearch = await GET(new Request("http://localhost/api/feed?range=7d&title=Story"));
      const withoutSearch = await GET(new Request("http://localhost/api/feed?range=7d&title="));

      const filtered = await withSearch.json();
      const unfiltered = await withoutSearch.json();

      // Empty search should return more (or equal) results than filtered search
      expect(unfiltered.items.length).toBeGreaterThanOrEqual(filtered.items.length);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats FTS5 operators as literal search text", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));

    try {
      const { GET } = await import("@/app/api/feed/route");
      // "AND" is an FTS5 operator; should be treated as literal text, not cause errors
      const response = await GET(new Request("http://localhost/api/feed?range=7d&title=AND"));

      const json = await response.json();
      // Should return a valid response without FTS5 syntax errors
      expect(json.items).toBeDefined();
      expect(json.pagination).toBeDefined();
      // "AND" likely doesn't match any test data, but shouldn't error
    } finally {
      vi.useRealTimers();
    }
  });

  it("filters feed entries by group and only returns matching content", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));

    try {
      const group = await prisma.sourceGroup.create({
        data: {
          name: "Infra",
        },
      });

      const groupedSource = await prisma.source.create({
        data: {
          name: "Grouped Feed",
          rssUrl: "https://grouped.example.com/feed.xml",
          siteUrl: "https://grouped.example.com",
          enabled: true,
          aiParsingEnabled: true,
          groupId: group.id,
        },
      });

      await prisma.contentCluster.create({
        data: {
          id: "cluster-grouped",
          kind: "topic",
          title: "Infra Launch",
          summary: "Infra summary",
          score: 85,
          itemCount: 1,
          latestPublishedAt: new Date("2026-04-10T10:00:00.000Z"),
          status: "active",
          fingerprint: "infra-launch",
        },
      });

      await prisma.item.create({
        data: {
          id: "item-grouped-1",
          sourceId: groupedSource.id,
          clusterId: "cluster-grouped",
          originalUrl: "https://grouped.example.com/post-1",
          canonicalUrl: "https://grouped.example.com/post-1",
          urlHash: "hash-grouped-1",
          originalTitle: "Infra story",
          translatedTitle: "基础设施动态",
          publishedAt: new Date("2026-04-10T10:00:00.000Z"),
          summaryText: "Infra item summary",
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 85,
          qualityRationale: "高质量",
          language: "en",
        },
      });

      const { GET } = await import("@/app/api/feed/route");
      const response = await GET(
        new Request(`http://localhost/api/feed?range=7d&groupId=${group.id}`),
      );

      const json = await response.json();

      expect(json.items).toHaveLength(1);
      expect(json.items[0]).toMatchObject({
        type: "single",
        id: "item-grouped-1",
        title: "基础设施动态",
        sourceName: "Grouped Feed",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns dynamic group counts for the current filter range while ignoring the selected group filter", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));

    try {
      const infra = await prisma.sourceGroup.create({
        data: {
          name: "Infra",
        },
      });

      const ai = await prisma.sourceGroup.create({
        data: {
          name: "AI",
        },
      });

      const infraSource = await prisma.source.create({
        data: {
          name: "Infra Feed",
          rssUrl: "https://infra.example.com/feed.xml",
          siteUrl: "https://infra.example.com",
          enabled: true,
          aiParsingEnabled: true,
          groupId: infra.id,
        },
      });

      const aiSource = await prisma.source.create({
        data: {
          name: "AI Feed",
          rssUrl: "https://ai.example.com/feed.xml",
          siteUrl: "https://ai.example.com",
          enabled: true,
          aiParsingEnabled: true,
          groupId: ai.id,
        },
      });

      await prisma.item.createMany({
        data: [
          {
            id: "item-group-count-infra",
            sourceId: infraSource.id,
            originalUrl: "https://infra.example.com/post-1",
            canonicalUrl: "https://infra.example.com/post-1",
            urlHash: "hash-group-count-infra",
            originalTitle: "Infra count story",
            translatedTitle: "基础设施统计",
            publishedAt: new Date("2026-04-10T08:00:00.000Z"),
            summaryText: "Infra summary",
            status: "processed",
            moderationStatus: "allowed",
            qualityScore: 80,
            qualityRationale: "高质量",
            language: "en",
          },
          {
            id: "item-group-count-ai",
            sourceId: aiSource.id,
            originalUrl: "https://ai.example.com/post-1",
            canonicalUrl: "https://ai.example.com/post-1",
            urlHash: "hash-group-count-ai",
            originalTitle: "AI count story",
            translatedTitle: "AI 统计",
            publishedAt: new Date("2026-04-10T09:00:00.000Z"),
            summaryText: "AI summary",
            status: "processed",
            moderationStatus: "allowed",
            qualityScore: 81,
            qualityRationale: "高质量",
            language: "en",
          },
        ],
      });

      const { GET } = await import("@/app/api/feed/route");
      const response = await GET(
        new Request(`http://localhost/api/feed?range=7d&groupId=${infra.id}`),
      );

      const json = await response.json();

      expect(json.items).toHaveLength(1);
      expect(json.groupTotalCount).toBe(6);
      expect(json.groups).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: infra.id, name: "Infra", count: 1 }),
          expect.objectContaining({ id: ai.id, name: "AI", count: 1 }),
        ]),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the all-groups total for ungrouped items", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));

    try {
      const ungroupedSource = await prisma.source.create({
        data: {
          name: "Ungrouped Feed",
          rssUrl: "https://ungrouped.example.com/feed.xml",
          siteUrl: "https://ungrouped.example.com",
          enabled: true,
          aiParsingEnabled: true,
        },
      });

      await prisma.item.createMany({
        data: [
          {
            id: "item-ungrouped-total-1",
            sourceId: ungroupedSource.id,
            originalUrl: "https://ungrouped.example.com/post-1",
            canonicalUrl: "https://ungrouped.example.com/post-1",
            urlHash: "hash-ungrouped-total-1",
            originalTitle: "Ungrouped story one",
            translatedTitle: "未分组内容一",
            publishedAt: new Date("2026-04-10T08:00:00.000Z"),
            summaryText: "summary 1",
            status: "processed",
            moderationStatus: "allowed",
            qualityScore: 70,
            qualityRationale: "ok",
            language: "en",
          },
          {
            id: "item-ungrouped-total-2",
            sourceId: ungroupedSource.id,
            originalUrl: "https://ungrouped.example.com/post-2",
            canonicalUrl: "https://ungrouped.example.com/post-2",
            urlHash: "hash-ungrouped-total-2",
            originalTitle: "Ungrouped story two",
            translatedTitle: "未分组内容二",
            publishedAt: new Date("2026-04-10T09:00:00.000Z"),
            summaryText: "summary 2",
            status: "processed",
            moderationStatus: "allowed",
            qualityScore: 71,
            qualityRationale: "ok",
            language: "en",
          },
        ],
      });

      const { GET } = await import("@/app/api/feed/route");
      const response = await GET(new Request("http://localhost/api/feed?range=7d"));
      const json = await response.json();

      expect(json.groupTotalCount).toBeGreaterThanOrEqual(2);
      expect(json.groups).toEqual(expect.any(Array));
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns all cluster child items regardless of feed time filters", async () => {
    const source = await prisma.source.findFirstOrThrow({
      where: { rssUrl: "https://api.example.com/feed.xml" },
    });
    const parent = await prisma.item.create({
      data: {
        id: "aggregation-parent-cluster-detail",
        sourceId: source.id,
        originalUrl: "https://api.example.com/roundup-detail",
        canonicalUrl: "https://api.example.com/roundup-detail",
        urlHash: "aggregation-parent-cluster-detail",
        originalTitle: "Cluster Detail Parent",
        translatedTitle: "聚类详情父条目",
        publishedAt: new Date("2026-04-10T10:00:00.000Z"),
        summaryText: "父聚合摘要",
        status: "processed",
        moderationStatus: "allowed",
        qualityScore: 80,
        qualityRationale: "聚合父条目",
        isAggregation: true,
        aggregationParseStatus: "parsed",
        createdAt: new Date("2026-04-10T10:00:00.000Z"),
      },
    });
    await prisma.item.create({
      data: {
        id: "aggregation-child-cluster-detail",
        sourceId: source.id,
        clusterId: "cluster-a",
        parentItemId: parent.id,
        originalUrl: "https://api.example.com/roundup-detail#child",
        canonicalUrl: "https://api.example.com/roundup-detail",
        urlHash: "aggregation-child-cluster-detail",
        originalTitle: "Cluster Detail Child",
        translatedTitle: "聚类详情子事件",
        publishedAt: new Date("2026-04-10T10:00:00.000Z"),
        summaryText: "子事件摘要",
        status: "processed",
        moderationStatus: "allowed",
        qualityScore: 82,
        qualityRationale: "聚类详情 parent 元数据",
        isAggregation: false,
        createdAt: new Date("2026-04-10T10:00:00.000Z"),
      },
    });

    const { GET } = await import("@/app/api/feed/clusters/[id]/route");
    const response = await GET(
      new Request("http://localhost/api/feed/clusters/cluster-a?range=all&start=2026-04-11&end=2026-04-11"),
      { params: Promise.resolve({ id: "cluster-a" }) },
    );

    const json = await response.json();

    expect(json.items.map((item: { id: string }) => item.id)).toEqual([
      "aggregation-child-cluster-detail",
      "item-a1",
      "item-a2",
    ]);
    expect(json.items[0]).toMatchObject({
      aggregationParent: {
        id: parent.id,
        title: "聚类详情父条目",
        originalUrl: "https://api.example.com/roundup-detail",
      },
    });
  });

  it("does not match multi-item clusters by sourceId child membership", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));

    try {
      const otherSource = await prisma.source.create({
        data: {
          name: "Other Feed",
          rssUrl: "https://other.example.com/feed.xml",
          siteUrl: "https://other.example.com",
          enabled: true,
          aiParsingEnabled: true,
        },
      });

      await prisma.contentCluster.create({
        data: {
          id: "cluster-mixed",
          kind: "topic",
          title: "Mixed Cluster",
          summary: "Mixed summary",
          score: 77,
          itemCount: 2,
          latestPublishedAt: new Date("2026-04-10T11:00:00.000Z"),
          status: "active",
          fingerprint: "mixed-cluster",
        },
      });

      const baseSource = await prisma.source.findFirstOrThrow({
        where: { rssUrl: "https://api.example.com/feed.xml" },
      });

      await prisma.item.createMany({
        data: [
          {
            id: "item-mixed-source-a",
            sourceId: baseSource.id,
            clusterId: "cluster-mixed",
            originalUrl: "https://api.example.com/mixed-a",
            canonicalUrl: "https://api.example.com/mixed-a",
            urlHash: "hash-mixed-a",
            originalTitle: "Mixed Story A",
            translatedTitle: "混合来源 A",
            publishedAt: new Date("2026-04-10T11:00:00.000Z"),
            summaryText: "摘要 A",
            status: "processed",
            moderationStatus: "allowed",
            qualityScore: 75,
            qualityRationale: "质量稳定",
            language: "en",
          },
          {
            id: "item-mixed-source-b",
            sourceId: otherSource.id,
            clusterId: "cluster-mixed",
            originalUrl: "https://other.example.com/mixed-b",
            canonicalUrl: "https://other.example.com/mixed-b",
            urlHash: "hash-mixed-b",
            originalTitle: "Mixed Story B",
            translatedTitle: "混合来源 B",
            publishedAt: new Date("2026-04-10T10:30:00.000Z"),
            summaryText: "摘要 B",
            status: "processed",
            moderationStatus: "allowed",
            qualityScore: 71,
            qualityRationale: "质量稳定",
            language: "en",
          },
        ],
      });
      await refreshClusterFeedStats(["cluster-mixed"]);

      const { GET } = await import("@/app/api/feed/route");
      const response = await GET(
        new Request(`http://localhost/api/feed?range=7d&sourceId=${baseSource.id}`),
      );

      const json = await response.json();
      const downgradedEntry = json.items.find((entry: { id: string }) => entry.id === "item-mixed-source-a");

      expect(downgradedEntry).toBeUndefined();
      expect(json.items.find((entry: { id: string }) => entry.id === "cluster-mixed")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
