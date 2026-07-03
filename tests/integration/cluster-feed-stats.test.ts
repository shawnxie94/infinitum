import { beforeEach, describe, expect, it } from "vitest";

import { refreshClusterFeedStats } from "@/lib/clusters/feed-stats";
import { prisma } from "@/lib/db";
import { replaceItemTags } from "@/lib/tags/service";

describe("cluster feed stats", () => {
  beforeEach(async () => {
    await prisma.item.deleteMany();
    await prisma.tag.deleteMany();
    await prisma.contentCluster.deleteMany();
    await prisma.source.deleteMany();
    await prisma.sourceGroup.deleteMany();
  });

  it("precomputes display stats from public child items only", async () => {
    const [aiGroup, researchGroup] = await Promise.all([
      prisma.sourceGroup.create({ data: { id: "stats-ai", name: "AI", sortOrder: 1 } }),
      prisma.sourceGroup.create({ data: { id: "stats-research", name: "Research", sortOrder: 2 } }),
    ]);
    const [aiSource, researchSource, disabledSource] = await Promise.all([
      prisma.source.create({
        data: {
          id: "stats-ai-source",
          name: "AI Feed",
          rssUrl: "https://stats-ai.example.com/feed.xml",
          siteUrl: "https://stats-ai.example.com",
          groupId: aiGroup.id,
          enabled: true,
          aiParsingEnabled: true,
        },
      }),
      prisma.source.create({
        data: {
          id: "stats-research-source",
          name: "Research Feed",
          rssUrl: "https://stats-research.example.com/feed.xml",
          siteUrl: "https://stats-research.example.com",
          groupId: researchGroup.id,
          enabled: true,
          aiParsingEnabled: true,
        },
      }),
      prisma.source.create({
        data: {
          id: "stats-disabled-source",
          name: "Disabled Feed",
          rssUrl: "https://stats-disabled.example.com/feed.xml",
          siteUrl: "https://stats-disabled.example.com",
          enabled: false,
          aiParsingEnabled: true,
        },
      }),
    ]);

    await prisma.contentCluster.create({
      data: {
        id: "stats-cluster",
        kind: "topic",
        title: "Stats Cluster",
        summary: "Stats summary",
        score: 50,
        itemCount: 5,
        latestPublishedAt: new Date("2026-04-10T10:00:00.000Z"),
        status: "active",
        fingerprint: "stats-cluster",
      },
    });
    await prisma.item.createMany({
      data: [
        {
          id: "stats-visible-ai",
          sourceId: aiSource.id,
          clusterId: "stats-cluster",
          originalUrl: "https://stats.example.com/ai",
          canonicalUrl: "https://stats.example.com/ai",
          urlHash: "stats-visible-ai",
          originalTitle: "Visible AI",
          publishedAt: new Date("2026-04-10T10:00:00.000Z"),
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 80,
          qualityRationale: "ok",
          language: "en",
          createdAt: new Date("2026-04-10T10:05:00.000Z"),
        },
        {
          id: "stats-visible-research",
          sourceId: researchSource.id,
          clusterId: "stats-cluster",
          originalUrl: "https://stats.example.com/research",
          canonicalUrl: "https://stats.example.com/research",
          urlHash: "stats-visible-research",
          originalTitle: "Visible Research",
          publishedAt: new Date("2026-04-10T09:00:00.000Z"),
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 60,
          qualityRationale: "ok",
          language: "en",
          createdAt: new Date("2026-04-10T09:05:00.000Z"),
        },
        {
          id: "stats-filtered",
          sourceId: aiSource.id,
          clusterId: "stats-cluster",
          originalUrl: "https://stats.example.com/filtered",
          canonicalUrl: "https://stats.example.com/filtered",
          urlHash: "stats-filtered",
          originalTitle: "Filtered",
          publishedAt: new Date("2026-04-10T11:00:00.000Z"),
          status: "processed",
          moderationStatus: "filtered",
          qualityScore: 100,
          qualityRationale: "filtered",
          language: "en",
        },
        {
          id: "stats-disabled",
          sourceId: disabledSource.id,
          clusterId: "stats-cluster",
          originalUrl: "https://stats.example.com/disabled",
          canonicalUrl: "https://stats.example.com/disabled",
          urlHash: "stats-disabled",
          originalTitle: "Disabled",
          publishedAt: new Date("2026-04-10T12:00:00.000Z"),
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 100,
          qualityRationale: "disabled",
          language: "en",
        },
        {
          id: "stats-aggregation-parent",
          sourceId: aiSource.id,
          clusterId: "stats-cluster",
          originalUrl: "https://stats.example.com/parent",
          canonicalUrl: "https://stats.example.com/parent",
          urlHash: "stats-parent",
          originalTitle: "Parent",
          publishedAt: new Date("2026-04-10T13:00:00.000Z"),
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 100,
          qualityRationale: "parent",
          language: "en",
          isAggregation: true,
        },
      ],
    });
    await replaceItemTags("stats-visible-ai", ["OpenAI", "Agents"]);
    await replaceItemTags("stats-visible-research", ["OpenAI", "Benchmarks"]);

    await refreshClusterFeedStats(["stats-cluster"]);

    const cluster = await prisma.contentCluster.findUniqueOrThrow({
      where: { id: "stats-cluster" },
    });
    const tags = JSON.parse(cluster.feedTagsJson) as Array<{ name: string; normalized: string }>;

    expect(cluster).toMatchObject({
      displayItemCount: 2,
      displaySourceCount: 2,
      displayAverageScore: 70,
      earliestCreatedAt: new Date("2026-04-10T09:05:00.000Z"),
      latestCreatedAt: new Date("2026-04-10T10:05:00.000Z"),
      latestPublishedAt: new Date("2026-04-10T10:00:00.000Z"),
      dominantGroupId: researchGroup.id,
    });
    expect(cluster.displayQualityScore).toBe(70);
    expect(tags.map((tag) => tag.normalized)).toEqual(["agents", "benchmarks", "openai"]);
    expect(cluster.feedSearchText).toContain("OpenAI");
    expect(cluster.feedStatsUpdatedAt).toBeInstanceOf(Date);
  });
});
