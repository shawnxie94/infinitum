import { beforeEach, describe, expect, it } from "vitest";

import { refreshClusterFeedStats } from "@/lib/clusters/feed-stats";
import { prisma } from "@/lib/db";
import {
  addEntityAlias,
  backfillItemEntities,
  mergeEntities,
  replaceItemEntities,
} from "@/lib/entities/service";

async function createSource() {
  return prisma.source.create({
    data: {
      id: "entity-alias-source",
      name: "Entity Alias Feed",
      rssUrl: "https://entity-alias.example.com/feed.xml",
      siteUrl: "https://entity-alias.example.com",
      enabled: true,
      aiParsingEnabled: true,
    },
  });
}

async function createCluster() {
  return prisma.contentCluster.create({
    data: {
      id: "entity-alias-cluster",
      kind: "topic",
      title: "AI Agent 发布",
      summary: "标签归一测试聚合",
      score: 80,
      itemCount: 3,
      latestPublishedAt: new Date("2026-04-10T10:00:00.000Z"),
      status: "active",
      fingerprint: "entity-alias-cluster",
    },
  });
}

async function createItem(input: {
  id: string;
  sourceId: string;
  clusterId?: string | null;
  title: string;
  createdAt?: Date;
}) {
  return prisma.item.create({
    data: {
      id: input.id,
      sourceId: input.sourceId,
      clusterId: input.clusterId ?? null,
      originalUrl: `https://entity-alias.example.com/${input.id}`,
      canonicalUrl: `https://entity-alias.example.com/${input.id}`,
      urlHash: input.id,
      originalTitle: input.title,
      translatedTitle: input.title,
      publishedAt: new Date("2026-04-10T10:00:00.000Z"),
      status: "processed",
      moderationStatus: "allowed",
      qualityScore: 80,
      qualityRationale: "ok",
      language: "zh",
      createdAt: input.createdAt ?? new Date("2026-04-10T10:05:00.000Z"),
    },
  });
}

describe("entity aliases and merge", () => {
  beforeEach(async () => {
    await prisma.item.deleteMany();
    await prisma.entity.deleteMany();
    await prisma.contentCluster.deleteMany();
    await prisma.source.deleteMany();
  });

  it("resolves confirmed aliases before writing item entities", async () => {
    const source = await createSource();
    await createItem({
      id: "canonical-item",
      sourceId: source.id,
      title: "OpenAI 发布 AI Agent",
    });
    await createItem({
      id: "alias-item",
      sourceId: source.id,
      title: "OpenAI 发布智能体",
    });

    await replaceItemEntities("canonical-item", ["AI Agent"]);
    const canonical = await prisma.entity.findUniqueOrThrow({
      where: { normalized: "ai agent" },
    });
    await addEntityAlias({
      entityId: canonical.id,
      aliasName: "智能体",
    });
    await replaceItemEntities("alias-item", ["智能体", "AI Agent"]);

    const entities = await prisma.entity.findMany({
      include: {
        items: true,
        aliases: true,
      },
      orderBy: { normalized: "asc" },
    });

    expect(entities).toHaveLength(1);
    expect(entities[0]?.normalized).toBe("ai agent");
    expect(entities[0]?.items).toHaveLength(2);
    expect(entities[0]?.aliases.map((alias) => alias.aliasNormalized)).toEqual(["智能体"]);
  });

  it("auto-canonicalizes high-confidence new entity variants before writing item entities", async () => {
    const source = await createSource();
    await createItem({
      id: "canonical-openai-item",
      sourceId: source.id,
      title: "OpenAI 发布模型",
    });
    await createItem({
      id: "variant-open-ai-item",
      sourceId: source.id,
      title: "Open AI 发布工具",
    });

    await replaceItemEntities("canonical-openai-item", ["OpenAI"]);
    await replaceItemEntities("variant-open-ai-item", ["Open AI"]);

    const entities = await prisma.entity.findMany({
      include: {
        aliases: true,
        items: true,
      },
      orderBy: { normalized: "asc" },
    });

    expect(entities).toHaveLength(1);
    expect(entities[0]?.normalized).toBe("openai");
    expect(entities[0]?.items).toHaveLength(2);
    expect(entities[0]?.aliases.map((alias) => alias.aliasNormalized)).toEqual(["open ai"]);
    expect(entities[0]?.aliases[0]?.createdBy).toBe("system:auto-canonical");
  });

  it("rebuilds event entities and is idempotent", async () => {
    const source = await createSource();
    await createItem({
      id: "entity-backfill-item",
      sourceId: source.id,
      title: "OpenAI 发布 Codex",
    });
    await prisma.item.update({
      where: { id: "entity-backfill-item" },
      data: {
        eventSubject: "OpenAI",
        eventObject: "Codex",
      },
    });
    const first = await backfillItemEntities({ batchSize: 1 });
    const second = await backfillItemEntities({ batchSize: 1 });
    const entities = await prisma.itemEntity.findMany({
      where: { itemId: "entity-backfill-item" },
      include: { entity: true },
      orderBy: { entity: { normalized: "asc" } },
    });

    expect(first.scannedItems).toBe(1);
    expect(first.changedItems).toBe(1);
    expect(second.changedItems).toBe(0);
    expect(entities.map((entry) => entry.entity.normalized)).toEqual([
      "codex",
      "openai",
    ]);
  });

  it("does not rewrite item entity relations when the canonical entity set is unchanged", async () => {
    const source = await createSource();
    await createItem({
      id: "stable-entity-relations-item",
      sourceId: source.id,
      title: "OpenAI 发布 AI Agent",
    });

    await replaceItemEntities("stable-entity-relations-item", ["OpenAI", "AI Agent"]);
    const firstRelations = await prisma.itemEntity.findMany({
      where: { itemId: "stable-entity-relations-item" },
      orderBy: { entityId: "asc" },
      select: {
        id: true,
        entityId: true,
        createdAt: true,
      },
    });

    await replaceItemEntities("stable-entity-relations-item", ["AI Agent", "OpenAI"]);
    const secondRelations = await prisma.itemEntity.findMany({
      where: { itemId: "stable-entity-relations-item" },
      orderBy: { entityId: "asc" },
      select: {
        id: true,
        entityId: true,
        createdAt: true,
      },
    });

    expect(secondRelations).toEqual(firstRelations);
  });

  it("merges source entities into the canonical entity and preserves old names as aliases", async () => {
    const source = await createSource();
    await createCluster();
    await createItem({
      id: "target-item",
      sourceId: source.id,
      clusterId: "entity-alias-cluster",
      title: "AI Agent",
    });
    await createItem({
      id: "source-item",
      sourceId: source.id,
      clusterId: "entity-alias-cluster",
      title: "AI Agents",
      createdAt: new Date("2026-04-10T10:06:00.000Z"),
    });
    await createItem({
      id: "overlap-item",
      sourceId: source.id,
      clusterId: "entity-alias-cluster",
      title: "Overlap",
      createdAt: new Date("2026-04-10T10:07:00.000Z"),
    });

    await replaceItemEntities("target-item", ["AI Agent"]);
    const target = await prisma.entity.findUniqueOrThrow({
      where: { normalized: "ai agent" },
    });
    const sourceEntity = await prisma.entity.create({
      data: {
        name: "AI Agents",
        normalized: "ai agents",
      },
    });
    await prisma.itemEntity.createMany({
      data: [
        {
          itemId: "source-item",
          entityId: sourceEntity.id,
        },
        {
          itemId: "overlap-item",
          entityId: target.id,
        },
        {
          itemId: "overlap-item",
          entityId: sourceEntity.id,
        },
      ],
    });
    await refreshClusterFeedStats(["entity-alias-cluster"]);

    const result = await mergeEntities({
      targetEntityId: target.id,
      sourceEntityIds: [sourceEntity.id],
    });

    expect(result).toEqual({ mergedCount: 1, affectedClusterCount: 1 });
    await expect(prisma.entity.findUnique({ where: { id: sourceEntity.id } })).resolves.toBeNull();

    const canonical = await prisma.entity.findUniqueOrThrow({
      where: { id: target.id },
      include: {
        aliases: true,
        items: true,
      },
    });
    expect(canonical.aliases.map((alias) => alias.aliasNormalized)).toEqual(["ai agents"]);
    expect(canonical.items).toHaveLength(3);

    const overlapItemEntities = await prisma.itemEntity.findMany({
      where: { itemId: "overlap-item" },
    });
    expect(overlapItemEntities).toHaveLength(1);
    expect(overlapItemEntities[0]?.entityId).toBe(target.id);

    const cluster = await prisma.contentCluster.findUniqueOrThrow({
      where: { id: "entity-alias-cluster" },
    });
    const feedTags = JSON.parse(cluster.feedEntitiesJson) as Array<{ normalized: string }>;
    expect(feedTags.map((entity) => entity.normalized)).toEqual(["ai agent"]);
  });
});
