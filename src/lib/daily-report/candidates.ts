

import { getDailyReportDateRange } from "@/lib/daily-report/date";
import { listDailyReportCandidates } from "@/lib/daily-report/repository";
import { type DailyReportCandidate, type DailyReportCandidateCoverageDTO, type DailyReportModelDraft, type DailyReportPlanningAudit, type DailyReportContent, type DailyReportReviewInput, type DailyReportItem } from "@/lib/daily-report/types";
import { buildDailyReportCandidateBriefs, buildDailyReportSelectedTopics } from "@/lib/daily-report/planning";
import { normalizeDailyReportTemplateConfig } from "@/lib/daily-report/template";
import { listEventBriefingEntriesForDailyReport } from "@/lib/events/service";
import type { EventBriefingEntryDTO, EventBriefingItemDTO } from "@/lib/events/types";
import { getDailyReportEventIdentity, normalizeOptionalDailyReportText } from "@/lib/daily-report/recent-duplicates";
import { MAX_DAILY_REPORT_EVIDENCE_ITEMS_PER_CANDIDATE, DAILY_REPORT_REVIEW_TOP_UNSELECTED_CANDIDATE_LIMIT, getSectionSourceIds } from "@/lib/daily-report/report-input";


export function buildDailyReportSourceKey(input: {
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

export function getLegacyParsedItemId(sourceKey: string | null | undefined) {
  const normalized = sourceKey?.trim() ?? "";
  const prefix = "parsed:";
  if (!normalized.startsWith(prefix) || normalized.length === prefix.length) {
    return null;
  }
  return normalized.slice(prefix.length);
}

export function normalizeLegacyParsedSourceKey(sourceKey: string | null | undefined) {
  const legacyParsedItemId = getLegacyParsedItemId(sourceKey);
  return legacyParsedItemId ? `item:${legacyParsedItemId}` : sourceKey?.trim() || null;
}

export function compactDailyReportCandidates(candidates: DailyReportCandidate[]) {
  return candidates.map((candidate, index) => ({
    ...candidate,
    id: index + 1,
  }));
}

export function toDailyReportEvidenceItem(item: EventBriefingItemDTO) {
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

export function getDailyReportEntryItems(entry: EventBriefingEntryDTO, date: string) {
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

export function eventBriefingEntryToDailyReportCandidate(
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

export async function listDailyReportEventBriefingCandidates(date: string, channelIds: string[] = []) {
  const entries = await listEventBriefingEntriesForDailyReport({
    date,
    channelIds,
  });

  return entries
    .map((entry, index) => eventBriefingEntryToDailyReportCandidate(entry, index, date))
    .filter((candidate): candidate is DailyReportCandidate => Boolean(candidate));
}

export function buildDailyReportCandidateIdentity(candidate: DailyReportCandidate) {
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

export function buildDailyReportContentDuplicateIdentities(candidate: DailyReportCandidate) {
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

export function buildDailyReportReviewContext(input: {
  date: string;
  draft: DailyReportModelDraft;
  selectedTopics: ReturnType<typeof buildDailyReportSelectedTopics>;
  candidates: DailyReportCandidate[];
  rawCandidateCount?: number;
  candidateBriefs: Awaited<ReturnType<typeof buildDailyReportCandidateBriefs>>;
  historyFilteredCount: number;
  candidateCoverage: DailyReportCandidateCoverageDTO;
  planningAudit: DailyReportPlanningAudit | null;
  template: ReturnType<typeof normalizeDailyReportTemplateConfig>;
}): DailyReportReviewInput {
  const selectedIds = new Set(input.selectedTopics.flatMap((topic) => topic.candidateIds));
  const selectedByBlock = input.selectedTopics.reduce<Record<string, number>>((counts, topic) => {
    counts[topic.blockKey] = (counts[topic.blockKey] ?? 0) + 1;
    return counts;
  }, {});
  const candidatesByBlock = input.candidateBriefs.reduce<Record<string, number>>((counts, candidate) => {
    const blockKey = candidate.suggestedBlockKey ?? "unassigned";
    counts[blockKey] = (counts[blockKey] ?? 0) + 1;
    return counts;
  }, {});
  const unselectedCandidates = input.candidateBriefs
    .filter((candidate) => !selectedIds.has(candidate.candidateId))
    .sort((left, right) => right.candidateScore - left.candidateScore || left.candidateId - right.candidateId);

  return {
    date: input.date,
    draft: input.draft,
    selectedTopics: input.selectedTopics,
    candidatePool: {
      rawCandidateCount: input.rawCandidateCount ?? input.candidates.length,
      eligibleCandidateCount: input.candidateBriefs.length,
      excludedByAssessCount: Math.max(0, input.candidates.length - input.candidateBriefs.length),
      historyFilteredCount: input.historyFilteredCount,
      candidatesByBlock,
      topUnselectedCandidates: unselectedCandidates.slice(0, DAILY_REPORT_REVIEW_TOP_UNSELECTED_CANDIDATE_LIMIT),
      inputTruncatedCount: Math.max(0, unselectedCandidates.length - DAILY_REPORT_REVIEW_TOP_UNSELECTED_CANDIDATE_LIMIT),
    },
    selectionAudit: {
      candidateCoverage: input.candidateCoverage as unknown as Record<string, unknown>,
      planningAudit: input.planningAudit as unknown as Record<string, unknown> | null,
      selectedCount: input.selectedTopics.length,
      selectedByBlock,
    },
    template: input.template,
  };
}

export function deduplicateDailyReportCandidates(candidates: DailyReportCandidate[]) {
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

export async function listDailyReportGenerationCandidates(
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

