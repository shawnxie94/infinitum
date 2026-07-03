import { describe, expect, it } from "vitest";

import { getEventBriefingDateRange } from "@/lib/events/date";
import { compressBehaviorNetScore, getCuratorBehaviorScore } from "@/lib/curator-behavior/service";
import { calculateCuratorPreference } from "@/lib/events/preferences";
import type { EventBriefingCandidate } from "@/lib/events/types";

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
    tags: [{ name: "AI Coding", normalized: "ai-coding" }],
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

  it("adds capped site-level curator boosts and penalties without hard filtering", () => {
    const result = calculateCuratorPreference(buildCandidate(), {
      id: "preference",
      weightedRules: [
        { type: "tag", value: "AI Coding", weight: 6 },
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
