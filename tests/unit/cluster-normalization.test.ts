import { describe, expect, it } from "vitest";

import {
  normalizeEventActionForStorage,
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
});
