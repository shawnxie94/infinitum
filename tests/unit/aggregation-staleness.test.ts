import { describe, expect, it } from "vitest";

import { evaluateAggregationChildStaleness } from "@/lib/aggregation/staleness";

const baseline = new Date("2026-10-08T00:00:00.000Z");

function child(overrides: Partial<Parameters<typeof evaluateAggregationChildStaleness>[0]> = {}) {
  return evaluateAggregationChildStaleness({
    eventDate: "2024-03-15",
    publishedAt: baseline,
    publishedAtKnown: true,
    restoredByAdminAt: null,
    originalTitle: "Child event",
    summaryText: "The child event occurred on 2024-03-15.",
    rssContent: "child text",
    rssExcerpt: null,
    fullText: null,
    referenceAt: baseline,
    ...overrides,
  });
}

describe("aggregation child staleness", () => {
  it("uses the child's own full eventDate evidence", () => {
    expect(child().stale).toBe(true);
    expect(child({ eventDate: "2026-10-01", summaryText: "The child event occurred on 2026-10-01." }).stale).toBe(false);
  });

  it("preserves missing/unknown child dates and administrator-restored children", () => {
    expect(child({ eventDate: null }).skipReason).toBe("no_event_date");
    expect(child({ restoredByAdminAt: baseline }).skipReason).toBe("restored_by_admin");
  });

  it("does not filter when child-owned text has no date evidence", () => {
    expect(child({
      originalTitle: "A different company launched an unrelated product",
      summaryText: "The child text does not mention the event date.",
      rssContent: null,
      eventDate: "2024-03-15",
    }).stale).toBe(false);
  });

  it("requires the complete child eventDate rather than a same-year date", () => {
    expect(child({ summaryText: "The child event occurred on 2024-03-14." }).stale).toBe(false);
  });
});
