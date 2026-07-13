import { beforeEach, describe, expect, it } from "vitest";

import { refreshClusterFeedStats } from "@/lib/clusters/feed-stats";
import { prisma } from "@/lib/db";
import { getIngestionMetrics } from "@/lib/ingestion/metrics-service";

describe("ingestion metrics service", () => {
  beforeEach(async () => {
    await prisma.item.deleteMany();
    await prisma.contentCluster.deleteMany();
    await prisma.source.deleteMany();
  });

  it("builds the quality distribution from composite feed scores", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Metrics Feed",
        rssUrl: "https://metrics.example.com/feed.xml",
        siteUrl: "https://metrics.example.com",
        enabled: true,
        aiParsingEnabled: true,
      },
    });

    await prisma.contentCluster.create({
      data: {
        id: "metrics-cluster",
        kind: "topic",
        title: "Metrics Cluster",
        summary: "Metrics summary",
        score: 90,
        itemCount: 2,
        latestPublishedAt: new Date("2026-04-29T10:00:00.000Z"),
        status: "active",
        fingerprint: "metrics-cluster",
      },
    });

    await prisma.item.createMany({
      data: [
        {
          id: "metrics-cluster-item-1",
          sourceId: source.id,
          clusterId: "metrics-cluster",
          originalUrl: "https://metrics.example.com/cluster-1",
          canonicalUrl: "https://metrics.example.com/cluster-1",
          urlHash: "hash-metrics-cluster-1",
          originalTitle: "Cluster Item 1",
          publishedAt: new Date("2026-04-29T10:00:00.000Z"),
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 92,
          qualityRationale: "高质量",
          language: "en",
        },
        {
          id: "metrics-cluster-item-2",
          sourceId: source.id,
          clusterId: "metrics-cluster",
          originalUrl: "https://metrics.example.com/cluster-2",
          canonicalUrl: "https://metrics.example.com/cluster-2",
          urlHash: "hash-metrics-cluster-2",
          originalTitle: "Cluster Item 2",
          publishedAt: new Date("2026-04-29T09:00:00.000Z"),
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 88,
          qualityRationale: "高质量",
          language: "en",
        },
        {
          id: "metrics-single-high",
          sourceId: source.id,
          originalUrl: "https://metrics.example.com/single-high",
          canonicalUrl: "https://metrics.example.com/single-high",
          urlHash: "hash-metrics-single-high",
          originalTitle: "Single High",
          publishedAt: new Date("2026-04-29T08:00:00.000Z"),
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 98,
          qualityRationale: "非常高质量",
          language: "en",
        },
        {
          id: "metrics-single-mid",
          sourceId: source.id,
          originalUrl: "https://metrics.example.com/single-mid",
          canonicalUrl: "https://metrics.example.com/single-mid",
          urlHash: "hash-metrics-single-mid",
          originalTitle: "Single Mid",
          publishedAt: new Date("2026-04-29T07:00:00.000Z"),
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 75,
          qualityRationale: "中高质量",
          language: "en",
        },
      ],
    });
    await refreshClusterFeedStats(["metrics-cluster"]);

    const metrics = await getIngestionMetrics(1);
    const countByRange = new Map(metrics.qualityScoreDistribution.map((bucket) => [bucket.range, bucket.count]));

    expect(countByRange.get("70-79")).toBe(1);
    expect(countByRange.get("80-89")).toBe(0);
    expect(countByRange.get("90-100")).toBe(2);
  });
});

describe("ingestion metrics service - AI usage aggregation", () => {
  beforeEach(async () => {
    await prisma.backgroundTaskRun.deleteMany();
  });

  function makeTaskRun(overrides: {
    kind: string;
    status?: string;
    createdAt: Date;
    aiCallCountActual: number;
    breakdownKeys?: string[];
  }) {
    const breakdown = (overrides.breakdownKeys ?? []).map((key) => ({
      key,
      label: key,
      actual: 1,
      estimated: 1,
    }));
    return prisma.backgroundTaskRun.create({
      data: {
        kind: overrides.kind as never,
        triggerType: "scheduled",
        status: (overrides.status ?? "succeeded") as never,
        label: overrides.kind,
        aiCallCountActual: overrides.aiCallCountActual,
        aiCallBreakdownJson: JSON.stringify(breakdown),
        createdAt: overrides.createdAt,
      },
    });
  }

  it("aggregates AI call counts across ingestion, item, cluster and daily report task kinds", async () => {
    const today = new Date("2026-06-16T10:00:00.000Z");
    const yesterday = new Date("2026-06-15T10:00:00.000Z");

    // ingestion task with one unified item understanding + cluster merge
    await makeTaskRun({
      kind: "ingestion",
      createdAt: today,
      aiCallCountActual: 2,
      breakdownKeys: ["item_understanding", "cluster_merge"],
    });
    // daily report task with daily_report
    await makeTaskRun({
      kind: "daily_report_generate",
      createdAt: today,
      aiCallCountActual: 2,
      breakdownKeys: ["daily_report", "daily_report"],
    });
    // cluster summary task with cluster_summary
    await makeTaskRun({
      kind: "cluster_regenerate_summary",
      createdAt: today,
      aiCallCountActual: 1,
      breakdownKeys: ["cluster_summary"],
    });
    // item reanalyze task with unified understanding + cluster match
    await makeTaskRun({
      kind: "item_reanalyze",
      createdAt: yesterday,
      aiCallCountActual: 2,
      breakdownKeys: ["item_understanding", "cluster_match"],
    });
    // item aggregation reparse task with unified understanding
    await makeTaskRun({
      kind: "item_reparse_aggregations",
      createdAt: yesterday,
      aiCallCountActual: 5,
      breakdownKeys: ["item_understanding", "item_understanding", "item_understanding", "item_understanding", "item_understanding"],
    });
    // ingestion task that failed after partial work should still be counted
    await makeTaskRun({
      kind: "ingestion",
      status: "failed",
      createdAt: yesterday,
      aiCallCountActual: 2,
      breakdownKeys: ["item_understanding", "cluster_match"],
    });
    // irrelevant task (no AI calls) should be excluded by the in-list filter
    await makeTaskRun({
      kind: "item_cleanup",
      createdAt: today,
      aiCallCountActual: 0,
      breakdownKeys: [],
    });
    // queued task should be excluded by the status filter
    await makeTaskRun({
      kind: "ingestion",
      status: "queued",
      createdAt: today,
      aiCallCountActual: 0,
      breakdownKeys: [],
    });

    const metrics = await getIngestionMetrics(30);
    const todayKey = today.toISOString().slice(0, 10);
    const yesterdayKey = yesterday.toISOString().slice(0, 10);

    const todayStat = metrics.dailyAiUsageStats.find((s) => s.date === todayKey);
    const yesterdayStat = metrics.dailyAiUsageStats.find((s) => s.date === yesterdayKey);

    expect(todayStat).toBeDefined();
    expect(todayStat).toMatchObject({
      date: todayKey,
      totalCalls: 5, // 2 ingestion + 2 daily report + 1 cluster summary
      itemUnderstandings: 1,
      clusterMatches: 0,
      clusterMerges: 1, // cluster_merge from ingestion
      clusterSummaries: 1, // cluster_summary from cluster regen task
      dailyReports: 2, // daily_report x2
    });

    expect(yesterdayStat).toBeDefined();
    expect(yesterdayStat).toMatchObject({
      date: yesterdayKey,
      totalCalls: 9, // 2 reanalyze + 5 reparse + 2 failed ingestion
      itemUnderstandings: 7,
      clusterMatches: 2, // cluster_match from reanalyze + failed ingestion
      clusterMerges: 0,
      clusterSummaries: 0,
      dailyReports: 0,
    });
  });

  it("returns zero counts for dates with no qualifying task runs", async () => {
    const today = new Date("2026-06-16T10:00:00.000Z");
    // Only an irrelevant task kind, no AI-relevant rows
    await makeTaskRun({
      kind: "item_cleanup",
      createdAt: today,
      aiCallCountActual: 0,
      breakdownKeys: [],
    });

    const metrics = await getIngestionMetrics(7);
    for (const stat of metrics.dailyAiUsageStats) {
      expect(stat.totalCalls).toBe(0);
      expect(stat.itemUnderstandings).toBe(0);
      expect(stat.clusterMatches).toBe(0);
      expect(stat.clusterMerges).toBe(0);
      expect(stat.clusterSummaries).toBe(0);
      expect(stat.dailyReports).toBe(0);
    }
  });
});
