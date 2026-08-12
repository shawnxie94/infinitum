import { describe, expect, it, vi } from "vitest";

import { createAiProvider } from "@/lib/ai/provider";
import { normalizeModelResponseText } from "@/lib/ai/response-format";
import {
  DEFAULT_DAILY_REPORT_PROMPT,
  DEFAULT_DAILY_REPORT_USER_PROMPT_TEMPLATE,
} from "@/config/prompts";

describe("ai provider", () => {
  it("disables MiniMax-M3 thinking and never falls back to reasoning content", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({
        choices: [{
          finish_reason: "stop",
          message: {
            content: null,
            reasoning_content: "<think>内部思考不应作为 JSON 返回</think>",
          },
        }],
      })
      .mockResolvedValueOnce({
        choices: [{
          finish_reason: "stop",
          message: { content: '{"headline":"今日重点","blocks":[]}' },
        }],
      });
    const provider = createAiProvider(
      { apiKey: "sk-test", baseURL: "https://api.minimaxi.com/v1", model: "MiniMax-M3" },
      {
        dailyReport: {
          systemPrompt: "生成日报。",
          promptTemplate: "{{articlesJson}}",
          maxTokens: 20480,
        },
      },
      { chat: { completions: { create } } },
    );

    await provider.generateDailyReport({
      date: "2026-04-24",
      timezone: "Asia/Shanghai",
      articles: [{ id: 1, title: "今日候选" }],
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]?.[0]?.thinking).toEqual({ type: "disabled" });
    expect(create.mock.calls[1]?.[0]?.thinking).toEqual({ type: "disabled" });
    expect(create.mock.calls[1]?.[0]?.messages?.[1]?.content).toContain("未返回最终 JSON 内容");
  });

  it("omits MiniMax-only thinking parameters for non-MiniMax models", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "{}" } }],
    });
    const provider = createAiProvider(
      { apiKey: "sk-test", baseURL: "https://example.com/v1", model: "test-model" },
      {
        dailyReport: {
          systemPrompt: "生成日报。",
          promptTemplate: "{{articlesJson}}",
        },
      },
      { chat: { completions: { create } } },
    );

    await provider.generateDailyReport({
      date: "2026-04-24",
      timezone: "Asia/Shanghai",
      articles: [{ id: 1, title: "今日候选" }],
    });

    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("thinking");
  });

  it("compacts daily report candidates and evidence before sending them to the model", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "{}" } }],
    });
    const provider = createAiProvider(
      { apiKey: "sk-test", baseURL: "https://example.com/v1", model: "test-model" },
      {
        dailyReport: {
          systemPrompt: "生成日报。",
          promptTemplate: "{{articlesJson}}",
        },
      },
      { chat: { completions: { create } } },
    );

    await provider.generateDailyReport({
      date: "2026-04-24",
      timezone: "Asia/Shanghai",
      articles: [{
        id: 1,
        sourceKey: "cluster:internal",
        itemId: "item-internal",
        clusterId: "cluster-internal",
        title: "事件标题",
        itemTitle: "原始文章标题",
        sourceName: "代表来源",
        url: "https://internal.example/article",
        summary: "候选摘要",
        qualityScore: 90,
        candidateScore: 88,
        sourceCount: 2,
        itemCount: 2,
        createdAt: "2026-04-24T08:00:00.000Z",
        publishedAt: "2026-04-24T07:00:00.000Z",
        publishedAtKnown: true,
        eventType: "release",
        eventSubject: "主体",
        eventAction: "发布",
        eventObject: "对象",
        eventDate: "2026-04-24",
        isFollowUp: true,
        newItemCountOnDate: 1,
        newSourceCountOnDate: 1,
        evidenceItems: [{
          title: "证据标题",
          sourceName: "证据来源",
          summary: "不应发送的证据摘要",
          url: "https://internal.example/evidence",
          publishedAt: "2026-04-24T07:30:00.000Z",
          createdAt: "2026-04-24T08:30:00.000Z",
          qualityScore: 85,
        }],
      }],
    });

    const userContent = create.mock.calls[0]?.[0]?.messages?.[1]?.content as string;
    expect(JSON.parse(userContent.split("\n", 1)[0] ?? "")).toEqual([{
      id: 1,
      title: "事件标题",
      summary: "候选摘要",
      sourceName: "代表来源",
      qualityScore: 90,
      candidateScore: 88,
      sourceCount: 2,
      itemCount: 2,
      createdAt: "2026-04-24T08:00:00.000Z",
      publishedAt: "2026-04-24T07:00:00.000Z",
      publishedAtKnown: true,
      eventType: "release",
      eventSubject: "主体",
      eventAction: "发布",
      eventObject: "对象",
      eventDate: "2026-04-24",
      isFollowUp: true,
      newItemCountOnDate: 1,
      newSourceCountOnDate: 1,
      evidenceItems: [{
        title: "证据标题",
        sourceName: "证据来源",
        publishedAt: "2026-04-24T07:30:00.000Z",
      }],
    }]);
  });

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

  it("appends the fixed moderation reason enum to custom item prompts", async () => {
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
    expect(systemPrompt).toContain("这是管理员自定义的条目理解提示词。");
    expect(systemPrompt).toContain("moderationReason 只能是 marketing、low_quality、duplicate_noise、rule_filter、rule_blacklist、other 或 null");
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

  it("turns approved merge pairs into conservative target-direct merge groups", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              approvedPairs: [
                ["cluster-a", "cluster-b"],
                ["cluster-b", "cluster-c"],
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

    const groups = await provider.mergeClusters(JSON.stringify({
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

    expect(groups).toEqual([["cluster-a", "cluster-b"]]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]?.messages?.[0]?.content).toContain("候选聚合 Pair");
    expect(create.mock.calls[0]?.[0]?.messages?.[0]?.content).toContain("score 是本地规则");
    expect(create.mock.calls[0]?.[0]?.messages?.[1]?.content).toContain("\"pairs\"");
  });

  it("ignores approved merge pairs that were not present in the local pair input", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              approvedPairs: [
                ["cluster-a", "cluster-b"],
                ["cluster-a", "cluster-c"],
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

    const groups = await provider.mergeClusters(JSON.stringify({
      pairs: [
        {
          left: { id: "cluster-a", title: "A", summary: "A", itemCount: 3 },
          right: { id: "cluster-b", title: "B", summary: "B", itemCount: 2 },
          score: 95,
        },
      ],
    }));

    expect(groups).toEqual([["cluster-a", "cluster-b"]]);
  });

  it("honors explicit empty approved merge pairs over legacy merge groups", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              approvedPairs: [],
              mergeGroups: [["cluster-a", "cluster-b"]],
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

    const groups = await provider.mergeClusters(JSON.stringify({
      pairs: [
        {
          left: { id: "cluster-a", title: "A", summary: "A", itemCount: 3 },
          right: { id: "cluster-b", title: "B", summary: "B", itemCount: 2 },
          score: 95,
        },
      ],
    }));

    expect(groups).toEqual([]);
  });

  it("retries cluster merge once when the first response is invalid json", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: "{\"approvedPairs\":[[\"cluster-a\",\"cluster-b\"]",
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({
                approvedPairs: [["cluster-a", "cluster-b"]],
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

    const groups = await provider.mergeClusters(JSON.stringify({
      pairs: [
        {
          left: { id: "cluster-a", title: "A", summary: "A", itemCount: 3 },
          right: { id: "cluster-b", title: "B", summary: "B", itemCount: 2 },
          score: 95,
        },
      ],
    }));

    expect(groups).toEqual([["cluster-a", "cluster-b"]]);
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
          promptTemplate: "标题：{{title}}\n正文：{{inputText}}",
        },
        clusterSummary: {
          systemPrompt: "聚合摘要专用提示词",
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
    expect(create.mock.calls[0]?.[0]?.messages?.[0]?.content).toContain("聚合摘要专用提示词");
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
          promptTemplate: "标题：{{title}}\n正文：{{inputText}}",
        },
        clusterSummary: {
          systemPrompt: "聚合摘要专用提示词",
          promptTemplate: "主题：{{title}}\n候选内容：{{inputText}}",
        },
        clusterMatch: {
          systemPrompt: "归组判定专用提示词",
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
    expect(create.mock.calls[0]?.[0]?.messages?.[0]?.content).toContain("归组判定专用提示词");
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

  it("retries daily reports when the model stops before returning complete JSON", async () => {
    const validOutput = JSON.stringify({
      headline: "今日 AI 重点",
      blocks: [],
    });
    const create = vi.fn()
      .mockResolvedValueOnce({
        choices: [{
          finish_reason: "length",
          message: {
            content: null,
            reasoning_content: '{"headline":"未完成',
          },
        }],
      })
      .mockResolvedValueOnce({
        choices: [{
          finish_reason: "stop",
          message: { content: validOutput },
        }],
      });
    const provider = createAiProvider(
      {
        apiKey: "sk-test",
        baseURL: "https://example.com/v1",
        model: "test-model",
      },
      {
        dailyReport: {
          systemPrompt: "生成日报。",
          promptTemplate: "日期：{{date}}\n候选内容 JSON：{{articlesJson}}",
          maxTokens: 40960,
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

    const output = await provider.generateDailyReport({
      date: "2026-04-24",
      timezone: "Asia/Shanghai",
      articles: [{ id: 1, title: "今日候选" }],
    });

    expect(output).toBe(validOutput);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]?.[0]?.max_tokens).toBe(40960);
    expect(create.mock.calls[1]?.[0]?.messages?.[1]?.content).toContain("finish_reason=length");
  });

  it("retries daily reports when the model returns no final JSON content", async () => {
    const validOutput = '{"headline":"今日 AI 重点","blocks":[]}';
    const create = vi.fn()
      .mockResolvedValueOnce({
        choices: [{
          finish_reason: "stop",
          message: { content: null, reasoning_content: null },
        }],
      })
      .mockResolvedValueOnce({
        choices: [{
          finish_reason: "stop",
          message: { content: validOutput },
        }],
      });
    const provider = createAiProvider(
      { apiKey: "sk-test", baseURL: "https://example.com/v1", model: "test-model" },
      {
        dailyReport: {
          systemPrompt: "生成日报。",
          promptTemplate: "{{articlesJson}}",
          maxTokens: 8192,
        },
      },
      { chat: { completions: { create } } },
    );

    const output = await provider.generateDailyReport({
      date: "2026-04-24",
      timezone: "Asia/Shanghai",
      articles: [{ id: 1, title: "今日候选" }],
    });

    expect(output).toBe(validOutput);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]?.[0]?.messages?.[1]?.content).toContain("未返回最终 JSON 内容");
  });

  it("caps daily report JSON repair output to avoid runaway retries", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{
        finish_reason: "stop",
        message: { content: '{"headline":"已修复","blocks":[]}' },
      }],
    });
    const provider = createAiProvider(
      {
        apiKey: "sk-test",
        baseURL: "https://example.com/v1",
        model: "test-model",
      },
      {
        dailyReport: {
          systemPrompt: "生成日报。",
          promptTemplate: "{{articlesJson}}",
          maxTokens: 40960,
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

    await provider.repairDailyReportJson('{"headline":"未完成');

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]?.max_tokens).toBe(8192);
  });

  it("appends recent daily report topics when custom daily prompt lacks the placeholder", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: "{}",
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
        dailyReport: {
          systemPrompt: "生成日报。",
          promptTemplate: "日期：{{date}}\n候选内容 JSON：{{articlesJson}}",
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

    await provider.generateDailyReport({
      date: "2026-04-24",
      timezone: "Asia/Shanghai",
      articles: [{ id: 1, title: "今日候选" }],
      recentTopics: [{ date: "2026-04-23", title: "昨日已写主题" }],
    });

    const userContent = create.mock.calls[0]?.[0]?.messages?.[1]?.content;
    expect(userContent).toContain("候选内容 JSON");
    expect(userContent).toContain("日报标题字段规则");
    expect(userContent).toContain("顶层必须包含 headline 字段");
    expect(userContent).toContain("MM-DD日报 | ");
    expect(userContent).toContain("最近 7 天已写主题 JSON");
    expect(userContent).toContain("昨日已写主题");
    expect(userContent).toContain("历史主题使用规则");
  });

  it("does not append daily report fallback rules when the prompt config is current", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: "{}",
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
        dailyReport: {
          systemPrompt: DEFAULT_DAILY_REPORT_PROMPT,
          promptTemplate: DEFAULT_DAILY_REPORT_USER_PROMPT_TEMPLATE,
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

    await provider.generateDailyReport({
      date: "2026-04-24",
      timezone: "Asia/Shanghai",
      articles: [{ id: 1, title: "今日候选" }],
      recentTopics: [{ date: "2026-04-23", title: "昨日已写主题" }],
    });

    const userContent = create.mock.calls[0]?.[0]?.messages?.[1]?.content;
    expect(userContent).toContain("最近 7 天已写主题 JSON");
    expect(userContent).toContain("昨日已写主题");
    expect(userContent).not.toContain("日报标题字段规则");
    expect(userContent).not.toContain("历史主题使用规则");
  });
});
