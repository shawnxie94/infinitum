import { describe, expect, it } from "vitest";

import { parseItemUnderstandingOutput } from "@/lib/ai/protocols/item-understanding";
import { buildEnabledEventTypeResolver } from "@/lib/event-types/resolve";
import { toRegistrySnapshot } from "@/lib/event-types/validation";
import type { ItemUnderstandingResult } from "@/lib/ai/provider-types";

function makeResolver() {
  const snapshot = toRegistrySnapshot([
    { id: "1", key: "finance", label: "财经", description: "财经与经济数据", aliasesJson: JSON.stringify(["经济数据"]), enabled: true, sortOrder: 0 },
    { id: "2", key: "release", label: "版本发布", description: null, aliasesJson: "[]", enabled: true, sortOrder: 1 },
    { id: "3", key: "other", label: "其他", description: null, aliasesJson: "[]", enabled: true, sortOrder: 2 },
    { id: "4", key: "legacy", label: "旧类型", description: null, aliasesJson: "[]", enabled: false, sortOrder: 3 },
  ]);
  return buildEnabledEventTypeResolver(snapshot);
}

function fallback(): ItemUnderstandingResult {
  return {
    translatedTitle: null,
    moderationStatus: "allowed",
    moderationReason: null,
    moderationDetail: null,
    qualityScore: 50,
    qualityRationale: "fallback",
    eventSignature: { eventType: null, eventSubject: null, eventAction: null, eventObject: null, eventDate: null },
    summary: "",
    aggregation: { isAggregation: false, mainEvent: null, events: [] },
    diagnostics: { summaryValid: true, analysisValid: true, aggregationValid: true },
  };
}

function output(eventType: unknown, events: Array<{ eventType: unknown; title: string }> = []) {
  return JSON.stringify({
    summary: "这是一个足够长的示例摘要，覆盖主体、动作和关键结果，用于通过摘要校验长度要求，包含二十个字以上。",
    translatedTitle: "",
    moderationStatus: "allowed",
    moderationReason: null,
    moderationDetail: null,
    qualityScore: 80,
    qualityBreakdown: [{ name: "事实密度", score: 80 }],
    qualityRationale: "事实充分",
    eventSignature: {
      eventType,
      eventSubject: "某公司",
      eventAction: "发布",
      eventObject: "产品",
      eventDate: null,
    },
    aggregation: {
      isAggregation: events.length > 0,
      mainEvent: null,
      events: events.map((event) => ({
        eventType: event.eventType,
        eventSubject: "主体",
        eventAction: "动作",
        eventObject: "对象",
        eventDate: null,
        title: event.title,
        oneLiner: "子事件摘要，长度足够用于校验通过的一百字内容 filler filler filler filler filler filler filler",
        qualityScore: 80,
        qualityBreakdown: [{ name: "事实密度", score: 80 }],
        sourceUrl: null,
      })),
    },
  });
}

describe("item understanding event type registry parsing", () => {
  it("maps aliases and keys to canonical keys", () => {
    const result = parseItemUnderstandingOutput(
      output("经济数据"), "input", fallback(), false, 20, null, null, makeResolver(),
    );
    expect(result.eventSignature.eventType).toBe("finance");
    expect(result.eventSignature.eventTypeRaw ?? null).toBeNull();
  });

  it("maps unknown and disabled outputs to other and preserves the raw value", () => {
    const unknown = parseItemUnderstandingOutput(
      output("funding_round"), "input", fallback(), false, 20, null, null, makeResolver(),
    );
    expect(unknown.eventSignature.eventType).toBe("other");
    expect(unknown.eventSignature.eventTypeRaw).toBe("funding_round");

    const disabled = parseItemUnderstandingOutput(
      output("legacy"), "input", fallback(), false, 20, null, null, makeResolver(),
    );
    expect(disabled.eventSignature.eventType).toBe("other");
    expect(disabled.eventSignature.eventTypeRaw).toBe("legacy");
  });

  it("keeps genuinely missing event types null", () => {
    const result = parseItemUnderstandingOutput(
      output(null), "input", fallback(), false, 20, null, null, makeResolver(),
    );
    expect(result.eventSignature.eventType).toBeNull();
    expect(result.eventSignature.eventTypeRaw ?? null).toBeNull();
  });

  it("normalizes aggregation child events through the same registry", () => {
    const result = parseItemUnderstandingOutput(
      output("release", [{ eventType: "funding_round", title: "子事件" }]),
      "input", fallback(), false, 20, null, null, makeResolver(),
    );
    expect(result.aggregation.events[0]?.eventType).toBe("other");
    expect(result.aggregation.events[0]?.eventTypeRaw).toBe("funding_round");
  });

  it("without a registry falls back to the legacy ten defaults", () => {
    const matched = parseItemUnderstandingOutput(
      output("release"), "input", fallback(), false, 20, null, null, null,
    );
    expect(matched.eventSignature.eventType).toBe("release");
    expect(matched.eventSignature.eventTypeRaw ?? null).toBeNull();

    const unknown = parseItemUnderstandingOutput(
      output("funding_round"), "input", fallback(), false, 20, null, null, null,
    );
    expect(unknown.eventSignature.eventType).toBe("other");
    expect(unknown.eventSignature.eventTypeRaw).toBe("funding_round");
  });
});
