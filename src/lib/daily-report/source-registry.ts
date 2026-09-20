

import { prisma } from "@/lib/db";
import { type DailyReportCandidate, type DailyReportContent, type DailyReportSourceRegistryEntry } from "@/lib/daily-report/types";
import { getDisplaySummary, getDisplayTitle } from "@/lib/feed/presentation";
import { DISPLAYABLE_DAILY_REPORT_SOURCE_STATUSES, getSectionSourceIds, MAX_DAILY_REPORT_EXPANDED_SOURCES_PER_CANDIDATE } from "@/lib/daily-report/report-input";
import { buildDailyReportSourceKey, normalizeLegacyParsedSourceKey } from "@/lib/daily-report/candidates";


export function candidateToDailyReportSourceRegistryEntry(
  candidate: DailyReportCandidate,
  sourceNumber = candidate.id,
): DailyReportSourceRegistryEntry {
  return {
    sourceNumber,
    sourceKey: buildDailyReportSourceKey(candidate),
    itemId: candidate.itemId,
    clusterId: candidate.clusterId,
    sourceName: candidate.sourceName,
    title: candidate.title,
    url: candidate.url,
    summary: candidate.summary,
    publishedAt: candidate.publishedAt,
    qualityScore: candidate.qualityScore,
    eventType: candidate.eventType,
    eventSubject: candidate.eventSubject,
    eventAction: candidate.eventAction,
    eventObject: candidate.eventObject,
    eventDate: candidate.eventDate,
  };
}

export async function listExpandedClusterSourceRegistryEntries(candidates: DailyReportCandidate[], groupIds: string[] = []) {
  const clusterCandidates = candidates.filter((candidate) => candidate.clusterId);
  const clusterIds = Array.from(new Set(clusterCandidates.map((candidate) => candidate.clusterId!)));

  if (clusterIds.length === 0) {
    return new Map<string, DailyReportSourceRegistryEntry[]>();
  }

  const candidateByClusterId = new Map(clusterCandidates.map((candidate) => [candidate.clusterId!, candidate]));
  const rows = await prisma.item.findMany({
    where: {
      clusterId: { in: clusterIds },
      status: "processed",
      moderationStatus: {
        in: [...DISPLAYABLE_DAILY_REPORT_SOURCE_STATUSES],
      },
      source: {
        is: {
          enabled: true,
          ...(groupIds.length > 0 ? { groupId: { in: groupIds } } : {}),
        },
      },
    },
    select: {
      id: true,
      clusterId: true,
      originalTitle: true,
      translatedTitle: true,
      originalUrl: true,
      summaryText: true,
      rssExcerpt: true,
      fullText: true,
      rssContent: true,
      qualityScore: true,
      publishedAt: true,
      eventType: true,
      eventSubject: true,
      eventAction: true,
      eventObject: true,
      eventDate: true,
      source: {
        select: {
          name: true,
        },
      },
    },
    orderBy: [{ qualityScore: "desc" }, { publishedAt: "desc" }, { createdAt: "desc" }],
  });
  const entriesByClusterId = new Map<string, DailyReportSourceRegistryEntry[]>();

  for (const row of rows) {
    if (!row.clusterId) continue;
    const candidate = candidateByClusterId.get(row.clusterId);
    if (!candidate) continue;
    const entries = entriesByClusterId.get(row.clusterId) ?? [];
    entries.push({
      sourceNumber: candidate.id,
      sourceKey: buildDailyReportSourceKey({ itemId: row.id, clusterId: null, url: row.originalUrl }),
      itemId: row.id,
      clusterId: row.clusterId,
      sourceName: row.source.name,
      title: getDisplayTitle(row.originalTitle, row.translatedTitle),
      url: row.originalUrl,
      summary: getDisplaySummary(row.summaryText, row.rssExcerpt, row.fullText ?? row.rssContent),
      publishedAt: row.publishedAt.toISOString(),
      qualityScore: row.qualityScore,
      eventType: candidate.eventType ?? row.eventType,
      eventSubject: candidate.eventSubject ?? row.eventSubject,
      eventAction: candidate.eventAction ?? row.eventAction,
      eventObject: candidate.eventObject ?? row.eventObject,
      eventDate: candidate.eventDate ?? row.eventDate,
    });
    entriesByClusterId.set(row.clusterId, entries);
  }

  for (const [clusterId, entries] of entriesByClusterId) {
    entriesByClusterId.set(clusterId, entries.slice(0, MAX_DAILY_REPORT_EXPANDED_SOURCES_PER_CANDIDATE));
  }

  return entriesByClusterId;
}

export async function buildExpandedDailyReportSourceRegistry(input: {
  candidatesById: Map<number, DailyReportCandidate>;
  sourceRows: Array<{ sourceId: number }>;
  groupIds?: string[];
}) {
  const selectedCandidates = Array.from(new Set(input.sourceRows.map((row) => row.sourceId)))
    .map((sourceId) => input.candidatesById.get(sourceId))
    .filter((candidate): candidate is DailyReportCandidate => Boolean(candidate));
  const expandedClusterEntries = await listExpandedClusterSourceRegistryEntries(selectedCandidates, input.groupIds ?? []);
  const entriesByNumber = new Map<number, DailyReportSourceRegistryEntry[]>();

  for (const candidate of selectedCandidates) {
    const expandedEntries = candidate.clusterId ? expandedClusterEntries.get(candidate.clusterId) : null;
    entriesByNumber.set(
      candidate.id,
      expandedEntries && expandedEntries.length > 0
        ? expandedEntries
        : [candidateToDailyReportSourceRegistryEntry(candidate)],
    );
  }

  return entriesByNumber;
}

export function countSelectedDailyReportCandidates(content: DailyReportContent) {
  const selectedIds = new Set<number>();

  for (const row of getSectionSourceIds(content)) {
    selectedIds.add(row.sourceId);
  }

  return selectedIds.size;
}

export function getDailyReportContentSourceIds(content: DailyReportContent) {
  return new Set(getSectionSourceIds(content).map((row) => row.sourceId));
}

export function assertDailyReportSourceIdsExist(content: DailyReportContent, registry: DailyReportSourceRegistryEntry[]) {
  const validIds = new Set(registry.map((entry) => entry.sourceNumber));
  const invalidIds = Array.from(getDailyReportContentSourceIds(content)).filter((sourceId) => !validIds.has(sourceId));

  if (invalidIds.length > 0) {
    throw new Error(`日报输出引用了不存在的来源：${invalidIds.join(", ")}`);
  }
}

export function buildDailyReportSourceRegistryFromRows(rows: Array<{
  sourceNumber: number | null;
  sourceKey: string | null;
  itemId: string | null;
  clusterId: string | null;
  sourceName: string;
  title: string;
  url: string;
  sourceSummary: string | null;
  sourcePublishedAt: Date | null;
  sourceQualityScore: number | null;
  eventType: string | null;
  eventSubject: string | null;
  eventAction: string | null;
  eventObject: string | null;
  eventDate: string | null;
}>): DailyReportSourceRegistryEntry[] {
  const entries = new Map<string, DailyReportSourceRegistryEntry>();

  for (const row of rows) {
    if (!row.sourceNumber || row.sourceNumber < 1) {
      continue;
    }

    const entryKey = [
      row.sourceNumber,
      row.itemId ?? row.sourceKey ?? row.url.trim().toLowerCase(),
    ].join("\u0000");
    if (entries.has(entryKey)) {
      continue;
    }

    entries.set(entryKey, {
      sourceNumber: row.sourceNumber,
      sourceKey: normalizeLegacyParsedSourceKey(row.sourceKey) ?? buildDailyReportSourceKey(row),
      itemId: row.itemId,
      clusterId: row.clusterId,
      sourceName: row.sourceName,
      title: row.title,
      url: row.url,
      summary: row.sourceSummary,
      publishedAt: row.sourcePublishedAt?.toISOString() ?? null,
      qualityScore: row.sourceQualityScore,
      eventType: row.eventType,
      eventSubject: row.eventSubject,
      eventAction: row.eventAction,
      eventObject: row.eventObject,
      eventDate: row.eventDate,
    });
  }

  return Array.from(entries.values()).sort((left, right) =>
    left.sourceNumber - right.sourceNumber ||
    (right.publishedAt ?? "").localeCompare(left.publishedAt ?? "") ||
    left.title.localeCompare(right.title)
  );
}

export async function getDailyReportSourceRegistry(dailyReportId: string) {
  const rows = await prisma.dailyReportSource.findMany({
    where: { dailyReportId },
    orderBy: [{ sourceNumber: "asc" }, { createdAt: "asc" }],
  });

  return buildDailyReportSourceRegistryFromRows(rows);
}

export async function countExistingSelectedDailyReportCandidates(dailyReportId: string) {
  const rows = await prisma.dailyReportSource.findMany({
    where: { dailyReportId },
    select: {
      sourceNumber: true,
      itemId: true,
      clusterId: true,
      url: true,
    },
  });

  return new Set(rows.map((row) => row.sourceNumber ?? row.itemId ?? row.clusterId ?? row.url)).size;
}
