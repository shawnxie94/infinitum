import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { normalizeDailyReportContent } from "@/lib/daily-report/content";
import { withDailyReportCache } from "@/lib/daily-report/cache";
import { getDailyReportDateRange } from "@/lib/daily-report/date";
import {
  DAILY_REPORT_TIMEZONE,
  type DailyReportCandidateCoverageDTO,
  type DailyReportCandidateReviewDTO,
  type DailyReportCandidate,
  type DailyReportContent,
  type DailyReportDetailDTO,
  type DailyReportListItemDTO,
} from "@/lib/daily-report/types";
import { stripDailyReportGeneratedLabel } from "@/lib/daily-report/validator";
import { getDisplaySummary, getDisplayTitle } from "@/lib/feed/presentation";

const DISPLAYABLE_MODERATION_STATUSES = ["allowed", "restored"] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const DAILY_REPORT_ARCHIVE_WEEK_COUNT = 53;
const DAILY_REPORT_CANDIDATE_POOL_MULTIPLIER = 4;
const DAILY_REPORT_CANDIDATE_POOL_MAX = 2000;

export type RecentDailyReportSourceSnapshot = {
  date: string;
  sourceNumber: number | null;
  sectionName: string | null;
  topic: string | null;
  sourceKey: string | null;
  itemId: string | null;
  clusterId: string | null;
  url: string;
  eventType: string | null;
  eventSubject: string | null;
  eventAction: string | null;
  eventObject: string | null;
  eventDate: string | null;
  title: string;
  sourceSummary: string | null;
};

function calculateDailyReportCandidateScore(input: { qualityScore: number; sourceCount: number; itemCount: number }) {
  const aiBaseScore = 50 + (input.qualityScore - 50) * 0.3;
  const sourceBoost = Math.min(12, Math.max(0, input.sourceCount - 1) * 4);
  const itemBoost = Math.min(6, Math.floor(Math.log2(Math.max(1, input.itemCount))) * 2);

  return Math.max(0, Math.min(100, Math.round(aiBaseScore + sourceBoost + itemBoost)));
}

export function getDailyReportCandidatePoolLimit(limit: number) {
  return Math.max(limit, Math.min(DAILY_REPORT_CANDIDATE_POOL_MAX, limit * DAILY_REPORT_CANDIDATE_POOL_MULTIPLIER));
}

function addUtcDays(date: string, days: number) {
  const normalized = getDailyReportDateRange(date).date;
  const [year, month, day] = normalized.split("-").map((part) => Number.parseInt(part, 10));
  const value = new Date(Date.UTC(year, month - 1, day));
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

async function getDailyReportCacheVersion(isAdmin: boolean) {
  const latestReport = await prisma.dailyReport.findFirst({
    where: isAdmin
      ? { status: { not: "failed" } }
      : { status: "published" },
    select: {
      id: true,
      updatedAt: true,
      generatedAt: true,
      publishedAt: true,
      status: true,
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
  });

  if (!latestReport) {
    return "no-daily-reports";
  }

  return [
    latestReport.id,
    latestReport.status,
    latestReport.updatedAt.toISOString(),
    latestReport.generatedAt.toISOString(),
    latestReport.publishedAt?.toISOString() ?? "unpublished",
  ].join(":");
}

export async function listDailyReportCandidates(
  date: string,
  limit = 120,
  groupIdsInput: string[] = [],
  options: { returnPool?: boolean } = {},
) {
  const { start, end } = getDailyReportDateRange(date);
  const groupIds = [...new Set(groupIdsInput.filter(Boolean))];
  const poolLimit = getDailyReportCandidatePoolLimit(limit);
  const sourceFilter = {
    source: {
      is: {
        enabled: true,
        ...(groupIds.length > 0 ? { groupId: { in: groupIds } } : {}),
      },
    },
  };

  const itemRows = await prisma.item.findMany({
    take: options.returnPool ? DAILY_REPORT_CANDIDATE_POOL_MAX : poolLimit,
    where: {
      createdAt: { gte: start, lt: end },
      status: "processed",
      moderationStatus: { in: [...DISPLAYABLE_MODERATION_STATUSES] },
      isAggregation: false,
      ...sourceFilter,
      AND: [
        {
          OR: [
            { clusterId: null },
            {
              cluster: {
                is: { status: "active" },
              },
            },
          ],
        },
      ],
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
      createdAt: true,
      publishedAt: true,
      eventType: true,
      eventSubject: true,
      eventAction: true,
      eventObject: true,
      eventDate: true,
      source: { select: { id: true, name: true } },
      cluster: {
        select: {
          id: true,
          title: true,
          summary: true,
          eventType: true,
          eventSubject: true,
          eventAction: true,
          eventObject: true,
          eventDate: true,
        },
      },
    },
    orderBy: [{ qualityScore: "desc" }, { createdAt: "desc" }],
  });

  const rows = [
    ...itemRows.map((item) => ({
      kind: "item" as const,
      id: item.id,
      sourceKey: `item:${item.id}`,
      itemId: item.id,
      clusterId: item.clusterId,
      originalTitle: item.originalTitle,
      translatedTitle: item.translatedTitle,
      originalUrl: item.originalUrl,
      summaryText: item.summaryText,
      rssExcerpt: item.rssExcerpt,
      fullText: item.fullText,
      rssContent: item.rssContent,
      qualityScore: item.qualityScore,
      createdAt: item.createdAt,
      publishedAt: item.publishedAt,
      eventType: item.eventType,
      eventSubject: item.eventSubject,
      eventAction: item.eventAction,
      eventObject: item.eventObject,
      eventDate: item.eventDate,
      source: item.source,
      cluster: item.cluster,
    })),
  ];

  const grouped = new Map<string, {
    representative: (typeof rows)[number];
    qualityScore: number;
    sourceIds: Set<string>;
    itemCount: number;
    latestCreatedAt: Date;
    latestPublishedAt: Date;
  }>();

  for (const item of rows) {
    const groupKey = item.clusterId ? `cluster:${item.clusterId}` : `item:${item.id}`;
    const existing = grouped.get(groupKey);

    if (!existing) {
      grouped.set(groupKey, {
        representative: item,
        qualityScore: item.qualityScore,
        sourceIds: new Set([item.source.id]),
        itemCount: 1,
        latestCreatedAt: item.createdAt,
        latestPublishedAt: item.publishedAt,
      });
      continue;
    }

    existing.sourceIds.add(item.source.id);
    existing.qualityScore = Math.max(existing.qualityScore, item.qualityScore);
    existing.itemCount += 1;
    if (item.createdAt.getTime() > existing.latestCreatedAt.getTime()) {
      existing.latestCreatedAt = item.createdAt;
    }
    if (item.publishedAt.getTime() > existing.latestPublishedAt.getTime()) {
      existing.latestPublishedAt = item.publishedAt;
    }
    if (
      item.qualityScore > existing.representative.qualityScore ||
      (item.qualityScore === existing.representative.qualityScore &&
        item.createdAt.getTime() > existing.representative.createdAt.getTime())
    ) {
      existing.representative = item;
    }
  }

  const ranked = [...grouped.values()]
    .map((entry) => ({
      ...entry,
      score: calculateDailyReportCandidateScore({
        qualityScore: entry.qualityScore,
        sourceCount: entry.sourceIds.size,
        itemCount: entry.itemCount,
      }),
    }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (right.qualityScore !== left.qualityScore) return right.qualityScore - left.qualityScore;
      if (right.latestPublishedAt.getTime() !== left.latestPublishedAt.getTime()) {
        return right.latestPublishedAt.getTime() - left.latestPublishedAt.getTime();
      }
      if (right.latestCreatedAt.getTime() !== left.latestCreatedAt.getTime()) {
        return right.latestCreatedAt.getTime() - left.latestCreatedAt.getTime();
      }
      return right.representative.id.localeCompare(left.representative.id);
    })
    .slice(0, options.returnPool ? poolLimit : limit);

  return ranked.map((entry, index): DailyReportCandidate => {
    const item = entry.representative;
    const cluster = item.cluster;
    const shouldUseClusterDisplay = groupIds.length === 0;

    return {
      id: index + 1,
      sourceKey: item.sourceKey,
      itemId: item.itemId,
      clusterId: item.clusterId,
      title: shouldUseClusterDisplay && cluster ? cluster.title : getDisplayTitle(item.originalTitle, item.translatedTitle),
      itemTitle: getDisplayTitle(item.originalTitle, item.translatedTitle),
      sourceName: item.source.name,
      url: item.originalUrl,
      summary: shouldUseClusterDisplay && cluster
        ? cluster.summary
        : getDisplaySummary(item.summaryText, item.rssExcerpt, item.fullText ?? item.rssContent),
      qualityScore: item.qualityScore,
      candidateScore: entry.score,
      sourceCount: entry.sourceIds.size,
      itemCount: entry.itemCount,
      createdAt: item.createdAt.toISOString(),
      publishedAt: item.publishedAt.toISOString(),
      eventType: shouldUseClusterDisplay ? cluster?.eventType ?? item.eventType : item.eventType ?? cluster?.eventType ?? null,
      eventSubject: shouldUseClusterDisplay ? cluster?.eventSubject ?? item.eventSubject : item.eventSubject ?? cluster?.eventSubject ?? null,
      eventAction: shouldUseClusterDisplay ? cluster?.eventAction ?? item.eventAction : item.eventAction ?? cluster?.eventAction ?? null,
      eventObject: shouldUseClusterDisplay ? cluster?.eventObject ?? item.eventObject : item.eventObject ?? cluster?.eventObject ?? null,
      eventDate: shouldUseClusterDisplay ? cluster?.eventDate ?? item.eventDate : item.eventDate ?? cluster?.eventDate ?? null,
    };
  });
}

export async function listRecentDailyReportSourceSnapshots(
  date: string,
  lookbackDays: number,
): Promise<RecentDailyReportSourceSnapshot[]> {
  const { date: normalizedDate } = getDailyReportDateRange(date);
  const startDate = addUtcDays(normalizedDate, -lookbackDays);

  const rows = await prisma.dailyReportSource.findMany({
    where: {
      dailyReport: {
        date: {
          gte: startDate,
          lt: normalizedDate,
        },
        timezone: DAILY_REPORT_TIMEZONE,
        status: {
          equals: "published",
        },
      },
    },
    orderBy: [
      { dailyReport: { date: "desc" } },
      { sourceNumber: "asc" },
      { title: "asc" },
    ],
    select: {
      sourceNumber: true,
      sectionName: true,
      topic: true,
      sourceKey: true,
      itemId: true,
      clusterId: true,
      url: true,
      eventType: true,
      eventSubject: true,
      eventAction: true,
      eventObject: true,
      eventDate: true,
      title: true,
      sourceSummary: true,
      dailyReport: {
        select: {
          date: true,
        },
      },
    },
  });

  return rows.map((row) => ({
    date: row.dailyReport.date,
    sourceNumber: row.sourceNumber,
    sectionName: row.sectionName,
    topic: row.topic,
    sourceKey: row.sourceKey,
    itemId: row.itemId,
    clusterId: row.clusterId,
    url: row.url,
    eventType: row.eventType,
    eventSubject: row.eventSubject,
    eventAction: row.eventAction,
    eventObject: row.eventObject,
    eventDate: row.eventDate,
    title: row.title,
    sourceSummary: row.sourceSummary,
  }));
}

function parseContent(summaryJson: string): DailyReportContent {
  return normalizeDailyReportContent(JSON.parse(summaryJson));
}

function parseDailyReportCandidateReview(
  candidateSnapshot: string | null,
  selectedCount: number,
): DailyReportCandidateReviewDTO | null {
  if (!candidateSnapshot) {
    return null;
  }

  try {
    const parsed = JSON.parse(candidateSnapshot) as unknown;
    const snapshot = parsed && typeof parsed === "object"
      ? parsed as Record<string, unknown>
      : null;

    if (!snapshot || !Array.isArray(snapshot.candidates)) {
      return null;
    }

    const candidates = snapshot.candidates.filter((candidate): candidate is DailyReportCandidateReviewDTO["candidates"][number] =>
      Boolean(candidate && typeof candidate === "object" && "title" in candidate && "itemTitle" in candidate),
    );
    const excludedRecentDuplicates = Array.isArray(snapshot.excludedRecentDuplicates)
      ? snapshot.excludedRecentDuplicates.filter((candidate): candidate is DailyReportCandidateReviewDTO["excludedRecentDuplicates"][number] =>
          Boolean(candidate && typeof candidate === "object" && "title" in candidate && "itemTitle" in candidate && "excludedReason" in candidate),
        )
      : [];
    const rawCoverage = snapshot.candidateCoverage;
    const candidateCoverage = rawCoverage && typeof rawCoverage === "object"
      ? rawCoverage as Record<string, unknown>
      : null;
    const parsedCoverage: DailyReportCandidateCoverageDTO | null = candidateCoverage &&
        typeof candidateCoverage.candidateCount === "number" &&
        typeof candidateCoverage.selectedCount === "number" &&
        typeof candidateCoverage.topRankPoolCount === "number" &&
        typeof candidateCoverage.selectedTopRankCount === "number" &&
        typeof candidateCoverage.sameDayCandidateCount === "number" &&
        typeof candidateCoverage.selectedSameDayCount === "number" &&
        typeof candidateCoverage.lowRankSelectedCount === "number" &&
        Array.isArray(candidateCoverage.warnings)
      ? {
          candidateCount: candidateCoverage.candidateCount,
          selectedCount: candidateCoverage.selectedCount,
          topRankPoolCount: candidateCoverage.topRankPoolCount,
          selectedTopRankCount: candidateCoverage.selectedTopRankCount,
          sameDayCandidateCount: candidateCoverage.sameDayCandidateCount,
          selectedSameDayCount: candidateCoverage.selectedSameDayCount,
          lowRankSelectedCount: candidateCoverage.lowRankSelectedCount,
          warnings: candidateCoverage.warnings.filter((warning): warning is string => typeof warning === "string"),
        }
      : null;

    return {
      candidateCount: typeof snapshot.candidateCount === "number" ? snapshot.candidateCount : candidates.length,
      selectedCount,
      candidates,
      excludedRecentDuplicates,
      candidateCoverage: parsedCoverage,
    };
  } catch {
    return null;
  }
}

function countDailyReportSourceItems(sources?: Array<{
  sourceNumber: number | null;
  itemId: string | null;
  clusterId: string | null;
  url: string;
}>, fallback = 0) {
  if (!sources) {
    return fallback;
  }

  return new Set(sources.map((source) => source.itemId ?? source.url)).size;
}

function toListItem(report: {
  id: string;
  date: string;
  timezone: string;
  status: "draft" | "published" | "failed";
  title: string;
  openingSummary: string;
  generatedAt: Date;
  publishedAt: Date | null;
  errorMessage: string | null;
  _count?: { sources: number };
  sources?: Array<{
    sourceNumber: number | null;
    itemId: string | null;
    clusterId: string | null;
    url: string;
  }>;
}): DailyReportListItemDTO {
  return {
    id: report.id,
    date: report.date,
    timezone: report.timezone,
    status: report.status,
    title: report.title,
    openingSummary: stripDailyReportGeneratedLabel(report.openingSummary),
    sourceCount: countDailyReportSourceItems(report.sources, report._count?.sources ?? 0),
    generatedAt: report.generatedAt.toISOString(),
    publishedAt: report.publishedAt?.toISOString() ?? null,
    errorMessage: report.errorMessage,
  };
}

export async function listDailyReports(input: {
  isAdmin: boolean;
  status?: "draft" | "published" | "all";
  week?: string | null;
  page?: number;
  pageSize?: number;
}) {
  if (!input.isAdmin) {
    const cacheVersion = await getDailyReportCacheVersion(false);

    return withDailyReportCache(
      `daily:list:${cacheVersion}:${input.status ?? "published"}:${input.week ?? "all"}:${input.page ?? ""}:${input.pageSize ?? ""}`,
      () => listDailyReportsUncached(input),
    );
  }

  return listDailyReportsUncached(input);
}

async function listDailyReportsUncached(input: {
  isAdmin: boolean;
  status?: "draft" | "published" | "all";
  week?: string | null;
  page?: number;
  pageSize?: number;
}) {
  const where = buildDailyReportVisibilityWhere(input);

  const weekRange = getDailyReportArchiveWeekRange(input.week);
  if (weekRange) {
    where.date = {
      gte: weekRange.start,
      lte: weekRange.end,
    };
  }

  const take = input.pageSize;
  const skip = input.page != null && take != null ? (input.page - 1) * take : undefined;

  const [reports, total] = await Promise.all([
    prisma.dailyReport.findMany({
      where,
      include: {
        sources: {
          select: {
            sourceNumber: true,
            itemId: true,
            clusterId: true,
            url: true,
          },
        },
        _count: {
          select: { sources: true },
        },
      },
      orderBy: [{ date: "desc" }, { generatedAt: "desc" }],
      ...(take != null ? { take } : {}),
      ...(skip != null ? { skip } : {}),
    }),
    prisma.dailyReport.count({ where }),
  ]);

  return {
    reports: reports.map(toListItem),
    total,
    ...(input.page != null ? { page: input.page, pageSize: input.pageSize! } : {}),
  };
}

function buildDailyReportVisibilityWhere(input: {
  isAdmin: boolean;
  status?: "draft" | "published" | "all";
}): Prisma.DailyReportWhereInput {
  if (input.isAdmin && input.status && input.status !== "all") {
    return { status: input.status };
  }

  if (input.isAdmin) {
    return { status: { not: "failed" } };
  }

  return { status: "published" };
}

function toDateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function parseDateKey(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!));
}

function startOfShanghaiToday(now = new Date()) {
  const shanghai = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return new Date(Date.UTC(shanghai.getUTCFullYear(), shanghai.getUTCMonth(), shanghai.getUTCDate()));
}

function startOfWeek(date: Date) {
  const day = date.getUTCDay();
  const mondayOffset = day === 0 ? 6 : day - 1;
  return new Date(date.getTime() - mondayOffset * DAY_MS);
}

function formatWeekLabel(start: string, end: string) {
  return `${start.replace(/-/g, "/")} - ${end.replace(/-/g, "/")}`;
}

function getDailyReportArchiveWeekRange(weekKey: string | null | undefined) {
  if (!weekKey || !/^\d{4}-\d{2}-\d{2}$/.test(weekKey)) {
    return null;
  }

  const today = startOfShanghaiToday();
  const lowerBound = new Date(today.getTime() - 365 * DAY_MS);
  const start = parseDateKey(weekKey);
  const end = new Date(start.getTime() + 6 * DAY_MS);

  if (Number.isNaN(start.getTime()) || end < lowerBound || start > today) {
    return null;
  }

  return {
    start: toDateKey(new Date(Math.max(start.getTime(), lowerBound.getTime()))),
    end: toDateKey(new Date(Math.min(end.getTime(), today.getTime()))),
  };
}

export async function listDailyReportArchiveWeeks(input: {
  isAdmin: boolean;
  status?: "draft" | "published" | "all";
}) {
  if (!input.isAdmin) {
    const cacheVersion = await getDailyReportCacheVersion(false);

    return withDailyReportCache(
      `daily:weeks:${cacheVersion}:${input.status ?? "published"}`,
      () => listDailyReportArchiveWeeksUncached(input),
    );
  }

  return listDailyReportArchiveWeeksUncached(input);
}

async function listDailyReportArchiveWeeksUncached(input: {
  isAdmin: boolean;
  status?: "draft" | "published" | "all";
}) {
  const today = startOfShanghaiToday();
  const currentWeekStart = startOfWeek(today);
  const lowerBound = new Date(today.getTime() - 365 * DAY_MS);
  const weeks = Array.from({ length: DAILY_REPORT_ARCHIVE_WEEK_COUNT }, (_, index) => {
    const startDate = new Date(currentWeekStart.getTime() - index * WEEK_MS);
    const endDate = new Date(startDate.getTime() + 6 * DAY_MS);
    const visibleStart = new Date(Math.max(startDate.getTime(), lowerBound.getTime()));
    const visibleEnd = new Date(Math.min(endDate.getTime(), today.getTime()));

    return {
      key: toDateKey(startDate),
      start: toDateKey(visibleStart),
      end: toDateKey(visibleEnd),
      label: formatWeekLabel(toDateKey(visibleStart), toDateKey(visibleEnd)),
    };
  }).filter((week) => week.start <= week.end);

  const reports = await prisma.dailyReport.findMany({
    where: {
      ...buildDailyReportVisibilityWhere(input),
      date: {
        gte: weeks.at(-1)?.start ?? toDateKey(lowerBound),
        lte: toDateKey(today),
      },
    },
    select: { date: true },
  });
  const counts = new Map<string, number>();

  for (const report of reports) {
    const date = parseDateKey(report.date);
    const weekStart = toDateKey(startOfWeek(date));
    counts.set(weekStart, (counts.get(weekStart) ?? 0) + 1);
  }

  return weeks
    .map((week) => ({
      key: week.key,
      label: week.label,
      count: counts.get(week.key) ?? 0,
    }))
    .filter((week) => week.count > 0);
}

export async function getDailyReportByDate(date: string, isAdmin: boolean): Promise<DailyReportDetailDTO | null> {
  if (!isAdmin) {
    const cacheVersion = await getDailyReportCacheVersion(false);

    return withDailyReportCache(`daily:detail:${cacheVersion}:${date}`, () => getDailyReportByDateUncached(date, false));
  }

  return getDailyReportByDateUncached(date, isAdmin);
}

async function getDailyReportByDateUncached(date: string, isAdmin: boolean): Promise<DailyReportDetailDTO | null> {
  const report = await prisma.dailyReport.findUnique({
    where: {
      date_timezone: {
        date,
        timezone: DAILY_REPORT_TIMEZONE,
      },
    },
    include: {
      sources: {
        orderBy: [{ sectionName: "asc" }, { sourceNumber: "asc" }, { sourceName: "asc" }],
      },
      _count: {
        select: { sources: true },
      },
    },
  });

  if (!report || report.status === "failed" || (!isAdmin && report.status !== "published")) {
    return null;
  }

  const [previous, next] = await Promise.all([
    prisma.dailyReport.findFirst({
      where: {
        date: { lt: report.date },
        ...(isAdmin ? { status: { not: "failed" as const } } : { status: "published" as const }),
      },
      orderBy: { date: "desc" },
      select: { date: true, title: true },
    }),
    prisma.dailyReport.findFirst({
      where: {
        date: { gt: report.date },
        ...(isAdmin ? { status: { not: "failed" as const } } : { status: "published" as const }),
      },
      orderBy: { date: "asc" },
      select: { date: true, title: true },
    }),
  ]);

  return {
    ...toListItem(report),
    closingThought: stripDailyReportGeneratedLabel(report.closingThought),
    content: parseContent(report.summaryJson),
    renderedMarkdown: report.renderedMarkdown,
    sources: report.sources.map((source) => ({
      id: source.id,
      sourceNumber: source.sourceNumber,
      sourceSummary: source.sourceSummary,
      sourceQualityScore: source.sourceQualityScore,
      itemId: source.itemId,
      clusterId: source.clusterId,
      sourceName: source.sourceName,
      title: source.title,
      url: source.url,
      sectionName: source.sectionName,
      topic: source.topic,
    })),
    previous,
    next,
    candidateReview: isAdmin
      ? parseDailyReportCandidateReview(report.candidateSnapshot, countDailyReportSourceItems(report.sources, report._count.sources))
      : null,
  };
}
