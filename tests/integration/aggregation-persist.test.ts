import { beforeEach, describe, expect, it } from "vitest";

import {
  persistAggregationChildItems,
  retireAggregationChildItems,
} from "@/lib/aggregation/persist";
import { prisma } from "@/lib/db";
import { getAggregationSplitParent } from "@/lib/feed/repository";

describe("aggregation child persistence", () => {
  beforeEach(async () => {
    await prisma.aggregationSplitLink.deleteMany();
    await prisma.itemEntity.deleteMany();
    await prisma.item.deleteMany();
    await prisma.entity.deleteMany();
    await prisma.contentCluster.deleteMany();
    await prisma.source.deleteMany();
  });

  it("reuses a stable child item across different aggregation parents while preserving split links", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Daily Roundup",
        rssUrl: "https://roundup.example.com/feed.xml",
        siteUrl: "https://roundup.example.com",
        enabled: true,
        aiParsingEnabled: true,
        aggregationDetectionEnabled: true,
      },
    });
    const firstParent = await prisma.item.create({
      data: {
        sourceId: source.id,
        originalUrl: "https://roundup.example.com/2026-04-10",
        canonicalUrl: "https://roundup.example.com/2026-04-10",
        urlHash: "roundup-parent-1",
        originalTitle: "2026-04-10 Daily",
        publishedAt: new Date("2026-04-10T08:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        summaryText: "Daily roundup",
        isAggregation: true,
        aggregationParseStatus: "parsed",
        aggregationCheckedAt: new Date("2026-04-10T09:00:00.000Z"),
      },
    });
    const secondParent = await prisma.item.create({
      data: {
        sourceId: source.id,
        originalUrl: "https://roundup.example.com/2026-04-11",
        canonicalUrl: "https://roundup.example.com/2026-04-11",
        urlHash: "roundup-parent-2",
        originalTitle: "2026-04-11 Daily",
        publishedAt: new Date("2026-04-11T08:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        summaryText: "Daily roundup",
        isAggregation: true,
        aggregationParseStatus: "parsed",
        aggregationCheckedAt: new Date("2026-04-11T09:00:00.000Z"),
      },
    });
    const repeatedEvent = {
      eventType: "acquisition",
      eventSubject: "SpaceX",
      eventAction: "收购",
      eventObject: "Cursor",
      eventDate: "2026-04-10",
      title: "SpaceX 收购 Cursor",
      oneLiner: "SpaceX 收购 Cursor 的消息被多期日报重复提及",
      qualityScore: 90,
      sourceUrl: "https://news.example.com/spacex-cursor",
    };

    const first = await persistAggregationChildItems({
      sourceId: source.id,
      parent: firstParent,
      publishedAt: firstParent.publishedAt,
      events: [repeatedEvent],
    });
    const second = await persistAggregationChildItems({
      sourceId: source.id,
      parent: secondParent,
      publishedAt: secondParent.publishedAt,
      events: [repeatedEvent],
    });

    expect(second.childItemIds).toEqual(first.childItemIds);
    expect(await prisma.item.count({ where: { parentItemId: { not: null } } })).toBe(1);
    expect(await prisma.aggregationSplitLink.count()).toBe(2);

    const firstDetail = await getAggregationSplitParent(firstParent.id);
    const secondDetail = await getAggregationSplitParent(secondParent.id);

    expect(firstDetail?.childCount).toBe(1);
    expect(secondDetail?.childCount).toBe(1);
    expect(firstDetail?.children?.[0]?.id).toBe(first.childItemIds[0]);
    expect(secondDetail?.children?.[0]?.id).toBe(first.childItemIds[0]);

    await expect(retireAggregationChildItems(firstParent.id)).resolves.toBe(0);
    const sharedChild = await prisma.item.findUniqueOrThrow({
      where: { id: first.childItemIds[0] },
    });
    expect(sharedChild.status).toBe("processed");
    expect(sharedChild.publishedAt.toISOString()).toBe("2026-04-11T08:00:00.000Z");
    expect(sharedChild.publishedAtKnown).toBe(true);
    expect(sharedChild.parentItemId).toBe(secondParent.id);
    expect(
      await prisma.aggregationSplitLink.count({
        where: { parentItemId: firstParent.id },
      }),
    ).toBe(0);
    expect(
      await prisma.aggregationSplitLink.count({
        where: { parentItemId: secondParent.id },
      }),
    ).toBe(1);
  });

  it("retires dropped child items with a clear moderation reason", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Retire Roundup",
        rssUrl: "https://retire-roundup.example.com/feed.xml",
        siteUrl: "https://retire-roundup.example.com",
        enabled: true,
        aiParsingEnabled: true,
        aggregationDetectionEnabled: true,
      },
    });
    const parent = await prisma.item.create({
      data: {
        sourceId: source.id,
        originalUrl: "https://retire-roundup.example.com/2026-04-10",
        canonicalUrl: "https://retire-roundup.example.com/2026-04-10",
        urlHash: "retire-roundup-parent",
        originalTitle: "2026-04-10 Retire Daily",
        publishedAt: new Date("2026-04-10T08:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        summaryText: "Daily roundup",
        isAggregation: true,
        aggregationParseStatus: "parsed",
        aggregationCheckedAt: new Date("2026-04-10T09:00:00.000Z"),
      },
    });
    const { childItemIds } = await persistAggregationChildItems({
      sourceId: source.id,
      parent,
      publishedAt: parent.publishedAt,
      events: [
        {
          eventType: "launch",
          eventSubject: "MiniMax",
          eventAction: "发布",
          eventObject: "H3",
          eventDate: "2026-04-10",
          title: "MiniMax 发布 H3",
          oneLiner: "MiniMax 发布 H3 视频生成模型",
          qualityScore: 85,
          sourceUrl: "https://news.example.com/minimax-h3",
        },
      ],
    });

    await expect(retireAggregationChildItems(parent.id)).resolves.toBe(1);

    const retired = await prisma.item.findUniqueOrThrow({
      where: { id: childItemIds[0] },
    });
    expect(retired.status).toBe("filtered");
    expect(retired.moderationStatus).toBe("filtered");
    expect(retired.moderationReason).toBe("other");
    expect(retired.moderationDetail).toBe("聚合重拆后下线：旧拆分结果已被新解析替换");
    expect(retired.filterReason).toBe("reparsed_parent");
  });

  it("persists entities derived from aggregation child event fields", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Tagged Roundup",
        rssUrl: "https://tagged-roundup.example.com/feed.xml",
        siteUrl: "https://tagged-roundup.example.com",
        enabled: true,
        aiParsingEnabled: true,
        aggregationDetectionEnabled: true,
      },
    });
    const parent = await prisma.item.create({
      data: {
        sourceId: source.id,
        originalUrl: "https://tagged-roundup.example.com/2026-04-10",
        canonicalUrl: "https://tagged-roundup.example.com/2026-04-10",
        urlHash: "tagged-roundup-parent",
        originalTitle: "2026-04-10 Tagged Daily",
        publishedAt: new Date("2026-04-10T08:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        summaryText: "Tagged daily roundup",
        isAggregation: true,
        aggregationParseStatus: "parsed",
        aggregationCheckedAt: new Date("2026-04-10T09:00:00.000Z"),
      },
    });

    const result = await persistAggregationChildItems({
      sourceId: source.id,
      parent,
      publishedAt: parent.publishedAt,
      events: [
        {
          eventType: "launch",
          eventSubject: "OpenAI",
          eventAction: "发布",
          eventObject: "Agent SDK",
          eventDate: "2026-04-10",
          title: "OpenAI 推出 Agent SDK",
          oneLiner: "OpenAI 发布 Agent SDK。",
          qualityScore: 92,
          sourceUrl: null,
        },
      ],
    });

    const child = await prisma.item.findUniqueOrThrow({
      where: { id: result.childItemIds[0] },
      include: {
        entities: {
          include: { entity: true },
        },
      },
    });

    const entityNames = child.entities.map((entry) => entry.entity.name);
    expect(entityNames).toHaveLength(2);
    expect(entityNames).toEqual(expect.arrayContaining([
      "OpenAI",
      "Agent SDK",
    ]));
  });

  it("auto-canonicalizes new entity variants across one aggregation batch", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Variant Tagged Roundup",
        rssUrl: "https://variant-tagged-roundup.example.com/feed.xml",
        siteUrl: "https://variant-tagged-roundup.example.com",
        enabled: true,
        aiParsingEnabled: true,
        aggregationDetectionEnabled: true,
      },
    });
    const parent = await prisma.item.create({
      data: {
        sourceId: source.id,
        originalUrl: "https://variant-tagged-roundup.example.com/2026-04-10",
        canonicalUrl: "https://variant-tagged-roundup.example.com/2026-04-10",
        urlHash: "variant-tagged-roundup-parent",
        originalTitle: "2026-04-10 Variant Tagged Daily",
        publishedAt: new Date("2026-04-10T08:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        summaryText: "Variant tagged daily roundup",
        isAggregation: true,
        aggregationParseStatus: "parsed",
        aggregationCheckedAt: new Date("2026-04-10T09:00:00.000Z"),
      },
    });

    await persistAggregationChildItems({
      sourceId: source.id,
      parent,
      publishedAt: parent.publishedAt,
      events: [
        {
          eventType: "launch",
          eventSubject: "OpenAI",
          eventAction: "发布",
          eventObject: "模型",
          eventDate: "2026-04-10",
          title: "OpenAI 发布模型",
          oneLiner: "OpenAI 发布新模型。",
          qualityScore: 92,
          sourceUrl: "https://news.example.com/openai-model",
        },
        {
          eventType: "launch",
          eventSubject: "Open AI",
          eventAction: "发布",
          eventObject: "工具",
          eventDate: "2026-04-10",
          title: "Open AI 发布工具",
          oneLiner: "Open AI 发布新工具。",
          qualityScore: 88,
          sourceUrl: "https://news.example.com/open-ai-tool",
        },
      ],
    });

    const entities = await prisma.entity.findMany({
      include: {
        aliases: true,
        items: true,
      },
    });

    expect(entities).toHaveLength(1);
    expect(entities[0]?.normalized).toBe("openai");
    expect(entities[0]?.items).toHaveLength(2);
    expect(entities[0]?.aliases.map((alias) => alias.aliasNormalized)).toEqual(["open ai"]);
  });

  it("allows one parent to link events with the same semantic fingerprint when source urls differ", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Daily Roundup",
        rssUrl: "https://roundup.example.com/feed.xml",
        siteUrl: "https://roundup.example.com",
        enabled: true,
        aiParsingEnabled: true,
        aggregationDetectionEnabled: true,
      },
    });
    const parent = await prisma.item.create({
      data: {
        sourceId: source.id,
        originalUrl: "https://roundup.example.com/2026-04-12",
        canonicalUrl: "https://roundup.example.com/2026-04-12",
        urlHash: "roundup-parent-3",
        originalTitle: "2026-04-12 Daily",
        publishedAt: new Date("2026-04-12T08:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        summaryText: "Daily roundup",
        isAggregation: true,
        aggregationParseStatus: "parsed",
        aggregationCheckedAt: new Date("2026-04-12T09:00:00.000Z"),
      },
    });

    const result = await persistAggregationChildItems({
      sourceId: source.id,
      parent,
      publishedAt: parent.publishedAt,
      events: [
        {
          eventType: "funding",
          eventSubject: "Acme",
          eventAction: "融资",
          eventObject: "B轮",
          eventDate: "2026-04-12",
          title: "Acme 完成 B 轮融资",
          oneLiner: "Acme 完成 B 轮融资",
          qualityScore: 86,
          sourceUrl: "https://news.example.com/acme-series-b",
        },
        {
          eventType: "funding",
          eventSubject: "Acme",
          eventAction: "融资",
          eventObject: "B轮",
          eventDate: "2026-04-12",
          title: "Acme B 轮融资后续报道",
          oneLiner: "Acme B 轮融资有后续报道",
          qualityScore: 84,
          sourceUrl: "https://another.example.com/acme-funding-followup",
        },
      ],
    });

    expect(new Set(result.childItemIds).size).toBe(2);
    expect(await prisma.aggregationSplitLink.count({ where: { parentItemId: parent.id } })).toBe(2);

    const links = await prisma.aggregationSplitLink.findMany({
      where: { parentItemId: parent.id },
      orderBy: { eventIndex: "asc" },
      select: { fingerprint: true },
    });
    expect(links[0]?.fingerprint).toBe(links[1]?.fingerprint);
  });

  it("dedupes independent source urls without relying on AI-derived fingerprints", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Daily Roundup",
        rssUrl: "https://roundup.example.com/feed.xml",
        siteUrl: "https://roundup.example.com",
        enabled: true,
        aiParsingEnabled: true,
        aggregationDetectionEnabled: true,
      },
    });
    const firstParent = await prisma.item.create({
      data: {
        sourceId: source.id,
        originalUrl: "https://roundup.example.com/2026-04-13",
        canonicalUrl: "https://roundup.example.com/2026-04-13",
        urlHash: "roundup-parent-4",
        originalTitle: "2026-04-13 Daily",
        publishedAt: new Date("2026-04-13T08:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        summaryText: "Daily roundup",
        isAggregation: true,
        aggregationParseStatus: "parsed",
        aggregationCheckedAt: new Date("2026-04-13T09:00:00.000Z"),
      },
    });
    const secondParent = await prisma.item.create({
      data: {
        sourceId: source.id,
        originalUrl: "https://roundup.example.com/2026-04-14",
        canonicalUrl: "https://roundup.example.com/2026-04-14",
        urlHash: "roundup-parent-5",
        originalTitle: "2026-04-14 Daily",
        publishedAt: new Date("2026-04-14T08:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        summaryText: "Daily roundup",
        isAggregation: true,
        aggregationParseStatus: "parsed",
        aggregationCheckedAt: new Date("2026-04-14T09:00:00.000Z"),
      },
    });
    const sourceUrl = "https://news.example.com/acme-series-b";

    const first = await persistAggregationChildItems({
      sourceId: source.id,
      parent: firstParent,
      publishedAt: firstParent.publishedAt,
      events: [
        {
          eventType: "funding",
          eventSubject: "Acme",
          eventAction: "融资",
          eventObject: "B轮",
          eventDate: "2026-04-13",
          title: "Acme 完成 B 轮融资",
          oneLiner: "Acme 完成 B 轮融资",
          qualityScore: 86,
          sourceUrl,
        },
        {
          eventType: "product",
          eventSubject: "Acme",
          eventAction: "发布",
          eventObject: "新平台",
          eventDate: "2026-04-13",
          title: "Acme 发布新平台",
          oneLiner: "同一篇原文被 AI 拆成另一条事件",
          qualityScore: 83,
          sourceUrl,
        },
      ],
    });
    const second = await persistAggregationChildItems({
      sourceId: source.id,
      parent: secondParent,
      publishedAt: secondParent.publishedAt,
      events: [
        {
          eventType: "financing",
          eventSubject: "Acme Inc.",
          eventAction: "获投",
          eventObject: "Series B",
          eventDate: "2026-04-14",
          title: "Acme Inc. 获得 Series B 投资",
          oneLiner: "同一原文在下一期被 AI 抽成略不同字段",
          qualityScore: 88,
          sourceUrl,
        },
      ],
    });

    expect(first.childItemIds).toHaveLength(1);
    expect(second.childItemIds).toEqual(first.childItemIds);
    expect(await prisma.item.count({ where: { parentItemId: { not: null } } })).toBe(1);
    expect(await prisma.aggregationSplitLink.count()).toBe(2);
  });

  it("removes stale split links when the same parent is persisted again", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Daily Roundup",
        rssUrl: "https://roundup.example.com/feed.xml",
        siteUrl: "https://roundup.example.com",
        enabled: true,
        aiParsingEnabled: true,
        aggregationDetectionEnabled: true,
      },
    });
    const parent = await prisma.item.create({
      data: {
        sourceId: source.id,
        originalUrl: "https://roundup.example.com/2026-04-15",
        canonicalUrl: "https://roundup.example.com/2026-04-15",
        urlHash: "roundup-parent-6",
        originalTitle: "2026-04-15 Daily",
        publishedAt: new Date("2026-04-15T08:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        summaryText: "Daily roundup",
        isAggregation: true,
        aggregationParseStatus: "parsed",
        aggregationCheckedAt: new Date("2026-04-15T09:00:00.000Z"),
      },
    });

    await persistAggregationChildItems({
      sourceId: source.id,
      parent,
      publishedAt: parent.publishedAt,
      events: [
        {
          eventType: "funding",
          eventSubject: "Acme",
          eventAction: "融资",
          eventObject: "B轮",
          eventDate: "2026-04-15",
          title: "Acme 完成 B 轮融资",
          oneLiner: "Acme 完成 B 轮融资",
          qualityScore: 86,
          sourceUrl: "https://news.example.com/acme-series-b",
        },
        {
          eventType: "launch",
          eventSubject: "Beta",
          eventAction: "发布",
          eventObject: "平台",
          eventDate: "2026-04-15",
          title: "Beta 发布平台",
          oneLiner: "Beta 发布平台",
          qualityScore: 82,
          sourceUrl: "https://news.example.com/beta-platform",
        },
      ],
    });

    const second = await persistAggregationChildItems({
      sourceId: source.id,
      parent,
      publishedAt: parent.publishedAt,
      events: [
        {
          eventType: "funding",
          eventSubject: "Acme Inc.",
          eventAction: "获投",
          eventObject: "Series B",
          eventDate: "2026-04-16",
          title: "Acme Inc. 获得 Series B 投资",
          oneLiner: "同一原文在重跑时被 AI 抽成略不同字段",
          qualityScore: 88,
          sourceUrl: "https://news.example.com/acme-series-b",
        },
        {
          eventType: "product",
          eventSubject: "Acme",
          eventAction: "发布",
          eventObject: "新平台",
          eventDate: "2026-04-16",
          title: "Acme 发布新平台",
          oneLiner: "同一篇原文被 AI 重复拆出",
          qualityScore: 83,
          sourceUrl: "https://news.example.com/acme-series-b",
        },
      ],
    });

    expect(second.childItemIds).toHaveLength(1);
    const links = await prisma.aggregationSplitLink.findMany({
      where: { parentItemId: parent.id },
      orderBy: { eventIndex: "asc" },
      select: { eventIndex: true, sourceUrl: true },
    });
    expect(links).toEqual([
      {
        eventIndex: 0,
        sourceUrl: "https://news.example.com/acme-series-b",
      },
    ]);
  });
});
