import { beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/db";
import {
  enqueueItemReanalyzeTask,
  enqueueItemRegenerationTask,
  regenerateItemContent,
} from "@/lib/items/service";
import { replaceItemEntities } from "@/lib/entities/service";
import { buildAiProviderMock, buildEventSignature } from "../helpers/ai-provider";

describe("regenerateItemContent", () => {
  beforeEach(async () => {
    await prisma.item.deleteMany();
    await prisma.entity.deleteMany();
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

  it("preserves item entities when only the summary is regenerated", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Example Feed",
        rssUrl: "https://example.com/feed-summary-entities.xml",
        siteUrl: "https://example.com",
        enabled: true,
        aiParsingEnabled: true,
      },
    });
    const item = await prisma.item.create({
      data: {
        sourceId: source.id,
        originalUrl: "https://example.com/posts/summary-entities",
        canonicalUrl: "https://example.com/posts/summary-entities",
        urlHash: "hash-summary-entities",
        originalTitle: "OpenAI launches a benchmark",
        translatedTitle: "现有中文标题",
        summaryText: "现有摘要",
        publishedAt: new Date("2026-04-10T09:30:00.000Z"),
        status: "processed",
        language: "en",
        fullText: "A full text body used for summarization",
      },
    });
    await replaceItemEntities(item.id, ["OpenAI", "Benchmark"]);

    await regenerateItemContent(item.id, "summary", {
      aiProvider: buildAiProviderMock({
        summaryFixture: vi.fn().mockResolvedValue({summary: "新的摘要内容", isAggregation: false}),
        summarizeCluster: vi.fn().mockResolvedValue("聚合摘要"),
        matchClusterCandidate: vi.fn().mockResolvedValue(null),
      }),
    });

    const storedTags = await prisma.itemEntity.findMany({
      where: { itemId: item.id },
      include: { entity: true },
      orderBy: { createdAt: "asc" },
    });
    expect(storedTags.map((entry) => entry.entity.normalized)).toEqual(["openai", "benchmark"]);
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
});
