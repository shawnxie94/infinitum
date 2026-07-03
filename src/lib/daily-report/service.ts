import { createHash } from "node:crypto";

import type { BackgroundTaskRun } from "@prisma/client";

import { createAiProvider, type AiEventSignature } from "@/lib/ai/provider";
import { prisma } from "@/lib/db";
import { getDailyReportDateRange, getTodayDailyReportDate, normalizeDailyReportDate } from "@/lib/daily-report/date";
import { invalidateDailyReportCache } from "@/lib/daily-report/cache";
import {
  getDailyReportClosingThought,
  getDailyReportOpeningSummary,
  getDailyReportSectionBlocks,
} from "@/lib/daily-report/content";
import {
  listDailyReportCandidates,
  listRecentDailyReportSourceSnapshots,
  type RecentDailyReportSourceSnapshot,
} from "@/lib/daily-report/repository";
import { renderDailyReportMarkdown } from "@/lib/daily-report/renderer";
import {
  formatDailyReportTitle,
  normalizeDailyReportHeadline,
} from "@/lib/daily-report/title";
import {
  DAILY_REPORT_TIMEZONE,
  type DailyReportCandidate,
  type DailyReportCandidateSnapshotEntry,
  type DailyReportContent,
  type DailyReportItem,
  type DailyReportSourceRegistryEntry,
  type RecentDailyReportTopic,
} from "@/lib/daily-report/types";
import { parseDailyReportContent } from "@/lib/daily-report/validator";
import { normalizeEventSignatureForStorage } from "@/lib/clusters/normalization";
import { listEventBriefingEntriesForDailyReport } from "@/lib/events/service";
import type { EventBriefingEntryDTO } from "@/lib/events/types";
import { getDisplaySummary, getDisplayTitle } from "@/lib/feed/presentation";
import { getIngestionRuntimeConfig } from "@/lib/settings/runtime-service";
import { DEFAULT_DAILY_REPORT_TASK_LABEL, type TaskTimelineNodeSnapshot } from "@/lib/tasks/types";
import type { TaskAiCallBreakdownSnapshot } from "@/lib/tasks/types";
import { enqueueTaskRun, ensureDefaultDailyReportSchedule, parseDailyReportGroupIdsJson, updateTaskRun } from "@/lib/tasks/service";
import { createTaskAiUsageTracker } from "@/lib/tasks/ai-usage";

const MIN_CANDIDATE_COUNT = 2;
const DAILY_REPORT_RECENT_SOURCE_LOOKBACK_DAYS = 7;
const DAILY_REPORT_RECENT_TOPIC_CONTEXT_LIMIT = 120;
const MAX_DAILY_REPORT_EXPANDED_SOURCES_PER_CANDIDATE = 5;
const DISPLAYABLE_DAILY_REPORT_SOURCE_STATUSES = ["allowed", "restored"] as const;

function getFallbackDailyReportHeadline(content: DailyReportContent) {
  const sectionTitles = getDailyReportSectionBlocks(content)
    .flatMap((section) => section.items.map((item) => item.title))
    .map((title) => normalizeDailyReportHeadline(title))
    .filter(Boolean);
  return normalizeDailyReportHeadline(sectionTitles.slice(0, 3).join("、"));
}

export function buildDailyReportTitle(date: string, content?: DailyReportContent) {
  const headline = content
    ? normalizeDailyReportHeadline(content.headline) || getFallbackDailyReportHeadline(content)
    : "";
  return formatDailyReportTitle(date, headline);
}

function buildInputHash(
  date: string,
  candidates: DailyReportCandidate[],
  groupIds: string[] = [],
  recentTopics: RecentDailyReportTopic[] = [],
) {
  const hash = createHash("sha256");
  hash.update(date);
  hash.update(JSON.stringify([...groupIds].sort()));
  hash.update(JSON.stringify(recentTopics));
  for (const candidate of candidates) {
    hash.update(JSON.stringify({
      sourceKey: candidate.sourceKey,
      itemId: candidate.itemId,
      clusterId: candidate.clusterId,
      title: candidate.title,
      summary: candidate.summary,
      qualityScore: candidate.qualityScore,
      candidateScore: candidate.candidateScore,
      sourceCount: candidate.sourceCount,
      itemCount: candidate.itemCount,
    }));
  }
  return hash.digest("hex");
}

function getSectionSourceIds(content: DailyReportContent) {
  const rows: Array<{ sectionName: string; topic: string; sourceId: number }> = [];

  for (const section of getDailyReportSectionBlocks(content)) {
    for (const item of section.items as DailyReportItem[]) {
      for (const sourceId of item.sourceIds) {
        rows.push({ sectionName: section.title, topic: item.title, sourceId });
      }
    }
  }

  return rows;
}

function buildDailyReportSourceKey(input: {
  sourceKey?: string | null;
  itemId: string | null;
  clusterId: string | null;
  url: string;
}) {
  const sourceKey = input.sourceKey?.trim();
  if (sourceKey) return sourceKey;
  if (input.itemId) return `item:${input.itemId}`;
  if (input.clusterId) return `cluster:${input.clusterId}`;
  return `url:${input.url.trim().toLowerCase()}`;
}

function getLegacyParsedItemId(sourceKey: string | null | undefined) {
  const normalized = sourceKey?.trim() ?? "";
  const prefix = "parsed:";
  if (!normalized.startsWith(prefix) || normalized.length === prefix.length) {
    return null;
  }
  return normalized.slice(prefix.length);
}

function normalizeLegacyParsedSourceKey(sourceKey: string | null | undefined) {
  const legacyParsedItemId = getLegacyParsedItemId(sourceKey);
  return legacyParsedItemId ? `item:${legacyParsedItemId}` : sourceKey?.trim() || null;
}

function compactDailyReportCandidates(candidates: DailyReportCandidate[]) {
  return candidates.map((candidate, index) => ({
    ...candidate,
    id: index + 1,
  }));
}

function eventBriefingEntryToDailyReportCandidate(
  entry: EventBriefingEntryDTO,
  index: number,
): DailyReportCandidate | null {
  const representativeItem = entry.items[0];

  if (!representativeItem) {
    return null;
  }

  return {
    id: index + 1,
    sourceKey: entry.type === "cluster" ? `cluster:${entry.id}` : `item:${entry.id}`,
    itemId: representativeItem.id,
    clusterId: entry.type === "cluster" ? entry.id : null,
    title: entry.title,
    itemTitle: representativeItem.title,
    sourceName: representativeItem.sourceName,
    url: representativeItem.originalUrl,
    summary: entry.summary,
    qualityScore: entry.qualityScore,
    candidateScore: entry.rankScore,
    sourceCount: entry.sourceCount,
    itemCount: entry.itemCount,
    createdAt: entry.latestCreatedAt,
    publishedAt: representativeItem.publishedAt,
    eventType: entry.eventType,
    eventSubject: entry.eventSubject,
    eventAction: entry.eventAction,
    eventObject: entry.eventObject,
    eventDate: entry.eventDate,
  };
}

async function listDailyReportEventBriefingCandidates(date: string, limit: number, groupIds: string[] = []) {
  const entries = await listEventBriefingEntriesForDailyReport({
    date,
    limit,
    groupIds,
  });

  return entries
    .map(eventBriefingEntryToDailyReportCandidate)
    .filter((candidate): candidate is DailyReportCandidate => Boolean(candidate));
}

async function listDailyReportGenerationCandidates(date: string, limit: number, groupIds: string[] = []) {
  try {
    return {
      source: "event_briefing" as const,
      candidates: await listDailyReportEventBriefingCandidates(date, limit, groupIds),
    };
  } catch (error) {
    console.warn("[daily-report] falling back to legacy candidate query", error);
    return {
      source: "legacy_daily_report" as const,
      candidates: await listDailyReportCandidates(date, limit, groupIds),
    };
  }
}

function normalizeOptionalDailyReportText(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized || null;
}

function normalizeDailyReportComparableText(value: string | null | undefined) {
  return value
    ?.normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s·・,，.。:：;；'"“”‘’()[\]（）【】{}<>《》_\-—–/\\|]+/g, "") || null;
}

function buildCharacterBigrams(value: string) {
  if (value.length <= 1) return new Set([value]);
  const grams = new Set<string>();
  for (let index = 0; index < value.length - 1; index += 1) {
    grams.add(value.slice(index, index + 2));
  }
  return grams;
}

function calculateDailyReportTitleSimilarity(left: string, right: string) {
  const normalizedLeft = normalizeDailyReportComparableText(left);
  const normalizedRight = normalizeDailyReportComparableText(right);
  if (!normalizedLeft || !normalizedRight) return 0;
  if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) {
    return 1;
  }

  const leftGrams = buildCharacterBigrams(normalizedLeft);
  const rightGrams = buildCharacterBigrams(normalizedRight);
  const intersectionSize = [...leftGrams].filter((gram) => rightGrams.has(gram)).length;
  const unionSize = new Set([...leftGrams, ...rightGrams]).size;
  return unionSize > 0 ? intersectionSize / unionSize : 0;
}

function isDailyReportFollowUpTitle(title: string) {
  return /后续|新进展|进展|更新|恢复|解除|回归|重新|修复|回应|澄清|正式/.test(title);
}

function getDailyReportEventIdentity(input: {
  eventType: string | null;
  eventSubject: string | null;
  eventAction: string | null;
  eventObject: string | null;
  eventDate: string | null;
}) {
  const normalized = normalizeEventSignatureForStorage({
    eventType: input.eventType as AiEventSignature["eventType"],
    eventSubject: input.eventSubject,
    eventAction: input.eventAction,
    eventObject: input.eventObject,
    eventDate: input.eventDate,
  });

  return {
    eventType: normalizeOptionalDailyReportText(normalized?.eventType),
    eventSubject: normalizeOptionalDailyReportText(normalized?.eventSubject),
    eventAction: normalizeOptionalDailyReportText(normalized?.eventAction),
    eventObject: normalizeOptionalDailyReportText(normalized?.eventObject),
    eventDate: normalizeOptionalDailyReportText(normalized?.eventDate),
  };
}

function matchesRecentDailyReportEvent(
  candidate: DailyReportCandidate,
  recentSource: RecentDailyReportSourceSnapshot,
) {
  const candidateEvent = getDailyReportEventIdentity(candidate);
  const recentEvent = getDailyReportEventIdentity(recentSource);

  if (
    !candidateEvent.eventSubject ||
    !candidateEvent.eventObject ||
    candidateEvent.eventSubject !== recentEvent.eventSubject ||
    candidateEvent.eventObject !== recentEvent.eventObject
  ) {
    return false;
  }

  if (
    candidateEvent.eventDate &&
    recentEvent.eventDate &&
    candidateEvent.eventDate !== recentEvent.eventDate
  ) {
    return false;
  }

  if (candidateEvent.eventAction && recentEvent.eventAction) {
    return candidateEvent.eventAction === recentEvent.eventAction;
  }

  return Boolean(
    candidateEvent.eventType &&
      recentEvent.eventType &&
      candidateEvent.eventType === recentEvent.eventType,
  );
}

function hasSimilarDailyReportEventCore(
  candidate: DailyReportCandidate,
  recentSource: RecentDailyReportSourceSnapshot,
) {
  const candidateSubject = normalizeDailyReportComparableText(candidate.eventSubject);
  const recentSubject = normalizeDailyReportComparableText(recentSource.eventSubject);
  const candidateObject = normalizeDailyReportComparableText(candidate.eventObject);
  const recentObject = normalizeDailyReportComparableText(recentSource.eventObject);
  const titleSimilarity = calculateDailyReportTitleSimilarity(candidate.title, recentSource.title);

  if (candidateSubject && recentSubject && candidateSubject === recentSubject) {
    if (candidateObject && recentObject) {
      return (
        candidateObject === recentObject ||
        candidateObject.includes(recentObject) ||
        recentObject.includes(candidateObject) ||
        titleSimilarity >= 0.52
      );
    }

    return titleSimilarity >= 0.68;
  }

  if (candidateObject && recentObject) {
    return (
      (candidateObject === recentObject ||
        candidateObject.includes(recentObject) ||
        recentObject.includes(candidateObject)) &&
      titleSimilarity >= 0.5
    );
  }

  return titleSimilarity >= 0.72;
}

function matchesRecentDailyReportSoftDuplicate(
  candidate: DailyReportCandidate,
  recentSource: RecentDailyReportSourceSnapshot,
) {
  if (!hasSimilarDailyReportEventCore(candidate, recentSource)) {
    return false;
  }

  const candidateEvent = getDailyReportEventIdentity(candidate);
  const recentEvent = getDailyReportEventIdentity(recentSource);
  const sameAction = Boolean(
    candidateEvent.eventAction &&
      recentEvent.eventAction &&
      candidateEvent.eventAction === recentEvent.eventAction,
  );
  const sameDate = Boolean(
    candidateEvent.eventDate &&
      recentEvent.eventDate &&
      candidateEvent.eventDate === recentEvent.eventDate,
  );
  const missingDate = !candidateEvent.eventDate || !recentEvent.eventDate;
  const titleSimilarity = calculateDailyReportTitleSimilarity(candidate.title, recentSource.title);

  if (isDailyReportFollowUpTitle(candidate.title) && (!sameDate || !sameAction)) {
    return false;
  }

  return sameAction || sameDate || missingDate || titleSimilarity >= 0.62;
}

function matchesRecentDailyReportSource(
  candidate: DailyReportCandidate,
  recentSource: RecentDailyReportSourceSnapshot,
) {
  const candidateSourceKey = buildDailyReportSourceKey(candidate);
  const recentSourceKey = normalizeLegacyParsedSourceKey(recentSource.sourceKey) ?? buildDailyReportSourceKey(recentSource);
  const hasSameItemSourceKey = Boolean(
    candidate.itemId &&
      recentSource.itemId &&
      candidate.itemId === recentSource.itemId &&
      candidateSourceKey === `item:${candidate.itemId}` &&
      (!recentSource.sourceKey || recentSourceKey === `item:${recentSource.itemId}`),
  );

  return Boolean(
    (recentSourceKey && candidateSourceKey === recentSourceKey) ||
      hasSameItemSourceKey ||
      (candidate.clusterId && recentSource.clusterId && candidate.clusterId === recentSource.clusterId) ||
      matchesRecentDailyReportEvent(candidate, recentSource) ||
      matchesRecentDailyReportSoftDuplicate(candidate, recentSource),
  );
}

function filterRecentDailyReportDuplicates(
  candidates: DailyReportCandidate[],
  recentSources: RecentDailyReportSourceSnapshot[],
) {
  if (recentSources.length === 0) {
    return candidates;
  }

  return compactDailyReportCandidates(candidates.filter(
    (candidate) => !recentSources.some((recentSource) => matchesRecentDailyReportSource(candidate, recentSource)),
  ));
}

function toCandidateSnapshotEntry(candidate: DailyReportCandidate): DailyReportCandidateSnapshotEntry {
  return {
    id: candidate.id,
    sourceKey: candidate.sourceKey,
    itemId: candidate.itemId,
    clusterId: candidate.clusterId,
    title: candidate.title,
    itemTitle: candidate.itemTitle,
    sourceName: candidate.sourceName,
    url: candidate.url,
    candidateScore: candidate.candidateScore,
    sourceCount: candidate.sourceCount,
    itemCount: candidate.itemCount,
    eventType: candidate.eventType,
    eventSubject: candidate.eventSubject,
    eventAction: candidate.eventAction,
    eventObject: candidate.eventObject,
    eventDate: candidate.eventDate,
  };
}

function buildDailyReportExcludedRecentDuplicateSnapshots(
  candidates: DailyReportCandidate[],
  recentSources: RecentDailyReportSourceSnapshot[],
) {
  return candidates.flatMap((candidate) => {
    const matchedRecentSource = recentSources.find((recentSource) => matchesRecentDailyReportSource(candidate, recentSource));
    if (!matchedRecentSource) {
      return [];
    }

    return [{
      ...toCandidateSnapshotEntry(candidate),
      excludedReason: "近 7 天日报已覆盖相同或高度相似事件",
      matchedRecentDate: matchedRecentSource.date,
      matchedRecentTitle: matchedRecentSource.topic ?? matchedRecentSource.title,
    }];
  });
}

function buildRecentDailyReportTopics(recentSources: RecentDailyReportSourceSnapshot[]): RecentDailyReportTopic[] {
  const topics = new Map<string, RecentDailyReportTopic>();

  for (const source of recentSources) {
    const key = [
      source.date,
      source.sourceNumber ?? "",
      source.sectionName ?? "",
      source.topic ?? source.title,
      normalizeDailyReportComparableText(source.eventSubject) ?? "",
      normalizeDailyReportComparableText(source.eventObject) ?? "",
    ].join("\u0000");

    if (topics.has(key)) {
      continue;
    }

    topics.set(key, {
      date: source.date,
      sourceNumber: source.sourceNumber,
      sectionName: source.sectionName,
      topic: source.topic,
      title: source.title,
      eventType: source.eventType,
      eventSubject: source.eventSubject,
      eventAction: source.eventAction,
      eventObject: source.eventObject,
      eventDate: source.eventDate,
    });

    if (topics.size >= DAILY_REPORT_RECENT_TOPIC_CONTEXT_LIMIT) {
      break;
    }
  }

  return Array.from(topics.values());
}

function candidateToDailyReportSourceRegistryEntry(
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

async function listExpandedClusterSourceRegistryEntries(candidates: DailyReportCandidate[], groupIds: string[] = []) {
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

async function buildExpandedDailyReportSourceRegistry(input: {
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

function countSelectedDailyReportCandidates(content: DailyReportContent) {
  const selectedIds = new Set<number>();

  for (const row of getSectionSourceIds(content)) {
    selectedIds.add(row.sourceId);
  }

  return selectedIds.size;
}

function getDailyReportContentSourceIds(content: DailyReportContent) {
  return new Set(getSectionSourceIds(content).map((row) => row.sourceId));
}

function assertDailyReportSourceIdsExist(content: DailyReportContent, registry: DailyReportSourceRegistryEntry[]) {
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

async function countExistingSelectedDailyReportCandidates(dailyReportId: string) {
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

function getDailyReportTaskFinishedLabel(status: "succeeded" | "failed" | "skipped") {
  if (status === "failed") return "失败";
  if (status === "skipped") return "已跳过";
  return "已完成";
}

function buildDailyReportTaskTimeline(input: {
  taskRun: BackgroundTaskRun;
  status: "running" | "succeeded" | "failed" | "skipped";
  candidateCount?: number | null;
  selectedCount?: number | null;
  finishedAt?: Date | null;
}): TaskTimelineNodeSnapshot[] {
  const taskStartedAt = input.taskRun.startedAt ?? input.taskRun.createdAt;
  const startedAt = taskStartedAt.toISOString();
  const finishedAt = input.finishedAt?.toISOString() ?? null;
  const durationMs = input.finishedAt ? input.finishedAt.getTime() - taskStartedAt.getTime() : null;

  const generationNode: TaskTimelineNodeSnapshot = {
    key: "daily_report_generate",
    label: "AI 日报生成",
    status: input.status === "running" ? "running" : input.status === "failed" ? "failed" : "succeeded",
    startedAt,
    finishedAt: input.status === "running" ? null : finishedAt,
    durationMs: input.status === "running" ? null : durationMs,
    metrics: [
      { label: "总候选数", value: input.candidateCount ?? 0 },
    ],
  };

  if (input.status === "running") {
    return [generationNode];
  }

  return [
    generationNode,
    {
      key: "task_finished",
      label: getDailyReportTaskFinishedLabel(input.status),
      status: input.status === "failed" ? "failed" : input.status === "skipped" ? "skipped" : "succeeded",
      startedAt: finishedAt,
      finishedAt,
      durationMs: null,
      metrics: [
        { label: "最后入选数", value: input.selectedCount ?? 0 },
      ],
    },
  ];
}

async function markDailyScheduleRunFinished(taskRun: BackgroundTaskRun, status: "succeeded" | "failed" | "partial") {
  if (taskRun.triggerType !== "scheduled") {
    return;
  }

  const schedule = await ensureDefaultDailyReportSchedule();
  const now = new Date();
  await prisma.taskSchedule.update({
    where: { id: schedule.id },
    data: {
      lastRunStartedAt: taskRun.startedAt ?? taskRun.createdAt,
      lastRunFinishedAt: now,
      lastRunStatus: status,
    },
  });
}

export async function enqueueDailyReportGeneration(date: string, triggerType: "manual" | "scheduled" | "admin_action" = "manual") {
  const normalizedDate = normalizeDailyReportDate(date);
  const existingActive = await prisma.backgroundTaskRun.findFirst({
    where: {
      kind: "daily_report_generate",
      entityId: normalizedDate,
      status: {
        in: ["queued", "running"],
      },
    },
  });

  if (existingActive) {
    return existingActive;
  }

  return enqueueTaskRun({
    kind: "daily_report_generate",
    triggerType,
    label: `${DEFAULT_DAILY_REPORT_TASK_LABEL} ${normalizedDate}`,
    entityId: normalizedDate,
  });
}

export async function generateDailyReport(input: {
  date: string;
  taskRunId?: string | null;
  force?: boolean;
  onCandidatesLoaded?: (candidateCount: number) => Promise<void>;
}) {
  const { date } = getDailyReportDateRange(input.date);
  const schedule = await ensureDefaultDailyReportSchedule();
  const dailyReportGroupIds = parseDailyReportGroupIdsJson(schedule.dailyReportGroupIdsJson);
  const recentSources = await listRecentDailyReportSourceSnapshots(date, DAILY_REPORT_RECENT_SOURCE_LOOKBACK_DAYS);
  const recentTopics = buildRecentDailyReportTopics(recentSources);
  const candidateResult = await listDailyReportGenerationCandidates(
    date,
    schedule.dailyReportCandidateLimit,
    dailyReportGroupIds,
  );
  const rawCandidates = candidateResult.candidates;
  const excludedRecentDuplicates = buildDailyReportExcludedRecentDuplicateSnapshots(rawCandidates, recentSources);
  const candidates = filterRecentDailyReportDuplicates(rawCandidates, recentSources);
  await input.onCandidatesLoaded?.(candidates.length);
  const inputHash = buildInputHash(date, candidates, dailyReportGroupIds, recentTopics);
  const existing = await prisma.dailyReport.findUnique({
    where: {
      date_timezone: {
        date,
        timezone: DAILY_REPORT_TIMEZONE,
      },
    },
  });

  if (existing && existing.inputHash === inputHash && !input.force) {
    return {
      report: existing,
      skipped: true,
      reason: "日报输入未变化，已跳过生成。",
      candidateCount: candidates.length,
      selectedCount: await countExistingSelectedDailyReportCandidates(existing.id),
      aiUsage: { actual: 0, estimated: 0, breakdown: [] },
    };
  }

  if (candidates.length < MIN_CANDIDATE_COUNT) {
    return {
      report: null,
      skipped: true,
      reason: `候选内容不足 ${MIN_CANDIDATE_COUNT} 条，已跳过生成。`,
      candidateCount: candidates.length,
      selectedCount: 0,
      aiUsage: { actual: 0, estimated: 0, breakdown: [] },
    };
  }

  const runtimeConfig = await getIngestionRuntimeConfig();
  const baseProvider = createAiProvider(runtimeConfig.modelApi, runtimeConfig.selectedPromptConfigs);
  // Track every AI call made during generation (main call + repair fallback)
  // so the background task run records accurate `aiCallCountActual` / breakdown.
  const aiUsage = createTaskAiUsageTracker(1, "daily_report");
  const provider = aiUsage.wrapProvider(baseProvider);
  const rawOutput = await provider.generateDailyReport({
    date,
    timezone: DAILY_REPORT_TIMEZONE,
    articles: candidates,
    recentTopics,
  });

  if (!rawOutput) {
    throw new Error("模型未返回日报内容。");
  }

  let content: DailyReportContent;
  try {
    content = parseDailyReportContent(rawOutput, candidates.length);
  } catch (error) {
    const repairedOutput = await provider.repairDailyReportJson(rawOutput);
    if (!repairedOutput) {
      throw error;
    }
    content = parseDailyReportContent(repairedOutput, candidates.length);
  }
  assertDailyReportSourceIdsExist(content, candidates.map((candidate) => ({
    sourceNumber: candidate.id,
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
  })));
  const sourceRows = getSectionSourceIds(content);
  const selectedCount = countSelectedDailyReportCandidates(content);
  const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const expandedSourcesByNumber = await buildExpandedDailyReportSourceRegistry({
    candidatesById,
    sourceRows,
    groupIds: dailyReportGroupIds,
  });
  const title = buildDailyReportTitle(date, content);
  const renderedMarkdown = renderDailyReportMarkdown(
    content,
    candidates,
    title,
    Array.from(expandedSourcesByNumber.values()).flat(),
  );
  const candidateSnapshot = JSON.stringify({
    candidateSource: candidateResult.source,
    candidates: candidates.map(toCandidateSnapshotEntry),
    excludedRecentDuplicates,
    candidateCount: candidates.length,
  });
  const shouldAutoPublish = schedule.dailyReportAutoPublish;
  const publishedAt = shouldAutoPublish ? new Date() : null;

  const report = await prisma.$transaction(async (tx) => {
    const saved = await tx.dailyReport.upsert({
      where: {
        date_timezone: {
          date,
          timezone: DAILY_REPORT_TIMEZONE,
        },
      },
      update: {
        status: shouldAutoPublish ? "published" : "draft",
        title,
        openingSummary: getDailyReportOpeningSummary(content),
        closingThought: getDailyReportClosingThought(content),
        summaryJson: JSON.stringify(content),
        renderedMarkdown,
        inputHash,
        modelName: runtimeConfig.modelApi.model,
        taskRunId: input.taskRunId ?? null,
        candidateSnapshot,
        errorMessage: null,
        publishedAt,
        generatedAt: new Date(),
      },
      create: {
        date,
        timezone: DAILY_REPORT_TIMEZONE,
        status: shouldAutoPublish ? "published" : "draft",
        title,
        openingSummary: getDailyReportOpeningSummary(content),
        closingThought: getDailyReportClosingThought(content),
        summaryJson: JSON.stringify(content),
        renderedMarkdown,
        inputHash,
        modelName: runtimeConfig.modelApi.model,
        taskRunId: input.taskRunId ?? null,
        candidateSnapshot,
        publishedAt,
      },
    });

    await tx.dailyReportSource.deleteMany({
      where: { dailyReportId: saved.id },
    });
    await tx.dailyReportSource.createMany({
      data: sourceRows.flatMap((row) => {
        const sources = expandedSourcesByNumber.get(row.sourceId);
        if (!sources) return [];
        return sources.map((source) => ({
          dailyReportId: saved.id,
          sourceNumber: source.sourceNumber,
          sourceKey: source.sourceKey,
          itemId: source.itemId,
          clusterId: source.clusterId,
          sourceName: source.sourceName,
          title: source.title,
          url: source.url,
          sourceSummary: source.summary,
          sourcePublishedAt: source.publishedAt ? new Date(source.publishedAt) : null,
          sourceQualityScore: source.qualityScore,
          eventType: source.eventType,
          eventSubject: source.eventSubject,
          eventAction: source.eventAction,
          eventObject: source.eventObject,
          eventDate: source.eventDate,
          sectionName: row.sectionName,
          topic: row.topic,
        }));
      }),
    });

    return saved;
  });

  invalidateDailyReportCache();

  return {
    report,
    skipped: false,
    reason: null,
    candidateCount: candidates.length,
    selectedCount,
    aiUsage: aiUsage.snapshot(),
  };
}

export async function executeDailyReportTask(taskRun: BackgroundTaskRun) {
  const date = taskRun.entityId && /^\d{4}-\d{2}-\d{2}$/.test(taskRun.entityId)
    ? taskRun.entityId
    : getTodayDailyReportDate();
  let candidateCount = 0;

  try {
    await updateTaskRun(taskRun.id, {
      status: "running",
      progressCurrent: 0,
      progressTotal: 1,
      progressLabel: `正在生成 ${date} AI 日报`,
      taskTimeline: buildDailyReportTaskTimeline({
        taskRun,
        status: "running",
      }),
      aiCallCountEstimated: 1,
      aiCallBreakdown: [
        { key: "daily_report", label: "AI 日报", actual: 0, estimated: 1 } as TaskAiCallBreakdownSnapshot,
      ],
    });

    const result = await generateDailyReport({
      date,
      taskRunId: taskRun.id,
      force: taskRun.triggerType !== "scheduled",
      onCandidatesLoaded: async (loadedCandidateCount) => {
        candidateCount = loadedCandidateCount;
        await updateTaskRun(taskRun.id, {
          taskTimeline: buildDailyReportTaskTimeline({
            taskRun,
            status: "running",
            candidateCount,
          }),
        });
      },
    });

    const finishedAt = new Date();
    const finalAiUsage = result.aiUsage;
    const totalActual = result.skipped ? 0 : finalAiUsage.actual;
    const totalEstimated = finalAiUsage.estimated;
    // Always include the daily_report key so the breakdown is non-empty when
    // the task runs at all, even if the call count is zero.
    const finalBreakdown: TaskAiCallBreakdownSnapshot[] = result.skipped
      ? [{ key: "daily_report", label: "AI 日报", actual: 0, estimated: totalEstimated }]
      : finalAiUsage.breakdown.some((entry) => entry.key === "daily_report")
        ? finalAiUsage.breakdown
        : [{ key: "daily_report", label: "AI 日报", actual: totalActual, estimated: totalEstimated }];
    await updateTaskRun(taskRun.id, {
      status: "succeeded",
      progressCurrent: 1,
      progressTotal: 1,
      progressLabel: result.skipped
        ? result.reason
        : `已生成 ${date} AI 日报${result.report?.status === "published" ? "并发布" : "草稿"}`,
      aiCallCountActual: totalActual,
      aiCallCountEstimated: totalEstimated,
      aiCallBreakdown: finalBreakdown,
      taskTimeline: buildDailyReportTaskTimeline({
        taskRun,
        status: result.skipped ? "skipped" : "succeeded",
        candidateCount: result.candidateCount,
        selectedCount: result.selectedCount,
        finishedAt,
      }),
      finishedAt,
    });
    await markDailyScheduleRunFinished(taskRun, "succeeded");
  } catch (error) {
    const message = error instanceof Error ? error.message : "AI 日报生成失败。";
    const existingReport = await prisma.dailyReport.findUnique({
      where: {
        date_timezone: {
          date,
          timezone: DAILY_REPORT_TIMEZONE,
        },
      },
    });

    if (existingReport) {
      await prisma.dailyReport.update({
        where: { id: existingReport.id },
        data: {
          errorMessage: message,
          taskRunId: taskRun.id,
        },
      });
    }
    invalidateDailyReportCache();
    const finishedAt = new Date();
    await updateTaskRun(taskRun.id, {
      status: "failed",
      progressLabel: message,
      errorSummary: message,
      taskTimeline: buildDailyReportTaskTimeline({
        taskRun,
        status: "failed",
        candidateCount,
        finishedAt,
      }),
      finishedAt,
    });
    await markDailyScheduleRunFinished(taskRun, "failed");

    // 自动重试：检查重试次数是否未达上限
    const schedule = await ensureDefaultDailyReportSchedule();
    const maxRetries = schedule.dailyReportMaxRetries ?? 0;
    if (maxRetries > 0) {
      const existingAttempts = await prisma.backgroundTaskRun.count({
        where: {
          kind: "daily_report_generate",
          entityId: date,
        },
      });
      if (existingAttempts <= maxRetries) {
        await enqueueTaskRun({
          kind: "daily_report_generate",
          triggerType: taskRun.triggerType,
          label: `${DEFAULT_DAILY_REPORT_TASK_LABEL} ${date} (自动重试)`,
          entityId: date,
        });
      }
    }
  }
}

export async function publishDailyReport(date: string) {
  const report = await prisma.dailyReport.update({
    where: {
      date_timezone: {
        date: normalizeDailyReportDate(date),
        timezone: DAILY_REPORT_TIMEZONE,
      },
    },
    data: {
      status: "published",
      publishedAt: new Date(),
    },
  });
  invalidateDailyReportCache();
  return report;
}

export async function unpublishDailyReport(date: string) {
  const report = await prisma.dailyReport.update({
    where: {
      date_timezone: {
        date: normalizeDailyReportDate(date),
        timezone: DAILY_REPORT_TIMEZONE,
      },
    },
    data: {
      status: "draft",
      publishedAt: null,
    },
  });
  invalidateDailyReportCache();
  return report;
}

export async function deleteDailyReport(date: string) {
  const report = await prisma.dailyReport.delete({
    where: {
      date_timezone: {
        date: normalizeDailyReportDate(date),
        timezone: DAILY_REPORT_TIMEZONE,
      },
    },
  });
  invalidateDailyReportCache();
  return report;
}
