import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { normalizeFeedQualityScore } from "@/lib/feed/quality-score";

const DISPLAYABLE_MODERATION_STATUSES = ["allowed", "restored"] as const;
const DEFAULT_REFRESH_BATCH_SIZE = 200;

type RefreshableCluster = Prisma.ContentClusterGetPayload<{
  include: {
    items: {
      include: {
        source: {
          select: {
            enabled: true;
            groupId: true;
          };
        };
        tags: {
          include: {
            tag: true;
          };
        };
      };
    };
  };
}>;

function uniqueClusterIds(clusterIds: string[]) {
  return [...new Set(clusterIds.map((id) => id.trim()).filter(Boolean))];
}

function buildFeedSearchText(input: {
  title: string;
  summary: string;
  tags: Array<{ name: string; normalized: string }>;
}) {
  return [
    input.title,
    input.summary,
    ...input.tags.flatMap((tag) => (tag.name === tag.normalized ? [tag.name] : [tag.name, tag.normalized])),
  ]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ");
}

function selectDominantGroupId(
  items: RefreshableCluster["items"],
) {
  const groupCounts = new Map<string, { count: number; firstCreatedAt: Date }>();

  for (const item of items) {
    const groupId = item.source.groupId;
    if (!groupId) {
      continue;
    }

    const current = groupCounts.get(groupId);
    if (!current) {
      groupCounts.set(groupId, { count: 1, firstCreatedAt: item.createdAt });
      continue;
    }

    current.count += 1;
    if (item.createdAt.getTime() < current.firstCreatedAt.getTime()) {
      current.firstCreatedAt = item.createdAt;
    }
  }

  return [...groupCounts.entries()].sort(([leftId, left], [rightId, right]) => {
    if (right.count !== left.count) {
      return right.count - left.count;
    }

    const createdAtDiff = left.firstCreatedAt.getTime() - right.firstCreatedAt.getTime();
    if (createdAtDiff !== 0) {
      return createdAtDiff;
    }

    return leftId.localeCompare(rightId);
  })[0]?.[0] ?? null;
}

function aggregateTags(items: RefreshableCluster["items"]) {
  const tagsByNormalized = new Map<string, { name: string; normalized: string }>();

  for (const item of items) {
    for (const itemTag of item.tags) {
      const normalized = itemTag.tag.normalized.trim();
      if (!normalized || tagsByNormalized.has(normalized)) {
        continue;
      }

      tagsByNormalized.set(normalized, {
        name: itemTag.tag.name,
        normalized,
      });
    }
  }

  return [...tagsByNormalized.values()].sort((left, right) => {
    const nameCompare = left.name.localeCompare(right.name);
    return nameCompare !== 0 ? nameCompare : left.normalized.localeCompare(right.normalized);
  });
}

function getDisplayableClusterItems(cluster: RefreshableCluster) {
  return cluster.items.filter(
    (item) =>
      item.status === "processed" &&
      DISPLAYABLE_MODERATION_STATUSES.includes(item.moderationStatus as (typeof DISPLAYABLE_MODERATION_STATUSES)[number]) &&
      !item.isAggregation &&
      item.source.enabled,
  );
}

async function refreshCluster(cluster: RefreshableCluster) {
  const items = getDisplayableClusterItems(cluster);
  const now = new Date();

  if (items.length === 0) {
    await prisma.contentCluster.update({
      where: { id: cluster.id },
      data: {
        displayItemCount: 0,
        displaySourceCount: 0,
        displayAverageScore: 0,
        displayQualityScore: 0,
        earliestCreatedAt: null,
        latestCreatedAt: null,
        dominantGroupId: null,
        feedSearchText: buildFeedSearchText({ title: cluster.title, summary: cluster.summary, tags: [] }),
        feedTagsJson: "[]",
        feedStatsUpdatedAt: now,
      },
    });
    return;
  }

  const displayItemCount = items.length;
  const displaySourceCount = new Set(items.map((item) => item.sourceId)).size;
  const displayAverageScore = Math.round(items.reduce((sum, item) => sum + item.qualityScore, 0) / displayItemCount);
  const displayQualityScore = normalizeFeedQualityScore(displayAverageScore);
  const earliestCreatedAt = items.reduce((earliest, item) =>
    item.createdAt.getTime() < earliest.getTime() ? item.createdAt : earliest,
  items[0]!.createdAt);
  const latestCreatedAt = items.reduce((latest, item) =>
    item.createdAt.getTime() > latest.getTime() ? item.createdAt : latest,
  items[0]!.createdAt);
  const latestPublishedAt = items.reduce((latest, item) =>
    item.publishedAt.getTime() > latest.getTime() ? item.publishedAt : latest,
  items[0]!.publishedAt);
  const tags = aggregateTags(items);

  await prisma.contentCluster.update({
    where: { id: cluster.id },
    data: {
      displayItemCount,
      displaySourceCount,
      displayAverageScore,
      displayQualityScore,
      earliestCreatedAt,
      latestCreatedAt,
      latestPublishedAt,
      dominantGroupId: selectDominantGroupId(items),
      feedSearchText: buildFeedSearchText({ title: cluster.title, summary: cluster.summary, tags }),
      feedTagsJson: JSON.stringify(tags),
      feedStatsUpdatedAt: now,
    },
  });
}

export async function refreshClusterFeedStats(clusterIds: string[]): Promise<void> {
  const ids = uniqueClusterIds(clusterIds);
  if (ids.length === 0) {
    return;
  }

  const clusters = await prisma.contentCluster.findMany({
    where: { id: { in: ids } },
    include: {
      items: {
        include: {
          source: {
            select: {
              enabled: true,
              groupId: true,
            },
          },
          tags: {
            include: {
              tag: true,
            },
          },
        },
      },
    },
  });

  for (const cluster of clusters) {
    await refreshCluster(cluster);
  }
}

export async function refreshClusterFeedStatsSafely(clusterIds: string[], context = "cluster feed stats refresh") {
  try {
    await refreshClusterFeedStats(clusterIds);
  } catch (error) {
    console.warn(`[Cluster Feed Stats] ${context} failed:`, error);
  }
}

export async function refreshAllClusterFeedStats(options?: { batchSize?: number }): Promise<number> {
  const batchSize = Math.max(1, options?.batchSize ?? DEFAULT_REFRESH_BATCH_SIZE);
  let cursor: string | undefined;
  let refreshedCount = 0;

  while (true) {
    const clusters = await prisma.contentCluster.findMany({
      select: { id: true },
      orderBy: { id: "asc" },
      take: batchSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    if (clusters.length === 0) {
      return refreshedCount;
    }

    await refreshClusterFeedStats(clusters.map((cluster) => cluster.id));
    refreshedCount += clusters.length;
    cursor = clusters[clusters.length - 1]!.id;
  }
}
