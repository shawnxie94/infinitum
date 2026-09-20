import { describe, expect, it, vi } from "vitest";

import { createAiProvider } from "@/lib/ai/provider";
import { ITEM_UNDERSTANDING_FIXED_OUTPUT_RULE } from "@/config/prompts";
import {
  DEFAULT_QUALITY_RUBRIC,
  stringifyQualityRubric,
} from "@/lib/ai/quality-rubric";

/**
 * 评分规则接入后的 provider 行为契约：qualityBreakdown 三档回退、
 * 评分标准块拼入系统提示词、判定类任务温度锁定。
 */

function mockModelResponse(content: unknown) {
  return vi.fn().mockResolvedValue({
    choices: [{ message: { content: JSON.stringify(content) } }],
  });
}

function buildUnderstandingContent(overrides: Record<string, unknown> = {}) {
  return {
    summary: "OpenAI 发布新的 Agent 工具能力。",
    translatedTitle: "",
    moderationStatus: "allowed",
    moderationReason: null,
    moderationDetail: null,
    qualityScore: 50,
    qualityBreakdown: [
      { name: "事实密度", score: 30 },
      { name: "一手性", score: 25 },
      { name: "完整度", score: 20 },
      { name: "可信度", score: 15 },
      { name: "信息聚焦", score: 10 },
    ],
    qualityRationale: "各维度档位理由。",
    eventSignature: { eventType: null, eventSubject: null, eventAction: null, eventObject: null, eventDate: null },
    aggregation: { isAggregation: false, mainEvent: null, events: [] },
    ...overrides,
  };
}

const modelApiConfig = { apiKey: "sk-test", baseURL: "https://example.com/v1", model: "test-model" };

describe("ai provider quality rubric integration", () => {
  it("computes the total score from qualityBreakdown when it matches the configured rubric", async () => {
    const create = mockModelResponse(buildUnderstandingContent({
      // 模型自报总分错误（应为 70），代码以 breakdown 吸附求和为准。
      qualityScore: 88,
      qualityBreakdown: [
        { name: "事实密度", score: 30 },
        { name: "一手性", score: 15 },
        { name: "完整度", score: 12 },
        { name: "可信度", score: 8 },
        { name: "信息聚焦", score: 5 },
      ],
    }));
    const provider = createAiProvider(
      modelApiConfig,
      {
        itemUnderstanding: {
          systemPrompt: "contract",
          templateJson: stringifyQualityRubric(DEFAULT_QUALITY_RUBRIC),
          temperature: 0.7,
        },
      },
      { chat: { completions: { create } } },
    );

    const result = await provider.understandItem("正文", {
      title: "标题",
      sourceName: "来源",
      translateTitle: false,
    });

    expect(result.qualityScore).toBe(70);
    expect(result.diagnostics.analysisValid).toBe(true);
  });

  it("falls back to the single qualityScore field when the breakdown is invalid", async () => {
    const create = mockModelResponse(buildUnderstandingContent({
      qualityScore: 66,
      qualityBreakdown: [{ name: "事实密度", score: 30 }],
    }));
    const provider = createAiProvider(
      modelApiConfig,
      {
        itemUnderstanding: {
          systemPrompt: "contract",
          templateJson: stringifyQualityRubric(DEFAULT_QUALITY_RUBRIC),
        },
      },
      { chat: { completions: { create } } },
    );

    const result = await provider.understandItem("正文", {
      title: "标题",
      sourceName: "来源",
      translateTitle: false,
    });

    expect(result.qualityScore).toBe(66);
  });

  it("appends the rendered rubric block to the system prompt and locks temperature to 0", async () => {
    const create = mockModelResponse(buildUnderstandingContent({
      qualityScore: 80,
      qualityBreakdown: [
        { name: "事实密度", score: 20 },
        { name: "一手性", score: 25 },
        { name: "完整度", score: 20 },
        { name: "可信度", score: 15 },
        { name: "信息聚焦", score: 0 },
      ],
    }));
    const provider = createAiProvider(
      modelApiConfig,
      {
        itemUnderstanding: {
          systemPrompt: "legacy prompt text that must be ignored",
          templateJson: stringifyQualityRubric(DEFAULT_QUALITY_RUBRIC),
          temperature: 0.9,
          maxTokens: 1234,
        },
      },
      { chat: { completions: { create } } },
    );

    await provider.understandItem("正文", {
      title: "标题",
      sourceName: "来源",
      translateTitle: false,
    });

    const request = create.mock.calls[0]?.[0] as {
      temperature?: number;
      max_tokens?: number;
      messages?: Array<{ role: string; content: string }>;
    };
    expect(request.temperature).toBe(0);
    expect(request.max_tokens).toBe(1234);

    const systemPrompt = request.messages?.find((message) => message.role === "system")?.content ?? "";
    expect(systemPrompt).toContain("qualityScore 评分标准");
    expect(systemPrompt).toContain("事实密度（满分 30 分");
    expect(systemPrompt).toContain(ITEM_UNDERSTANDING_FIXED_OUTPUT_RULE);
    // 系统提示词以代码契约为底，持久化 systemPrompt 是遗留数据不得透传。
    expect(systemPrompt.startsWith("你是资讯内容理解助手")).toBe(true);
    expect(systemPrompt).not.toContain("legacy prompt text that must be ignored");
  });

  it("uses the built-in default rubric when no override is provided", async () => {
    const create = mockModelResponse(buildUnderstandingContent({ qualityScore: 50 }));
    const provider = createAiProvider(
      modelApiConfig,
      undefined,
      { chat: { completions: { create } } },
    );

    const result = await provider.understandItem("正文", {
      title: "标题",
      sourceName: "来源",
      translateTitle: false,
    });

    expect(result.qualityScore).toBe(100);
    const request = create.mock.calls[0]?.[0] as { temperature?: number; max_tokens?: number };
    expect(request.temperature).toBe(0);
    expect(request.max_tokens).toBe(8000);
  });

  it("locks the entity alias check to temperature 0 with a bounded token budget", async () => {
    const create = mockModelResponse({
      decisions: [{ a: "A", b: "B", isSameEntity: false, confidence: "high", canonicalName: null }],
    });
    const provider = createAiProvider(
      modelApiConfig,
      undefined,
      { chat: { completions: { create } } },
    );

    const decisions = await provider.assessEntityAliasPairs?.({
      pairs: [{ aName: "A", bName: "B", evidence: [] }],
    });

    expect(decisions).toHaveLength(1);
    const request = create.mock.calls[0]?.[0] as { temperature?: number; max_tokens?: number };
    expect(request.temperature).toBe(0);
    expect(request.max_tokens).toBe(2000);
  });
});
