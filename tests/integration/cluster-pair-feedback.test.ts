import { afterEach, describe, expect, it } from "vitest";

import {
  recordClusterPairLabelFromClusters,
  recordClusterPairLabelFromItem,
} from "@/lib/clusters/feedback";
import { prisma } from "@/lib/db";

const IDS = {
  source: "feedback-source",
  clusterA: "feedback-cluster-a",
  clusterB: "feedback-cluster-b",
  item: "feedback-item-1",
};

async function seedFixtures() {
  await prisma.source.create({
    data: {
      id: IDS.source,
      name: "Feedback Test Source",
      rssUrl: "https://feedback.example.com/feed.xml",
      siteUrl: "https://feedback.example.com",
      enabled: true,
    },
  });
  await prisma.contentCluster.createMany({
    data: [
      {
        id: IDS.clusterA,
        title: "OpenAI 发布 GPT-6 Astra",
        summary: "OpenAI 在发布会上推出 GPT-6 Astra 模型",
        fingerprint: "fp-a",
        eventType: "product_release",
        eventSubject: "OpenAI",
        eventObject: "GPT-6 Astra",
        eventAction: "发布",
        eventDate: "2026-09-03",
        itemCount: 3,
        latestPublishedAt: new Date("2026-09-03T10:00:00.000Z"),
      },
      {
        id: IDS.clusterB,
        title: "OpenAI 推出 GPT-6 Astra 大模型",
        summary: "GPT-6 Astra 面向开发者开放 API",
        fingerprint: "fp-b",
        eventSubject: "OpenAI",
        eventObject: "GPT-6 Astra",
        itemCount: 1,
        latestPublishedAt: new Date("2026-09-03T12:00:00.000Z"),
      },
    ],
  });
  await prisma.item.create({
    data: {
      id: IDS.item,
      sourceId: IDS.source,
      originalUrl: "https://feedback.example.com/astra",
      canonicalUrl: "https://feedback.example.com/astra",
      urlHash: IDS.item,
      originalTitle: "OpenAI launches GPT-6 Astra",
      translatedTitle: "OpenAI 发布 GPT-6 Astra",
      summaryText: "GPT-6 Astra 面向开发者开放",
      publishedAt: new Date("2026-09-03T09:00:00.000Z"),
      status: "processed",
      moderationStatus: "allowed",
      createdAt: new Date("2026-09-03T09:00:00.000Z"),
      updatedAt: new Date("2026-09-03T09:00:00.000Z"),
    },
  });
}

afterEach(async () => {
  // 本文件独占 pair 标签夹具，无条件清空避免跨文件顺序性污染
  await prisma.clusterPairLabel.deleteMany({});
  await prisma.item.deleteMany({ where: { id: IDS.item } });
  await prisma.contentCluster.deleteMany({ where: { id: { in: [IDS.clusterA, IDS.clusterB] } } });
  await prisma.source.deleteMany({ where: { id: IDS.source } });
});

describe("cluster pair feedback labels", () => {
  it("writes an eval-grade label from two clusters", async () => {
    await seedFixtures();

    const labelId = await recordClusterPairLabelFromClusters({
      verdict: "approved",
      source: "manual_review_merge",
      leftClusterId: IDS.clusterB,
      rightClusterId: IDS.clusterA,
    });
    expect(labelId).not.toBeNull();

    const label = await prisma.clusterPairLabel.findUnique({ where: { id: labelId! } });
    expect(label).not.toBeNull();
    expect(label!.verdict).toBe("approved");
    expect(label!.source).toBe("manual_review_merge");
    expect(label!.leftKind).toBe("cluster");
    expect(label!.titleA).toBe("OpenAI 推出 GPT-6 Astra 大模型");
    expect(label!.titleB).toBe("OpenAI 发布 GPT-6 Astra");
    expect(label!.subjectA).toBe("OpenAI");
    expect(label!.objectB).toBe("GPT-6 Astra");
    expect(label!.itemCountA).toBe(1);
    expect(label!.itemCountB).toBe(3);
  });

  it("writes an eval-grade label from an item against a cluster", async () => {
    await seedFixtures();

    const labelId = await recordClusterPairLabelFromItem({
      verdict: "declined",
      source: "item_detach",
      itemId: IDS.item,
      clusterId: IDS.clusterA,
    });
    expect(labelId).not.toBeNull();

    const label = await prisma.clusterPairLabel.findUnique({ where: { id: labelId! } });
    expect(label!.verdict).toBe("declined");
    expect(label!.leftKind).toBe("item");
    expect(label!.leftId).toBe(IDS.item);
    expect(label!.titleA).toBe("OpenAI 发布 GPT-6 Astra");
    expect(label!.titleB).toBe("OpenAI 发布 GPT-6 Astra");
    expect(label!.itemCountA).toBe(1);
    expect(label!.itemCountB).toBe(3);
  });

  it("returns null without writing when a side is missing", async () => {
    await seedFixtures();

    const labelId = await recordClusterPairLabelFromClusters({
      verdict: "approved",
      source: "manual_review_merge",
      leftClusterId: IDS.clusterA,
      rightClusterId: "missing-cluster",
    });
    expect(labelId).toBeNull();
    expect(await prisma.clusterPairLabel.count()).toBe(0);
  });
});
