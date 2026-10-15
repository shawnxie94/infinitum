import { describe, expect, it } from "vitest";

import { parseItemUnderstandingOutput, getFallbackUnderstanding } from "@/lib/ai/protocols/item-understanding";

function parseDate(eventDate: string | null, publishedAt?: string | null) {
  const fallback = getFallbackUnderstanding({ title: "Title", translateTitle: false });
  const result = parseItemUnderstandingOutput(JSON.stringify({
    summary: "Summary",
    moderationStatus: "allowed",
    qualityScore: 50,
    qualityRationale: "ok",
    eventSignature: { eventType: "release", eventSubject: "OpenAI", eventAction: "发布", eventObject: "Agent SDK", eventDate },
    aggregation: { isAggregation: false, events: [] },
  }), `OpenAI 发布 Agent SDK，日期为 ${eventDate}。`, fallback, false, 20, null, publishedAt);
  return result.eventSignature.eventDate;
}

describe("item understanding event date calendar validation", () => {
  it.each(["2025-02-30", "2025-02-29", "2024-02-30", "0100-02-29", "1900-02-29", "2025-04-31", "0000-01-01", "2025-13-01", "2025-00-01", "2025-01-32", "2025-01-00"])(
    "rejects invalid date %s", (date) => expect(parseDate(date)).toBeNull(),
  );

  it.each(["0096-02-29", "2000-02-29", "0400-02-29", "2025-10-15", "1900-03-01", "2099-12-31"])(
    "accepts valid date %s", (date) => expect(parseDate(date)).toBe(date),
  );

  it.each([null, "", "  ", "2025-10", "2025/10/15", "2025年10月15日"])("keeps strict parser behavior for %s", (date) => {
    expect(parseDate(date)).toBeNull();
  });

  it("trims surrounding whitespace around a valid strict date", () => {
    expect(parseDate("  2025-10-15  ")).toBe("2025-10-15");
  });
});

describe("event date distance from article publication", () => {
  it.each(["2026-07-01", "2026-07-02", "2026-01-02", "2026-12-28"])(
    "preserves %s within the inclusive 180-day window", (date) => {
      expect(parseDate(date, "2026-07-01")).toBe(date);
    },
  );

  it.each(["2026-01-01", "2026-12-29", "2025-07-01", "2027-07-01"])(
    "clears %s more than 180 days before or after publication", (date) => {
      expect(parseDate(date, "2026-07-01")).toBeNull();
    },
  );

  it("uses the article date rather than the current clock for historical articles", () => {
    expect(parseDate("2000-02-29", "2000-03-01")).toBe("2000-02-29");
    expect(parseDate("0096-02-29", "0096-03-01")).toBe("0096-02-29");
  });

  it.each([undefined, null, "", "not-a-date", "2026-02-30"])(
    "only validates the calendar when publication date is unavailable or invalid: %s", (publishedAt) => {
      expect(parseDate("2025-10-15", publishedAt)).toBe("2025-10-15");
      expect(parseDate("2025-02-30", publishedAt)).toBeNull();
    },
  );
});
