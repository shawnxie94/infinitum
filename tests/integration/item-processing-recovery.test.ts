
import { beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/db";
import { executeItemProcessingRecoveryTask } from "@/lib/items/processing-recovery";
import { reanalyzeItem } from "@/lib/items/service";
import { buildAiProviderMock, buildEventSignature } from "../helpers/ai-provider";
import type { AiProvider } from "@/lib/ai/provider";

function buildUnderstandingProvider(overrides: {
  summary: string;
  summaryValid?: boolean;
  analysisValid?: boolean;
  aggregationValid?: boolean;
  isAggregation?: boolean;
  events?: Array<Record<string, unknown>>;
  eventSignature?: ReturnType<typeof buildEventSignature>;
}): AiProvider {
  return buildAiProviderMock({
    understandItem: vi.fn().mockResolvedValue({
      translatedTitle: null,
      moderationStatus: "allowed",
      moderationReason: null,
      moderationDetail: null,
      qualityScore: 82,
      qualityRationale: "recovery mock",
      eventSignature: overrides.eventSignature ?? buildEventSignature({
        eventType: "launch",
        eventSubject: "OpenAI",
        eventAction: "发布",
        eventObject: "Toolkit",
        eventDate: "2026-04-10",
      }),
      entities: ["OpenAI"],
      summary: overrides.summary,
      aggregation: {
        isAggregation: Boolean(overrides.isAggregation),
        mainEvent: null,
        events: overrides.events ?? [],
      },
      diagnostics: {
        summaryValid: overrides.summaryValid ?? true,
        analysisValid: overrides.analysisValid ?? true,
        aggregationValid: overrides.aggregationValid ?? true,
      },
    }),
  });
}

describe("item processing recovery task", () => {
  beforeEach(async () => {
    await prisma.itemEntity.deleteMany();
    await prisma.item.deleteMany();
    await prisma.contentCluster.deleteMany();
    await prisma.backgroundTaskRun.deleteMany();
    await prisma.source.deleteMany();
  });

  it("reanalyzes failed items outside rss reuse and clears retry state on success", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Recovery Feed",
        rssUrl: "https://recovery.example.com/feed.xml",
        siteUrl: "https://recovery.example.com",
        enabled: true,
        aiParsingEnabled: true,
        aggregationDetectionEnabled: false,
      },
    });

    await prisma.item.create({
      data: {
        id: "failed-summary-item",
        sourceId: source.id,
        originalUrl: "https://recovery.example.com/posts/1",
        canonicalUrl: "https://recovery.example.com/posts/1",
        urlHash: "failed-summary-item",
        originalTitle: "Broken summary story",
        publishedAt: new Date("2026-04-10T09:00:00.000Z"),
        rssExcerpt: "Enough source text for recovery reanalyze path.",
        fullText: "Enough source text for recovery reanalyze path with more body content.",
        status: "processed",
        summaryStatus: "failed",
        analysisStatus: "failed",
        moderationStatus: "allowed",
        qualityScore: 50,
        qualityRationale: "previous failure",
        processingAttemptCount: 0,
        nextProcessingRetryAt: new Date("2026-04-10T09:30:00.000Z"),
        lastProcessingError: "summary_failed,analysis_failed",
      },
    });

    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "item_processing_recovery",
        triggerType: "manual",
        status: "queued",
        label: "抓取失败补偿",
      },
    });

    await executeItemProcessingRecoveryTask(taskRun, {
      aiProvider: buildUnderstandingProvider({
        summary: "恢复后的摘要内容，足够短且有效。",
      }),
      now: new Date("2026-04-10T10:00:00.000Z"),
    });

    const item = await prisma.item.findUniqueOrThrow({ where: { id: "failed-summary-item" } });
    const finishedTask = await prisma.backgroundTaskRun.findUniqueOrThrow({ where: { id: taskRun.id } });

    expect(item.summaryStatus).toBe("succeeded");
    expect(item.analysisStatus).toBe("succeeded");
    expect(item.summaryText).toContain("恢复后的摘要");
    expect(item.nextProcessingRetryAt).toBeNull();
    expect(item.lastProcessingError).toBeNull();
    expect(item.processingAttemptCount).toBe(0);
    expect(item.clusterId).toBeTruthy();
    expect(finishedTask.status).toBe("succeeded");
  });

  it("degrades exhausted aggregation failures into regular visible items", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Aggregation Recovery Feed",
        rssUrl: "https://agg-recovery.example.com/feed.xml",
        siteUrl: "https://agg-recovery.example.com",
        enabled: true,
        aiParsingEnabled: true,
        aggregationDetectionEnabled: true,
        aggregationEnabled: true,
      },
    });

    await prisma.item.create({
      data: {
        id: "agg-failed-parent",
        sourceId: source.id,
        originalUrl: "https://agg-recovery.example.com/roundup",
        canonicalUrl: "https://agg-recovery.example.com/roundup",
        urlHash: "agg-failed-parent",
        originalTitle: "Weekly roundup",
        publishedAt: new Date("2026-04-10T09:00:00.000Z"),
        rssContent: "A long enough weekly roundup body for recovery parsing attempts.",
        fullText: "A long enough weekly roundup body for recovery parsing attempts with details.",
        status: "processed",
        summaryStatus: "succeeded",
        summaryText: "这是聚合简报。",
        analysisStatus: "succeeded",
        moderationStatus: "allowed",
        isAggregation: true,
        aggregationParseStatus: "failed",
        qualityScore: 70,
        qualityRationale: "aggregation failed",
        processingAttemptCount: 2,
        nextProcessingRetryAt: new Date("2026-04-10T09:30:00.000Z"),
        lastProcessingError: "aggregation_retriable",
        eventType: "other",
        eventSubject: "Roundup",
        eventAction: "汇总",
        eventObject: "AI",
        eventDate: "2026-04-10",
      },
    });

    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "item_processing_recovery",
        triggerType: "manual",
        status: "queued",
        label: "抓取失败补偿",
      },
    });

    await executeItemProcessingRecoveryTask(taskRun, {
      aiProvider: buildUnderstandingProvider({
        summary: "仍然是一篇聚合简报。",
        isAggregation: true,
        aggregationValid: false,
        events: [],
        eventSignature: buildEventSignature({
          eventType: "other",
          eventSubject: "Roundup",
          eventAction: "汇总",
          eventObject: "AI",
          eventDate: "2026-04-10",
        }),
      }),
      now: new Date("2026-04-10T10:00:00.000Z"),
    });

    const item = await prisma.item.findUniqueOrThrow({ where: { id: "agg-failed-parent" } });
expect(item.isAggregation).toBe(false);
    expect(item.aggregationParseStatus).toBe("failed");
    expect(item.nextProcessingRetryAt).toBeNull();
    expect(item.clusterId).toBeTruthy();
  });

  it("regenerates only the summary for aggregation parents with live split children", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Split Recovery Feed",
        rssUrl: "https://split-recovery.example.com/feed.xml",
        siteUrl: "https://split-recovery.example.com",
        enabled: true,
        aiParsingEnabled: true,
        aggregationDetectionEnabled: true,
      },
    });
    const parent = await prisma.item.create({
      data: {
        id: "split-parent",
        sourceId: source.id,
        originalUrl: "https://split-recovery.example.com/roundup",
        canonicalUrl: "https://split-recovery.example.com/roundup",
        urlHash: "split-parent",
        originalTitle: "聚合日报",
        publishedAt: new Date("2026-04-10T09:00:00.000Z"),
        rssExcerpt: "Enough source text for recovery regeneration path.",
        fullText: "Enough source text for recovery regeneration path with more body content.",
        status: "processed",
        summaryStatus: "failed",
        analysisStatus: "succeeded",
        moderationStatus: "allowed",
        qualityScore: 70,
        qualityRationale: "由聚合内容拆出",
        isAggregation: true,
        aggregationParseStatus: "parsed",
        processingAttemptCount: 0,
        nextProcessingRetryAt: new Date("2026-04-10T09:30:00.000Z"),
        lastProcessingError: "summary_failed",
      },
    });
    const child = await prisma.item.create({
      data: {
        id: "split-child",
        sourceId: source.id,
        originalUrl: "https://news.example.com/child",
        canonicalUrl: "https://news.example.com/child",
        urlHash: "split-child",
        originalTitle: "拆分子事件",
        publishedAt: new Date("2026-04-10T09:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        parentItemId: parent.id,
      },
    });
    await prisma.aggregationSplitLink.create({
      data: {
        parentItemId: parent.id,
        childItemId: child.id,
        eventIndex: 0,
        fingerprint: "split-child-fingerprint",
        oneLiner: "拆分子事件摘要",
      },
    });

    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "item_processing_recovery",
        triggerType: "manual",
        status: "queued",
        label: "抓取失败补偿",
      },
    });

    await executeItemProcessingRecoveryTask(taskRun, {
      aiProvider: buildUnderstandingProvider({
        summary: "恢复后的聚合摘要，足够短且有效。",
        isAggregation: true,
      }),
      now: new Date("2026-04-10T10:00:00.000Z"),
    });

    const updatedParent = await prisma.item.findUniqueOrThrow({
      where: { id: parent.id },
    });
    const updatedChild = await prisma.item.findUniqueOrThrow({
      where: { id: child.id },
    });
    const finishedTask = await prisma.backgroundTaskRun.findUniqueOrThrow({
      where: { id: taskRun.id },
    });

    expect(updatedParent.summaryStatus).toBe("succeeded");
    expect(updatedParent.summaryText).toContain("恢复后的聚合摘要");
    expect(updatedParent.isAggregation).toBe(true);
    expect(updatedParent.aggregationParseStatus).toBe("parsed");
    expect(updatedChild.status).toBe("processed");
    expect(updatedChild.moderationStatus).toBe("allowed");
    expect(updatedChild.filterReason).toBeNull();
    expect(
      await prisma.aggregationSplitLink.count({
        where: { parentItemId: parent.id },
      }),
    ).toBe(1);
    expect(finishedTask.status).toBe("succeeded");
  });

  it("keeps live split children when reanalysis fails to confirm aggregation", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Split Reanalyze Feed",
        rssUrl: "https://split-reanalyze.example.com/feed.xml",
        siteUrl: "https://split-reanalyze.example.com",
        enabled: true,
        aiParsingEnabled: true,
        aggregationDetectionEnabled: true,
      },
    });
    const parent = await prisma.item.create({
      data: {
        id: "reanalyze-split-parent",
        sourceId: source.id,
        originalUrl: "https://split-reanalyze.example.com/roundup",
        canonicalUrl: "https://split-reanalyze.example.com/roundup",
        urlHash: "reanalyze-split-parent",
        originalTitle: "聚合日报",
        publishedAt: new Date("2026-04-10T09:00:00.000Z"),
        rssExcerpt: "Enough source text for reanalysis path.",
        fullText: "Enough source text for reanalysis path with more body content.",
        status: "processed",
        summaryStatus: "succeeded",
        analysisStatus: "succeeded",
        moderationStatus: "allowed",
        qualityScore: 70,
        qualityRationale: "由聚合内容拆出",
        isAggregation: true,
        aggregationParseStatus: "parsed",
      },
    });
    const child = await prisma.item.create({
      data: {
        id: "reanalyze-split-child",
        sourceId: source.id,
        originalUrl: "https://news.example.com/reanalyze-child",
        canonicalUrl: "https://news.example.com/reanalyze-child",
        urlHash: "reanalyze-split-child",
        originalTitle: "拆分子事件",
        publishedAt: new Date("2026-04-10T09:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        parentItemId: parent.id,
      },
    });
    await prisma.aggregationSplitLink.create({
      data: {
        parentItemId: parent.id,
        childItemId: child.id,
        eventIndex: 0,
        fingerprint: "reanalyze-split-child-fingerprint",
        oneLiner: "拆分子事件摘要",
      },
    });

    await reanalyzeItem(parent.id, {
      aiProvider: buildUnderstandingProvider({
        summary: "重分析后的有效摘要",
        aggregationValid: false,
        isAggregation: false,
      }),
    });

    const updatedParent = await prisma.item.findUniqueOrThrow({
      where: { id: parent.id },
    });
    const updatedChild = await prisma.item.findUniqueOrThrow({
      where: { id: child.id },
    });

    expect(updatedParent.isAggregation).toBe(true);
    expect(updatedParent.aggregationParseStatus).toBe("parsed");
    expect(updatedParent.summaryText).toContain("重分析后的有效摘要");
    expect(updatedParent.errorMessage).toContain("保留现有拆分");
    expect(updatedChild.moderationStatus).toBe("allowed");
    expect(updatedChild.status).toBe("processed");
    expect(
      await prisma.aggregationSplitLink.count({
        where: { parentItemId: parent.id },
      }),
    ).toBe(1);
  });

  it("bounded retries when summary regeneration fails for a split parent", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Split Retry Feed",
        rssUrl: "https://split-retry.example.com/feed.xml",
        siteUrl: "https://split-retry.example.com",
        enabled: true,
        aiParsingEnabled: true,
        aggregationDetectionEnabled: true,
      },
    });
    const parent = await prisma.item.create({
      data: {
        id: "split-retry-parent",
        sourceId: source.id,
        originalUrl: "https://split-retry.example.com/roundup",
        canonicalUrl: "https://split-retry.example.com/roundup",
        urlHash: "split-retry-parent",
        originalTitle: "聚合日报",
        publishedAt: new Date("2026-04-10T09:00:00.000Z"),
        rssExcerpt: "Enough source text for recovery retry path.",
        fullText: "Enough source text for recovery retry path with more body content.",
        status: "processed",
        summaryStatus: "failed",
        analysisStatus: "succeeded",
        moderationStatus: "allowed",
        qualityScore: 70,
        qualityRationale: "由聚合内容拆出",
        isAggregation: true,
        aggregationParseStatus: "parsed",
        processingAttemptCount: 0,
        nextProcessingRetryAt: new Date("2026-04-10T09:30:00.000Z"),
        lastProcessingError: "summary_failed",
      },
    });
    const child = await prisma.item.create({
      data: {
        id: "split-retry-child",
        sourceId: source.id,
        originalUrl: "https://news.example.com/split-retry-child",
        canonicalUrl: "https://news.example.com/split-retry-child",
        urlHash: "split-retry-child",
        originalTitle: "拆分子事件",
        publishedAt: new Date("2026-04-10T09:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        parentItemId: parent.id,
      },
    });
    await prisma.aggregationSplitLink.create({
      data: {
        parentItemId: parent.id,
        childItemId: child.id,
        eventIndex: 0,
        fingerprint: "split-retry-child-fingerprint",
        oneLiner: "拆分子事件摘要",
      },
    });

    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "item_processing_recovery",
        triggerType: "manual",
        status: "queued",
        label: "抓取失败补偿",
      },
    });

    await executeItemProcessingRecoveryTask(taskRun, {
      aiProvider: buildUnderstandingProvider({
        summary: "无效摘要",
        summaryValid: false,
        isAggregation: true,
      }),
      now: new Date("2026-04-10T10:00:00.000Z"),
    });

    const updatedParent = await prisma.item.findUniqueOrThrow({
      where: { id: parent.id },
    });

    expect(updatedParent.summaryStatus).toBe("failed");
    expect(updatedParent.processingAttemptCount).toBe(1);
    expect(updatedParent.nextProcessingRetryAt).not.toBeNull();
    expect(updatedParent.lastProcessingError).toContain("summary_failed");
    expect(updatedParent.aggregationParseStatus).toBe("parsed");
    expect(updatedParent.isAggregation).toBe(true);
    expect(
      await prisma.aggregationSplitLink.count({
        where: { parentItemId: parent.id },
      }),
    ).toBe(1);
  });
});
