import { getEventBriefingDateRange } from "@/lib/events/date";
import { EVENT_BRIEFING_DEFAULT_PAGE_SIZE, EVENT_BRIEFING_MAX_PAGE_SIZE } from "@/lib/events/pagination";
import { calculateCuratorPreference } from "@/lib/events/preferences";
import { listEventBriefingCandidates } from "@/lib/events/repository";
import type {
  BriefingPreferenceForRuntime,
  EventBriefingConfigForRuntime,
  EventBriefingChannelDTO,
  EventBriefingCandidate,
  EventBriefingDTO,
  EventBriefingEntryDTO,
  EventBriefingOptions,
  EventBriefingSummaryDTO,
} from "@/lib/events/types";
import { normalizeEventBriefingTag } from "@/lib/events/types";
import { withEventBriefingCache } from "@/lib/events/cache";
import {
  DEFAULT_EVENT_BRIEFING_CHANNEL_ID,
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

type EventBriefingRankContext = {
  historicalSourceCounts: readonly number[];
  historicalItemCounts: readonly number[];
  sameDaySourceCounts: readonly number[];
  sameDayItemCounts: readonly number[];
};

const MIN_CONTEXTUAL_CANDIDATE_COUNT = 3;

function lowerBound(values: readonly number[], value: number) {
  let low = 0;
  let high = values.length;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle]! < value) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return low;
}

function upperBound(values: readonly number[], value: number) {
  let low = 0;
  let high = values.length;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle]! <= value) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return low;
}

function calculateRelativeScore(
  value: number,
  sortedValues: readonly number[],
  maxScore: number,
) {
  if (
    sortedValues.length < MIN_CONTEXTUAL_CANDIDATE_COUNT ||
    sortedValues[0] === sortedValues[sortedValues.length - 1]
  ) {
    return null;
  }

  const lowerCount = lowerBound(sortedValues, value);
  const equalCount = upperBound(sortedValues, value) - lowerCount;
  const percentile = (lowerCount + (equalCount - 1) / 2) / (sortedValues.length - 1);
  return Math.round(percentile * maxScore);
}

function blendFixedAndRelativeScore(
  fixedScore: number,
  relativeScore: number | null,
  maxScore: number,
) {
  if (relativeScore === null) {
    return fixedScore;
  }

  return clamp(Math.round((fixedScore + relativeScore) / 2), 0, maxScore);
}

function sortCounts(values: number[]) {
  return values.sort((left, right) => left - right);
}

export function createEventBriefingRankContext(
  candidates: readonly EventBriefingCandidate[],
): EventBriefingRankContext {
  return {
    historicalSourceCounts: sortCounts(candidates.map((candidate) => candidate.sourceCount)),
    historicalItemCounts: sortCounts(candidates.map((candidate) => candidate.itemCount)),
    sameDaySourceCounts: sortCounts(candidates.map((candidate) => candidate.newSourceCountOnDate)),
    sameDayItemCounts: sortCounts(candidates.map((candidate) => candidate.newItemCountOnDate)),
  };
}

function calculateHistoricalEvidenceScore(
  candidate: EventBriefingCandidate,
  context?: EventBriefingRankContext,
) {
  // Historical volume is useful as a confidence signal, but should not
  // overpower today's progress. Keep it deliberately below the combined
  // same-day evidence and momentum budget.
  const sourceScore = candidate.sourceCount >= 4
    ? 7
    : candidate.sourceCount >= 3
      ? 5
      : candidate.sourceCount >= 2
        ? 3
        : 0;
  const itemScore = candidate.itemCount >= 8
    ? 5
    : candidate.itemCount >= 4
      ? 4
      : candidate.itemCount >= 2
        ? 2
        : 0;
  const contextualSourceScore = context
    ? calculateRelativeScore(candidate.sourceCount, context.historicalSourceCounts, 7)
    : null;
  const contextualItemScore = context
    ? calculateRelativeScore(candidate.itemCount, context.historicalItemCounts, 5)
    : null;

  return Math.min(
    10,
    blendFixedAndRelativeScore(sourceScore, contextualSourceScore, 7) +
      blendFixedAndRelativeScore(itemScore, contextualItemScore, 5),
  );
}

function calculateSameDayEvidenceScore(
  candidate: EventBriefingCandidate,
  context?: EventBriefingRankContext,
) {
  const sourceScore = Math.min(6, candidate.newSourceCountOnDate * 2);
  const itemScore = Math.min(3, candidate.newItemCountOnDate);
  const contextualSourceScore = context
    ? calculateRelativeScore(candidate.newSourceCountOnDate, context.sameDaySourceCounts, 6)
    : null;
  const contextualItemScore = context
    ? calculateRelativeScore(candidate.newItemCountOnDate, context.sameDayItemCounts, 3)
    : null;

  return Math.min(
    9,
    blendFixedAndRelativeScore(sourceScore, contextualSourceScore, 6) +
      blendFixedAndRelativeScore(itemScore, contextualItemScore, 3),
  );
}

function getLatestCreatedItem(candidate: EventBriefingCandidate) {
  return candidate.items.reduce<(typeof candidate.items)[number] | null>(
    (latest, item) => (!latest || item.createdAt.getTime() > latest.createdAt.getTime() ? item : latest),
    null,
  );
}

function calculateFreshnessScore(
  candidate: EventBriefingCandidate,
  range: ReturnType<typeof getEventBriefingDateRange>,
) {
  const rangeDuration = range.end.getTime() - range.start.getTime();
  if (rangeDuration <= 0) return 0;

  const latestCreatedItem = getLatestCreatedItem(candidate);
  if (latestCreatedItem && !latestCreatedItem.publishedAtKnown) {
    return 0;
  }

  const progress = clamp(
    (candidate.latestCreatedAt.getTime() - range.start.getTime()) / rangeDuration,
    0,
    1,
  );
  return Math.round(progress * 2);
}

const PUBLISHED_AT_DELAY_GRACE_HOURS = 12;
const PUBLISHED_AT_DELAY_STEP_HOURS = 12;
const MAX_PUBLISHED_AT_DELAY_PENALTY = 8;

function calculatePublishedAtDelayPenalty(candidate: EventBriefingCandidate) {
  const latestCreatedItem = getLatestCreatedItem(candidate);
  const createdAt = latestCreatedItem?.createdAt ?? candidate.latestCreatedAt;
  const publishedAt = latestCreatedItem?.publishedAt ?? candidate.latestPublishedAt;
  if (latestCreatedItem && !latestCreatedItem.publishedAtKnown) {
    return 0;
  }
  const delayHours = Math.max(
    0,
    (createdAt.getTime() - publishedAt.getTime()) / (60 * 60 * 1000),
  );
  if (delayHours <= PUBLISHED_AT_DELAY_GRACE_HOURS) {
    return 0;
  }

  return Math.min(
    MAX_PUBLISHED_AT_DELAY_PENALTY,
    Math.ceil((delayHours - PUBLISHED_AT_DELAY_GRACE_HOURS) / PUBLISHED_AT_DELAY_STEP_HOURS),
  );
}

export function calculateEventBriefingBaseRankScore(
  candidate: EventBriefingCandidate,
  range: ReturnType<typeof getEventBriefingDateRange>,
  context?: EventBriefingRankContext,
) {
  const qualityComponent = Math.round(candidate.qualityScore * 0.65);
  const historicalEvidenceScore = calculateHistoricalEvidenceScore(candidate, context);
  const sameDayEvidenceScore = calculateSameDayEvidenceScore(candidate, context);
  const freshnessScore = calculateFreshnessScore(candidate, range);
  const publishedAtDelayPenalty = calculatePublishedAtDelayPenalty(candidate);
  const hasNewFacts = candidate.newItemCountOnDate > 0 || candidate.newSourceCountOnDate > 0;
  const momentumScore = candidate.isFollowUp ? (hasNewFacts ? 6 : 0) : 3;

  return clamp(
    qualityComponent +
      historicalEvidenceScore +
      sameDayEvidenceScore +
      freshnessScore +
      momentumScore -
      publishedAtDelayPenalty,
    0,
    100,
  );
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
  range: ReturnType<typeof getEventBriefingDateRange>;
  preference: BriefingPreferenceForRuntime;
  rankContext?: EventBriefingRankContext;
}): EventBriefingEntryDTO {
  const baseRankScore = calculateEventBriefingBaseRankScore(
    input.candidate,
    input.range,
    input.rankContext,
  );
  const curator = calculateCuratorPreference(input.candidate, input.preference);
  const rankScore = clamp(baseRankScore + curator.curatorBoost - curator.curatorPenalty, 0, 100);

  return {
    id: input.candidate.id,
    type: input.candidate.type,
    title: input.candidate.title,
    summary: input.candidate.summary,
    qualityScore: input.candidate.qualityScore,
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
    eventType: input.candidate.eventType,
    eventSubject: input.candidate.eventSubject,
    eventAction: input.candidate.eventAction,
    eventObject: input.candidate.eventObject,
    eventDate: input.candidate.eventDate,
    detailHref: `/?entryKeys=${encodeURIComponent(`${input.candidate.type}:${input.candidate.id}`)}`,
    items: input.candidate.items.map((item) => ({
      id: item.id,
      title: item.title,
      summary: item.summary,
      sourceName: item.sourceName,
      originalUrl: item.originalUrl,
      publishedAt: item.publishedAt.toISOString(),
      publishedAtKnown: item.publishedAtKnown,
      createdAt: item.createdAt.toISOString(),
      qualityScore: item.qualityScore,
    })),
  };
}

export function sortEventBriefingEntries(left: EventBriefingEntryDTO, right: EventBriefingEntryDTO) {
  if (right.rankScore !== left.rankScore) {
    return right.rankScore - left.rankScore;
  }
  if (right.baseRankScore !== left.baseRankScore) {
    return right.baseRankScore - left.baseRankScore;
  }

  const createdAtOrder = new Date(right.latestCreatedAt).getTime() - new Date(left.latestCreatedAt).getTime();
  if (createdAtOrder !== 0) {
    return createdAtOrder;
  }

  return `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`);
}

const sortEntries = sortEventBriefingEntries;

type RankedEventBriefing = {
  date: string;
  tag: NonNullable<EventBriefingOptions["tag"]>;
  channel: EventBriefingChannelDTO;
  channels: EventBriefingChannelDTO[];
  timezone: "Asia/Shanghai";
  generatedAt: string;
  summary: EventBriefingSummaryDTO;
  entries: EventBriefingEntryDTO[];
};

function toChannelDTO(channel: {
  id: string;
  name: string;
  sourceGroupIds: string[];
  enabled: boolean;
  sortOrder: number;
}, count = 0): EventBriefingChannelDTO {
  return {
    id: channel.id,
    name: channel.name,
    sourceGroupIds: channel.sourceGroupIds,
    enabled: channel.enabled,
    sortOrder: channel.sortOrder,
    count,
  };
}

function resolveSelectedChannel(
  channels: EventBriefingChannelDTO[],
  channelId: string | null | undefined,
) {
  return channels.find((channel) => channel.id === channelId)
    ?? channels.find((channel) => channel.id === DEFAULT_EVENT_BRIEFING_CHANNEL_ID)
    ?? channels[0]!;
}

function getActiveChannels(config: EventBriefingConfigForRuntime) {
  return (config.channels.some((channel) => channel.enabled)
    ? config.channels.filter((channel) => channel.enabled)
    : config.channels)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name))
    .map((channel) => toChannelDTO(channel));
}

async function loadEventBriefingRuntime() {
  const [configRow, preferenceRow] = await Promise.all([
    ensureEventBriefingConfig(),
    ensureBriefingPreferenceConfig(),
  ]);
  const config = serializeAdminEventBriefingConfig(configRow);

  return {
    config,
    preference: serializeAdminBriefingPreferenceConfig(preferenceRow),
    activeChannels: getActiveChannels(config),
  };
}

async function loadEntriesForChannel(input: {
  channel: EventBriefingChannelDTO;
  range: ReturnType<typeof getEventBriefingDateRange>;
  preference: BriefingPreferenceForRuntime;
  minRankScore: number;
  tag: EventBriefingOptions["tag"];
}) {
  const candidateResult = await listEventBriefingCandidates(input.range, {
    groupIds: input.channel.sourceGroupIds,
    tag: normalizeEventBriefingTag(input.tag),
  });
  const rankContext = createEventBriefingRankContext(candidateResult.candidates);

  return candidateResult.candidates
    .map((candidate) => toEntryDTO({
      candidate,
      range: input.range,
      preference: input.preference,
      rankContext,
    }))
    .filter((entry) => entry.rankScore >= input.minRankScore)
    .sort(sortEntries);
}

async function loadRankedEventBriefing(options: EventBriefingOptions): Promise<RankedEventBriefing> {
  const range = getEventBriefingDateRange(options.date, options.now);
  const tag = normalizeEventBriefingTag(options.tag);
  const { config, preference, activeChannels } = await loadEventBriefingRuntime();
  const selectedChannel = resolveSelectedChannel(activeChannels, options.channelId);
  const channelEntries = await Promise.all(
    activeChannels.map(async (channel) => ({
      channel,
      entries: await loadEntriesForChannel({
        channel,
        range,
        preference,
        minRankScore: config.minRankScore,
        tag,
      }),
    })),
  );
  const channels = channelEntries.map(({ channel, entries }) => ({
    ...channel,
    count: entries.length,
  }));
  const selectedChannelWithCount = resolveSelectedChannel(channels, selectedChannel.id);
  const allEntries = channelEntries.find(({ channel }) => channel.id === selectedChannel.id)?.entries ?? [];

  return {
    date: range.date,
    tag,
    channel: selectedChannelWithCount,
    channels,
    timezone: range.timezone,
    generatedAt: new Date().toISOString(),
    summary: {
      eventCount: allEntries.length,
    },
    entries: allEntries,
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
    tag: ranked.tag,
    channel: ranked.channel,
    channels: ranked.channels,
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
    channelId: options.channelId ?? null,
    tag: normalizeEventBriefingTag(options.tag),
    now: options.now?.toISOString() ?? null,
  });
}

export async function getEventBriefing(options: EventBriefingOptions = {}) {
  return loadEventBriefing(options);
}

export async function listEventBriefingEntriesForDailyReport(options: {
  date: string;
  channelIds?: string[];
}) {
  const ranked = await withEventBriefingCache(
    `event-briefing-daily:${JSON.stringify({
      date: options.date,
      channelIds: [...new Set((options.channelIds ?? []).filter(Boolean))].sort(),
    })}`,
    () => loadDailyReportRankedEntries(options),
  );

  // Daily reports apply duplicate filtering after the shared ranking. Return
  // the full ranked set so lower-ranked candidates can fill removed slots.
  return ranked;
}

function resolveSelectedChannelIds(
  channels: EventBriefingChannelDTO[],
  channelIds: string[] | undefined,
) {
  const activeIds = new Set(channels.map((channel) => channel.id));
  const normalized = [...new Set((channelIds ?? []).map((channelId) => channelId.trim()).filter(Boolean))]
    .filter((channelId) => activeIds.has(channelId));

  if (normalized.length > 0) {
    return normalized;
  }

  const fallback = resolveSelectedChannel(channels, DEFAULT_EVENT_BRIEFING_CHANNEL_ID);
  return [fallback.id];
}

async function loadDailyReportRankedEntries(options: {
  date: string;
  channelIds?: string[];
}) {
  const range = getEventBriefingDateRange(options.date);
  const { config, preference, activeChannels } = await loadEventBriefingRuntime();
  const selectedChannelIds = resolveSelectedChannelIds(activeChannels, options.channelIds);
  const selectedChannels = activeChannels.filter((channel) => selectedChannelIds.includes(channel.id));
  const entriesByKey = new Map<string, EventBriefingEntryDTO>();
  const channelEntries = await Promise.all(
    selectedChannels.map((channel) => loadEntriesForChannel({
      channel,
      range,
      preference,
      minRankScore: config.minRankScore,
      tag: "all",
    })),
  );

  for (const entry of channelEntries.flat()) {
    const key = `${entry.type}:${entry.id}`;
    const current = entriesByKey.get(key);
    if (!current || entry.rankScore > current.rankScore) {
      entriesByKey.set(key, entry);
    }
  }

  return [...entriesByKey.values()].sort(sortEntries);
}

export async function resolveDailyReportChannelSourceGroupIds(channelIds?: string[]) {
  const configRow = await ensureEventBriefingConfig();
  const config = serializeAdminEventBriefingConfig(configRow);
  const activeChannels = getActiveChannels(config);
  const selectedChannelIds = resolveSelectedChannelIds(activeChannels, channelIds);
  const selectedChannels = activeChannels.filter((channel) => selectedChannelIds.includes(channel.id));

  if (selectedChannels.some((channel) => channel.sourceGroupIds.length === 0)) {
    return [];
  }

  return [...new Set(selectedChannels.flatMap((channel) => channel.sourceGroupIds))];
}

export { formatTime as formatEventBriefingTime };
