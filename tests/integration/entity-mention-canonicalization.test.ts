import { afterEach, describe, expect, it } from "vitest";

import { buildClusterMergeCandidateInputHash } from "@/lib/clusters/helpers";
import { precomputeClusterMergeCleanPairs } from "@/lib/clusters/service";
import { prisma } from "@/lib/db";
import { loadMentionResolver, resetMentionResolverCache } from "@/lib/entities/mention-resolution";

const NOW = new Date("2026-09-19T08:00:00.000Z");

type FixtureCluster = {
  id: string;
  title: string;
  summary: string;
  eventType?: string | null;
  eventSubject?: string | null;
  eventObject?: string | null;
  ageDays: number;
};

const createdIds = { clusters: [] as string[], sources: [] as string[], items: [] as string[] };

async function seedClusterWithItem(fixture: FixtureCluster) {
  const source = await prisma.source.create({
    data: {
      name: `mention-resolve-${fixture.id}`,
      rssUrl: `https://mention-resolve.example.com/${fixture.id}.xml`,
      siteUrl: `https://mention-resolve.example.com/${fixture.id}`,
      enabled: true,
      aiParsingEnabled: true,
      aggregationEnabled: true,
    },
  });
  createdIds.sources.push(source.id);
  const publishedAt = new Date(NOW.getTime() - fixture.ageDays * 24 * 60 * 60 * 1000);
  const cluster = await prisma.contentCluster.create({
    data: {
      id: fixture.id,
      kind: "topic",
      title: fixture.title,
      summary: fixture.summary,
      score: 60,
      itemCount: 1,
      latestPublishedAt: publishedAt,
      createdAt: publishedAt,
      updatedAt: publishedAt,
      status: "active",
      fingerprint: `fp-${fixture.id}`,
      eventType: fixture.eventType ?? null,
      eventSubject: fixture.eventSubject ?? null,
      eventAction: null,
      eventObject: fixture.eventObject ?? null,
      eventDate: null,
      mergeInputHash: buildClusterMergeCandidateInputHash({
        id: fixture.id,
        fingerprint: `fp-${fixture.id}`,
        title: fixture.title,
        summary: fixture.summary,
        eventType: fixture.eventType ?? null,
        eventSubject: fixture.eventSubject ?? null,
        eventAction: null,
        eventObject: fixture.eventObject ?? null,
        eventDate: null,
        itemCount: 1,
        latestPublishedAt: publishedAt,
      }),
    },
  });
  createdIds.clusters.push(cluster.id);
  const item = await prisma.item.create({
    data: {
      id: `${fixture.id}-item`,
      sourceId: source.id,
      clusterId: fixture.id,
      originalUrl: `https://mention-resolve.example.com/${fixture.id}/item`,
      canonicalUrl: `https://mention-resolve.example.com/${fixture.id}/item`,
      urlHash: `${fixture.id}-item-hash`,
      originalTitle: fixture.title,
      publishedAt,
      createdAt: publishedAt,
      summaryText: fixture.summary,
      status: "processed",
      moderationStatus: "allowed",
      qualityScore: 80,
      qualityRationale: "test",
    },
  });
  createdIds.items.push(item.id);
}

async function seedZhipuAlias() {
  const entity = await prisma.entity.create({
    data: { name: "智谱", normalized: "智谱" },
  });
  await prisma.entityAlias.create({
    data: { entityId: entity.id, aliasName: "Z.ai", aliasNormalized: "z.ai" },
  });
}

// 同一 GLM-5.3 事件、对象同义但主体 Mention 不同（智谱 vs Z.ai）；
// eventType 不同且相隔 4 天（无时间加成）→ 规范化前规则分 = 40（低于灰区 55），
// 主体解析为同一 canonical 后 +35 → 95，跨过灰区获得 AI 提名。
const PAIR: [FixtureCluster, FixtureCluster] = [
  {
    id: "mention-a",
    title: "智谱正式上线新一代基座模型 API 服务",
    summary: "智谱宣布新一代基座模型 API 正式上线开放。",
    eventType: "release",
    eventSubject: "智谱",
    eventObject: "GLM-5.3 大模型",
    ageDays: 5,
  },
  {
    id: "mention-b",
    title: "Z.ai 平台调整调用配额与计费规则",
    summary: "Z.ai 调整了调用配额与计费规则。",
    eventType: "update",
    eventSubject: "Z.ai",
    eventObject: "GLM-5.3",
    ageDays: 1,
  },
];

afterEach(async () => {
  resetMentionResolverCache();
  await prisma.entityAlias.deleteMany({ where: { entity: { normalized: "智谱" } } });
  await prisma.entity.deleteMany({ where: { normalized: "智谱" } });
  await prisma.item.deleteMany({ where: { id: { in: createdIds.items } } });
  await prisma.contentCluster.deleteMany({ where: { id: { in: createdIds.clusters } } });
  await prisma.source.deleteMany({ where: { id: { in: createdIds.sources } } });
  createdIds.clusters = [];
  createdIds.sources = [];
  createdIds.items = [];
  await prisma.clusterMergeCleanPairCandidate.deleteMany({});
});

describe("merge precompute entity mention canonicalization", () => {
  it("resolves alias mentions to their canonical entity name", async () => {
    await seedZhipuAlias();
    const resolve = await loadMentionResolver(["Z.ai", "智谱", "未知实体", null]);
    expect(resolve("Z.ai")).toBe("智谱");
    expect(resolve("智谱")).toBe("智谱");
    expect(resolve("未知实体")).toBeNull();
    expect(resolve(null)).toBeNull();
  });

  it("keeps unresolvable mentions on pure rule behavior", async () => {
    await seedClusterWithItem(PAIR[0]);
    await seedClusterWithItem(PAIR[1]);
    const result = await precomputeClusterMergeCleanPairs(NOW);

    expect(result.vectorEnabled).toBe(false);
    // 无实体/别名数据：subject 不相似（0）+ object 相似（40）= 40 < 55，不提名
    const stored = await prisma.clusterMergeCleanPairCandidate.findMany();
    expect(stored).toHaveLength(0);
    expect(result.storedPairs).toBe(0);
  });

  it("admits aliased-subject pairs once the alias resolves to the canonical entity", async () => {
    await seedClusterWithItem(PAIR[0]);
    await seedClusterWithItem(PAIR[1]);
    await seedZhipuAlias();

    const result = await precomputeClusterMergeCleanPairs(NOW);

    expect(result.storedPairs).toBe(1);
    const stored = await prisma.clusterMergeCleanPairCandidate.findFirstOrThrow();
    expect(stored.leftClusterId).toBe("mention-a");
    expect(stored.rightClusterId).toBe("mention-b");
    // 35(subject canonical 相似) + 40(object 相似) + 20(对象词面重叠) = 95
    expect(stored.score).toBe(95);
  });
});
