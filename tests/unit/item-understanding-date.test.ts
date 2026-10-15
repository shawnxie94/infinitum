import { describe, expect, it } from "vitest";

import { parseItemUnderstandingOutput, getFallbackUnderstanding } from "@/lib/ai/protocols/item-understanding";

function parseDate(eventDate: string | null) {
  const fallback = getFallbackUnderstanding({ title: "Title", translateTitle: false });
  const result = parseItemUnderstandingOutput(JSON.stringify({
    summary: "Summary",
    moderationStatus: "allowed",
    qualityScore: 50,
    qualityRationale: "ok",
    eventSignature: { eventType: "release", eventSubject: "OpenAI", eventAction: "发布", eventObject: "Agent SDK", eventDate },
    aggregation: { isAggregation: false, events: [] },
  }), `OpenAI 发布 Agent SDK，日期为 ${eventDate}。`, fallback, false, 20);
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
