import { beforeEach, describe, expect, it } from "vitest";

import { getActionableMonitorSnapshot } from "@/lib/admin/actionable-monitor";
import { prisma } from "@/lib/db";

describe("actionable monitor snapshot", () => {
  beforeEach(async () => {
    await prisma.clusterDecision.deleteMany();
    await prisma.tagSuggestionCandidate.deleteMany();
    await prisma.itemTag.deleteMany();
    await prisma.item.deleteMany();
    await prisma.tag.deleteMany();
    await prisma.contentCluster.deleteMany();
    await prisma.backgroundTaskRun.deleteMany();
    await prisma.source.deleteMany();
  });

  it("summarizes source, tag, cluster, and task action items", async () => {
    await prisma.source.create({
      data: {
        id: "source-failed",
        name: "Broken RSS",
        rssUrl: "https://broken.example.com/feed.xml",
        siteUrl: "https://broken.example.com",
        enabled: true,
        healthStatus: "failed",
        healthMessage: "HTTP 500",
        healthCheckedAt: new Date("2026-06-30T00:00:00.000Z"),
      },
    });
    await prisma.item.create({
      data: {
        id: "filtered-item",
        sourceId: "source-failed",
        originalUrl: "https://broken.example.com/filtered",
        canonicalUrl: "https://broken.example.com/filtered",
        urlHash: "filtered-item",
        originalTitle: "Filtered story",
        translatedTitle: "被过滤内容",
        publishedAt: new Date("2026-06-29T08:00:00.000Z"),
        status: "filtered",
        moderationStatus: "filtered",
        moderationReason: "low_quality",
        moderationDetail: "信息密度不足",
        createdAt: new Date("2026-06-29T09:00:00.000Z"),
        updatedAt: new Date("2026-06-29T09:00:00.000Z"),
      },
    });
    await prisma.item.create({
      data: {
        id: "old-filtered-item",
        sourceId: "source-failed",
        originalUrl: "https://broken.example.com/old-filtered",
        canonicalUrl: "https://broken.example.com/old-filtered",
        urlHash: "old-filtered-item",
        originalTitle: "Old filtered story",
        translatedTitle: "较早过滤内容",
        publishedAt: new Date("2026-06-28T12:00:00.000Z"),
        status: "filtered",
        moderationStatus: "filtered",
        moderationReason: "low_quality",
        moderationDetail: "信息密度不足",
        createdAt: new Date("2026-06-28T12:00:00.000Z"),
        updatedAt: new Date("2026-06-28T12:00:00.000Z"),
      },
    });
    await prisma.item.create({
      data: {
        id: "split-parent",
        sourceId: "source-failed",
        originalUrl: "https://broken.example.com/split",
        canonicalUrl: "https://broken.example.com/split",
        urlHash: "split-parent",
        originalTitle: "Aggregation story",
        translatedTitle: "聚合内容",
        publishedAt: new Date("2026-06-29T09:00:00.000Z"),
        status: "processed",
        moderationStatus: "allowed",
        isAggregation: true,
        aggregationParseStatus: "failed",
        aggregationCheckedAt: new Date("2026-06-29T10:00:00.000Z"),
        createdAt: new Date("2026-06-29T10:00:00.000Z"),
        updatedAt: new Date("2026-06-29T10:00:00.000Z"),
      },
    });
    const sourceTag = await prisma.tag.create({
      data: {
        name: "AI Agents",
        normalized: "ai agents",
      },
    });
    const targetTag = await prisma.tag.create({
      data: {
        name: "AI Agent",
        normalized: "ai agent",
      },
    });
    await prisma.tagSuggestionCandidate.create({
      data: {
        pairKey: "ai-agents::ai-agent",
        sourceTagId: sourceTag.id,
        targetTagId: targetTag.id,
        sourceTagNormalized: sourceTag.normalized,
        targetTagNormalized: targetTag.normalized,
        confidence: 0.99,
        affectedItemCount: 4,
        sharedItemCount: 2,
        reason: "singular_match",
        status: "active",
        expiresAt: new Date("2026-07-07T00:00:00.000Z"),
        createdAt: new Date("2026-06-29T11:00:00.000Z"),
        updatedAt: new Date("2026-06-29T11:00:00.000Z"),
      },
    });
    await prisma.contentCluster.createMany({
      data: [
        {
          id: "cluster-left",
          kind: "topic",
          title: "Model launch",
          summary: "left",
          score: 80,
          itemCount: 3,
          latestPublishedAt: new Date("2026-06-29T00:00:00.000Z"),
          status: "active",
          fingerprint: "cluster-left",
        },
        {
          id: "cluster-right",
          kind: "topic",
          title: "Model release",
          summary: "right",
          score: 78,
          itemCount: 1,
          latestPublishedAt: new Date("2026-06-29T00:00:00.000Z"),
          status: "active",
          fingerprint: "cluster-right",
        },
      ],
    });
    await prisma.clusterDecision.create({
      data: {
        id: "decision-cluster",
        kind: "cluster_pair",
        source: "llm",
        verdict: "ambiguous",
        leftClusterId: "cluster-left",
        rightClusterId: "cluster-right",
        pairKey: "cluster-left::cluster-right",
        inputHash: "input-hash",
        confidence: 91,
        reasonText: "主体接近",
        createdAt: new Date("2026-06-29T12:00:00.000Z"),
        updatedAt: new Date("2026-06-29T12:00:00.000Z"),
      },
    });
    await prisma.backgroundTaskRun.create({
      data: {
        id: "task-failed",
        kind: "ingestion",
        triggerType: "scheduled",
        status: "failed",
        label: "默认抓取任务",
        errorSummary: "RSS fetch failed",
        startedAt: new Date("2026-06-29T23:00:00.000Z"),
        createdAt: new Date("2026-06-29T23:00:00.000Z"),
      },
    });

    const snapshot = await getActionableMonitorSnapshot(new Date("2026-06-30T00:00:00.000Z"), {
      rangeDays: 1,
    });

    expect(snapshot.rangeDays).toBe(1);
    expect(snapshot.since).toBe("2026-06-29T00:00:00.000Z");
    expect(snapshot.totalCount).toBe(6);
    expect(snapshot.criticalCount).toBe(2);
    expect(snapshot.warningCount).toBe(3);
    expect(snapshot.items.map((item) => item.id)).toEqual([
      "sources",
      "filtered-content",
      "tags",
      "aggregation-splits",
      "clusters",
      "tasks",
    ]);
    expect(snapshot.items.find((item) => item.id === "filtered-content")?.count).toBe(1);
    expect(snapshot.items.find((item) => item.id === "filtered-content")?.description).toContain("近 1 天");
    expect(snapshot.items.find((item) => item.id === "aggregation-splits")?.description).toContain("失败 1 条");
    expect(snapshot.items.find((item) => item.id === "tags")?.description).toContain("当前有 1 条标签建议");
    expect(snapshot.items.find((item) => item.id === "sources")?.href).toBe(
      "/admin?tab=monitoring&section=dashboard&sourceSummary=open",
    );

    const threeDaySnapshot = await getActionableMonitorSnapshot(new Date("2026-06-30T00:00:00.000Z"), {
      rangeDays: 3,
    });
    expect(threeDaySnapshot.rangeDays).toBe(3);
    expect(threeDaySnapshot.items.find((item) => item.id === "filtered-content")?.count).toBe(2);
  });
});
