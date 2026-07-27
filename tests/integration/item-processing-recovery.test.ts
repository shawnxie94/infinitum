
import { beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/db";
import { executeItemProcessingRecoveryTask } from "@/lib/items/processing-recovery";
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
      tags: ["OpenAI"],
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
    await prisma.itemTag.deleteMany();
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
});
