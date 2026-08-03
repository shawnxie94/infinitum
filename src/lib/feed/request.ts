import { DEFAULT_FEED_PAGE_SIZE, type FeedFilters, type FeedRange } from "@/lib/feed/types";
import {
  isFeedRange,
  isFeedSort,
  normalizeFeedEntryKeys,
  normalizeFeedDateInput,
  normalizeFeedFilterId,
  resolveFeedFilters,
} from "@/lib/feed/range";

type SearchParamRecord = Record<string, string | string[] | undefined>;
type SearchParamSource = URLSearchParams | SearchParamRecord;

type ResolvedFeedRequest = {
  filters: ReturnType<typeof resolveFeedFilters>;
  pagination: {
    page: number;
    size: number;
  };
};

const ADVANCED_FILTER_KEYS = [
  "sourceId",
  "title",
  "entity",
  "publishedStart",
  "publishedEnd",
  "entryId",
  "entryType",
  "entryKeys",
] as const;
const CREATED_TIME_FILTER_KEYS = ["range", "start", "end"] as const;

function getSearchParamValue(searchParams: SearchParamSource, key: keyof FeedFilters | "page" | "size") {
  if (searchParams instanceof URLSearchParams) {
    return searchParams.get(key) ?? undefined;
  }

  const value = searchParams[key];
  return Array.isArray(value) ? value[0] : value;
}

function getSearchParamValues(searchParams: SearchParamSource, key: keyof FeedFilters | "page" | "size") {
  if (searchParams instanceof URLSearchParams) {
    return searchParams.getAll(key);
  }

  const value = searchParams[key];
  return Array.isArray(value) ? value : value ? [value] : [];
}

function parsePage(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function parsePageSize(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : DEFAULT_FEED_PAGE_SIZE;
}

function hasParamValue(searchParams: SearchParamSource, key: keyof FeedFilters): boolean {
  return getSearchParamValues(searchParams, key).some((value) => Boolean(value.trim()));
}

function resolveDefaultRange(searchParams: SearchParamSource): FeedRange {
  const hasAdvancedFilter = ADVANCED_FILTER_KEYS.some((key) => hasParamValue(searchParams, key));
  const hasCreatedTimeFilter = CREATED_TIME_FILTER_KEYS.some((key) => hasParamValue(searchParams, key));

  return hasAdvancedFilter && !hasCreatedTimeFilter ? "all" : "today";
}

export function resolveFeedRequest(searchParams: SearchParamSource, now = new Date()): ResolvedFeedRequest {
  const rangeParam = getSearchParamValue(searchParams, "range");
  const sortParam = getSearchParamValue(searchParams, "sort");
  const startParam = getSearchParamValue(searchParams, "start");
  const endParam = getSearchParamValue(searchParams, "end");
  const publishedStartParam = getSearchParamValue(searchParams, "publishedStart");
  const publishedEndParam = getSearchParamValue(searchParams, "publishedEnd");
  const groupIdParam = getSearchParamValue(searchParams, "groupId");
  const sourceIdParam = getSearchParamValue(searchParams, "sourceId");
  const titleParam = getSearchParamValue(searchParams, "title");
  const entityParam = getSearchParamValue(searchParams, "entity");
  const entryIdParam = getSearchParamValue(searchParams, "entryId");
  const entryTypeParam = getSearchParamValue(searchParams, "entryType");
  const entryKeysParam = getSearchParamValues(searchParams, "entryKeys");
  const defaultRange = resolveDefaultRange(searchParams);
  return {
    filters: resolveFeedFilters(
      {
        range: rangeParam && isFeedRange(rangeParam) ? rangeParam : defaultRange,
        sort: sortParam && isFeedSort(sortParam) ? sortParam : "time_desc",
        start: normalizeFeedDateInput(startParam),
        end: normalizeFeedDateInput(endParam),
        publishedStart: normalizeFeedDateInput(publishedStartParam),
        publishedEnd: normalizeFeedDateInput(publishedEndParam),
        groupId: normalizeFeedFilterId(groupIdParam),
        sourceId: normalizeFeedFilterId(sourceIdParam),
        title: titleParam?.trim() ? titleParam.trim() : null,
        entity: normalizeFeedFilterId(entityParam),
        entryId: normalizeFeedFilterId(entryIdParam),
        entryType: entryTypeParam === "single" || entryTypeParam === "cluster" ? entryTypeParam : null,
        entryKeys: normalizeFeedEntryKeys(entryKeysParam),
      },
      now,
    ),
    pagination: {
      page: parsePage(getSearchParamValue(searchParams, "page")),
      size: parsePageSize(getSearchParamValue(searchParams, "size")),
    },
  };
}
