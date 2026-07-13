import { describe, expect, it } from "vitest";

import { DEFAULT_BLACKLIST_KEYWORDS } from "@/config/blacklist";
import { getRuntimeConfig } from "@/config/runtime";
import { DEFAULT_SOURCE_CONFIGS } from "@/config/sources";

describe("runtime config defaults", () => {
  it("returns built-in defaults", () => {
    const defaults = getRuntimeConfig();

    expect(defaults.rssSources).toEqual(DEFAULT_SOURCE_CONFIGS);
    expect(defaults.blacklistKeywords).toEqual(DEFAULT_BLACKLIST_KEYWORDS);
    expect(defaults.ingestion.itemConcurrency).toBe(3);
    expect(defaults.ingestion.fullTextFetchThreshold).toBe(80);
    expect(defaults.modelApi.apiKey).toBe("");
    expect(defaults.modelApi.baseURL).toBe("");
    expect(defaults.modelApi.model).toBe("gpt-4.1-mini");
    expect(defaults.prompts.itemUnderstanding.length).toBeGreaterThan(0);
    expect(defaults.prompts.itemUnderstanding).toContain("一次完成摘要、内容分析、事件识别与聚合拆分");
    expect(defaults.prompts.itemUnderstanding).toContain("固定输出格式");
    expect(defaults.prompts.itemUnderstanding).toContain('"summary"');
    expect(defaults.prompts.itemUnderstanding).toContain('"eventSignature"');
    expect(defaults.prompts.itemUnderstanding).toContain('"isAggregation"');
    expect(defaults.prompts.itemUnderstanding).not.toContain("restored");
    expect(defaults.prompts.itemUnderstanding).toContain('"mainEvent"');
    expect(defaults.prompts.itemUnderstanding).toContain('"events"');
    expect(defaults.prompts.itemUnderstanding).toContain('"tags"');
    expect(defaults.prompts.clusterSummary.length).toBeGreaterThan(0);
    expect(defaults.prompts.clusterSummary).toContain("聚合展示编辑");
    expect(defaults.prompts.clusterSummary).toContain("固定输出格式");
    expect(defaults.prompts.clusterSummary).toContain('{"title":"...","summary":"..."}');
    expect(defaults.prompts.clusterSummary).toContain("**加粗**");
    expect(defaults.prompts.clusterSummary).toContain("*斜体*");
    expect(defaults.prompts.clusterMatch.length).toBeGreaterThan(0);
    expect(defaults.prompts.clusterMatch).toContain('{"clusterId":"候选组ID"}');
    expect(defaults.prompts.dailyReport).toContain("优先综合参考 candidateScore、sourceCount、itemCount 和日期相关性");
    expect(defaults.prompts.dailyReport).toContain("items 为空数组时会在渲染时自动隐藏");
    expect(defaults.prompts.dailyReport).toContain("说明变化内容、适用对象、实践价值或可能影响");
    expect(defaults.prompts.dailyReport).toContain("多个来源只能用于同一事件的互证");
    expect(defaults.prompts.dailyReport).toContain("只使用输入候选内容和合法来源编号");
    expect(defaults.prompts.dailyReport).toContain("同一事件只出现一次，避免跨栏目重复");
  });

  it("returns fresh copies for mutable arrays", () => {
    const left = getRuntimeConfig();
    const right = getRuntimeConfig();

    left.rssSources.push({
      name: "Extra Feed",
      rssUrl: "https://example.com/feed.xml",
      siteUrl: "https://example.com",
      enabled: true,
      aiParsingEnabled: true,
      aggregationEnabled: true,
    });
    left.blacklistKeywords.push("foo");

    expect(right.rssSources).toEqual(DEFAULT_SOURCE_CONFIGS);
    expect(right.blacklistKeywords).toEqual(DEFAULT_BLACKLIST_KEYWORDS);
  });
});
