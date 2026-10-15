import { describe, expect, it } from "vitest";

import { getFallbackUnderstanding, parseItemUnderstandingOutput } from "@/lib/ai/protocols/item-understanding";
import type { ParsedEvent } from "@/lib/ai/provider-types";
import type { QualityRubric } from "@/lib/ai/quality-rubric";
import { areEventDatesExactlyEqual } from "@/lib/clusters/normalization";

// Development fixtures, not historical model responses or independent relation gold.
const empty = () => getFallbackUnderstanding({ title: "", translateTitle: false });
const sig = (eventDate: unknown, eventAction = "发布", eventObject: unknown = "Nova", eventSubject = "Alpha") => ({
  eventType: "release", eventSubject, eventAction, eventObject, eventDate,
});
function parsePayload(
  source: string,
  payload: Record<string, unknown>,
  title = "",
  fallback = empty(),
  rubric: QualityRubric | null = null,
) {
  return parseItemUnderstandingOutput(JSON.stringify({
    summary: "Useful summary retained.", moderationStatus: "allowed", qualityScore: 80, qualityRationale: "ok",
    aggregation: { isAggregation: false, events: [] }, ...payload,
  }), source, fallback, false, 20, rubric, title);
}
function parse(source: string, fields: Record<string, unknown>, title = "", fallback = empty()) {
  return parsePayload(source, { eventSignature: fields }, title, fallback);
}
function childEvent(): ParsedEvent {
  return {
    eventType: "release", eventSubject: "Alpha", eventAction: "发布", eventObject: "Nova", eventDate: "2026-07-11",
    title: "generated title", oneLiner: "summary", qualityScore: 80, qualityBreakdown: [], sourceUrl: null,
  };
}

describe("source evidence for event fields", () => {
  it("supports original-title-only evidence", () => {
    expect(parse("", sig("2026-07-11"), "Alpha于2026-07-11发布Nova").eventSignature.eventDate).toBe("2026-07-11");
  });

  it.each([
    ["Alpha于2026年7月11日发布Nova。", "Alpha"],
    ["Alpha于2026/7/11发布Nova。", "Alpha"],
    ["阶跃星辰于2026.7.11发布Nova。", "阶跃星辰"],
  ])("supports adjacent Chinese tokens and absolute dates: %s", (text, subject) => {
    expect(parse(text, sig("2026-07-11", "发布", "Nova", subject)).eventSignature.eventDate).toBe("2026-07-11");
  });

  it.each([
    ["Alpha released Nova. Beta launched Other on 2026-07-11.", "released"],
    ["Alpha发布Nova。Beta于2026-07-11发布Other。", "发布"],
    ["Alpha发布Nova\nBeta于2026-07-11发布Other", "发布"],
    ["Alpha于2020-01-01成立后在2026-07-11发布Nova。", "发布"],
    ["Alpha发布Nova，日期为2026-07-11但该日期只是占位值。", "发布"],
  ])("does not borrow an ambiguous or unsupported date: %s", (source, action) => {
    expect(parse(source, sig("2026-07-11", action)).eventSignature.eventDate).toBeNull();
  });

  it("does not borrow future weights date for the current API-opening phase", () => {
    const source = "Alpha于2026年7月11日发布Nova，完整权重计划2026年10月15日发布。";
    expect(parse(source, sig("2026-10-15")).eventSignature.eventDate).toBeNull();
    expect(parse(source, sig("2026-07-11")).eventSignature.eventDate).toBe("2026-07-11");
    expect(parse("今天Nova的API已经开放，10月15日还将发布完整权重。", sig("2025-10-15")).eventSignature.eventDate).toBeNull();
  });

  it("distinguishes a future plan from an already-completed release", () => {
    const source = "Alpha计划于2030年10月15日发布Nova。";
    expect(parse(source, sig("2030-10-15", "发布")).eventSignature.eventDate).toBeNull();
    expect(parse(source, sig("2030-10-15", "计划发布")).eventSignature.eventDate).toBe("2030-10-15");
  });

  it("does not discard independently supported dates because of unrelated context", () => {
    for (const suffix of ["Beta于2020-01-01上线Other。", "Beta never launched Other。"])
      expect(parse(`Alpha于2026-07-11发布Nova。${suffix}`, sig("2026-07-11")).eventSignature.eventDate).toBe("2026-07-11");
    expect(parse("Alpha发布Nova，日期为2026-07-11。", sig("2026-07-11")).eventSignature.eventDate).toBe("2026-07-11");
    expect(parse("Alpha于2026-07-11发布Nova。", sig("2026-07-11"), "Alpha于2026-07-11发布Nova").eventSignature.eventDate).toBe("2026-07-11");
  });

  it.each(["0096-02-29", "2000-02-29", "0400-02-29", "2099-12-31"])("preserves supported historical/future date %s", (date) => {
    expect(parse(`Alpha于${date}发布Nova。`, sig(date)).eventSignature.eventDate).toBe(date);
  });

  it("rejects placeholder, year conflict and missing-year candidates without guessing", () => {
    expect(parse("Alpha把9999-12-31设为Nova发布的占位日期。", sig("9999-12-31")).eventSignature.eventDate).toBeNull();
    expect(parse("Alpha于2026年7月11日发布Nova。", sig("2025-07-11")).eventSignature.eventDate).toBeNull();
    expect(parse("Alpha计划于10月15日发布Nova。", sig("2026-10-15", "计划发布")).eventSignature.eventDate).toBeNull();
  });

  it("does not promote competition context or unnamed generic objects to identity anchors", () => {
    const source = "Alpha发布Nova以应对Beta的Astra竞争。";
    expect(parse(source, sig(null, "发布", "Astra")).eventSignature.eventObject).toBeNull();
    expect(parse(source, sig(null)).eventSignature.eventObject).toBe("Nova");
    expect(parse("Alpha发布一款全新AI模型。", sig(null, "发布", "全新AI模型")).eventSignature.eventObject).toBeNull();
    expect(parse("Alpha宣布收购Beta公司。", sig(null, "收购", "Beta公司")).eventSignature.eventObject).toBe("Beta公司");
  });

  it.each([null, "", "2025-02-30", 42])("does not revive explicitly rejected flat or nested fields: %s", (value) => {
    for (const payload of [
      { eventDate: value, eventObject: null },
      { eventSignature: { eventDate: value, eventObject: null } },
    ]) {
      const fallback = empty();
      fallback.eventSignature = { ...fallback.eventSignature, eventSubject: "Alpha", eventAction: "发布", eventObject: "Nova", eventDate: "2026-07-11" };
      const before = structuredClone(fallback);
      const result = parsePayload("Alpha于2026-07-11发布Nova。", payload, "", fallback);
      expect(result.eventSignature.eventDate).toBeNull();
      expect(result.eventSignature.eventObject).toBeNull();
      expect(fallback).toEqual(before);
    }
  });

  it("clears aggregation fields after structural checks without deleting accepted events", () => {
    const child = childEvent();
    const result = parsePayload("Alpha发布一个模型。", { aggregation: { isAggregation: true, mainEvent: child, events: [child] } });
    expect(result.aggregation.events).toHaveLength(1);
    expect(result.aggregation.events[0]?.eventDate).toBeNull();
    expect(result.aggregation.events[0]?.eventObject).toBeNull();
    expect(result.aggregation.mainEvent?.eventDate).toBeNull();
    expect(result.aggregation.mainEvent?.eventObject).toBeNull();
    expect(result.summary).toBe("Useful summary retained.");
    expect(result.diagnostics).toMatchObject({ analysisValid: true, aggregationValid: true });
  });

  it("sanitizes fallback aggregation without mutating or reusing its objects", () => {
    const child = childEvent();
    const fallback = empty();
    fallback.aggregation = { isAggregation: true, mainEvent: child, events: [child] };
    const before = structuredClone(fallback);
    const result = parsePayload("Alpha发布Nova。", { aggregation: {} }, "", fallback);
    expect(result.aggregation.events).toHaveLength(1);
    expect(result.aggregation.events[0]?.eventDate).toBeNull();
    expect(result.aggregation.mainEvent?.eventDate).toBeNull();
    expect(result.aggregation.events[0]).not.toBe(child);
    expect(fallback).toEqual(before);
  });

  it("computes rubric scores before checking aggregation completeness", () => {
    const rubric: QualityRubric = { kind: "quality_rubric", dimensions: [{
      name: "信息", points: 100, description: "事实完整度",
      levels: [{ score: 100, description: "完整" }, { score: 0, description: "缺失" }],
    }] };
    const child = { ...sig("2026-07-11"), title: "Nova发布", oneLiner: "产品发布事件", qualityBreakdown: [{ name: "信息", score: 100 }] };
    const result = parsePayload("Alpha于2026-07-11发布Nova。", {
      aggregation: { isAggregation: true, events: [child] },
    }, "", empty(), rubric);
    expect(result.aggregation.events).toHaveLength(1);
    expect(result.aggregation.events[0]?.qualityScore).toBe(100);
    expect(result.aggregation.events[0]?.eventDate).toBe("2026-07-11");
  });

  it("still rejects structurally incomplete events after normalization", () => {
    const result = parsePayload("Alpha于2026-07-11发布Nova。", {
      aggregation: { isAggregation: true, events: [childEvent(), { ...childEvent(), eventSubject: "  " }] },
    });
    expect(result.aggregation.events).toHaveLength(1);
  });

  it("clears malformed aggregation dates instead of throwing or retrying", () => {
    const child = { ...childEvent(), eventDate: 42 };
    const result = parsePayload("Alpha发布Nova。", { aggregation: { isAggregation: true, mainEvent: child, events: [child] } });
    expect(result.aggregation.mainEvent?.eventDate).toBeNull();
    expect(result.aggregation.events[0]?.eventDate).toBeNull();
    expect(result.diagnostics.aggregationValid).toBe(true);
  });

  it("does not treat generated event titles as source evidence or unknown dates as equal", () => {
    const child = { ...childEvent(), title: "Alpha于2026-07-11发布Nova" };
    const result = parsePayload("没有相关原文证据。", { aggregation: { isAggregation: true, events: [child] } });
    expect(result.aggregation.events).toHaveLength(1);
    expect(result.aggregation.events[0]?.eventDate).toBeNull();
    expect(areEventDatesExactlyEqual(null, null)).toBe(false);
    expect(areEventDatesExactlyEqual(null, "2026-07-11")).toBe(false);
  });
});
