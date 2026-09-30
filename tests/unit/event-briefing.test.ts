import { describe, expect, it } from "vitest";

import { getEventBriefingDateRange } from "@/lib/events/date";
import {
  calculateEventBriefingBaseRankScore,
  createEventBriefingRankContext,
  sortEventBriefingEntries,
} from "@/lib/events/service";
import type { EventBriefingCandidate, EventBriefingEntryDTO } from "@/lib/events/types";

function buildCandidate(overrides: Partial<EventBriefingCandidate> = {}): EventBriefingCandidate {
  return {
    id: "candidate-1",
    type: "cluster",
    title: "OpenAI 发布 Agent 工具",
    summary: "OpenAI 发布面向 AI Coding 的 Agent 工具。",
    qualityScore: 80,
    sourceCount: 2,
    itemCount: 3,
    newItemCountOnDate: 1,
    newSourceCountOnDate: 1,
    latestCreatedAt: new Date("2026-06-30T08:00:00.000Z"),
    latestPublishedAt: new Date("2026-06-30T07:50:00.000Z"),
    earliestCreatedAt: new Date("2026-06-29T08:00:00.000Z"),
    representativeUrl: "https://example.com/openai-agent",
    eventType: "launch",
    eventSubject: "OpenAI",
    eventAction: "launches",
    eventObject: "Agent tools",
    eventDate: "2026-06-30",
    isFollowUp: true,
    entities: [{ name: "AI Coding", normalized: "ai-coding" }],
    sources: [
      { id: "source-1", name: "OpenAI Blog", groupId: "group-1" },
      { id: "source-2", name: "Tech Media", groupId: null },
    ],
    items: [
      {
        id: "item-1",
        title: "OpenAI 发布 Agent 工具",
        summary: "OpenAI 发布面向 AI Coding 的 Agent 工具。",
        sourceName: "OpenAI Blog",
        originalUrl: "https://example.com/openai-agent",
        publishedAt: new Date("2026-06-30T07:50:00.000Z"),
        publishedAtKnown: true,
        createdAt: new Date("2026-06-30T08:00:00.000Z"),
        qualityScore: 80,
      },
    ],
    searchText: "openai agent ai coding launch",
    ...overrides,
  };
}

describe("event briefing helpers", () => {
  it("uses Asia/Shanghai createdAt day boundaries", () => {
    const range = getEventBriefingDateRange("2026-06-30");

    expect(range.date).toBe("2026-06-30");
    expect(range.start.toISOString()).toBe("2026-06-29T16:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-06-30T16:00:00.000Z");
  });

  it("gives bounded priority to same-day evidence and freshness", () => {
    const range = getEventBriefingDateRange("2026-06-30");
    const baseline = buildCandidate({
      newItemCountOnDate: 1,
      newSourceCountOnDate: 1,
      latestCreatedAt: new Date("2026-06-29T16:30:00.000Z"),
    });
    const fresher = buildCandidate({
      newItemCountOnDate: 3,
      newSourceCountOnDate: 3,
      latestCreatedAt: new Date("2026-06-30T15:30:00.000Z"),
    });

    expect(calculateEventBriefingBaseRankScore(fresher, range)).toBeGreaterThan(
      calculateEventBriefingBaseRankScore(baseline, range),
    );
    expect(
      calculateEventBriefingBaseRankScore(fresher, range) - calculateEventBriefingBaseRankScore(baseline, range),
    ).toBeLessThanOrEqual(8);
  });

  it("keeps historical event volume from overpowering current-day momentum", () => {
    const range = getEventBriefingDateRange("2026-06-30");
    const established = buildCandidate({ sourceCount: 50, itemCount: 100 });
    const smaller = buildCandidate({ sourceCount: 2, itemCount: 2 });

    expect(
      calculateEventBriefingBaseRankScore(established, range) -
        calculateEventBriefingBaseRankScore(smaller, range),
    ).toBe(5);
  });

  it("blends candidate-set relative scores to smooth fixed thresholds", () => {
    const range = getEventBriefingDateRange("2026-06-30");
    const low = buildCandidate({ itemCount: 2 });
    const middle = buildCandidate({ itemCount: 3 });
    const high = buildCandidate({ itemCount: 4 });
    const context = createEventBriefingRankContext([low, middle, high]);

    expect(calculateEventBriefingBaseRankScore(middle, range, context)).toBeGreaterThan(
      calculateEventBriefingBaseRankScore(low, range, context),
    );
    expect(calculateEventBriefingBaseRankScore(high, range, context)).toBeGreaterThan(
      calculateEventBriefingBaseRankScore(middle, range, context),
    );
  });

  it("ranks purely on the universal score without any preference fields", () => {
    const range = getEventBriefingDateRange("2026-06-30");
    const candidate = buildCandidate();
    const score = calculateEventBriefingBaseRankScore(candidate, range);
    const range2 = getEventBriefingDateRange("2026-06-30");
    const entry = {
      id: candidate.id,
      type: candidate.type,
      title: candidate.title,
      summary: candidate.summary,
      qualityScore: candidate.qualityScore,
      rankScore: score,
      isFollowUp: candidate.isFollowUp,
      sourceCount: candidate.sourceCount,
      itemCount: candidate.itemCount,
      newItemCountOnDate: candidate.newItemCountOnDate,
      newSourceCountOnDate: candidate.newSourceCountOnDate,
      latestCreatedAt: candidate.latestCreatedAt.toISOString(),
      latestPublishedAt: candidate.latestPublishedAt.toISOString(),
      eventType: candidate.eventType,
      eventSubject: candidate.eventSubject,
      eventAction: candidate.eventAction,
      eventObject: candidate.eventObject,
      eventDate: candidate.eventDate,
      detailHref: "",
      items: [],
    } as EventBriefingEntryDTO;

    expect(entry.rankScore).toBe(score);
    expect(entry).not.toHaveProperty("curatorBoost");
    expect(entry).not.toHaveProperty("curatorPenalty");
    expect(entry).not.toHaveProperty("baseRankScore");
    expect(range2.date).toBe(range.date);
  });

  it("uses a stable id tie-breaker when ranked entries otherwise match", () => {
    const common = {
      type: "single",
      rankScore: 80,
      latestCreatedAt: "2026-06-30T08:00:00.000Z",
    } as const;
    const entries = [
      { ...common, id: "event-b" } as EventBriefingEntryDTO,
      { ...common, id: "event-a" } as EventBriefingEntryDTO,
    ];

    expect(entries.sort(sortEventBriefingEntries).map((entry) => entry.id)).toEqual([
      "event-a",
      "event-b",
    ]);
  });

  it("penalizes delayed publication without changing the createdAt inclusion boundary", () => {
    const range = getEventBriefingDateRange("2026-06-30");
    const baseItem = buildCandidate().items[0]!;
    const onTime = buildCandidate({
      latestCreatedAt: new Date("2026-06-30T08:00:00.000Z"),
      latestPublishedAt: new Date("2026-06-30T00:00:00.000Z"),
      items: [{ ...baseItem, createdAt: new Date("2026-06-30T08:00:00.000Z"), publishedAt: new Date("2026-06-30T00:00:00.000Z") }],
    });
    const delayed = buildCandidate({
      latestCreatedAt: new Date("2026-06-30T08:00:00.000Z"),
      latestPublishedAt: new Date("2026-06-28T08:00:00.000Z"),
      items: [{ ...baseItem, createdAt: new Date("2026-06-30T08:00:00.000Z"), publishedAt: new Date("2026-06-28T08:00:00.000Z") }],
    });
    const futurePublished = buildCandidate({
      latestCreatedAt: new Date("2026-06-30T08:00:00.000Z"),
      latestPublishedAt: new Date("2026-06-30T12:00:00.000Z"),
      items: [{ ...baseItem, createdAt: new Date("2026-06-30T08:00:00.000Z"), publishedAt: new Date("2026-06-30T12:00:00.000Z") }],
    });

    expect(calculateEventBriefingBaseRankScore(delayed, range)).toBeLessThan(
      calculateEventBriefingBaseRankScore(onTime, range),
    );
    expect(calculateEventBriefingBaseRankScore(futurePublished, range)).toBe(
      calculateEventBriefingBaseRankScore(onTime, range),
    );
  });

  it("does not grant unknown publication timestamps a freshness bonus", () => {
    const range = getEventBriefingDateRange("2026-06-30");
    const known = buildCandidate({
      latestCreatedAt: new Date("2026-06-30T15:30:00.000Z"),
      items: [{
        ...buildCandidate().items[0]!,
        createdAt: new Date("2026-06-30T15:30:00.000Z"),
        publishedAtKnown: true,
      }],
    });
    const unknown = buildCandidate({
      latestCreatedAt: new Date("2026-06-30T15:30:00.000Z"),
      items: [{
        ...buildCandidate().items[0]!,
        createdAt: new Date("2026-06-30T15:30:00.000Z"),
        publishedAtKnown: false,
      }],
    });

    expect(calculateEventBriefingBaseRankScore(unknown, range)).toBeLessThan(
      calculateEventBriefingBaseRankScore(known, range),
    );
  });

});
