import { prisma } from "@/lib/db";
import type {
  EventBriefingCandidate,
  EventBriefingDateRange,
  EventCandidateEntity,
  EventCandidateItem,
  EventCandidateSource,
} from "@/lib/events/types";
import { getDisplaySummary, getDisplayTitle } from "@/lib/feed/presentation";

const DISPLAYABLE_MODERATION_STATUSES = ["allowed", "restored"] as const;

type PublicItemRow = Awaited<ReturnType<typeof listDailyPublicItems>>[number];

type ListEventBriefingCandidateOptions = {
  groupIds?: string[];
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

function buildSourceFilter(groupIds: string[] = []) {
  return {
    source: {
      is: {
        enabled: true,
        ...(groupIds.length > 0 ? { groupId: { in: groupIds } } : {}),
      },
    },
  };
}

async function listDailyPublicItems(range: EventBriefingDateRange, options: ListEventBriefingCandidateOptions = {}) {
  const groupIds = normalizeGroupIds(options.groupIds);

  return prisma.item.findMany({
    where: {
      createdAt: { gte: range.start, lt: range.end },
      status: "processed",
      moderationStatus: { in: [...DISPLAYABLE_MODERATION_STATUSES] },
      isAggregation: false,
      ...buildSourceFilter(groupIds),
      AND: [
        {
          OR: [
            { clusterId: null },
            { cluster: { is: { status: "active" } } },
          ],
        },
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

  return prisma.item.findMany({
    where: {
      clusterId: { in: clusterIds },
      status: "processed",
      moderationStatus: { in: [...DISPLAYABLE_MODERATION_STATUSES] },
      isAggregation: false,
      ...buildSourceFilter(groupIds),
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
): EventBriefingCandidate | null {
  const representative = pickRepresentative(allMembers.length ? allMembers : dailyItems);
  const cluster = representative.cluster;

  if (!cluster) {
    return null;
  }

  if (allMembers.length <= 1) {
    return buildSingleCandidate(representative);
  }

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
      ...parseClusterEntities(cluster.feedEntitiesJson),
      ...allMembers.flatMap(entitiesFromItem),
    ],
    (entity) => entity.normalized.toLowerCase(),
  );
  const latestCreatedAt = allMembers.reduce(
    (latest, item) => item.createdAt.getTime() > latest.getTime() ? item.createdAt : latest,
    representative.createdAt,
  );
  const latestPublishedAt = allMembers.reduce(
    (latest, item) => item.publishedAt.getTime() > latest.getTime() ? item.publishedAt : latest,
    representative.publishedAt,
  );
  const earliestCreatedAt = allMembers.reduce(
    (earliest, item) => item.createdAt.getTime() < earliest.getTime() ? item.createdAt : earliest,
    representative.createdAt,
  );
  const title = cluster.title.trim() || getDisplayTitle(representative.originalTitle, representative.translatedTitle);
  const summary = getDisplaySummary(cluster.summary, representative.summaryText, representative.rssExcerpt ?? representative.fullText);
  const qualityScore = cluster.displayAverageScore || cluster.score || representative.qualityScore;
  const sourceCount = Math.max(cluster.displaySourceCount, sources.length);
  const itemCount = Math.max(cluster.displayItemCount, allMembers.length);
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
    latestCreatedAt: cluster.latestCreatedAt ?? latestCreatedAt,
    latestPublishedAt: cluster.latestPublishedAt ?? latestPublishedAt,
    earliestCreatedAt: cluster.earliestCreatedAt ?? earliestCreatedAt,
    representativeUrl: representative.originalUrl,
    eventType: cluster.eventType ?? representative.eventType,
    eventSubject: cluster.eventSubject ?? representative.eventSubject,
    eventAction: cluster.eventAction ?? representative.eventAction,
    eventObject: cluster.eventObject ?? representative.eventObject,
    eventDate: cluster.eventDate ?? representative.eventDate,
    isFollowUp: (cluster.earliestCreatedAt ?? earliestCreatedAt).getTime() < range.start.getTime(),
    entities,
    sources,
    items,
    searchText: buildSearchText({
      title,
      summary,
      eventType: cluster.eventType ?? representative.eventType,
      eventSubject: cluster.eventSubject ?? representative.eventSubject,
      eventAction: cluster.eventAction ?? representative.eventAction,
      eventObject: cluster.eventObject ?? representative.eventObject,
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
    ))
    .filter((candidate): candidate is EventBriefingCandidate => Boolean(candidate));
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
    .map(buildSingleCandidate);

  return {
    candidates: [...clusterCandidates, ...singleCandidates],
  };
}
