import { afterEach, describe, expect, it } from "vitest";

import { createEmbedTexts, type EmbedTextsFn } from "@/lib/ai/embeddings";
import type { AiProvider, EntityAliasCheckDecision } from "@/lib/ai/provider";
import { precomputeClusterMergeCleanPairs } from "@/lib/clusters/service";
import { prisma } from "@/lib/db";
import {
  autoNormalizeEntityAliases,
  precomputeEntitySuggestionCandidates,
} from "@/lib/entities/service";
import { loadMentionResolver, resetMentionResolverCache } from "@/lib/entities/mention-resolution";

const NOW = new Date("2026-09-19T08:00:00.000Z");

const created = {
  sources: [] as string[],
  clusters: [] as string[],
  items: [] as string[],
};

async function seedClusterWithSubjects(id: string, subjects: string[]) {
  const source = await prisma.source.create({
    data: {
      name: `alias-auto-${id}`,
      rssUrl: `https://alias-auto.example.com/${id}.xml`,
      siteUrl: `https://alias-auto.example.com/${id}`,
      enabled: true,
      aiParsingEnabled: true,
      aggregationEnabled: true,
    },
  });
  created.sources.push(source.id);
  const publishedAt = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
  const cluster = await prisma.contentCluster.create({
    data: {
      id,
      kind: "topic",
      title: `${id} 聚类标题`,
      summary: `${id} 聚类摘要`,
      score: 60,
      itemCount: subjects.length,
      latestPublishedAt: publishedAt,
      createdAt: publishedAt,
      updatedAt: publishedAt,
      status: "active",
      fingerprint: `fp-${id}`,
    },
  });
  created.clusters.push(cluster.id);

  for (const [index, subject] of subjects.entries()) {
    const item = await prisma.item.create({
      data: {
        id: `${id}-item-${index}`,
        sourceId: source.id,
        clusterId: id,
        originalUrl: `https://alias-auto.example.com/${id}/item-${index}`,
        canonicalUrl: `https://alias-auto.example.com/${id}/item-${index}`,
        urlHash: `${id}-item-hash-${index}`,
        originalTitle: `${subject} 相关报道 ${index}`,
        publishedAt,
        createdAt: publishedAt,
        summaryText: `${subject} 的正文摘要 ${index}`,
        status: "processed",
        moderationStatus: "allowed",
        qualityScore: 80,
        qualityRationale: "test",
        eventSubject: subject,
      },
    });
    created.items.push(item.id);
  }
}

async function seedEntityPair() {
  const zhipu = await prisma.entity.create({ data: { name: "智谱", normalized: "智谱" } });
  const zai = await prisma.entity.create({ data: { name: "Z.ai", normalized: "z.ai" } });
  return { zhipu, zai };
}

function fakeProvider(
  decide: (pair: { aName: string; bName: string }) => EntityAliasCheckDecision,
): AiProvider {
  return {
    assessEntityAliasPairs: async (input: { pairs: Array<{ aName: string; bName: string }> }) =>
      input.pairs.map((pair) => decide(pair)),
  } as unknown as AiProvider;
}

afterEach(async () => {
  resetMentionResolverCache();
  await prisma.entityAlias.deleteMany({ where: { createdBy: "auto-llm" } });
  await prisma.entity.deleteMany({ where: { normalized: { in: ["智谱", "z.ai"] } } });
  await prisma.item.deleteMany({ where: { id: { in: created.items } } });
  await prisma.contentCluster.deleteMany({ where: { id: { in: created.clusters } } });
  await prisma.source.deleteMany({ where: { id: { in: created.sources } } });
  await prisma.clusterMergeCleanPairCandidate.deleteMany({});
  await prisma.entitySuggestionCandidate.deleteMany({});
  created.sources = [];
  created.clusters = [];
  created.items = [];
});

describe("autoNormalizeEntityAliases", () => {
  it("degrades to no-op when provider lacks adjudication", async () => {
    await seedClusterWithSubjects("alias-auto-1", ["智谱", "Z.ai"]);
    await seedEntityPair();
    const provider = {} as AiProvider;

    const { result } = await autoNormalizeEntityAliases(NOW, provider);
    expect(result.adjudicatedPairs).toBe(0);
    expect(result.autoMergedAliases).toBe(0);
  });

  it("writes the alias on high confidence and resets the resolver cache", async () => {
    await seedClusterWithSubjects("alias-auto-1", ["智谱", "Z.ai"]);
    const { zhipu } = await seedEntityPair();

    // 预热缓存：Z.ai 本身是实体行，解析为自身名（identity）；尚未指向智谱
    const resolverBefore = await loadMentionResolver(["Z.ai"]);
    expect(resolverBefore("Z.ai")).toBe("Z.ai");

    const provider = fakeProvider(() => ({
      isSameEntity: true,
      confidence: "high",
      canonicalName: "智谱",
    }));
    const { result } = await autoNormalizeEntityAliases(NOW, provider);

    expect(result.candidatePairs).toBeGreaterThanOrEqual(1);
    expect(result.autoMergedAliases).toBe(1);
    const alias = await prisma.entityAlias.findFirstOrThrow({
      where: { entityId: zhipu.id, aliasNormalized: "z.ai" },
    });
    expect(alias.createdBy).toBe("auto-llm");

    // 缓存已被重置：解析层立即可见新别名
    const resolverAfter = await loadMentionResolver(["Z.ai"]);
    expect(resolverAfter("Z.ai")).toBe("智谱");
  });

  it("uses canonicalName to choose the existing target entity", async () => {
    await seedClusterWithSubjects("alias-auto-1", ["智谱", "Z.ai"]);
    const { zhipu, zai } = await seedEntityPair();

    const provider = fakeProvider(() => ({
      isSameEntity: true,
      confidence: "high",
      canonicalName: "Z.ai",
    }));
    const { result } = await autoNormalizeEntityAliases(NOW, provider);

    expect(result.autoMergedAliases).toBe(1);
    await expect(prisma.entityAlias.findFirstOrThrow({
      where: { aliasNormalized: "智谱" },
    })).resolves.toMatchObject({ entityId: zai.id });
    expect(await prisma.entityAlias.findFirst({ where: { entityId: zhipu.id, aliasNormalized: "z.ai" } })).toBeNull();
  });

  it("does not auto-alias when canonicalName is outside the adjudicated pair", async () => {
    await seedClusterWithSubjects("alias-auto-1", ["智谱", "Z.ai"]);
    const { zhipu, zai } = await seedEntityPair();

    const provider = fakeProvider(() => ({
      isSameEntity: true,
      confidence: "high",
      canonicalName: "全新规范名称",
    }));
    const { result, mediumRecords } = await autoNormalizeEntityAliases(NOW, provider);

    expect(result.autoMergedAliases).toBe(0);
    expect(mediumRecords).toHaveLength(1);
    expect(await prisma.entityAlias.count({ where: { entityId: { in: [zhipu.id, zai.id] } } })).toBe(0);
  });

  it("routes medium confidence to governance suggestions via non-destructive precompute", async () => {
    await seedClusterWithSubjects("alias-auto-1", ["智谱", "Z.ai"]);
    const { zhipu, zai } = await seedEntityPair();

    const provider = fakeProvider(() => ({
      isSameEntity: true,
      confidence: "medium",
      canonicalName: "智谱",
    }));
    const { mediumRecords } = await autoNormalizeEntityAliases(NOW, provider);
    expect(mediumRecords).toHaveLength(1);
    // 只断言本测试的实体对没有写别名：并行套件共享 DB，全局计数会看到其他文件的行
    expect(
      await prisma.entityAlias.count({
        where: { entityId: { in: [zhipu.id, zai.id] } },
      }),
    ).toBe(0);

    const precompute = await precomputeEntitySuggestionCandidates(NOW, {
      additionalRecords: mediumRecords,
    });
    expect(precompute.storedCandidates).toBeGreaterThanOrEqual(1);
    // 方向由 compareCanonicalPreference 决定，按 reason 定位
    const suggestion = await prisma.entitySuggestionCandidate.findFirstOrThrow({
      where: { reason: "auto_alias_vote" },
    });
    expect(suggestion.pairKey).toBe(mediumRecords[0]!.pairKey);

    // 非破坏性：再次重建不产生别名相关的相似度草稿，但外部来源的候选保留
    await precomputeEntitySuggestionCandidates(NOW);
    expect(
      await prisma.entitySuggestionCandidate.count({
        where: { reason: "auto_alias_vote" },
      }),
    ).toBe(1);
  });
});

describe("precompute embedTexts wiring", () => {
  it("accepts injected embedTexts on the clean-pair precompute", async () => {
    const embedTexts: EmbedTextsFn = async (texts) => texts.map(() => [1, 0]);
    const result = await precomputeClusterMergeCleanPairs(NOW, {
      embedTexts: createEmbedTexts(null, { client: null }) ?? embedTexts,
    });
    // createEmbedTexts(null) 返回恒 null 的降级函数 → 向量通道关闭，不阻断
    expect(result.vectorEnabled).toBe(false);
  });
});
