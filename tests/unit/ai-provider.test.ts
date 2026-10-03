import { describe, expect, it, vi } from "vitest";

import { createAiProvider } from "@/lib/ai/provider-next";
import { normalizeModelResponseText } from "@/lib/ai/response-format";
import type { DailyReportReviewInput } from "@/lib/daily-report/types";

function makeMergeDecision(pairRef: string, verdict: "approved" | "declined" | "ambiguous") {
  const reasonCode = verdict === "approved" ? "same_event" : verdict === "ambiguous" ? "insufficient_evidence" : "different_event";
  return {
    pair_id: pairRef,
    verdict,
    confidence: 95,
    reasonCode,
    reasonText: verdict === "approved" ? "主体、对象和事件动作一致。" : verdict === "ambiguous" ? "证据不足，无法确认是同一事件。" : "主体和具体对象不同，不是同一事件。",
  };
}

describe("ai provider", () => {
  it("understands a regular item in one structured call", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{
        message: {
          content: JSON.stringify({
            summary: "OpenAI 发布新的 Agent 工具能力。",
            translatedTitle: "OpenAI 发布 Agent 工具",
            moderationStatus: "allowed",
            moderationReason: null,
            moderationDetail: "包含明确产品发布事实。",
            qualityScore: 88,
            qualityRationale: "事实完整且具有时效性。",
            eventSignature: {
              eventType: "release",
              eventSubject: "OpenAI",
              eventAction: "发布",
              eventObject: "Agent 工具",
              eventDate: "2026-07-11",
            },
            aggregation: { isAggregation: false, mainEvent: null, events: [] },
          }),
        },
      }],
    });
    const provider = createAiProvider(
      { apiKey: "sk-test", baseURL: "https://example.com/v1", model: "test-model" },
      undefined,
      { chat: { completions: { create } } },
    );

    const result = await provider.understandItem("Full source body", {
      title: "OpenAI releases agent tooling",
      sourceName: "OpenAI",
      translateTitle: true,
    });

    expect(result.summary).toBe("OpenAI 发布新的 Agent 工具能力。");
    expect(result.eventSignature.eventObject).toBe("Agent 工具");
    expect(result.aggregation).toEqual({ isAggregation: false, mainEvent: null, events: [] });
    expect(result.diagnostics).toMatchObject({ summaryValid: true, analysisValid: true, aggregationValid: true });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]?.messages?.[0]?.content).toContain("双引号必须转义");
    expect(create.mock.calls[0]?.[0]?.messages?.[0]?.content).not.toContain("true|false");
    expect(create.mock.calls[0]?.[0]?.messages?.[0]?.content).toContain('"isAggregation":false');
    expect(create.mock.calls[0]?.[0]?.messages?.[0]?.content).toContain('"isAggregation":true');
    expect(create.mock.calls[0]?.[0]?.messages?.[0]?.content).toContain("页面附加内容不代表正文主体");
  });

  it("keeps the item protocol fixed while sending custom instructions separately", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{
        message: {
          content: JSON.stringify({
            summary: "这是一条有效内容摘要。",
            translatedTitle: "",
            moderationStatus: "allowed",
            moderationReason: null,
            moderationDetail: "内容有效。",
            qualityScore: 80,
            qualityRationale: "事实清晰。",
            eventSignature: null,
            aggregation: { isAggregation: false, mainEvent: null, events: [] },
          }),
        },
      }],
    });
    const provider = createAiProvider(
      { apiKey: "sk-test", baseURL: "https://example.com/v1", model: "test-model" },
      {
        itemUnderstanding: {
          systemPrompt: "这是管理员自定义的条目理解提示词。",
          userInstruction: "这是管理员自定义的条目理解提示词。",
          promptTemplate: "正文：{{inputText}}",
        },
      },
      { chat: { completions: { create } } },
    );

    await provider.understandItem("正文内容", {
      title: "测试标题",
      translateTitle: false,
    });

    const systemPrompt = create.mock.calls[0]?.[0]?.messages?.[0]?.content as string;
    const userPrompt = create.mock.calls[0]?.[0]?.messages?.[1]?.content as string;
    expect(systemPrompt).not.toContain("这是管理员自定义的条目理解提示词。");
    expect(systemPrompt).toContain("moderationReason 只能是 marketing、low_quality、duplicate_noise、rule_filter、rule_blacklist、other 或 null");
    expect(systemPrompt).not.toContain("{{maxEvents}}");
    expect(userPrompt).toContain("这是管理员自定义的条目理解提示词。");
    expect(userPrompt).toContain("正文内容");
    expect(userPrompt).not.toContain("{{inputText}}");
    expect(userPrompt).not.toContain('"maxEvents"');
  });

  it("repairs a syntactically invalid item understanding response before retrying the model", async () => {
    const validResponse = JSON.stringify({
      summary: "OpenAI 发布新的 Agent 工具能力。",
      translatedTitle: "OpenAI 发布 Agent 工具",
      moderationStatus: "allowed",
      moderationReason: null,
      moderationDetail: "包含明确产品发布事实。",
      qualityScore: 88,
      qualityRationale: "事实完整且具有时效性。",
      eventSignature: {
        eventType: "release",
        eventSubject: "OpenAI",
        eventAction: "发布",
        eventObject: "Agent 工具",
        eventDate: "2026-07-11",
      },
      aggregation: { isAggregation: false, mainEvent: null, events: [] },
    });
    const malformedResponse = validResponse.replace(
      "新的 Agent 工具能力。",
      '新的 "Agent" 工具能力。',
    );
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: malformedResponse } }],
    });
    const provider = createAiProvider(
      { apiKey: "sk-test", baseURL: "https://example.com/v1", model: "test-model" },
      undefined,
      { chat: { completions: { create } } },
    );

    const result = await provider.understandItem("Full source body", {
      title: "OpenAI releases agent tooling",
      sourceName: "OpenAI",
      translateTitle: true,
    });

    expect(result.summary).toBe('OpenAI 发布新的 "Agent" 工具能力。');
    expect(result.diagnostics).toEqual({
      summaryValid: true,
      analysisValid: true,
      aggregationValid: true,
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("returns aggregation children from the same understanding call", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{
        message: {
          content: JSON.stringify({
            summary: "本期简报包含两条独立产品新闻。",
            translatedTitle: "",
            moderationStatus: "allowed",
            moderationReason: null,
            moderationDetail: "包含多个有效事件。",
            qualityScore: 80,
            qualityRationale: "事实密度较高。",
            eventSignature: null,
            aggregation: {
              isAggregation: true,
              mainEvent: null,
              events: [
                {
                  eventType: "release",
                  eventSubject: "OpenAI",
                  eventAction: "发布",
                  eventObject: "Agent SDK",
                  eventDate: null,
                  title: "OpenAI 发布 Agent SDK",
                  oneLiner: "OpenAI 发布新的 Agent SDK。",
                  qualityScore: 90,
                  qualityBreakdown: [
                    { name: "事实密度", score: 20 },
                    { name: "一手性", score: 15 },
                    { name: "完整度", score: 12 },
                    { name: "可信度", score: 8 },
                    { name: "信息聚焦", score: 5 },
                  ],
                  sourceUrl: "https://example.com/openai",
                },
                {
                  eventType: "launch",
                  eventSubject: "Anthropic",
                  eventAction: "上线",
                  eventObject: "Console",
                  eventDate: null,
                  title: "Anthropic 上线 Console",
                  oneLiner: "Anthropic 上线新的开发者 Console。",
                  qualityScore: 85,
                  qualityBreakdown: [
                    { name: "事实密度", score: 20 },
                    { name: "一手性", score: 5 },
                    { name: "完整度", score: 12 },
                    { name: "可信度", score: 8 },
                    { name: "信息聚焦", score: 5 },
                  ],
                  sourceUrl: null,
                },
              ],
            },
          }),
        },
      }],
    });
    const provider = createAiProvider(
      { apiKey: "sk-test", baseURL: "https://example.com/v1", model: "test-model" },
      undefined,
      { chat: { completions: { create } } },
      { aggregationSplitMaxEvents: 1 },
    );

    const result = await provider.understandItem("Roundup body", {
      title: "AI roundup",
      sourceName: "Newsletter",
      translateTitle: false,
    });

    expect(result.aggregation.isAggregation).toBe(true);
    expect(result.aggregation.events).toHaveLength(1);
    expect(result.aggregation.events[0]?.eventObject).toBe("Agent SDK");
    expect(result.aggregation.events[0]?.qualityScore).toBe(60);
    expect(result.aggregation.events[0]?.qualityBreakdown).toEqual([
      { name: "事实密度", score: 20 },
      { name: "一手性", score: 15 },
      { name: "完整度", score: 12 },
      { name: "可信度", score: 8 },
      { name: "信息聚焦", score: 5 },
    ]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("preserves valid analysis when summary and aggregation field groups are invalid", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{
        message: {
          content: JSON.stringify({
            summary: "",
            translatedTitle: "OpenAI 发布 Agent 工具",
            moderationStatus: "allowed",
            moderationReason: null,
            moderationDetail: "包含明确产品发布事实。",
            qualityScore: 86,
            qualityRationale: "事实完整。",
            eventSignature: {
              eventType: "release",
              eventSubject: "OpenAI",
              eventAction: "发布",
              eventObject: "Agent 工具",
              eventDate: null,
            },
            aggregation: { isAggregation: true, mainEvent: null, events: [] },
          }),
        },
      }],
    });
    const provider = createAiProvider(
      { apiKey: "sk-test", baseURL: "https://example.com/v1", model: "test-model" },
      undefined,
      { chat: { completions: { create } } },
    );

    const result = await provider.understandItem("Full source body", {
      title: "OpenAI releases agent tooling",
      sourceName: "OpenAI",
      translateTitle: true,
    });

    expect(result.summary).toBe("");
    expect(result.qualityScore).toBe(86);
    expect(result.eventSignature.eventObject).toBe("Agent 工具");
    expect(result.aggregation.isAggregation).toBe(false);
    expect(result.diagnostics).toEqual({
      summaryValid: false,
      analysisValid: true,
      aggregationValid: false,
    });
  });

  it("preserves a valid summary when analysis fields are invalid", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{
        message: {
          content: JSON.stringify({
            summary: "OpenAI 发布新的 Agent 工具能力。",
            translatedTitle: "OpenAI 发布 Agent 工具",
            moderationStatus: "unknown",
            qualityScore: "not-a-number",
            qualityRationale: null,
            aggregation: { isAggregation: false, mainEvent: null, events: [] },
          }),
        },
      }],
    });
    const provider = createAiProvider(
      { apiKey: "sk-test", baseURL: "https://example.com/v1", model: "test-model" },
      undefined,
      { chat: { completions: { create } } },
    );

    const result = await provider.understandItem("Full source body", {
      title: "OpenAI releases agent tooling",
      sourceName: "OpenAI",
      translateTitle: true,
    });

    expect(result.summary).toBe("OpenAI 发布新的 Agent 工具能力。");
    expect(result.qualityScore).toBe(50);
    expect(result.diagnostics).toMatchObject({
      summaryValid: true,
      analysisValid: false,
      aggregationValid: true,
    });
  });

  it("strips leading think blocks and code fences from model responses", () => {
    expect(
      normalizeModelResponseText([
        "<think>",
        "The user is asking me to reply with \"OK\".",
        "</think>",
        "```json",
        "{\"summary\":\"这是摘要\",\"isAggregation\":false}",
        "```",
      ].join("\n")),
    ).toBe(`{"summary":"这是摘要","isAggregation":false}`);
  });

  it("turns approved merge decisions into conservative target-direct merge groups", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({ decisions: [makeMergeDecision("p1", "approved"), makeMergeDecision("p2", "approved")] }),
          },
        },
      ],
    });
    const provider = createAiProvider(
      {
        apiKey: "sk-test",
        baseURL: "https://example.com/v1",
        model: "test-model",
      },
      undefined,
      {
        chat: {
          completions: {
            create,
          },
        },
      },
    );

    const decisions = await provider.assessClusterMergePairs(JSON.stringify({
      pairs: [
        {
          left: { id: "cluster-a", title: "A", summary: "A", itemCount: 10 },
          right: { id: "cluster-b", title: "B", summary: "B", itemCount: 5 },
          score: 95,
        },
        {
          left: { id: "cluster-b", title: "B", summary: "B", itemCount: 5 },
          right: { id: "cluster-c", title: "C", summary: "C", itemCount: 1 },
          score: 95,
        },
      ],
    }));

    expect(decisions).toEqual([
      expect.objectContaining({ leftClusterId: "cluster-a", rightClusterId: "cluster-b", verdict: "approved", reasonCode: "same_event" }),
      expect.objectContaining({ leftClusterId: "cluster-b", rightClusterId: "cluster-c", verdict: "approved", reasonCode: "same_event" }),
    ]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]?.messages?.[0]?.content).toContain("候选聚合 Pair");
    expect(create.mock.calls[0]?.[0]?.messages?.[0]?.content).toContain("score 是本地规则");
    expect(create.mock.calls[0]?.[0]?.messages?.[1]?.content).toContain("\"pairs\"");
    expect(create.mock.calls[0]?.[0]?.messages?.[1]?.content).not.toContain("cluster-a");
    expect(create.mock.calls[0]?.[0]?.messages?.[1]?.content).not.toContain("cluster-b");
    expect(create.mock.calls[0]?.[0]?.messages?.[1]?.content).toContain('"pair_id":"p1"');
    expect(create.mock.calls[0]?.[0]?.messages?.[1]?.content).toContain('"pair_id":"p2"');
    // 批内短 ref：不应再让模型回抄 64 位摘要
    expect(create.mock.calls[0]?.[0]?.messages?.[1]?.content).not.toContain("merge_pair_");
  });

  it("parses explicit cluster merge verdicts including ambiguous pairs", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{
        message: {
            content: JSON.stringify({ decisions: [makeMergeDecision("p1", "approved"), makeMergeDecision("p2", "ambiguous")] }),
        },
      }],
    });
    const provider = createAiProvider(
      {
        apiKey: "sk-test",
        baseURL: "https://example.com/v1",
        model: "test-model",
      },
      undefined,
      {
        chat: {
          completions: {
            create,
          },
        },
      },
    );

    await expect(provider.assessClusterMergePairs?.(JSON.stringify({
      pairs: [
        {
          left: { id: "cluster-a", title: "A", summary: "A", itemCount: 10 },
          right: { id: "cluster-b", title: "B", summary: "B", itemCount: 5 },
          score: 95,
        },
        {
          left: { id: "cluster-a", title: "A", summary: "A", itemCount: 10 },
          right: { id: "cluster-c", title: "C", summary: "C", itemCount: 1 },
          score: 60,
        },
      ],
    }))).resolves.toEqual([
      expect.objectContaining({ leftClusterId: "cluster-a", rightClusterId: "cluster-b", verdict: "approved", reasonCode: "same_event" }),
      expect.objectContaining({ leftClusterId: "cluster-a", rightClusterId: "cluster-c", verdict: "ambiguous", reasonCode: "insufficient_evidence" }),
    ]);

    expect(create.mock.calls[0]?.[0]?.messages?.[0]?.content).toContain("每个输入 pair_id");
    expect(create.mock.calls[0]?.[0]?.messages?.[0]?.content).toContain('"decisions"');
    expect(create.mock.calls[0]?.[0]?.messages?.[0]?.content).toContain("pair_id");
  });

  it("returns per-pair merge audit reasons", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{
        message: {
          content: JSON.stringify({ decisions: [makeMergeDecision("p1", "declined")] }),
        },
      }],
    });
    const provider = createAiProvider(
      { apiKey: "sk-test", baseURL: "https://example.com/v1", model: "test-model" },
      undefined,
      { chat: { completions: { create } } },
    );

    await expect(provider.assessClusterMergePairs?.(JSON.stringify({
      pairs: [{
        left: { id: "cluster-a", title: "A", summary: "A", itemCount: 2 },
        right: { id: "cluster-b", title: "B", summary: "B", itemCount: 1 },
        score: 80,
      }],
    }))).resolves.toEqual([expect.objectContaining({
      leftClusterId: "cluster-a",
      rightClusterId: "cluster-b",
      verdict: "declined",
      confidence: 95,
      reasonCode: "different_event",
      reasonText: "主体和具体对象不同，不是同一事件。",
    })]);
  });

  it("drops extra merge decisions that reference unknown pairs", async () => {
    // 逐 pair 抢救：未知 pair_id 的 decision 被丢弃，已知 pair 仍保留。
    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({ decisions: [makeMergeDecision("p1", "approved"), makeMergeDecision("p9", "approved")] }),
          },
        },
      ],
    });
    const provider = createAiProvider(
      {
        apiKey: "sk-test",
        baseURL: "https://example.com/v1",
        model: "test-model",
      },
      undefined,
      {
        chat: {
          completions: {
            create,
          },
        },
      },
    );

    await expect(provider.assessClusterMergePairs(JSON.stringify({
      pairs: [
        {
          left: { id: "cluster-a", title: "A", summary: "A", itemCount: 3 },
          right: { id: "cluster-b", title: "B", summary: "B", itemCount: 2 },
          score: 95,
        },
      ],
    }))).resolves.toEqual([expect.objectContaining({
      leftClusterId: "cluster-a",
      rightClusterId: "cluster-b",
      verdict: "approved",
    })]);
  });

  it("returns no decisions when the model answers with an empty decision set", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({ decisions: [] }),
          },
        },
      ],
    });
    const provider = createAiProvider(
      {
        apiKey: "sk-test",
        baseURL: "https://example.com/v1",
        model: "test-model",
      },
      undefined,
      {
        chat: {
          completions: {
            create,
          },
        },
      },
    );

    // 缺失的 pair 交由下一轮重新评估，而不是抛错连坐同批其他判定。
    await expect(provider.assessClusterMergePairs(JSON.stringify({
      pairs: [
        {
          left: { id: "cluster-a", title: "A", summary: "A", itemCount: 3 },
          right: { id: "cluster-b", title: "B", summary: "B", itemCount: 2 },
          score: 95,
        },
      ],
    }))).resolves.toEqual([]);
  });

  it("salvages the valid pairs in a batch containing an invalid verdict", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({ decisions: [makeMergeDecision("p1", "approved"), { ...makeMergeDecision("p2", "declined"), verdict: "approve" }, makeMergeDecision("p3", "declined")] }),
          },
        },
      ],
    });
    const provider = createAiProvider(
      {
        apiKey: "sk-test",
        baseURL: "https://example.com/v1",
        model: "test-model",
      },
      undefined,
      {
        chat: {
          completions: {
            create,
          },
        },
      },
    );

    await expect(provider.assessClusterMergePairs(JSON.stringify({
      pairs: [
        {
          left: { id: "cluster-a", title: "A", summary: "A", itemCount: 3 },
          right: { id: "cluster-b", title: "B", summary: "B", itemCount: 2 },
          score: 95,
        },
        {
          left: { id: "cluster-c", title: "C", summary: "C", itemCount: 2 },
          right: { id: "cluster-d", title: "D", summary: "D", itemCount: 1 },
          score: 90,
        },
        {
          left: { id: "cluster-e", title: "E", summary: "E", itemCount: 2 },
          right: { id: "cluster-f", title: "F", summary: "F", itemCount: 1 },
          score: 88,
        },
      ],
    }))).resolves.toEqual([
      expect.objectContaining({ leftClusterId: "cluster-a", rightClusterId: "cluster-b", verdict: "approved" }),
      expect.objectContaining({ leftClusterId: "cluster-e", rightClusterId: "cluster-f", verdict: "declined" }),
    ]);
  });

  it("salvages aligned alias decisions when model returns fewer decisions than pairs", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              decisions: [
                { isSameEntity: true, confidence: "high", canonicalName: "OpenAI" },
              ],
            }),
          },
        },
      ],
    });
    const provider = createAiProvider(
      {
        apiKey: "sk-test",
        baseURL: "https://example.com/v1",
        model: "test-model",
      },
      undefined,
      {
        chat: {
          completions: {
            create,
          },
        },
      },
    );

    const decisions = await provider.assessEntityAliasPairs!({
      pairs: [
        { aName: "OpenAI", bName: "OpenAI Inc.", evidence: [] },
        { aName: "Anthropic", bName: "Anthropic PBC", evidence: [] },
      ],
    });

    expect(decisions).toEqual([
      { isSameEntity: true, confidence: "high", canonicalName: "OpenAI" },
    ]);
  });

  it("ignores unknown fields in cluster summary output instead of failing", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              title: "Nothing 发布 Phone（4b）",
              summary: "Nothing 发布 Phone（4b），定价 329 欧元起，扩展移动产品线。",
              keyPoints: ["附赠要点"],
            }),
          },
        },
      ],
    });
    const provider = createAiProvider(
      {
        apiKey: "sk-test",
        baseURL: "https://example.com/v1",
        model: "test-model",
      },
      undefined,
      {
        chat: {
          completions: {
            create,
          },
        },
      },
    );

    const summary = await provider.summarizeCluster("候选内容种子", { title: "Nothing 发布 Phone（4b）" });

    expect(JSON.parse(summary)).toEqual({
      title: "Nothing 发布 Phone（4b）",
      summary: "Nothing 发布 Phone（4b），定价 329 欧元起，扩展移动产品线。",
    });
  });

  it("retries cluster merge once when the first response is invalid json", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: "{\"verdicts\":[\"approved\"",
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({ decisions: [makeMergeDecision("p1", "approved")] }),
            },
          },
        ],
      });
    const provider = createAiProvider(
      {
        apiKey: "sk-test",
        baseURL: "https://example.com/v1",
        model: "test-model",
      },
      undefined,
      {
        chat: {
          completions: {
            create,
          },
        },
      },
    );

    const decisions = await provider.assessClusterMergePairs(JSON.stringify({
      pairs: [
        {
          left: { id: "cluster-a", title: "A", summary: "A", itemCount: 3 },
          right: { id: "cluster-b", title: "B", summary: "B", itemCount: 2 },
          score: 95,
        },
      ],
    }));

    expect(decisions).toEqual([expect.objectContaining({
      leftClusterId: "cluster-a",
      rightClusterId: "cluster-b",
      verdict: "approved",
    })]);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]?.[0]?.messages?.[1]?.content).toContain("上一次输出不是合法 JSON");
  });

  it("uses the cluster summary prompt for aggregated summaries", async () => {
    const presentation = {
      title: "OpenAI 发布 Agent 工具",
      summary: "OpenAI 发布新的 Agent 工具并面向开发者开放。",
    };
    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify(presentation),
          },
        },
      ],
    });

    const provider = createAiProvider(
      {
        apiKey: "sk-test",
        baseURL: "https://example.com/v1",
        model: "test-model",
      },
      {
        itemUnderstanding: {
          systemPrompt: "内容分析提示词",
          userInstruction: "条目理解补充要求",
          promptTemplate: "标题：{{title}}\n正文：{{inputText}}",
        },
        clusterSummary: {
          systemPrompt: "聚合摘要专用提示词",
          userInstruction: "聚合摘要专用提示词",
          promptTemplate: "主题：{{title}}\n候选内容：{{inputText}}",
        },
      },
      {
        chat: {
          completions: {
            create,
          },
        },
      },
    );

    const summary = await provider.summarizeCluster("事件 A：摘要一\n事件 B：摘要二", {
      title: "OpenAI Agent",
    });

    expect(summary).toBe(JSON.stringify(presentation));
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]?.messages?.[0]?.content).not.toContain("聚合摘要专用提示词");
    expect(create.mock.calls[0]?.[0]?.messages?.[1]?.content).toContain("聚合摘要专用提示词");
    expect(create.mock.calls[0]?.[0]?.response_format).toEqual({ type: "json_object" });
  });

  it("retries cluster summaries when reasoning content is truncated before valid JSON", async () => {
    const validPresentation = {
      title: "Nothing 发布 Phone 4b 手机",
      summary: "Nothing 正式发布 Phone 4b 手机，公布售价和主要硬件配置。",
    };
    const create = vi.fn()
      .mockResolvedValueOnce({
        choices: [{ message: { content: null, reasoning_content: "分析候选内容后继续撰写标题" } }],
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify(validPresentation) } }],
      });
    const provider = createAiProvider(
      { apiKey: "sk-test", baseURL: "https://example.com/v1", model: "test-model" },
      {
        clusterSummary: {
          systemPrompt: "聚合摘要提示词",
          promptTemplate: "主题：{{title}}\n候选内容：{{inputText}}",
          maxTokens: 2000,
        },
      },
      { chat: { completions: { create } } },
    );

    const summary = await provider.summarizeCluster("候选内容", { title: "旧标题" });

    expect(summary).toBe(JSON.stringify(validPresentation));
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]?.[0]?.max_tokens).toBe(2000);
    expect(create.mock.calls[1]?.[0]?.messages?.[1]?.content).toContain("上一次输出不是合法 JSON");
  });

  it("selects a candidate cluster even when the cluster hints are phrased differently", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              clusterId: "cluster-1",
            }),
          },
        },
      ],
    });

    const provider = createAiProvider(
      {
        apiKey: "sk-test",
        baseURL: "https://example.com/v1",
        model: "test-model",
      },
      {
        itemUnderstanding: {
          systemPrompt: "内容分析提示词",
          userInstruction: "条目理解补充要求",
          promptTemplate: "标题：{{title}}\n正文：{{inputText}}",
        },
        clusterSummary: {
          systemPrompt: "聚合摘要专用提示词",
          userInstruction: "聚合摘要补充要求",
          promptTemplate: "主题：{{title}}\n候选内容：{{inputText}}",
        },
        clusterMatch: {
          systemPrompt: "归组判定专用提示词",
          userInstruction: "归组判定专用提示词",
          promptTemplate: "当前内容标题：{{title}}\n候选聚合组：{{candidatesJson}}",
        },
      },
      {
        chat: {
          completions: {
            create,
          },
        },
      },
    );

    const matchedClusterId = await provider.matchClusterCandidate("OpenAI developer toolkit for agents", {
      title: "Another report on OpenAI's agent toolkit",
      candidates: [
        {
          id: "cluster-1",
          title: "OpenAI Agent 发布",
          summary: "围绕 OpenAI 新 agent 工具的首发报道",
        },
      ],
    });

    expect(matchedClusterId).toBe("cluster-1");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]?.messages?.[0]?.content).not.toContain("归组判定专用提示词");
    expect(create.mock.calls[0]?.[0]?.messages?.[1]?.content).toContain("归组判定专用提示词");
    expect(create.mock.calls[0]?.[0]?.messages?.[1]?.content).toContain('"candidates":[{"id":"cluster-1"');
    expect(create.mock.calls[0]?.[0]?.messages?.[1]?.content).not.toContain('"candidatesJson"');
  });

  it("uses a strict event-only cluster match prompt by default", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              clusterId: null,
            }),
          },
        },
      ],
    });

    const provider = createAiProvider(
      {
        apiKey: "sk-test",
        baseURL: "https://example.com/v1",
        model: "test-model",
      },
      undefined,
      {
        chat: {
          completions: {
            create,
          },
        },
      },
    );

    await provider.matchClusterCandidate("企业AI工具主题下的另一篇文章", {
      title: "Another AI tools story",
      candidates: [
        {
          id: "cluster-1",
          title: "企业AI工具",
          summary: "某个 AI 工具行业主题聚合",
        },
      ],
    });

    const systemPrompt = create.mock.calls[0]?.[0]?.messages?.[0]?.content as string;
    expect(systemPrompt).toContain("同一具体事件");
    expect(systemPrompt).toContain("如果只是主题接近");
    expect(systemPrompt).toContain("当前内容缺少明确事件线索时");
    expect(create.mock.calls[0]?.[0]?.response_format).toEqual({ type: "json_object" });
  });

  it("retries cluster matching once when the first response is invalid json", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: "{\"cluster\":",
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({clusterId: "cluster-1"}),
            },
          },
        ],
      });
    const provider = createAiProvider(
      {
        apiKey: "sk-test",
        baseURL: "https://example.com/v1",
        model: "test-model",
      },
      undefined,
      {
        chat: {
          completions: {
            create,
          },
        },
      },
    );

    const matchedClusterId = await provider.matchClusterCandidate("OpenAI developer toolkit for agents", {
      title: "Another report on OpenAI's agent toolkit",
      candidates: [
        {
          id: "cluster-1",
          title: "OpenAI Agent 发布",
          summary: "围绕 OpenAI 新 agent 工具的首发报道",
        },
      ],
    });

    expect(matchedClusterId).toBe("cluster-1");
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]?.[0]?.messages?.[1]?.content).toContain("上一次输出不是合法 JSON");
  });

  it("sends the internal review contract together with the custom user prompt and reports usage", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ verdict: "pass", violations: [], summary: "通过" }) } }],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 12,
        total_tokens: 132,
        prompt_tokens_details: { cached_tokens: 10 },
      },
    });
    const onUsage = vi.fn();
    const provider = createAiProvider(
      { apiKey: "sk-test", baseURL: "https://example.com/v1", model: "review-model" },
      {
        dailyReportReview: {
          systemPrompt: "内部 Review 自定义扩展",
          promptTemplate: "用户补充要求：优先检查事实一致性。",
          modelApi: {
            apiKey: "sk-test",
            baseURL: "https://example.com/v1",
            model: "review-model",
          },
        },
      },
      { chat: { completions: { create } } },
      { onUsage },
    );

    const input = {
      date: "2026-08-20",
      draft: { blocks: [] },
      selectedTopics: [],
      candidatePool: { topUnselectedCandidates: [] },
    } as unknown as DailyReportReviewInput;
    await expect(provider.reviewDailyReport(input)).resolves.toEqual({
      verdict: "pass",
      violations: [],
      summary: "通过",
    });

    const messages = create.mock.calls[0]?.[0]?.messages ?? [];
    expect(messages[0]?.content).not.toContain("内部 Review 自定义扩展");
    expect(messages[0]?.content).toContain("输出合同");
    expect(messages[0]?.content).toContain("factual_inconsistency");
    expect(messages[0]?.content).toContain("evidence");
    expect(messages[1]?.content).toContain("用户补充要求");
    expect(messages[1]?.content).toContain("2026-08-20");
    expect(messages[1]?.content).not.toContain("{{reviewContextJson}}");
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({
      promptTokens: 120,
      completionTokens: 12,
      totalTokens: 132,
      cachedTokens: 10,
      tokenUsageSource: "provider",
    }), "daily_report_review");
  });

  it("does not inject a free-form user prompt into daily report stages", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ assessments: [] }) } }],
    });
    const provider = createAiProvider(
      { apiKey: "sk-test", baseURL: "https://example.com/v1", model: "daily-model" },
      {
        dailyReport: {
          systemPrompt: "旧日报系统提示词",
          userInstruction: "这段日报用户提示词不应被注入",
        },
      },
      { chat: { completions: { create } } },
    );

    await expect(provider.assessDailyReportCandidates({
      candidates: [],
      template: { schemaVersion: 2, blocks: [], recentTopicRules: [] } as never,
      recentTopics: [],
    })).resolves.toEqual([]);

    const messages = create.mock.calls[0]?.[0]?.messages ?? [];
    expect(messages[0]?.content).not.toContain("旧日报系统提示词");
    expect(messages[0]?.content).not.toContain("这段日报用户提示词不应被注入");
    expect(messages[1]?.content).not.toContain("用户补充指令");
  });

  it("rejects a review violation without evidence", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{
        message: {
          content: JSON.stringify({
            verdict: "reject",
            violations: [{
              code: "factual_inconsistency",
              severity: "error",
              message: "事实冲突",
            }],
            summary: "未通过",
          }),
        },
      }],
    });
    const provider = createAiProvider(
      { apiKey: "sk-test", baseURL: "https://example.com/v1", model: "review-model" },
      undefined,
      { chat: { completions: { create } } },
    );

    const input = {
      date: "2026-08-20",
      draft: { blocks: [] },
      selectedTopics: [],
      candidatePool: { topUnselectedCandidates: [] },
    } as unknown as DailyReportReviewInput;
    await expect(provider.reviewDailyReport(input)).rejects.toThrow("必须包含非空 evidence");
    expect(create).toHaveBeenCalledTimes(2);
  });

});
