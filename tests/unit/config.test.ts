import { describe, expect, it } from "vitest";

import { DEFAULT_BLACKLIST_KEYWORDS } from "@/config/blacklist";
import { DEFAULT_DAILY_REPORT_PROMPT } from "@/config/prompts";
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
    expect(defaults.prompts.itemUnderstanding).toContain("自动生成实体关联");
    expect(defaults.prompts.clusterSummary.length).toBeGreaterThan(0);
    expect(defaults.prompts.clusterSummary).toContain("聚合展示编辑");
    expect(defaults.prompts.clusterSummary).toContain("固定输出格式");
    expect(defaults.prompts.clusterSummary).toContain('{"title":"...","summary":"..."}');
    expect(defaults.prompts.clusterSummary).toContain("**加粗**");
    expect(defaults.prompts.clusterSummary).toContain("*斜体*");
    expect(defaults.prompts.clusterMatch.length).toBeGreaterThan(0);
    expect(defaults.prompts.clusterMatch).toContain('{"clusterId":"候选组ID"}');
    expect(defaults.prompts.dailyReport).toBe(DEFAULT_DAILY_REPORT_PROMPT);
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
