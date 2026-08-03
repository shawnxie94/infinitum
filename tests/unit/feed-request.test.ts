import { describe, expect, it } from "vitest";

import { resolveFeedRequest } from "@/lib/feed/request";

describe("feed request parsing", () => {
  it("keeps today as the default range when no advanced filter is present", () => {
    const now = new Date("2026-04-10T16:45:00.000Z");

    expect(resolveFeedRequest({}, now).filters.range).toBe("today");
  });

  it("defaults to all when advanced filters are present without an explicit created time filter", () => {
    const now = new Date("2026-04-10T16:45:00.000Z");

    expect(resolveFeedRequest({ title: "Agent" }, now).filters.range).toBe("all");
    expect(resolveFeedRequest({ sourceId: "source-1" }, now).filters.range).toBe("all");
    expect(resolveFeedRequest({ publishedStart: "2026-04-01" }, now).filters.range).toBe("all");
    expect(resolveFeedRequest({ entryKeys: "single:item-a,cluster:cluster-a" }, now).filters.range).toBe("all");
  });

  it("prefers a valid explicit range over the advanced-filter default", () => {
    const now = new Date("2026-04-10T16:45:00.000Z");

    expect(resolveFeedRequest({ range: "7d", title: "Agent" }, now).filters.range).toBe("7d");
  });


  it("normalizes multi-entry filters", () => {
    const now = new Date("2026-04-10T16:45:00.000Z");

    expect(resolveFeedRequest({ entryKeys: " single:item-a ,bad-key,single:item-a,cluster:cluster-a " }, now).filters.entryKeys)
      .toEqual(["single:item-a", "cluster:cluster-a"]);
  });

});
