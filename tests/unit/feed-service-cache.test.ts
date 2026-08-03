import { beforeEach, describe, expect, it, vi } from "vitest";

const { cacheKeys } = vi.hoisted(() => ({
  cacheKeys: [] as string[],
}));

vi.mock("@/lib/feed/cache", () => ({
  withFeedCache: vi.fn(async (key: string, loader: () => Promise<unknown>) => {
    cacheKeys.push(key);
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
  countDisplayItemsCreatedDuringFetchRun: vi.fn(async () => 0),
  toFetchRunSnapshot: vi.fn(() => null),
}));

const { getCachedFeedItems } = await import("@/lib/feed/service");

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
    entity: "ai",
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
  });

  it("uses a stable cache key for rolling created-time ranges", async () => {
    await getCachedFeedItems(buildFilters({ rangeStart: new Date("2026-04-07T12:00:00.000Z") }), { page: 1, size: 50 });
    await getCachedFeedItems(buildFilters({ rangeStart: new Date("2026-04-07T12:00:02.500Z") }), { page: 1, size: 50 });

    expect(cacheKeys).toHaveLength(2);
    expect(cacheKeys[1]).toBe(cacheKeys[0]);
    expect(cacheKeys[0]).toContain('"rangeStart":"range:3d"');
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
