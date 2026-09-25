import { beforeEach, describe, expect, it, vi } from "vitest";

const { cacheKeys, cacheTtls, newsSitemapCalls } = vi.hoisted(() => ({
  cacheKeys: [] as string[],
  cacheTtls: [] as Array<number | null>,
  newsSitemapCalls: [] as Array<{ since: Date; limit: number }>,
}));

vi.mock("@/lib/feed/cache", () => ({
  withFeedCache: vi.fn(async (key: string, loader: () => Promise<unknown>, ttlMs?: number) => {
    cacheKeys.push(key);
    cacheTtls.push(ttlMs ?? null);
    return loader();
  }),
}));

vi.mock("@/lib/feed/repository", () => ({
  getLatestFetchRun: vi.fn(async () => null),
  getLatestFeedItemUpdate: vi.fn(async () => ({
    id: "item-version",
    updatedAt: new Date("2026-04-10T12:00:00.000Z"),
  })),
  getLatestFeedSourceConfigUpdate: vi.fn(async () => ({
    latestSource: null,
    latestGroup: null,
  })),
  listFeedFilterOptions: vi.fn(async () => ({ groups: [], sources: [] })),
  listFeedItems: vi.fn(async () => ({
    items: [],
    groups: [],
    groupTotalCount: 0,
    pagination: { page: 1, size: 50, total: 0, totalPages: 1 },
    nextCursor: null,
  })),
  listNewsSitemapItems: vi.fn(async (since: Date, limit: number) => {
    newsSitemapCalls.push({ since, limit });
    return [];
  }),
  countDisplayItemsCreatedDuringFetchRun: vi.fn(async () => 0),
  toFetchRunSnapshot: vi.fn(() => null),
}));

const { getCachedFeedItems, getCachedNewsSitemapItems } = await import("@/lib/feed/service");

function buildFilters(overrides: Partial<Parameters<typeof getCachedFeedItems>[0]> = {}): Parameters<typeof getCachedFeedItems>[0] {
  return {
    range: "3d",
    sort: "time_desc",
    start: null,
    end: null,
    publishedStart: null,
    publishedEnd: null,
    groupId: null,
    sourceId: null,
    title: null,
    entryId: null,
    entryType: null,
    entryKeys: [],
    rangeStart: new Date("2026-04-07T12:00:00.000Z"),
    rangeEnd: null,
    publishedRangeStart: null,
    publishedRangeEnd: null,
    isCustomRange: false,
    ...overrides,
  };
}

describe("feed service cache keys", () => {
  beforeEach(() => {
    cacheKeys.length = 0;
    cacheTtls.length = 0;
    newsSitemapCalls.length = 0;
  });

  it("uses a stable cache key for rolling created-time ranges", async () => {
    await getCachedFeedItems(buildFilters({ rangeStart: new Date("2026-04-07T12:00:00.000Z") }), { page: 1, size: 50 });
    await getCachedFeedItems(buildFilters({ rangeStart: new Date("2026-04-07T12:00:02.500Z") }), { page: 1, size: 50 });

    expect(cacheKeys).toHaveLength(2);
    expect(cacheKeys[1]).toBe(cacheKeys[0]);
    expect(cacheKeys[0]).toContain('"rangeStart":"range:3d"');
  });

  it("caches news sitemap queries by rounded window and result limit", async () => {
    const since = new Date("2026-04-09T00:00:00.000Z");
    await getCachedNewsSitemapItems(since, 1000);
    await getCachedNewsSitemapItems(new Date(since.getTime() + 20_000), 1000);
    await getCachedNewsSitemapItems(new Date(since.getTime() + 20_000), 500);

    expect(cacheKeys[0]).toBe(cacheKeys[1]);
    expect(cacheKeys[2]).not.toBe(cacheKeys[0]);
    expect(cacheKeys[0]).toContain("feed:news-sitemap:");
    expect(cacheTtls).toEqual([30_000, 30_000, 30_000]);
    expect(newsSitemapCalls.map((call) => call.limit)).toEqual([1000, 1000, 500]);
  });

  it("keeps custom created-time ranges separated by their explicit boundaries", async () => {
    await getCachedFeedItems(
      buildFilters({
        range: "today",
        start: "2026-04-07",
        end: null,
        rangeStart: new Date("2026-04-07T08:00:00.000Z"),
        isCustomRange: true,
      }),
      { page: 1, size: 50 },
    );
    await getCachedFeedItems(
      buildFilters({
        range: "today",
        start: "2026-04-08",
        end: null,
        rangeStart: new Date("2026-04-08T08:00:00.000Z"),
        isCustomRange: true,
      }),
      { page: 1, size: 50 },
    );

    expect(cacheKeys).toHaveLength(2);
    expect(cacheKeys[1]).not.toBe(cacheKeys[0]);
    expect(cacheKeys[0]).toContain('"rangeStart":"2026-04-07T08:00:00.000Z"');
    expect(cacheKeys[1]).toContain('"rangeStart":"2026-04-08T08:00:00.000Z"');
  });
});
