
import { beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/db";
import { reanalyzeItem } from "@/lib/items/service";
import { buildAiProviderMock, buildEventSignature } from "../helpers/ai-provider";
import type { AiProvider } from "@/lib/ai/provider-types";

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
});
