import { getEventBriefingDateRange } from "@/lib/events/date";
import { EVENT_BRIEFING_DEFAULT_PAGE_SIZE, EVENT_BRIEFING_MAX_PAGE_SIZE } from "@/lib/events/pagination";
import { calculateCuratorPreference } from "@/lib/events/preferences";
import { listEventBriefingCandidates } from "@/lib/events/repository";
import type {
  BriefingPreferenceForRuntime,
  EventBriefingCandidate,
  EventBriefingDTO,
  EventBriefingEntryDTO,
  EventBriefingOptions,
  EventBriefingSummaryDTO,
  EventBriefingView,
} from "@/lib/events/types";
import { withEventBriefingCache } from "@/lib/events/cache";
import {
  ensureBriefingPreferenceConfig,
  ensureEventBriefingConfig,
  serializeAdminBriefingPreferenceConfig,
  serializeAdminEventBriefingConfig,
} from "@/lib/settings/event-briefing-service";

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function normalizePositiveInteger(value: number | undefined, fallback: number) {
  return Number.isInteger(value) && value && value > 0 ? value : fallback;
}

function normalizeBriefingView(view: EventBriefingOptions["view"]): EventBriefingView {
  return view === "updates" || view === "multi-source" ? view : "important";
}

function filterEntriesByView(entries: EventBriefingEntryDTO[], view: EventBriefingView) {
  if (view === "updates") {
    return entries.filter((entry) => entry.isFollowUp);
  }

  if (view === "multi-source") {
    return entries.filter((entry) => entry.sourceCount >= 2);
  }

  return entries;
}

function calculateEvidenceScore(candidate: EventBriefingCandidate) {
  const sourceScore = candidate.sourceCount >= 4
    ? 10
    : candidate.sourceCount >= 3
      ? 8
      : candidate.sourceCount >= 2
        ? 5
        : 0;
  const itemScore = candidate.itemCount >= 8
    ? 7
    : candidate.itemCount >= 4
      ? 5
      : candidate.itemCount >= 2
        ? 3
        : 0;

  return Math.min(15, sourceScore + itemScore);
}

function calculateBaseRankScore(candidate: EventBriefingCandidate) {
  const qualityComponent = Math.round(candidate.qualityScore * 0.7);
  const evidenceScore = calculateEvidenceScore(candidate);
  const momentumScore = candidate.isFollowUp ? 8 : 3;

  return clamp(qualityComponent + evidenceScore + momentumScore, 0, 100);
}

function formatTime(value: Date) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Shanghai",
  }).format(value);
}

function toEntryDTO(input: {
  candidate: EventBriefingCandidate;
  preference: BriefingPreferenceForRuntime;
}): EventBriefingEntryDTO {
  const baseRankScore = calculateBaseRankScore(input.candidate);
  const curator = calculateCuratorPreference(input.candidate, input.preference);
  const rankScore = clamp(baseRankScore + curator.curatorBoost - curator.curatorPenalty, 0, 100);

  return {
    id: input.candidate.id,
    type: input.candidate.type,
    title: input.candidate.title,
    summary: input.candidate.summary,
    rankScore,
    baseRankScore,
    curatorBoost: curator.curatorBoost,
    curatorPenalty: curator.curatorPenalty,
    isFollowUp: input.candidate.isFollowUp,
    sourceCount: input.candidate.sourceCount,
    itemCount: input.candidate.itemCount,
    newItemCountOnDate: input.candidate.newItemCountOnDate,
    newSourceCountOnDate: input.candidate.newSourceCountOnDate,
    latestCreatedAt: input.candidate.latestCreatedAt.toISOString(),
    latestPublishedAt: input.candidate.latestPublishedAt.toISOString(),
    detailHref: `/?entryKeys=${encodeURIComponent(`${input.candidate.type}:${input.candidate.id}`)}`,
    items: input.candidate.items.map((item) => ({
      id: item.id,
      title: item.title,
      summary: item.summary,
      sourceName: item.sourceName,
      originalUrl: item.originalUrl,
      publishedAt: item.publishedAt.toISOString(),
      createdAt: item.createdAt.toISOString(),
      qualityScore: item.qualityScore,
    })),
  };
}

function sortEntries(left: EventBriefingEntryDTO, right: EventBriefingEntryDTO) {
  if (right.rankScore !== left.rankScore) {
    return right.rankScore - left.rankScore;
  }
  if (right.baseRankScore !== left.baseRankScore) {
    return right.baseRankScore - left.baseRankScore;
  }
  return new Date(right.latestCreatedAt).getTime() - new Date(left.latestCreatedAt).getTime();
}

type RankedEventBriefing = {
  date: string;
  view: EventBriefingView;
  timezone: "Asia/Shanghai";
  generatedAt: string;
  summary: EventBriefingSummaryDTO;
  entries: EventBriefingEntryDTO[];
};

async function loadRankedEventBriefing(options: EventBriefingOptions): Promise<RankedEventBriefing> {
  const range = getEventBriefingDateRange(options.date, options.now);
  const [configRow, preferenceRow, candidateResult] = await Promise.all([
    ensureEventBriefingConfig(),
    ensureBriefingPreferenceConfig(),
    listEventBriefingCandidates(range),
  ]);
  const config = serializeAdminEventBriefingConfig(configRow);
  const preference = serializeAdminBriefingPreferenceConfig(preferenceRow);
  const view = normalizeBriefingView(options.view);
  const allEntries = candidateResult.candidates
    .map((candidate) => toEntryDTO({
      candidate,
      preference,
    }))
    .filter((entry) => entry.rankScore >= config.minRankScore)
    .sort(sortEntries);
  const visibleEntries = filterEntriesByView(allEntries, view);
  const updatedEventCount = allEntries.filter((entry) => entry.isFollowUp).length;

  return {
    date: range.date,
    view,
    timezone: range.timezone,
    generatedAt: new Date().toISOString(),
    summary: {
      eventCount: allEntries.length,
      multiSourceCount: allEntries.filter((entry) => entry.sourceCount >= 2).length,
      updatedEventCount,
    },
    entries: visibleEntries,
  };
}

async function loadEventBriefing(options: EventBriefingOptions): Promise<EventBriefingDTO> {
  const ranked = await withEventBriefingCache(
    `event-briefing-ranked:${serializeRankedOptions(options)}`,
    () => loadRankedEventBriefing(options),
  );
  const pageSize = clamp(
    normalizePositiveInteger(options.pageSize, EVENT_BRIEFING_DEFAULT_PAGE_SIZE),
    1,
    EVENT_BRIEFING_MAX_PAGE_SIZE,
  );
  const page = normalizePositiveInteger(options.page, 1);
  const total = ranked.entries.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const normalizedPage = clamp(page, 1, totalPages);
  const start = (normalizedPage - 1) * pageSize;
  const entries = ranked.entries.slice(start, start + pageSize);

  return {
    date: ranked.date,
    view: ranked.view,
    timezone: ranked.timezone,
    generatedAt: ranked.generatedAt,
    summary: ranked.summary,
    pagination: {
      page: normalizedPage,
      pageSize,
      total,
      totalPages,
    },
    entries,
  };
}

function serializeRankedOptions(options: EventBriefingOptions) {
  return JSON.stringify({
    date: options.date ?? null,
    view: options.view ?? null,
    now: options.now?.toISOString() ?? null,
  });
}

export async function getEventBriefing(options: EventBriefingOptions = {}) {
  return loadEventBriefing(options);
}

export { formatTime as formatEventBriefingTime };
