import { beforeEach, describe, expect, it, vi } from "vitest";

import { normalizeFingerprint } from "@/lib/clusters/helpers";
import { executeClusterSummaryTask } from "@/lib/clusters/service";
import { prisma } from "@/lib/db";
import {
  enqueueItemReanalyzeTask,
  enqueueItemRegenerationTask,
  executeItemReanalyzeTask,
  executeItemRegenerationTask,
  executeItemReparseAggregationsTask,
  regenerateItemContent,
} from "@/lib/items/service";
import { replaceItemTags } from "@/lib/tags/service";
import { buildAiProviderMock, buildEventSignature } from "../helpers/ai-provider";

describe("regenerateItemContent", () => {
  beforeEach(async () => {
    await prisma.item.deleteMany();
    await prisma.tag.deleteMany();
    await prisma.contentCluster.deleteMany();
    await prisma.fetchRun.deleteMany();
    await prisma.backgroundTaskRun.deleteMany();
    await prisma.source.deleteMany();
    await prisma.sourceGroup.deleteMany();
    await prisma.blacklistKeyword.deleteMany();
    await prisma.taskSchedule.deleteMany();
  });

  it("queues a summary regeneration task", async () => {
    const taskRun = await enqueueItemRegenerationTask("item-1", "summary");

    expect(taskRun.kind).toBe("item_regenerate_summary");
    expect(taskRun.entityId).toBe("item-1");
    expect(taskRun.status).toBe("queued");
  });

  it("queues an item reanalyze task", async () => {
    const taskRun = await enqueueItemReanalyzeTask("item-1");

    expect(taskRun.kind).toBe("item_reanalyze");
    expect(taskRun.entityId).toBe("item-1");
    expect(taskRun.status).toBe("queued");
  });

  it("regenerates only the translated title when requested", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Example Feed",
        rssUrl: "https://example.com/feed.xml",
        siteUrl: "https://example.com",
        enabled: true,
        aiParsingEnabled: true,
      },
    });

    const item = await prisma.item.create({
      data: {
        sourceId: source.id,
        originalUrl: "https://example.com/posts/1",
        canonicalUrl: "https://example.com/posts/1",
        urlHash: "hash-1",
        originalTitle: "OpenAI ships a new toolkit",
        translatedTitle: "旧标题",
        summaryText: "旧摘要",
        publishedAt: new Date("2026-04-10T09:00:00.000Z"),
        status: "processed",
        language: "en",
        fullText: "Full article body",
      },
    });

    const regenerated = await regenerateItemContent(item.id, "translation", {
      aiProvider: buildAiProviderMock({
        analysisFixture: vi.fn().mockResolvedValue({
          translatedTitle: "新的中文标题",
          moderationStatus: "allowed",
          moderationReason: null,
          moderationDetail: null,
          qualityScore: 80,
          qualityRationale: "高质量",
          eventSignature: buildEventSignature({
            eventType: "launch",
            eventSubject: "OpenAI",
            eventAction: "发布",
            eventObject: "toolkit",
          }),
        }),
        summarizeCluster: vi.fn().mockResolvedValue("聚合摘要"),
        matchClusterCandidate: vi.fn().mockResolvedValue(null),
      }),
    });

    expect(regenerated.translatedTitle).toBe("新的中文标题");
    expect(regenerated.summaryText).toBe("旧摘要");
  });

  it("regenerates only the summary when requested and preserves the title", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Example Feed",
        rssUrl: "https://example.com/feed.xml",
        siteUrl: "https://example.com",
        enabled: true,
        aiParsingEnabled: true,
      },
    });

    const item = await prisma.item.create({
      data: {
        sourceId: source.id,
        originalUrl: "https://example.com/posts/2",
        canonicalUrl: "https://example.com/posts/2",
        urlHash: "hash-2",
        originalTitle: "OpenAI launches a benchmark",
        translatedTitle: "现有中文标题",
        summaryText: "现有摘要",
        publishedAt: new Date("2026-04-10T09:30:00.000Z"),
        status: "processed",
        language: "en",
        fullText: "A full text body used for summarization",
      },
    });

    const regenerated = await regenerateItemContent(item.id, "summary", {
      aiProvider: buildAiProviderMock({
        summaryFixture: vi.fn().mockResolvedValue({summary: "新的摘要内容", isAggregation: false}),
        summarizeCluster: vi.fn().mockResolvedValue("聚合摘要"),
        matchClusterCandidate: vi.fn().mockResolvedValue(null),
      }),
    });

    expect(regenerated.translatedTitle).toBe("现有中文标题");
    expect(regenerated.summaryText).toBe("新的摘要内容");
  });

  it("preserves item tags when only the summary is regenerated", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Example Feed",
        rssUrl: "https://example.com/feed-summary-tags.xml",
        siteUrl: "https://example.com",
        enabled: true,
        aiParsingEnabled: true,
      },
    });
    const item = await prisma.item.create({
      data: {
        sourceId: source.id,
        originalUrl: "https://example.com/posts/summary-tags",
        canonicalUrl: "https://example.com/posts/summary-tags",
        urlHash: "hash-summary-tags",
        originalTitle: "OpenAI launches a benchmark",
        translatedTitle: "现有中文标题",
        summaryText: "现有摘要",
        publishedAt: new Date("2026-04-10T09:30:00.000Z"),
        status: "processed",
        language: "en",
        fullText: "A full text body used for summarization",
      },
    });
    await replaceItemTags(item.id, ["OpenAI", "Benchmark"]);

    await regenerateItemContent(item.id, "summary", {
      aiProvider: buildAiProviderMock({
        summaryFixture: vi.fn().mockResolvedValue({summary: "新的摘要内容", isAggregation: false}),
        summarizeCluster: vi.fn().mockResolvedValue("聚合摘要"),
        matchClusterCandidate: vi.fn().mockResolvedValue(null),
      }),
    });

    const storedTags = await prisma.itemTag.findMany({
      where: { itemId: item.id },
      include: { tag: true },
      orderBy: { createdAt: "asc" },
    });
    expect(storedTags.map((entry) => entry.tag.normalized)).toEqual(["openai", "benchmark"]);
  });

  it("keeps the old value and records the error when regeneration fails", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Example Feed",
        rssUrl: "https://example.com/feed.xml",
        siteUrl: "https://example.com",
        enabled: true,
        aiParsingEnabled: true,
      },
    });

    const item = await prisma.item.create({
      data: {
        sourceId: source.id,
        originalUrl: "https://example.com/posts/3",
        canonicalUrl: "https://example.com/posts/3",
        urlHash: "hash-3",
        originalTitle: "OpenAI model update",
        translatedTitle: "保留原标题",
        summaryText: "保留原摘要",
        publishedAt: new Date("2026-04-10T10:00:00.000Z"),
        status: "processed",
        language: "en",
        fullText: "Body for regeneration",
      },
    });

    const regenerated = await regenerateItemContent(item.id, "summary", {
      aiProvider: buildAiProviderMock({
        summaryFixture: vi.fn().mockRejectedValue(new Error("Upstream regeneration failed")),
        summarizeCluster: vi.fn().mockResolvedValue("聚合摘要"),
        matchClusterCandidate: vi.fn().mockResolvedValue(null),
      }),
    });

    expect(regenerated.summaryText).toBe("保留原摘要");
    expect(regenerated.errorMessage).toContain("Upstream regeneration failed");
  });

  it("records ai usage for item summary regeneration tasks", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Example Feed",
        rssUrl: "https://example.com/feed.xml",
        siteUrl: "https://example.com",
        enabled: true,
        aiParsingEnabled: true,
      },
    });
    const cluster = await prisma.contentCluster.create({
      data: {
        id: "cluster-regeneration",
        kind: "topic",
        title: "OpenAI Toolkit",
        summary: "旧聚合摘要",
        score: 80,
        itemCount: 2,
        latestPublishedAt: new Date("2026-04-10T10:00:00.000Z"),
        status: "active",
        fingerprint: "openai-toolkit",
      },
    });

    await prisma.item.createMany({
      data: [
        {
          id: "item-regeneration-target",
          sourceId: source.id,
          clusterId: cluster.id,
          originalUrl: "https://example.com/posts/summary-1",
          canonicalUrl: "https://example.com/posts/summary-1",
          urlHash: "summary-1",
          originalTitle: "OpenAI ships a new toolkit",
          translatedTitle: "OpenAI 发布新工具包",
          summaryText: "旧摘要一",
          publishedAt: new Date("2026-04-10T10:00:00.000Z"),
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 86,
          qualityRationale: "高质量",
          language: "en",
          fullText: "Summary body one",
        },
        {
          id: "item-regeneration-peer",
          sourceId: source.id,
          clusterId: cluster.id,
          originalUrl: "https://example.com/posts/summary-2",
          canonicalUrl: "https://example.com/posts/summary-2",
          urlHash: "summary-2",
          originalTitle: "Another toolkit update",
          translatedTitle: "另一条工具包更新",
          summaryText: "旧摘要二",
          publishedAt: new Date("2026-04-10T09:30:00.000Z"),
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 82,
          qualityRationale: "高质量",
          language: "en",
          fullText: "Summary body two",
        },
      ],
    });

    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "item_regenerate_summary",
        triggerType: "admin_action",
        status: "queued",
        label: "重生成摘要",
        entityId: "item-regeneration-target",
      },
    });

    await executeItemRegenerationTask(taskRun, "summary", {
      aiProvider: buildAiProviderMock({
        summaryFixture: vi.fn().mockResolvedValue({summary: "新的摘要内容", isAggregation: false}),
        summarizeCluster: vi.fn().mockResolvedValue("新的聚合摘要"),
        matchClusterCandidate: vi.fn().mockResolvedValue(null),
      }),
    });

    const storedTaskRun = await prisma.backgroundTaskRun.findUniqueOrThrow({
      where: { id: taskRun.id },
    });

    expect(storedTaskRun.status).toBe("succeeded");
    expect(storedTaskRun.aiCallCountActual).toBe(1);
    expect(storedTaskRun.aiCallCountEstimated).toBe(1);
  });

  it("keeps the existing cluster when only the summary is regenerated", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Example Feed",
        rssUrl: "https://example.com/feed.xml",
        siteUrl: "https://example.com",
        enabled: true,
        aiParsingEnabled: true,
      },
    });
    const matchingFingerprint = normalizeFingerprint("launch|OpenAI|发布|toolkit|2026-04-10");
    const matchingCluster = await prisma.contentCluster.create({
      data: {
        id: "matching-cluster",
        kind: "topic",
        title: "OpenAI Toolkit 发布",
        summary: "已有聚合摘要",
        score: 88,
        itemCount: 1,
        latestPublishedAt: new Date("2026-04-10T09:00:00.000Z"),
        status: "active",
        fingerprint: matchingFingerprint,
        eventType: "launch",
        eventSubject: "OpenAI",
        eventAction: "发布",
        eventObject: "toolkit",
        eventDate: "2026-04-10",
      },
    });
    const previousCluster = await prisma.contentCluster.create({
      data: {
        id: "previous-single-cluster",
        kind: "topic",
        title: "旧单条聚合",
        summary: "旧单条摘要",
        score: 70,
        itemCount: 1,
        latestPublishedAt: new Date("2026-04-10T10:00:00.000Z"),
        status: "active",
        fingerprint: "previous-single-cluster",
      },
    });

    await prisma.item.create({
      data: {
        id: "matching-seed-item",
        sourceId: source.id,
        clusterId: matchingCluster.id,
        originalUrl: "https://example.com/posts/matching-seed",
        canonicalUrl: "https://example.com/posts/matching-seed",
        urlHash: "matching-seed",
        originalTitle: "OpenAI toolkit seed",
        translatedTitle: "OpenAI 工具包发布",
        summaryText: "已有聚合条目",
        publishedAt: new Date("2026-04-10T09:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        qualityScore: 88,
        qualityRationale: "高质量",
        eventType: "launch",
        eventSubject: "OpenAI",
        eventAction: "发布",
        eventObject: "toolkit",
        eventDate: "2026-04-10",
        language: "en",
        fullText: "Seed body",
      },
    });
    await prisma.item.create({
      data: {
        id: "summary-regeneration-match-target",
        sourceId: source.id,
        clusterId: previousCluster.id,
        originalUrl: "https://example.com/posts/matching-target",
        canonicalUrl: "https://example.com/posts/matching-target",
        urlHash: "matching-target",
        originalTitle: "OpenAI ships toolkit",
        translatedTitle: "OpenAI 发布工具包",
        summaryText: "旧摘要",
        publishedAt: new Date("2026-04-10T10:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        qualityScore: 86,
        qualityRationale: "高质量",
        eventType: "launch",
        eventSubject: "OpenAI",
        eventAction: "发布",
        eventObject: "toolkit",
        eventDate: "2026-04-10",
        language: "en",
        fullText: "Target body",
      },
    });

    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "item_regenerate_summary",
        triggerType: "admin_action",
        status: "queued",
        label: "重生成摘要",
        entityId: "summary-regeneration-match-target",
      },
    });

    await executeItemRegenerationTask(taskRun, "summary", {
      aiProvider: buildAiProviderMock({
        summaryFixture: vi.fn().mockResolvedValue({summary: "新的摘要内容", isAggregation: false}),
        summarizeCluster: vi.fn().mockResolvedValue("新的聚合摘要"),
        matchClusterCandidate: vi.fn().mockResolvedValue(null),
      }),
    });

    const [storedTaskRun, updatedItem] = await Promise.all([
      prisma.backgroundTaskRun.findUniqueOrThrow({ where: { id: taskRun.id } }),
      prisma.item.findUniqueOrThrow({ where: { id: "summary-regeneration-match-target" } }),
    ]);

    expect(updatedItem.clusterId).toBe(previousCluster.id);
    expect(storedTaskRun.progressLabel).toBe("已完成条目更新");
  });

  it("records ai usage for item reanalyze tasks", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Example Feed",
        rssUrl: "https://example.com/feed.xml",
        siteUrl: "https://example.com",
        enabled: true,
        aiParsingEnabled: true,
      },
    });
    const existingCluster = await prisma.contentCluster.create({
      data: {
        id: "cluster-reanalyze",
        kind: "topic",
        title: "OpenAI Toolkit",
        summary: "现有聚合摘要",
        score: 84,
        itemCount: 1,
        latestPublishedAt: new Date("2026-04-10T09:00:00.000Z"),
        status: "active",
        fingerprint: "openai-toolkit-launch",
      },
    });

    await prisma.item.create({
      data: {
        id: "cluster-seed-item",
        sourceId: source.id,
        clusterId: existingCluster.id,
        originalUrl: "https://example.com/posts/seed",
        canonicalUrl: "https://example.com/posts/seed",
        urlHash: "seed-item",
        originalTitle: "OpenAI toolkit launch",
        translatedTitle: "OpenAI 工具包发布",
        summaryText: "现有聚合中的条目",
        publishedAt: new Date("2026-04-10T09:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        qualityScore: 84,
        qualityRationale: "高质量",
        language: "en",
        fullText: "Existing seed body",
      },
    });
    await prisma.item.create({
      data: {
        id: "reanalyze-target",
        sourceId: source.id,
        originalUrl: "https://example.com/posts/reanalyze",
        canonicalUrl: "https://example.com/posts/reanalyze",
        urlHash: "reanalyze-target",
        originalTitle: "Another OpenAI toolkit report",
        translatedTitle: null,
        summaryText: "旧摘要",
        publishedAt: new Date("2026-04-10T10:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        qualityScore: 70,
        qualityRationale: "中等",
        language: "en",
        fullText: "Target body",
      },
    });
    await replaceItemTags("reanalyze-target", ["旧标签", "OpenAI"]);

    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "item_reanalyze",
        triggerType: "admin_action",
        status: "queued",
        label: "重新 AI 判定",
        entityId: "reanalyze-target",
      },
    });

    await executeItemReanalyzeTask(taskRun, {
      aiProvider: buildAiProviderMock({
        summaryFixture: vi.fn().mockResolvedValue({summary: "新的重分析摘要", isAggregation: false}),
        analysisFixture: vi.fn().mockResolvedValue({
          translatedTitle: "另一篇 OpenAI 工具包报道",
          moderationStatus: "allowed",
          moderationReason: null,
          moderationDetail: null,
          qualityScore: 88,
          qualityRationale: "高质量",
          eventSignature: buildEventSignature({
            eventType: "launch",
            eventSubject: "OpenAI",
            eventAction: "发布",
            eventObject: "toolkit",
          }),
          tags: ["OpenAI", "AI Agent", "新闻", "开发者工具"],
        }),
        summarizeCluster: vi.fn().mockResolvedValue("重算后的聚合摘要"),
        matchClusterCandidate: vi.fn().mockImplementation(async (_input, metadata: { candidates: Array<{ id: string }> }) => {
          return metadata.candidates[0]?.id ?? null;
        }),
      }),
    });

    const storedTaskRun = await prisma.backgroundTaskRun.findUniqueOrThrow({
      where: { id: taskRun.id },
    });
    const updatedItem = await prisma.item.findUniqueOrThrow({
      where: { id: "reanalyze-target" },
    });
    const updatedTags = await prisma.itemTag.findMany({
      where: { itemId: "reanalyze-target" },
      include: { tag: true },
      orderBy: { createdAt: "asc" },
    });

    expect(storedTaskRun.status).toBe("succeeded");
    expect(storedTaskRun.progressLabel).toBe(
      "已完成重新 AI 判定（非聚合 · 处理成功）",
    );
    expect(storedTaskRun.aiCallCountActual).toBe(3);
    expect(storedTaskRun.aiCallCountEstimated).toBe(5);
    expect(updatedItem.eventType).toBe("launch");
    expect(updatedItem.eventSubject).toBe("OpenAI");
    expect(updatedItem.eventAction).toBe("发布");
    expect(updatedItem.eventObject).toBe("toolkit");
    expect(updatedTags.map((entry) => entry.tag.normalized)).toEqual([
      "openai",
      "ai agent",
      "开发者工具",
    ]);
  });

  it("splits aggregation content during manual item reanalyze", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Aggregation Source",
        rssUrl: "https://aggregation.example.com/feed.xml",
        siteUrl: "https://aggregation.example.com",
        enabled: true,
        aiParsingEnabled: true,
        aggregationDetectionEnabled: true,
      },
    });
    const previousCluster = await prisma.contentCluster.create({
      data: {
        kind: "topic",
        title: "旧父项聚合",
        summary: "旧摘要",
        score: 70,
        itemCount: 1,
        latestPublishedAt: new Date("2026-04-10T09:00:00.000Z"),
        status: "active",
        fingerprint: "manual-reanalyze-parent-cluster",
      },
    });
    const item = await prisma.item.create({
      data: {
        sourceId: source.id,
        clusterId: previousCluster.id,
        originalUrl: "https://aggregation.example.com/roundup-manual",
        canonicalUrl: "https://aggregation.example.com/roundup-manual",
        urlHash: "manual-reanalyze-roundup",
        originalTitle: "AI roundup",
        translatedTitle: null,
        summaryText: "旧摘要",
        publishedAt: new Date("2026-04-10T09:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        qualityScore: 70,
        qualityRationale: "旧质量",
        language: "en",
        fullText: "OpenAI launches Toolkit. Anthropic updates Console. Mistral ships a model update.",
        isAggregation: false,
      },
    });
    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "item_reanalyze",
        triggerType: "admin_action",
        status: "queued",
        label: "重新 AI 判定",
        entityId: item.id,
      },
    });
    const analysisFixture = vi.fn().mockResolvedValue({
      translatedTitle: "AI 行业多项更新",
      moderationStatus: "allowed",
      moderationReason: null,
      moderationDetail: null,
      qualityScore: 90,
      qualityRationale: "包含多项独立更新",
      eventSignature: buildEventSignature({
        eventType: "update",
        eventSubject: "AI 行业",
        eventAction: "发布",
        eventObject: "多项更新",
        eventDate: "2026-04-10",
      }),
      tags: [],
    });
    const aggregationFixture = vi.fn().mockResolvedValue({
      mainEvent: {
        eventType: "update",
        eventSubject: "AI 行业",
        eventAction: "发布",
        eventObject: "多项更新",
        eventDate: "2026-04-10",
      },
      events: [
        {
          eventType: "launch",
          eventSubject: "OpenAI",
          eventAction: "发布",
          eventObject: "Toolkit",
          eventDate: "2026-04-10",
          title: "OpenAI 推出 Toolkit",
          oneLiner: "OpenAI 发布 Toolkit",
          qualityScore: 92,
          sourceUrl: "https://aggregation.example.com/roundup-manual",
        },
        {
          eventType: "update",
          eventSubject: "Anthropic",
          eventAction: "更新",
          eventObject: "Console",
          eventDate: "2026-04-10",
          title: "Anthropic 更新 Console",
          oneLiner: "Anthropic 更新 Console",
          qualityScore: 88,
          sourceUrl: null,
        },
      ],
    });

    await executeItemReanalyzeTask(taskRun, {
      aiProvider: buildAiProviderMock({
        summaryFixture: vi.fn().mockResolvedValue({summary: "多条 AI 新闻更新", isAggregation: true}),
        aggregationFixture,
        analysisFixture,
        summarizeCluster: vi.fn().mockResolvedValue("重算后的聚合摘要"),
        matchClusterCandidate: vi.fn().mockResolvedValue(null),
      }),
    });

    const storedTaskRun = await prisma.backgroundTaskRun.findUniqueOrThrow({
      where: { id: taskRun.id },
    });
    const updatedParent = await prisma.item.findUniqueOrThrow({ where: { id: item.id } });
    const children = await prisma.item.findMany({
      where: { parentItemId: item.id, status: "processed" },
      orderBy: { originalTitle: "asc" },
    });
    const oldCluster = await prisma.contentCluster.findUnique({
      where: { id: previousCluster.id },
    });

    expect(storedTaskRun.status).toBe("succeeded");
    expect(storedTaskRun.progressLabel).toBe(
      "已完成重新 AI 判定（聚合 · 子事件 2 · 处理成功）",
    );
    expect(analysisFixture).toHaveBeenCalledOnce();
    expect(aggregationFixture).toHaveBeenCalledTimes(1);
    expect(updatedParent).toMatchObject({
      summaryText: "多条 AI 新闻更新",
      isAggregation: true,
      aggregationParseStatus: "parsed",
      clusterId: null,
      eventSubject: "AI 行业",
      eventObject: "多项更新",
      qualityScore: 92,
    });
    expect(children).toHaveLength(2);
    expect(children.map((child) => child.originalTitle)).toEqual([
      "Anthropic 更新 Console",
      "OpenAI 推出 Toolkit",
    ]);
    expect(children.every((child) => child.clusterId)).toBe(true);
    expect(oldCluster).toBeNull();
  });

  it("retires stale aggregation children when manual reanalyze marks an item as non-aggregation", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Aggregation Source",
        rssUrl: "https://aggregation.example.com/feed.xml",
        siteUrl: "https://aggregation.example.com",
        enabled: true,
        aiParsingEnabled: true,
        aggregationDetectionEnabled: true,
      },
    });
    const staleChildCluster = await prisma.contentCluster.create({
      data: {
        kind: "topic",
        title: "旧子事件聚合",
        summary: "旧子事件摘要",
        score: 70,
        itemCount: 1,
        latestPublishedAt: new Date("2026-04-10T09:00:00.000Z"),
        status: "active",
        fingerprint: "manual-reanalyze-stale-child-cluster",
      },
    });
    const parent = await prisma.item.create({
      data: {
        sourceId: source.id,
        originalUrl: "https://aggregation.example.com/not-roundup",
        canonicalUrl: "https://aggregation.example.com/not-roundup",
        urlHash: "manual-reanalyze-not-roundup",
        originalTitle: "Single AI story",
        summaryText: "旧聚合摘要",
        publishedAt: new Date("2026-04-10T09:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        qualityScore: 70,
        qualityRationale: "旧质量",
        language: "en",
        fullText: "This article is a single story about one launch rather than a roundup.",
        isAggregation: true,
        aggregationParseStatus: "parsed",
      },
    });
    const staleChild = await prisma.item.create({
      data: {
        sourceId: source.id,
        parentItemId: parent.id,
        clusterId: staleChildCluster.id,
        originalUrl: "https://aggregation.example.com/not-roundup#event-stale",
        canonicalUrl: "https://aggregation.example.com/not-roundup",
        urlHash: "manual-reanalyze-stale-child",
        originalTitle: "旧拆分事件",
        summaryText: "旧拆分摘要",
        publishedAt: new Date("2026-04-10T09:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        summaryStatus: "succeeded",
        analysisStatus: "succeeded",
        qualityScore: 70,
        qualityRationale: "旧拆分",
        isAggregation: false,
      },
    });
    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "item_reanalyze",
        triggerType: "admin_action",
        status: "queued",
        label: "重新 AI 判定",
        entityId: parent.id,
      },
    });
    await executeItemReanalyzeTask(taskRun, {
      aiProvider: buildAiProviderMock({
        summaryFixture: vi.fn().mockResolvedValue({summary: "新的单条新闻摘要", isAggregation: false}),
        analysisFixture: vi.fn().mockResolvedValue({
          translatedTitle: "单条 AI 新闻",
          moderationStatus: "allowed",
          moderationReason: null,
          moderationDetail: null,
          qualityScore: 86,
          qualityRationale: "高质量",
          eventSignature: buildEventSignature({
            eventType: "launch",
            eventSubject: "OpenAI",
            eventAction: "发布",
            eventObject: "Toolkit",
          }),
        }),
        summarizeCluster: vi.fn().mockResolvedValue("重算后的聚合摘要"),
        matchClusterCandidate: vi.fn().mockResolvedValue(null),
      }),
    });

    const updatedParent = await prisma.item.findUniqueOrThrow({ where: { id: parent.id } });
    const retiredChild = await prisma.item.findUniqueOrThrow({ where: { id: staleChild.id } });
    const childCluster = await prisma.contentCluster.findUnique({
      where: { id: staleChildCluster.id },
    });

    expect(updatedParent).toMatchObject({
      isAggregation: false,
      aggregationParseStatus: "not_aggregation",
      summaryText: "新的单条新闻摘要",
      eventSubject: "OpenAI",
      eventObject: "Toolkit",
    });
    expect(retiredChild).toMatchObject({
      status: "filtered",
      moderationStatus: "filtered",
      filterReason: "reparsed_parent",
    });
    expect(childCluster).toBeNull();
  });

  it("preserves an existing aggregation when unified reanalysis has an invalid aggregation field", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Aggregation Source",
        rssUrl: "https://aggregation.example.com/feed.xml",
        siteUrl: "https://aggregation.example.com",
        enabled: true,
        aiParsingEnabled: true,
        aggregationDetectionEnabled: true,
      },
    });
    const parent = await prisma.item.create({
      data: {
        sourceId: source.id,
        originalUrl: "https://aggregation.example.com/roundup",
        canonicalUrl: "https://aggregation.example.com/roundup",
        urlHash: "manual-reanalyze-invalid-aggregation-parent",
        originalTitle: "AI roundup",
        summaryText: "旧聚合摘要",
        summaryStatus: "succeeded",
        analysisStatus: "succeeded",
        publishedAt: new Date("2026-04-10T09:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        qualityScore: 80,
        qualityRationale: "旧质量",
        fullText: "This roundup contains several independent AI product updates for developers.",
        isAggregation: true,
        aggregationParseStatus: "parsed",
      },
    });
    const child = await prisma.item.create({
      data: {
        sourceId: source.id,
        parentItemId: parent.id,
        originalUrl: "https://aggregation.example.com/roundup#event-existing",
        canonicalUrl: "https://aggregation.example.com/roundup",
        urlHash: "manual-reanalyze-invalid-aggregation-child",
        originalTitle: "已有拆分事件",
        summaryText: "已有拆分摘要",
        summaryStatus: "succeeded",
        analysisStatus: "succeeded",
        publishedAt: new Date("2026-04-10T09:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        qualityScore: 75,
        qualityRationale: "已有拆分",
      },
    });
    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "item_reanalyze",
        triggerType: "admin_action",
        status: "queued",
        label: "重新 AI 判定",
        entityId: parent.id,
      },
    });
    const understandItem = vi.fn().mockResolvedValue({
      summary: "新的有效摘要",
      translatedTitle: "AI 聚合更新",
      moderationStatus: "allowed",
      moderationReason: null,
      moderationDetail: null,
      qualityScore: 90,
      qualityRationale: "新分析有效",
      eventSignature: buildEventSignature({ eventSubject: "AI 行业" }),
      tags: ["AI"],
      aggregation: { isAggregation: false, mainEvent: null, events: [] },
      diagnostics: {
        summaryValid: true,
        analysisValid: true,
        aggregationValid: false,
      },
    });

    await executeItemReanalyzeTask(taskRun, {
      aiProvider: buildAiProviderMock({ understandItem }),
    });

    const [updatedParent, preservedChild, updatedTask] = await Promise.all([
      prisma.item.findUniqueOrThrow({ where: { id: parent.id } }),
      prisma.item.findUniqueOrThrow({ where: { id: child.id } }),
      prisma.backgroundTaskRun.findUniqueOrThrow({ where: { id: taskRun.id } }),
    ]);
    expect(updatedParent).toMatchObject({
      summaryText: "新的有效摘要",
      isAggregation: true,
      aggregationParseStatus: "failed",
      qualityScore: 80,
      qualityRationale: "旧质量",
    });
    expect(preservedChild.status).toBe("processed");
    expect(updatedTask).toMatchObject({
      status: "partial",
      errorSummary: expect.stringContaining("aggregation"),
    });
  });

  it("uses every cluster item summary and event signature when regenerating cluster summaries", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Example Feed",
        rssUrl: "https://example.com/feed.xml",
        siteUrl: "https://example.com",
        enabled: true,
        aiParsingEnabled: true,
      },
    });
    const cluster = await prisma.contentCluster.create({
      data: {
        id: "cluster-summary-task",
        kind: "topic",
        title: "OpenAI Toolkit",
        summary: "旧聚合摘要",
        score: 80,
        itemCount: 2,
        latestPublishedAt: new Date("2026-04-10T10:00:00.000Z"),
        status: "active",
        fingerprint: "openai-toolkit-summary",
      },
    });

    await prisma.item.createMany({
      data: [
        {
          id: "cluster-summary-item-1",
          sourceId: source.id,
          clusterId: cluster.id,
          originalUrl: "https://example.com/posts/cluster-1",
          canonicalUrl: "https://example.com/posts/cluster-1",
          urlHash: "cluster-summary-1",
          originalTitle: "Toolkit launch",
          translatedTitle: "工具包发布",
          summaryText: "内容一",
          publishedAt: new Date("2026-04-10T10:00:00.000Z"),
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 88,
          qualityRationale: "高质量",
          eventType: "launch",
          eventSubject: "OpenAI",
          eventAction: "发布",
          eventObject: "toolkit",
          eventDate: "2026-04-10",
          language: "en",
          fullText: "Cluster body one",
        },
        {
          id: "cluster-summary-item-2",
          sourceId: source.id,
          clusterId: cluster.id,
          originalUrl: "https://example.com/posts/cluster-2",
          canonicalUrl: "https://example.com/posts/cluster-2",
          urlHash: "cluster-summary-2",
          originalTitle: "Toolkit follow-up",
          translatedTitle: "工具包后续",
          summaryText: "内容二",
          publishedAt: new Date("2026-04-10T09:30:00.000Z"),
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 85,
          qualityRationale: "高质量",
          eventType: "launch",
          eventSubject: "OpenAI",
          eventAction: "补充",
          eventObject: "toolkit API",
          eventDate: "2026-04-10",
          language: "en",
          fullText: "Cluster body two",
        },
        {
          id: "cluster-summary-item-3",
          sourceId: source.id,
          clusterId: cluster.id,
          originalUrl: "https://example.com/posts/cluster-3",
          canonicalUrl: "https://example.com/posts/cluster-3",
          urlHash: "cluster-summary-3",
          originalTitle: "Toolkit pricing details",
          translatedTitle: "工具包价格细节",
          summaryText: "内容三",
          publishedAt: new Date("2026-04-10T09:00:00.000Z"),
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 83,
          qualityRationale: "高质量",
          eventType: "launch",
          eventSubject: "OpenAI",
          eventAction: "披露",
          eventObject: "toolkit pricing",
          eventDate: "2026-04-10",
          language: "en",
          fullText: "Cluster body three",
        },
        {
          id: "cluster-summary-item-4",
          sourceId: source.id,
          clusterId: cluster.id,
          originalUrl: "https://example.com/posts/cluster-4",
          canonicalUrl: "https://example.com/posts/cluster-4",
          urlHash: "cluster-summary-4",
          originalTitle: "Toolkit enterprise rollout",
          translatedTitle: "工具包企业版推广",
          summaryText: "内容四",
          publishedAt: new Date("2026-04-10T08:30:00.000Z"),
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 82,
          qualityRationale: "高质量",
          eventType: "launch",
          eventSubject: "OpenAI",
          eventAction: "上线",
          eventObject: "toolkit enterprise",
          eventDate: "2026-04-10",
          language: "en",
          fullText: "Cluster body four",
        },
      ],
    });

    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "cluster_regenerate_summary",
        triggerType: "admin_action",
        status: "queued",
        label: "重新生成聚合摘要",
        entityId: cluster.id,
      },
    });

    const summarizeCluster = vi.fn().mockResolvedValue("新的聚合摘要");

    await executeClusterSummaryTask(taskRun, {
      aiProvider: buildAiProviderMock({
        summarizeCluster,
        matchClusterCandidate: vi.fn().mockResolvedValue(null),
      }),
    });

    const storedTaskRun = await prisma.backgroundTaskRun.findUniqueOrThrow({
      where: { id: taskRun.id },
    });

    expect(storedTaskRun.status).toBe("succeeded");
    expect(storedTaskRun.aiCallCountActual).toBe(1);
    expect(storedTaskRun.aiCallCountEstimated).toBe(1);

    const summarySeed = summarizeCluster.mock.calls[0]?.[0] as string;
    expect(summarySeed).toContain("候选 1");
    expect(summarySeed).toContain("候选 4");
    expect(summarySeed).toContain("摘要：内容一");
    expect(summarySeed).toContain("摘要：内容四");
    expect(summarySeed).toContain("事件主体：OpenAI");
    expect(summarySeed).toContain("事件动作：上线");
    expect(summarySeed).toContain("关键对象：toolkit enterprise");

    const secondTaskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "cluster_regenerate_summary",
        triggerType: "admin_action",
        status: "queued",
        label: "重新生成聚合摘要",
        entityId: cluster.id,
      },
    });

    await executeClusterSummaryTask(secondTaskRun, {
      aiProvider: buildAiProviderMock({
        summarizeCluster,
        matchClusterCandidate: vi.fn().mockResolvedValue(null),
      }),
    });

    const storedCluster = await prisma.contentCluster.findUniqueOrThrow({
      where: { id: cluster.id },
    });
    const storedSecondTaskRun = await prisma.backgroundTaskRun.findUniqueOrThrow({
      where: { id: secondTaskRun.id },
    });

    expect(storedCluster.summaryInputHash).not.toBeNull();
    expect(summarizeCluster).toHaveBeenCalledTimes(2);
    expect(storedSecondTaskRun.aiCallCountActual).toBe(1);
  });

  it("rejects malformed cluster presentation JSON", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Example Feed",
        rssUrl: "https://example.com/feed.xml",
        siteUrl: "https://example.com",
        enabled: true,
        aiParsingEnabled: true,
      },
    });
    const cluster = await prisma.contentCluster.create({
      data: {
        id: "cluster-malformed-summary-json",
        kind: "topic",
        title: "旧聚合标题",
        summary: "旧聚合摘要",
        score: 80,
        itemCount: 2,
        latestPublishedAt: new Date("2026-04-21T10:00:00.000Z"),
        status: "active",
        fingerprint: "openai-gpt-image-2",
      },
    });

    await prisma.item.createMany({
      data: [
        {
          id: "cluster-malformed-summary-json-item-1",
          sourceId: source.id,
          clusterId: cluster.id,
          originalUrl: "https://example.com/posts/gpt-image-2-1",
          canonicalUrl: "https://example.com/posts/gpt-image-2-1",
          urlHash: "cluster-malformed-summary-json-1",
          originalTitle: "OpenAI launches GPT Image 2",
          translatedTitle: "OpenAI 上线 GPT Image 2",
          summaryText: "OpenAI 推出文生图模型 GPT Image 2。",
          publishedAt: new Date("2026-04-21T10:00:00.000Z"),
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 88,
          qualityRationale: "高质量",
          eventType: "launch",
          eventSubject: "OpenAI",
          eventAction: "上线",
          eventObject: "GPT Image 2",
          eventDate: "2026-04-21",
          language: "en",
          fullText: "Cluster body one",
        },
        {
          id: "cluster-malformed-summary-json-item-2",
          sourceId: source.id,
          clusterId: cluster.id,
          originalUrl: "https://example.com/posts/gpt-image-2-2",
          canonicalUrl: "https://example.com/posts/gpt-image-2-2",
          urlHash: "cluster-malformed-summary-json-2",
          originalTitle: "GPT Image 2 tops visual model benchmark",
          translatedTitle: "GPT Image 2 登顶视觉模型榜首",
          summaryText: "GPT Image 2 在视觉模型榜单中取得领先。",
          publishedAt: new Date("2026-04-21T09:00:00.000Z"),
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 86,
          qualityRationale: "高质量",
          eventType: "launch",
          eventSubject: "OpenAI",
          eventAction: "上线",
          eventObject: "GPT Image 2",
          eventDate: "2026-04-21",
          language: "en",
          fullText: "Cluster body two",
        },
      ],
    });

    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "cluster_regenerate_summary",
        triggerType: "admin_action",
        status: "queued",
        label: "重新生成聚合摘要",
        entityId: cluster.id,
      },
    });
    const summarizeCluster = vi.fn().mockResolvedValue(
      `{"title":"OpenAI 上线 GPT Image 2 登顶全球视觉模型榜首","summary":"OpenAI 于 *4 月 21 日* 正式推出文生图模型 **GPT Image 2**，并在权威评测中超越谷歌 **Nano Banana 2**，登顶全球视觉模型榜首。该模型有效解决文字"漂浮感"和乱码问题。"}`,
    );

    await executeClusterSummaryTask(taskRun, {
      aiProvider: buildAiProviderMock({
        summarizeCluster,
        matchClusterCandidate: vi.fn().mockResolvedValue(null),
      }),
    });

    const storedCluster = await prisma.contentCluster.findUniqueOrThrow({
      where: { id: cluster.id },
    });

    expect(storedCluster.title).toBe("OpenAI 上线 GPT Image 2");
    expect(storedCluster.summary).toContain("OpenAI 推出文生图模型 GPT Image 2");
    expect(storedCluster.summary).not.toContain('文字"漂浮感"和乱码问题');
  });

  it("keeps invalid unified aggregation results retryable", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Aggregation Source",
        rssUrl: "https://aggregation.example.com/feed.xml",
        siteUrl: "https://aggregation.example.com",
        enabled: true,
        aiParsingEnabled: true,
        aggregationDetectionEnabled: true,
      },
    });
    const candidate = await prisma.item.create({
      data: {
        sourceId: source.id,
        originalUrl: "https://aggregation.example.com/retry-invalid",
        canonicalUrl: "https://aggregation.example.com/retry-invalid",
        urlHash: "reparse-invalid-aggregation",
        originalTitle: "Potential roundup",
        publishedAt: new Date("2026-04-10T09:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        summaryText: "候选聚合内容",
        fullText: "This article contains enough text to run unified understanding but returns an invalid aggregation field.",
        isAggregation: false,
        aggregationParseStatus: "failed",
      },
    });
    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "item_reparse_aggregations",
        triggerType: "admin_action",
        status: "queued",
        label: "重新识别聚合内容",
      },
    });
    const understandItem = vi.fn().mockResolvedValue({
      summary: "有效摘要",
      translatedTitle: null,
      moderationStatus: "allowed",
      moderationReason: null,
      moderationDetail: null,
      qualityScore: 80,
      qualityRationale: "有效分析",
      eventSignature: buildEventSignature(),
      tags: [],
      aggregation: { isAggregation: false, mainEvent: null, events: [] },
      diagnostics: { summaryValid: true, analysisValid: true, aggregationValid: false },
    });

    await executeItemReparseAggregationsTask(taskRun, {
      aiProvider: buildAiProviderMock({ understandItem }),
    });

    const [updatedCandidate, updatedTask] = await Promise.all([
      prisma.item.findUniqueOrThrow({ where: { id: candidate.id } }),
      prisma.backgroundTaskRun.findUniqueOrThrow({ where: { id: taskRun.id } }),
    ]);
    expect(updatedCandidate.aggregationParseStatus).toBe("failed");
    expect(updatedTask.status).toBe("failed");
  });

  it("marks non-aggregation reparse candidates so they are not scanned repeatedly", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Aggregation Source",
        rssUrl: "https://aggregation.example.com/feed.xml",
        siteUrl: "https://aggregation.example.com",
        enabled: true,
        aiParsingEnabled: true,
        aggregationDetectionEnabled: true,
      },
    });
    await prisma.item.create({
      data: {
        sourceId: source.id,
        originalUrl: "https://aggregation.example.com/single",
        canonicalUrl: "https://aggregation.example.com/single",
        urlHash: "reparse-non-aggregation",
        originalTitle: "Single story",
        publishedAt: new Date("2026-04-10T09:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        summaryText: "单条新闻",
        fullText: "Only one event is present in this article, so the aggregation parser should classify it as not a roundup.",
        isAggregation: false,
      },
    });
    const aggregationFixture = vi.fn().mockResolvedValue({ mainEvent: null, events: [] });
    const firstTaskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "item_reparse_aggregations",
        triggerType: "admin_action",
        status: "queued",
        label: "聚合内容重拆",
      },
    });

    await executeItemReparseAggregationsTask(firstTaskRun, {
      aiProvider: buildAiProviderMock({ aggregationFixture }),
    });
    const secondTaskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "item_reparse_aggregations",
        triggerType: "admin_action",
        status: "queued",
        label: "聚合内容重拆",
      },
    });
    await executeItemReparseAggregationsTask(secondTaskRun, {
      aiProvider: buildAiProviderMock({ aggregationFixture }),
    });

    const item = await prisma.item.findFirstOrThrow();
    const storedSecondTaskRun = await prisma.backgroundTaskRun.findUniqueOrThrow({
      where: { id: secondTaskRun.id },
    });

    expect(aggregationFixture).toHaveBeenCalledTimes(1);
    expect(item.isAggregation).toBe(false);
    expect(item.aggregationParseStatus).toBe("not_aggregation");
    expect(item.aggregationCheckedAt).not.toBeNull();
    expect(storedSecondTaskRun.progressTotal).toBe(0);
  });

  it("persists reparse events even when the aggregation has no main event", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Aggregation Source",
        rssUrl: "https://aggregation.example.com/feed.xml",
        siteUrl: "https://aggregation.example.com",
        enabled: true,
        aiParsingEnabled: true,
        aggregationDetectionEnabled: true,
      },
    });
    const item = await prisma.item.create({
      data: {
        sourceId: source.id,
        originalUrl: "https://aggregation.example.com/roundup",
        canonicalUrl: "https://aggregation.example.com/roundup",
        urlHash: "reparse-no-main-event",
        originalTitle: "Roundup",
        publishedAt: new Date("2026-04-10T09:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        summaryText: "多条新闻",
        fullText: "OpenAI launches Toolkit. Anthropic updates Console.",
        isAggregation: false,
      },
    });
    const staleCluster = await prisma.contentCluster.create({
      data: {
        kind: "topic",
        title: "旧拆条聚合",
        summary: "旧拆条摘要",
        score: 70,
        itemCount: 1,
        latestPublishedAt: new Date("2026-04-10T08:00:00.000Z"),
        status: "active",
        fingerprint: "stale-child-cluster",
      },
    });
    const staleChild = await prisma.item.create({
      data: {
        sourceId: source.id,
        parentItemId: item.id,
        clusterId: staleCluster.id,
        originalUrl: "https://aggregation.example.com/roundup#event-stale",
        canonicalUrl: "https://aggregation.example.com/roundup",
        urlHash: "reparse-stale-child-url",
        originalTitle: "旧拆条事件",
        publishedAt: new Date("2026-04-10T08:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        summaryText: "旧拆条摘要",
        summaryStatus: "succeeded",
        analysisStatus: "succeeded",
        qualityScore: 70,
        qualityRationale: "旧拆条",
        isAggregation: false,
      },
    });
    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "item_reparse_aggregations",
        triggerType: "admin_action",
        status: "queued",
        label: "聚合内容重拆",
      },
    });

    const summarizeCluster = vi.fn().mockResolvedValue("聚合摘要");
    await executeItemReparseAggregationsTask(taskRun, {
      aiProvider: buildAiProviderMock({
        aggregationFixture: vi.fn().mockResolvedValue({
          mainEvent: null,
          events: [
            {
              eventType: "launch",
              eventSubject: "OpenAI",
              eventAction: "发布",
              eventObject: "Toolkit",
              eventDate: "2026-04-10",
              title: "OpenAI 推出 Toolkit",
              oneLiner: "OpenAI 发布 Toolkit",
              qualityScore: 92,
              sourceUrl: "https://aggregation.example.com/roundup/",
            },
          ],
        }),
        summarizeCluster,
      }),
    });

    const updatedItem = await prisma.item.findUniqueOrThrow({ where: { id: item.id } });
    const childItems = await prisma.item.findMany({ where: { parentItemId: item.id }, orderBy: { createdAt: "asc" } });
    const activeChildItems = childItems.filter((child) => child.status === "processed");
    const retiredChild = childItems.find((child) => child.id === staleChild.id);
    const activeChild = activeChildItems[0];
    const childCluster = activeChild?.clusterId
      ? await prisma.contentCluster.findUnique({ where: { id: activeChild.clusterId } })
      : null;

    expect(updatedItem.isAggregation).toBe(true);
    expect(updatedItem.aggregationParseStatus).toBe("parsed");
    expect(childItems).toHaveLength(2);
    expect(retiredChild).toMatchObject({
      status: "filtered",
      moderationStatus: "filtered",
      filterReason: "reparsed_parent",
      clusterId: staleCluster.id,
    });
    expect(activeChildItems).toHaveLength(1);
    expect(activeChild?.summaryText).toBe("OpenAI 发布 Toolkit");
    expect(activeChild?.originalTitle).toBe("OpenAI 推出 Toolkit");
    expect(activeChild?.parentItemId).toBe(item.id);
    expect(activeChild?.isAggregation).toBe(false);
    expect(activeChild?.originalUrl).toBe("https://aggregation.example.com/roundup");
    expect(summarizeCluster).not.toHaveBeenCalled();
    // Cluster is created at assignment time; itemCount refresh happens at the
    // batch-level cluster_finalize pass, which is not part of the reparse task.
    expect(childCluster).toMatchObject({
      eventSubject: "OpenAI",
      eventAction: "发布",
      eventObject: "Toolkit",
    });
  });

  it("retries failed aggregation parses using rss content when full text is unavailable", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Aggregation Source",
        rssUrl: "https://aggregation.example.com/feed.xml",
        siteUrl: "https://aggregation.example.com",
        enabled: true,
        aiParsingEnabled: true,
        aggregationDetectionEnabled: true,
      },
    });
    const item = await prisma.item.create({
      data: {
        sourceId: source.id,
        originalUrl: "https://aggregation.example.com/failed-roundup",
        canonicalUrl: "https://aggregation.example.com/failed-roundup",
        urlHash: "reparse-failed-rss-content",
        originalTitle: "Failed Roundup",
        publishedAt: new Date("2026-04-10T09:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        summaryText: "此前拆分失败的多条新闻",
        rssContent: `OpenAI launches <a href="https://tracking.tldrnewsletter.com/CL0/https:%2F%2Fopenai.com%2Ftoolkit%3Futm_source=tldrdev/1/test">Toolkit</a>. Anthropic updates Console. Mistral ships a model update.`,
        fullText: null,
        isAggregation: true,
        aggregationParseStatus: "failed",
      },
    });
    const aggregationFixture = vi.fn().mockResolvedValue({
      mainEvent: {
        eventType: "launch",
        eventSubject: "OpenAI",
        eventAction: "发布",
        eventObject: "Toolkit",
        eventDate: "2026-04-10",
      },
      events: [
        {
          eventType: "launch",
          eventSubject: "OpenAI",
          eventAction: "发布",
          eventObject: "Toolkit",
          eventDate: "2026-04-10",
          oneLiner: "OpenAI 发布 Toolkit",
          qualityScore: 92,
        },
      ],
    });
    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "item_reparse_aggregations",
        triggerType: "admin_action",
        status: "queued",
        label: "聚合内容重拆",
      },
    });

    const summarizeCluster = vi.fn().mockResolvedValue("聚合摘要");
    await executeItemReparseAggregationsTask(taskRun, {
      aiProvider: buildAiProviderMock({
        aggregationFixture,
        summarizeCluster,
      }),
    });

    const updatedItem = await prisma.item.findUniqueOrThrow({ where: { id: item.id } });
    const childItems = await prisma.item.findMany({ where: { parentItemId: item.id } });

    expect(aggregationFixture).toHaveBeenCalledWith(
      "OpenAI launches Toolkit (link: https://openai.com/toolkit?utm_source=tldrdev). Anthropic updates Console. Mistral ships a model update.",
      expect.objectContaining({ title: "Failed Roundup" }),
    );
    expect(updatedItem.isAggregation).toBe(true);
    expect(updatedItem.aggregationParseStatus).toBe("parsed");
    expect(childItems).toHaveLength(1);
    expect(summarizeCluster).not.toHaveBeenCalled();
  });
});
