import { createHash } from "node:crypto";

import type { BackgroundTaskRun } from "@prisma/client";

import type { RuntimeConfig } from "@/config/runtime";
import {
  createAiProvider,
  type AiEventSignature,
  type DailyReportStageContext,
} from "@/lib/ai/provider";
import { prisma } from "@/lib/db";
import { getDailyReportDateRange, getTodayDailyReportDate, normalizeDailyReportDate } from "@/lib/daily-report/date";
import { invalidateDailyReportCache } from "@/lib/daily-report/cache";
import { withDailyReportLock } from "@/lib/daily-report/history";
import { DailyReportCancellationError, DailyReportGenerationError } from "@/lib/daily-report/errors";
import { getDailyReportSectionBlocks } from "@/lib/daily-report/content";
import { getDailyReportAttemptLimit, isDailyReportContextOverflowError } from "@/lib/daily-report/attempts";
import {
  DailyReportStageLoopError,
  runDailyReportStageLoop,
  type DailyReportStageLoopResult,
} from "@/lib/daily-report/stage-loop";
import {
  listDailyReportCandidates,
  listRecentDailyReportSourceSnapshots,
  type RecentDailyReportSourceSnapshot,
} from "@/lib/daily-report/repository";
import { renderDailyReportMarkdown } from "@/lib/daily-report/renderer";
import { persistDailyReport } from "@/lib/daily-report/persistence";
import {
  formatDailyReportTitle,
  normalizeDailyReportHeadline,
} from "@/lib/daily-report/title";
import {
  DAILY_REPORT_TIMEZONE,
  type DailyReportCandidate,
  type DailyReportCandidateCoverageDTO,
  type DailyReportCandidateSnapshotEntry,
  type DailyReportCandidateAssessment,
  type DailyReportAssessDuplicateSnapshotEntry,
  type DailyReportDraft,
  type DailyReportModelDraft,
  type DailyReportPlan,
  type DailyReportPlanningAudit,
  type DailyReportPlanningCandidate,
  type DailyReportContent,
  type DailyReportItem,
  type DailyReportSourceRegistryEntry,
  type RecentDailyReportTopic,
} from "@/lib/daily-report/types";
import { isDailyReportNotesRepairableViolation } from "@/lib/daily-report/types";
import {
  applyDailyReportRepairPatches,
  buildDailyReportCandidateBriefs,
  buildDailyReportSelectedTopics,
  attachDailyReportTopicSources,
  getDailyReportPlanCandidateIds,
  getDailyReportPlanTopics,
  materializeDailyReportPlan,
  normalizeDailyReportDraftForTemplate,
  omitInvalidOptionalDailyReportTopics,
  orderAndLimitDailyReportPlanWithAudit,
  orderDailyReportDraft,
  splitDailyReportCandidates,
  toDailyReportModelDraft,
  toDailyReportPlanningCandidate,
  validateDailyReportAssessments,
  validateDailyReportDraft,
  validateDailyReportPlan,
  validateDailyReportPlanSectionQuantities,
} from "@/lib/daily-report/planning";
import {
  DEFAULT_DAILY_REPORT_TEMPLATE,
  classifyDailyReportTemplateMigration,
  getDailyReportTemplateSignature,
  normalizeDailyReportTemplateConfig,
  parseDailyReportTemplateJson,
} from "@/lib/daily-report/template";
import { normalizeEventSignatureForStorage } from "@/lib/clusters/normalization";
import { listEventBriefingEntriesForDailyReport, resolveDailyReportChannelSourceGroupIds } from "@/lib/events/service";
import type { EventBriefingEntryDTO, EventBriefingItemDTO } from "@/lib/events/types";
import { getDisplaySummary, getDisplayTitle } from "@/lib/feed/presentation";
import { getIngestionRuntimeConfig } from "@/lib/settings/runtime-service";
import { DEFAULT_DAILY_REPORT_TASK_LABEL, type TaskPipelineCheckpoint } from "@/lib/tasks/types";
import type { TaskAiCallBreakdownSnapshot } from "@/lib/tasks/types";
import { parseTaskPipelineCheckpointJson } from "@/lib/tasks/checkpoint";
import {
  enqueueTaskRun,
  ensureDefaultDailyReportSchedule,
  isTaskRunCancellationRequested,
  parseDailyReportChannelIdsJson,
  TASK_RUN_CANCELLED_LABEL,
  TASK_RUN_CANCELLED_MESSAGE,
  updateTaskRun,
} from "@/lib/tasks/service";
import { createTaskAiUsageTracker } from "@/lib/tasks/ai-usage";
import {
  buildDailyReportTaskTimeline,
  normalizeDailyReportTimelineStage,
  type DailyReportPipelineStage,
} from "@/lib/daily-report/timeline";
import { getDailyReportRecoveryStages } from "@/lib/daily-report/recovery";
import { DEFAULT_DAILY_REPORT_RECENT_TOPIC_LOOKBACK_DAYS } from "@/lib/tasks/scheduler";

const MIN_CANDIDATE_COUNT = 2;
const DAILY_REPORT_RECENT_TOPIC_CONTEXT_LIMIT = 120;
const MAX_DAILY_REPORT_EXPANDED_SOURCES_PER_CANDIDATE = 5;
const MAX_DAILY_REPORT_EVIDENCE_ITEMS_PER_CANDIDATE = 3;
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
  channelIds: string[] = [],
  recentTopics: RecentDailyReportTopic[] = [],
  generationSignature = "legacy",
) {
  const hash = createHash("sha256");
  hash.update(date);
  hash.update(JSON.stringify([...channelIds].sort()));
  hash.update(JSON.stringify(recentTopics));
  hash.update(generationSignature);
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
      isFollowUp: candidate.isFollowUp ?? false,
      newItemCountOnDate: candidate.newItemCountOnDate ?? 0,
      newSourceCountOnDate: candidate.newSourceCountOnDate ?? 0,
      evidenceItems: candidate.evidenceItems ?? [],
    }));
  }
  return hash.digest("hex");
}

function buildDailyReportGenerationSignature(input: {
  runtimeConfig: RuntimeConfig;
  templateSignature: string;
  planningBatchSize: number | null;
  recentTopicLookbackDays: number;
}) {
  const prompt = input.runtimeConfig.selectedPromptConfigs?.dailyReport;
  const modelApi = prompt?.modelApi ?? input.runtimeConfig.modelApi;
  return createHash("sha256")
    .update(JSON.stringify({
      pipelineVersion: "daily-report-topic-first-v2",
      templateSignature: input.templateSignature,
      planningBatchSize: input.planningBatchSize,
      recentTopicLookbackDays: input.recentTopicLookbackDays,
      modelApi: {
        baseURL: modelApi.baseURL,
        model: modelApi.model,
        apiKeyConfigured: Boolean(modelApi.apiKey),
        customHeaderNames: Object.keys(modelApi.customHeaders ?? {}).sort(),
      },
      prompt: prompt
        ? {
            temperature: prompt.temperature ?? null,
            maxTokens: prompt.maxTokens ?? null,
            topP: prompt.topP ?? null,
          }
        : null,
    }))
    .digest("hex");
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

export function deduplicateDailyReportContentByCandidate(
  content: DailyReportContent,
  candidates: DailyReportCandidate[],
  options: { refillEmptySections?: boolean } = {},
) {
  const refillEmptySections = options.refillEmptySections !== false;
  const identityBySourceId = new Map(
    candidates.map((candidate) => [candidate.id, buildDailyReportContentDuplicateIdentities(candidate)]),
  );
  const seenIdentityOwner = new Map<string, string>();
  const emptySectionTitles: string[] = [];
  const refilledSectionTitles: string[] = [];
  const removedEmptySectionTitles: string[] = [];
  let changed = false;

  const blocks: DailyReportContent["blocks"] = [];
  for (const block of content.blocks) {
    if (block.type !== "section") {
      blocks.push(block);
      continue;
    }

    const items: DailyReportItem[] = [];
    for (const [itemIndex, item] of block.items.entries()) {
      const itemOwner = item.topicId ?? `${block.blockKey ?? block.title}:${itemIndex}`;
      const sourceIds = item.sourceIds.filter((sourceId) => {
        const identities = identityBySourceId.get(sourceId) ?? new Set([`source:${sourceId}`]);
        // PLAN has already established the final topic boundary. Do not
        // collapse two different topic items merely because their candidates
        // share an upstream event identity; source IDs remain distinct
        // evidence inside their selected topic.
        if (item.topicId) {
          for (const identity of identities) {
            seenIdentityOwner.set(identity, itemOwner);
          }
          return true;
        }
        if ([...identities].some((identity) => {
          const owner = seenIdentityOwner.get(identity);
          return owner !== undefined && owner !== itemOwner;
        })) {
          changed = true;
          return false;
        }
        for (const identity of identities) {
          seenIdentityOwner.set(identity, itemOwner);
        }
        return true;
      });

      if (sourceIds.length === 0) {
        changed = true;
        continue;
      }

      items.push({ ...item, sourceIds });
    }

    if (items.length === 0) {
      emptySectionTitles.push(block.title);
      const fallbackCandidate = refillEmptySections
        ? candidates.find((candidate) => {
            const identities = identityBySourceId.get(candidate.id);
            return identities && ![...identities].some((identity) => seenIdentityOwner.has(identity));
          })
        : null;
      if (fallbackCandidate) {
        const identities = identityBySourceId.get(fallbackCandidate.id);
        if (identities) {
          for (const identity of identities) {
            seenIdentityOwner.set(identity, `${block.blockKey ?? block.title}:fallback`);
          }
        }
        items.push({
          title: fallbackCandidate.title,
          body: fallbackCandidate.summary || fallbackCandidate.itemTitle || fallbackCandidate.title,
          sourceIds: [fallbackCandidate.id],
        });
        refilledSectionTitles.push(block.title);
      } else {
        removedEmptySectionTitles.push(block.title);
        changed = true;
        continue;
      }
      changed = true;
    }

    blocks.push({ ...block, items });
  }

  if (blocks.every((block) => block.type !== "section" || block.items.length === 0)) {
    throw new Error("日报去重后没有可用栏目内容。");
  }

  return {
    content: changed ? { ...content, blocks } : content,
    emptySectionTitles,
    refilledSectionTitles,
    removedEmptySectionTitles,
  };
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

function toDailyReportEvidenceItem(item: EventBriefingItemDTO) {
  return {
    title: item.title,
    sourceName: item.sourceName,
    summary: item.summary,
    url: item.originalUrl,
    publishedAt: item.publishedAt,
    createdAt: item.createdAt,
    qualityScore: item.qualityScore,
    publishedAtKnown: item.publishedAtKnown,
  };
}

function getDailyReportEntryItems(entry: EventBriefingEntryDTO, date: string) {
  const { start, end } = getDailyReportDateRange(date);
  const dailyItems = entry.items
    .filter((item) => {
      const createdAt = new Date(item.createdAt);
      return !Number.isNaN(createdAt.getTime()) && createdAt >= start && createdAt < end;
    })
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  const evidenceItems = (dailyItems.length > 0 ? dailyItems : entry.items)
    .slice(0, MAX_DAILY_REPORT_EVIDENCE_ITEMS_PER_CANDIDATE);

  return {
    representativeItem: evidenceItems[0] ?? entry.items[0],
    evidenceItems,
  };
}

function eventBriefingEntryToDailyReportCandidate(
  entry: EventBriefingEntryDTO,
  index: number,
  date: string,
): DailyReportCandidate | null {
  const { representativeItem, evidenceItems } = getDailyReportEntryItems(entry, date);

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
    createdAt: representativeItem.createdAt,
    publishedAt: representativeItem.publishedAt,
    publishedAtKnown: representativeItem.publishedAtKnown,
    eventType: entry.eventType,
    eventSubject: entry.eventSubject,
    eventAction: entry.eventAction,
    eventObject: entry.eventObject,
    eventDate: entry.eventDate,
    isFollowUp: entry.isFollowUp,
    newItemCountOnDate: entry.newItemCountOnDate,
    newSourceCountOnDate: entry.newSourceCountOnDate,
    evidenceItems: evidenceItems.map(toDailyReportEvidenceItem),
  };
}

async function listDailyReportEventBriefingCandidates(date: string, channelIds: string[] = []) {
  const entries = await listEventBriefingEntriesForDailyReport({
    date,
    channelIds,
  });

  return entries
    .map((entry, index) => eventBriefingEntryToDailyReportCandidate(entry, index, date))
    .filter((candidate): candidate is DailyReportCandidate => Boolean(candidate));
}

function buildDailyReportCandidateIdentity(candidate: DailyReportCandidate) {
  if (candidate.clusterId) {
    return `cluster:${candidate.clusterId}`;
  }

  const event = getDailyReportEventIdentity(candidate);
  if (event.eventSubject && event.eventObject) {
    return [
      "event",
      event.eventType ?? "",
      event.eventSubject,
      event.eventAction ?? "",
      event.eventObject,
      event.eventDate ?? "",
    ].join(":");
  }

  return candidate.itemId ? `item:${candidate.itemId}` : `url:${candidate.url.trim().toLowerCase()}`;
}

function buildDailyReportContentDuplicateIdentities(candidate: DailyReportCandidate) {
  const identities = new Set<string>();
  const sourceKey = normalizeOptionalDailyReportText(buildDailyReportSourceKey(candidate));
  if (sourceKey) {
    identities.add(`source:${sourceKey}`);
  }
  if (candidate.itemId) {
    identities.add(`item:${candidate.itemId}`);
  }
  if (candidate.clusterId) {
    identities.add(`cluster:${candidate.clusterId}`);
  }

  const event = getDailyReportEventIdentity(candidate);
  if (event.eventSubject && event.eventObject) {
    identities.add(`event:${event.eventSubject}:${event.eventObject}`);
  }

  if (identities.size === 0) {
    identities.add(`source:${candidate.id}`);
  }

  return identities;
}

export function buildDailyReportCandidateCoverage(
  content: DailyReportContent,
  candidates: DailyReportCandidate[],
): DailyReportCandidateCoverageDTO {
  const selectedIds = new Set(getSectionSourceIds(content).map((row) => row.sourceId));
  const rankedCandidates = [...candidates].sort((left, right) => (
    right.candidateScore - left.candidateScore || left.id - right.id
  ));
  const topRankPoolCount = rankedCandidates.length > 0
    ? Math.max(1, Math.ceil(rankedCandidates.length * 0.5))
    : 0;
  const topRankIds = new Set(rankedCandidates.slice(0, topRankPoolCount).map((candidate) => candidate.id));
  const sameDayIds = new Set(
    candidates
      .filter((candidate) => (candidate.newItemCountOnDate ?? 0) > 0 || (candidate.newSourceCountOnDate ?? 0) > 0)
      .map((candidate) => candidate.id),
  );
  const selectedCandidates = candidates.filter((candidate) => selectedIds.has(candidate.id));
  const selectedTopRankCount = selectedCandidates.filter((candidate) => topRankIds.has(candidate.id)).length;
  const selectedSameDayCount = selectedCandidates.filter((candidate) => sameDayIds.has(candidate.id)).length;
  const warnings: string[] = [];

  if (selectedCandidates.length > 0 && topRankPoolCount > 0 && selectedTopRankCount === 0) {
    warnings.push("selected_candidates_only_low_rank");
  }
  if (sameDayIds.size > 0 && selectedSameDayCount === 0) {
    warnings.push("selected_candidates_miss_same_day_updates");
  }

  return {
    candidateCount: candidates.length,
    selectedCount: selectedCandidates.length,
    topRankPoolCount,
    selectedTopRankCount,
    sameDayCandidateCount: sameDayIds.size,
    selectedSameDayCount,
    lowRankSelectedCount: selectedCandidates.filter((candidate) => !topRankIds.has(candidate.id)).length,
    warnings,
  };
}

function deduplicateDailyReportCandidates(candidates: DailyReportCandidate[]) {
  const seen = new Set<string>();
  const unique: DailyReportCandidate[] = [];
  const duplicates: DailyReportCandidate[] = [];

  for (const candidate of candidates) {
    const identity = buildDailyReportCandidateIdentity(candidate);
    if (seen.has(identity)) {
      duplicates.push(candidate);
      continue;
    }
    seen.add(identity);
    unique.push(candidate);
  }

  return { candidates: unique, duplicates };
}

async function listDailyReportGenerationCandidates(
  date: string,
  limit: number,
  channelIds: string[] = [],
  fallbackGroupIds: string[] = [],
) {
  try {
    return {
      source: "event_briefing" as const,
      candidates: await listDailyReportEventBriefingCandidates(date, channelIds),
    };
  } catch (error) {
    console.warn("[daily-report] falling back to legacy candidate query", error);
    return {
      source: "legacy_daily_report" as const,
      candidates: await listDailyReportCandidates(date, limit, fallbackGroupIds, { returnPool: true }),
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
  const sameCluster = Boolean(candidate.clusterId && recentSource.clusterId && candidate.clusterId === recentSource.clusterId);
  const isMeaningfulFollowUp = Boolean(
    sameCluster &&
      candidate.isFollowUp &&
      ((candidate.newItemCountOnDate ?? 0) > 0 || (candidate.newSourceCountOnDate ?? 0) > 0),
  );

  if (isMeaningfulFollowUp) {
    return false;
  }

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
      sameCluster ||
      matchesRecentDailyReportEvent(candidate, recentSource) ||
      matchesRecentDailyReportSoftDuplicate(candidate, recentSource),
  );
}

function filterRecentDailyReportDuplicates(
  candidates: DailyReportCandidate[],
  recentSources: RecentDailyReportSourceSnapshot[],
  limit = candidates.length,
) {
  const normalizedLimit = Number.isInteger(limit) && limit > 0 ? limit : candidates.length;

  if (recentSources.length === 0) {
    return compactDailyReportCandidates(candidates.slice(0, normalizedLimit));
  }

  return compactDailyReportCandidates(candidates.filter(
    (candidate) => !recentSources.some((recentSource) => matchesRecentDailyReportSource(candidate, recentSource)),
  ).slice(0, normalizedLimit));
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
    publishedAtKnown: candidate.publishedAtKnown ?? true,
    isFollowUp: candidate.isFollowUp ?? false,
    newItemCountOnDate: candidate.newItemCountOnDate ?? 0,
    newSourceCountOnDate: candidate.newSourceCountOnDate ?? 0,
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

function buildDailyReportExcludedAssessDuplicateSnapshots(
  candidates: DailyReportCandidate[],
  assessments: DailyReportCandidateAssessment[],
): DailyReportAssessDuplicateSnapshotEntry[] {
  const assessmentById = new Map(
    assessments
      .filter((assessment) => assessment.historyDecision === "duplicate")
      .map((assessment) => [assessment.candidateId, assessment]),
  );

  return candidates.flatMap((candidate) => {
    const assessment = assessmentById.get(candidate.id);
    if (!assessment) {
      return [];
    }

    return [{
      ...toCandidateSnapshotEntry(candidate),
      relevanceScore: assessment.relevanceScore,
      suggestedBlockKey: assessment.suggestedBlockKey,
      historyDecision: "duplicate" as const,
      matchedRecentTopicTitle: assessment.matchedRecentTopicTitle,
      excludedReason: "ASSESS 判定为历史重复",
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

async function markDailyScheduleRunFinished(taskRun: BackgroundTaskRun, status: "succeeded" | "failed" | "partial" | "cancelled") {
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

async function generateDailyReportInternal(input: {
  date: string;
  taskRunId?: string | null;
  force?: boolean;
  onCandidatesLoaded?: (candidateCount: number) => Promise<void>;
  onStageUpdate?: (stage: DailyReportPipelineStage) => Promise<void>;
  onCheckpoint?: (checkpoint: TaskPipelineCheckpoint) => Promise<void>;
  resumeCheckpoint?: TaskPipelineCheckpoint | null;
}) {
  const { date } = getDailyReportDateRange(input.date);
  const schedule = await ensureDefaultDailyReportSchedule();
  const dailyReportChannelIds = parseDailyReportChannelIdsJson(schedule.dailyReportChannelIdsJson);
  const dailyReportSourceGroupIds = await resolveDailyReportChannelSourceGroupIds(dailyReportChannelIds);
  const recentTopicLookbackDays = schedule.dailyReportRecentTopicLookbackDays ?? DEFAULT_DAILY_REPORT_RECENT_TOPIC_LOOKBACK_DAYS;
  const recentSources = await listRecentDailyReportSourceSnapshots(date, recentTopicLookbackDays);
  const recentTopics = buildRecentDailyReportTopics(recentSources);
  const candidateResult = await listDailyReportGenerationCandidates(
    date,
    schedule.dailyReportCandidateLimit,
    dailyReportChannelIds,
    dailyReportSourceGroupIds,
  );
  const deduplicated = deduplicateDailyReportCandidates(candidateResult.candidates);
  const rawCandidates = deduplicated.candidates;
  const excludedRecentDuplicates = buildDailyReportExcludedRecentDuplicateSnapshots(rawCandidates, recentSources);
  const candidates = filterRecentDailyReportDuplicates(rawCandidates, recentSources, schedule.dailyReportCandidateLimit);
  await input.onCandidatesLoaded?.(candidates.length);
  await input.onStageUpdate?.("prepare");
  const runtimeConfig = await getIngestionRuntimeConfig();
  let template;
  const templateJson = runtimeConfig.selectedPromptConfigs?.dailyReport.templateJson;
  if (!templateJson) {
    template = normalizeDailyReportTemplateConfig(DEFAULT_DAILY_REPORT_TEMPLATE);
  } else {
    try {
      template = parseDailyReportTemplateJson(templateJson);
    } catch (error) {
      let migrationStatus: ReturnType<typeof classifyDailyReportTemplateMigration> = "invalid";
      try {
        migrationStatus = classifyDailyReportTemplateMigration(
          JSON.parse(templateJson) as unknown,
          runtimeConfig.selectedPromptConfigs?.dailyReport.systemPrompt,
        );
      } catch {
        // Keep the original parse error for invalid JSON.
      }
      if (migrationStatus === "custom_legacy_requires_migration") {
        throw new Error("日报模板仍是旧版 opening/sections/closing 结构，请先在 Admin 中迁移为模板 v2。", { cause: error });
      }
      throw error;
    }
  }
  if (!template) throw new Error("日报模板未配置。");
  const templateSignature = getDailyReportTemplateSignature(template);
  const generationSignature = buildDailyReportGenerationSignature({
    runtimeConfig,
    templateSignature,
    planningBatchSize: schedule.dailyReportPlanningBatchSize ?? null,
    recentTopicLookbackDays,
  });
  const inputHash = buildInputHash(date, candidates, dailyReportChannelIds, recentTopics, generationSignature);
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
      planningCandidateCount: 0,
      mergedTopicCount: 0,
      planSectionCount: 0,
      planTopicCount: 0,
      planSelectedCount: 0,
      planViolationCount: 0,
      repairCount: 0,
      writeRetryCount: 0,
      partial: false,
      omittedTopicIds: [],
      historyFilteredCount: 0,
      batchCount: 0,
      batchSize: schedule.dailyReportPlanningBatchSize ?? null,
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
      planningCandidateCount: 0,
      mergedTopicCount: 0,
      planSectionCount: 0,
      planTopicCount: 0,
      planSelectedCount: 0,
      planViolationCount: 0,
      repairCount: 0,
      writeRetryCount: 0,
      partial: false,
      omittedTopicIds: [],
      historyFilteredCount: 0,
      batchCount: 0,
      batchSize: schedule.dailyReportPlanningBatchSize ?? null,
      aiUsage: { actual: 0, estimated: 0, breakdown: [] },
    };
  }

  const baseProvider = createAiProvider(runtimeConfig.modelApi, runtimeConfig.selectedPromptConfigs);
  // Track every AI call made during generation (main call + repair fallback)
  // so the background task run records accurate `aiCallCountActual` / breakdown.
  const aiUsage = createTaskAiUsageTracker(0, "daily_report");
  const provider = aiUsage.wrapProvider(baseProvider);
  let content: DailyReportContent;
  let finalizationPlan: DailyReportPlan | null = null;
  let finalizationSelectedCandidates: DailyReportPlanningCandidate[] = [];
  let finalizationTemplate: ReturnType<typeof normalizeDailyReportTemplateConfig> | null = null;
  finalizationTemplate = template;
  let planningBatchCount = 0;
  let planningCandidateCount = 0;
  let mergedTopicCount = 0;
  let planSectionCount = 0;
  let planTopicCount = 0;
  let planSelectedCount = 0;
  let planViolationCount = 0;
  let repairCount = 0;
  let writeRetryCount = 0;
  let historyFilteredCount = 0;
  let validationViolationCount = 0;
  let partial = false;
  let omittedTopicIds = new Set<string>();
  let latestCheckpoint: TaskPipelineCheckpoint | null = input.resumeCheckpoint ?? null;
  const stageAttempts: Record<string, number> = { ...(input.resumeCheckpoint?.stageAttempts ?? {}) };
  let currentStage: DailyReportPipelineStage = "prepare";
  let currentBatchIndex: number | null = null;
  let currentAttemptKey = "PREPARE";
  let currentStageContext: DailyReportStageContext | null = null;
  let latestPlanAttempt: DailyReportPlan | null = null;
  let latestPlanViolations: ReturnType<typeof validateDailyReportPlan> | null = null;
  let latestPlanningAudit: DailyReportPlanningAudit | null = null;
  let planOverflowFeedbackUsed = false;
  const buildFailureCheckpoint = (error: unknown) => {
    if (!latestCheckpoint) return null;
    const contextOverflow = isDailyReportContextOverflowError(error);
    const matrixStage = currentAttemptKey.startsWith("ASSESS.") ? "ASSESS" : currentAttemptKey;
    const maxAttempts = getDailyReportAttemptLimit(matrixStage);
    const currentAttempt = stageAttempts[currentAttemptKey] ?? 0;
    const assessmentBatches = latestCheckpoint.assessmentBatches?.map((batch) =>
      currentBatchIndex === batch.index
        ? { ...batch, status: "failed" as const, attempt: currentAttempt, error: error instanceof Error ? error.message : String(error) }
        : batch,
    );
    const planFailureContext = currentStage === "plan" || currentStage === "plan_validate"
      ? {
          ...(latestPlanAttempt ? { plan: latestPlanAttempt } : {}),
          ...(latestPlanningAudit ? { planningAudit: latestPlanningAudit } : {}),
          ...(latestPlanViolations ? { violations: latestPlanViolations } : {}),
        }
      : {};
    return {
      ...latestCheckpoint,
      stage: currentStage,
      failedStage: currentStage,
      failureCode: contextOverflow ? "context_overflow" : "stage_failed",
      resumeEligible: !contextOverflow && currentAttempt < maxAttempts,
      stageAttempts: { ...stageAttempts },
      ...(currentStageContext ? { stageLoop: currentStageContext } : latestCheckpoint.stageLoop ? { stageLoop: latestCheckpoint.stageLoop } : {}),
      ...(assessmentBatches ? { assessmentBatches } : {}),
      ...planFailureContext,
      data: {
        ...(latestCheckpoint.data ?? {}),
        writeRetryCount,
      },
    } satisfies TaskPipelineCheckpoint;
  };
  const buildCancellationCheckpoint = () => {
    if (!latestCheckpoint) return null;
    const assessmentBatches = latestCheckpoint.assessmentBatches?.map((batch) =>
      currentBatchIndex === batch.index && batch.status !== "succeeded"
        ? { ...batch, status: "failed" as const, error: TASK_RUN_CANCELLED_MESSAGE }
        : batch,
    );
    return {
      ...latestCheckpoint,
      stage: currentStage,
      failedStage: currentStage,
      failureCode: "cancelled",
      resumeEligible: true,
      stageAttempts: { ...stageAttempts },
      ...(currentStageContext ? { stageLoop: currentStageContext } : latestCheckpoint.stageLoop ? { stageLoop: latestCheckpoint.stageLoop } : {}),
      ...(assessmentBatches ? { assessmentBatches } : {}),
      data: {
        ...(latestCheckpoint.data ?? {}),
        writeRetryCount,
      },
    } satisfies TaskPipelineCheckpoint;
  };
  const throwIfCancellationRequested = async () => {
    if (input.taskRunId && await isTaskRunCancellationRequested(input.taskRunId)) {
      throw new DailyReportCancellationError(aiUsage.snapshot(), buildCancellationCheckpoint());
    }
  };
  const saveCheckpoint = async (checkpoint: TaskPipelineCheckpoint) => {
    const resumeFrom = checkpoint.resumeFrom ?? latestCheckpoint?.resumeFrom;
    const checkpointWithRecovery = resumeFrom
      ? {
          ...checkpoint,
          resumeFrom,
          data: {
            ...(checkpoint.data ?? {}),
            manualRetryFrom: resumeFrom,
          },
        }
      : checkpoint;
    latestCheckpoint = checkpointWithRecovery;
    await input.onCheckpoint?.(checkpointWithRecovery);
    await throwIfCancellationRequested();
  };
  const persistStageLoopContext = async (context: DailyReportStageContext) => {
    currentStageContext = context;
    currentStage = context.stage;
    currentAttemptKey = context.stage.toUpperCase();
    stageAttempts[currentAttemptKey] = context.cleanRetryAttempt + 1;
    if (!latestCheckpoint) return;
    await saveCheckpoint({
      ...latestCheckpoint,
      stage: context.stage,
      failedStage: null,
      failureCode: null,
      resumeEligible: true,
      stageAttempts: { ...stageAttempts },
      stageLoop: context,
      data: {
        ...(latestCheckpoint.data ?? {}),
        [`${context.stage}RepairRound`]: context.repairRound,
        [`${context.stage}CleanRetryCount`]: context.cleanRetryAttempt,
        ...(context.contextOverflow ? { contextOverflowStage: context.stage } : {}),
      },
    });
  };
  const runStageWithAttempts = async <T>(
    stage: DailyReportPipelineStage,
    operation: (attempt: number) => Promise<T>,
    options: { attemptKey?: string; matrixStage?: string } = {},
  ) => {
    const matrixStage = options.matrixStage ?? stage.toUpperCase();
    const attemptKey = options.attemptKey ?? matrixStage;
    const maxAttempts = getDailyReportAttemptLimit(matrixStage);
    let lastError: unknown = null;
    const firstAttempt = (stageAttempts[attemptKey] ?? 0) + 1;
    currentStage = stage;
    currentAttemptKey = attemptKey;
    for (let attempt = firstAttempt; attempt <= maxAttempts; attempt += 1) {
      stageAttempts[attemptKey] = attempt;
      try {
        await throwIfCancellationRequested();
        const result = await operation(attempt);
        await throwIfCancellationRequested();
        return result;
      } catch (error) {
        if (error instanceof DailyReportCancellationError) throw error;
        await throwIfCancellationRequested();
        lastError = error;
        if (isDailyReportContextOverflowError(error) || attempt === maxAttempts) break;
        console.warn(`[daily-report] ${stage} attempt ${attempt} failed; retrying same input`, error);
      }
    }
    const stageError = lastError instanceof Error ? lastError : new Error(`${stage} 阶段失败。`);
    throw new DailyReportGenerationError(stageError, aiUsage.snapshot(), buildFailureCheckpoint(stageError));
  };
  const assessments: DailyReportCandidateAssessment[] = [];
  try {
    const planningCandidates = candidates.map(toDailyReportPlanningCandidate);
    const batchSize = schedule.dailyReportPlanningBatchSize ?? null;
    const batches = splitDailyReportCandidates(planningCandidates, batchSize);
    planningBatchCount = batches.length;
    const candidateSnapshotHash = createHash("sha256").update(JSON.stringify(candidates.map(toCandidateSnapshotEntry))).digest("hex");
    const checkpoint = input.resumeCheckpoint;
    const canResume = Boolean(
      checkpoint?.resumeEligible &&
      checkpoint.inputHash === inputHash &&
      checkpoint.candidateSnapshotHash === candidateSnapshotHash &&
      checkpoint.templateSignature === templateSignature &&
      checkpoint.pipelineVersion === "daily-report-topic-first-v2",
    );
    if (input.resumeCheckpoint && !canResume) {
      throw new DailyReportGenerationError(
        new Error("日报输入、模板或 Pipeline 版本已变化，旧 checkpoint 不可继续执行，请重新生成。"),
        aiUsage.snapshot(),
        {
          ...input.resumeCheckpoint,
          stage: "prepare",
          failedStage: "prepare",
          failureCode: "checkpoint_mismatch",
          resumeEligible: false,
        },
      );
    }
    await saveCheckpoint({
      version: 1,
      pipelineVersion: "daily-report-topic-first-v2",
      stage: "prepare",
      completedStages: canResume ? checkpoint?.completedStages ?? ["prepare"] : ["prepare"],
      lastCompletedStage: "prepare",
      failedStage: null,
      failureCode: null,
      resumeAttempt: checkpoint?.resumeAttempt ?? 0,
      stageAttempts: { ...stageAttempts },
      inputHash,
      templateSignature,
      candidateSnapshotHash,
      candidateSnapshot: candidates.map(toCandidateSnapshotEntry),
      resumeEligible: true,
      data: { batchCount: batches.length, batchSize },
      ...(canResume && checkpoint?.assessmentBatches
        ? { assessmentBatches: checkpoint.assessmentBatches }
        : { assessmentBatches: batches.map((batch, index) => ({ index, candidateIds: batch.map((candidate) => candidate.id), status: "pending" as const, attempt: 0 })) }),
      ...(canResume && checkpoint?.ledger ? { ledger: checkpoint.ledger } : {}),
      ...(canResume && checkpoint?.planningAudit ? { planningAudit: checkpoint.planningAudit } : {}),
      ...(canResume && checkpoint?.planningCandidateBriefs ? { planningCandidateBriefs: checkpoint.planningCandidateBriefs } : {}),
      ...(canResume && checkpoint?.plan ? { plan: checkpoint.plan } : {}),
      ...(canResume && checkpoint?.draft ? { draft: checkpoint.draft } : {}),
    });
    await input.onStageUpdate?.("assess");
    const getHistoryFilteredCount = () => assessments.filter(
      (assessment) => assessment.historyDecision === "duplicate",
    ).length;
    for (const [batchIndex, batch] of batches.entries()) {
      const checkpointBatch = canResume ? checkpoint?.assessmentBatches?.find((entry) => entry.index === batchIndex && entry.status === "succeeded") : null;
      currentBatchIndex = batchIndex;
      const batchAssessments = checkpointBatch?.assessments
        ? validateDailyReportAssessments(batch, checkpointBatch.assessments)
        : validateDailyReportAssessments(
            batch,
            (await runDailyReportStageLoop({
              stage: "assess",
              inputHash: `${candidateSnapshotHash}:assess:${batchIndex}`,
              run: (stageContext, validationFeedback) => provider.assessDailyReportCandidates({
                candidates: batch,
                template,
                recentTopics,
                recentTopicLookbackDays,
                stageContext,
                validationFeedback,
              }),
              validate: (value) => {
                try {
                  validateDailyReportAssessments(batch, value);
                  return [];
                } catch (error) {
                  return [{
                    code: "assess_output_invalid",
                    stage: "assess" as const,
                    message: error instanceof Error ? error.message : String(error),
                  }];
                }
              },
              onContextUpdate: async (context) => {
                stageAttempts[`ASSESS.batch.${batchIndex}`] = context.cleanRetryAttempt + 1;
                await persistStageLoopContext(context);
              },
            })).value,
          );
      currentStageContext = null;
      assessments.push(...batchAssessments);
      historyFilteredCount = getHistoryFilteredCount();
      await saveCheckpoint({
        version: 1,
        pipelineVersion: "daily-report-topic-first-v2",
        stage: "assess",
        completedStages: ["prepare", "assess"],
        lastCompletedStage: "assess",
        failedStage: null,
        failureCode: null,
        resumeAttempt: checkpoint?.resumeAttempt ?? 0,
        stageAttempts: { ...stageAttempts },
        inputHash,
        templateSignature: getDailyReportTemplateSignature(template),
        candidateSnapshotHash,
        candidateSnapshot: candidates.map(toCandidateSnapshotEntry),
        resumeEligible: true,
        assessmentBatches: batches.map((currentBatch, index) => ({
          index,
          candidateIds: currentBatch.map((candidate) => candidate.id),
          status: index < batches.indexOf(batch) + 1 ? "succeeded" : "pending",
          attempt: index < batches.indexOf(batch) + 1 ? stageAttempts[`ASSESS.batch.${index}`] ?? 1 : 0,
          ...(index <= batchIndex
            ? { assessments: assessments.filter((assessment) => currentBatch.some((candidate) => candidate.id === assessment.candidateId)) }
            : {}),
        })),
        data: {
          batchCount: batches.length,
          batchSize,
          assessedCount: assessments.length,
          historyFilteredCount: getHistoryFilteredCount(),
        },
      });
    }
    currentBatchIndex = null;
    await input.onStageUpdate?.("merge");
    const ledger = {
      schemaVersion: 1 as const,
      candidateCount: planningCandidates.length,
      assessedCount: assessments.length,
      unassessedCandidateIds: planningCandidates
        .map((candidate) => candidate.id)
        .filter((candidateId) => !assessments.some((assessment) => assessment.candidateId === candidateId)),
      excludedCandidateIds: assessments
        .filter((assessment) => !assessment.isWorthReading)
        .map((assessment) => assessment.candidateId),
      historyFilteredCandidateIds: assessments
        .filter((assessment) => assessment.historyDecision === "duplicate")
        .map((assessment) => assessment.candidateId),
      historyFilteredCount: getHistoryFilteredCount(),
      assessments: assessments.filter((assessment) => assessment.isWorthReading),
      batchCount: batches.length,
      recentTopics,
    };
    const candidateBriefs = canResume && Array.isArray(checkpoint?.planningCandidateBriefs)
      ? checkpoint.planningCandidateBriefs as Awaited<ReturnType<typeof buildDailyReportCandidateBriefs>>
      : buildDailyReportCandidateBriefs(planningCandidates, assessments);
    planningCandidateCount = candidateBriefs.length;
    await saveCheckpoint({
      version: 1,
      pipelineVersion: "daily-report-topic-first-v2",
      stage: "merge",
      completedStages: ["prepare", "assess", "merge"],
      lastCompletedStage: "merge",
      failedStage: null,
      failureCode: null,
      resumeAttempt: checkpoint?.resumeAttempt ?? 0,
      stageAttempts: { ...stageAttempts },
      inputHash,
      templateSignature: getDailyReportTemplateSignature(template),
      candidateSnapshotHash,
      candidateSnapshot: candidates.map(toCandidateSnapshotEntry),
      resumeEligible: true,
      assessmentBatches: batches.map((batch, index) => ({
        index,
        candidateIds: batch.map((candidate) => candidate.id),
        status: "succeeded" as const,
        attempt: stageAttempts[`ASSESS.batch.${index}`] ?? 1,
        assessments: assessments.filter((assessment) => batch.some((candidate) => candidate.id === assessment.candidateId)),
      })),
      data: {
        batchCount: batches.length,
        batchSize,
        assessedCount: assessments.length,
        historyFilteredCount: getHistoryFilteredCount(),
      },
      ledger,
      planningCandidateBriefs: candidateBriefs,
    });
    await input.onStageUpdate?.("plan");
    const hasCompletedPlan = Boolean(
      canResume
      && checkpoint?.plan
      && (checkpoint.completedStages.includes("plan") || checkpoint.completedStages.includes("plan_validate")),
    );
    let plan: DailyReportPlan;
    if (hasCompletedPlan) {
      plan = checkpoint!.plan as DailyReportPlan;
      latestPlanningAudit = checkpoint?.planningAudit as DailyReportPlanningAudit | null ?? null;
    } else {
      const planLoop = await runDailyReportStageLoop({
        stage: "plan",
        inputHash: `${inputHash}:plan`,
        run: (stageContext, validationFeedback) => provider.planDailyReport({
          candidateBriefs,
          template,
          recentTopics,
          recentTopicLookbackDays,
          stageContext,
          validationFeedback,
        }),
        validate: (rawSelection) => {
          const rawPlan = materializeDailyReportPlan(rawSelection);
          const rawQuantityViolations = validateDailyReportPlanSectionQuantities(rawPlan, template);
          const ordered = orderAndLimitDailyReportPlanWithAudit(
            rawPlan,
            template,
            planningCandidates,
            assessments,
          );
          const violations = validateDailyReportPlan(ordered.plan, planningCandidates, assessments, template);
          const overflowFeedback = rawQuantityViolations.length > 0 && !planOverflowFeedbackUsed
            ? rawQuantityViolations
            : [];
          if (rawQuantityViolations.length > 0) planOverflowFeedbackUsed = true;
          latestPlanAttempt = ordered.plan;
          latestPlanningAudit = ordered.audit;
          latestPlanViolations = [...overflowFeedback, ...violations];
          return latestPlanViolations;
        },
        // The model cannot repair a shortage of eligible candidates: the
        // missing inputs do not exist in the PLAN context. Keep the single
        // clean retry as a fresh-model attempt, but do not spend same-context
        // repair rounds on an impossible minimum-count violation.
        isRepairable: (violations) => !violations.some(
          (violation) => violation.code === "insufficient_required_candidates",
        ),
        onContextUpdate: persistStageLoopContext,
      });
      plan = latestPlanAttempt ?? materializeDailyReportPlan(planLoop.value);
      currentStageContext = null;
    }
    const planViolations = validateDailyReportPlan(plan, planningCandidates, assessments, template);
    planSectionCount = plan.sections.length;
    planTopicCount = getDailyReportPlanTopics(plan).length;
    planSelectedCount = getDailyReportPlanCandidateIds(plan).length;
    mergedTopicCount = getDailyReportPlanTopics(plan).length;
    planViolationCount = planViolations.length;
    if (planViolations.length > 0) {
      throw new Error(`PLAN 校验失败：${planViolations.map((violation) => violation.message).slice(0, 5).join("；")}`);
    }
    await saveCheckpoint({
      version: 1,
      pipelineVersion: "daily-report-topic-first-v2",
      stage: "plan",
      completedStages: ["prepare", "assess", "merge", "plan", "plan_validate"],
      lastCompletedStage: "plan",
      failedStage: null,
      failureCode: null,
      resumeAttempt: checkpoint?.resumeAttempt ?? 0,
      stageAttempts: { ...stageAttempts },
      inputHash,
      templateSignature: getDailyReportTemplateSignature(template),
      candidateSnapshotHash,
      candidateSnapshot: candidates.map(toCandidateSnapshotEntry),
      resumeEligible: true,
      data: {
        batchCount: batches.length,
        batchSize,
        assessedCount: assessments.length,
        historyFilteredCount: getHistoryFilteredCount(),
      },
      assessmentBatches: batches.map((batch, index) => ({
        index,
        candidateIds: batch.map((candidate) => candidate.id),
        status: "succeeded" as const,
        attempt: stageAttempts[`ASSESS.batch.${index}`] ?? 1,
        assessments: assessments.filter((assessment) => batch.some((candidate) => candidate.id === assessment.candidateId)),
      })),
      ledger,
      planningCandidateBriefs: candidateBriefs,
      plan,
      ...(latestPlanningAudit ? { planningAudit: latestPlanningAudit } : {}),
      violations: [],
    });
    const selectedIds = new Set(getDailyReportPlanCandidateIds(plan));
    const selectedCandidates = planningCandidates.filter((candidate) => selectedIds.has(candidate.id));
    const selectedTopics = buildDailyReportSelectedTopics(plan, planningCandidates, assessments);
    finalizationPlan = plan;
    finalizationSelectedCandidates = selectedCandidates;
    await input.onStageUpdate?.("write");
    let modelDraft: DailyReportModelDraft | null = null;
    let draft: DailyReportDraft | null = null;
    let draftViolations: ReturnType<typeof validateDailyReportDraft> = [];
    let latestModelDraftForLoop: DailyReportModelDraft | null = null;
    let latestDraftForLoop: DailyReportDraft | null = null;
    let writeLoop: DailyReportStageLoopResult<DailyReportModelDraft> | null = null;
    let writeLoopFailedWithDraft = false;
    let notePatchRepairCount = 0;
    try {
      writeLoop = canResume && checkpoint?.draft
        ? null
        : await runDailyReportStageLoop({
          stage: "write",
          inputHash: `${inputHash}:write`,
          run: (stageContext, validationFeedback) => provider.writeDailyReport({
            selectedTopics,
            template,
            stageContext,
            validationFeedback,
          }),
          validate: (nextModelDraft) => {
            latestModelDraftForLoop = nextModelDraft;
            latestDraftForLoop = normalizeDailyReportDraftForTemplate(
              orderDailyReportDraft(attachDailyReportTopicSources(nextModelDraft, plan), plan, template),
              template,
            );
            const violations = validateDailyReportDraft(latestDraftForLoop, plan, selectedCandidates, template);
            draftViolations = violations;
            validationViolationCount = violations.length;
            return violations;
          },
          stopOnValidation: (violations) => violations.length > 0 && violations.every(isDailyReportNotesRepairableViolation),
          onContextUpdate: async (context) => {
            repairCount = context.repairRound;
            writeRetryCount = context.cleanRetryAttempt;
            await persistStageLoopContext(context);
          },
          });
    } catch (error) {
      if (!(error instanceof DailyReportStageLoopError) || error.stage !== "write" || !latestModelDraftForLoop || !latestDraftForLoop) {
        throw error;
      }
      writeRetryCount = error.cleanRetryCount;
      repairCount = error.context.repairRound;
      currentStageContext = error.context;
      writeLoopFailedWithDraft = true;
      modelDraft = latestModelDraftForLoop;
      draft = latestDraftForLoop;
      draftViolations = validateDailyReportDraft(draft, plan, selectedCandidates, template, omittedTopicIds);
    }

    if (writeLoop) {
      modelDraft = writeLoop.value;
      draft = latestDraftForLoop ?? normalizeDailyReportDraftForTemplate(
        orderDailyReportDraft(attachDailyReportTopicSources(modelDraft, plan), plan, template),
        template,
      );
      draftViolations = validateDailyReportDraft(draft, plan, selectedCandidates, template, omittedTopicIds);
    } else if (!writeLoopFailedWithDraft) {
      modelDraft = toDailyReportModelDraft(checkpoint!.draft as DailyReportModelDraft);
      draft = normalizeDailyReportDraftForTemplate(
        orderDailyReportDraft(attachDailyReportTopicSources(modelDraft, plan), plan, template),
        template,
      );
      draftViolations = validateDailyReportDraft(draft, plan, selectedCandidates, template, omittedTopicIds);
    }
    if (!modelDraft || !draft) {
      throw new Error("WRITE 阶段未生成可校验的日报草稿。");
    }
    validationViolationCount = draftViolations.length;
    const nonRepairableDraftViolations = draftViolations.filter(
      (violation) => !isDailyReportNotesRepairableViolation(violation),
    );
    if (draftViolations.length > 0 && nonRepairableDraftViolations.length === 0) {
      let repairViolations = draftViolations.filter(isDailyReportNotesRepairableViolation);
      while (repairViolations.length > 0 && notePatchRepairCount < 2) {
        notePatchRepairCount += 1;
        repairCount += 1;
        await input.onStageUpdate?.("repair");
        let patchResult;
        try {
          patchResult = await runStageWithAttempts(
            "repair",
            async () => provider.repairDailyReportDraft({
              draft: toDailyReportModelDraft(draft!),
              violations: repairViolations,
              selectedTopics,
              template,
            }),
            {
              attemptKey: `REPAIR.round.${notePatchRepairCount}`,
              matrixStage: "REPAIR",
            },
          );
        } catch {
          break;
        }
        draft = normalizeDailyReportDraftForTemplate(
          orderDailyReportDraft(
            applyDailyReportRepairPatches(draft, patchResult) as DailyReportDraft,
            plan,
            template,
          ),
          template,
        );
        modelDraft = toDailyReportModelDraft(draft);
        draftViolations = validateDailyReportDraft(draft, plan, selectedCandidates, template, omittedTopicIds);
        repairViolations = draftViolations.filter(isDailyReportNotesRepairableViolation);
        validationViolationCount = draftViolations.length;
        if (latestCheckpoint) {
          await saveCheckpoint({
            ...latestCheckpoint,
            stage: "repair",
            completedStages: draftViolations.length > 0
              ? [...new Set([...latestCheckpoint.completedStages, "write", "repair"])]
              : [...new Set([...latestCheckpoint.completedStages, "write", "validate", "repair"])],
            lastCompletedStage: "repair",
            failedStage: null,
            failureCode: null,
            resumeEligible: draftViolations.length === 0,
            stageAttempts: { ...stageAttempts },
            draft: modelDraft,
            violations: draftViolations,
            data: {
              ...(latestCheckpoint.data ?? {}),
              writeRepairRound: repairCount,
              omittedTopicIds: Array.from(omittedTopicIds),
              omittedTopicCount: omittedTopicIds.size,
            },
          });
        }
      }
    }
    if (draftViolations.length > 0) {
      const fallback = omitInvalidOptionalDailyReportTopics(draft, draftViolations, template, omittedTopicIds);
      omittedTopicIds = fallback.omittedTopicIds;
      if (omittedTopicIds.size > 0) {
        partial = true;
        draft = normalizeDailyReportDraftForTemplate(
          orderDailyReportDraft(fallback.draft as DailyReportDraft, plan, template),
          template,
        );
        modelDraft = toDailyReportModelDraft(draft);
        draftViolations = validateDailyReportDraft(draft, plan, selectedCandidates, template, omittedTopicIds);
        validationViolationCount = draftViolations.length;
      }
    }
    if (latestCheckpoint) {
      await saveCheckpoint({
        ...latestCheckpoint,
        stage: "write",
        completedStages: draftViolations.length > 0
          ? [...new Set([...latestCheckpoint.completedStages, "write"])]
          : [...new Set([...latestCheckpoint.completedStages, "write", "validate"])],
        lastCompletedStage: draftViolations.length > 0 ? "write" : "validate",
        failedStage: null,
        failureCode: null,
        resumeEligible: draftViolations.length === 0,
        stageAttempts: { ...stageAttempts },
        stageLoop: undefined,
        draft: modelDraft,
        violations: draftViolations,
        data: {
          ...(latestCheckpoint.data ?? {}),
          writeRetryCount,
          writeRepairRound: repairCount,
          omittedTopicIds: Array.from(omittedTopicIds),
          omittedTopicCount: omittedTopicIds.size,
        },
      });
    }
    if (draftViolations.length === 0) {
      currentStageContext = null;
    }
    if (draftViolations.length > 0) {
      throw new Error(`WRITE 校验失败：${draftViolations.map((violation) => violation.message).slice(0, 5).join("；")}`);
    }
    content = draft;
  } catch (error) {
    if (error instanceof DailyReportGenerationError || error instanceof DailyReportCancellationError) throw error;
    throw new DailyReportGenerationError(error, aiUsage.snapshot(), buildFailureCheckpoint(error));
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
  let deduplication: ReturnType<typeof deduplicateDailyReportContentByCandidate>;
  try {
    deduplication = deduplicateDailyReportContentByCandidate(content, finalizationSelectedCandidates, { refillEmptySections: false });
    if (finalizationPlan && finalizationTemplate) {
      currentStage = "validate";
      currentAttemptKey = "VALIDATE";
      const finalViolations = validateDailyReportDraft(
        deduplication.content,
        finalizationPlan,
        finalizationSelectedCandidates,
        finalizationTemplate,
        omittedTopicIds,
      );
      validationViolationCount = finalViolations.length;
      if (finalViolations.length > 0) {
        latestCheckpoint = latestCheckpoint
          ? {
              ...latestCheckpoint,
              stage: "validate",
              failedStage: "validate",
              failureCode: "stage_failed",
              resumeEligible: false,
              violations: finalViolations,
            }
          : latestCheckpoint;
        throw new Error(`日报最终校验失败：${finalViolations.map((violation) => violation.message).slice(0, 5).join("；")}`);
      }
    }
  } catch (error) {
    if (error instanceof DailyReportGenerationError || error instanceof DailyReportCancellationError) throw error;
    throw new DailyReportGenerationError(error, aiUsage.snapshot(), buildFailureCheckpoint(error));
  }
  content = deduplication.content;
  const sourceRows = getSectionSourceIds(content);
  const candidateCoverage = buildDailyReportCandidateCoverage(content, candidates);
  if (candidateCoverage.warnings.length > 0) {
    console.warn("[daily-report] candidate coverage warnings:", candidateCoverage.warnings.join(", "));
  }
  const selectedCount = countSelectedDailyReportCandidates(content);
  const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const excludedAssessDuplicates = buildDailyReportExcludedAssessDuplicateSnapshots(candidates, assessments);
  const expandedSourcesByNumber = await buildExpandedDailyReportSourceRegistry({
    candidatesById,
    sourceRows,
    groupIds: dailyReportSourceGroupIds,
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
    excludedCurrentDuplicates: deduplicated.duplicates.map((candidate) => ({
      ...toCandidateSnapshotEntry(candidate),
      excludedReason: "当前候选集合内重复",
      matchedRecentDate: null,
      matchedRecentTitle: null,
    })),
    excludedRecentDuplicates,
    excludedAssessDuplicates,
    emptySectionsAfterDeduplication: deduplication.emptySectionTitles,
    refilledEmptySections: deduplication.refilledSectionTitles,
    removedEmptySections: deduplication.removedEmptySectionTitles,
    omittedRepairTopics: Array.from(omittedTopicIds),
    candidateCoverage,
    candidateCount: candidates.length,
  });
  const shouldAutoPublish = schedule.dailyReportAutoPublish && !partial;
  const publishedAt = shouldAutoPublish ? new Date() : null;
  const persistIdempotencyKey = `generated:${input.taskRunId ?? `direct-${Date.now()}`}:${inputHash}`;

  await throwIfCancellationRequested();
  await input.onStageUpdate?.("persist_publish");
  const report = await runStageWithAttempts("persist_publish", async () => persistDailyReport({
    date,
    existing,
    taskRunId: input.taskRunId,
    content,
    title,
    renderedMarkdown,
    inputHash,
    candidateSnapshot,
    modelName: runtimeConfig.modelApi.model,
    templateSignature,
    sourceRows,
    expandedSourcesByNumber,
    shouldAutoPublish,
    publishedAt,
    idempotencyKey: persistIdempotencyKey,
    aiUsage: aiUsage.snapshot(),
    buildCancellationCheckpoint,
  }), { matrixStage: "PERSIST_PUBLISH" });

  invalidateDailyReportCache();

  return {
    report,
    skipped: false,
    reason: null,
    candidateCount: candidates.length,
    selectedCount,
    planningCandidateCount,
    batchCount: planningBatchCount,
    mergedTopicCount,
    planSectionCount,
    planTopicCount,
    planSelectedCount,
    planViolationCount,
    repairCount,
    writeRetryCount,
    partial,
    omittedTopicIds: Array.from(omittedTopicIds),
    historyFilteredCount,
    validationViolationCount,
    batchSize: schedule.dailyReportPlanningBatchSize ?? null,
    aiUsage: aiUsage.snapshot(),
  };
}

export async function generateDailyReport(input: {
  date: string;
  taskRunId?: string | null;
  force?: boolean;
  onCandidatesLoaded?: (candidateCount: number) => Promise<void>;
  onStageUpdate?: (stage: DailyReportPipelineStage) => Promise<void>;
  onCheckpoint?: (checkpoint: TaskPipelineCheckpoint) => Promise<void>;
  resumeCheckpoint?: TaskPipelineCheckpoint | null;
}) {
  const normalizedDate = normalizeDailyReportDate(input.date);
  return withDailyReportLock(normalizedDate, "generate", async ({ assertLock }) => {
    return generateDailyReportInternal({
      ...input,
      onCandidatesLoaded: async (candidateCount) => {
        await assertLock();
        await input.onCandidatesLoaded?.(candidateCount);
      },
      onStageUpdate: async (stage) => {
        await assertLock();
        await input.onStageUpdate?.(stage);
      },
      onCheckpoint: async (checkpoint) => {
        await assertLock();
        await input.onCheckpoint?.(checkpoint);
      },
    });
  });
}

export async function executeDailyReportTask(taskRun: BackgroundTaskRun) {
  const date = taskRun.entityId && /^\d{4}-\d{2}-\d{2}$/.test(taskRun.entityId)
    ? taskRun.entityId
    : getTodayDailyReportDate();
  let candidateCount = 0;
  let historyFilteredCount = 0;
  let planningCandidateCount = 0;
  let planSectionCount = 0;
  let planTopicCount = 0;
  let planSelectedCount = 0;
  let planTruncatedTopicCount = 0;
  let planningAudit: DailyReportPlanningAudit | null = null;
  let planViolationCount = 0;
  let assessRepairCount = 0;
  let assessRetryCount = 0;
  let planRepairCount = 0;
  let planRetryCount = 0;
  let writeRepairCount = 0;
  let repairCount = 0;
  let writeRetryCount = 0;
  let validationViolationCount = 0;
  const contextOverflowStages = new Set<string>();
  let omittedTopicCount = 0;
  let batchCount = 0;
  let batchSize: number | null = null;
  let activeStage: DailyReportPipelineStage | null = "prepare";
  let resumeCheckpoint: TaskPipelineCheckpoint | null = null;
  if (taskRun.pipelineCheckpointJson) {
    const parsed = parseTaskPipelineCheckpointJson(taskRun.pipelineCheckpointJson);
    if (parsed?.resumeEligible) resumeCheckpoint = parsed;
  }

  try {
    await updateTaskRun(taskRun.id, {
      status: "running",
      progressCurrent: 0,
      progressTotal: 1,
      progressLabel: `正在生成 ${date} AI 日报`,
      taskTimeline: buildDailyReportTaskTimeline({
        taskRun,
        status: "running",
        activeStage,
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
            historyFilteredCount,
            batchCount,
            batchSize,
            activeStage,
          }),
        });
      },
      onStageUpdate: async (stage) => {
        activeStage = normalizeDailyReportTimelineStage(stage);
        await updateTaskRun(taskRun.id, {
          taskTimeline: buildDailyReportTaskTimeline({
            taskRun,
            status: "running",
            candidateCount,
            historyFilteredCount,
            batchCount,
            batchSize,
          activeStage,
          assessRepairCount,
          assessRetryCount,
          planRepairCount,
          planRetryCount,
          writeRepairCount,
          contextOverflowCount: contextOverflowStages.size,
        }),
        });
      },
      onCheckpoint: async (checkpoint) => {
        if (typeof checkpoint.data?.batchCount === "number") batchCount = checkpoint.data.batchCount;
        if (typeof checkpoint.data?.historyFilteredCount === "number") historyFilteredCount = checkpoint.data.historyFilteredCount;
        if (checkpoint.data && Object.prototype.hasOwnProperty.call(checkpoint.data, "batchSize")) {
          batchSize = typeof checkpoint.data.batchSize === "number" ? checkpoint.data.batchSize : null;
        }
        const checkpointPlan = checkpoint.plan as DailyReportPlan | undefined;
        if (Array.isArray(checkpoint.planningCandidateBriefs)) {
          planningCandidateCount = checkpoint.planningCandidateBriefs.length;
        }
        if (checkpointPlan?.sections) {
          planSectionCount = checkpointPlan.sections.length;
          planTopicCount = getDailyReportPlanTopics(checkpointPlan).length;
          planSelectedCount = getDailyReportPlanCandidateIds(checkpointPlan).length;
          planViolationCount = checkpoint.violations?.length ?? 0;
        }
        if (checkpoint.stageLoop) {
          const stageLoop = checkpoint.stageLoop;
          if (stageLoop.stage === "assess") {
            assessRepairCount = stageLoop.repairRound;
            assessRetryCount = stageLoop.cleanRetryAttempt;
          } else if (stageLoop.stage === "plan") {
            planRepairCount = stageLoop.repairRound;
            planRetryCount = stageLoop.cleanRetryAttempt;
          } else if (stageLoop.stage === "write") {
            writeRepairCount = stageLoop.repairRound;
            repairCount = stageLoop.repairRound;
            writeRetryCount = stageLoop.cleanRetryAttempt;
          }
          if (stageLoop.contextOverflow) contextOverflowStages.add(stageLoop.stage);
        }
        const checkpointPlanningAudit = checkpoint.planningAudit as DailyReportPlanningAudit | undefined;
        if (checkpointPlanningAudit && typeof checkpointPlanningAudit.truncatedTopicCount === "number") {
          planningAudit = checkpointPlanningAudit;
          planTruncatedTopicCount = checkpointPlanningAudit.truncatedTopicCount;
        }
        if (checkpoint.stage === "write" || checkpoint.stage === "validate" || checkpoint.stage === "repair") {
          validationViolationCount = checkpoint.violations?.length ?? 0;
        }
        if (typeof checkpoint.data?.omittedTopicCount === "number") {
          omittedTopicCount = checkpoint.data.omittedTopicCount;
        }
        if (typeof checkpoint.data?.writeRetryCount === "number") {
          writeRetryCount = checkpoint.data.writeRetryCount;
        }
        await updateTaskRun(taskRun.id, { pipelineCheckpoint: checkpoint });
        resumeCheckpoint = checkpoint;
      },
      resumeCheckpoint,
    });

    const finishedAt = new Date();
    const finalAiUsage = result.aiUsage;
    const finalStatus = result.partial ? "partial" : "succeeded";
    omittedTopicCount = result.omittedTopicIds.length;
    const totalActual = result.skipped ? 0 : finalAiUsage.actual;
    const totalEstimated = finalAiUsage.estimated;
    // Always include the daily_report key so the breakdown is non-empty when
    // the task runs at all, even if the call count is zero.
    const finalBreakdown: TaskAiCallBreakdownSnapshot[] = result.skipped
      ? [{ key: "daily_report", label: "AI 日报", actual: 0, estimated: totalEstimated }]
      : finalAiUsage.breakdown.some((entry) => entry.key === "daily_report")
        ? finalAiUsage.breakdown
        : [{ key: "daily_report", label: "AI 日报", actual: totalActual, estimated: totalEstimated }];
    const completedCheckpoint = resumeCheckpoint
      && resumeCheckpoint.resumeEligible
      && getDailyReportRecoveryStages(resumeCheckpoint).length > 0
      ? {
          ...resumeCheckpoint,
          stage: "validate",
          lastCompletedStage: "validate",
          failedStage: null,
          failureCode: null,
          resumeEligible: true,
          stageLoop: undefined,
        }
      : null;
    await updateTaskRun(taskRun.id, {
      status: finalStatus,
      progressCurrent: 1,
      progressTotal: 1,
      progressLabel: result.skipped
        ? result.reason
        : `已生成 ${date} AI 日报${result.report?.status === "published" ? "并发布" : "草稿"}${result.partial ? "（部分条目因校验失败被剔除）" : ""}`,
      aiCallCountActual: totalActual,
      aiCallCountEstimated: totalEstimated,
      aiCallBreakdown: finalBreakdown,
      taskTimeline: buildDailyReportTaskTimeline({
        taskRun,
        status: result.skipped ? "skipped" : finalStatus,
        candidateCount: result.candidateCount,
        historyFilteredCount: result.historyFilteredCount,
        selectedCount: result.selectedCount,
        planningCandidateCount: result.planningCandidateCount,
        planSectionCount: result.planSectionCount,
        planTopicCount: result.planTopicCount,
        planSelectedCount: result.planSelectedCount,
        planTruncatedTopicCount,
        planningAudit,
        planViolationCount: result.planViolationCount,
        validationViolationCount: result.validationViolationCount,
        assessRepairCount,
        assessRetryCount,
        planRepairCount,
        planRetryCount,
        writeRepairCount,
        writeRetryCount: result.writeRetryCount,
        repairCount: result.repairCount,
        contextOverflowCount: contextOverflowStages.size,
        omittedTopicCount,
        batchCount: result.batchCount,
        batchSize: result.batchSize,
        activeStage: result.skipped ? null : "persist_publish",
        finishedAt,
      }),
      // Keep the final planning inputs and plan so a completed report can be
      // regenerated from ASSESS/PLAN/WRITE as a new task.
      pipelineCheckpoint: completedCheckpoint,
      finishedAt,
    });
    await markDailyScheduleRunFinished(taskRun, finalStatus);
  } catch (error) {
    const message = error instanceof Error ? error.message : "AI 日报生成失败。";
    const cancelled = error instanceof DailyReportCancellationError;
    const failedAiUsage = error instanceof DailyReportGenerationError || cancelled ? error.aiUsage : null;
    const failedCheckpoint = error instanceof DailyReportGenerationError || cancelled ? error.checkpoint : null;
    if (failedCheckpoint?.failedStage) activeStage = normalizeDailyReportTimelineStage(failedCheckpoint.failedStage);
    if (failedCheckpoint?.data && typeof failedCheckpoint.data.batchCount === "number") batchCount = failedCheckpoint.data.batchCount;
    if (failedCheckpoint?.data && typeof failedCheckpoint.data.historyFilteredCount === "number") {
      historyFilteredCount = failedCheckpoint.data.historyFilteredCount;
    }
    if (failedCheckpoint?.data && Object.prototype.hasOwnProperty.call(failedCheckpoint.data, "batchSize")) {
      batchSize = typeof failedCheckpoint.data.batchSize === "number" ? failedCheckpoint.data.batchSize : null;
    }
    if (failedCheckpoint?.data && typeof failedCheckpoint.data.omittedTopicCount === "number") {
      omittedTopicCount = failedCheckpoint.data.omittedTopicCount;
    }
    if (failedCheckpoint?.data && typeof failedCheckpoint.data.writeRetryCount === "number") {
      writeRetryCount = failedCheckpoint.data.writeRetryCount;
    }
    if (failedCheckpoint?.stageLoop) {
      const stageLoop = failedCheckpoint.stageLoop;
      if (stageLoop.stage === "assess") {
        assessRepairCount = stageLoop.repairRound;
        assessRetryCount = stageLoop.cleanRetryAttempt;
      } else if (stageLoop.stage === "plan") {
        planRepairCount = stageLoop.repairRound;
        planRetryCount = stageLoop.cleanRetryAttempt;
      } else if (stageLoop.stage === "write") {
        writeRepairCount = stageLoop.repairRound;
        repairCount = stageLoop.repairRound;
        writeRetryCount = stageLoop.cleanRetryAttempt;
      }
      if (stageLoop.contextOverflow) contextOverflowStages.add(stageLoop.stage);
    }
    const failedPlan = failedCheckpoint?.plan as DailyReportPlan | undefined;
    if (failedPlan?.sections) {
      planSectionCount = failedPlan.sections.length;
      planTopicCount = getDailyReportPlanTopics(failedPlan).length;
      planSelectedCount = getDailyReportPlanCandidateIds(failedPlan).length;
      planViolationCount = failedCheckpoint?.violations?.length ?? 0;
    }
    const failedPlanningAudit = failedCheckpoint?.planningAudit as DailyReportPlanningAudit | undefined;
    if (failedPlanningAudit && typeof failedPlanningAudit.truncatedTopicCount === "number") {
      planningAudit = failedPlanningAudit;
      planTruncatedTopicCount = failedPlanningAudit.truncatedTopicCount;
    }
    const finishedAt = new Date();
    await updateTaskRun(taskRun.id, {
      status: cancelled ? "cancelled" : "failed",
      progressLabel: cancelled ? TASK_RUN_CANCELLED_LABEL : message,
      errorSummary: cancelled ? TASK_RUN_CANCELLED_MESSAGE : message,
      ...(failedAiUsage ? {
        aiCallCountActual: failedAiUsage.actual,
        aiCallCountEstimated: failedAiUsage.estimated,
        aiCallBreakdown: failedAiUsage.breakdown,
      } : {}),
      taskTimeline: buildDailyReportTaskTimeline({
        taskRun,
        status: cancelled ? "cancelled" : "failed",
        candidateCount,
        historyFilteredCount,
        planningCandidateCount,
        planSectionCount,
        planTopicCount,
        planSelectedCount,
        planTruncatedTopicCount,
        planningAudit,
        planViolationCount,
        validationViolationCount,
        assessRepairCount,
        assessRetryCount,
        planRepairCount,
        planRetryCount,
        writeRepairCount,
        writeRetryCount,
        repairCount,
        contextOverflowCount: contextOverflowStages.size,
        omittedTopicCount,
        batchCount,
        batchSize,
        activeStage,
        finishedAt,
      }),
      ...(failedCheckpoint ? { pipelineCheckpoint: failedCheckpoint } : {}),
      finishedAt,
    });
    await markDailyScheduleRunFinished(taskRun, cancelled ? "cancelled" : "failed");
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
