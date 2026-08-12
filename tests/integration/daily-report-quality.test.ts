import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db";
import { getDailyReportQualityMetrics } from "@/lib/daily-report/quality";

function dateDaysAgo(days: number) {
  const shifted = new Date();
  shifted.setUTCDate(shifted.getUTCDate() - days);
  return shifted.toISOString().slice(0, 10);
}

// Seed dates stay relative to "now" so the hardcoded values do not drift out of
// the metrics date window (e.g. days: 90) as time passes.
const REPORT_DATE_A = dateDaysAgo(3);
const REPORT_DATE_B = dateDaysAgo(2);
const REPORT_DATE_C = dateDaysAgo(1);

function buildContent(overrides: {
  topCount: number;
  changeCount: number;
  securityCount?: number;
}) {
  return JSON.stringify({
    openingSummary: `${REPORT_DATE_A} 期间 AI 行业发生了若干重要进展,涵盖产品发布、工具更新、安全事件和数据洞察,值得持续关注其对开发者和企业的实际影响。`,
    sections: {
      今日大事: Array.from({ length: overrides.topCount }, (_, i) => ({
        topic: `今日大事 ${i + 1}`,
        summary: `这是第 ${i + 1} 条今日大事的详细描述,涵盖了关键主体、动作和结果。`,
        whyImportant: `重要性 ${i + 1}`,
        sourceIds: [i + 1],
      })),
      变更与实践: Array.from({ length: overrides.changeCount }, (_, i) => ({
        topic: `变更 ${i + 1}`,
        action: `行动建议 ${i + 1}`,
        sourceIds: [i + 10],
      })),
      安全与风险: Array.from({ length: overrides.securityCount ?? 0 }, (_, i) => ({
        topic: `风险 ${i + 1}`,
        affected: `影响对象 ${i + 1}`,
        action: `建议 ${i + 1}`,
        sourceIds: [i + 20],
      })),
      开源与工具: [],
      数据与洞察: [],
    },
    closingThought: "今天的主线变化说明生态正在向更高效的工具链收敛,后续需要持续观察落地效果。",
  });
}

async function createItem(sourceId: string, key: string, url: string) {
  return prisma.item.create({
    data: {
      sourceId,
      originalUrl: url,
      canonicalUrl: url,
      urlHash: key,
      originalTitle: `Title for ${key}`,
      publishedAt: new Date(`${dateDaysAgo(4)}T08:00:00.000Z`),
      createdAt: new Date(`${dateDaysAgo(4)}T08:00:00.000Z`),
      status: "processed",
      moderationStatus: "allowed",
      summaryText: "summary",
      qualityScore: 80,
    },
  });
}

type ReportItemRef = {
  id: string;
  sourceName: string;
  url: string;
  key: string;
};

async function createReportWithItems(opts: {
  date: string;
  sourceId: string;
  contentOverrides: { topCount: number; changeCount: number; securityCount?: number };
  usedItems: ReportItemRef[];
  snapshotUsedItemIds: string[];
  snapshotTotalCandidates: number;
  status?: "draft" | "published";
}) {
  const extraItems: ReportItemRef[] = [];
  for (let i = opts.snapshotUsedItemIds.length; i < opts.snapshotTotalCandidates; i += 1) {
    const key = `missed-${i}`;
    const item = await createItem(opts.sourceId, key, `https://missed.example/${i}`);
    extraItems.push({ id: item.id, sourceName: "Source B", url: item.originalUrl, key });
  }

  const snapshotEntries = Array.from({ length: opts.snapshotTotalCandidates }, (_, i) => {
    const usedItemId = opts.snapshotUsedItemIds[i];
    const usedItem = usedItemId ? opts.usedItems.find((u) => u.id === usedItemId) : undefined;
    const missedItem = extraItems[i - opts.snapshotUsedItemIds.length];
    const isUsed = Boolean(usedItem);
    return {
      id: i + 1,
      itemId: isUsed ? usedItem!.id : missedItem.id,
      clusterId: null,
      title: isUsed ? `Used Candidate ${i + 1}` : `Missed Candidate ${i + 1}`,
      itemTitle: isUsed ? `Used Candidate ${i + 1}` : `Missed Candidate ${i + 1}`,
      sourceName: isUsed ? "Source A" : "Source B",
      candidateScore: 100 - i,
      sourceCount: Math.max(1, 5 - i),
      itemCount: 1,
      eventType: "release",
      eventSubject: `Subject ${i + 1}`,
      eventAction: null,
      eventObject: null,
      eventDate: null,
    };
  });

  return prisma.dailyReport.create({
    data: {
      date: opts.date,
      timezone: "Asia/Shanghai",
      status: opts.status ?? "published",
      title: `${opts.date} AI 日报`,
      openingSummary: "本期日报聚焦行业关键变化,涵盖产品、工具、安全和数据洞察。",
      closingThought: "整体趋势向工程化收敛,后续值得继续观察开发者工具链的演进。",
      summaryJson: buildContent(opts.contentOverrides),
      renderedMarkdown: `# ${opts.date} AI 日报`,
      inputHash: `hash-${opts.date}-${Math.random()}`,
      candidateSnapshot: JSON.stringify({
        candidates: snapshotEntries,
        excludedRecentDuplicates: [],
        candidateCount: snapshotEntries.length,
      }),
      sources: {
        create: opts.usedItems.map((s, i) => ({
          sourceNumber: i + 1,
          sourceKey: `item:${s.key}`,
          itemId: s.id,
          clusterId: null,
          sourceName: s.sourceName,
          title: `Source ${i + 1} Title`,
          url: s.url,
          sourceSummary: "summary",
          sourcePublishedAt: new Date(`${opts.date}T05:00:00.000Z`),
          sourceQualityScore: 80,
        })),
      },
    },
  });
}

describe("daily report quality metrics", () => {
  beforeEach(async () => {
    await prisma.dailyReportSource.deleteMany();
    await prisma.dailyReport.deleteMany();
    await prisma.item.deleteMany();
    await prisma.contentCluster.deleteMany();
    await prisma.source.deleteMany();
  });

  it("returns zero/empty metrics when there are no reports in range", async () => {
    const metrics = await getDailyReportQualityMetrics({ days: 14 });
    expect(metrics.reportCount).toBe(0);
    expect(metrics.sectionFillRate.every((b) => b.reportCount === 0)).toBe(true);
    expect(metrics.sourceDiversity.avgSourceCountPerReport).toBe(0);
    expect(metrics.missRate.reportsEvaluated).toBe(0);
    expect(metrics.dayOverlap.pairsComputed).toBe(0);
  });

  it("computes all metrics over multiple reports", async () => {
    const sourceA = await prisma.source.create({
      data: { name: "Source A", rssUrl: "https://a.example/feed.xml", siteUrl: "https://a.example" },
    });
    const sourceB = await prisma.source.create({
      data: { name: "Source B", rssUrl: "https://b.example/feed.xml", siteUrl: "https://b.example" },
    });

    const usedA1 = await createItem(sourceA.id, "u-a-1", "https://a.example/1");
    const usedA2 = await createItem(sourceA.id, "u-a-2", "https://a.example/2");
    const usedA3 = await createItem(sourceA.id, "u-a-3", "https://a.example/3");
    const usedB1 = await createItem(sourceB.id, "u-b-1", "https://b.example/1");
    const usedB2 = await createItem(sourceB.id, "u-b-2", "https://b.example/2");
    const usedC1 = await createItem(sourceB.id, "u-c-1", "https://c.example/1");
    const usedC2 = await createItem(sourceB.id, "u-c-2", "https://c.example/2");
    const usedD1 = await createItem(sourceB.id, "u-d-1", "https://d.example/1");
    const usedD2 = await createItem(sourceB.id, "u-d-2", "https://d.example/2");
    const usedE1 = await createItem(sourceB.id, "u-e-1", "https://e.example/1");

    await createReportWithItems({
      date: REPORT_DATE_A,
      sourceId: sourceA.id,
      contentOverrides: { topCount: 3, changeCount: 2 },
      usedItems: [
        { id: usedA1.id, sourceName: "Source A", url: usedA1.originalUrl, key: "u-a-1" },
        { id: usedA2.id, sourceName: "Source A", url: usedA2.originalUrl, key: "u-a-2" },
        { id: usedA3.id, sourceName: "Source B", url: usedA3.originalUrl, key: "u-a-3" },
      ],
      snapshotUsedItemIds: [usedA1.id, usedA2.id],
      snapshotTotalCandidates: 10,
    });

    await createReportWithItems({
      date: REPORT_DATE_B,
      sourceId: sourceB.id,
      contentOverrides: { topCount: 5, changeCount: 4, securityCount: 1 },
      usedItems: [
        { id: usedA1.id, sourceName: "Source A", url: usedA1.originalUrl, key: "u-a-1" },
        { id: usedB1.id, sourceName: "Source C", url: usedB1.originalUrl, key: "u-b-1" },
        { id: usedB2.id, sourceName: "Source C", url: usedB2.originalUrl, key: "u-b-2" },
        { id: usedC1.id, sourceName: "Source D", url: usedC1.originalUrl, key: "u-c-1" },
        { id: usedC2.id, sourceName: "Source D", url: usedC2.originalUrl, key: "u-c-2" },
        { id: usedD1.id, sourceName: "Source E", url: usedD1.originalUrl, key: "u-d-1" },
      ],
      snapshotUsedItemIds: [],
      snapshotTotalCandidates: 0,
    });

    await createReportWithItems({
      date: REPORT_DATE_C,
      sourceId: sourceA.id,
      contentOverrides: { topCount: 4, changeCount: 2 },
      usedItems: [
        { id: usedD2.id, sourceName: "Source C", url: usedD2.originalUrl, key: "u-d-2" },
        { id: usedE1.id, sourceName: "Source D", url: usedE1.originalUrl, key: "u-e-1" },
      ],
      snapshotUsedItemIds: [],
      snapshotTotalCandidates: 0,
    });

    const metrics = await getDailyReportQualityMetrics({ days: 90 });

    expect(metrics.reportCount).toBe(3);

    const topBucket = metrics.sectionFillRate.find((b) => b.sectionName === "今日大事");
    expect(topBucket?.reportCount).toBe(3);
    expect(topBucket?.avgCount).toBe(4);

    const changeBucket = metrics.sectionFillRate.find((b) => b.sectionName === "变更与实践");
    expect(changeBucket?.avgCount).toBeCloseTo(2.67, 1);

    const securityBucket = metrics.sectionFillRate.find((b) => b.sectionName === "安全与风险");
    expect(securityBucket?.avgCount).toBeCloseTo(0.33, 1);

    expect(metrics.sourceDiversity.avgSourceCountPerReport).toBeCloseTo(2.67, 1);
    expect(metrics.sourceDiversity.topSources.length).toBeGreaterThan(0);

    expect(metrics.missRate.reportsWithSnapshot).toBe(1);
    expect(metrics.missRate.reportsEvaluated).toBe(1);
    expect(metrics.missRate.avgTop20MissRate).toBeCloseTo(0.8, 1);
    expect(metrics.missRate.recentMissed.length).toBeGreaterThan(0);
    expect(metrics.missRate.recentMissed[0]?.title).toContain("Missed");

    expect(metrics.dayOverlap.pairsComputed).toBe(2);
    expect(metrics.dayOverlap.avgSourceOverlap).toBeGreaterThan(0);
    expect(metrics.dayOverlap.avgSourceOverlap).toBeLessThan(1);
  });

  it("filters out failed reports", async () => {
    await prisma.dailyReport.create({
      data: {
        date: REPORT_DATE_A,
        timezone: "Asia/Shanghai",
        status: "failed",
        title: `${REPORT_DATE_A} AI 日报`,
        openingSummary: "失败的日报不应该被计入指标。",
        closingThought: "本期没有可用结论。",
        summaryJson: buildContent({ topCount: 5, changeCount: 5 }),
        renderedMarkdown: "failed",
        inputHash: "hash-failed",
      },
    });

    const metrics = await getDailyReportQualityMetrics({ days: 90 });
    expect(metrics.reportCount).toBe(0);
  });

  it("clamps days input to safe range", async () => {
    await getDailyReportQualityMetrics({ days: 0 });
    await getDailyReportQualityMetrics({ days: 9999 });
  });
});

describe("URL fallback for miss-rate matching", () => {
  beforeEach(async () => {
    await prisma.dailyReportSource.deleteMany();
    await prisma.dailyReport.deleteMany();
    await prisma.item.deleteMany();
    await prisma.contentCluster.deleteMany();
    await prisma.source.deleteMany();
  });

  it("matches candidates and sources by URL when itemId/clusterId are absent", async () => {
    await prisma.source.create({
      data: { name: "Source A", rssUrl: "https://a.example/feed.xml", siteUrl: "https://a.example" },
    });

    const sharedUrl = "https://shared.example/unique-story";

    const snapshot = [
      { id: 1, itemId: null, clusterId: null, url: sharedUrl, title: "Top 1", itemTitle: "Top 1", sourceName: "Source A", candidateScore: 99, sourceCount: 1, itemCount: 1, eventType: null, eventSubject: null, eventAction: null, eventObject: null, eventDate: null },
      { id: 2, itemId: null, clusterId: null, url: "https://other.example/different", title: "Top 2", itemTitle: "Top 2", sourceName: "Source A", candidateScore: 90, sourceCount: 1, itemCount: 1, eventType: null, eventSubject: null, eventAction: null, eventObject: null, eventDate: null },
    ];

    await prisma.dailyReport.create({
      data: {
        date: REPORT_DATE_A,
        timezone: "Asia/Shanghai",
        status: "published",
        title: `${REPORT_DATE_A} AI 日报`,
        openingSummary: "本期日报聚焦行业关键变化,涵盖产品、工具、安全和数据洞察。",
        closingThought: "整体趋势向工程化收敛。",
        summaryJson: buildContent({ topCount: 1, changeCount: 1 }),
        renderedMarkdown: `# ${REPORT_DATE_A} AI 日报`,
        inputHash: `hash-url-fallback`,
        candidateSnapshot: JSON.stringify({
          candidates: snapshot,
          excludedRecentDuplicates: [],
          candidateCount: snapshot.length,
        }),
        sources: {
          create: [{
            sourceNumber: 1,
            sourceKey: `url:${sharedUrl.toLowerCase()}`,
            itemId: null,
            clusterId: null,
            sourceName: "Source A",
            title: "Top 1",
            url: sharedUrl,
            sourceSummary: "summary",
            sourcePublishedAt: new Date(`${REPORT_DATE_A}T05:00:00.000Z`),
            sourceQualityScore: 80,
          }],
        },
      },
    });

    const metrics = await getDailyReportQualityMetrics({ days: 90 });
    expect(metrics.missRate.reportsEvaluated).toBe(1);
    expect(metrics.missRate.avgTop20MissRate).toBe(0.5);
    expect(metrics.missRate.recentMissed.map((m) => m.title)).toContain("Top 2");
  });
});
