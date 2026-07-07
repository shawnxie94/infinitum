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
}) {
  const candidateResult = await listEventBriefingCandidates(input.range, { groupIds: input.channel.sourceGroupIds });

  return candidateResult.candidates
    .map((candidate) => toEntryDTO({
      candidate,
      preference: input.preference,
    }))
    .filter((entry) => entry.rankScore >= input.minRankScore)
    .sort(sortEntries);
}

async function loadRankedEventBriefing(options: EventBriefingOptions): Promise<RankedEventBriefing> {
  const range = getEventBriefingDateRange(options.date, options.now);
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
    now: options.now?.toISOString() ?? null,
  });
}

export async function getEventBriefing(options: EventBriefingOptions = {}) {
  return loadEventBriefing(options);
}

export async function listEventBriefingEntriesForDailyReport(options: {
  date: string;
  limit: number;
  channelIds?: string[];
}) {
  const ranked = await withEventBriefingCache(
    `event-briefing-daily:${JSON.stringify({
      date: options.date,
      channelIds: [...new Set((options.channelIds ?? []).filter(Boolean))].sort(),
    })}`,
    () => loadDailyReportRankedEntries(options),
  );
  const limit = normalizePositiveInteger(options.limit, ranked.length);

  return ranked.slice(0, limit);
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
