import { describe, expect, it, vi } from "vitest";

import { createAiProvider } from "@/lib/ai/provider";
import { DEFAULT_DAILY_REPORT_TEMPLATE, normalizeDailyReportTemplateConfig } from "@/lib/daily-report/template";
import type { DailyReportPlanningCandidate } from "@/lib/daily-report/types";

const candidate: DailyReportPlanningCandidate = {
  id: 1,
  sourceNumber: 1,
  sourceKey: "item:item-1",
  itemId: "item-1",
  clusterId: null,
  title: "模型发布新版本",
  itemTitle: "模型发布新版本",
  sourceName: "来源",
  url: "https://example.com/1",
  summary: "摘要",
  qualityScore: 90,
  candidateScore: 90,
  sourceCount: 1,
  itemCount: 1,
  createdAt: "2026-08-14T00:00:00.000Z",
  publishedAt: "2026-08-14T00:00:00.000Z",
  eventType: "release",
  eventSubject: "模型",
  eventAction: "发布",
  eventObject: "新版本",
  eventDate: "2026-08-14",
  evidence: [],
};

describe("daily report staged provider", () => {
  it("exposes assess, plan, write and repair as separate JSON calls", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ assessments: [{ candidateId: 1, relevanceScore: 90, isWorthReading: true, suggestedBlockKey: "hot-topics", exclusionReason: null, eventHint: { eventType: "release", eventSubject: "模型", eventAction: "发布", eventObject: "新版本", eventDate: "2026-08-14" }, evidenceSummary: "证据", confidence: 0.9 }] }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ schemaVersion: 1, headlineHint: "模型发布", sections: [], excludedCandidateIds: [], selectionRationale: "" }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ blocks: [{ type: "section", title: "热点事件", items: [{ title: "模型发布", body: "正文", sourceIds: [1] }] }] }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ blocks: [{ type: "section", title: "热点事件", items: [{ title: "模型发布", body: "修复正文", sourceIds: [1] }] }] }) } }] });
    const provider = createAiProvider(
      { apiKey: "sk-test", baseURL: "https://example.com/v1", model: "test-model" },
      { dailyReport: { systemPrompt: "日报", promptTemplate: "{{articlesJson}}" } },
      { chat: { completions: { create } } },
    );
    const template = normalizeDailyReportTemplateConfig(DEFAULT_DAILY_REPORT_TEMPLATE);
    const assessments = await provider.assessDailyReportCandidates({ candidates: [candidate], template, recentTopicLookbackDays: 10 });
    const plan = await provider.planDailyReport({ ledger: { schemaVersion: 1, candidateCount: 1, assessedCount: 1, unassessedCandidateIds: [], assessments, batchCount: 1 }, topics: [], template, recentTopicLookbackDays: 10 });
    const draft = await provider.writeDailyReport({ selectedCandidates: [candidate], plan, template });
    const repaired = await provider.repairDailyReportDraft({ draft, violations: [], plan, template });
    expect(assessments[0]?.candidateId).toBe(1);
    expect(draft.blocks).toHaveLength(1);
    expect(repaired.blocks).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(4);
    const userPrompts = create.mock.calls.map((call) => call[0]?.messages?.[1]?.content as string).join("\n");
    expect(userPrompts).toContain("阶段：ASSESS");
    expect(userPrompts).toContain("阶段：PLAN");
    expect(userPrompts).toContain("阶段：WRITE");
    expect(userPrompts).toContain("阶段：REPAIR");

    const assessCall = create.mock.calls[0]?.[0];
    const assessSystemPrompt = assessCall?.messages?.[0]?.content as string;
    const assessUserPrompt = assessCall?.messages?.[1]?.content as string;
    expect(assessSystemPrompt).toContain("eventHint 为包含 eventType");
    expect(assessSystemPrompt).toContain("当前阶段：ASSESS");
    expect(assessSystemPrompt).toContain("JSON 语法是硬约束");
    expect(assessSystemPrompt).not.toContain("固定输出格式：");
    expect(assessSystemPrompt).not.toContain("旧版");
    expect(assessSystemPrompt).not.toContain("一次性日报");
    expect(assessUserPrompt).toContain("eventType:string|null");
    expect(assessUserPrompt).toContain("不能省略任何字段");
    expect(assessUserPrompt).toContain("confidence 为 0 到 1 的数字");
    expect(assessUserPrompt).toContain('"recentTopicLookbackDays":10');

    const planCall = create.mock.calls[1]?.[0];
    const planUserPrompt = planCall?.messages?.[1]?.content as string;
    const planSystemPrompt = planCall?.messages?.[0]?.content as string;
    expect(planUserPrompt).toContain('"sections"');
    expect(planUserPrompt).toContain('"blockKey":"hot-topics"');
    expect(planUserPrompt).toContain('"topicCandidateMap"');
    expect(planUserPrompt).toContain("如果选择某个候选");
    expect(planUserPrompt).not.toContain('"type":"text"');
    expect(planUserPrompt).not.toContain('"title":"摘要"');
    expect(planSystemPrompt).toContain("text block 不属于可规划栏目");
    expect(planUserPrompt).toContain('"recentTopicLookbackDays":10');
    const writeSystemPrompt = create.mock.calls[2]?.[0]?.messages?.[0]?.content as string;
    const writeUserPrompt = create.mock.calls[2]?.[0]?.messages?.[1]?.content as string;
    expect(writeSystemPrompt).toContain('顶层返回 {headline:string,blocks:Array}');
    expect(writeSystemPrompt).toContain("required=true 的 note");
    expect(writeSystemPrompt).toContain("notes 必须是 {label:string,text:string} 数组");
    expect(writeUserPrompt).not.toContain("历史主题去重规则");
    expect(writeUserPrompt).not.toContain("recentTopicRules");
    const repairUserPrompt = create.mock.calls[3]?.[0]?.messages?.[1]?.content as string;
    expect(repairUserPrompt).not.toContain("历史主题去重规则");
    expect(repairUserPrompt).not.toContain("recentTopicRules");
  });
});
