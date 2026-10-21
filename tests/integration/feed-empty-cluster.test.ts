import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db";
import { listFeedItems } from "@/lib/feed/repository";
import { resolveFeedFilters } from "@/lib/feed/range";

const NOW = new Date("2026-04-10T12:00:00.000Z");

function buildFilters(overrides: Record<string, unknown> = {}) {
  return resolveFeedFilters(
    {
      range: "all",
      sort: "time_desc",
      start: null,
      end: null,
      groupId: null,
      sourceId: null,
      title: null,
      ...overrides,
    } as Parameters<typeof resolveFeedFilters>[0],
    NOW,
  );
}

async function createCluster(id: string, overrides: Record<string, unknown> = {}) {
  return prisma.contentCluster.create({
    data: {
      id,
      kind: "topic",
      title: `聚合 ${id}`,
      summary: `摘要 ${id}`,
      score: 90,
      status: "active",
      fingerprint: `fp-${id}`,
      latestPublishedAt: new Date("2026-04-10T09:00:00.000Z"),
      latestCreatedAt: new Date("2026-04-10T09:05:00.000Z"),
      // 缓存计数仍为 2：真实成员可能已全部不可见。
      displayItemCount: 2,
      displaySourceCount: 1,
      displayAverageScore: 90,
      displayQualityScore: 90,
      ...overrides,
    } as Parameters<typeof prisma.contentCluster.create>[0]["data"],
  });
}

async function createItem(
  id: string,
  sourceId: string,
  clusterId: string | null,
  overrides: Record<string, unknown> = {},
) {
  return prisma.item.create({
    data: {
      id,
      sourceId,
      clusterId,
      originalUrl: `https://example.com/${id}`,
      canonicalUrl: `https://example.com/${id}`,
      urlHash: `hash-${id}`,
      originalTitle: `Title ${id}`,
      publishedAt: new Date("2026-04-10T09:00:00.000Z"),
      createdAt: new Date("2026-04-10T09:05:00.000Z"),
      status: "processed",
      moderationStatus: "allowed",
      isAggregation: false,
      qualityScore: 80,
      ...overrides,
    } as Parameters<typeof prisma.item.create>[0]["data"],
  });
}

describe("feed empty cluster admission", () => {
  let enabledSourceId: string;
  let disabledSourceId: string;

  beforeEach(async () => {
    await prisma.item.deleteMany();
    await prisma.itemEntity.deleteMany();
    await prisma.contentCluster.deleteMany();
    await prisma.fetchRun.deleteMany();
    await prisma.source.deleteMany();
    await prisma.sourceGroup.deleteMany();

    const group = await prisma.sourceGroup.create({
      data: { id: "group-ai", name: "AI", color: "#3b82f6" },
    });
    const enabled = await prisma.source.create({
      data: {
        name: "Enabled Feed",
        rssUrl: "https://enabled.example.com/feed.xml",
        siteUrl: "https://enabled.example.com",
        enabled: true,
        aiParsingEnabled: true,
        groupId: group.id,
      },
    });
    const disabled = await prisma.source.create({
      data: {
        name: "Disabled Feed",
        rssUrl: "https://disabled.example.com/feed.xml",
        siteUrl: "https://disabled.example.com",
        enabled: false,
        aiParsingEnabled: true,
        groupId: group.id,
      },
    });
    enabledSourceId = enabled.id;
    disabledSourceId = disabled.id;
  });

  it("excludes a cached-count cluster whose only members are filtered out", async () => {
    await createCluster("cluster-hidden");
    await createItem("hidden-1", enabledSourceId, "cluster-hidden", { moderationStatus: "filtered" });
    await createItem("hidden-2", enabledSourceId, "cluster-hidden", { moderationStatus: "filtered" });

    const result = await listFeedItems(buildFilters(), { page: 1, size: 20 });

    expect(result.items.find((item) => item.id === "cluster-hidden")).toBeUndefined();
    expect(result.pagination.total).toBe(0);
  });

  it("excludes a cached-count cluster whose only members come from a disabled source", async () => {
    await createCluster("cluster-disabled-source");
    await createItem("disabled-1", disabledSourceId, "cluster-disabled-source");
    await createItem("disabled-2", disabledSourceId, "cluster-disabled-source");

    const result = await listFeedItems(buildFilters(), { page: 1, size: 20 });

    expect(result.items.find((item) => item.id === "cluster-disabled-source")).toBeUndefined();
    expect(result.pagination.total).toBe(0);
  });

  it("excludes a cluster whose only members are unprocessed or aggregation roots", async () => {
    await createCluster("cluster-not-processed");
    await createItem("pending-1", enabledSourceId, "cluster-not-processed", { status: "new" });
    await createItem("pending-2", enabledSourceId, "cluster-not-processed", { status: "new" });

    await createCluster("cluster-aggregation-root");
    await createItem("agg-1", enabledSourceId, "cluster-aggregation-root", { isAggregation: true });
    await createItem("agg-2", enabledSourceId, "cluster-aggregation-root", { isAggregation: true });

    const result = await listFeedItems(buildFilters(), { page: 1, size: 20 });
    const ids = result.items.map((item) => item.id);

    expect(ids).not.toContain("cluster-not-processed");
    expect(ids).not.toContain("cluster-aggregation-root");
  });

  it("keeps the cluster visible when exactly one member is eligible", async () => {
    await createCluster("cluster-one-visible");
    await createItem("visible-1", enabledSourceId, "cluster-one-visible");
    await createItem("visible-2", enabledSourceId, "cluster-one-visible", { moderationStatus: "filtered" });

    const result = await listFeedItems(buildFilters(), { page: 1, size: 20 });
    const entry = result.items.find((item) => item.id === "cluster-one-visible");

    expect(entry).toBeDefined();
    expect(entry?.type === "cluster" ? entry.itemsPreview.map((item) => item.id) : []).toEqual(["visible-1"]);
    expect(result.pagination.total).toBe(1);
  });

  it("agrees between exact entry lookup, group counts and the paginated list", async () => {
    await createCluster("cluster-empty-exact", { dominantGroupId: "group-ai" });
    await createItem("empty-exact-1", enabledSourceId, "cluster-empty-exact", { moderationStatus: "filtered" });
    await createItem("empty-exact-2", enabledSourceId, "cluster-empty-exact", { moderationStatus: "filtered" });
    await createCluster("cluster-valid-exact", { dominantGroupId: "group-ai" });
    await createItem("valid-exact-1", enabledSourceId, "cluster-valid-exact");
    await createItem("valid-exact-2", enabledSourceId, "cluster-valid-exact");

    const listResult = await listFeedItems(buildFilters(), { page: 1, size: 20 });
    const listIds = listResult.items.map((item) => item.id);
    expect(listIds).toContain("cluster-valid-exact");
    expect(listIds).not.toContain("cluster-empty-exact");
    expect(listResult.pagination.total).toBe(1);

    const emptyLookup = await listFeedItems(
      buildFilters({ entryId: "cluster-empty-exact", entryType: "cluster" }),
      { page: 1, size: 20 },
    );
    expect(emptyLookup.items).toHaveLength(0);
    expect(emptyLookup.pagination.total).toBe(0);

    const validLookup = await listFeedItems(
      buildFilters({ entryId: "cluster-valid-exact", entryType: "cluster" }),
      { page: 1, size: 20 },
    );
    expect(validLookup.items.map((item) => item.id)).toEqual(["cluster-valid-exact"]);

    const grouped = await listFeedItems(buildFilters({ groupId: "group-ai" }), { page: 1, size: 20 });
    expect(grouped.items.map((item) => item.id)).toEqual(["cluster-valid-exact"]);
    expect(grouped.pagination.total).toBe(1);
  });

  it("keeps a valid 4-member lazy cluster with a 3-item preview and normal expansion", async () => {
    await createCluster("cluster-lazy", { displayItemCount: 4, displaySourceCount: 2 });
    for (const index of [1, 2, 3, 4]) {
      await createItem(`lazy-${index}`, enabledSourceId, "cluster-lazy");
    }

    const result = await listFeedItems(buildFilters(), { page: 1, size: 20 });
    const entry = result.items.find((item) => item.id === "cluster-lazy");

    expect(entry).toBeDefined();
    expect(entry).toMatchObject({ type: "cluster", itemCount: 4 });
    expect(entry?.type === "cluster" ? entry.itemsPreview : []).toHaveLength(3);
    expect(entry?.type === "cluster" ? entry.hasMoreItems : null).toBe(true);
  });
});
