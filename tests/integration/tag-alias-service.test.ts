import { beforeEach, describe, expect, it } from "vitest";

import { refreshClusterFeedStats } from "@/lib/clusters/feed-stats";
import { prisma } from "@/lib/db";
import { addTagAlias, mergeTags, replaceItemTags } from "@/lib/tags/service";

async function createSource() {
  return prisma.source.create({
    data: {
      id: "tag-alias-source",
      name: "Tag Alias Feed",
      rssUrl: "https://tag-alias.example.com/feed.xml",
      siteUrl: "https://tag-alias.example.com",
      enabled: true,
      aiParsingEnabled: true,
    },
  });
}

async function createCluster() {
  return prisma.contentCluster.create({
    data: {
      id: "tag-alias-cluster",
      kind: "topic",
      title: "AI Agent 发布",
      summary: "标签归一测试聚合",
      score: 80,
      itemCount: 3,
      latestPublishedAt: new Date("2026-04-10T10:00:00.000Z"),
      status: "active",
      fingerprint: "tag-alias-cluster",
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
      originalUrl: `https://tag-alias.example.com/${input.id}`,
      canonicalUrl: `https://tag-alias.example.com/${input.id}`,
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

describe("tag aliases and merge", () => {
  beforeEach(async () => {
    await prisma.item.deleteMany();
    await prisma.tag.deleteMany();
    await prisma.contentCluster.deleteMany();
    await prisma.source.deleteMany();
  });

  it("resolves confirmed aliases before writing item tags", async () => {
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

    await replaceItemTags("canonical-item", ["AI Agent"]);
    const canonical = await prisma.tag.findUniqueOrThrow({
      where: { normalized: "ai agent" },
    });
    await addTagAlias({
      tagId: canonical.id,
      aliasName: "智能体",
    });
    await replaceItemTags("alias-item", ["智能体", "AI Agent"]);

    const tags = await prisma.tag.findMany({
      include: {
        items: true,
        aliases: true,
      },
      orderBy: { normalized: "asc" },
    });

    expect(tags).toHaveLength(1);
    expect(tags[0]?.normalized).toBe("ai agent");
    expect(tags[0]?.items).toHaveLength(2);
    expect(tags[0]?.aliases.map((alias) => alias.aliasNormalized)).toEqual(["智能体"]);
  });

  it("auto-canonicalizes high-confidence new tag variants before writing item tags", async () => {
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

    await replaceItemTags("canonical-openai-item", ["OpenAI"]);
    await replaceItemTags("variant-open-ai-item", ["Open AI"]);

    const tags = await prisma.tag.findMany({
      include: {
        aliases: true,
        items: true,
      },
      orderBy: { normalized: "asc" },
    });

    expect(tags).toHaveLength(1);
    expect(tags[0]?.normalized).toBe("openai");
    expect(tags[0]?.items).toHaveLength(2);
    expect(tags[0]?.aliases.map((alias) => alias.aliasNormalized)).toEqual(["open ai"]);
    expect(tags[0]?.aliases[0]?.createdBy).toBe("system:auto-canonical");
  });

  it("does not rewrite item tag relations when the canonical tag set is unchanged", async () => {
    const source = await createSource();
    await createItem({
      id: "stable-tag-relations-item",
      sourceId: source.id,
      title: "OpenAI 发布 AI Agent",
    });

    await replaceItemTags("stable-tag-relations-item", ["OpenAI", "AI Agent"]);
    const firstRelations = await prisma.itemTag.findMany({
      where: { itemId: "stable-tag-relations-item" },
      orderBy: { tagId: "asc" },
      select: {
        id: true,
        tagId: true,
        createdAt: true,
      },
    });

    await replaceItemTags("stable-tag-relations-item", ["AI Agent", "OpenAI"]);
    const secondRelations = await prisma.itemTag.findMany({
      where: { itemId: "stable-tag-relations-item" },
      orderBy: { tagId: "asc" },
      select: {
        id: true,
        tagId: true,
        createdAt: true,
      },
    });

    expect(secondRelations).toEqual(firstRelations);
  });

  it("merges source tags into the canonical tag and preserves old names as aliases", async () => {
    const source = await createSource();
    await createCluster();
    await createItem({
      id: "target-item",
      sourceId: source.id,
      clusterId: "tag-alias-cluster",
      title: "AI Agent",
    });
    await createItem({
      id: "source-item",
      sourceId: source.id,
      clusterId: "tag-alias-cluster",
      title: "AI Agents",
      createdAt: new Date("2026-04-10T10:06:00.000Z"),
    });
    await createItem({
      id: "overlap-item",
      sourceId: source.id,
      clusterId: "tag-alias-cluster",
      title: "Overlap",
      createdAt: new Date("2026-04-10T10:07:00.000Z"),
    });

    await replaceItemTags("target-item", ["AI Agent"]);
    const target = await prisma.tag.findUniqueOrThrow({
      where: { normalized: "ai agent" },
    });
    const sourceTag = await prisma.tag.create({
      data: {
        name: "AI Agents",
        normalized: "ai agents",
      },
    });
    await prisma.itemTag.createMany({
      data: [
        {
          itemId: "source-item",
          tagId: sourceTag.id,
        },
        {
          itemId: "overlap-item",
          tagId: target.id,
        },
        {
          itemId: "overlap-item",
          tagId: sourceTag.id,
        },
      ],
    });
    await refreshClusterFeedStats(["tag-alias-cluster"]);

    const result = await mergeTags({
      targetTagId: target.id,
      sourceTagIds: [sourceTag.id],
    });

    expect(result).toEqual({ mergedCount: 1, affectedClusterCount: 1 });
    await expect(prisma.tag.findUnique({ where: { id: sourceTag.id } })).resolves.toBeNull();

    const canonical = await prisma.tag.findUniqueOrThrow({
      where: { id: target.id },
      include: {
        aliases: true,
        items: true,
      },
    });
    expect(canonical.aliases.map((alias) => alias.aliasNormalized)).toEqual(["ai agents"]);
    expect(canonical.items).toHaveLength(3);

    const overlapItemTags = await prisma.itemTag.findMany({
      where: { itemId: "overlap-item" },
    });
    expect(overlapItemTags).toHaveLength(1);
    expect(overlapItemTags[0]?.tagId).toBe(target.id);

    const cluster = await prisma.contentCluster.findUniqueOrThrow({
      where: { id: "tag-alias-cluster" },
    });
    const feedTags = JSON.parse(cluster.feedTagsJson) as Array<{ normalized: string }>;
    expect(feedTags.map((tag) => tag.normalized)).toEqual(["ai agent"]);
  });
});
