import {
  type FetchRun,
  FetchRunStatus,
  type Item,
  type ModerationReason,
  Prisma,
  type Source,
  type SourceGroup,
} from "@prisma/client";

import { prisma } from "@/lib/db";
import { getDisplaySummary, getDisplayTitle, normalizeDisplaySummary, shouldTranslateTitle } from "@/lib/feed/presentation";
import { buildFeedQualityScoreSql, normalizeFeedQualityScore } from "@/lib/feed/quality-score";
import { toGroupBadge, type GroupBadge } from "@/lib/groups/badge";
import { getDatabaseSearchTerms } from "@/lib/utils/search";
import type {
  AggregationSplitChildDTO,
  AggregationSplitParentDTO,
  ClusterDTO,
  FeedGroupOption,
  FeedClusterPreviewItemDTO,
  FeedEntryDTO,
  FeedFilters,
  FeedItemDTO,
  FeedPagination,
  FeedSourceOption,
  FetchRunSnapshot,
  ReviewItemDTO,
  SourceConfig,
} from "@/lib/feed/types";

const DISPLAYABLE_MODERATION_STATUSES = ["allowed", "restored"] as const;
const isClusterEntityFilteringEnabled = () => process.env.FEED_CLUSTER_ENTITY_FILTERING_ENABLED !== "false";
const aggregationParentSelect = {
  id: true,
  originalTitle: true,
  translatedTitle: true,
  originalUrl: true,
} satisfies Prisma.ItemSelect;

type ItemWithSource = Item & {
  source: Source & { group?: SourceGroup | null };
  parent?: Pick<Item, "id" | "originalTitle" | "translatedTitle" | "originalUrl"> | null;
};

type AggregationSplitChildWithSource = Item & {
  source: Pick<Source, "name">;
  cluster?: { id: string; title: string } | null;
};

type AggregationSplitLinkWithChild = {
  eventIndex: number;
  child: AggregationSplitChildWithSource;
};

type AggregationSplitParentWithChildren = Item & {
  source: Pick<Source, "name">;
  children: AggregationSplitChildWithSource[];
  aggregationSplitChildren: AggregationSplitLinkWithChild[];
};

type FeedEntryRow = {
  id: string;
  entryType: "single" | "cluster";
  clusterId?: string | null;
  title?: string;
  summary?: string | null;
  latestPublishedAt: Date | string;
  createdAt: Date | string;
  score: number | bigint;
  sourceCount: number | bigint;
  itemCount: number | bigint;
  totalItemCount?: number | bigint;
  qualityScore?: number | bigint;
};

type FeedClusterMetadataRow = {
  id: string;
  title: string;
  summary: string;
  dominantGroup?: SourceGroup | null;
};

type CountRow = {
  total: bigint;
};

type IdRow = {
  id: string;
};

type ClusterWithPreviewItems = Prisma.ContentClusterGetPayload<{
  include: {
    items: {
      include: {
        source: {
          include: {
            group: true;
          };
        };
        parent: {
          select: {
            id: true;
            originalTitle: true;
            translatedTitle: true;
            originalUrl: true;
          };
        };
      };
    };
  };
}>;

type FeedGroupCountRow = {
  id: string;
  name: string;
  sortOrder: number | bigint;
  count: bigint;
};


type ClusterScoreStats = {
  aiScore: number;
  itemCount: number;
  sourceCount: number;
  qualityScore: number;
};

type ClusterScoreStatsRow = {
  clusterId: string;
  aiScore: number | bigint;
  itemCount: number | bigint;
  sourceCount: number | bigint;
  qualityScore: number | bigint;
};

export async function syncSources(sourceConfigs: SourceConfig[]) {
  for (const source of sourceConfigs) {
    await prisma.source.upsert({
      where: { rssUrl: source.rssUrl },
      update: {
        name: source.name,
        siteUrl: source.siteUrl,
        enabled: source.enabled,
        aiParsingEnabled: source.aiParsingEnabled,
        aggregationEnabled: source.aggregationEnabled ?? true,
        aggregationDetectionEnabled: source.aggregationDetectionEnabled ?? false,
      },
      create: {
        name: source.name,
        rssUrl: source.rssUrl,
        siteUrl: source.siteUrl,
        enabled: source.enabled,
        aiParsingEnabled: source.aiParsingEnabled,
        aggregationEnabled: source.aggregationEnabled ?? true,
        aggregationDetectionEnabled: source.aggregationDetectionEnabled ?? false,
      },
    });
  }

  return prisma.source.findMany({
    where: { enabled: true },
    orderBy: { name: "asc" },
  });
}

export async function findExistingItem(urlHash: string) {
  return prisma.item.findFirst({
    where: {
      urlHash,
    },
  });
}

export async function findExistingItemsForUrlHashes(urlHashes: string[]) {
  if (urlHashes.length === 0) {
    return [];
  }

  return prisma.item.findMany({
    where: {
      urlHash: {
        in: [...new Set(urlHashes)],
      },
    },
  });
}

export async function findDedupeHistoriesForUrlHashes(urlHashes: string[]) {
  if (urlHashes.length === 0) {
    return [];
  }

  return prisma.itemDedupeHistory.findMany({
    where: {
      urlHash: {
        in: [...new Set(urlHashes)],
      },
    },
  });
}

export async function updateSourceFetchMetadata(
  sourceId: string,
  data: {
    feedEtag?: string | null;
    feedLastModified?: string | null;
    feedContentHash?: string | null;
    lastFetchedAt: Date;
    healthStatus?: "unknown" | "healthy" | "failed";
    healthMessage?: string | null;
    healthCheckedAt?: Date | null;
  },
) {
  return prisma.source.update({
    where: { id: sourceId },
    data,
  });
}

export async function updateSourceHealthStatus(
  sourceId: string,
  data: {
    healthStatus: "unknown" | "healthy" | "failed";
    healthMessage: string | null;
    healthCheckedAt: Date;
  },
) {
  const current = await prisma.source.findUnique({
    where: { id: sourceId },
    select: { healthStatus: true, name: true },
  });

  const previousStatus = current?.healthStatus ?? "unknown";
  const sourceName = current?.name ?? sourceId;

  const updated = await prisma.source.update({
    where: { id: sourceId },
    data,
  });

  // Log health status changes
  if (previousStatus !== data.healthStatus) {
    await prisma.sourceHealthLog.create({
      data: {
        sourceId,
        sourceName,
        fromStatus: previousStatus,
        toStatus: data.healthStatus,
        message: data.healthMessage,
        changedAt: data.healthCheckedAt,
      },
    });
  }

  return updated;
}

export async function upsertItem(
  where: { id?: string; urlHash: string },
  data: Prisma.ItemUncheckedCreateInput,
) {
  if (where.id) {
    return prisma.item.update({
      where: { id: where.id },
      data,
    });
  }

  try {
    return await prisma.item.create({ data });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existing = await findExistingItem(where.urlHash);

      if (existing) {
        return prisma.item.update({
          where: { id: existing.id },
          data,
        });
      }
    }

    throw error;
  }
}

type ItemDedupeHistoryInput = Pick<
  Item,
  | "sourceId"
  | "originalUrl"
  | "canonicalUrl"
  | "urlHash"
  | "originalTitle"
  | "publishedAt"
  | "createdAt"
  | "updatedAt"
> & {
  source: Pick<Source, "name">;
};

async function upsertItemDedupeHistory(item: ItemDedupeHistoryInput, archivedAt: Date) {
  const data = {
    sourceId: item.sourceId,
    sourceName: item.source.name,
    originalUrl: item.originalUrl,
    canonicalUrl: item.canonicalUrl,
    urlHash: item.urlHash,
    originalTitle: item.originalTitle,
    publishedAt: item.publishedAt,
    firstSeenAt: item.createdAt,
    lastSeenAt: item.updatedAt,
    archivedAt,
  };

  try {
    return await prisma.itemDedupeHistory.upsert({
      where: { urlHash: item.urlHash },
      update: data,
      create: data,
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existing = await prisma.itemDedupeHistory.findFirst({
        where: {
          urlHash: item.urlHash,
        },
      });

      if (existing) {
        return prisma.itemDedupeHistory.update({
          where: { id: existing.id },
          data,
        });
      }
    }

    throw error;
  }
}

export async function archiveItemDedupeHistories(items: ItemDedupeHistoryInput[], archivedAt = new Date()) {
  for (const item of items) {
    await upsertItemDedupeHistory(item, archivedAt);
  }
}

export async function createFetchRun(triggerType: "scheduled" | "manual", startedAt: Date, taskRunId?: string) {
  return prisma.fetchRun.create({
    data: {
      taskRunId: taskRunId ?? null,
      triggerType,
      status: "running",
      startedAt,
    },
  });
}

export async function completeFetchRun(
  id: string,
  data: {
    status: FetchRunStatus;
    finishedAt: Date;
    sourceCount: number;
    itemCount: number;
    successCount: number;
    failureCount: number;
    itemsAdded: number;
    errorSummary?: string | null;
  },
) {
  return prisma.fetchRun.update({
    where: { id },
    data,
  });
}

export async function updateFetchRunProgress(
  id: string,
  data: {
    sourceCount?: number;
    itemCount?: number;
    successCount?: number;
    failureCount?: number;
    itemsAdded?: number;
    errorSummary?: string | null;
  },
) {
  return prisma.fetchRun.update({
    where: { id },
    data,
  });
}

export async function getLatestFetchRun() {
  return prisma.fetchRun.findFirst({
    orderBy: { startedAt: "desc" },
  });
}

export async function countDisplayItemsCreatedDuringFetchRun(run: FetchRun, now = new Date()) {
  const createdThrough = run.finishedAt ?? now;

  return prisma.item.count({
    where: {
      createdAt: {
        gte: run.startedAt,
        lte: createdThrough,
      },
      status: "processed",
      moderationStatus: {
        in: [...DISPLAYABLE_MODERATION_STATUSES],
      },
      isAggregation: false,
      source: {
        is: {
          enabled: true,
        },
      },
    },
  });
}

export async function getLatestFeedItemUpdate() {
  return prisma.item.findFirst({
    select: {
      id: true,
      updatedAt: true,
    },
    where: {
      status: "processed",
      moderationStatus: {
        in: [...DISPLAYABLE_MODERATION_STATUSES],
      },
      source: {
        is: {
          enabled: true,
        },
      },
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
  });
}

export async function getLatestFeedSourceConfigUpdate() {
  const [latestSource, latestGroup] = await Promise.all([
    prisma.source.findFirst({
      select: {
        id: true,
        updatedAt: true,
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    }),
    prisma.sourceGroup.findFirst({
      select: {
        id: true,
        updatedAt: true,
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    }),
  ]);

  return {
    latestSource,
    latestGroup,
  };
}

export function toFetchRunSnapshot(run: FetchRun, overrides?: { itemsAdded?: number }): FetchRunSnapshot {
  return {
    id: run.id,
    status: run.status,
    triggerType: run.triggerType,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    sourceCount: run.sourceCount,
    itemCount: run.itemCount,
    successCount: run.successCount,
    failureCount: run.failureCount,
    itemsAdded: overrides?.itemsAdded ?? run.itemsAdded,
    errorSummary: run.errorSummary,
  };
}

function mapItemToClusterPreview(item: ItemWithSource): FeedClusterPreviewItemDTO {
  return {
    id: item.id,
    title: getDisplayTitle(item.originalTitle, item.translatedTitle),
    originalTitle: item.originalTitle,
    originalUrl: item.originalUrl,
    publishedAt: item.publishedAt.toISOString(),
    sourceName: item.source.name,
    author: item.author,
    summary: getDisplaySummary(item.summaryText, item.rssExcerpt, item.fullText ?? item.rssContent),
    group: toGroupBadge(item.source.group),
    score: item.qualityScore,
    eventType: item.eventType,
    eventSubject: item.eventSubject,
    eventAction: item.eventAction,
    eventObject: item.eventObject,
    eventDate: item.eventDate,
    canRegenerateTranslation: shouldTranslateTitle(item.originalTitle),
    ...(item.parent
      ? {
          aggregationParent: {
            id: item.parent.id,
            title: getDisplayTitle(item.parent.originalTitle, item.parent.translatedTitle),
            originalUrl: item.parent.originalUrl,
          },
        }
      : {}),
  };
}

function buildClusterAssignmentExplanation(
  cluster: Pick<ClusterWithPreviewItems, "eventType" | "eventSubject" | "eventAction" | "eventObject" | "eventDate" | "items">,
  sourceCount: number,
  itemCount: number,
) {
  const reasons: string[] = [];

  if (sourceCount > 1) {
    reasons.push(`${sourceCount} 个来源共同指向该事件`);
  }

  if (itemCount > 1) {
    reasons.push(`${itemCount} 条内容被归入同一聚合组`);
  }

  if (reasons.length === 0) {
    reasons.push("当前聚合主要由标题、发布时间窗口和内容相似度形成，事件锚点不足。");
  }

  return {
    eventType: cluster.eventType,
    eventSubject: cluster.eventSubject,
    eventAction: cluster.eventAction,
    eventObject: cluster.eventObject,
    eventDate: cluster.eventDate,
    sourceCount,
    itemCount,
    reasons,
  } satisfies ClusterDTO["assignmentExplanation"];
}

function mapItemToFeedItem(item: ItemWithSource): FeedItemDTO {
  return {
    id: item.id,
    type: "single",
    title: getDisplayTitle(item.originalTitle, item.translatedTitle),
    originalUrl: item.originalUrl,
    publishedAt: item.publishedAt.toISOString(),
    createdAt: item.createdAt.toISOString(),
    latestPublishedAt: item.publishedAt.toISOString(),
    sourceName: item.source.name,
    author: item.author,
    summary: getDisplaySummary(item.summaryText, item.rssExcerpt, item.fullText ?? item.rssContent),
    group: toGroupBadge(item.source.group),
    score: item.qualityScore,
    sourceCount: 1,
    itemCount: 1,
    canRegenerateTranslation: shouldTranslateTitle(item.originalTitle),
    ...(item.parent
      ? {
          aggregationParent: {
            id: item.parent.id,
            title: getDisplayTitle(item.parent.originalTitle, item.parent.translatedTitle),
            originalUrl: item.parent.originalUrl,
          },
        }
      : {}),
  };
}

function selectDominantGroupBadge(items: ItemWithSource[], selectedGroup: GroupBadge | null): GroupBadge | null {
  if (selectedGroup) {
    return selectedGroup;
  }

  const groupCounts = new Map<string, { group: GroupBadge; count: number; firstIndex: number }>();
  items.forEach((item, index) => {
    const group = toGroupBadge(item.source.group);
    if (!group) {
      return;
    }

    const current = groupCounts.get(group.id);
    groupCounts.set(group.id, {
      group,
      count: (current?.count ?? 0) + 1,
      firstIndex: current?.firstIndex ?? index,
    });
  });

  return [...groupCounts.values()].sort((left, right) => {
    if (right.count !== left.count) {
      return right.count - left.count;
    }

    return left.firstIndex - right.firstIndex;
  })[0]?.group ?? null;
}

export function mapItemToReviewItem(item: ItemWithSource): ReviewItemDTO {
  return {
    id: item.id,
    title: getDisplayTitle(item.originalTitle, item.translatedTitle),
    originalUrl: item.originalUrl,
    publishedAt: item.publishedAt.toISOString(),
    sourceName: item.source.name,
    author: item.author,
    summary: getDisplaySummary(item.summaryText, item.rssExcerpt, item.fullText ?? item.rssContent),
    moderationStatus: item.moderationStatus,
    moderationReason: item.moderationReason,
    moderationDetail: item.moderationDetail,
    qualityScore: item.qualityScore,
    qualityRationale: item.qualityRationale,
    canRegenerateTranslation: shouldTranslateTitle(item.originalTitle),
  };
}

function normalizeUrlForSplitComparison(value: string) {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    if (parsed.pathname.length > 1) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    }
    return parsed.toString();
  } catch {
    return value;
  }
}

function isChildUsingParentUrl(child: Pick<Item, "originalUrl">, parent: Pick<Item, "originalUrl">) {
  return normalizeUrlForSplitComparison(child.originalUrl) === normalizeUrlForSplitComparison(parent.originalUrl);
}

function mapAggregationSplitChildToDto(
  child: AggregationSplitChildWithSource,
  parent: Pick<Item, "originalUrl">,
): AggregationSplitChildDTO {
  return {
    id: child.id,
    title: getDisplayTitle(child.originalTitle, child.translatedTitle),
    originalUrl: child.originalUrl,
    publishedAt: child.publishedAt.toISOString(),
    sourceName: child.source.name,
    summary: getDisplaySummary(child.summaryText, child.rssExcerpt, child.fullText ?? child.rssContent),
    status: child.status,
    moderationStatus: child.moderationStatus,
    filterReason: child.filterReason,
    qualityScore: child.qualityScore,
    eventType: child.eventType,
    eventSubject: child.eventSubject,
    eventAction: child.eventAction,
    eventObject: child.eventObject,
    eventDate: child.eventDate,
    clusterId: child.clusterId,
    clusterTitle: child.cluster?.title ?? null,
    usesParentUrl: isChildUsingParentUrl(child, parent),
  };
}

function mapAggregationSplitParentToDto(
  parent: AggregationSplitParentWithChildren,
  options?: { includeChildren?: boolean },
): AggregationSplitParentDTO {
  const linkedChildren = parent.aggregationSplitChildren.map((link) => link.child);
  const sourceChildren = linkedChildren.length > 0 ? linkedChildren : parent.children;
  const children = sourceChildren.map((child) => mapAggregationSplitChildToDto(child, parent));
  const parentUrlCount = children.filter((child) => child.usesParentUrl).length;

  return {
    id: parent.id,
    title: getDisplayTitle(parent.originalTitle, parent.translatedTitle),
    originalUrl: parent.originalUrl,
    publishedAt: parent.publishedAt.toISOString(),
    createdAt: parent.createdAt.toISOString(),
    aggregationCheckedAt: parent.aggregationCheckedAt?.toISOString() ?? null,
    sourceName: parent.source.name,
    summary: getDisplaySummary(parent.summaryText, parent.rssExcerpt, parent.fullText ?? parent.rssContent),
    status: parent.status,
    moderationStatus: parent.moderationStatus,
    aggregationParseStatus: parent.aggregationParseStatus,
    errorMessage: parent.errorMessage,
    childCount: children.length,
    eventUrlCount: children.length - parentUrlCount,
    parentUrlCount,
    qualityScore: parent.qualityScore,
    ...(options?.includeChildren ? { children } : {}),
  };
}

function buildItemWhere(
  filters: FeedFilters & {
    rangeStart: Date | null;
    rangeEnd: Date | null;
    publishedRangeStart: Date | null;
    publishedRangeEnd: Date | null;
  },
  clusterId?: string | string[],
): Prisma.ItemWhereInput {
  return {
    AND: [
      {
        status: "processed",
        moderationStatus: {
          in: [...DISPLAYABLE_MODERATION_STATUSES],
        },
        ...(clusterId
          ? {
              clusterId: Array.isArray(clusterId) ? { in: clusterId } : clusterId,
            }
          : {}),
        ...(filters.rangeStart || filters.rangeEnd
          ? {
              createdAt: {
                ...(filters.rangeStart ? { gte: filters.rangeStart } : {}),
                ...(filters.rangeEnd ? { lte: filters.rangeEnd } : {}),
              },
            }
          : {}),
        ...(filters.publishedRangeStart || filters.publishedRangeEnd
          ? {
              publishedAt: {
                ...(filters.publishedRangeStart ? { gte: filters.publishedRangeStart } : {}),
                ...(filters.publishedRangeEnd ? { lte: filters.publishedRangeEnd } : {}),
              },
            }
          : {}),
        source: {
          is: {
            enabled: true,
            ...(filters.groupId ? { groupId: filters.groupId } : {}),
            ...(filters.sourceId ? { id: filters.sourceId } : {}),
          },
        },
      },
      {
        OR: [{ clusterId: null }, { cluster: { is: { status: "active" } } }],
      },
    ],
  };
}

function sanitizeFts5Query(input: string | null) {
  const trimmed = input?.trim().toLocaleLowerCase() ?? "";
  if (!trimmed) {
    return null;
  }
  // Escape double quotes by doubling them (FTS5 convention)
  // Wrap in double quotes so FTS5 treats the whole input as a literal phrase
  // (prevents AND/OR/NOT from being interpreted as operators)
  const escaped = trimmed.replace(/"/g, '""');
  return `"${escaped}"`;
}

function sanitizeLikeQuery(input: string | null) {
  const trimmed = input?.trim() ?? "";
  if (!trimmed) {
    return null;
  }

  return `%${trimmed.replace(/[\\%_]/g, "\\$&")}%`;
}

function buildAdminClusterSearchCte(searchTerms: string[]) {
  const termMatchQueries = searchTerms.flatMap((term, index) => {
    const likeSearchTerm = sanitizeLikeQuery(term);
    if (!likeSearchTerm) {
      return [];
    }

    const likeEscape = "\\";
    const queries: Prisma.Sql[] = [
      Prisma.sql`
        SELECT ${index} AS term_index, cc.id AS cluster_id
        FROM "content_clusters" cc
        WHERE COALESCE(cc.title, '') LIKE ${likeSearchTerm} ESCAPE ${likeEscape}
      `,
      Prisma.sql`
        SELECT DISTINCT ${index} AS term_index, i."clusterId" AS cluster_id
        FROM "items" i
        WHERE i."clusterId" IS NOT NULL
          AND i.status = ${"processed"}
          AND i."moderationStatus" IN (${Prisma.join([...DISPLAYABLE_MODERATION_STATUSES])})
          AND (
            COALESCE(i."originalTitle", '') LIKE ${likeSearchTerm} ESCAPE ${likeEscape}
            OR COALESCE(i."translatedTitle", '') LIKE ${likeSearchTerm} ESCAPE ${likeEscape}
          )
      `,
    ];

    return queries;
  });

  if (termMatchQueries.length === 0) {
    return null;
  }

  return Prisma.sql`
    WITH term_matches AS (
      ${Prisma.join(termMatchQueries, "\nUNION ALL\n")}
    ),
    matched_clusters AS (
      SELECT cluster_id AS id
      FROM term_matches
      WHERE cluster_id IS NOT NULL
      GROUP BY cluster_id
      HAVING COUNT(DISTINCT term_index) = ${searchTerms.length}
    )
  `;
}

function toNumber(value: number | bigint) {
  return typeof value === "bigint" ? Number(value) : value;
}

function toIsoString(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapClusterToAdminDto(
  cluster: ClusterWithPreviewItems,
  latestItemUpdatedAt?: Date | null,
  scoreStats?: ClusterScoreStats,
) {
  const itemCount = scoreStats?.itemCount ?? cluster.items.length;
  const sourceCount = scoreStats?.sourceCount ?? new Set(cluster.items.map((item) => item.sourceId)).size;
  const aiScore =
    scoreStats?.aiScore ??
    (cluster.items.length > 0
      ? Math.round(cluster.items.reduce((sum, item) => sum + item.qualityScore, 0) / cluster.items.length)
      : cluster.score);
  const qualityScore =
    scoreStats?.qualityScore ?? normalizeFeedQualityScore(aiScore);

  return {
    id: cluster.id,
    title: cluster.title,
    summary: normalizeDisplaySummary(cluster.summary),
    score: qualityScore,
    itemCount: scoreStats?.itemCount ?? cluster.itemCount,
    latestPublishedAt: cluster.latestPublishedAt.toISOString(),
    latestItemUpdatedAt: (latestItemUpdatedAt ?? cluster.updatedAt).toISOString(),
    status: cluster.status,
    items: cluster.items.slice(0, 5).map(mapItemToClusterPreview),
    assignmentExplanation: buildClusterAssignmentExplanation(cluster, sourceCount, itemCount),
  } satisfies ClusterDTO;
}

function getPrecomputedClusterScoreStats(cluster: ClusterWithPreviewItems): ClusterScoreStats | null {
  if (!cluster.feedStatsUpdatedAt) {
    return null;
  }

  return {
    aiScore: cluster.displayAverageScore,
    itemCount: cluster.displayItemCount,
    sourceCount: cluster.displaySourceCount,
    qualityScore: cluster.displayQualityScore,
  };
}

async function getClusterScoreStatsByCluster(clusterIds: string[]) {
  if (clusterIds.length === 0) {
    return new Map<string, ClusterScoreStats>();
  }

  const clusterAiScore = Prisma.sql`CAST(ROUND(AVG(i."qualityScore")) AS INTEGER)`;
  const clusterItemCount = Prisma.sql`COUNT(*)`;
  const clusterSourceCount = Prisma.sql`COUNT(DISTINCT i."sourceId")`;
  const rows = await prisma.$queryRaw<ClusterScoreStatsRow[]>(Prisma.sql`
    SELECT
      i."clusterId" AS "clusterId",
      ${clusterAiScore} AS "aiScore",
      ${clusterItemCount} AS "itemCount",
      ${clusterSourceCount} AS "sourceCount",
      ${buildFeedQualityScoreSql(clusterAiScore)} AS "qualityScore"
    FROM "items" i
    INNER JOIN "content_clusters" cc ON cc.id = i."clusterId"
    WHERE i."clusterId" IN (${Prisma.join(clusterIds)})
      AND i.status = ${"processed"}
      AND i."moderationStatus" IN (${Prisma.join([...DISPLAYABLE_MODERATION_STATUSES])})
    GROUP BY i."clusterId"
  `);

  return new Map(
    rows.map((row) => [
      row.clusterId,
      {
        aiScore: toNumber(row.aiScore),
        itemCount: toNumber(row.itemCount),
        sourceCount: toNumber(row.sourceCount),
        qualityScore: toNumber(row.qualityScore),
      },
    ]),
  );
}

async function getLatestItemUpdatedAtByCluster(clusterIds: string[]) {
  if (clusterIds.length === 0) {
    return new Map<string, Date>();
  }

  const rows = await prisma.item.groupBy({
    by: ["clusterId"],
    where: {
      clusterId: { in: clusterIds },
      status: "processed",
      moderationStatus: {
        in: [...DISPLAYABLE_MODERATION_STATUSES],
      },
    },
    _max: {
      updatedAt: true,
    },
  });

  return new Map(
    rows.flatMap((row) => (row.clusterId && row._max.updatedAt ? [[row.clusterId, row._max.updatedAt] as const] : [])),
  );
}

function buildFeedEntryCandidatesCte(
  filters: FeedFilters & {
    rangeStart: Date | null;
    rangeEnd: Date | null;
    publishedRangeStart: Date | null;
    publishedRangeEnd: Date | null;
  },
  searchTerm: string | null = null,
  options: {
    includeClusterScoreStats?: boolean;
    includeDisplayFields?: boolean;
  } = {},
) {
  const includeClusterScoreStats = options.includeClusterScoreStats ?? true;
  const includeDisplayFields = options.includeDisplayFields ?? true;
  const explicitClusterEntryIds = getExplicitClusterEntryIds(filters.entryKeys);
  const explicitClusterEntryClause = explicitClusterEntryIds.length > 0
    ? Prisma.sql` OR cg.id IN (${Prisma.join(explicitClusterEntryIds)})`
    : Prisma.empty;
  const nonTimeWhereClauses: Prisma.Sql[] = [
    Prisma.sql`i.status = ${"processed"}`,
    Prisma.sql`i."moderationStatus" IN (${Prisma.join([...DISPLAYABLE_MODERATION_STATUSES])})`,
    Prisma.sql`s.enabled = ${true}`,
    Prisma.sql`(i."clusterId" IS NULL OR c.status = ${"active"})`,
    // Hide aggregation parents from the public feed; their child items carry the
    // actual content. The child items are full Item rows with isAggregation=false.
    Prisma.sql`i."isAggregation" = ${false}`,
  ];

  if (filters.sourceId) {
    nonTimeWhereClauses.push(Prisma.sql`s.id = ${filters.sourceId}`);
  }

  const likeSearchTerm = sanitizeLikeQuery(filters.title);

  if (searchTerm || likeSearchTerm) {
    const searchClauses: Prisma.Sql[] = [];

    if (searchTerm) {
      searchClauses.push(Prisma.sql`i.rowid IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ${searchTerm})`);
    }

    if (likeSearchTerm) {
      const likeEscape = "\\";
      // FTS handles body/full-text search. Keep LIKE only on short display fields
      // so short CJK terms below trigram length can still match titles.
      searchClauses.push(Prisma.sql`COALESCE(i."originalTitle", '') LIKE ${likeSearchTerm} ESCAPE ${likeEscape}`);
      searchClauses.push(Prisma.sql`COALESCE(i."translatedTitle", '') LIKE ${likeSearchTerm} ESCAPE ${likeEscape}`);
      searchClauses.push(Prisma.sql`COALESCE(i.author, '') LIKE ${likeSearchTerm} ESCAPE ${likeEscape}`);
      searchClauses.push(Prisma.sql`COALESCE(c.title, '') LIKE ${likeSearchTerm} ESCAPE ${likeEscape}`);
    }

    nonTimeWhereClauses.push(Prisma.sql`(${Prisma.join(searchClauses, " OR ")})`);
  }

  const timeWhereClauses: Prisma.Sql[] = [];

  if (filters.rangeStart) {
    // SQLite 存储的是毫秒时间戳，需要将 Date 转换为时间戳数字
    timeWhereClauses.push(Prisma.sql`mi."createdAt" >= ${filters.rangeStart.getTime()}`);
  }

  if (filters.rangeEnd) {
    // SQLite 存储的是毫秒时间戳，需要将 Date 转换为时间戳数字
    timeWhereClauses.push(Prisma.sql`mi."createdAt" <= ${filters.rangeEnd.getTime()}`);
  }

  if (filters.publishedRangeStart) {
    timeWhereClauses.push(Prisma.sql`mi."publishedAt" >= ${filters.publishedRangeStart.getTime()}`);
  }

  if (filters.publishedRangeEnd) {
    timeWhereClauses.push(Prisma.sql`mi."publishedAt" <= ${filters.publishedRangeEnd.getTime()}`);
  }

  const baseFilteredItemsWhereClause =
    timeWhereClauses.length > 0
      ? Prisma.sql`WHERE ${Prisma.join(timeWhereClauses, " AND ")}`
      : Prisma.empty;
  const filteredItemsCte = Prisma.sql`
    filtered_items AS (
      SELECT *
      FROM base_filtered_items
    )`;

  const clusterAiScore = Prisma.sql`CAST(ROUND(AVG(csi."qualityScore")) AS INTEGER)`;
  const clusterItemCount = Prisma.sql`COUNT(*)`;
  const clusterSourceCount = Prisma.sql`COUNT(DISTINCT csi."sourceId")`;
  const clusterScoreStatsCtes = includeClusterScoreStats
    ? Prisma.sql`
    cluster_score_items AS (
      SELECT
        i."clusterId" AS "clusterId",
        i."sourceId" AS "sourceId",
        i."qualityScore" AS "qualityScore"
      FROM "items" i
      INNER JOIN relevant_clusters rc ON rc.id = i."clusterId"
      INNER JOIN "sources" s ON s.id = i."sourceId"
      WHERE i.status = ${"processed"}
        AND i."moderationStatus" IN (${Prisma.join([...DISPLAYABLE_MODERATION_STATUSES])})
        AND s.enabled = ${true}
    ),
    cluster_score_groups AS (
      SELECT
        csi."clusterId" AS id,
        ${clusterAiScore} AS score,
        ${clusterItemCount} AS "totalItemCount",
        ${clusterSourceCount} AS "sourceCount",
        -- 公开信息流评分 = 内容质量分
        ${buildFeedQualityScoreSql(clusterAiScore)} AS "qualityScore"
      FROM cluster_score_items csi
      INNER JOIN "content_clusters" cc ON cc.id = csi."clusterId"
      GROUP BY csi."clusterId"
    )`
    : Prisma.sql`
    cluster_score_groups AS (
      SELECT
        CAST(NULL AS TEXT) AS id,
        CAST(0 AS INTEGER) AS score,
        CAST(0 AS INTEGER) AS "totalItemCount",
        CAST(0 AS INTEGER) AS "sourceCount",
        CAST(0 AS INTEGER) AS "qualityScore"
      WHERE 0
    )`;

  return Prisma.sql`
    WITH matched_items AS (
      SELECT
        i.id AS "itemId",
        i."clusterId" AS "clusterId",
        i."sourceId" AS "sourceId",
        i."publishedAt" AS "publishedAt",
        i."createdAt" AS "createdAt",
        i."qualityScore" AS "qualityScore",
        s."groupId" AS "sourceGroupId",
        ${includeDisplayFields
          ? Prisma.sql`
        i."originalTitle" AS "originalTitle",
        i."translatedTitle" AS "translatedTitle",
        c.title AS "clusterTitle",
        c.summary AS "clusterSummary"`
          : Prisma.sql`NULL AS "originalTitle", NULL AS "translatedTitle", NULL AS "clusterTitle", NULL AS "clusterSummary"`}
      FROM "items" i
      INNER JOIN "sources" s ON s.id = i."sourceId"
      LEFT JOIN "content_clusters" c ON c.id = i."clusterId"
      WHERE ${Prisma.join(nonTimeWhereClauses, " AND ")}
    ),
    base_filtered_items AS (
      SELECT
        mi."itemId",
        mi."clusterId",
        mi."sourceId",
        mi."publishedAt",
        mi."createdAt",
        mi."qualityScore",
        mi."originalTitle",
        mi."translatedTitle",
        mi."sourceGroupId",
        mi."clusterTitle",
        mi."clusterSummary"
      FROM matched_items mi
      ${baseFilteredItemsWhereClause}
    ),
    ${filteredItemsCte},
    relevant_clusters AS (
      SELECT DISTINCT fi."clusterId" AS id
      FROM filtered_items fi
      WHERE fi."clusterId" IS NOT NULL
    ),
    ${clusterScoreStatsCtes},
    cluster_match_group_counts AS (
      SELECT
        mi."clusterId",
        mi."sourceGroupId" AS "groupId",
        COUNT(*) AS count,
        MIN(mi."createdAt") AS "firstCreatedAt"
      FROM matched_items mi
      INNER JOIN relevant_clusters rc ON rc.id = mi."clusterId"
      WHERE mi."sourceGroupId" IS NOT NULL
      GROUP BY mi."clusterId", mi."sourceGroupId"
    ),
    cluster_dominant_groups AS (
      SELECT "clusterId", "groupId"
      FROM (
        SELECT
          cmgc."clusterId",
          cmgc."groupId",
          ROW_NUMBER() OVER (
            PARTITION BY cmgc."clusterId"
            ORDER BY cmgc.count DESC, cmgc."firstCreatedAt" ASC, cmgc."groupId" ASC
          ) AS rn
        FROM cluster_match_group_counts cmgc
      )
      WHERE rn = 1
    ),
    cluster_match_counts AS (
      SELECT
        mi."clusterId" AS id,
        COUNT(*) AS "matchedItemCount"
      FROM matched_items mi
      INNER JOIN relevant_clusters rc ON rc.id = mi."clusterId"
      GROUP BY mi."clusterId"
    ),
    cluster_groups AS (
      SELECT
        fi."clusterId" AS id,
        ${includeDisplayFields
          ? Prisma.sql`
        MIN(fi."clusterTitle") AS title,
        MIN(fi."clusterSummary") AS summary,`
          : Prisma.empty}
        MAX(fi."publishedAt") AS "latestPublishedAt",
        MAX(fi."createdAt") AS "createdAt",
        MAX(COALESCE(csg.score, 0)) AS score,
        COUNT(*) AS "itemCount",
        MAX(COALESCE(cmc."matchedItemCount", 0)) AS "matchedItemCount",
        MAX(COALESCE(csg."sourceCount", 0)) AS "sourceCount",
        MAX(COALESCE(csg."totalItemCount", 0)) AS "totalItemCount",
        MIN(cdg."groupId") AS "entryGroupId",
        MAX(COALESCE(csg."qualityScore", 0)) AS "qualityScore"
      FROM filtered_items fi
      INNER JOIN "content_clusters" cc ON cc.id = fi."clusterId"
      LEFT JOIN cluster_match_counts cmc ON cmc.id = fi."clusterId"
      LEFT JOIN cluster_score_groups csg ON csg.id = fi."clusterId"
      LEFT JOIN cluster_dominant_groups cdg ON cdg."clusterId" = fi."clusterId"
      WHERE fi."clusterId" IS NOT NULL
      GROUP BY fi."clusterId"
    ),
    single_entries AS (
      SELECT
        fi."itemId" AS id,
        'single' AS type,
        fi."clusterId" AS "clusterId",
        ${includeDisplayFields
          ? Prisma.sql`
        COALESCE(NULLIF(TRIM(fi."translatedTitle"), ''), fi."originalTitle") AS title,
        NULL AS summary,`
          : Prisma.empty}
        fi."publishedAt" AS "latestPublishedAt",
        fi."createdAt" AS "createdAt",
        fi."qualityScore" AS score,
        1 AS "sourceCount",
        1 AS "itemCount",
        fi."sourceGroupId" AS "entryGroupId",
        -- 公开信息流评分 = 内容质量分
        ${buildFeedQualityScoreSql(Prisma.sql`fi."qualityScore"`)} AS "qualityScore"
      FROM filtered_items fi
      LEFT JOIN cluster_match_counts cmc ON cmc.id = fi."clusterId"
      LEFT JOIN cluster_score_groups csg ON csg.id = fi."clusterId"
      WHERE fi."clusterId" IS NULL OR COALESCE(cmc."matchedItemCount", 1) <= 1
    ),
    cluster_entries AS (
      SELECT
        cg.id AS id,
        'cluster' AS type,
        cg.id AS "clusterId",
        ${includeDisplayFields
          ? Prisma.sql`
        cg.title AS title,
        cg.summary AS summary,`
          : Prisma.empty}
        cg."latestPublishedAt" AS "latestPublishedAt",
        cg."createdAt" AS "createdAt",
        cg.score AS score,
        cg."sourceCount" AS "sourceCount",
        cg."itemCount" AS "itemCount",
        cg."totalItemCount" AS "totalItemCount",
        cg."entryGroupId" AS "entryGroupId",
        cg."qualityScore" AS "qualityScore"
      FROM cluster_groups cg
      WHERE cg."matchedItemCount" > 1${explicitClusterEntryClause}
    ),
    all_entry_candidates AS (
      SELECT id, type, NULL AS "clusterId", ${includeDisplayFields ? Prisma.sql`title, summary,` : Prisma.empty} "latestPublishedAt", "createdAt", score, "sourceCount", "itemCount", "totalItemCount", "entryGroupId", "qualityScore"
      FROM cluster_entries
      UNION ALL
      SELECT id, type, "clusterId", ${includeDisplayFields ? Prisma.sql`title, summary,` : Prisma.empty} "latestPublishedAt", "createdAt", score, "sourceCount", "itemCount", CAST(1 AS INTEGER) AS "totalItemCount", "entryGroupId", "qualityScore"
      FROM single_entries
    ),
    entry_candidates AS (
      SELECT *
      FROM all_entry_candidates
      ${buildEntryCandidateWhereClause(filters)}
    )
  `;
}

function buildEntryCandidateWhereClause(filters: Pick<FeedFilters, "groupId" | "entryId" | "entryType" | "entryKeys">) {
  const clauses: Prisma.Sql[] = [];

  if (filters.groupId) {
    clauses.push(Prisma.sql`"entryGroupId" = ${filters.groupId}`);
  }

  if (filters.entryId) {
    clauses.push(Prisma.sql`id = ${filters.entryId}`);
  }

  if (filters.entryType) {
    clauses.push(Prisma.sql`"type" = ${filters.entryType}`);
  }

  if (filters.entryKeys.length > 0) {
    clauses.push(Prisma.sql`("type" || ':' || id) IN (${Prisma.join(filters.entryKeys)})`);
  }

  return clauses.length > 0
    ? Prisma.sql`WHERE ${Prisma.join(clauses, " AND ")}`
    : Prisma.empty;
}

function getExplicitClusterEntryIds(entryKeys: FeedFilters["entryKeys"]) {
  return entryKeys
    .map((entryKey) => entryKey.startsWith("cluster:") ? entryKey.slice("cluster:".length) : null)
    .filter((entryId): entryId is string => Boolean(entryId));
}

function buildFeedEntryCountCandidatesCte(
  filters: FeedFilters & {
    rangeStart: Date | null;
    rangeEnd: Date | null;
    publishedRangeStart: Date | null;
    publishedRangeEnd: Date | null;
  },
  searchTerm: string | null = null,
) {
  const explicitClusterEntryIds = getExplicitClusterEntryIds(filters.entryKeys);
  const explicitClusterEntryClause = explicitClusterEntryIds.length > 0
    ? Prisma.sql` OR fi."clusterId" IN (${Prisma.join(explicitClusterEntryIds)})`
    : Prisma.empty;
  const nonTimeWhereClauses: Prisma.Sql[] = [
    Prisma.sql`i.status = ${"processed"}`,
    Prisma.sql`i."moderationStatus" IN (${Prisma.join([...DISPLAYABLE_MODERATION_STATUSES])})`,
    Prisma.sql`s.enabled = ${true}`,
    Prisma.sql`(i."clusterId" IS NULL OR c.status = ${"active"})`,
    Prisma.sql`i."isAggregation" = ${false}`,
  ];

  if (filters.sourceId) {
    nonTimeWhereClauses.push(Prisma.sql`s.id = ${filters.sourceId}`);
  }

  const likeSearchTerm = sanitizeLikeQuery(filters.title);

  if (searchTerm || likeSearchTerm) {
    const searchClauses: Prisma.Sql[] = [];

    if (searchTerm) {
      searchClauses.push(Prisma.sql`i.rowid IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ${searchTerm})`);
    }

    if (likeSearchTerm) {
      const likeEscape = "\\";
      searchClauses.push(Prisma.sql`COALESCE(i."originalTitle", '') LIKE ${likeSearchTerm} ESCAPE ${likeEscape}`);
      searchClauses.push(Prisma.sql`COALESCE(i."translatedTitle", '') LIKE ${likeSearchTerm} ESCAPE ${likeEscape}`);
      searchClauses.push(Prisma.sql`COALESCE(i.author, '') LIKE ${likeSearchTerm} ESCAPE ${likeEscape}`);
      searchClauses.push(Prisma.sql`COALESCE(c.title, '') LIKE ${likeSearchTerm} ESCAPE ${likeEscape}`);
    }

    nonTimeWhereClauses.push(Prisma.sql`(${Prisma.join(searchClauses, " OR ")})`);
  }

  const timeWhereClauses: Prisma.Sql[] = [];

  if (filters.rangeStart) {
    timeWhereClauses.push(Prisma.sql`mi."createdAt" >= ${filters.rangeStart.getTime()}`);
  }

  if (filters.rangeEnd) {
    timeWhereClauses.push(Prisma.sql`mi."createdAt" <= ${filters.rangeEnd.getTime()}`);
  }

  if (filters.publishedRangeStart) {
    timeWhereClauses.push(Prisma.sql`mi."publishedAt" >= ${filters.publishedRangeStart.getTime()}`);
  }

  if (filters.publishedRangeEnd) {
    timeWhereClauses.push(Prisma.sql`mi."publishedAt" <= ${filters.publishedRangeEnd.getTime()}`);
  }

  const baseFilteredItemsWhereClause =
    timeWhereClauses.length > 0
      ? Prisma.sql`WHERE ${Prisma.join(timeWhereClauses, " AND ")}`
      : Prisma.empty;
  const filteredItemsCte = Prisma.sql`
    filtered_items AS (
      SELECT *
      FROM base_filtered_items
    )`;

  return Prisma.sql`
    WITH matched_items AS (
      SELECT
        i.id AS "itemId",
        i."clusterId" AS "clusterId",
        i."publishedAt" AS "publishedAt",
        i."createdAt" AS "createdAt",
        i."originalTitle" AS "originalTitle",
        i."translatedTitle" AS "translatedTitle",
        i.author AS author,
        s."groupId" AS "sourceGroupId",
        c.title AS "clusterTitle"
      FROM "items" i
      INNER JOIN "sources" s ON s.id = i."sourceId"
      LEFT JOIN "content_clusters" c ON c.id = i."clusterId"
      WHERE ${Prisma.join(nonTimeWhereClauses, " AND ")}
    ),
    base_filtered_items AS (
      SELECT
        mi."itemId",
        mi."clusterId",
        mi."publishedAt",
        mi."createdAt",
        mi."sourceGroupId"
      FROM matched_items mi
      ${baseFilteredItemsWhereClause}
    ),
    ${filteredItemsCte},
    relevant_clusters AS (
      SELECT DISTINCT fi."clusterId" AS id
      FROM filtered_items fi
      WHERE fi."clusterId" IS NOT NULL
    ),
    cluster_match_counts AS (
      SELECT
        mi."clusterId" AS id,
        COUNT(*) AS "matchedItemCount"
      FROM matched_items mi
      INNER JOIN relevant_clusters rc ON rc.id = mi."clusterId"
      GROUP BY mi."clusterId"
    ),
    cluster_match_group_counts AS (
      SELECT
        mi."clusterId",
        mi."sourceGroupId" AS "groupId",
        COUNT(*) AS count,
        MIN(mi."createdAt") AS "firstCreatedAt"
      FROM matched_items mi
      INNER JOIN relevant_clusters rc ON rc.id = mi."clusterId"
      WHERE mi."sourceGroupId" IS NOT NULL
      GROUP BY mi."clusterId", mi."sourceGroupId"
    ),
    cluster_dominant_groups AS (
      SELECT "clusterId", "groupId"
      FROM (
        SELECT
          cmgc."clusterId",
          cmgc."groupId",
          ROW_NUMBER() OVER (
            PARTITION BY cmgc."clusterId"
            ORDER BY cmgc.count DESC, cmgc."firstCreatedAt" ASC, cmgc."groupId" ASC
          ) AS rn
        FROM cluster_match_group_counts cmgc
      )
      WHERE rn = 1
    ),
    cluster_count_entries AS (
      SELECT
        fi."clusterId" AS id,
        MIN(cdg."groupId") AS "entryGroupId"
      FROM filtered_items fi
      INNER JOIN cluster_match_counts cmc ON cmc.id = fi."clusterId"
      LEFT JOIN cluster_dominant_groups cdg ON cdg."clusterId" = fi."clusterId"
      WHERE fi."clusterId" IS NOT NULL
        AND (cmc."matchedItemCount" > 1${explicitClusterEntryClause})
      GROUP BY fi."clusterId"
    ),
    single_count_entries AS (
      SELECT
        fi."itemId" AS id,
        fi."sourceGroupId" AS "entryGroupId"
      FROM filtered_items fi
      LEFT JOIN cluster_match_counts cmc ON cmc.id = fi."clusterId"
      WHERE fi."clusterId" IS NULL OR COALESCE(cmc."matchedItemCount", 1) <= 1
    ),
    entry_count_candidates AS (
      SELECT id, "entryGroupId"
      FROM cluster_count_entries
      UNION ALL
      SELECT id, "entryGroupId"
      FROM single_count_entries
    )
  `;
}

function buildEntityFeedEntryCandidatesCte(
  filters: FeedFilters & {
    rangeStart: Date | null;
    rangeEnd: Date | null;
    publishedRangeStart: Date | null;
    publishedRangeEnd: Date | null;
  },
  searchTerm: string | null = null,
  options: {
    includeDisplayFields?: boolean;
  } = {},
) {
  const includeDisplayFields = options.includeDisplayFields ?? true;
  const likeSearchTerm = sanitizeLikeQuery(filters.title);
  const likeEscape = "\\";
  const explicitClusterEntryIds = getExplicitClusterEntryIds(filters.entryKeys);
  const clusterWhereClauses: Prisma.Sql[] = [
    Prisma.sql`cc.status = ${"active"}`,
    explicitClusterEntryIds.length > 0
      ? Prisma.sql`(cc."displayItemCount" > 1 OR cc.id IN (${Prisma.join(explicitClusterEntryIds)}))`
      : Prisma.sql`cc."displayItemCount" > 1`,
    Prisma.sql`cc."latestCreatedAt" IS NOT NULL`,
  ];
  const singleWhereClauses: Prisma.Sql[] = [
    Prisma.sql`i.status = ${"processed"}`,
    Prisma.sql`i."moderationStatus" IN (${Prisma.join([...DISPLAYABLE_MODERATION_STATUSES])})`,
    Prisma.sql`s.enabled = ${true}`,
    Prisma.sql`(i."clusterId" IS NULL OR c.status = ${"active"})`,
    Prisma.sql`(i."clusterId" IS NULL OR COALESCE(c."displayItemCount", 0) <= 1)`,
    Prisma.sql`i."isAggregation" = ${false}`,
  ];

  if (filters.sourceId) {
    clusterWhereClauses.push(Prisma.sql`0 = 1`);
    singleWhereClauses.push(Prisma.sql`s.id = ${filters.sourceId}`);
  }

  if (filters.groupId) {
    clusterWhereClauses.push(Prisma.sql`cc."dominantGroupId" = ${filters.groupId}`);
    singleWhereClauses.push(Prisma.sql`s."groupId" = ${filters.groupId}`);
  }

  if (searchTerm || likeSearchTerm) {
    const singleSearchClauses: Prisma.Sql[] = [];
    const clusterSearchClauses: Prisma.Sql[] = [];

    if (searchTerm) {
      singleSearchClauses.push(Prisma.sql`i.rowid IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ${searchTerm})`);
    }

    if (likeSearchTerm) {
      singleSearchClauses.push(Prisma.sql`COALESCE(i."originalTitle", '') LIKE ${likeSearchTerm} ESCAPE ${likeEscape}`);
      singleSearchClauses.push(Prisma.sql`COALESCE(i."translatedTitle", '') LIKE ${likeSearchTerm} ESCAPE ${likeEscape}`);
      singleSearchClauses.push(Prisma.sql`COALESCE(i.author, '') LIKE ${likeSearchTerm} ESCAPE ${likeEscape}`);
      clusterSearchClauses.push(Prisma.sql`COALESCE(cc."feedSearchText", '') LIKE ${likeSearchTerm} ESCAPE ${likeEscape}`);
      clusterSearchClauses.push(Prisma.sql`COALESCE(cc.title, '') LIKE ${likeSearchTerm} ESCAPE ${likeEscape}`);
      clusterSearchClauses.push(Prisma.sql`COALESCE(cc.summary, '') LIKE ${likeSearchTerm} ESCAPE ${likeEscape}`);
    }

    if (singleSearchClauses.length > 0) {
      singleWhereClauses.push(Prisma.sql`(${Prisma.join(singleSearchClauses, " OR ")})`);
    }

    if (clusterSearchClauses.length > 0) {
      clusterWhereClauses.push(Prisma.sql`(${Prisma.join(clusterSearchClauses, " OR ")})`);
    }
  }

  if (filters.rangeStart) {
    clusterWhereClauses.push(Prisma.sql`cc."latestCreatedAt" >= ${filters.rangeStart.getTime()}`);
    singleWhereClauses.push(Prisma.sql`i."createdAt" >= ${filters.rangeStart.getTime()}`);
  }

  if (filters.rangeEnd) {
    clusterWhereClauses.push(Prisma.sql`cc."latestCreatedAt" <= ${filters.rangeEnd.getTime()}`);
    singleWhereClauses.push(Prisma.sql`i."createdAt" <= ${filters.rangeEnd.getTime()}`);
  }

  if (filters.publishedRangeStart) {
    clusterWhereClauses.push(Prisma.sql`cc."latestPublishedAt" >= ${filters.publishedRangeStart.getTime()}`);
    singleWhereClauses.push(Prisma.sql`i."publishedAt" >= ${filters.publishedRangeStart.getTime()}`);
  }

  if (filters.publishedRangeEnd) {
    clusterWhereClauses.push(Prisma.sql`cc."latestPublishedAt" <= ${filters.publishedRangeEnd.getTime()}`);
    singleWhereClauses.push(Prisma.sql`i."publishedAt" <= ${filters.publishedRangeEnd.getTime()}`);
  }

  return Prisma.sql`
    WITH cluster_entries AS (
      SELECT
        cc.id AS id,
        'cluster' AS type,
        cc.id AS "clusterId",
        ${includeDisplayFields ? Prisma.sql`cc.title AS title, cc.summary AS summary,` : Prisma.empty}
        cc."latestPublishedAt" AS "latestPublishedAt",
        cc."latestCreatedAt" AS "createdAt",
        cc."displayAverageScore" AS score,
        cc."displaySourceCount" AS "sourceCount",
        cc."displayItemCount" AS "itemCount",
        cc."displayItemCount" AS "totalItemCount",
        cc."dominantGroupId" AS "entryGroupId",
        cc."displayQualityScore" AS "qualityScore"
      FROM "content_clusters" cc
      WHERE ${Prisma.join(clusterWhereClauses, " AND ")}
    ),
    single_entries AS (
      SELECT
        i.id AS id,
        'single' AS type,
        i."clusterId" AS "clusterId",
        ${includeDisplayFields ? Prisma.sql`COALESCE(NULLIF(TRIM(i."translatedTitle"), ''), i."originalTitle") AS title, NULL AS summary,` : Prisma.empty}
        i."publishedAt" AS "latestPublishedAt",
        i."createdAt" AS "createdAt",
        i."qualityScore" AS score,
        1 AS "sourceCount",
        1 AS "itemCount",
        s."groupId" AS "entryGroupId",
        ${buildFeedQualityScoreSql(Prisma.sql`i."qualityScore"`)} AS "qualityScore"
      FROM "items" i
      INNER JOIN "sources" s ON s.id = i."sourceId"
      LEFT JOIN "content_clusters" c ON c.id = i."clusterId"
      WHERE ${Prisma.join(singleWhereClauses, " AND ")}
    ),
    all_entry_candidates AS (
      SELECT id, type, NULL AS "clusterId", ${includeDisplayFields ? Prisma.sql`title, summary,` : Prisma.empty} "latestPublishedAt", "createdAt", score, "sourceCount", "itemCount", "totalItemCount", "entryGroupId", "qualityScore"
      FROM cluster_entries
      UNION ALL
      SELECT id, type, "clusterId", ${includeDisplayFields ? Prisma.sql`title, summary,` : Prisma.empty} "latestPublishedAt", "createdAt", score, "sourceCount", "itemCount", CAST(1 AS INTEGER) AS "totalItemCount", "entryGroupId", "qualityScore"
      FROM single_entries
    ),
    entry_candidates AS (
      SELECT *
      FROM all_entry_candidates
      ${buildEntryCandidateWhereClause(filters)}
    )
  `;
}

function buildEntityFeedEntryCountCandidatesCte(
  filters: FeedFilters & {
    rangeStart: Date | null;
    rangeEnd: Date | null;
    publishedRangeStart: Date | null;
    publishedRangeEnd: Date | null;
  },
  searchTerm: string | null = null,
) {
  return Prisma.sql`
    ${buildEntityFeedEntryCandidatesCte(filters, searchTerm, { includeDisplayFields: false })},
    entry_count_candidates AS (
      SELECT id, "entryGroupId"
      FROM entry_candidates
    )
  `;
}

function buildActiveFeedEntryCandidatesCte(
  filters: FeedFilters & {
    rangeStart: Date | null;
    rangeEnd: Date | null;
    publishedRangeStart: Date | null;
    publishedRangeEnd: Date | null;
  },
  searchTerm: string | null,
  options: {
    includeDisplayFields?: boolean;
  } = {},
) {
  if (!isClusterEntityFilteringEnabled()) {
    return buildFeedEntryCandidatesCte(filters, searchTerm, {
      includeClusterScoreStats: true,
      includeDisplayFields: options.includeDisplayFields,
    });
  }

  return buildEntityFeedEntryCandidatesCte(filters, searchTerm, options);
}

function buildActiveFeedEntryCountCandidatesCte(
  filters: FeedFilters & {
    rangeStart: Date | null;
    rangeEnd: Date | null;
    publishedRangeStart: Date | null;
    publishedRangeEnd: Date | null;
  },
  searchTerm: string | null,
) {
  if (!isClusterEntityFilteringEnabled()) {
    return buildFeedEntryCountCandidatesCte(filters, searchTerm);
  }

  return buildEntityFeedEntryCountCandidatesCte(filters, searchTerm);
}

function buildFeedEntryOrderBy(sort: FeedFilters["sort"], entryKeys: FeedFilters["entryKeys"] = []) {
  if (entryKeys.length > 0) {
    return Prisma.sql`
      ORDER BY CASE
        ${Prisma.join(
          entryKeys.map((entryKey, index) => Prisma.sql`WHEN "type" || ':' || id = ${entryKey} THEN ${index}`),
          " ",
        )}
        ELSE ${entryKeys.length}
      END ASC, id DESC
    `;
  }

  if (sort === "score_desc") {
    // 按内容质量分降序。
    return Prisma.sql`ORDER BY "qualityScore" DESC, "latestPublishedAt" DESC, "itemCount" DESC, id DESC`;
  }

  return Prisma.sql`ORDER BY "createdAt" DESC, "qualityScore" DESC, "itemCount" DESC, id DESC`;
}

function resolvePaginationTotalFromGroupCounts(
  groupCounts: {
    groups: FeedGroupOption[];
    totalCount: number;
  },
  groupId: string | null,
) {
  if (!groupId) {
    return groupCounts.totalCount;
  }

  return groupCounts.groups.find((group) => group.id === groupId)?.count ?? 0;
}

export async function listFeedFilterOptions(): Promise<{
  groups: FeedGroupOption[];
  sources: FeedSourceOption[];
}> {
  const [groups, sources] = await Promise.all([
    prisma.sourceGroup.findMany({
      where: { sources: { some: { enabled: true } } },
      include: {
        _count: {
          select: {
            sources: { where: { enabled: true } },
          },
        },
      },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    prisma.source.findMany({
      where: { enabled: true },
      orderBy: [{ name: "asc" }],
    }),
  ]);

  return {
    groups: groups.map((group) => ({
      id: group.id,
      name: group.name,
      count: group._count.sources,
      color: toGroupBadge(group)?.color,
    })),
    sources: sources.map((source) => ({
      id: source.id,
      name: source.name,
      groupId: source.groupId,
    })),
  };
}

async function listFeedGroupCounts(
  filters: FeedFilters & {
    rangeStart: Date | null;
    rangeEnd: Date | null;
    publishedRangeStart: Date | null;
    publishedRangeEnd: Date | null;
  },
): Promise<{
  groups: FeedGroupOption[];
  totalCount: number;
}> {
  const effectiveFilters = {
    ...filters,
    groupId: null,
  };
  const searchTerm = sanitizeFts5Query(filters.title);
  const entryCandidatesCte = buildActiveFeedEntryCountCandidatesCte(effectiveFilters, searchTerm);
  const groupRows = await prisma.$queryRaw<(FeedGroupCountRow & { total: bigint })[]>(Prisma.sql`
    ${entryCandidatesCte},
    grouped_entries AS (
      SELECT
        ecc."entryGroupId" AS id,
        COUNT(*) AS count
      FROM entry_count_candidates ecc
      WHERE ecc."entryGroupId" IS NOT NULL
      GROUP BY ecc."entryGroupId"
    ),
    total_entries AS (
      SELECT COUNT(*) AS total
      FROM entry_count_candidates
    )
    SELECT
      ge.id AS id,
      g.name AS name,
      g."sortOrder" AS "sortOrder",
      ge.count AS count,
      te.total AS total
    FROM grouped_entries ge
    INNER JOIN "source_groups" g ON g.id = ge.id
    CROSS JOIN total_entries te
    ORDER BY g."sortOrder" ASC, g.name ASC
  `);

  const totalCount =
    groupRows.length > 0
      ? toNumber(groupRows[0].total)
      : toNumber(
          (
            await prisma.$queryRaw<CountRow[]>(Prisma.sql`
              ${entryCandidatesCte}
              SELECT COUNT(*) AS total
              FROM entry_count_candidates
            `)
          )[0]?.total ?? BigInt(0),
        );

  return {
    groups: groupRows.map((row) => ({
      id: row.id,
      name: row.name,
      count: toNumber(row.count),
      color: toGroupBadge(row)?.color,
    })),
    totalCount,
  };
}

export async function listFeedItems(
  filters: FeedFilters & {
    rangeStart: Date | null;
    rangeEnd: Date | null;
    publishedRangeStart: Date | null;
    publishedRangeEnd: Date | null;
  },
  pagination: {
    page: number;
    size: number;
  },
) {
  const searchTerm = sanitizeFts5Query(filters.title);
  const entryCandidatesCte = buildActiveFeedEntryCandidatesCte(filters, searchTerm, {
    includeDisplayFields: false,
  });
  const requestedPage = Math.max(1, pagination.page);
  let page = requestedPage;
  let offset = (requestedPage - 1) * pagination.size;

  const queryPageRows = (pageOffset: number) =>
    prisma.$queryRaw<FeedEntryRow[]>(Prisma.sql`
      ${entryCandidatesCte}
      SELECT
        id,
        type AS "entryType",
        "clusterId",
        "latestPublishedAt",
        "createdAt",
        "qualityScore" AS score,
        "sourceCount",
        "itemCount",
        "totalItemCount",
        "qualityScore"
      FROM entry_candidates
      ${buildFeedEntryOrderBy(filters.sort, filters.entryKeys)}
      LIMIT ${pagination.size}
      OFFSET ${pageOffset}
    `);

  const [initialPageRows, groupCounts] = await Promise.all([
    queryPageRows(offset),
    listFeedGroupCounts(filters),
  ]);
  let pageRows = initialPageRows;
  const total = resolvePaginationTotalFromGroupCounts(groupCounts, filters.groupId);
  const totalPages = Math.max(1, Math.ceil(total / pagination.size));
  page = Math.min(requestedPage, totalPages);

  if (pageRows.length === 0 && total > 0 && page !== requestedPage) {
    offset = (page - 1) * pagination.size;
    pageRows = await queryPageRows(offset);
  }

  const singleIds = pageRows.filter((row) => row.entryType === "single").map((row) => row.id);
  const clusterIds = pageRows.filter((row) => row.entryType === "cluster").map((row) => row.id);
  const [singleItems, clusterItems, clusterMetadataRows] = await Promise.all([
    singleIds.length > 0
      ? prisma.item.findMany({
          where: {
            id: {
              in: singleIds,
            },
          },
          include: {
            source: {
              include: {
                group: true,
              },
            },
          },
        })
      : Promise.resolve([]),
    clusterIds.length > 0
      ? prisma.item.findMany({
          where: {
            clusterId: { in: clusterIds },
            status: "processed",
            moderationStatus: {
              in: [...DISPLAYABLE_MODERATION_STATUSES],
            },
            isAggregation: false,
            source: {
              is: {
                enabled: true,
              },
            },
          },
          include: {
            source: {
              include: {
                group: true,
              },
            },
          },
          orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
        })
      : Promise.resolve([]),
    clusterIds.length > 0
      ? prisma.contentCluster.findMany({
          where: {
            id: {
              in: clusterIds,
            },
          },
          select: {
            id: true,
            title: true,
            summary: true,
            dominantGroup: true,
          },
        })
      : Promise.resolve([]),
  ]);
  const singleItemMap = new Map(singleItems.map((item) => [item.id, mapItemToFeedItem(item)]));
  const clusterMetadataMap = new Map(
    (clusterMetadataRows as FeedClusterMetadataRow[]).map((cluster) => [cluster.id, cluster]),
  );
  const clusterItemMap = new Map<string, ItemWithSource[]>();
  const selectedGroup = filters.groupId
    ? toGroupBadge(groupCounts.groups.find((group) => group.id === filters.groupId))
    : null;

  for (const item of clusterItems) {
    if (!item.clusterId) {
      continue;
    }

    const current = clusterItemMap.get(item.clusterId) ?? [];
    current.push(item);
    clusterItemMap.set(item.clusterId, current);
  }

  const items = pageRows.flatMap<FeedEntryDTO>((row) => {
    if (row.entryType === "single") {
      const item = singleItemMap.get(row.id);
      if (!item) {
        return [];
      }
      return [{
        ...item,
        score: toNumber(row.qualityScore ?? row.score),
      }];
    }

    const clusterItemsForEntry = clusterItemMap.get(row.id) ?? [];
    const previewItems = clusterItemsForEntry.slice(0, 3).map(mapItemToClusterPreview);
    const totalCount = toNumber(row.totalItemCount ?? row.itemCount);
    const metadata = clusterMetadataMap.get(row.id);

    return [
      {
        id: row.id,
        type: "cluster",
        title: metadata?.title ?? row.id,
        summary: normalizeDisplaySummary(metadata?.summary ?? null),
        group: selectedGroup ?? toGroupBadge(metadata?.dominantGroup ?? null) ?? selectDominantGroupBadge(clusterItemsForEntry, null),
        publishedAt: toIsoString(row.latestPublishedAt),
        createdAt: toIsoString(row.createdAt),
        latestPublishedAt: toIsoString(row.latestPublishedAt),
        score: toNumber(row.qualityScore ?? row.score),
        sourceCount: toNumber(row.sourceCount),
        itemCount: totalCount,
        itemsPreview: previewItems,
        hasMoreItems: totalCount > previewItems.length,
      },
    ];
  });
  const nextCursor = page < totalPages ? pageRows[pageRows.length - 1]?.id ?? null : null;
  const normalizedPagination: FeedPagination = {
    page,
    size: pagination.size,
    total,
    totalPages,
  };

  return {
    items,
    groups: groupCounts.groups,
    groupTotalCount: groupCounts.totalCount,
    pagination: normalizedPagination,
    nextCursor,
  };
}

export async function listClusterItems(
  clusterId: string,
  filters: FeedFilters & {
    rangeStart: Date | null;
    rangeEnd: Date | null;
    publishedRangeStart: Date | null;
    publishedRangeEnd: Date | null;
  },
) {
  const items = await prisma.item.findMany({
    where: buildItemWhere(filters, clusterId),
    include: {
      source: {
        include: {
          group: true,
        },
      },
      parent: {
        select: aggregationParentSelect,
      },
    },
    orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
  });

  return items.map(mapItemToClusterPreview);
}

export type FilteredItemsQuery = {
  search?: string | null;
  sourceName?: string | null;
  moderationReason?: string | null;
  updatedAtStart?: Date | null;
};

function buildFilteredItemsWhere(filters?: FilteredItemsQuery): Prisma.ItemWhereInput {
  const search = filters?.search?.trim();

  return {
    moderationStatus: "filtered",
    ...(filters?.sourceName ? { source: { is: { name: filters.sourceName } } } : {}),
    ...(filters?.moderationReason ? { moderationReason: filters.moderationReason as ModerationReason } : {}),
    ...(filters?.updatedAtStart ? { updatedAt: { gte: filters.updatedAtStart } } : {}),
    ...(search
      ? {
          OR: [
            { originalTitle: { contains: search } },
            { translatedTitle: { contains: search } },
            { summaryText: { contains: search } },
            { rssExcerpt: { contains: search } },
            { moderationDetail: { contains: search } },
          ],
        }
      : {}),
  };
}

export async function listFilteredItems(page = 1, pageSize = 20, filters?: FilteredItemsQuery) {
  const skip = (page - 1) * pageSize;
  const where = buildFilteredItemsWhere(filters);
  const [items, total] = await Promise.all([
    prisma.item.findMany({
      where,
      include: { source: true },
      orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
      take: pageSize,
      skip,
    }),
    prisma.item.count({ where }),
  ]);

  return { items: items.map(mapItemToReviewItem), total, page, pageSize };
}

export type AggregationSplitQuery = {
  search?: string | null;
  status?: string | null;
  updatedAtStart?: Date | null;
};

function buildAggregationSplitWhere(filters?: AggregationSplitQuery): Prisma.ItemWhereInput {
  const search = filters?.search?.trim();
  const status = filters?.status?.trim();

  return {
    isAggregation: true,
    ...(status ? { aggregationParseStatus: status } : {}),
    ...(filters?.updatedAtStart ? { updatedAt: { gte: filters.updatedAtStart } } : {}),
    ...(search
      ? {
          OR: [
            { originalTitle: { contains: search } },
            { translatedTitle: { contains: search } },
            { summaryText: { contains: search } },
            { rssExcerpt: { contains: search } },
            { source: { is: { name: { contains: search } } } },
            {
              aggregationSplitChildren: {
                some: {
                  child: {
                    OR: [
                      { originalTitle: { contains: search } },
                      { translatedTitle: { contains: search } },
                      { summaryText: { contains: search } },
                    ],
                  },
                },
              },
            },
            {
              children: {
                some: {
                  OR: [
                    { originalTitle: { contains: search } },
                    { translatedTitle: { contains: search } },
                    { summaryText: { contains: search } },
                  ],
                },
              },
            },
          ],
        }
      : {}),
  };
}

const aggregationSplitParentInclude = {
  source: {
    select: {
      name: true,
    },
  },
  children: {
    include: {
      source: {
        select: {
          name: true,
        },
      },
      cluster: {
        select: {
          id: true,
          title: true,
        },
      },
    },
    orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
  },
  aggregationSplitChildren: {
    include: {
      child: {
        include: {
          source: {
            select: {
              name: true,
            },
          },
          cluster: {
            select: {
              id: true,
              title: true,
            },
          },
        },
      },
    },
    orderBy: [{ eventIndex: "asc" }, { createdAt: "asc" }],
  },
} satisfies Prisma.ItemInclude;

export async function listAggregationSplitParents(
  page = 1,
  pageSize = 20,
  filters?: AggregationSplitQuery,
) {
  const skip = (page - 1) * pageSize;
  const where = buildAggregationSplitWhere(filters);
  const [items, total] = await Promise.all([
    prisma.item.findMany({
      where,
      include: aggregationSplitParentInclude,
      orderBy: [{ aggregationCheckedAt: "desc" }, { updatedAt: "desc" }, { createdAt: "desc" }],
      take: pageSize,
      skip,
    }),
    prisma.item.count({ where }),
  ]);

  return {
    items: items.map((item) => mapAggregationSplitParentToDto(item)),
    total,
    page,
    pageSize,
  };
}

export async function getAggregationSplitParent(parentItemId: string) {
  const item = await prisma.item.findFirst({
    where: {
      id: parentItemId,
      isAggregation: true,
    },
    include: aggregationSplitParentInclude,
  });

  return item ? mapAggregationSplitParentToDto(item, { includeChildren: true }) : null;
}

export type AdminClusterQueryOptions = {
  minItemCount?: number | null;
  status?: "active" | "hidden" | null;
  latestItemUpdatedAtStart?: Date | null;
  latestItemUpdatedAtEnd?: Date | null;
};

function buildAdminClusterWhereClause(options?: AdminClusterQueryOptions) {
  const clauses: Prisma.Sql[] = [];

  if (typeof options?.minItemCount === "number") {
    clauses.push(Prisma.sql`cc."itemCount" >= ${options.minItemCount}`);
  }

  if (options?.status) {
    clauses.push(Prisma.sql`cc.status = ${options.status}`);
  }

  return clauses.length > 0
    ? Prisma.sql`WHERE ${Prisma.join(clauses, " AND ")}`
    : Prisma.empty;
}

function buildAdminClusterHavingClause(options?: AdminClusterQueryOptions) {
  const clauses: Prisma.Sql[] = [];
  const latestUpdatedAt = Prisma.sql`COALESCE(MAX(latest_items."updatedAt"), MAX(cc."updatedAt"))`;

  if (options?.latestItemUpdatedAtStart) {
    clauses.push(Prisma.sql`${latestUpdatedAt} >= ${options.latestItemUpdatedAtStart.getTime()}`);
  }

  if (options?.latestItemUpdatedAtEnd) {
    clauses.push(Prisma.sql`${latestUpdatedAt} <= ${options.latestItemUpdatedAtEnd.getTime()}`);
  }

  return clauses.length > 0
    ? Prisma.sql`HAVING ${Prisma.join(clauses, " AND ")}`
    : Prisma.empty;
}

export async function listAdminClusters(
  page = 1,
  pageSize = 20,
  search?: string | null,
  options?: AdminClusterQueryOptions,
) {
  const skip = (page - 1) * pageSize;
  const searchTerms = getDatabaseSearchTerms(search);
  const searchCte = buildAdminClusterSearchCte(searchTerms);
  const whereClause = buildAdminClusterWhereClause(options);
  const havingClause = buildAdminClusterHavingClause(options);
  const itemUpdatedJoin = Prisma.sql`
    LEFT JOIN "items" latest_items ON latest_items."clusterId" = cc.id
      AND latest_items.status = ${"processed"}
      AND latest_items."moderationStatus" IN (${Prisma.join([...DISPLAYABLE_MODERATION_STATUSES])})
  `;
  const orderByLatestItemUpdatedAt = Prisma.sql`
    ORDER BY MAX(latest_items."updatedAt") DESC, MAX(cc."updatedAt") DESC, cc.id DESC
  `;

  if (searchCte) {
    const [idRows, totalRows] = await Promise.all([
      prisma.$queryRaw<IdRow[]>(Prisma.sql`
        ${searchCte}
        SELECT cc.id
        FROM "content_clusters" cc
        INNER JOIN matched_clusters mc ON mc.id = cc.id
        ${itemUpdatedJoin}
        ${whereClause}
        GROUP BY cc.id
        ${havingClause}
        ${orderByLatestItemUpdatedAt}
        LIMIT ${pageSize}
        OFFSET ${skip}
      `),
      prisma.$queryRaw<CountRow[]>(Prisma.sql`
        ${searchCte}
        SELECT COUNT(*) AS total FROM (
          SELECT cc.id
          FROM "content_clusters" cc
          INNER JOIN matched_clusters mc ON mc.id = cc.id
          ${itemUpdatedJoin}
          ${whereClause}
          GROUP BY cc.id
          ${havingClause}
        ) matched_admin_clusters
      `),
    ]);
    const ids = idRows.map((row) => row.id);
    const order = new Map(ids.map((id, index) => [id, index]));
    const [clusters, latestItemUpdatedAtByCluster] = await Promise.all([
      ids.length > 0
        ? prisma.contentCluster.findMany({
            where: { id: { in: ids } },
            include: {
              items: {
                where: {
                  status: "processed",
                  moderationStatus: {
                    in: [...DISPLAYABLE_MODERATION_STATUSES],
                  },
                },
                include: {
                  source: {
                    include: {
                      group: true,
                    },
                  },
                  parent: {
                    select: aggregationParentSelect,
                  },
                },
                orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
                take: 5,
              },
            },
        })
        : [],
      getLatestItemUpdatedAtByCluster(ids),
    ]);
    const liveScoreStatsByCluster = await getClusterScoreStatsByCluster(
      clusters.filter((cluster) => !cluster.feedStatsUpdatedAt).map((cluster) => cluster.id),
    );
    const mappedClusters = clusters
      .sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0))
      .map((cluster) =>
        mapClusterToAdminDto(
          cluster,
          latestItemUpdatedAtByCluster.get(cluster.id),
          getPrecomputedClusterScoreStats(cluster) ?? liveScoreStatsByCluster.get(cluster.id),
        ),
      );

    return {
      clusters: mappedClusters,
      total: toNumber(totalRows[0]?.total ?? BigInt(0)),
      page,
      pageSize,
    };
  }

  const [idRows, totalRows] = await Promise.all([
    prisma.$queryRaw<IdRow[]>(Prisma.sql`
      SELECT cc.id
      FROM "content_clusters" cc
      ${itemUpdatedJoin}
      ${whereClause}
      GROUP BY cc.id
      ${havingClause}
      ${orderByLatestItemUpdatedAt}
      LIMIT ${pageSize}
      OFFSET ${skip}
    `),
    prisma.$queryRaw<CountRow[]>(Prisma.sql`
      SELECT COUNT(*) AS total FROM (
        SELECT cc.id
        FROM "content_clusters" cc
        ${itemUpdatedJoin}
        ${whereClause}
        GROUP BY cc.id
        ${havingClause}
      ) matched_admin_clusters
    `),
  ]);
  const ids = idRows.map((row) => row.id);
  const order = new Map(ids.map((id, index) => [id, index]));
  const [clusters, latestItemUpdatedAtByCluster] = await Promise.all([
    ids.length > 0
      ? prisma.contentCluster.findMany({
          where: { id: { in: ids } },
          include: {
            items: {
              where: {
                status: "processed",
                moderationStatus: {
                  in: [...DISPLAYABLE_MODERATION_STATUSES],
                },
              },
              include: {
                source: {
                  include: {
                    group: true,
                  },
                },
                parent: {
                  select: aggregationParentSelect,
                },
              },
              orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
              take: 5,
            },
          },
      })
      : [],
    getLatestItemUpdatedAtByCluster(ids),
  ]);
  const liveScoreStatsByCluster = await getClusterScoreStatsByCluster(
    clusters.filter((cluster) => !cluster.feedStatsUpdatedAt).map((cluster) => cluster.id),
  );

  const mappedClusters = clusters
    .sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0))
    .map((cluster) =>
      mapClusterToAdminDto(
        cluster,
        latestItemUpdatedAtByCluster.get(cluster.id),
        getPrecomputedClusterScoreStats(cluster) ?? liveScoreStatsByCluster.get(cluster.id),
      ),
    );
  return {
    clusters: mappedClusters,
    total: toNumber(totalRows[0]?.total ?? BigInt(0)),
    page,
    pageSize,
  };
}

export async function getAdminCluster(clusterId: string) {
  const cluster = await prisma.contentCluster.findUnique({
    where: { id: clusterId },
    include: {
      items: {
        where: {
          status: "processed",
          moderationStatus: {
            in: [...DISPLAYABLE_MODERATION_STATUSES],
          },
        },
        include: {
          source: {
            include: {
              group: true,
            },
          },
          parent: {
            select: aggregationParentSelect,
          },
        },
        orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
      },
    },
  });

  if (!cluster) {
    return null;
  }

  const latestItemUpdatedAt = cluster.items.reduce<Date | null>((latest, item) => {
    if (!latest || item.updatedAt.getTime() > latest.getTime()) {
      return item.updatedAt;
    }
    return latest;
  }, null);

  return {
    ...mapClusterToAdminDto(cluster, latestItemUpdatedAt),
    itemCount: cluster.items.length,
    items: cluster.items.map(mapItemToClusterPreview),
  } satisfies ClusterDTO;
}
