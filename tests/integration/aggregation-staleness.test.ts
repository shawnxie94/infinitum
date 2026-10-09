import { beforeEach, describe, expect, it, vi } from "vitest";

import { filterStaleAggregationChildren } from "@/lib/aggregation/staleness";
import { prisma } from "@/lib/db";
import { reanalyzeItem } from "@/lib/items/service";
import { processFeedItem } from "@/lib/ingestion/item-processor";
import { createClusterAssignmentCoordinator } from "@/lib/clusters/helpers";
import { recomputeCluster } from "@/lib/clusters/service";
import { listFeedItems } from "@/lib/feed/repository";
import { getCachedFeedItems } from "@/lib/feed/service";
import { resolveFeedFilters } from "@/lib/feed/range";
import { buildAiProviderMock, buildEventSignature } from "../helpers/ai-provider";

const baseline = new Date("2026-10-08T12:00:00.000Z");

function regularProvider() {
  return buildAiProviderMock({
    summaryFixture: vi.fn().mockResolvedValue({ summary: "当前日报摘要", isAggregation: false }),
    analysisFixture: vi.fn().mockResolvedValue({
      translatedTitle: null,
      moderationStatus: "allowed",
      moderationReason: null,
      moderationDetail: null,
      qualityScore: 85,
      qualityRationale: "test",
      eventSignature: buildEventSignature({
        eventType: "update", eventSubject: "当前进展", eventAction: "更新", eventObject: "日报", eventDate: "2026-10-08",
      }),
    }),
  });
}

function aggregationProvider() {
  return buildAiProviderMock({
    summaryFixture: vi.fn().mockResolvedValue({ summary: "当前日报，包含 2024 年 3 月 15 日事件的后续进展。", isAggregation: true }),
    analysisFixture: vi.fn().mockResolvedValue({
      translatedTitle: null,
      moderationStatus: "allowed",
      moderationReason: null,
      moderationDetail: null,
      qualityScore: 85,
      qualityRationale: "test",
      eventSignature: buildEventSignature({
        eventType: "update",
        eventSubject: "当前进展",
        eventAction: "更新",
        eventObject: "日报",
        eventDate: "2026-10-08",
      }),
    }),
    aggregationFixture: vi.fn().mockResolvedValue({
      mainEvent: buildEventSignature({ eventType: "update", eventDate: "2026-10-08" }),
      events: [
        {
          eventType: "launch", eventSubject: "旧事件", eventAction: "发布", eventObject: "旧产品",
          eventDate: "2024-03-15", title: "旧事件发布旧产品", oneLiner: "2024 年 3 月 15 日旧事件。",
          qualityScore: 80, sourceUrl: "https://events.example.test/old",
        },
        {
          eventType: "launch", eventSubject: "新事件", eventAction: "发布", eventObject: "新产品",
          eventDate: "2026-10-08", title: "新事件发布新产品", oneLiner: "新事件今天发布。",
          qualityScore: 85, sourceUrl: "https://events.example.test/new",
        },
        {
          eventType: "update", eventSubject: "未知日期事件", eventAction: "更新", eventObject: "项目",
          eventDate: null, title: "未知日期事件更新项目", oneLiner: "正文没有明确日期。",
          qualityScore: 70, sourceUrl: "https://events.example.test/unknown",
        },
      ],
    }),
  });
}

describe("aggregation child stale filtering end-to-end", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await prisma.aggregationSplitLink.deleteMany();
    await prisma.itemEntity.deleteMany();
    await prisma.item.deleteMany();
    await prisma.contentCluster.deleteMany();
    await prisma.source.deleteMany();
  });

  it("re-evaluates mixed split children after successful reanalysis and hides stale children from feed", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Staleness aggregation",
        rssUrl: "https://events.example.test/feed.xml",
        siteUrl: "https://events.example.test",
        enabled: true,
        aiParsingEnabled: true,
        aggregationDetectionEnabled: true,
      },
    });
    const parent = await prisma.item.create({
      data: {
        sourceId: source.id,
        originalUrl: "https://events.example.test/daily",
        canonicalUrl: "https://events.example.test/daily",
        urlHash: "staleness-parent",
        originalTitle: "当前日报",
        rssContent: "当前内容回顾 2024 年 3 月 15 日旧事件，并介绍 2026 年 10 月 8 日新进展。",
        publishedAt: baseline,
        status: "processed",
        moderationStatus: "allowed",
        summaryText: "旧摘要",
        isAggregation: true,
        aggregationParseStatus: "parsed",
      },
    });
    const preexistingChild = await prisma.item.create({
      data: {
        sourceId: source.id,
        originalUrl: "https://events.example.test/preexisting-old",
        canonicalUrl: "https://events.example.test/preexisting-old",
        urlHash: "staleness-preexisting-child",
        originalTitle: "之前拆分的旧事件",
        publishedAt: baseline,
        eventDate: "2024-03-15",
        status: "processed",
        moderationStatus: "allowed",
        parentItemId: parent.id,
      },
    });
    await prisma.aggregationSplitLink.create({
      data: { parentItemId: parent.id, childItemId: preexistingChild.id, eventIndex: 0, fingerprint: "staleness-preexisting", oneLiner: "旧拆分事件" },
    });

    await reanalyzeItem(parent.id, { aiProvider: aggregationProvider() });

    const links = await prisma.aggregationSplitLink.findMany({
      where: { parentItemId: parent.id },
      include: { child: true },
    });
    const childByUrl = new Map(links.map(({ child }) => [child.originalUrl, child]));
    const stale = childByUrl.get("https://events.example.test/old");
    const fresh = childByUrl.get("https://events.example.test/new");
    const unknown = childByUrl.get("https://events.example.test/unknown");

    expect(stale).toMatchObject({
      status: "filtered",
      moderationStatus: "filtered",
      moderationReason: "stale_content",
      filterReason: "stale_event_content",
    });
    expect(fresh).toMatchObject({ status: "processed", moderationStatus: "allowed" });
    expect(unknown).toMatchObject({ status: "processed", moderationStatus: "allowed" });

    const filters = resolveFeedFilters({
      range: "all", sort: "time_desc", start: null, end: null,
      groupId: null, sourceId: null, title: null,
    }, baseline);
    const feed = await listFeedItems(filters, { page: 1, size: 100 });
    const visibleIds = feed.items.flatMap((entry) => entry.type === "cluster"
      ? [entry.id, ...entry.itemsPreview.map((item) => item.id)]
      : [entry.id]);
    expect(visibleIds).not.toContain(stale?.id);
    expect(visibleIds).toContain(fresh?.id);
    expect(visibleIds).toContain(unknown?.id);
    expect(feed.items.some((entry) => entry.type === "single" && entry.id === stale?.id)).toBe(false);
    expect(feed.items.some((entry) => entry.type === "single" && entry.id === fresh?.id)).toBe(true);
  });

  it("filters old children during ingestion when a split is preserved without re-parsing", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Preserved ingestion split",
        rssUrl: "https://preserved.example.test/feed.xml",
        siteUrl: "https://preserved.example.test",
        enabled: true,
        aiParsingEnabled: true,
        aggregationDetectionEnabled: true,
      },
    });
    const childCluster = await prisma.contentCluster.create({
      data: {
        id: "preserved-ingestion-child-cluster",
        title: "旧事件和新事件",
        summary: "拆分子事件",
        score: 80,
        itemCount: 2,
        latestPublishedAt: baseline,
        status: "active",
        fingerprint: "preserved-ingestion-child-cluster",
      },
    });
    const parent = await prisma.item.create({
      data: {
        sourceId: source.id,
        originalUrl: "https://preserved.example.test/daily",
        canonicalUrl: "https://preserved.example.test/daily",
        urlHash: "preserved-ingestion-parent",
        originalTitle: "当前日报",
        rssContent: "回顾 2024 年 3 月 15 日旧事件以及 2026 年 10 月 8 日新进展。",
        fullText: "回顾 2024 年 3 月 15 日旧事件以及 2026 年 10 月 8 日新进展，完整正文内容。",
        publishedAt: baseline,
        status: "processed",
        summaryStatus: "succeeded",
        analysisStatus: "succeeded",
        moderationStatus: "allowed",
        summaryText: "日报摘要",
        isAggregation: true,
        aggregationParseStatus: "detected",
      },
    });
    const staleChild = await prisma.item.create({
      data: {
        sourceId: source.id,
        originalUrl: "https://preserved.example.test/stale-child",
        canonicalUrl: "https://preserved.example.test/stale-child",
        urlHash: "preserved-stale-child",
        originalTitle: "旧事件",
        summaryText: "该旧事件发生于 2024 年 3 月 15 日。",
        publishedAt: baseline,
        eventDate: "2024-03-15",
        status: "processed",
        moderationStatus: "allowed",
        parentItemId: parent.id,
        clusterId: childCluster.id,
      },
    });
    const freshChild = await prisma.item.create({
      data: {
        sourceId: source.id,
        originalUrl: "https://preserved.example.test/fresh-child",
        canonicalUrl: "https://preserved.example.test/fresh-child",
        urlHash: "preserved-fresh-child",
        originalTitle: "新事件",
        publishedAt: baseline,
        eventDate: "2026-10-01",
        status: "processed",
        moderationStatus: "allowed",
        parentItemId: parent.id,
        clusterId: childCluster.id,
      },
    });
    await prisma.aggregationSplitLink.createMany({
      data: [staleChild, freshChild].map((child, eventIndex) => ({
        parentItemId: parent.id,
        childItemId: child.id,
        eventIndex,
        fingerprint: `preserved-ingestion-${eventIndex}`,
        oneLiner: child.originalTitle,
      })),
    });
    const feedFilters = resolveFeedFilters({
      range: "all", sort: "time_desc", start: null, end: null,
      groupId: null, sourceId: null, title: null,
    }, baseline);
    const before = await getCachedFeedItems(feedFilters, { page: 1, size: 100 });
    expect(before.items.some((entry) => entry.type === "single" && entry.id === staleChild.id)).toBe(true);

    await processFeedItem({
      item: { title: parent.originalTitle, link: parent.originalUrl, isoDate: baseline.toISOString(), content: parent.rssContent },
      sourceId: source.id,
      sourceName: source.name,
      aiParsingEnabled: true,
      aggregationEnabled: true,
      aggregationDetectionEnabled: true,
      existingItem: parent,
      blacklist: [],
      articleFetcher: vi.fn().mockResolvedValue(null),
      aiProvider: regularProvider(),
      clusterAssignmentCoordinator: createClusterAssignmentCoordinator(),
      fullTextFetchThreshold: 1,
      contentExtraction: {
        jinaEnabled: false, jinaBaseUrl: "https://jina.example.test", jinaApiKey: null,
        timeoutMs: 1000, concurrency: 1, rpmLimit: 1, maxPerRun: 1, minChars: 1, maxChars: 1000,
      },
      now: baseline,
    });

    expect(await prisma.item.findUniqueOrThrow({ where: { id: staleChild.id } })).toMatchObject({
      status: "filtered", moderationStatus: "filtered", filterReason: "stale_event_content",
    });
    expect(await prisma.item.findUniqueOrThrow({ where: { id: freshChild.id } })).toMatchObject({
      status: "processed", moderationStatus: "allowed", filterReason: null,
    });
    expect(await prisma.aggregationSplitLink.count({ where: { parentItemId: parent.id } })).toBe(2);
    expect(await prisma.contentCluster.findUnique({ where: { id: childCluster.id } })).toMatchObject({ itemCount: 1 });
    const after = await getCachedFeedItems(feedFilters, { page: 1, size: 100 });
    expect(after.items.some((entry) => entry.type === "single" && entry.id === staleChild.id)).toBe(false);
    expect(after.items.some((entry) => entry.type === "single" && entry.id === freshChild.id)).toBe(true);

    await prisma.item.update({ where: { id: freshChild.id }, data: { eventDate: "2024-01-01", summaryText: "该事件发生于 2024 年 1 月 1 日。" } });
    const reusableParent = await prisma.item.findUniqueOrThrow({ where: { id: parent.id } });
    await processFeedItem({
      item: { title: parent.originalTitle, link: parent.originalUrl, isoDate: baseline.toISOString(), content: parent.rssContent },
      sourceId: source.id,
      sourceName: source.name,
      aiParsingEnabled: true,
      aggregationEnabled: true,
      aggregationDetectionEnabled: true,
      existingItem: reusableParent,
      blacklist: [],
      articleFetcher: vi.fn().mockResolvedValue(null),
      aiProvider: regularProvider(),
      clusterAssignmentCoordinator: createClusterAssignmentCoordinator(),
      fullTextFetchThreshold: 1,
      contentExtraction: {
        jinaEnabled: false, jinaBaseUrl: "https://jina.example.test", jinaApiKey: null,
        timeoutMs: 1000, concurrency: 1, rpmLimit: 1, maxPerRun: 1, minChars: 1, maxChars: 1000,
      },
      now: baseline,
    });
    expect(await prisma.item.findUniqueOrThrow({ where: { id: freshChild.id } })).toMatchObject({
      status: "filtered", moderationStatus: "filtered", filterReason: "stale_event_content",
    });
  });

  it("keeps fresh children when a stale parent is reanalyzed but its split is preserved", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Stale parent split",
        rssUrl: "https://parent-stale.example.test/feed.xml",
        siteUrl: "https://parent-stale.example.test",
        enabled: true,
        aiParsingEnabled: true,
        aggregationDetectionEnabled: true,
      },
    });
    const childCluster = await prisma.contentCluster.create({
      data: {
        id: "parent-stale-child-cluster",
        title: "旧事件和新事件",
        summary: "拆分子事件",
        score: 80,
        itemCount: 2,
        latestPublishedAt: baseline,
        status: "active",
        fingerprint: "parent-stale-child-cluster",
      },
    });
    const parent = await prisma.item.create({
      data: {
        sourceId: source.id,
        originalUrl: "https://parent-stale.example.test/daily",
        canonicalUrl: "https://parent-stale.example.test/daily",
        urlHash: "parent-stale-daily",
        originalTitle: "旧日报",
        rssContent: "另一个无关事件发生于 2024 年 3 月 15 日，日报于 2026 年 10 月 8 日重新发布。",
        publishedAt: baseline,
        eventDate: "2024-03-15",
        status: "processed",
        moderationStatus: "allowed",
        summaryText: "旧日报摘要",
        isAggregation: true,
        aggregationParseStatus: "parsed",
      },
    });
    const oldChild = await prisma.item.create({
      data: {
        sourceId: source.id,
        originalUrl: "https://parent-stale.example.test/old-child",
        canonicalUrl: "https://parent-stale.example.test/old-child",
        urlHash: "parent-stale-old-child",
        originalTitle: "旧事件",
        summaryText: "该旧事件发生于 2024 年 3 月 15 日。",
        publishedAt: baseline,
        eventDate: "2024-03-15",
        status: "processed",
        moderationStatus: "allowed",
        parentItemId: parent.id,
        clusterId: childCluster.id,
      },
    });
    const freshChild = await prisma.item.create({
      data: {
        sourceId: source.id,
        originalUrl: "https://parent-stale.example.test/fresh-child",
        canonicalUrl: "https://parent-stale.example.test/fresh-child",
        urlHash: "parent-stale-fresh-child",
        originalTitle: "新事件",
        publishedAt: baseline,
        eventDate: "2026-10-01",
        status: "processed",
        moderationStatus: "allowed",
        parentItemId: parent.id,
        clusterId: childCluster.id,
      },
    });
    await prisma.aggregationSplitLink.createMany({
      data: [oldChild, freshChild].map((child, eventIndex) => ({
        parentItemId: parent.id,
        childItemId: child.id,
        eventIndex,
        fingerprint: `parent-stale-${eventIndex}`,
        oneLiner: child.originalTitle,
      })),
    });
    const provider = buildAiProviderMock({
      summaryFixture: vi.fn().mockResolvedValue({ summary: "旧事件复盘摘要", isAggregation: false }),
      analysisFixture: vi.fn().mockResolvedValue({
        translatedTitle: null,
        moderationStatus: "allowed",
        moderationReason: null,
        moderationDetail: null,
        qualityScore: 75,
        qualityRationale: "test",
        eventSignature: buildEventSignature({ eventType: "launch", eventSubject: "旧事件", eventAction: "发布", eventObject: "项目", eventDate: "2024-03-15" }),
      }),
    });

    await reanalyzeItem(parent.id, { aiProvider: provider });

    expect(await prisma.item.findUniqueOrThrow({ where: { id: parent.id } })).toMatchObject({
      status: "filtered", moderationStatus: "filtered", filterReason: "stale_event_content",
    });
    expect(await prisma.item.findUniqueOrThrow({ where: { id: oldChild.id } })).toMatchObject({
      status: "filtered", moderationStatus: "filtered", filterReason: "stale_event_content",
    });
    expect(await prisma.item.findUniqueOrThrow({ where: { id: freshChild.id } })).toMatchObject({
      status: "processed", moderationStatus: "allowed", filterReason: null,
    });
    expect(await prisma.contentCluster.findUnique({ where: { id: childCluster.id } })).toMatchObject({ itemCount: 1 });
  });

  it("filters linked and legacy children once while preserving admin restores and other filter reasons", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Relation staleness",
        rssUrl: "https://relations.example.test/feed.xml",
        siteUrl: "https://relations.example.test",
        enabled: true,
        aiParsingEnabled: true,
        aggregationDetectionEnabled: true,
      },
    });
    const cluster = await prisma.contentCluster.create({
      data: {
        id: "relations-staleness-cluster",
        title: "旧事件",
        summary: "旧事件摘要",
        score: 80,
        itemCount: 1,
        latestPublishedAt: baseline,
        status: "active",
        fingerprint: "relations-staleness-cluster",
      },
    });
    const parent = await prisma.item.create({
      data: {
        sourceId: source.id,
        originalUrl: "https://relations.example.test/daily",
        canonicalUrl: "https://relations.example.test/daily",
        urlHash: "relations-staleness-parent",
        originalTitle: "日报",
        rssContent: "另一个无关事件发生于 2024 年 3 月 15 日。",
        publishedAt: baseline,
        status: "processed",
        moderationStatus: "allowed",
        isAggregation: true,
        aggregationParseStatus: "parsed",
      },
    });
    const createChild = (data: {
      originalUrl: string;
      canonicalUrl: string;
      urlHash: string;
      parentItemId: string;
      clusterId?: string;
      restoredByAdminAt?: Date;
      filterReason?: string;
      eventDate?: string;
      summaryText?: string;
    }) => prisma.item.create({
      data: {
        sourceId: source.id,
        publishedAt: baseline,
        originalTitle: "子事件",
        summaryText: "该子事件发生于 2024 年 3 月 15 日。",
        eventDate: "2024-03-15",
        status: "processed",
        moderationStatus: "allowed",
        ...data,
      },
    });
    const linked = await createChild({
      originalUrl: "https://relations.example.test/linked",
      canonicalUrl: "https://relations.example.test/linked",
      urlHash: "relations-linked",
      parentItemId: parent.id,
      clusterId: cluster.id,
    });
    const legacy = await createChild({
      originalUrl: "https://relations.example.test/legacy",
      canonicalUrl: "https://relations.example.test/legacy",
      urlHash: "relations-legacy",
      parentItemId: parent.id,
    });
    const freshClusterMember = await createChild({
      originalUrl: "https://relations.example.test/fresh-cluster-member",
      canonicalUrl: "https://relations.example.test/fresh-cluster-member",
      urlHash: "relations-fresh-member",
      parentItemId: parent.id,
      clusterId: cluster.id,
      eventDate: "2026-10-08",
    });
    const secondFreshClusterMember = await createChild({
      originalUrl: "https://relations.example.test/fresh-cluster-member-2",
      canonicalUrl: "https://relations.example.test/fresh-cluster-member-2",
      urlHash: "relations-fresh-member-2",
      parentItemId: parent.id,
      clusterId: cluster.id,
      eventDate: "2026-10-07",
    });
    const restored = await createChild({
      originalUrl: "https://relations.example.test/restored",
      canonicalUrl: "https://relations.example.test/restored",
      urlHash: "relations-restored",
      parentItemId: parent.id,
      restoredByAdminAt: baseline,
    });
    const otherFiltered = await createChild({
      originalUrl: "https://relations.example.test/other-filter",
      canonicalUrl: "https://relations.example.test/other-filter",
      urlHash: "relations-other-filter",
      parentItemId: parent.id,
      filterReason: "rule_blacklist",
    });
    await prisma.aggregationSplitLink.create({
      data: { parentItemId: parent.id, childItemId: linked.id, eventIndex: 0, fingerprint: "relation-linked", oneLiner: "linked" },
    });

    const unrelated = await createChild({
      originalUrl: "https://relations.example.test/unrelated-parent-date",
      canonicalUrl: "https://relations.example.test/unrelated-parent-date",
      urlHash: "relations-unrelated-parent-date",
      parentItemId: parent.id,
      summaryText: "This child's own text contains no date evidence.",
    });
    const result = await filterStaleAggregationChildren({
      parentItemId: parent.id,
      referenceAt: baseline,
    });

    expect(result.filteredCount).toBe(2);
    expect(result.clusterIds).toEqual([cluster.id]);
    expect((await prisma.item.findUniqueOrThrow({ where: { id: linked.id } })).filterReason).toBe("stale_event_content");
    expect((await prisma.item.findUniqueOrThrow({ where: { id: legacy.id } })).filterReason).toBe("stale_event_content");
    expect((await prisma.item.findUniqueOrThrow({ where: { id: restored.id } })).status).toBe("processed");
    expect((await prisma.item.findUniqueOrThrow({ where: { id: unrelated.id } })).status).toBe("processed");
    expect((await prisma.item.findUniqueOrThrow({ where: { id: otherFiltered.id } })).filterReason).toBe("rule_blacklist");
    const feed = await listFeedItems(resolveFeedFilters({
      range: "all", sort: "time_desc", start: null, end: null,
      groupId: null, sourceId: null, title: null,
    }, baseline), { page: 1, size: 100 });
    expect(feed.items.some((entry) => entry.type === "single" && [linked.id, legacy.id].includes(entry.id))).toBe(false);
    await recomputeCluster(cluster.id);
    const clusterFeed = await listFeedItems(resolveFeedFilters({
      range: "all", sort: "time_desc", start: null, end: null,
      groupId: null, sourceId: null, title: null,
    }, baseline), { page: 1, size: 100 });
    const clusterEntry = clusterFeed.items.find((entry) => entry.type === "cluster" && entry.id === cluster.id);
    expect(clusterEntry?.type).toBe("cluster");
    expect(clusterEntry?.type === "cluster" ? clusterEntry.itemsPreview.map((item) => item.id) : []).toEqual(expect.arrayContaining([freshClusterMember.id, secondFreshClusterMember.id]));
    expect(clusterEntry?.type === "cluster" ? clusterEntry.itemsPreview.map((item) => item.id) : []).not.toContain(linked.id);
  });

  it("invalidates failed-reparse caches after retained-child filtering and cluster recomputation", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Failed reparse ordering",
        rssUrl: "https://ordering.example.test/feed.xml",
        siteUrl: "https://ordering.example.test",
        enabled: true,
        aiParsingEnabled: true,
        aggregationDetectionEnabled: true,
      },
    });
    const childCluster = await prisma.contentCluster.create({
      data: {
        id: "failed-reparse-child-cluster",
        title: "旧事件与新事件",
        summary: "拆分事件",
        score: 80,
        itemCount: 2,
        latestPublishedAt: baseline,
        status: "active",
        fingerprint: "failed-reparse-child-cluster",
      },
    });
    const parent = await prisma.item.create({
      data: {
        sourceId: source.id,
        originalUrl: "https://ordering.example.test/daily",
        canonicalUrl: "https://ordering.example.test/daily",
        urlHash: "failed-reparse-parent",
        originalTitle: "今日聚合",
        rssContent: "另一个无关事件发生于 2024 年 3 月 15 日。",
        fullText: "这是一篇足够长的聚合日报正文。另一个无关事件发生于 2024 年 3 月 15 日，不涉及拆分子事件。",
        publishedAt: baseline,
        status: "processed",
        summaryText: "旧摘要",
        isAggregation: true,
        aggregationParseStatus: "parsed",
      },
    });
    const staleChild = await prisma.item.create({
      data: {
        sourceId: source.id,
        originalUrl: "https://ordering.example.test/old",
        canonicalUrl: "https://ordering.example.test/old",
        urlHash: "failed-reparse-old-child",
        originalTitle: "旧事件",
        summaryText: "该旧事件发生于 2024 年 3 月 15 日。",
        publishedAt: baseline,
        eventDate: "2024-03-15",
        status: "processed",
        moderationStatus: "allowed",
        parentItemId: parent.id,
        clusterId: childCluster.id,
      },
    });
    const freshChild = await prisma.item.create({
      data: {
        sourceId: source.id,
        originalUrl: "https://ordering.example.test/new",
        canonicalUrl: "https://ordering.example.test/new",
        urlHash: "failed-reparse-new-child",
        originalTitle: "新事件",
        summaryText: "新事件今天发布。",
        publishedAt: baseline,
        eventDate: "2026-10-08",
        status: "processed",
        moderationStatus: "allowed",
        parentItemId: parent.id,
        clusterId: childCluster.id,
      },
    });
    await prisma.aggregationSplitLink.createMany({
      data: [staleChild, freshChild].map((child, eventIndex) => ({
        parentItemId: parent.id,
        childItemId: child.id,
        eventIndex,
        fingerprint: `failed-reparse-${eventIndex}`,
        oneLiner: child.summaryText ?? child.originalTitle,
      })),
    });

    const feedFilters = resolveFeedFilters({
      range: "all", sort: "time_desc", start: null, end: null,
      groupId: null, sourceId: null, title: null,
    }, baseline);
    const before = await getCachedFeedItems(feedFilters, { page: 1, size: 100 });
    expect(before.items.some((entry) => entry.type === "single" && entry.id === staleChild.id)).toBe(true);
    const order: string[] = [];
    const moduleNames = [
      "@/lib/aggregation/persist",
      "@/lib/aggregation/staleness",
      "@/lib/clusters/service",
      "@/lib/feed/cache",
      "@/lib/daily-report/cache",
    ];
    vi.resetModules();
    vi.doMock("@/lib/aggregation/persist", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/aggregation/persist")>();
      return {
        ...actual,
        retireAggregationChildItems: async () => 0,
        persistAggregationChildItems: async () => { throw new Error("injected split persistence failure"); },
      };
    });
    vi.doMock("@/lib/aggregation/staleness", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/aggregation/staleness")>();
      return {
        ...actual,
        filterStaleAggregationChildren: async (input: Parameters<typeof actual.filterStaleAggregationChildren>[0]) => {
          const concurrentRead = await getCachedFeedItems(feedFilters, { page: 1, size: 100 });
          order.push(concurrentRead.items.some((entry) => entry.type === "single" && entry.id === staleChild.id)
            ? "concurrent-read-stale"
            : "concurrent-read-current");
          const result = await actual.filterStaleAggregationChildren(input);
          const updated = await prisma.item.findUniqueOrThrow({ where: { id: staleChild.id } });
          order.push(updated.status === "filtered" ? "child-filtered" : "child-not-filtered");
          return result;
        },
      };
    });
    vi.doMock("@/lib/clusters/service", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/clusters/service")>();
      return {
        ...actual,
        recomputeCluster: async (...args: Parameters<typeof actual.recomputeCluster>) => {
          const result = await actual.recomputeCluster(...args);
          order.push("cluster-recomputed");
          return result;
        },
      };
    });
    vi.doMock("@/lib/feed/cache", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/feed/cache")>();
      return {
        ...actual,
        invalidateFeedCache: () => {
          order.push("feed-invalidated");
          actual.invalidateFeedCache();
        },
      };
    });
    vi.doMock("@/lib/daily-report/cache", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/daily-report/cache")>();
      return {
        ...actual,
        invalidateDailyReportCache: () => {
          order.push("daily-invalidated");
          actual.invalidateDailyReportCache();
        },
      };
    });

    try {
      const isolatedItemsService = await import("@/lib/items/service");
      const result = await isolatedItemsService.reanalyzeItem(parent.id, { aiProvider: aggregationProvider() });
      expect(result.failedFields).toContain("aggregation");
      expect(order).toContain("child-filtered");
      expect(order).toContain("concurrent-read-stale");
      expect(order.indexOf("child-filtered")).toBeLessThan(order.lastIndexOf("feed-invalidated"));
      expect(order.indexOf("cluster-recomputed")).toBeLessThan(order.lastIndexOf("feed-invalidated"));
      expect(order.indexOf("cluster-recomputed")).toBeLessThan(order.lastIndexOf("daily-invalidated"));
      expect(await prisma.item.findUniqueOrThrow({ where: { id: staleChild.id } })).toMatchObject({
        status: "filtered", filterReason: "stale_event_content",
      });
      expect(await prisma.item.findUniqueOrThrow({ where: { id: freshChild.id } })).toMatchObject({ status: "processed" });
      const finalFeed = await getCachedFeedItems(feedFilters, { page: 1, size: 100 });
      expect(finalFeed.items.some((entry) => entry.type === "single" && entry.id === staleChild.id)).toBe(false);
    } finally {
      for (const moduleName of moduleNames) vi.doUnmock(moduleName);
      vi.resetModules();
    }
  });

  it("re-evaluates existing children when ingestion successfully re-parses an active split", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Ingestion staleness aggregation",
        rssUrl: "https://events.example.test/ingestion-feed.xml",
        siteUrl: "https://events.example.test",
        enabled: true,
        aiParsingEnabled: true,
        aggregationDetectionEnabled: true,
      },
    });
    const parent = await prisma.item.create({
      data: {
        sourceId: source.id,
        originalUrl: "https://events.example.test/ingestion-daily",
        canonicalUrl: "https://events.example.test/ingestion-daily",
        urlHash: "ingestion-staleness-parent",
        originalTitle: "当前日报",
        rssContent: "当前内容回顾 2024 年 3 月 15 日旧事件，并介绍 2026 年 10 月 8 日新进展。",
        fullText: "当前内容回顾 2024 年 3 月 15 日旧事件，并介绍 2026 年 10 月 8 日新进展，文章正文已完整抓取。",
        publishedAt: baseline,
        status: "processed",
        summaryStatus: "succeeded",
        analysisStatus: "succeeded",
        moderationStatus: "allowed",
        summaryText: "日报摘要",
        isAggregation: true,
        aggregationParseStatus: "detected",
      },
    });
    const oldChild = await prisma.item.create({
      data: {
        sourceId: source.id,
        originalUrl: "https://events.example.test/old-existing",
        canonicalUrl: "https://events.example.test/old-existing",
        urlHash: "ingestion-old-child",
        originalTitle: "旧拆分事件",
        summaryText: "该旧事件发生于 2024 年 3 月 15 日。",
        publishedAt: baseline,
        eventDate: "2024-03-15",
        status: "processed",
        moderationStatus: "allowed",
        parentItemId: parent.id,
      },
    });
    await prisma.aggregationSplitLink.create({
      data: { parentItemId: parent.id, childItemId: oldChild.id, eventIndex: 0, fingerprint: "ingestion-old", oneLiner: "旧事件" },
    });

    await processFeedItem({
      item: {
        title: parent.originalTitle,
        link: parent.originalUrl,
        isoDate: baseline.toISOString(),
        content: parent.rssContent,
      },
      sourceId: source.id,
      sourceName: source.name,
      aiParsingEnabled: true,
      aggregationEnabled: true,
      aggregationDetectionEnabled: true,
      existingItem: parent,
      blacklist: [],
      articleFetcher: vi.fn().mockResolvedValue(null),
      aiProvider: aggregationProvider(),
      clusterAssignmentCoordinator: createClusterAssignmentCoordinator(),
      fullTextFetchThreshold: 1,
      contentExtraction: {
        jinaEnabled: false,
        jinaBaseUrl: "https://jina.example.test",
        jinaApiKey: null,
        timeoutMs: 1000,
        concurrency: 1,
        rpmLimit: 1,
        maxPerRun: 1,
        minChars: 1,
        maxChars: 1000,
      },
      now: baseline,
    });

    const linkedChildren = await prisma.aggregationSplitLink.findMany({
      where: { parentItemId: parent.id },
      include: { child: true },
    });
    const stale = linkedChildren.find(({ child }) => child.originalUrl === "https://events.example.test/old")?.child;
    const fresh = linkedChildren.find(({ child }) => child.originalUrl === "https://events.example.test/new")?.child;
    expect(stale).toMatchObject({ status: "filtered", moderationStatus: "filtered", filterReason: "stale_event_content" });
    expect(fresh).toMatchObject({ status: "processed", moderationStatus: "allowed" });
  });
});
