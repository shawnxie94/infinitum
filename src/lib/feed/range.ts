import { DAY_MS, MINUTE_MS } from "@/config/constants";
import type { FeedEntryKey, FeedFilters, FeedRange, FeedSort } from "@/lib/feed/types";

export const DEFAULT_FEED_TIME_ZONE_OFFSET_MINUTES = -8 * 60;

export const RANGE_OPTIONS: Array<{ value: FeedRange; label: string }> = [
  { value: "today", label: "当天" },
  { value: "3d", label: "3天" },
  { value: "7d", label: "7天" },
  { value: "1m", label: "1月" },
  { value: "1y", label: "1年" },
  { value: "all", label: "不限" },
];

export const SORT_OPTIONS: Array<{ value: FeedSort; label: string }> = [
  { value: "time_desc", label: "按时间倒序" },
  { value: "score_desc", label: "按评分倒序" },
];

const RANGE_SET = new Set<FeedRange>(RANGE_OPTIONS.map((option) => option.value));
const SORT_SET = new Set<FeedSort>(SORT_OPTIONS.map((option) => option.value));
const FEED_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const FEED_ENTRY_KEY_PATTERN = /^(single|cluster):[A-Za-z0-9_-]+$/;
const MAX_FEED_ENTRY_KEY_FILTERS = 50;

export function normalizeFeedFilterId(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function normalizeFeedEntryKeys(value: string | string[] | null | undefined): FeedEntryKey[] {
  const rawValues = Array.isArray(value) ? value : value ? [value] : [];
  const seen = new Set<string>();
  const keys: FeedEntryKey[] = [];

  for (const rawValue of rawValues) {
    for (const rawKey of rawValue.split(",")) {
      const key = rawKey.trim();

      if (!FEED_ENTRY_KEY_PATTERN.test(key) || seen.has(key)) {
        continue;
      }

      seen.add(key);
      keys.push(key as FeedEntryKey);

      if (keys.length >= MAX_FEED_ENTRY_KEY_FILTERS) {
        return keys;
      }
    }
  }

  return keys;
}

export function isFeedRange(value: string): value is FeedRange {
  return RANGE_SET.has(value as FeedRange);
}

export function isFeedSort(value: string): value is FeedSort {
  return SORT_SET.has(value as FeedSort);
}

export function normalizeFeedDateInput(value: string | null | undefined): string | null {
  if (!value || !FEED_DATE_PATTERN.test(value)) {
    return null;
  }

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));

  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month! - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return value;
}

function shiftInstantToOffsetTimeline(date: Date, timeZoneOffsetMinutes: number): Date {
  return new Date(date.getTime() - timeZoneOffsetMinutes * MINUTE_MS);
}

function shiftOffsetTimelineToUtc(date: Date, timeZoneOffsetMinutes: number): Date {
  return new Date(date.getTime() + timeZoneOffsetMinutes * MINUTE_MS);
}

export function getRangeStart(
  range: FeedRange,
  now = new Date(),
  timeZoneOffsetMinutes = DEFAULT_FEED_TIME_ZONE_OFFSET_MINUTES,
): Date | null {
  const current = new Date(now);
  const localCurrent = shiftInstantToOffsetTimeline(current, timeZoneOffsetMinutes);

  switch (range) {
    case "today": {
      const localDayStart = new Date(Date.UTC(localCurrent.getUTCFullYear(), localCurrent.getUTCMonth(), localCurrent.getUTCDate()));
      return shiftOffsetTimelineToUtc(localDayStart, timeZoneOffsetMinutes);
    }
    case "3d":
      return new Date(current.getTime() - 3 * DAY_MS);
    case "7d":
      return new Date(current.getTime() - 7 * DAY_MS);
    case "1m": {
      const localDate = new Date(localCurrent);
      localDate.setUTCMonth(localDate.getUTCMonth() - 1);
      return shiftOffsetTimelineToUtc(localDate, timeZoneOffsetMinutes);
    }
    case "1y": {
      const localDate = new Date(localCurrent);
      localDate.setUTCFullYear(localDate.getUTCFullYear() - 1);
      return shiftOffsetTimelineToUtc(localDate, timeZoneOffsetMinutes);
    }
    case "all":
      return null;
  }
}

function buildDateBoundary(value: string, boundary: "start" | "end", timeZoneOffsetMinutes: number): Date {
  const [year, month, day] = value.split("-").map(Number);

  if (boundary === "start") {
    return shiftOffsetTimelineToUtc(new Date(Date.UTC(year!, month! - 1, day!, 0, 0, 0, 0)), timeZoneOffsetMinutes);
  }

  return shiftOffsetTimelineToUtc(new Date(Date.UTC(year!, month! - 1, day!, 23, 59, 59, 999)), timeZoneOffsetMinutes);
}

export function resolveFeedFilters(
  input: Partial<FeedFilters> & Pick<FeedFilters, "range" | "sort">,
  now = new Date(),
  timeZoneOffsetMinutes = DEFAULT_FEED_TIME_ZONE_OFFSET_MINUTES,
): FeedFilters & {
  rangeStart: Date | null;
  rangeEnd: Date | null;
  publishedRangeStart: Date | null;
  publishedRangeEnd: Date | null;
  isCustomRange: boolean;
} {
  let start = normalizeFeedDateInput(input.start);
  let end = normalizeFeedDateInput(input.end);
  let publishedStart = normalizeFeedDateInput(input.publishedStart);
  let publishedEnd = normalizeFeedDateInput(input.publishedEnd);

  if (start && end && start > end) {
    [start, end] = [end, start];
  }

  if (publishedStart && publishedEnd && publishedStart > publishedEnd) {
    [publishedStart, publishedEnd] = [publishedEnd, publishedStart];
  }

  const sharedFilters = {
    groupId: normalizeFeedFilterId(input.groupId),
    sourceId: normalizeFeedFilterId(input.sourceId),
    title: input.title?.trim() ? input.title.trim() : null,
    entryId: normalizeFeedFilterId(input.entryId),
    entryType: input.entryType === "single" || input.entryType === "cluster" ? input.entryType : null,
    entryKeys: normalizeFeedEntryKeys(input.entryKeys),
    publishedStart,
    publishedEnd,
    publishedRangeStart: publishedStart ? buildDateBoundary(publishedStart, "start", timeZoneOffsetMinutes) : null,
    publishedRangeEnd: publishedEnd ? buildDateBoundary(publishedEnd, "end", timeZoneOffsetMinutes) : null,
  };

  if (start || end) {
    return {
      range: input.range,
      sort: input.sort,
      start,
      end,
      ...sharedFilters,
      rangeStart: start ? buildDateBoundary(start, "start", timeZoneOffsetMinutes) : null,
      rangeEnd: end ? buildDateBoundary(end, "end", timeZoneOffsetMinutes) : null,
      isCustomRange: true,
    };
  }

  return {
    range: input.range,
    sort: input.sort,
    start: null,
    end: null,
    ...sharedFilters,
    rangeStart: getRangeStart(input.range, now, timeZoneOffsetMinutes),
    rangeEnd: null,
    isCustomRange: false,
  };
}
