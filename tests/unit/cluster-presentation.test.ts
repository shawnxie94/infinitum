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
});
