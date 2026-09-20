import { describe, expect, it, vi } from "vitest";

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
    });
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
