import { prisma } from "@/lib/db";
import type {
  EventBriefingCandidate,
  EventBriefingDateRange,
  EventBriefingTag,
  EventCandidateEntity,
  EventCandidateItem,
  EventCandidateSource,
} from "@/lib/events/types";
import { getDisplaySummary, getDisplayTitle } from "@/lib/feed/presentation";

const DISPLAYABLE_MODERATION_STATUSES = ["allowed", "restored"] as const;

type PublicItemRow = Awaited<ReturnType<typeof listDailyPublicItems>>[number];

type ListEventBriefingCandidateOptions = {
  groupIds?: string[];
  tag?: EventBriefingTag;
  /** 关注快照：非空时只在关注源内取候选/聚类成员；空集合表示无输入而非全量。 */
  followedSourceIds?: string[];
  dateBasis?: "published";
};

function uniqueBy<T>(values: T[], getKey: (value: T) => string) {
  const seen = new Set<string>();
  const result: T[] = [];

  for (const value of values) {
    const key = getKey(value);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
  }

  return result;
}

function parseClusterEntities(raw: string | null | undefined): EventCandidateEntity[] {
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((entry): EventCandidateEntity | null => {
        if (!entry || typeof entry !== "object") {
          return null;
        }

        const name = "name" in entry && typeof entry.name === "string" ? entry.name.trim() : "";
        const normalized = "normalized" in entry && typeof entry.normalized === "string"
          ? entry.normalized.trim()
          : name.toLowerCase();

        return name && normalized ? { name, normalized } : null;
      })
      .filter((entry): entry is EventCandidateEntity => Boolean(entry));
  } catch {
    return [];
  }
}

function entitiesFromItem(item: PublicItemRow): EventCandidateEntity[] {
  return item.entities.map(({ entity }) => ({
    name: entity.name,
    normalized: entity.normalized,
  }));
}

function getItemSummary(item: PublicItemRow) {
  return getDisplaySummary(item.summaryText, item.rssExcerpt, item.fullText ?? item.rssContent);
}

function toCandidateItem(item: PublicItemRow): EventCandidateItem {
  return {
    id: item.id,
    title: getDisplayTitle(item.originalTitle, item.translatedTitle),
    summary: getItemSummary(item),
    sourceName: item.source.name,
    originalUrl: item.originalUrl,
    publishedAt: item.publishedAt,
    publishedAtKnown: item.publishedAtKnown,
    createdAt: item.createdAt,
    qualityScore: item.qualityScore,
  };
}

function buildSearchText(input: {
  title: string;
  summary: string;
  eventType: string | null;
  eventSubject: string | null;
  eventAction: string | null;
  eventObject: string | null;
  sources: EventCandidateSource[];
  entities: EventCandidateEntity[];
}) {
  return [
    input.title,
    input.summary,
    input.eventType,
    input.eventSubject,
    input.eventAction,
    input.eventObject,
    ...input.sources.map((source) => source.name),
    ...input.entities.flatMap((entity) => [entity.name, entity.normalized]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function normalizeGroupIds(groupIds: string[] | undefined) {
  return [...new Set((groupIds ?? []).filter(Boolean))];
}

function normalizeFollowedSourceIds(followedSourceIds: string[] | undefined) {
  return [...new Set((followedSourceIds ?? []).filter(Boolean))];
}

function buildSourceFilter(groupIds: string[] = [], followedSourceIds?: string[]) {
  const followed = normalizeFollowedSourceIds(followedSourceIds);
  if (followed.length === 0 && followedSourceIds !== undefined) {
    // 显式空关注快照：无任何输入，不回退全量。
    return { sourceId: { in: [] as string[] } };
  }
  return {
    source: {
      is: {
        enabled: true,
        ...(followed.length > 0 ? { id: { in: followed } } : {}),
        ...(groupIds.length > 0 ? { groupId: { in: groupIds } } : {}),
      },
    },
  };
}

async function listDailyPublicItems(range: EventBriefingDateRange, options: ListEventBriefingCandidateOptions = {}) {
  const groupIds = normalizeGroupIds(options.groupIds);
  const sourceFilter = buildSourceFilter(groupIds, options.followedSourceIds);
  const tagWhere = options.tag === "follow_up"
    ? {
        cluster: {
          is: {
            status: "active" as const,
            OR: [
              { earliestCreatedAt: null },
              { earliestCreatedAt: { lt: range.start } },
            ],
          },
        },
      }
    : options.tag === "new_content"
      ? {
          OR: [
            { clusterId: null },
            {
              cluster: {
                is: {
                  status: "active" as const,
                  OR: [
                    { earliestCreatedAt: null },
                    { earliestCreatedAt: { gte: range.start } },
                  ],
                },
              },
            },
          ],
        }
      : null;

  return prisma.item.findMany({
    where: {
      ...(options.dateBasis === "published"
        ? { publishedAtKnown: true, publishedAt: { gte: range.start, lt: range.end } }
        : { createdAt: { gte: range.start, lt: range.end } }),
      status: "processed",
      moderationStatus: { in: [...DISPLAYABLE_MODERATION_STATUSES] },
      isAggregation: false,
      ...sourceFilter,
      AND: [
        {
          OR: [
            { clusterId: null },
            { cluster: { is: { status: "active" } } },
          ],
        },
        ...(tagWhere ? [tagWhere] : []),
      ],
    },
    select: {
      id: true,
      clusterId: true,
      originalUrl: true,
      originalTitle: true,
      translatedTitle: true,
      rssExcerpt: true,
      rssContent: true,
      fullText: true,
      summaryText: true,
      qualityScore: true,
      createdAt: true,
      publishedAt: true,
      publishedAtKnown: true,
      eventType: true,
      eventSubject: true,
      eventAction: true,
      eventObject: true,
      eventDate: true,
      source: {
        select: {
          id: true,
          name: true,
          groupId: true,
        },
      },
      parent: {
        select: {
          clusterId: true,
        },
      },
      aggregationSplitParents: {
        select: {
          parent: {
            select: {
              clusterId: true,
            },
          },
        },
      },
      entities: {
        select: {
          entity: {
            select: {
              name: true,
              normalized: true,
            },
          },
        },
      },
      cluster: {
        select: {
          id: true,
          title: true,
          summary: true,
          score: true,
          eventType: true,
          eventSubject: true,
          eventAction: true,
          eventObject: true,
          eventDate: true,
          displayItemCount: true,
          displaySourceCount: true,
          displayAverageScore: true,
          displayQualityScore: true,
          earliestCreatedAt: true,
          latestCreatedAt: true,
          latestPublishedAt: true,
          feedEntitiesJson: true,
          createdAt: true,
        },
      },
    },
    orderBy: [{ qualityScore: "desc" }, { createdAt: "desc" }],
  });
}

async function listClusterPublicMembers(clusterIds: string[], options: ListEventBriefingCandidateOptions = {}) {
  if (clusterIds.length === 0) {
    return [];
  }

  const groupIds = normalizeGroupIds(options.groupIds);
  const memberSourceFilter = buildSourceFilter(groupIds, options.followedSourceIds);

  return prisma.item.findMany({
    where: {
      clusterId: { in: clusterIds },
      status: "processed",
      moderationStatus: { in: [...DISPLAYABLE_MODERATION_STATUSES] },
      isAggregation: false,
      ...memberSourceFilter,
    },
    select: {
      id: true,
      clusterId: true,
      originalUrl: true,
      originalTitle: true,
      translatedTitle: true,
      rssExcerpt: true,
      rssContent: true,
      fullText: true,
      summaryText: true,
      qualityScore: true,
      createdAt: true,
      publishedAt: true,
      publishedAtKnown: true,
      eventType: true,
      eventSubject: true,
      eventAction: true,
      eventObject: true,
      eventDate: true,
      source: {
        select: {
          id: true,
          name: true,
          groupId: true,
        },
      },
      parent: {
        select: {
          clusterId: true,
        },
      },
      aggregationSplitParents: {
        select: {
          parent: {
            select: {
              clusterId: true,
            },
          },
        },
      },
      entities: {
        select: {
          entity: {
            select: {
              name: true,
              normalized: true,
            },
          },
        },
      },
      cluster: {
        select: {
          id: true,
          title: true,
          summary: true,
          score: true,
          eventType: true,
          eventSubject: true,
          eventAction: true,
          eventObject: true,
          eventDate: true,
          displayItemCount: true,
          displaySourceCount: true,
          displayAverageScore: true,
          displayQualityScore: true,
          earliestCreatedAt: true,
          latestCreatedAt: true,
          latestPublishedAt: true,
          feedEntitiesJson: true,
          createdAt: true,
        },
      },
    },
    orderBy: [{ qualityScore: "desc" }, { createdAt: "desc" }],
  });
}

function pickRepresentative(items: PublicItemRow[]) {
  return [...items].sort((left, right) => {
    if (right.qualityScore !== left.qualityScore) {
      return right.qualityScore - left.qualityScore;
    }
    return right.createdAt.getTime() - left.createdAt.getTime();
  })[0]!;
}

function buildClusterCandidate(
  clusterId: string,
  dailyItems: PublicItemRow[],
  allMembers: PublicItemRow[],
  range: EventBriefingDateRange,
  followScoped = false,
  publicationDateBasis = false,
): EventBriefingCandidate | null {
  const representative = pickRepresentative(publicationDateBasis ? dailyItems : (allMembers.length ? allMembers : dailyItems));
  const cluster = representative.cluster;

  if (!cluster) {
    return null;
  }

  if (allMembers.length <= 1) {
    return buildSingleCandidate(representative);
  }

  // 关注快照模式下，聚类全局字段（title/summary/score/display*/event/feedEntitiesJson）
  // 可能由未关注源聚合而来，一律改用关注成员自身内容构造与评分。
  const sources = uniqueBy(
    allMembers.map((item) => ({
      id: item.source.id,
      name: item.source.name,
      groupId: item.source.groupId,
    })),
    (source) => source.id,
  );
  const dailySources = uniqueBy(
    dailyItems.map((item) => ({
      id: item.source.id,
      name: item.source.name,
      groupId: item.source.groupId,
    })),
    (source) => source.id,
  );
  const entities = uniqueBy(
    [
      ...(followScoped ? [] : parseClusterEntities(cluster.feedEntitiesJson)),
      ...allMembers.flatMap(entitiesFromItem),
    ],
    (entity) => entity.normalized.toLowerCase(),
  );
  const memberLatestCreatedAt = allMembers.reduce(
    (latest, item) => item.createdAt.getTime() > latest.getTime() ? item.createdAt : latest,
    representative.createdAt,
  );
  const memberLatestPublishedAt = allMembers.reduce(
    (latest, item) => item.publishedAt.getTime() > latest.getTime() ? item.publishedAt : latest,
    representative.publishedAt,
  );
  const memberEarliestCreatedAt = allMembers.reduce(
    (earliest, item) => item.createdAt.getTime() < earliest.getTime() ? item.createdAt : earliest,
    representative.createdAt,
  );
  const earliestKnownPublication = allMembers
    .filter((item) => item.publishedAtKnown)
    .reduce<Date | null>((earliest, item) => !earliest || item.publishedAt < earliest ? item.publishedAt : earliest, null);
  const title = followScoped
    ? getDisplayTitle(representative.originalTitle, representative.translatedTitle)
    : cluster.title.trim() || getDisplayTitle(representative.originalTitle, representative.translatedTitle);
  const summary = followScoped
    ? getItemSummary(representative)
    : getDisplaySummary(cluster.summary, representative.summaryText, representative.rssExcerpt ?? representative.fullText);
  const qualityScore = followScoped
    ? Math.max(...allMembers.map((item) => item.qualityScore))
    : cluster.displayAverageScore || cluster.score || representative.qualityScore;
  const sourceCount = followScoped ? sources.length : Math.max(cluster.displaySourceCount, sources.length);
  const itemCount = followScoped ? allMembers.length : Math.max(cluster.displayItemCount, allMembers.length);
  const items = [...allMembers].sort((left, right) => {
    if (right.publishedAtKnown !== left.publishedAtKnown) {
      return right.publishedAtKnown ? 1 : -1;
    }
    if (right.publishedAt.getTime() !== left.publishedAt.getTime()) {
      return right.publishedAt.getTime() - left.publishedAt.getTime();
    }
    return right.createdAt.getTime() - left.createdAt.getTime();
  }).map(toCandidateItem);

  return {
    id: clusterId,
    type: "cluster",
    title,
    summary,
    qualityScore,
    sourceCount,
    itemCount,
    newItemCountOnDate: dailyItems.length,
    newSourceCountOnDate: dailySources.length,
    latestCreatedAt: followScoped ? memberLatestCreatedAt : cluster.latestCreatedAt ?? memberLatestCreatedAt,
    latestPublishedAt: followScoped ? memberLatestPublishedAt : cluster.latestPublishedAt ?? memberLatestPublishedAt,
    earliestCreatedAt: followScoped ? memberEarliestCreatedAt : cluster.earliestCreatedAt ?? memberEarliestCreatedAt,
    representativeUrl: representative.originalUrl,
    eventType: followScoped ? representative.eventType : cluster.eventType ?? representative.eventType,
    eventSubject: followScoped ? representative.eventSubject : cluster.eventSubject ?? representative.eventSubject,
    eventAction: followScoped ? representative.eventAction : cluster.eventAction ?? representative.eventAction,
    eventObject: followScoped ? representative.eventObject : cluster.eventObject ?? representative.eventObject,
    eventDate: followScoped ? representative.eventDate : cluster.eventDate ?? representative.eventDate,
    isFollowUp: publicationDateBasis
      ? Boolean(earliestKnownPublication && earliestKnownPublication.getTime() < range.start.getTime())
      : (followScoped ? memberEarliestCreatedAt : cluster.earliestCreatedAt ?? memberEarliestCreatedAt).getTime() < range.start.getTime(),
    entities,
    sources,
    items,
    searchText: buildSearchText({
      title,
      summary,
      eventType: followScoped ? representative.eventType : cluster.eventType ?? representative.eventType,
      eventSubject: followScoped ? representative.eventSubject : cluster.eventSubject ?? representative.eventSubject,
      eventAction: followScoped ? representative.eventAction : cluster.eventAction ?? representative.eventAction,
      eventObject: followScoped ? representative.eventObject : cluster.eventObject ?? representative.eventObject,
      sources,
      entities,
    }),
  };
}

function buildSingleCandidate(item: PublicItemRow): EventBriefingCandidate {
  const entities = uniqueBy(entitiesFromItem(item), (entity) => entity.normalized.toLowerCase());
  const sources = [{
    id: item.source.id,
    name: item.source.name,
    groupId: item.source.groupId,
  }];
  const title = getDisplayTitle(item.originalTitle, item.translatedTitle);
  const summary = getItemSummary(item);

  return {
    id: item.id,
    type: "single",
    title,
    summary,
    qualityScore: item.qualityScore,
    sourceCount: 1,
    itemCount: 1,
    newItemCountOnDate: 1,
    newSourceCountOnDate: 1,
    latestCreatedAt: item.createdAt,
    latestPublishedAt: item.publishedAt,
    earliestCreatedAt: item.createdAt,
    representativeUrl: item.originalUrl,
    eventType: item.eventType,
    eventSubject: item.eventSubject,
    eventAction: item.eventAction,
    eventObject: item.eventObject,
    eventDate: item.eventDate,
    isFollowUp: false,
    entities,
    sources,
    items: [toCandidateItem(item)],
    searchText: buildSearchText({
      title,
      summary,
      eventType: item.eventType,
      eventSubject: item.eventSubject,
      eventAction: item.eventAction,
      eventObject: item.eventObject,
      sources,
      entities,
    }),
  };
}

function getAggregationParentClusterIds(item: PublicItemRow) {
  return [
    item.parent?.clusterId,
    ...item.aggregationSplitParents.map((link) => link.parent.clusterId),
  ].filter((clusterId): clusterId is string => Boolean(clusterId));
}

function matchesEventBriefingTag(candidate: EventBriefingCandidate, tag: EventBriefingTag | undefined) {
  if (!tag || tag === "all") {
    return true;
  }

  return tag === "follow_up" ? candidate.isFollowUp : !candidate.isFollowUp;
}

export async function listEventBriefingCandidates(
  range: EventBriefingDateRange,
  options: ListEventBriefingCandidateOptions = {},
) {
  const dailyItems = await listDailyPublicItems(range, options);
  const clusterIds = uniqueBy(
    dailyItems
      .map((item) => item.clusterId)
      .filter((clusterId): clusterId is string => Boolean(clusterId)),
    (clusterId) => clusterId,
  );
  const clusterMembers = await listClusterPublicMembers(clusterIds, options);
  const dailyItemsByClusterId = new Map<string, PublicItemRow[]>();
  const clusterMembersByClusterId = new Map<string, PublicItemRow[]>();

  for (const item of dailyItems) {
    if (!item.clusterId) {
      continue;
    }
    dailyItemsByClusterId.set(item.clusterId, [...(dailyItemsByClusterId.get(item.clusterId) ?? []), item]);
  }

  for (const item of clusterMembers) {
    if (!item.clusterId) {
      continue;
    }
    clusterMembersByClusterId.set(item.clusterId, [...(clusterMembersByClusterId.get(item.clusterId) ?? []), item]);
  }

  const clusterCandidates = clusterIds
    .map((clusterId) => buildClusterCandidate(
      clusterId,
      dailyItemsByClusterId.get(clusterId) ?? [],
      clusterMembersByClusterId.get(clusterId) ?? [],
      range,
      options.followedSourceIds !== undefined,
      options.dateBasis === "published",
    ))
    .filter((candidate): candidate is EventBriefingCandidate => Boolean(candidate))
    .filter((candidate) => matchesEventBriefingTag(candidate, options.tag));
  const visibleClusterIds = new Set(
    clusterCandidates
      .filter((candidate) => candidate.type === "cluster")
      .map((candidate) => candidate.id),
  );
  const clusteredItemIds = new Set(
    clusterCandidates
      .filter((candidate) => candidate.type === "cluster")
      .flatMap((candidate) => candidate.items.map((item) => item.id)),
  );
  const singleCandidates = dailyItems
    .filter((item) => {
      if (item.clusterId || clusteredItemIds.has(item.id)) {
        return false;
      }

      return !getAggregationParentClusterIds(item).some((clusterId) => visibleClusterIds.has(clusterId));
    })
    .map(buildSingleCandidate)
    .filter((candidate) => matchesEventBriefingTag(candidate, options.tag));

  return {
    candidates: [...clusterCandidates, ...singleCandidates],
  };
}
