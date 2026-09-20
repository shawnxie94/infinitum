import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { refreshClusterFeedStatsSafely } from "@/lib/clusters/feed-stats";
import { invalidateFeedCache } from "@/lib/feed/cache";
import { generateUniqueGroupColor } from "@/lib/groups/badge";
import { createRssParser } from "@/lib/ingestion/parser";
import {
  buildSiteUrlFromRssUrl,
  getFallbackSourceName,
  type ImportSourcesFromOpmlOptions,
  parseOpmlSources,
  type SourceInput,
  type SourceMetadataOptions,
  shouldEnableAiParsing,
} from "@/lib/settings/core";
import type { OpmlImportSummary, ResolvedSourceMetadata } from "@/lib/settings/types";
import { normalizeKeyword, normalizeText, normalizeUrl } from "@/lib/utils/text";

async function collectClusterIdsForSources(sourceIds: string[]) {
  if (sourceIds.length === 0) {
    return [];
  }

  const rows = await prisma.item.findMany({
    where: {
      sourceId: { in: [...new Set(sourceIds)] },
      clusterId: { not: null },
    },
    select: { clusterId: true },
    distinct: ["clusterId"],
  });

  return rows.map((row) => row.clusterId).filter((clusterId): clusterId is string => Boolean(clusterId));
}

export async function resolveSourceMetadata(
  rssUrl: string,
  options?: SourceMetadataOptions,
): Promise<ResolvedSourceMetadata> {
  const normalizedRssUrl = normalizeUrl(rssUrl);

  if (!normalizedRssUrl) {
    throw new Error("Invalid RSS URL.");
  }

  const parser = options?.parser ?? createRssParser();

  let parsedFeed;

  try {
    parsedFeed = await parser.parseURL(normalizedRssUrl);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Failed to resolve RSS metadata.");
  }

  return {
    name: normalizeText(parsedFeed.title) || getFallbackSourceName(normalizedRssUrl),
    rssUrl: normalizedRssUrl,
    siteUrl: normalizeUrl(parsedFeed.link) ?? buildSiteUrlFromRssUrl(normalizedRssUrl),
    suggestedAiParsingEnabled: shouldEnableAiParsing(parsedFeed.items ?? []),
  };
}

export async function importSourcesFromOpml(
  opmlText: string,
  options?: ImportSourcesFromOpmlOptions,
): Promise<OpmlImportSummary> {
  const parsedSources = parseOpmlSources(opmlText);
  const parser = options?.parser ?? createRssParser();
  const resolveMetadata =
    options?.resolveMetadata ??
    ((rssUrl: string) =>
      resolveSourceMetadata(rssUrl, {
        parser,
      }));
  const existingGroups = await prisma.sourceGroup.findMany();
  const groupIdByName = new Map(existingGroups.map((group) => [group.name, group.id]));
  const usedColors = new Set(existingGroups.map((g) => g.color).filter(Boolean));
  let createdCount = 0;
  let updatedCount = 0;
  const changedSourceIds = new Set<string>();
  const failures: OpmlImportSummary["failures"] = [];

  for (const source of parsedSources) {
    try {
      const metadata = await resolveMetadata(source.rssUrl);
      const groupName = source.groupName ? normalizeText(source.groupName) : "";
      let groupId: string | null = null;

      if (groupName) {
        const existingGroupId = groupIdByName.get(groupName);

        if (existingGroupId) {
          groupId = existingGroupId;
        } else {
          const color = generateUniqueGroupColor(usedColors);
          usedColors.add(color);
          const group = await prisma.sourceGroup.create({
            data: {
              name: groupName,
              color,
            },
          });
          groupIdByName.set(groupName, group.id);
          groupId = group.id;
        }
      }

      const existingSource = await prisma.source.findUnique({
        where: { rssUrl: source.rssUrl },
      });
      const name = source.name || metadata.name;
      const siteUrl = source.siteUrl || metadata.siteUrl;

      const storedSource = await prisma.source.upsert({
        where: { rssUrl: source.rssUrl },
        update: {
          name,
          siteUrl,
          groupId,
          enabled: source.enabled ?? true,
          aiParsingEnabled: source.aiParsingEnabled ?? true,
          aggregationEnabled: source.aggregationEnabled ?? true,
          aggregationDetectionEnabled: source.aggregationDetectionEnabled ?? false,
        },
        create: {
          name,
          rssUrl: source.rssUrl,
          siteUrl,
          groupId,
          enabled: source.enabled ?? true,
          aiParsingEnabled: source.aiParsingEnabled ?? true,
          aggregationEnabled: source.aggregationEnabled ?? true,
          aggregationDetectionEnabled: source.aggregationDetectionEnabled ?? false,
        },
      });

      if (existingSource) {
        updatedCount += 1;
        changedSourceIds.add(storedSource.id);
      } else {
        createdCount += 1;
      }
    } catch (error) {
      failures.push({
        rssUrl: source.rssUrl,
        message: error instanceof Error ? error.message : "Unknown OPML import error.",
      });
    }
  }

  const affectedClusterIds = await collectClusterIdsForSources([...changedSourceIds]);
  await refreshClusterFeedStatsSafely(affectedClusterIds, "import sources from OPML");
  invalidateFeedCache();

  return {
    totalCount: parsedSources.length,
    createdCount,
    updatedCount,
    failedCount: failures.length,
    failures,
  };
}

export async function replaceBlacklistKeywords(keywords: string[]) {
  const normalized = [...new Set(keywords.map(normalizeKeyword).filter(Boolean))];

  await prisma.$transaction([
    prisma.blacklistKeyword.deleteMany(),
    ...(normalized.length > 0
      ? [
          prisma.blacklistKeyword.createMany({
            data: normalized.map((keyword) => ({ keyword })),
          }),
        ]
      : []),
  ]);
}

export async function createSourceGroup(name: string) {
  const nextSortOrder = await getNextSourceGroupSortOrder();
  const existingColors = new Set(
    (await prisma.sourceGroup.findMany({ select: { color: true } }))
      .map((g) => g.color)
      .filter(Boolean),
  );

  const group = await prisma.sourceGroup.create({
    data: {
      name: name.trim(),
      color: generateUniqueGroupColor(existingColors),
      sortOrder: nextSortOrder,
    },
  });
  invalidateFeedCache();
  return group;
}

async function getNextSourceGroupSortOrder() {
  const latest = await prisma.sourceGroup.findFirst({
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });

  return (latest?.sortOrder ?? -1) + 1;
}

export async function renameSourceGroup(id: string, name: string) {
  const group = await prisma.sourceGroup.update({
    where: { id },
    data: {
      name: name.trim(),
    },
  });
  invalidateFeedCache();
  return group;
}

export async function deleteSourceGroup(id: string) {
  const assignedSourceCount = await prisma.source.count({
    where: { groupId: id },
  });

  if (assignedSourceCount > 0) {
    throw new Error("Please move sources out of this group before deleting it.");
  }

  await prisma.sourceGroup.delete({
    where: { id },
  });
  invalidateFeedCache();
}

export async function reorderSourceGroups(groupIds: string[]) {
  const uniqueGroupIds = [...new Set(groupIds)];
  const existingGroups = await prisma.sourceGroup.findMany({
    select: { id: true },
  });
  const existingGroupIds = new Set(existingGroups.map((group) => group.id));

  if (uniqueGroupIds.length !== existingGroups.length || uniqueGroupIds.some((id) => !existingGroupIds.has(id))) {
    throw new Error("Invalid source group order.");
  }

  await prisma.$transaction(
    uniqueGroupIds.map((id, index) =>
      prisma.sourceGroup.update({
        where: { id },
        data: { sortOrder: index },
      }),
    ),
  );
  invalidateFeedCache();

  return prisma.sourceGroup.findMany({
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
}

export async function createSource(input: SourceInput) {
  const existing = await prisma.source.findUnique({
    where: { rssUrl: input.rssUrl },
  });

  if (existing) {
    throw new Error("该 RSS 地址已存在。");
  }

  const source = await prisma.source.create({
    data: {
      name: input.name,
      rssUrl: input.rssUrl,
      siteUrl: input.siteUrl,
      enabled: input.enabled,
      aiParsingEnabled: input.aiParsingEnabled,
      aggregationEnabled: input.aggregationEnabled ?? true,
      aggregationDetectionEnabled: input.aggregationDetectionEnabled ?? false,
      groupId: input.groupId ?? null,
    },
  });
  invalidateFeedCache();
  return source;
}

export async function updateSource(id: string, input: SourceInput) {
  const existing = await prisma.source.findUnique({
    where: { rssUrl: input.rssUrl },
  });

  if (existing && existing.id !== id) {
    throw new Error("该 RSS 地址已被其他源使用。");
  }

  const affectedClusterIds = await collectClusterIdsForSources([id]);
  const source = await prisma.source.update({
    where: { id },
    data: {
      name: input.name,
      rssUrl: input.rssUrl,
      siteUrl: input.siteUrl,
      enabled: input.enabled,
      aiParsingEnabled: input.aiParsingEnabled,
      aggregationEnabled: input.aggregationEnabled ?? true,
      aggregationDetectionEnabled: input.aggregationDetectionEnabled ?? false,
      groupId: input.groupId ?? null,
    },
  });
  await refreshClusterFeedStatsSafely(affectedClusterIds, "update source");
  invalidateFeedCache();
  return source;
}

export async function deleteSource(id: string) {
  const affectedClusterIds = await collectClusterIdsForSources([id]);
  await prisma.source.delete({
    where: { id },
  });
  await refreshClusterFeedStatsSafely(affectedClusterIds, "delete source");
  invalidateFeedCache();
}

export type AdminSourceGroupFilter =
  | { kind: "all" }
  | { kind: "group"; groupId: string }
  | { kind: "ungrouped" };

export type AdminSourceListItem = {
  id: string;
  name: string;
  rssUrl: string;
  siteUrl: string;
  enabled: boolean;
  aiParsingEnabled: boolean;
  aggregationEnabled: boolean;
  aggregationDetectionEnabled: boolean;
  groupId: string | null;
  groupName: string | null;
  lastItemCreatedAt: string | null;
};

export type AdminSourceListResult = {
  sources: AdminSourceListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export async function listSourcesForAdmin(params: {
  page: number;
  pageSize: number;
  search: string;
  enabled: boolean | null;
  group: AdminSourceGroupFilter;
}): Promise<AdminSourceListResult> {
  const where: Prisma.SourceWhereInput = {};

  if (params.enabled !== null) {
    where.enabled = params.enabled;
  }

  if (params.group.kind === "ungrouped") {
    where.groupId = null;
  } else if (params.group.kind === "group") {
    where.groupId = params.group.groupId;
  }

  if (params.search) {
    where.OR = [
      { name: { contains: params.search } },
      { rssUrl: { contains: params.search } },
    ];
  }

  const [sources, total] = await Promise.all([
    prisma.source.findMany({
      where,
      include: { group: true },
      orderBy: [{ name: "asc" }],
      take: params.pageSize,
      skip: (params.page - 1) * params.pageSize,
    }),
    prisma.source.count({ where }),
  ]);

  const latestItemsBySource = await prisma.item.groupBy({
    by: ["sourceId"],
    where: { sourceId: { in: sources.map((source) => source.id) } },
    _max: { createdAt: true },
  });
  const latestItemCreatedAtBySourceId = new Map(
    latestItemsBySource.map((entry) => [entry.sourceId, entry._max.createdAt]),
  );

  return {
    sources: sources.map((source) => ({
      id: source.id,
      name: source.name,
      rssUrl: source.rssUrl,
      siteUrl: source.siteUrl,
      enabled: source.enabled,
      aiParsingEnabled: source.aiParsingEnabled,
      aggregationEnabled: source.aggregationEnabled,
      aggregationDetectionEnabled: source.aggregationDetectionEnabled,
      groupId: source.groupId,
      groupName: source.group?.name ?? null,
      lastItemCreatedAt: latestItemCreatedAtBySourceId.get(source.id)?.toISOString() ?? null,
    })),
    total,
    page: params.page,
    pageSize: params.pageSize,
    totalPages: Math.max(1, Math.ceil(total / params.pageSize)),
  };
}
