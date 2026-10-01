import { describe, expect, it, vi } from "vitest";

import { InvalidJsonModelResponseError } from "@/lib/ai/provider-types";
import { generateClusterPresentation, type ItemWithSource } from "@/lib/clusters/helpers";

function createItem(id: string, summaryText: string): ItemWithSource {
  return {
    id,
    originalTitle: `候选标题 ${id}`,
    translatedTitle: null,
    summaryText,
    rssExcerpt: null,
    fullText: null,
    rssContent: null,
    eventType: "release",
    eventSubject: "Nothing",
    eventAction: "发布",
    eventObject: "Phone (4b)",
    eventDate: "2026-07-07",
    qualityScore: id === "two" ? 80 : 65,
    publishedAt: new Date(id === "two" ? "2026-07-07T23:58:01.000Z" : "2026-07-09T00:40:02.000Z"),
    source: { name: "测试来源" },
  } as ItemWithSource;
}

describe("generateClusterPresentation", () => {
  it("rejects leaked reasoning instead of publishing it as the cluster summary", async () => {
    const leakedReasoning = [
      "1. **分析请求**：基于多条候选内容生成摘要。",
      "2. **分析候选内容**：候选 1 与候选 2。",
      "3. **提炼共同事件**：Nothing 发布 Phone (4b)。",
      "4. **撰写 Title**：Nothing 发布 Phone (4b",
    ].join("\n");
    const summarizeCluster = vi.fn().mockResolvedValue(leakedReasoning);
    const items = [
      createItem("one", "Nothing 发布 Phone (4b)，扩展其移动设备产品线。"),
      createItem("two", "Nothing 发布 Phone（4b），定价 329 欧元起。"),
    ];

    const result = await generateClusterPresentation(
      items,
      "Nothing 发布 Phone (4b",
      { summarizeCluster },
      { preferEventTitleFallback: true },
    );

    expect(result).toEqual({
      title: "Nothing 发布 Phone (4b)",
      summary: "Nothing 发布 Phone (4b)，扩展其移动设备产品线。 Nothing 发布 Phone（4b），定价 329 欧元起。",
      summaryAttempted: true,
      summarySucceeded: false,
      failureReason: "protocol_invalid",
    });
  });

  it("reports reasoning_marker when a JSON summary leaks reasoning text", async () => {
    const leakedReasoning = JSON.stringify({
      title: "Nothing 发布 Phone（4b）",
      summary: "**分析请求**：基于多条候选内容撰写 summary，提炼共同事件。",
    });
    const summarizeCluster = vi.fn().mockResolvedValue(leakedReasoning);
    const items = [
      createItem("one", "Nothing 发布 Phone (4b)，扩展其移动设备产品线。"),
      createItem("two", "Nothing 发布 Phone（4b），定价 329 欧元起。"),
    ];

    const result = await generateClusterPresentation(
      items,
      "Nothing 发布 Phone (4b",
      { summarizeCluster },
      { preferEventTitleFallback: true },
    );

    expect(result.summarySucceeded).toBe(false);
    expect(result.failureReason).toBe("reasoning_marker");
  });

  it("reports empty when the model returns no usable content", async () => {
    const summarizeCluster = vi.fn().mockResolvedValue("   ");
    const items = [
      createItem("one", "Nothing 发布 Phone (4b)，扩展其移动设备产品线。"),
      createItem("two", "Nothing 发布 Phone（4b），定价 329 欧元起。"),
    ];

    const result = await generateClusterPresentation(
      items,
      "Nothing 发布 Phone (4b",
      { summarizeCluster },
      { preferEventTitleFallback: true },
    );

    expect(result.summaryAttempted).toBe(true);
    expect(result.summarySucceeded).toBe(false);
    expect(result.failureReason).toBe("empty");
  });

  it("reports protocol_invalid when the provider throws a JSON protocol error", async () => {
    const summarizeCluster = vi.fn().mockRejectedValue(new InvalidJsonModelResponseError("bad json"));
    const items = [
      createItem("one", "Nothing 发布 Phone (4b)，扩展其移动设备产品线。"),
      createItem("two", "Nothing 发布 Phone（4b），定价 329 欧元起。"),
    ];

    const result = await generateClusterPresentation(
      items,
      "Nothing 发布 Phone (4b",
      { summarizeCluster },
      { preferEventTitleFallback: true },
    );

    expect(result.summarySucceeded).toBe(false);
    expect(result.failureReason).toBe("protocol_invalid");
  });

  it("reports provider_error as the safe code for other provider exceptions", async () => {
    const summarizeCluster = vi.fn().mockRejectedValue(new Error("network exploded with secret detail"));
    const items = [
      createItem("one", "Nothing 发布 Phone (4b)，扩展其移动设备产品线。"),
      createItem("two", "Nothing 发布 Phone（4b），定价 329 欧元起。"),
    ];

    const result = await generateClusterPresentation(
      items,
      "Nothing 发布 Phone (4b",
      { summarizeCluster },
      { preferEventTitleFallback: true },
    );

    expect(result.summarySucceeded).toBe(false);
    expect(result.failureReason).toBe("provider_error");
    expect(JSON.stringify(result)).not.toContain("secret detail");
  });

  it("reports non_chinese when the Chinese retry is exhausted", async () => {
    const englishSummary = JSON.stringify({
      title: "Nothing launches Phone (4b)",
      summary: "Nothing launched the Phone (4b) with a new design and better cameras across markets.",
    });
    const summarizeCluster = vi.fn().mockResolvedValue(englishSummary);
    const items = [
      createItem("one", "Nothing 发布 Phone (4b)，扩展其移动设备产品线。"),
      createItem("two", "Nothing 发布 Phone（4b），定价 329 欧元起。"),
    ];

    const result = await generateClusterPresentation(
      items,
      "Nothing 发布 Phone (4b",
      { summarizeCluster },
      { preferEventTitleFallback: true },
    );

    expect(summarizeCluster).toHaveBeenCalledTimes(2);
    expect(result.summarySucceeded).toBe(false);
    expect(result.failureReason).toBe("non_chinese");
  });

  it("reports no_change when the model output equals the fallback content", async () => {
    const fallbackSummary = "Nothing 发布 Phone (4b)，扩展其移动设备产品线。 Nothing 发布 Phone（4b），定价 329 欧元起。";
    const summarizeCluster = vi.fn().mockResolvedValue(
      JSON.stringify({ title: "Nothing 发布 Phone (4b)", summary: fallbackSummary }),
    );
    const items = [
      createItem("one", "Nothing 发布 Phone (4b)，扩展其移动设备产品线。"),
      createItem("two", "Nothing 发布 Phone（4b），定价 329 欧元起。"),
    ];

    const result = await generateClusterPresentation(
      items,
      "Nothing 发布 Phone (4b",
      { summarizeCluster },
      { preferEventTitleFallback: true },
    );

    expect(result).toEqual({
      title: "Nothing 发布 Phone (4b)",
      summary: fallbackSummary,
      summaryAttempted: true,
      summarySucceeded: false,
      failureReason: "no_change",
    });
  });

  it("does not mark singleton or no-provider runs as attempted failures", async () => {
    const items = [createItem("one", "单条内容摘要。")];
    const singletonResult = await generateClusterPresentation(
      items,
      "单条标题",
      { summarizeCluster: vi.fn() },
      { preferEventTitleFallback: true },
    );
    expect(singletonResult.summaryAttempted).toBe(false);
    expect(singletonResult.summarySucceeded).toBe(false);
    expect(singletonResult.failureReason).toBeUndefined();

    const multiItems = [
      createItem("one", "Nothing 发布 Phone (4b)，扩展其移动设备产品线。"),
      createItem("two", "Nothing 发布 Phone（4b），定价 329 欧元起。"),
    ];
    const noProviderResult = await generateClusterPresentation(
      multiItems,
      "Nothing 发布 Phone (4b",
      undefined,
      { preferEventTitleFallback: true },
    );
    expect(noProviderResult.summaryAttempted).toBe(false);
    expect(noProviderResult.summarySucceeded).toBe(false);
    expect(noProviderResult.failureReason).toBeUndefined();
  });

  it("clamps over-length summaries at a sentence boundary instead of dropping them", async () => {
    const longSummary = Array.from(
      { length: 30 },
      (_, index) => `这是第${index}句关于 Nothing Phone（4b）发布的详细描述与背景补充内容。`,
    ).join("");
    const summarizeCluster = vi.fn().mockResolvedValue(
      JSON.stringify({ title: "Nothing 发布 Phone（4b）", summary: longSummary }),
    );
    const items = [
      createItem("one", "Nothing 发布 Phone (4b)，扩展其移动设备产品线。"),
      createItem("two", "Nothing 发布 Phone（4b），定价 329 欧元起。"),
    ];

    const result = await generateClusterPresentation(
      items,
      "Nothing 发布 Phone (4b",
      { summarizeCluster },
      { preferEventTitleFallback: true },
    );

    expect(result.summarySucceeded).toBe(true);
    expect(result.summary.length).toBeLessThanOrEqual(400);
    expect(result.summary.endsWith("。")).toBe(true);
    expect(result.summary.startsWith("这是第0句")).toBe(true);
  });

  it("balances emphasis markers when truncation cuts inside bold or italic text", async () => {
    const filler = " Nothing 发布了全新的手机与配件。".repeat(20);
    const summary = `${filler}这是**未闭合的加粗内容，后面还有 *斜体强调也没有收尾，继续补充很长的正文让它超过四百字的硬性截断边界。`;
    const summarizeCluster = vi.fn().mockResolvedValue(
      JSON.stringify({ title: "Nothing 发布 Phone（4b）", summary }),
    );
    const items = [
      createItem("one", "Nothing 发布 Phone (4b)，扩展其移动设备产品线。"),
      createItem("two", "Nothing 发布 Phone（4b），定价 329 欧元起。"),
    ];

    const result = await generateClusterPresentation(
      items,
      "Nothing 发布 Phone (4b",
      { summarizeCluster },
      { preferEventTitleFallback: true },
    );

    expect(result.summarySucceeded).toBe(true);
    expect(result.summary.length).toBeLessThanOrEqual(400);
    expect((result.summary.match(/\*\*/g) || []).length % 2).toBe(0);
    expect((result.summary.match(/(?<!\*)\*(?!\*)/g) || []).length % 2).toBe(0);
  });

  it("still falls back when the summary is empty", async () => {
    const summarizeCluster = vi.fn().mockResolvedValue(JSON.stringify({ title: "   ", summary: "" }));
    const items = [
      createItem("one", "Nothing 发布 Phone (4b)，扩展其移动设备产品线。"),
      createItem("two", "Nothing 发布 Phone（4b），定价 329 欧元起。"),
    ];

    const result = await generateClusterPresentation(
      items,
      "Nothing 发布 Phone (4b",
      { summarizeCluster },
      { preferEventTitleFallback: true },
    );

    expect(result.summaryAttempted).toBe(true);
    expect(result.summary).toBe("Nothing 发布 Phone (4b)，扩展其移动设备产品线。 Nothing 发布 Phone（4b），定价 329 欧元起。");
    expect(result.summarySucceeded).toBe(false);
  });
});
