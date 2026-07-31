import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AiProvider } from "@/lib/ai/provider";
import { CLUSTER_MERGE_SCAN_CLUSTER_LIMIT } from "@/config/constants";
import {
  assignItemToCluster,
  detachItemFromCluster,
  executeClusterMerge,
  mergeClusters,
  mergeSelectedItemsToLargestCluster,
  precomputeClusterMergeCleanPairs,
  splitClusterIntoSingletons,
} from "@/lib/clusters/service";
import { prisma } from "@/lib/db";
import { getAdminCluster } from "@/lib/feed/repository";

describe("cluster assignment", () => {
  beforeEach(async () => {
    await prisma.backgroundTaskRun.deleteMany();
    await prisma.clusterDecision.deleteMany();
    await prisma.clusterConstraint.deleteMany();
    await prisma.clusterMergeCleanPairCandidate.deleteMany();
    await prisma.item.deleteMany();
    await prisma.contentCluster.deleteMany();
    await prisma.source.deleteMany();
  });

  it("limits cluster merge scans before local pair scoring", async () => {
    const executeRawSpy = vi.spyOn(prisma, "$executeRaw").mockResolvedValue(0);
    const findManySpy = vi.spyOn(prisma.contentCluster, "findMany").mockResolvedValue([]);

    try {
      const result = await executeClusterMerge(undefined, new Date("2026-04-21T10:00:00.000Z"));

      expect(result).toMatchObject({
        baseClusters: 0,
        skipped: true,
      });
      expect(findManySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [
            { latestPublishedAt: "desc" },
            { updatedAt: "desc" },
            { itemCount: "desc" },
            { id: "asc" },
          ],
          take: CLUSTER_MERGE_SCAN_CLUSTER_LIMIT,
        }),
      );
    } finally {
      executeRawSpy.mockRestore();
      findManySpy.mockRestore();
    }
  });

  it("keeps sources with aggregation disabled out of cluster matching", async () => {
    const [aggregatingSource, isolatedSource] = await Promise.all([
      prisma.source.create({
        data: {
          name: "Aggregating Feed",
          rssUrl: "https://aggregating.example.com/feed.xml",
          siteUrl: "https://aggregating.example.com",
          enabled: true,
          aiParsingEnabled: true,
          aggregationEnabled: true,
        },
      }),
      prisma.source.create({
        data: {
          name: "Isolated Feed",
          rssUrl: "https://isolated.example.com/feed.xml",
          siteUrl: "https://isolated.example.com",
          enabled: true,
          aiParsingEnabled: true,
          aggregationEnabled: false,
        },
      }),
    ]);
    const eventSignature = {
      eventType: "release" as const,
      eventSubject: "Acme",
      eventAction: "发布",
      eventObject: "Widget",
      eventDate: "2026-04-20",
    };
    const baseItemData = {
      originalTitle: "Acme 发布 Widget",
      translatedTitle: "Acme 发布 Widget",
      author: null,
      publishedAt: new Date("2026-04-20T08:00:00.000Z"),
      rssExcerpt: "Acme 发布 Widget",
      rssContent: "Acme 发布 Widget",
      fullText: null,
      summaryText: "Acme 发布 Widget",
      language: "zh",
      status: "processed" as const,
      summaryStatus: "succeeded" as const,
      analysisStatus: "succeeded" as const,
      moderationStatus: "allowed" as const,
      qualityScore: 80,
      qualityRationale: "relevant",
      eventType: eventSignature.eventType,
      eventSubject: eventSignature.eventSubject,
      eventAction: eventSignature.eventAction,
      eventObject: eventSignature.eventObject,
      eventDate: eventSignature.eventDate,
    };

    const firstItem = await prisma.item.create({
      data: {
        ...baseItemData,
        sourceId: aggregatingSource.id,
        originalUrl: "https://aggregating.example.com/acme-widget",
        canonicalUrl: "https://aggregating.example.com/acme-widget",
        urlHash: "aggregating-acme-widget",
      },
    });
    const firstAssignment = await assignItemToCluster(firstItem.id, { eventSignature });
    const secondItem = await prisma.item.create({
      data: {
        ...baseItemData,
        sourceId: isolatedSource.id,
        originalUrl: "https://isolated.example.com/acme-widget",
        canonicalUrl: "https://isolated.example.com/acme-widget",
        urlHash: "isolated-acme-widget",
      },
    });

    const secondAssignment = await assignItemToCluster(secondItem.id, { eventSignature });

    expect(secondAssignment.matchSource).toBeNull();
    expect(secondAssignment.createdNewCluster).toBe(true);
    expect(secondAssignment.clusterId).not.toBe(firstAssignment.clusterId);
    await expect(prisma.contentCluster.count()).resolves.toBe(2);
  });

  it("does not use title fallback across incompatible event dates", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Date Guard Feed",
        rssUrl: "https://date-guard.example.com/feed.xml",
        siteUrl: "https://date-guard.example.com",
        enabled: true,
        aiParsingEnabled: true,
        aggregationEnabled: true,
      },
    });
    const baseItemData = {
      originalTitle: "Acme 发布 Widget",
      translatedTitle: "Acme 发布 Widget",
      author: null,
      publishedAt: new Date("2026-04-20T08:00:00.000Z"),
      rssExcerpt: "Acme 发布 Widget",
      rssContent: "Acme 发布 Widget",
      fullText: null,
      summaryText: "Acme 发布 Widget",
      language: "zh",
      status: "processed" as const,
      summaryStatus: "succeeded" as const,
      analysisStatus: "succeeded" as const,
      moderationStatus: "allowed" as const,
      qualityScore: 80,
      qualityRationale: "relevant",
      eventType: "launch",
      eventSubject: "Acme",
      eventAction: "发布",
      eventObject: "Widget",
    };

    const firstItem = await prisma.item.create({
      data: {
        ...baseItemData,
        sourceId: source.id,
        eventDate: "2026-04-10",
        originalUrl: "https://date-guard.example.com/acme-widget-april",
        canonicalUrl: "https://date-guard.example.com/acme-widget-april",
        urlHash: "date-guard-april",
      },
    });
    const firstAssignment = await assignItemToCluster(firstItem.id, {
      eventSignature: {
        eventType: "launch",
        eventSubject: "Acme",
        eventAction: "发布",
        eventObject: "Widget",
        eventDate: "2026-04-10",
      },
    });

    const secondItem = await prisma.item.create({
      data: {
        ...baseItemData,
        sourceId: source.id,
        eventDate: "2026-05-10",
        originalUrl: "https://date-guard.example.com/acme-widget-may",
        canonicalUrl: "https://date-guard.example.com/acme-widget-may",
        urlHash: "date-guard-may",
      },
    });
    const secondAssignment = await assignItemToCluster(secondItem.id, {
      eventSignature: {
        eventType: "launch",
        eventSubject: "Acme",
        eventAction: "发布",
        eventObject: "Widget",
        eventDate: "2026-05-10",
      },
    });

    expect(firstAssignment.clusterId).not.toBeNull();
    expect(secondAssignment.createdNewCluster).toBe(true);
    expect(secondAssignment.clusterId).not.toBe(firstAssignment.clusterId);
  });

  it("allows aggregation split children from disabled sources to join clusters", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Split Only Feed",
        rssUrl: "https://split-only.example.com/feed.xml",
        siteUrl: "https://split-only.example.com",
        enabled: true,
        aiParsingEnabled: true,
        aggregationEnabled: false,
        aggregationDetectionEnabled: true,
      },
    });
    const parent = await prisma.item.create({
      data: {
        sourceId: source.id,
        originalUrl: "https://split-only.example.com/roundup",
        canonicalUrl: "https://split-only.example.com/roundup",
        urlHash: "split-only-roundup",
        originalTitle: "Split only roundup",
        translatedTitle: null,
        author: null,
        publishedAt: new Date("2026-04-20T08:00:00.000Z"),
        rssExcerpt: null,
        rssContent: "Acme 发布 Widget。Acme 发布 Widget。",
        fullText: null,
        summaryText: "聚合父项",
        language: "zh",
        status: "processed",
        summaryStatus: "succeeded",
        analysisStatus: "succeeded",
        moderationStatus: "allowed",
        qualityScore: 70,
        qualityRationale: "aggregation parent",
        isAggregation: true,
      },
    });
    const eventSignature = {
      eventType: "release" as const,
      eventSubject: "Acme",
      eventAction: "发布",
      eventObject: "Widget",
      eventDate: "2026-04-20",
    };
    const childBaseData = {
      sourceId: source.id,
      parentItemId: parent.id,
      translatedTitle: null,
      author: null,
      publishedAt: new Date("2026-04-20T08:00:00.000Z"),
      rssExcerpt: null,
      rssContent: null,
      fullText: null,
      summaryText: "Acme 发布 Widget",
      language: "zh",
      status: "processed" as const,
      summaryStatus: "succeeded" as const,
      analysisStatus: "succeeded" as const,
      moderationStatus: "allowed" as const,
      qualityScore: 88,
      qualityRationale: "由聚合内容拆出",
      eventType: eventSignature.eventType,
      eventSubject: eventSignature.eventSubject,
      eventAction: eventSignature.eventAction,
      eventObject: eventSignature.eventObject,
      eventDate: eventSignature.eventDate,
      isAggregation: false,
    };
    const firstChild = await prisma.item.create({
      data: {
        ...childBaseData,
        originalUrl: "https://split-only.example.com/roundup#event-1",
        canonicalUrl: "https://split-only.example.com/roundup",
        urlHash: "split-only-child-1",
        originalTitle: "Acme 发布 Widget",
      },
    });
    const firstAssignment = await assignItemToCluster(firstChild.id, {
      eventSignature,
      aggregationEnabled: true,
    });
    const secondChild = await prisma.item.create({
      data: {
        ...childBaseData,
        originalUrl: "https://split-only.example.com/roundup#event-2",
        canonicalUrl: "https://split-only.example.com/roundup",
        urlHash: "split-only-child-2",
        originalTitle: "Acme 发布 Widget follow-up",
      },
    });

    const secondAssignment = await assignItemToCluster(secondChild.id, {
      eventSignature,
      aggregationEnabled: true,
    });

    expect(firstAssignment.createdNewCluster).toBe(true);
    expect(secondAssignment.matchSource).toBe("exact_match");
    expect(secondAssignment.createdNewCluster).toBe(false);
    expect(secondAssignment.clusterId).toBe(firstAssignment.clusterId);
    await expect(prisma.contentCluster.count()).resolves.toBe(1);
  });

  it("joins an active cluster with the same generated title even when fingerprints differ", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Aggregating Feed",
        rssUrl: "https://title-match.example.com/feed.xml",
        siteUrl: "https://title-match.example.com",
        enabled: true,
        aiParsingEnabled: true,
        aggregationEnabled: true,
      },
    });
    await prisma.contentCluster.create({
      data: {
        id: "cluster-title-match",
        kind: "topic",
        title: "Acme 发布 Widget",
        summary: "已有聚合",
        score: 80,
        itemCount: 1,
        latestPublishedAt: new Date("2026-04-20T08:00:00.000Z"),
        status: "active",
        fingerprint: "legacy-fingerprint",
      },
    });
    await prisma.item.create({
      data: {
        id: "title-seed-item",
        sourceId: source.id,
        clusterId: "cluster-title-match",
        originalUrl: "https://title-match.example.com/seed",
        canonicalUrl: "https://title-match.example.com/seed",
        urlHash: "title-seed-hash",
        originalTitle: "Acme 发布 Widget",
        translatedTitle: "Acme 发布 Widget",
        publishedAt: new Date("2026-04-20T08:00:00.000Z"),
        summaryText: "已有条目",
        language: "zh",
        status: "processed",
        moderationStatus: "allowed",
        qualityScore: 80,
        qualityRationale: "relevant",
      },
    });
    const item = await prisma.item.create({
      data: {
        id: "title-new-item",
        sourceId: source.id,
        originalUrl: "https://title-match.example.com/new",
        canonicalUrl: "https://title-match.example.com/new",
        urlHash: "title-new-hash",
        originalTitle: "Acme launches Widget",
        translatedTitle: "Acme 发布 Widget",
        publishedAt: new Date("2026-04-20T09:00:00.000Z"),
        summaryText: "新条目",
        language: "en",
        status: "processed",
        moderationStatus: "allowed",
        qualityScore: 82,
        qualityRationale: "relevant",
      },
    });

    const assignment = await assignItemToCluster(item.id, {
      eventSignature: {
        eventType: "launch",
        eventSubject: "Acme",
        eventAction: "发布",
        eventObject: "Widget",
        eventDate: "2026-04-20",
      },
    });

    expect(assignment.clusterId).toBe("cluster-title-match");
    expect(assignment.matchSource).toBe("exact_match");
    await expect(prisma.contentCluster.count()).resolves.toBe(1);
    await expect(prisma.item.findUnique({ where: { id: item.id } })).resolves.toMatchObject({
      clusterId: "cluster-title-match",
    });
  });

  it("does not attach same-signature undated events to a previous week cluster", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Weekly Identity Feed",
        rssUrl: "https://weekly-identity.example.com/feed.xml",
        siteUrl: "https://weekly-identity.example.com",
        enabled: true,
        aiParsingEnabled: true,
        aggregationEnabled: true,
      },
    });
    const eventSignature = {
      eventType: "launch" as const,
      eventSubject: "Acme",
      eventAction: "发布",
      eventObject: "Widget",
      eventDate: null,
    };
    const firstItem = await prisma.item.create({
      data: {
        sourceId: source.id,
        originalUrl: "https://weekly-identity.example.com/first",
        canonicalUrl: "https://weekly-identity.example.com/first",
        urlHash: "weekly-identity-first",
        originalTitle: "Acme 发布 Widget",
        publishedAt: new Date("2026-04-20T08:00:00.000Z"),
        summaryText: "Acme 发布 Widget。",
        language: "zh",
        status: "processed",
        moderationStatus: "allowed",
        qualityScore: 80,
        qualityRationale: "relevant",
        eventType: eventSignature.eventType,
        eventSubject: eventSignature.eventSubject,
        eventAction: eventSignature.eventAction,
        eventObject: eventSignature.eventObject,
      },
    });
    const secondItem = await prisma.item.create({
      data: {
        sourceId: source.id,
        originalUrl: "https://weekly-identity.example.com/second",
        canonicalUrl: "https://weekly-identity.example.com/second",
        urlHash: "weekly-identity-second",
        originalTitle: "Acme 发布 Widget",
        publishedAt: new Date("2026-04-28T08:00:00.000Z"),
        summaryText: "Acme 发布 Widget。",
        language: "zh",
        status: "processed",
        moderationStatus: "allowed",
        qualityScore: 80,
        qualityRationale: "relevant",
        eventType: eventSignature.eventType,
        eventSubject: eventSignature.eventSubject,
        eventAction: eventSignature.eventAction,
        eventObject: eventSignature.eventObject,
      },
    });

    const firstAssignment = await assignItemToCluster(firstItem.id, { eventSignature });
    const secondAssignment = await assignItemToCluster(secondItem.id, { eventSignature });

    expect(firstAssignment.clusterId).toBeTruthy();
    expect(secondAssignment.clusterId).toBeTruthy();
    expect(secondAssignment.clusterId).not.toBe(firstAssignment.clusterId);

    const clusters = await prisma.contentCluster.findMany({
      orderBy: { latestPublishedAt: "asc" },
      select: { eventBucket: true, eventFingerprint: true, fingerprint: true },
    });
    expect(clusters).toHaveLength(2);
    expect(clusters[0]?.eventBucket).toBe("week:2026-04-20");
    expect(clusters[1]?.eventBucket).toBe("week:2026-04-27");
    expect(clusters[0]?.eventFingerprint).toBe(clusters[1]?.eventFingerprint);
    expect(clusters[0]?.fingerprint).not.toBe(clusters[1]?.fingerprint);
  });

  it("deletes merged clusters, transfers their items and refreshes target counts", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Merge Feed",
        rssUrl: "https://merge.example.com/feed.xml",
        siteUrl: "https://merge.example.com",
        enabled: true,
        aiParsingEnabled: true,
        aggregationEnabled: true,
      },
    });
    await prisma.contentCluster.createMany({
      data: [
        {
          id: "cluster-target",
          kind: "topic",
          title: "目标聚合",
          summary: "目标摘要",
          score: 70,
          itemCount: 1,
          latestPublishedAt: new Date("2026-04-20T10:00:00.000Z"),
          status: "active",
          fingerprint: "merge-target",
        },
        {
          id: "cluster-source",
          kind: "topic",
          title: "目标聚合",
          summary: "源摘要",
          score: 80,
          itemCount: 2,
          latestPublishedAt: new Date("2026-04-20T09:00:00.000Z"),
          status: "active",
          fingerprint: "merge-source",
        },
      ],
    });
    await prisma.item.createMany({
      data: [
        {
          id: "merge-target-item",
          sourceId: source.id,
          clusterId: "cluster-target",
          originalUrl: "https://merge.example.com/target",
          canonicalUrl: "https://merge.example.com/target",
          urlHash: "merge-target-hash",
          originalTitle: "目标条目",
          publishedAt: new Date("2026-04-20T10:00:00.000Z"),
          summaryText: "目标条目摘要",
          language: "zh",
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 70,
          qualityRationale: "relevant",
        },
        {
          id: "merge-source-item-1",
          sourceId: source.id,
          clusterId: "cluster-source",
          originalUrl: "https://merge.example.com/source-1",
          canonicalUrl: "https://merge.example.com/source-1",
          urlHash: "merge-source-hash-1",
          originalTitle: "源条目 1",
          publishedAt: new Date("2026-04-20T09:00:00.000Z"),
          summaryText: "源条目摘要 1",
          language: "zh",
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 82,
          qualityRationale: "relevant",
        },
        {
          id: "merge-source-item-2",
          sourceId: source.id,
          clusterId: "cluster-source",
          originalUrl: "https://merge.example.com/source-2",
          canonicalUrl: "https://merge.example.com/source-2",
          urlHash: "merge-source-hash-2",
          originalTitle: "源条目 2",
          publishedAt: new Date("2026-04-20T08:00:00.000Z"),
          summaryText: "源条目摘要 2",
          language: "zh",
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 78,
          qualityRationale: "relevant",
        },
      ],
    });

    const result = await mergeClusters("cluster-target", ["cluster-source"]);

    expect(result).toMatchObject({
      targetClusterId: "cluster-target",
      mergedClusterIds: ["cluster-source"],
      itemsMoved: 2,
    });
    await expect(prisma.contentCluster.findUnique({ where: { id: "cluster-source" } })).resolves.toBeNull();
    await expect(
      prisma.item.count({
        where: {
          id: { in: ["merge-target-item", "merge-source-item-1", "merge-source-item-2"] },
          clusterId: "cluster-target",
        },
      }),
    ).resolves.toBe(3);
    await expect(prisma.contentCluster.findUnique({ where: { id: "cluster-target" } })).resolves.toMatchObject({
      itemCount: 3,
      score: 82,
    });
    await expect(getAdminCluster("cluster-target")).resolves.toMatchObject({
      itemCount: 3,
      assignmentExplanation: {
        itemCount: 3,
        sourceCount: 1,
        reasons: expect.arrayContaining(["3 条内容被归入同一聚合组"]),
      },
    });
  });

  it("merges selected items into the largest selected cluster without moving unselected siblings", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Batch Merge Feed",
        rssUrl: "https://batch-merge.example.com/feed.xml",
        siteUrl: "https://batch-merge.example.com",
        enabled: true,
        aiParsingEnabled: true,
        aggregationEnabled: true,
      },
    });
    await prisma.contentCluster.createMany({
      data: [
        {
          id: "batch-target",
          kind: "topic",
          title: "目标大聚合",
          summary: "目标摘要",
          score: 80,
          itemCount: 3,
          latestPublishedAt: new Date("2026-04-20T10:00:00.000Z"),
          status: "active",
          fingerprint: "batch-target",
        },
        {
          id: "batch-source",
          kind: "topic",
          title: "来源聚合",
          summary: "来源摘要",
          score: 75,
          itemCount: 2,
          latestPublishedAt: new Date("2026-04-20T09:00:00.000Z"),
          status: "active",
          fingerprint: "batch-source",
        },
      ],
    });
    await prisma.item.createMany({
      data: [
        {
          id: "batch-target-item",
          sourceId: source.id,
          clusterId: "batch-target",
          originalUrl: "https://batch-merge.example.com/target",
          canonicalUrl: "https://batch-merge.example.com/target",
          urlHash: "batch-target-hash",
          originalTitle: "目标条目",
          publishedAt: new Date("2026-04-20T10:00:00.000Z"),
          summaryText: "目标条目摘要",
          language: "zh",
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 80,
          qualityRationale: "relevant",
        },
        {
          id: "batch-source-selected",
          sourceId: source.id,
          clusterId: "batch-source",
          originalUrl: "https://batch-merge.example.com/source-selected",
          canonicalUrl: "https://batch-merge.example.com/source-selected",
          urlHash: "batch-source-selected-hash",
          originalTitle: "选中来源条目",
          publishedAt: new Date("2026-04-20T09:00:00.000Z"),
          summaryText: "选中来源摘要",
          language: "zh",
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 75,
          qualityRationale: "relevant",
        },
        {
          id: "batch-source-unselected",
          sourceId: source.id,
          clusterId: "batch-source",
          originalUrl: "https://batch-merge.example.com/source-unselected",
          canonicalUrl: "https://batch-merge.example.com/source-unselected",
          urlHash: "batch-source-unselected-hash",
          originalTitle: "未选中来源条目",
          publishedAt: new Date("2026-04-20T08:00:00.000Z"),
          summaryText: "未选中来源摘要",
          language: "zh",
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 74,
          qualityRationale: "relevant",
        },
      ],
    });

    const result = await mergeSelectedItemsToLargestCluster(["batch-target-item", "batch-source-selected"]);

    expect(result).toMatchObject({
      targetClusterId: "batch-target",
      movedItemIds: ["batch-source-selected"],
      itemsMoved: 1,
    });
    await expect(prisma.item.findUnique({ where: { id: "batch-source-selected" } })).resolves.toMatchObject({
      clusterId: "batch-target",
      manualClusterAssignedAt: expect.any(Date),
    });
    await expect(prisma.item.findUnique({ where: { id: "batch-source-unselected" } })).resolves.toMatchObject({
      clusterId: "batch-source",
    });
    await expect(prisma.contentCluster.findUnique({ where: { id: "batch-target" } })).resolves.toMatchObject({
      itemCount: 2,
    });
    await expect(prisma.contentCluster.findUnique({ where: { id: "batch-source" } })).resolves.toMatchObject({
      itemCount: 1,
    });
  });

  it("keeps a detached item in a singleton cluster so it can enter later merge passes", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Detach Feed",
        rssUrl: "https://detach.example.com/feed.xml",
        siteUrl: "https://detach.example.com",
        enabled: true,
        aiParsingEnabled: true,
        aggregationEnabled: true,
      },
    });
    await prisma.contentCluster.create({
      data: {
        id: "detach-cluster",
        kind: "topic",
        title: "OpenAI 发布 Stargate 算力计划",
        summary: "OpenAI 发布 Stargate 算力基础设施计划。",
        score: 85,
        itemCount: 2,
        latestPublishedAt: new Date("2026-04-20T10:00:00.000Z"),
        status: "active",
        fingerprint: "detach-cluster",
      },
    });
    await prisma.item.createMany({
      data: [
        {
          id: "detach-target-item",
          sourceId: source.id,
          clusterId: "detach-cluster",
          originalUrl: "https://detach.example.com/target",
          canonicalUrl: "https://detach.example.com/target",
          urlHash: "detach-target-hash",
          originalTitle: "OpenAI 调整星际之门计划",
          publishedAt: new Date("2026-04-20T10:00:00.000Z"),
          summaryText: "OpenAI 调整星际之门计划和算力基础设施布局。",
          language: "zh",
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 85,
          qualityRationale: "relevant",
          eventType: "other",
          eventSubject: "OpenAI",
          eventAction: "调整战略",
          eventObject: "星际之门计划",
        },
        {
          id: "detach-sibling-item",
          sourceId: source.id,
          clusterId: "detach-cluster",
          originalUrl: "https://detach.example.com/sibling",
          canonicalUrl: "https://detach.example.com/sibling",
          urlHash: "detach-sibling-hash",
          originalTitle: "OpenAI 发布 Stargate 算力计划",
          publishedAt: new Date("2026-04-20T09:00:00.000Z"),
          summaryText: "OpenAI 发布 Stargate 算力基础设施计划。",
          language: "zh",
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 82,
          qualityRationale: "relevant",
          eventType: "release",
          eventSubject: "OpenAI",
          eventAction: "发布",
          eventObject: "Stargate算力基础设施计划",
        },
      ],
    });

    await detachItemFromCluster("detach-target-item");

    const detached = await prisma.item.findUniqueOrThrow({ where: { id: "detach-target-item" } });
    expect(detached.clusterId).toBeTruthy();
    expect(detached.clusterId).not.toBe("detach-cluster");
    await expect(prisma.contentCluster.findUnique({ where: { id: detached.clusterId! } })).resolves.toMatchObject({
      fingerprint: "single-detach-target-item",
      itemCount: 1,
      eventSubject: "OpenAI",
      eventObject: "星际之门计划",
    });
    await expect(prisma.contentCluster.findUnique({ where: { id: "detach-cluster" } })).resolves.toMatchObject({
      itemCount: 1,
    });
  });

  it("splits every item in a cluster into singleton clusters", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Split Feed",
        rssUrl: "https://split.example.com/feed.xml",
        siteUrl: "https://split.example.com",
        enabled: true,
        aiParsingEnabled: true,
        aggregationEnabled: true,
      },
    });
    await prisma.contentCluster.create({
      data: {
        id: "split-cluster",
        kind: "topic",
        title: "OpenAI 算力基础设施动态",
        summary: "OpenAI 算力基础设施动态聚合。",
        score: 86,
        itemCount: 3,
        latestPublishedAt: new Date("2026-04-20T10:00:00.000Z"),
        status: "active",
        fingerprint: "split-cluster",
      },
    });
    await prisma.item.createMany({
      data: [
        {
          id: "split-item-1",
          sourceId: source.id,
          clusterId: "split-cluster",
          originalUrl: "https://split.example.com/1",
          canonicalUrl: "https://split.example.com/1",
          urlHash: "split-hash-1",
          originalTitle: "OpenAI 调整星际之门计划",
          publishedAt: new Date("2026-04-20T10:00:00.000Z"),
          summaryText: "OpenAI 调整星际之门计划。",
          language: "zh",
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 86,
          qualityRationale: "relevant",
          eventSubject: "OpenAI",
          eventObject: "星际之门计划",
        },
        {
          id: "split-item-2",
          sourceId: source.id,
          clusterId: "split-cluster",
          originalUrl: "https://split.example.com/2",
          canonicalUrl: "https://split.example.com/2",
          urlHash: "split-hash-2",
          originalTitle: "为智能时代构建算力基础设施",
          publishedAt: new Date("2026-04-20T09:00:00.000Z"),
          summaryText: "为智能时代构建算力基础设施。",
          language: "zh",
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 82,
          qualityRationale: "relevant",
          eventSubject: "OpenAI",
          eventObject: "算力基础设施",
        },
        {
          id: "split-item-3",
          sourceId: source.id,
          clusterId: "split-cluster",
          originalUrl: "https://split.example.com/3",
          canonicalUrl: "https://split.example.com/3",
          urlHash: "split-hash-3",
          originalTitle: "OpenAI 租赁算力加速 AI 布局",
          publishedAt: new Date("2026-04-20T08:00:00.000Z"),
          summaryText: "OpenAI 租赁算力加速 AI 布局。",
          language: "zh",
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 84,
          qualityRationale: "relevant",
          eventSubject: "OpenAI",
          eventObject: "算力租赁",
        },
      ],
    });

    const result = await splitClusterIntoSingletons("split-cluster");

    expect(result).toMatchObject({
      clusterId: "split-cluster",
      itemCount: 3,
    });
    expect(result.singletonClusterIds).toHaveLength(3);
    await expect(prisma.contentCluster.findUnique({ where: { id: "split-cluster" } })).resolves.toBeNull();

    const splitItems = await prisma.item.findMany({
      where: { id: { in: ["split-item-1", "split-item-2", "split-item-3"] } },
      orderBy: { id: "asc" },
    });
    expect(splitItems.map((item) => item.clusterId)).toHaveLength(3);
    expect(new Set(splitItems.map((item) => item.clusterId)).size).toBe(3);
    expect(splitItems.every((item) => item.clusterId && item.clusterId !== "split-cluster")).toBe(true);

    const singletonClusters = await prisma.contentCluster.findMany({
      where: { id: { in: splitItems.map((item) => item.clusterId!) } },
      orderBy: { fingerprint: "asc" },
    });
    expect(singletonClusters.map((cluster) => cluster.fingerprint)).toEqual([
      "single-split-item-1",
      "single-split-item-2",
      "single-split-item-3",
    ]);
    expect(singletonClusters.every((cluster) => cluster.itemCount === 1)).toBe(true);
  });

  it("blocks automatic re-merge after a manual split creates cannot-link constraints", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Split Block Feed",
        rssUrl: "https://split-block.example.com/feed.xml",
        siteUrl: "https://split-block.example.com",
        enabled: true,
        aiParsingEnabled: true,
        aggregationEnabled: true,
      },
    });
    await prisma.contentCluster.create({
      data: {
        id: "split-block-cluster",
        kind: "topic",
        title: "Acme 发布 Widget",
        summary: "Acme 发布 Widget。",
        score: 86,
        itemCount: 2,
        latestPublishedAt: new Date("2026-04-20T10:00:00.000Z"),
        status: "active",
        fingerprint: "split-block-cluster",
        eventType: "launch",
        eventSubject: "Acme",
        eventAction: "发布",
        eventObject: "Widget",
        eventDate: "2026-04-20",
      },
    });
    await prisma.item.createMany({
      data: [
        {
          id: "split-block-item-1",
          sourceId: source.id,
          clusterId: "split-block-cluster",
          originalUrl: "https://split-block.example.com/1",
          canonicalUrl: "https://split-block.example.com/1",
          urlHash: "split-block-hash-1",
          originalTitle: "Acme 发布 Widget",
          publishedAt: new Date("2026-04-20T10:00:00.000Z"),
          summaryText: "Acme 发布 Widget。",
          language: "zh",
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 86,
          qualityRationale: "relevant",
          eventType: "launch",
          eventSubject: "Acme",
          eventAction: "发布",
          eventObject: "Widget",
          eventDate: "2026-04-20",
        },
        {
          id: "split-block-item-2",
          sourceId: source.id,
          clusterId: "split-block-cluster",
          originalUrl: "https://split-block.example.com/2",
          canonicalUrl: "https://split-block.example.com/2",
          urlHash: "split-block-hash-2",
          originalTitle: "Acme 再次报道 Widget 发布",
          publishedAt: new Date("2026-04-20T09:00:00.000Z"),
          summaryText: "Acme 发布 Widget 的另一篇报道。",
          language: "zh",
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 84,
          qualityRationale: "relevant",
          eventType: "launch",
          eventSubject: "Acme",
          eventAction: "发布",
          eventObject: "Widget",
          eventDate: "2026-04-20",
        },
      ],
    });
    const splitResult = await splitClusterIntoSingletons("split-block-cluster");
    const mergeClustersAi = vi.fn().mockResolvedValue([splitResult.singletonClusterIds]);
    const aiProvider = {
      mergeClusters: mergeClustersAi,
    } as unknown as AiProvider;

    const mergeResult = await executeClusterMerge(aiProvider, new Date("2026-04-21T10:00:00.000Z"));

    expect(mergeResult).toMatchObject({
      skipped: true,
      blockedByCannotLink: 1,
      mergedCount: 0,
    });
    expect(mergeClustersAi).not.toHaveBeenCalled();
    await expect(
      prisma.clusterConstraint.count({
        where: {
          kind: "cannot_link",
          scope: "item_item",
        },
      }),
    ).resolves.toBeGreaterThan(0);
  });

  it("sends multi-subject singleton merge candidates to AI and merges the selected group", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Singleton Merge Feed",
        rssUrl: "https://singleton-merge.example.com/feed.xml",
        siteUrl: "https://singleton-merge.example.com",
        enabled: true,
        aiParsingEnabled: true,
        aggregationEnabled: true,
      },
    });
    await prisma.contentCluster.createMany({
      data: [
        {
          id: "openai-contract-cluster",
          kind: "topic",
          title: "OpenAI 与微软调整合作合同",
          summary: "OpenAI 和微软调整云服务合作合同条款。",
          score: 84,
          itemCount: 1,
          latestPublishedAt: new Date("2026-04-20T09:00:00.000Z"),
          status: "active",
          fingerprint: "openai-contract",
          eventType: "partnership",
          eventSubject: "OpenAI",
          eventAction: "变更",
          eventObject: "微软合同",
          eventDate: "2026-04-20",
        },
        {
          id: "microsoft-contract-cluster",
          kind: "topic",
          title: "微软和 OpenAI 调整合作协议",
          summary: "微软与 OpenAI 对合作合同进行变更。",
          score: 86,
          itemCount: 1,
          latestPublishedAt: new Date("2026-04-20T10:00:00.000Z"),
          status: "active",
          fingerprint: "microsoft-contract",
          eventType: "partnership",
          eventSubject: "微软",
          eventAction: "变更",
          eventObject: "OpenAI 合同",
          eventDate: "2026-04-20",
        },
      ],
    });
    await prisma.item.createMany({
      data: [
        {
          id: "openai-contract-item",
          sourceId: source.id,
          clusterId: "openai-contract-cluster",
          originalUrl: "https://singleton-merge.example.com/openai-contract",
          canonicalUrl: "https://singleton-merge.example.com/openai-contract",
          urlHash: "openai-contract-hash",
          originalTitle: "OpenAI 与微软调整合作合同",
          publishedAt: new Date("2026-04-20T09:00:00.000Z"),
          summaryText: "OpenAI 和微软调整云服务合作合同条款。",
          language: "zh",
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 84,
          qualityRationale: "relevant",
          eventType: "partnership",
          eventSubject: "OpenAI",
          eventAction: "变更",
          eventObject: "微软合同",
          eventDate: "2026-04-20",
        },
        {
          id: "microsoft-contract-item",
          sourceId: source.id,
          clusterId: "microsoft-contract-cluster",
          originalUrl: "https://singleton-merge.example.com/microsoft-contract",
          canonicalUrl: "https://singleton-merge.example.com/microsoft-contract",
          urlHash: "microsoft-contract-hash",
          originalTitle: "微软和 OpenAI 调整合作协议",
          publishedAt: new Date("2026-04-20T10:00:00.000Z"),
          summaryText: "微软与 OpenAI 对合作合同进行变更。",
          language: "zh",
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 86,
          qualityRationale: "relevant",
          eventType: "partnership",
          eventSubject: "微软",
          eventAction: "变更",
          eventObject: "OpenAI 合同",
          eventDate: "2026-04-20",
        },
      ],
    });
    const mergeClustersAi = vi.fn().mockImplementation(async (clustersJson: string) => {
      const input = JSON.parse(clustersJson) as {
        pairs: Array<{ left: { id: string }; right: { id: string } }>;
      };

      expect(input.pairs).toHaveLength(1);
      expect(
        input.pairs.some(
          (pair) =>
            [pair.left.id, pair.right.id].sort().join("|") ===
            ["microsoft-contract-cluster", "openai-contract-cluster"].sort().join("|"),
        ),
      ).toBe(true);

      return [["openai-contract-cluster", "microsoft-contract-cluster"]];
    });
    const aiProvider = {
      mergeClusters: mergeClustersAi,
    } as unknown as AiProvider;

    const result = await executeClusterMerge(aiProvider, new Date("2026-04-21T10:00:00.000Z"));

    expect(result).toMatchObject({
      candidates: 2,
      skipped: false,
      mergedCount: 1,
      affectedClusterIds: ["openai-contract-cluster"],
    });
    expect(mergeClustersAi).toHaveBeenCalledTimes(1);
    await expect(prisma.contentCluster.findUnique({ where: { id: "microsoft-contract-cluster" } })).resolves.toBeNull();
    await expect(
      prisma.item.count({
        where: {
          clusterId: "openai-contract-cluster",
          id: { in: ["openai-contract-item", "microsoft-contract-item"] },
        },
      }),
    ).resolves.toBe(2);
  });

  it("uses declined decision cooldowns and stops after three declined attempts", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Clean Pair Retry Feed",
        rssUrl: "https://clean-pair-retry.example.com/feed.xml",
        siteUrl: "https://clean-pair-retry.example.com",
        enabled: true,
        aiParsingEnabled: true,
        aggregationEnabled: true,
      },
    });
    await prisma.contentCluster.createMany({
      data: [
        {
          id: "openai-clean-contract-cluster",
          kind: "topic",
          title: "OpenAI 与微软调整合作合同",
          summary: "OpenAI 和微软调整云服务合作合同条款。",
          score: 84,
          itemCount: 1,
          latestPublishedAt: new Date("2026-04-20T09:00:00.000Z"),
          status: "active",
          fingerprint: "openai-clean-contract",
          eventType: "partnership",
          eventSubject: "OpenAI",
          eventAction: "变更",
          eventObject: "微软合同",
          eventDate: "2026-04-20",
        },
        {
          id: "microsoft-clean-contract-cluster",
          kind: "topic",
          title: "微软和 OpenAI 调整合作协议",
          summary: "微软与 OpenAI 对合作合同进行变更。",
          score: 86,
          itemCount: 1,
          latestPublishedAt: new Date("2026-04-20T10:00:00.000Z"),
          status: "active",
          fingerprint: "microsoft-clean-contract",
          eventType: "partnership",
          eventSubject: "微软",
          eventAction: "变更",
          eventObject: "OpenAI 合同",
          eventDate: "2026-04-20",
        },
      ],
    });
    await prisma.item.createMany({
      data: [
        {
          id: "openai-clean-contract-item",
          sourceId: source.id,
          clusterId: "openai-clean-contract-cluster",
          originalUrl: "https://clean-pair-retry.example.com/openai-contract",
          canonicalUrl: "https://clean-pair-retry.example.com/openai-contract",
          urlHash: "openai-clean-contract-hash",
          originalTitle: "OpenAI 与微软调整合作合同",
          publishedAt: new Date("2026-04-20T09:00:00.000Z"),
          summaryText: "OpenAI 和微软调整云服务合作合同条款。",
          language: "zh",
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 84,
          qualityRationale: "relevant",
          eventType: "partnership",
          eventSubject: "OpenAI",
          eventAction: "变更",
          eventObject: "微软合同",
          eventDate: "2026-04-20",
        },
        {
          id: "microsoft-clean-contract-item",
          sourceId: source.id,
          clusterId: "microsoft-clean-contract-cluster",
          originalUrl: "https://clean-pair-retry.example.com/microsoft-contract",
          canonicalUrl: "https://clean-pair-retry.example.com/microsoft-contract",
          urlHash: "microsoft-clean-contract-hash",
          originalTitle: "微软和 OpenAI 调整合作协议",
          publishedAt: new Date("2026-04-20T10:00:00.000Z"),
          summaryText: "微软与 OpenAI 对合作合同进行变更。",
          language: "zh",
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 86,
          qualityRationale: "relevant",
          eventType: "partnership",
          eventSubject: "微软",
          eventAction: "变更",
          eventObject: "OpenAI 合同",
          eventDate: "2026-04-20",
        },
      ],
    });
    const mergeClustersAi = vi.fn().mockResolvedValue([]);
    const aiProvider = {
      mergeClusters: mergeClustersAi,
    } as unknown as AiProvider;
    const now = new Date("2026-04-21T10:00:00.000Z");

    const firstPass = await executeClusterMerge(aiProvider, now);
    const precomputeResult = await precomputeClusterMergeCleanPairs(now);
    const storedPair = await prisma.clusterMergeCleanPairCandidate.findFirstOrThrow({
      where: {
        leftClusterId: { in: ["openai-clean-contract-cluster", "microsoft-clean-contract-cluster"] },
        rightClusterId: { in: ["openai-clean-contract-cluster", "microsoft-clean-contract-cluster"] },
      },
    });
    const cooldownPass = await executeClusterMerge(aiProvider, now);
    const secondPass = await executeClusterMerge(aiProvider, new Date("2026-04-21T17:00:00.000Z"));
    const thirdPass = await executeClusterMerge(aiProvider, new Date("2026-04-22T18:00:00.000Z"));
    const fourthPass = await executeClusterMerge(aiProvider, new Date("2026-04-24T18:00:00.000Z"));
    const updatedStoredPair = await prisma.clusterMergeCleanPairCandidate.findUniqueOrThrow({
      where: { id: storedPair.id },
    });

    expect(firstPass.dirtyPairs).toBeGreaterThan(0);
    expect(firstPass.precomputedCleanPairsUsed).toBe(0);
    expect(precomputeResult.storedPairs).toBe(1);
    expect(cooldownPass).toMatchObject({
      skipped: true,
      blockedByDeclinedDecision: 1,
    });
    expect(secondPass).toMatchObject({
      dirtyPairs: 0,
      precomputedCleanPairsUsed: 1,
    });
    expect(thirdPass).toMatchObject({
      dirtyPairs: 0,
      precomputedCleanPairsUsed: 1,
    });
    expect(fourthPass).toMatchObject({
      skipped: true,
      blockedByDeclinedDecision: 1,
    });
    expect(updatedStoredPair.attemptCount).toBe(2);
    expect(mergeClustersAi).toHaveBeenCalledTimes(3);
    await expect(
      prisma.clusterDecision.count({
        where: {
          kind: "cluster_pair",
          verdict: "declined",
        },
      }),
    ).resolves.toBe(3);
  });

  it("records merge AI failures without marking candidates evaluated", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Merge Failure Feed",
        rssUrl: "https://merge-failure.example.com/feed.xml",
        siteUrl: "https://merge-failure.example.com",
        enabled: true,
        aiParsingEnabled: true,
        aggregationEnabled: true,
      },
    });
    await prisma.contentCluster.createMany({
      data: [
        {
          id: "failure-left-cluster",
          kind: "topic",
          title: "OpenAI 与微软调整合作合同",
          summary: "OpenAI 和微软调整云服务合作合同条款。",
          score: 84,
          itemCount: 1,
          latestPublishedAt: new Date("2026-04-20T09:00:00.000Z"),
          status: "active",
          fingerprint: "failure-left",
          eventType: "partnership",
          eventSubject: "OpenAI",
          eventAction: "变更",
          eventObject: "微软合同",
          eventDate: "2026-04-20",
        },
        {
          id: "failure-right-cluster",
          kind: "topic",
          title: "微软和 OpenAI 调整合作协议",
          summary: "微软与 OpenAI 对合作合同进行变更。",
          score: 86,
          itemCount: 1,
          latestPublishedAt: new Date("2026-04-20T10:00:00.000Z"),
          status: "active",
          fingerprint: "failure-right",
          eventType: "partnership",
          eventSubject: "微软",
          eventAction: "变更",
          eventObject: "OpenAI 合同",
          eventDate: "2026-04-20",
        },
      ],
    });
    await prisma.item.createMany({
      data: [
        {
          id: "failure-left-item",
          sourceId: source.id,
          clusterId: "failure-left-cluster",
          originalUrl: "https://merge-failure.example.com/left",
          canonicalUrl: "https://merge-failure.example.com/left",
          urlHash: "failure-left-hash",
          originalTitle: "OpenAI 与微软调整合作合同",
          publishedAt: new Date("2026-04-20T09:00:00.000Z"),
          summaryText: "OpenAI 和微软调整云服务合作合同条款。",
          language: "zh",
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 84,
          qualityRationale: "relevant",
          eventType: "partnership",
          eventSubject: "OpenAI",
          eventAction: "变更",
          eventObject: "微软合同",
          eventDate: "2026-04-20",
        },
        {
          id: "failure-right-item",
          sourceId: source.id,
          clusterId: "failure-right-cluster",
          originalUrl: "https://merge-failure.example.com/right",
          canonicalUrl: "https://merge-failure.example.com/right",
          urlHash: "failure-right-hash",
          originalTitle: "微软和 OpenAI 调整合作协议",
          publishedAt: new Date("2026-04-20T10:00:00.000Z"),
          summaryText: "微软与 OpenAI 对合作合同进行变更。",
          language: "zh",
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 86,
          qualityRationale: "relevant",
          eventType: "partnership",
          eventSubject: "微软",
          eventAction: "变更",
          eventObject: "OpenAI 合同",
          eventDate: "2026-04-20",
        },
      ],
    });
    const mergeClustersAi = vi
      .fn()
      .mockRejectedValueOnce(new Error("upstream timeout"))
      .mockResolvedValueOnce([]);
    const aiProvider = {
      mergeClusters: mergeClustersAi,
    } as unknown as AiProvider;

    const failedPass = await executeClusterMerge(aiProvider, new Date("2026-04-21T10:00:00.000Z"));
    await expect(
      prisma.contentCluster.findMany({
        where: { id: { in: ["failure-left-cluster", "failure-right-cluster"] } },
        select: { mergeInputHash: true },
      }),
    ).resolves.toEqual(expect.arrayContaining([{ mergeInputHash: null }, { mergeInputHash: null }]));
    const retryPass = await executeClusterMerge(aiProvider, new Date("2026-04-21T10:05:00.000Z"));

    expect(failedPass).toMatchObject({
      skipped: true,
      aiMergeGroups: 0,
    });
    expect(retryPass.skipped).toBe(false);
    expect(mergeClustersAi).toHaveBeenCalledTimes(2);
    await expect(
      prisma.clusterDecision.count({
        where: {
          verdict: "failed",
          reasonCode: "llm_failure",
        },
      }),
    ).resolves.toBe(1);
  });

  it("does not send singleton merge candidates to AI when key objects conflict", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Object Conflict Feed",
        rssUrl: "https://object-conflict.example.com/feed.xml",
        siteUrl: "https://object-conflict.example.com",
        enabled: true,
        aiParsingEnabled: true,
        aggregationEnabled: true,
      },
    });
    await prisma.contentCluster.createMany({
      data: [
        {
          id: "product-a-cluster",
          kind: "topic",
          title: "Acme 发布产品 A",
          summary: "Acme 发布产品 A。",
          score: 80,
          itemCount: 1,
          latestPublishedAt: new Date("2026-04-20T09:00:00.000Z"),
          status: "active",
          fingerprint: "product-a",
          eventType: "launch",
          eventSubject: "Acme",
          eventAction: "发布",
          eventObject: "产品 A",
          eventDate: "2026-04-20",
        },
        {
          id: "product-b-cluster",
          kind: "topic",
          title: "Acme 发布产品 B",
          summary: "Acme 发布产品 B。",
          score: 80,
          itemCount: 1,
          latestPublishedAt: new Date("2026-04-20T10:00:00.000Z"),
          status: "active",
          fingerprint: "product-b",
          eventType: "launch",
          eventSubject: "Acme",
          eventAction: "发布",
          eventObject: "产品 B",
          eventDate: "2026-04-20",
        },
      ],
    });
    await prisma.item.createMany({
      data: [
        {
          id: "product-a-item",
          sourceId: source.id,
          clusterId: "product-a-cluster",
          originalUrl: "https://object-conflict.example.com/product-a",
          canonicalUrl: "https://object-conflict.example.com/product-a",
          urlHash: "product-a-hash",
          originalTitle: "Acme 发布产品 A",
          publishedAt: new Date("2026-04-20T09:00:00.000Z"),
          summaryText: "Acme 发布产品 A。",
          language: "zh",
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 80,
          qualityRationale: "relevant",
          eventType: "launch",
          eventSubject: "Acme",
          eventAction: "发布",
          eventObject: "产品 A",
          eventDate: "2026-04-20",
        },
        {
          id: "product-b-item",
          sourceId: source.id,
          clusterId: "product-b-cluster",
          originalUrl: "https://object-conflict.example.com/product-b",
          canonicalUrl: "https://object-conflict.example.com/product-b",
          urlHash: "product-b-hash",
          originalTitle: "Acme 发布产品 B",
          publishedAt: new Date("2026-04-20T10:00:00.000Z"),
          summaryText: "Acme 发布产品 B。",
          language: "zh",
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 80,
          qualityRationale: "relevant",
          eventType: "launch",
          eventSubject: "Acme",
          eventAction: "发布",
          eventObject: "产品 B",
          eventDate: "2026-04-20",
        },
      ],
    });
    const mergeClustersAi = vi.fn();
    const aiProvider = {
      mergeClusters: mergeClustersAi,
    } as unknown as AiProvider;

    const result = await executeClusterMerge(aiProvider, new Date("2026-04-21T10:00:00.000Z"));

    expect(result).toMatchObject({
      candidates: 0,
      skipped: true,
      mergedCount: 0,
      affectedClusterIds: [],
    });
    expect(mergeClustersAi).not.toHaveBeenCalled();
  });
});
