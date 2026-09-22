import { describe, expect, it } from "vitest";

import { getEventBriefingDateRange } from "@/lib/events/date";
import { compressBehaviorNetScore, getCuratorBehaviorScore } from "@/lib/curator-behavior/service";
import { calculateCuratorPreference } from "@/lib/events/preferences";
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

  it("uses a stable id tie-breaker when ranked entries otherwise match", () => {
    const common = {
      type: "single",
      rankScore: 80,
      baseRankScore: 80,
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

  it("adds capped site-level curator boosts and penalties without hard filtering", () => {
    const result = calculateCuratorPreference(buildCandidate(), {
      id: "preference",
      weightedRules: [
        { type: "entity", value: "AI Coding", weight: 6 },
        { type: "source_group", value: "group-1", weight: 5 },
        { type: "keyword", value: "OpenAI", weight: 5 },
        { type: "event_type", value: "launch", weight: 9 },
        { type: "keyword", value: "agent", weight: -8 },
      ],
      maxCuratorBoost: 10,
      maxCuratorPenalty: 8,
      createdAt: "2026-06-30T00:00:00.000Z",
      updatedAt: "2026-06-30T00:00:00.000Z",
    });

    expect(result.curatorBoost).toBe(10);
    expect(result.curatorPenalty).toBe(8);
  });

  it("compresses behavior evidence into small suggested rule weights", () => {
    expect(getCuratorBehaviorScore("event_source_clicked")).toBe(2);
    expect(getCuratorBehaviorScore("cluster_hidden")).toBe(-5);
    expect(compressBehaviorNetScore(1)).toBe(1);
    expect(compressBehaviorNetScore(6)).toBe(2);
    expect(compressBehaviorNetScore(7)).toBe(3);
    expect(compressBehaviorNetScore(-3)).toBe(-2);
    expect(compressBehaviorNetScore(0)).toBe(0);
  });
});
