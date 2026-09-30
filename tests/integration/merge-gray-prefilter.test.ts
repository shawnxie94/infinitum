import { afterEach, describe, expect, it } from "vitest";

import type { AiProvider } from "@/lib/ai/provider-types";
import { buildClusterMergeCandidateInputHash, scoreClusterMergeCandidatePair } from "@/lib/clusters/helpers";
import type { EmbedTextsFn } from "@/lib/ai/embeddings";
import { executeClusterMerge, precomputeClusterMergeCleanPairs } from "@/lib/clusters/service";
import { prisma } from "@/lib/db";

const NOW = new Date("2026-09-19T08:00:00.000Z");

type FixtureCluster = {
  id: string;
  title: string;
  summary: string;
  eventType?: string | null;
  eventSubject?: string | null;
  eventAction?: string | null;
  eventObject?: string | null;
};

async function seedClusterWithItem(fixture: FixtureCluster) {
  const source = await prisma.source.create({
    data: {
      name: `merge-gray-${fixture.id}`,
      rssUrl: `https://merge-gray.example.com/${fixture.id}.xml`,
      siteUrl: `https://merge-gray.example.com/${fixture.id}`,
      enabled: true,
      aiParsingEnabled: true,
      aggregationEnabled: true,
    },
  });
  const publishedAt = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
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
      eventAction: fixture.eventAction ?? null,
      eventObject: fixture.eventObject ?? null,
      mergeInputHash: buildClusterMergeCandidateInputHash({
        id: fixture.id,
        fingerprint: `fp-${fixture.id}`,
        title: fixture.title,
        summary: fixture.summary,
        eventType: fixture.eventType ?? null,
        eventSubject: fixture.eventSubject ?? null,
        eventAction: fixture.eventAction ?? null,
        eventObject: fixture.eventObject ?? null,
        eventDate: null,
        itemCount: 1,
        latestPublishedAt: publishedAt,
      }),
    },
  });
  await prisma.item.create({
    data: {
      id: `${fixture.id}-item`,
      sourceId: source.id,
      clusterId: fixture.id,
      originalUrl: `https://merge-gray.example.com/${fixture.id}/item`,
      canonicalUrl: `https://merge-gray.example.com/${fixture.id}/item`,
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
  return cluster;
}

// 规则词汇盲区的一对同事件聚类：主题相同但措辞/字段完全无锚点
const BLIND_PAIR: [FixtureCluster, FixtureCluster] = [
  {
    id: "blind-a",
    title: "OpenAI reorganizes internal engineering units",
    summary: "Sam Altman sends a private memo to staff.",
  },
  {
    id: "blind-b",
    title: "萨姆·奥尔特曼调整安全研究团队部署",
    summary: "该企业重新安排实验室人员组合。",
  },
];

// 主体与对象均不相关的一对：词面/向量召回都不能绕过主体关系硬门。
const CONFLICT_PAIR: [FixtureCluster, FixtureCluster] = [
  {
    id: "conflict-a",
    title: "苹果 收购 TikTok 美国业务",
    summary: "苹果完成对 TikTok 美国业务的收购交割。",
    eventType: "acquisition",
    eventSubject: "苹果",
    eventAction: "收购",
    eventObject: "TikTok美国业务",
  },
  {
    id: "conflict-b",
    title: "甲骨文 收购 Chrome 浏览器",
    summary: "甲骨文将把 Chrome 浏览器收入旗下。",
    eventType: "acquisition",
    eventSubject: "甲骨文",
    eventAction: "收购",
    eventObject: "Chrome浏览器",
  },
];

function fakeEmbedTexts(vectorByText: Record<string, number[]>): EmbedTextsFn {
  return async (texts) =>
    texts.map((text) => {
      const key = Object.keys(vectorByText).find((candidate) => text.includes(candidate));
      return vectorByText[key ?? ""] ?? [0, 0, 1];
    });
}

async function ensureBlindPairIsRuleInvisible() {
  const left = await prisma.contentCluster.findUnique({ where: { id: BLIND_PAIR[0].id } });
  const right = await prisma.contentCluster.findUnique({ where: { id: BLIND_PAIR[1].id } });
  expect(left).not.toBeNull();
  expect(right).not.toBeNull();
  const result = scoreRawPair(left!, right!);
  // 前置条件：这对在规则预筛下不可见（no_event_anchor 或分数不达灰区）
  expect(result.rejected || result.score < 55).toBe(true);
}

function scoreRawPair(left: NonNullable<Awaited<ReturnType<typeof prisma.contentCluster.findUnique>>>, right: NonNullable<Awaited<ReturnType<typeof prisma.contentCluster.findUnique>>>) {
  return scoreClusterMergeCandidatePair(
    {
      id: left.id,
      title: left.title,
      summary: left.summary ?? "",
      fingerprint: left.fingerprint,
      eventType: left.eventType,
      eventSubject: left.eventSubject,
      eventAction: left.eventAction,
      eventObject: left.eventObject,
      eventDate: left.eventDate,
      itemCount: left.itemCount,
      latestPublishedAt: left.latestPublishedAt,
    },
    {
      id: right.id,
      title: right.title,
      summary: right.summary ?? "",
      fingerprint: right.fingerprint,
      eventType: right.eventType,
      eventSubject: right.eventSubject,
      eventAction: right.eventAction,
      eventObject: right.eventObject,
      eventDate: right.eventDate,
      itemCount: right.itemCount,
      latestPublishedAt: right.latestPublishedAt,
    },
  );
}

afterEach(async () => {
  await prisma.clusterDecision.deleteMany({ where: { kind: "cluster_pair" } });
  await prisma.entityAlias.deleteMany({ where: { aliasNormalized: "starlight" } });
  await prisma.entity.deleteMany({ where: { normalized: "nova systems" } });
  await prisma.clusterMergeCleanPairCandidate.deleteMany({});
  await prisma.item.deleteMany({ where: { source: { rssUrl: { contains: "merge-gray.example.com" } } } });
  await prisma.source.deleteMany({ where: { rssUrl: { contains: "merge-gray.example.com" } } });
  await prisma.contentCluster.deleteMany({ where: { id: { in: ["blind-a", "blind-b", "conflict-a", "conflict-b", "bm25-a", "bm25-b", "both-a", "both-b", "alias-a", "alias-b"] } } });
});

describe("precomputeClusterMergeCleanPairs vector prefilter", () => {
  it("nominates lexically-blind same-event pairs via vector similarity", async () => {
    await seedClusterWithItem(BLIND_PAIR[0]);
    await seedClusterWithItem(BLIND_PAIR[1]);
    await ensureBlindPairIsRuleInvisible();

    const result = await precomputeClusterMergeCleanPairs(NOW, {
      embedTexts: fakeEmbedTexts({
        "OpenAI": [1, 0],
        "奥尔特曼": [1, 0],
      }),
    });

    expect(result.vectorEnabled).toBe(true);
    expect(result.vectorAdmittedPairs).toBe(1);
    const stored = await prisma.clusterMergeCleanPairCandidate.findFirst({
      where: { leftClusterId: "blind-a", rightClusterId: "blind-b" },
    });
    expect(stored).not.toBeNull();
    expect(stored!.score).toBe(10_000_000); // vector priority × BM25 fixed-point scale
    expect(stored!.recallSource).toBe("vector");
    expect(stored!.bm25Score).toBe(0);
    expect(stored!.vectorSimilarity).toBeCloseTo(1);
  });

  it("canonicalizes configured subject aliases before precompute admission", async () => {
    const entity = await prisma.entity.create({
      data: { name: "Nova Systems", normalized: "nova systems" },
    });
    await prisma.entityAlias.create({
      data: {
        entityId: entity.id,
        aliasName: "Starlight",
        aliasNormalized: "starlight",
        createdBy: "test",
      },
    });
    await seedClusterWithItem({
      id: "alias-a",
      title: "Nova Systems launches Atlas 4 AI model",
      summary: "Nova Systems announces an Atlas 4 AI model launch with enterprise features.",
      eventType: "launch",
      eventSubject: "Nova Systems",
      eventAction: "launches",
    });
    await seedClusterWithItem({
      id: "alias-b",
      title: "Starlight launches Atlas 4 AI model",
      summary: "Starlight announces an Atlas 4 AI model launch with enterprise features.",
      eventType: "launch",
      eventSubject: "Starlight",
      eventAction: "launches",
    });

    const result = await precomputeClusterMergeCleanPairs(NOW, { embedTexts: async () => null });
    const stored = await prisma.clusterMergeCleanPairCandidate.findFirst({
      where: { leftClusterId: "alias-a", rightClusterId: "alias-b" },
    });

    expect(result.storedPairs).toBeGreaterThan(0);
    expect(stored).toMatchObject({ recallSource: "bm25" });
  });

  it("persists BM25-only and combined-channel provenance", async () => {
    await seedClusterWithItem({
      id: "bm25-a",
      title: "Acme launches Orion satellite",
      summary: "Acme launches the Orion satellite.",
      eventType: "launch",
      eventSubject: "Acme",
      eventAction: "launches",
      eventObject: "Orion satellite",
    });
    await seedClusterWithItem({
      id: "bm25-b",
      title: "Acme launches Orion satellite update",
      summary: "Acme launches an update for the Orion satellite.",
      eventType: "launch",
      eventSubject: "Acme",
      eventAction: "launches",
      eventObject: "Orion satellite",
    });
    await precomputeClusterMergeCleanPairs(NOW, { embedTexts: async () => null });
    const bm25Stored = await prisma.clusterMergeCleanPairCandidate.findFirstOrThrow({
      where: { leftClusterId: "bm25-a", rightClusterId: "bm25-b" },
    });
    expect(bm25Stored.recallSource).toBe("bm25");
    expect(bm25Stored.bm25Score).toBeGreaterThan(0);
    expect(bm25Stored.vectorSimilarity).toBeNull();

    await seedClusterWithItem({
      id: "both-a",
      title: "Acme launches Orion satellite",
      summary: "Acme launches the Orion satellite.",
      eventType: "launch",
      eventSubject: "Acme",
      eventAction: "launches",
      eventObject: "Orion satellite",
    });
    await seedClusterWithItem({
      id: "both-b",
      title: "Acme launches Orion satellite update",
      summary: "Acme launches an update for the Orion satellite.",
      eventType: "launch",
      eventSubject: "Acme",
      eventAction: "launches",
      eventObject: "Orion satellite",
    });
    await precomputeClusterMergeCleanPairs(NOW, {
      embedTexts: async (texts) => texts.map(() => [1, 0]),
    });
    const bothStored = await prisma.clusterMergeCleanPairCandidate.findFirstOrThrow({
      where: { leftClusterId: "both-a", rightClusterId: "both-b" },
    });
    expect(bothStored.recallSource).toBe("bm25+vector");
    expect(bothStored.bm25Score).toBeGreaterThan(0);
    expect(bothStored.vectorSimilarity).toBeCloseTo(1);
  });

  it("falls back to pure rule behavior when embeddings are unavailable", async () => {
    await seedClusterWithItem(BLIND_PAIR[0]);
    await seedClusterWithItem(BLIND_PAIR[1]);

    const result = await precomputeClusterMergeCleanPairs(NOW, {
      embedTexts: async () => null,
    });

    expect(result.vectorEnabled).toBe(false);
    expect(result.vectorAdmittedPairs).toBe(0);
    const stored = await prisma.clusterMergeCleanPairCandidate.findFirst({
      where: { leftClusterId: "blind-a", rightClusterId: "blind-b" },
    });
    expect(stored).toBeNull();
  });

  it("rejects unrelated structured subjects below the vector threshold", async () => {
    await seedClusterWithItem(CONFLICT_PAIR[0]);
    await seedClusterWithItem(CONFLICT_PAIR[1]);
    const left = await prisma.contentCluster.findUnique({ where: { id: CONFLICT_PAIR[0].id } });
    const right = await prisma.contentCluster.findUnique({ where: { id: CONFLICT_PAIR[1].id } });
    // 前置条件：主体关系硬门拒绝该对
    expect(scoreRawPair(left!, right!).rejectedReason).toBe("unrelated_subjects");

    // 低于向量准入线时同样不创建候选
    const result = await precomputeClusterMergeCleanPairs(NOW, {
      embedTexts: fakeEmbedTexts({
        "苹果": [1, 0],
        "甲骨文": [0.65, 0.76],
      }),
    });

    const stored = await prisma.clusterMergeCleanPairCandidate.findFirst({
      where: { leftClusterId: "conflict-a", rightClusterId: "conflict-b" },
    });
    expect(stored).toBeNull();
    expect(result.vectorAdmittedPairs).toBe(0);
  });

  it("tolerates null vectors without disabling the vector channel", async () => {
    await seedClusterWithItem(BLIND_PAIR[0]);
    await seedClusterWithItem(BLIND_PAIR[1]);
    await ensureBlindPairIsRuleInvisible();

    // 一侧聚类嵌入缺失（null）：该对不产生向量提名，但通道保持开启
    // （判别串用「萨姆」：仅 blind-b 标题包含；「奥尔特曼」两个聚类文本都含）
    const missingResult = await precomputeClusterMergeCleanPairs(NOW, {
      embedTexts: async (texts) =>
        texts.map((text) => (text.includes("萨姆") ? null : [1, 0])),
    });
    expect(missingResult.vectorEnabled).toBe(true);
    expect(missingResult.vectorAdmittedPairs).toBe(0);
    const missingStored = await prisma.clusterMergeCleanPairCandidate.findFirst({
      where: { leftClusterId: "blind-a", rightClusterId: "blind-b" },
    });
    expect(missingStored).toBeNull();

    // 缺失在无关聚类上时，其余配对的向量预筛照常工作
    const result = await precomputeClusterMergeCleanPairs(NOW, {
      embedTexts: fakeEmbedTexts({
        "OpenAI": [1, 0],
        "奥尔特曼": [1, 0],
      }),
    });
    expect(result.vectorEnabled).toBe(true);
    expect(result.vectorAdmittedPairs).toBe(1);
  });

  it("admits high-similarity unrelated subjects through vector-only precompute", async () => {
    await seedClusterWithItem(CONFLICT_PAIR[0]);
    await seedClusterWithItem(CONFLICT_PAIR[1]);

    // 向量通道独立于主体安全门；候选交 AI 终审
    const result = await precomputeClusterMergeCleanPairs(NOW, {
      embedTexts: fakeEmbedTexts({
        "苹果": [1, 0],
        "甲骨文": [0.995, 0.0999],
      }),
    });

    const stored = await prisma.clusterMergeCleanPairCandidate.findFirst({
      where: { leftClusterId: "conflict-a", rightClusterId: "conflict-b" },
    });
    expect(stored).toMatchObject({ recallSource: "vector" });
    expect(stored?.vectorSimilarity).toBeCloseTo(0.995);
    expect(result.vectorAdmittedPairs).toBe(1);

    let reachedAi = false;
    const aiProvider = {
      assessClusterMergePairs: async (clustersJson: string) => {
        const input = JSON.parse(clustersJson) as {
          pairs: Array<{ left: { id: string }; right: { id: string } }>;
        };
        expect(input.pairs).toHaveLength(1);
        expect([input.pairs[0]!.left.id, input.pairs[0]!.right.id].sort()).toEqual(["conflict-a", "conflict-b"]);
        reachedAi = true;
        return [{
          leftClusterId: "conflict-a",
          rightClusterId: "conflict-b",
          verdict: "declined" as const,
          confidence: 99,
          reasonCode: "subject_conflict",
          reasonText: "主体不同，事件无关",
        }];
      },
    } as unknown as AiProvider;
    const mergeResult = await executeClusterMerge(aiProvider, NOW);

    expect(reachedAi).toBe(true);
    expect(mergeResult).toMatchObject({ skipped: false, mergedCount: 0 });
    await expect(prisma.contentCluster.count({ where: { id: { in: ["conflict-a", "conflict-b"] } } })).resolves.toBe(2);
  });
});
