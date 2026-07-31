import { FEED_FILTER_OPTIONS_CACHE_TTL_MS, FEED_LIST_CACHE_TTL_MS, FEED_STATUS_CACHE_TTL_MS } from "@/config/constants";
import {
  getLatestFeedItemUpdate,
  getLatestFeedSourceConfigUpdate,
  listFeedFilterOptions,
  listFeedItems,
  getLatestFetchRun,
  countDisplayItemsCreatedDuringFetchRun,
  toFetchRunSnapshot,
} from "@/lib/feed/repository";
import { withFeedCache } from "@/lib/feed/cache";

type FeedFiltersInput = Parameters<typeof listFeedItems>[0] & { isCustomRange?: boolean };
type FeedPaginationInput = Parameters<typeof listFeedItems>[1];

const ROLLING_RANGE_CACHE_KEYS = new Set(["3d", "7d", "1m", "1y"]);

function serializeCreatedRangeStart(filters: FeedFiltersInput & { isCustomRange?: boolean }) {
  if (!filters.isCustomRange && ROLLING_RANGE_CACHE_KEYS.has(filters.range)) {
    return `range:${filters.range}`;
  }

  return filters.rangeStart?.toISOString() ?? null;
}

function serializeFeedFilters(filters: FeedFiltersInput) {
  return JSON.stringify({
    ...filters,
    rangeStart: serializeCreatedRangeStart(filters),
    rangeEnd: filters.rangeEnd?.toISOString() ?? null,
    publishedRangeStart: filters.publishedRangeStart?.toISOString() ?? null,
    publishedRangeEnd: filters.publishedRangeEnd?.toISOString() ?? null,
  });
}

function serializeFeedPagination(pagination: FeedPaginationInput) {
  return `${pagination.page}:${pagination.size}:${pagination.includePopularEntities === false ? "without-entities" : "with-entities"}`;
}

function serializeFetchRunCacheVersion(run: Awaited<ReturnType<typeof getLatestFetchRun>>) {
  if (!run) {
    return "no-fetch-run";
  }

  return [
    run.id,
    run.status,
    run.finishedAt?.toISOString() ?? "running",
    run.itemsAdded,
    run.successCount,
    run.failureCount,
  ].join(":");
}

function serializeFeedDataCacheVersion(itemUpdate: Awaited<ReturnType<typeof getLatestFeedItemUpdate>>) {
  if (!itemUpdate) {
    return "no-feed-items";
  }

  return `${itemUpdate.id}:${itemUpdate.updatedAt.toISOString()}`;
}

function serializeFeedSourceConfigCacheVersion(
  sourceConfigUpdate: Awaited<ReturnType<typeof getLatestFeedSourceConfigUpdate>>,
) {
  const sourceVersion = sourceConfigUpdate.latestSource
    ? `${sourceConfigUpdate.latestSource.id}:${sourceConfigUpdate.latestSource.updatedAt.toISOString()}`
    : "no-sources";
  const groupVersion = sourceConfigUpdate.latestGroup
    ? `${sourceConfigUpdate.latestGroup.id}:${sourceConfigUpdate.latestGroup.updatedAt.toISOString()}`
    : "no-source-groups";

  return `${sourceVersion}:${groupVersion}`;
}

export async function getCachedFeedItems(filters: FeedFiltersInput, pagination: FeedPaginationInput) {
  const [latestRun, latestItemUpdate] = await Promise.all([getLatestFetchRun(), getLatestFeedItemUpdate()]);
  const cacheVersion = `${serializeFetchRunCacheVersion(latestRun)}:${serializeFeedDataCacheVersion(latestItemUpdate)}`;

  return withFeedCache(
    `feed:list:${cacheVersion}:${serializeFeedFilters(filters)}:${serializeFeedPagination(pagination)}`,
    () => listFeedItems(filters, pagination),
    FEED_LIST_CACHE_TTL_MS,
  );
}

export async function getCachedFeedFilterOptions() {
  const sourceConfigVersion = serializeFeedSourceConfigCacheVersion(await getLatestFeedSourceConfigUpdate());

  return withFeedCache(
    `feed:filter-options:${sourceConfigVersion}`,
    () => listFeedFilterOptions(),
    FEED_FILTER_OPTIONS_CACHE_TTL_MS,
  );
}

export async function getCachedLatestFetchRunSnapshot() {
  const [latestRun, latestItemUpdate] = await Promise.all([getLatestFetchRun(), getLatestFeedItemUpdate()]);
  const cacheVersion = `${serializeFetchRunCacheVersion(latestRun)}:${serializeFeedDataCacheVersion(latestItemUpdate)}`;

  return withFeedCache(
    `feed:latest-run:${cacheVersion}`,
    async () => latestRun
      ? toFetchRunSnapshot(latestRun, {
        itemsAdded: await countDisplayItemsCreatedDuringFetchRun(latestRun),
      })
      : null,
    FEED_STATUS_CACHE_TTL_MS,
  );
}
