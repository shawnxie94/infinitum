import { describe, expect, it, vi } from "vitest";

import { createAiProvider, createDailyReportStageContext } from "@/lib/ai/provider";
import { DEFAULT_DAILY_REPORT_TEMPLATE, normalizeDailyReportTemplateConfig } from "@/lib/daily-report/template";
import type { DailyReportPlanningCandidate, DailyReportPlanningCandidateBrief } from "@/lib/daily-report/types";

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
  it("uses isolated ASSESS/PLAN/WRITE calls and repairs WRITE in the same context", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ assessments: [{ candidateId: 1, relevanceScore: 90, isWorthReading: true, suggestedBlockKey: "hot-topics", historyDecision: "new", matchedRecentTopicTitle: null }] }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ schemaVersion: 2, sections: [{ blockKey: "hot-topics", topics: [{ candidateIds: [1] }] }] }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ blocks: [{ type: "section", blockKey: "hot-topics", title: "热点事件", items: [{ topicId: "topic-1", title: "模型发布", body: "正文", sourceIds: [1] }] }] }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ blocks: [{ type: "section", blockKey: "hot-topics", title: "热点事件", items: [{ topicId: "topic-1", title: "模型发布（修复）", body: "修复后的正文", sourceIds: [1] }] }] }) } }] });
    const provider = createAiProvider(
      { apiKey: "sk-test", baseURL: "https://example.com/v1", model: "test-model" },
      { dailyReport: { systemPrompt: "日报", promptTemplate: "{{articlesJson}}" } },
      { chat: { completions: { create } } },
    );
    const template = normalizeDailyReportTemplateConfig(DEFAULT_DAILY_REPORT_TEMPLATE);
    const assessments = await provider.assessDailyReportCandidates({
      candidates: [candidate],
      template,
      recentTopics: [{
        date: "2026-08-13",
        sourceNumber: 1,
        sectionName: "热点事件",
        topic: "旧主题",
        title: "旧主题",
        eventType: "release",
        eventSubject: "旧主体",
        eventAction: "发布",
        eventObject: "旧对象",
        eventDate: null,
      }],
      recentTopicLookbackDays: 10,
    });
    const candidateBriefs: DailyReportPlanningCandidateBrief[] = [{
      candidateId: 1,
      clusterId: null,
      title: candidate.title,
      sourceName: candidate.sourceName,
      summaryExcerpt: candidate.summary,
      qualityScore: candidate.qualityScore,
      candidateScore: candidate.candidateScore,
      relevanceScore: 90,
      suggestedBlockKey: "hot-topics",
      sourceCount: candidate.sourceCount,
      itemCount: candidate.itemCount,
      publishedAt: candidate.publishedAt,
      publishedAtKnown: true,
      eventType: candidate.eventType,
      eventSubject: candidate.eventSubject,
      eventAction: candidate.eventAction,
      eventObject: candidate.eventObject,
      eventDate: candidate.eventDate,
    }];
    await provider.planDailyReport({ candidateBriefs, template, recentTopicLookbackDays: 10 });
    const writeContext = createDailyReportStageContext("write", "write-input");
    const draft = await provider.writeDailyReport({ selectedTopics: [{ topicId: "topic-1", blockKey: "hot-topics", candidateIds: [1], representativeCandidateId: 1, candidates: [candidate] }], template, stageContext: writeContext });
    const retriedDraft = await provider.writeDailyReport({
      selectedTopics: [{ topicId: "topic-1", blockKey: "hot-topics", candidateIds: [1], representativeCandidateId: 1, candidates: [candidate] }],
      template,
      stageContext: writeContext,
      validationFeedback: {
        type: "VALIDATION_FEEDBACK",
        stage: "write",
        violations: [{ code: "draft_topic_missing", stage: "draft", topicId: "topic-1", message: "草稿缺少主题 topic-1 对应的日报条目。" }],
        instruction: "只修正反馈中列出的问题，返回完整的当前阶段结果。",
      },
    });
    expect(assessments[0]?.candidateId).toBe(1);
    expect(assessments[0]?.matchedRecentTopicTitle).toBeNull();
    expect(draft.blocks).toHaveLength(1);
    const retriedSection = retriedDraft.blocks.find((block) => block.type === "section");
    expect(retriedSection?.items[0]?.title).toBe("模型发布（修复）");
    expect(create).toHaveBeenCalledTimes(4);
    const userPrompts = create.mock.calls.map((call) => call[0]?.messages?.[1]?.content as string).join("\n");
    expect(userPrompts).toContain("阶段：ASSESS");
    expect(userPrompts).toContain("阶段：PLAN");
    expect(userPrompts).toContain("阶段：WRITE");

    const assessCall = create.mock.calls[0]?.[0];
    const assessSystemPrompt = assessCall?.messages?.[0]?.content as string;
    const assessUserPrompt = assessCall?.messages?.[1]?.content as string;
    expect(assessSystemPrompt).toContain("suggestedBlockKey");
    expect(assessSystemPrompt).toContain("当前阶段：ASSESS");
    expect(assessSystemPrompt).toContain("JSON 语法是硬约束");
    expect(assessSystemPrompt).not.toContain("固定输出格式：");
    expect(assessSystemPrompt).not.toContain("旧版");
    expect(assessSystemPrompt).not.toContain("一次性日报");
    expect(assessUserPrompt).toContain("candidateScore");
    expect(assessUserPrompt).toContain("只返回上述六个字段");
    expect(assessUserPrompt).toContain("不附带其他解释字段");
    expect(assessUserPrompt).toContain('"recentTopics"');
    expect(assessUserPrompt).toContain("historyDecision");
    expect(assessUserPrompt).toContain("matchedRecentTopicTitle");
    expect(assessUserPrompt).toContain("historyTopicRules");
    expect(assessUserPrompt).toContain('"recentTopicLookbackDays":10');
    expect(assessUserPrompt).not.toContain('"required"');
    expect(assessUserPrompt).not.toContain('"minItems"');
    expect(assessUserPrompt).not.toContain('"maxItems"');

    const planCall = create.mock.calls[1]?.[0];
    const planUserPrompt = planCall?.messages?.[1]?.content as string;
    const planSystemPrompt = planCall?.messages?.[0]?.content as string;
    expect(planUserPrompt).toContain('"sections"');
    expect(planUserPrompt).toContain('"sections":[{"blockKey"');
    expect(planUserPrompt).toContain('"blockKey":"hot-topics"');
    expect(planUserPrompt).toContain('"candidateBriefs"');
    expect(planUserPrompt).toContain('"summaryExcerpt"');
    expect(planUserPrompt).toContain('"candidateScore"');
    expect(planUserPrompt).toContain("重新归纳最终日报主题");
    expect(planUserPrompt).not.toContain('"type":"text"');
    expect(planUserPrompt).not.toContain('"title":"摘要"');
    expect(planUserPrompt).not.toContain('"headlineInstruction"');
    expect(planUserPrompt).toContain("不要输出主题编号、栏目展示名、标题、理由或其他字段");
    expect(planSystemPrompt).toContain("text block 不属于 sections");
    expect(planUserPrompt).toContain('"recentTopicLookbackDays":10');
    expect(planUserPrompt).toContain('"historyTopicRules"');
    const writeSystemPrompt = create.mock.calls[2]?.[0]?.messages?.[0]?.content as string;
    const writeUserPrompt = create.mock.calls[2]?.[0]?.messages?.[1]?.content as string;
    expect(writeSystemPrompt).toContain("每个 selectedTopics 必须生成一个 item");
    expect(writeSystemPrompt).toContain("required=true 的 note");
    expect(writeSystemPrompt).toContain("notes 必须是 {label:string,text:string} 数组");
    expect(writeSystemPrompt).toContain("输出对象本身就是日报内容");
    expect(writeSystemPrompt).toContain("禁止输出 draft、result、data、output 等外层包装键");
    expect(writeUserPrompt).toContain("顶层直接包含 headline 和 blocks");
    expect(writeUserPrompt).toContain('"writingRules"');
    expect(writeUserPrompt).not.toContain("日报 Draft JSON");
    expect(writeUserPrompt).not.toContain("历史主题判断策略");
    expect(writeUserPrompt).not.toContain("historyTopicRules");
    expect(writeUserPrompt).not.toContain('"sourceIds":');
    expect(writeUserPrompt).not.toContain('"candidateScore"');
    const writeRetryCall = create.mock.calls[3]?.[0];
    expect(writeRetryCall?.messages).toHaveLength(5);
    expect(writeRetryCall?.messages?.[0]?.role).toBe("system");
    expect(writeRetryCall?.messages?.[1]?.role).toBe("user");
    expect(writeRetryCall?.messages?.[2]?.role).toBe("assistant");
    expect(writeRetryCall?.messages?.[3]?.role).toBe("user");
    expect(writeRetryCall?.messages?.[3]?.content).toContain("VALIDATION_FEEDBACK");
    expect(writeRetryCall?.messages?.[3]?.content).toContain("draft_topic_missing");
    expect(writeRetryCall?.messages?.[4]?.role).toBe("assistant");
  });
});
