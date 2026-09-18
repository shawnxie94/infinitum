import { afterEach, describe, expect, it } from "vitest";

import { buildClusterMergeCandidateInputHash, scoreClusterMergeCandidatePair } from "@/lib/clusters/helpers";
import type { EmbedTextsFn } from "@/lib/ai/embeddings";
import { precomputeClusterMergeCleanPairs } from "@/lib/clusters/service";
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
    title: "OpenAI 宣布重组核心领导团队并成立四个全新研究部门",
    summary: "山姆·奥尔特曼在一封全员信中公布了新的组织架构。",
  },
  {
    id: "blind-b",
    title: "萨姆·奥尔特曼重塑公司治理架构，研究板块拆分为四个部门",
    summary: "这家 ChatGPT 开发商本周确认了内部组织的一系列调整。",
  },
];

// 实体冲突的一对：对象零共享词（无关系词桥接），确保规则 early-reject object_conflict；
// 向量再相似也不得提名
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
  await prisma.clusterMergeCleanPairCandidate.deleteMany({});
  await prisma.item.deleteMany({ where: { source: { rssUrl: { contains: "merge-gray.example.com" } } } });
  await prisma.source.deleteMany({ where: { rssUrl: { contains: "merge-gray.example.com" } } });
  await prisma.contentCluster.deleteMany({ where: { id: { in: ["blind-a", "blind-b", "conflict-a", "conflict-b"] } } });
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
    expect(stored!.score).toBe(100); // sim=1 → round(100)
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

  it("vetoes object-conflict pairs below the override similarity", async () => {
    await seedClusterWithItem(CONFLICT_PAIR[0]);
    await seedClusterWithItem(CONFLICT_PAIR[1]);
    const left = await prisma.contentCluster.findUnique({ where: { id: CONFLICT_PAIR[0].id } });
    const right = await prisma.contentCluster.findUnique({ where: { id: CONFLICT_PAIR[1].id } });
    // 前置条件：规则确实以 object_conflict 拒绝该对
    expect(scoreRawPair(left!, right!).rejectedReason).toBe("object_conflict");

    // cos ≈ 0.65（< 0.72 豁免线，B4 校准后豁免线与向量准入线对齐）：实体冲突仍否决
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

  it("nominates object-conflict pairs at very high similarity (extraction noise)", async () => {
    await seedClusterWithItem(CONFLICT_PAIR[0]);
    await seedClusterWithItem(CONFLICT_PAIR[1]);

    // cos ≈ 0.995（≥ 0.9 豁免线）：视为抽取噪声，提名交 LLM 终审
    const result = await precomputeClusterMergeCleanPairs(NOW, {
      embedTexts: fakeEmbedTexts({
        "苹果": [1, 0],
        "甲骨文": [0.995, 0.0999],
      }),
    });

    const stored = await prisma.clusterMergeCleanPairCandidate.findFirst({
      where: { leftClusterId: "conflict-a", rightClusterId: "conflict-b" },
    });
    expect(stored).not.toBeNull();
    expect(result.vectorAdmittedPairs).toBe(1);
  });
});
