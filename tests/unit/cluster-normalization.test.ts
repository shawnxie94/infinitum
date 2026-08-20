import { describe, expect, it } from "vitest";

import {
  areEventDatesCompatible,
  areEventDatesCompatibleForClustering,
  areEventDatesExactlyEqual,
  getEventDatePrecision,
  normalizeEventActionForStorage,
  normalizeEventDateForStorage,
  normalizeEventObjectForStorage,
  normalizeEventSignatureForStorage,
  normalizeEventSubjectForStorage,
} from "@/lib/clusters/normalization";

describe("cluster normalization helpers", () => {
  it("removes low-signal company suffixes from subjects", () => {
    expect(normalizeEventSubjectForStorage("OpenAI 公司")).toBe("OpenAI");
    expect(normalizeEventSubjectForStorage("OpenAI, Inc.")).toBe("OpenAI");
    expect(normalizeEventSubjectForStorage("Microsoft 官方")).toBe("Microsoft");
  });

  it("collapses a small set of action aliases to stable values", () => {
    expect(normalizeEventActionForStorage("正式发布")).toBe("发布");
    expect(normalizeEventActionForStorage("宣布推出")).toBe("发布");
    expect(normalizeEventActionForStorage("完成融资")).toBe("融资");
  });

  it("lightly strips low-information object modifiers without over-merging", () => {
    expect(normalizeEventObjectForStorage("新版 Agents SDK 服务")).toBe("Agents SDK");
    expect(normalizeEventObjectForStorage("toolkit API")).toBe("toolkit API");
    expect(normalizeEventObjectForStorage("toolkit enterprise")).toBe("toolkit enterprise");
    expect(normalizeEventObjectForStorage("Phone (4b)")).toBe("Phone (4b)");
    expect(normalizeEventObjectForStorage("Phone（4b）手机")).toBe("Phone（4b）手机");
  });

  it("normalizes an event signature for storage without translating entities", () => {
    expect(
      normalizeEventSignatureForStorage({
        eventType: "launch",
        eventSubject: "OpenAI 公司",
        eventAction: "正式发布",
        eventObject: "新版 Agents SDK 服务",
        eventDate: "2026-04-10",
      }),
    ).toEqual({
      eventType: "launch",
      eventSubject: "OpenAI",
      eventAction: "发布",
      eventObject: "Agents SDK",
      eventDate: "2026-04-10",
    });
  });

  it("canonicalizes full, month-only, and year-only event dates", () => {
    expect(normalizeEventDateForStorage("2026/4/10")).toBe("2026-04-10");
    expect(normalizeEventDateForStorage("2026年4月10日")).toBe("2026-04-10");
    expect(normalizeEventDateForStorage("2026-4")).toBe("2026-04");
    expect(normalizeEventDateForStorage("2026年")).toBe("2026");
    expect(normalizeEventDateForStorage("2026-02-30")).toBe("2026-02-30");
    expect(getEventDatePrecision("2026/4/10")).toBe("day");
    expect(getEventDatePrecision("2026-4")).toBe("month");
    expect(getEventDatePrecision("2026年")).toBe("year");
  });

  it("treats lower-precision dates as compatible without making them exactly equal", () => {
    expect(areEventDatesExactlyEqual("2026/4/10", "2026-04-10")).toBe(true);
    expect(areEventDatesCompatible("2026-04", "2026-04-10")).toBe(true);
    expect(areEventDatesCompatible("2026", "2026-04-10")).toBe(true);
    expect(areEventDatesCompatible("2026-04-10", "2026-04-11")).toBe(false);
    expect(areEventDatesCompatible("2026-04", "2026-05-01")).toBe(false);
  });

  it("allows small exact-date drift for clustering review without changing strict date compatibility", () => {
    expect(areEventDatesCompatible("2026-04-10", "2026-04-11")).toBe(false);
    expect(areEventDatesCompatibleForClustering("2026-04-10", "2026-04-11")).toBe(true);
    expect(areEventDatesCompatibleForClustering("2026-04-10", "2026-04-12")).toBe(true);
    expect(areEventDatesCompatibleForClustering("2026-04-10", "2026-04-13")).toBe(false);
  });
});
