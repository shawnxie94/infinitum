import { describe, expect, it } from "vitest";

import { getFallbackUnderstanding, parseItemUnderstandingOutput } from "@/lib/ai/protocols/item-understanding";
import type { ParsedEvent } from "@/lib/ai/provider-types";
import type { QualityRubric } from "@/lib/ai/quality-rubric";

// Parser regression fixtures, not historical model responses or relation gold.
const empty = () => getFallbackUnderstanding({ title: "", translateTitle: false });
const sig = (eventDate: unknown, eventObject: unknown = "Nova") => ({
  eventType: "release", eventSubject: "Alpha", eventAction: "正式推出", eventObject, eventDate,
});
function parsePayload(
  payload: Record<string, unknown>,
  publishedAt: string | null = "2026-07-11",
  fallback = empty(),
  rubric: QualityRubric | null = null,
) {
  return parseItemUnderstandingOutput(JSON.stringify({
    summary: "Useful summary retained.", moderationStatus: "allowed", qualityScore: 80, qualityRationale: "ok",
    aggregation: { isAggregation: false, events: [] }, ...payload,
  }), "原文没有与模型动作逐字一致的句子。", fallback, false, 20, rubric, publishedAt);
}
function childEvent(): ParsedEvent {
  return {
    eventType: "release", eventSubject: "Alpha", eventAction: "正式推出", eventObject: "Nova", eventDate: "2026-07-11",
    title: "generated title", oneLiner: "summary", qualityScore: 80, qualityBreakdown: [], sourceUrl: null,
  };
}

describe("date-only sanitization leaves event descriptions unchanged", () => {
  it("preserves paraphrased subjects, actions and objects without literal source evidence", () => {
    const fields = sig("2026-07-11");
    const result = parsePayload({ eventSignature: fields });
    expect(result.eventSignature).toEqual(fields);
    expect(result.summary).toBe("Useful summary retained.");
    expect(result.diagnostics).toEqual({ analysisValid: true, summaryValid: true, aggregationValid: true });
  });

  it("does not clear the manual-revision object because its action is paraphrased", () => {
    const fields = { ...sig("2026-07-11", "少数派创作手册"), eventSubject: "少数派", eventAction: "修订并发布" };
    const result = parseItemUnderstandingOutput(JSON.stringify({
      summary: "创作手册说明更新后的标准。", moderationStatus: "allowed", qualityScore: 80, qualityRationale: "ok",
      eventSignature: fields, aggregation: { isAggregation: false, events: [] },
    }), "顺应变化，重申标准：《少数派创作手册》修订说明", empty(), false, 20, null, "2026-07-11");
    expect(result.eventSignature).toEqual(fields);
  });

  it.each(["Astra", "全新AI模型", "Beta公司"])("does not add an object semantics filter for %s", (object) => {
    expect(parsePayload({ eventSignature: sig(null, object) }).eventSignature.eventObject).toBe(object);
  });

  it("keeps a reasonable date even when the object, subject and action are absent", () => {
    const fields = { ...sig("2026-07-11", null), eventSubject: null, eventAction: null };
    expect(parsePayload({ eventSignature: fields }).eventSignature).toEqual(fields);
  });

  it.each(["2025-02-30", "2025-07-11", "2027-07-11"])("clears only the rejected date %s", (date) => {
    const fields = sig(date);
    expect(parsePayload({ eventSignature: fields }).eventSignature).toEqual({ ...fields, eventDate: null });
  });

  it("preserves month/day-derived and planned dates within the publication window", () => {
    const fields = { ...sig("2026-10-15"), eventAction: "计划发布" };
    expect(parsePayload({ eventSignature: fields }).eventSignature).toEqual(fields);
  });

  it.each([null, "", "2025-02-30", 42])("does not revive an explicitly rejected flat or nested date: %s", (value) => {
    for (const payload of [{ eventDate: value }, { eventSignature: { eventDate: value } }]) {
      const fallback = empty();
      fallback.eventSignature = {
        eventType: "release", eventSubject: "Alpha", eventAction: "正式推出", eventObject: "Nova", eventDate: "2026-07-11",
      };
      const before = structuredClone(fallback);
      const result = parsePayload(payload, "2026-07-11", fallback);
      expect(result.eventSignature.eventDate).toBeNull();
      expect(result.eventSignature.eventObject).toBe("Nova");
      expect(fallback).toEqual(before);
    }
  });

  it("retains reasonable fallback dates but rejects distant ones without mutating fallback", () => {
    const fallback = empty();
    fallback.eventSignature = {
      eventType: "release", eventSubject: "Alpha", eventAction: "正式推出", eventObject: "Nova", eventDate: "2026-07-11",
    };
    const before = structuredClone(fallback);
    expect(parsePayload({}, "2026-07-11", fallback).eventSignature).toEqual(before.eventSignature);
    expect(parsePayload({}, "2027-07-11", fallback).eventSignature).toEqual({ ...before.eventSignature, eventDate: null });
    expect(fallback).toEqual(before);
  });

  it("validates main-event and child dates independently without changing event objects or dropping children", () => {
    const child = childEvent();
    const far = { ...child, title: "far event", eventDate: "2027-07-11" };
    const invalid = { ...child, title: "invalid date", eventDate: "2026-02-30" };
    const result = parsePayload({ aggregation: { isAggregation: true, mainEvent: far, events: [child, far, invalid] } });
    expect(result.aggregation.events).toEqual([child, { ...far, eventDate: null }, { ...invalid, eventDate: null }]);
    expect(result.aggregation.mainEvent).toEqual({
      eventType: far.eventType, eventSubject: far.eventSubject, eventAction: far.eventAction,
      eventObject: far.eventObject, eventDate: null,
    });
    expect(result.diagnostics.aggregationValid).toBe(true);
  });

  it("sanitizes fallback aggregation dates without changing its descriptions or mutating it", () => {
    const child = { ...childEvent(), eventDate: "2027-07-11" };
    const fallback = empty();
    fallback.aggregation = { isAggregation: true, mainEvent: child, events: [child] };
    const before = structuredClone(fallback);
    const result = parsePayload({ aggregation: {} }, "2026-07-11", fallback);
    expect(result.aggregation.events).toEqual([{ ...child, eventDate: null }]);
    expect(result.aggregation.mainEvent).toEqual({ ...child, eventDate: null });
    expect(result.aggregation.events[0]).not.toBe(child);
    expect(fallback).toEqual(before);
  });

  it("computes rubric scores before checking aggregation completeness", () => {
    const rubric: QualityRubric = { kind: "quality_rubric", dimensions: [{
      name: "信息", points: 100, description: "事实完整度",
      levels: [{ score: 100, description: "完整" }, { score: 0, description: "缺失" }],
    }] };
    const child = { ...sig("2026-07-11"), title: "Nova发布", oneLiner: "产品发布事件", qualityBreakdown: [{ name: "信息", score: 100 }] };
    const result = parsePayload({ aggregation: { isAggregation: true, events: [child] } }, "2026-07-11", empty(), rubric);
    expect(result.aggregation.events).toHaveLength(1);
    expect(result.aggregation.events[0]?.qualityScore).toBe(100);
    expect(result.aggregation.events[0]?.eventDate).toBe("2026-07-11");
  });

  it("still rejects structurally incomplete events", () => {
    const child = childEvent();
    const result = parsePayload({ aggregation: { isAggregation: true, events: [child, { ...child, eventSubject: "  " }] } });
    expect(result.aggregation.events).toEqual([child]);
  });
});
