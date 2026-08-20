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
    const completion = (content: string) => ({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    const create = vi.fn()
      .mockResolvedValueOnce(completion(JSON.stringify({ assessments: [{ candidateId: 1, relevanceScore: 90, isWorthReading: true, suggestedBlockKey: "hot-topics", historyDecision: "new", matchedRecentTopicTitle: null }] })))
      .mockResolvedValueOnce(completion(JSON.stringify({ schemaVersion: 2, sections: [{ blockKey: "hot-topics", topics: [{ candidateIds: [1] }] }] })))
      .mockResolvedValueOnce(completion(JSON.stringify({ blocks: [{ type: "section", blockKey: "hot-topics", title: "热点事件", items: [{ topicId: "topic-1", title: "模型发布", body: "正文", sourceIds: [1] }] }] })))
      .mockResolvedValueOnce(completion(JSON.stringify({ blocks: [{ type: "section", blockKey: "hot-topics", title: "热点事件", items: [{ topicId: "topic-1", title: "模型发布（修复）", body: "修复后的正文", sourceIds: [1] }] }] })));
    const onUsage = vi.fn();
    const provider = createAiProvider(
      { apiKey: "sk-test", baseURL: "https://example.com/v1", model: "test-model" },
      { dailyReport: { systemPrompt: "日报", promptTemplate: "{{articlesJson}}" } },
      { chat: { completions: { create } } },
      { onUsage },
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
    expect(onUsage.mock.calls.map(([, usageKey]) => usageKey)).toEqual([
      "daily_report_assess",
      "daily_report_plan",
      "daily_report_write",
      "daily_report_write",
    ]);
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
    expect(planUserPrompt).toContain("一个独立事实命题");
    expect(planUserPrompt).toContain("不要把多个开源项目");
    expect(planUserPrompt).toContain("先从全部通过评估的候选中按重要性挑选“热点事件”");
    expect(planUserPrompt).toContain("同一 topic 只能进入一个栏目");
    expect(planUserPrompt).toContain("数量是硬约束");
    expect(planUserPrompt).toContain("topics 不是候选池");
    expect(planUserPrompt).toContain("达到 maxItems 后立即停止");
    expect(planUserPrompt).toContain("应尽量接近 maxItems");
    expect(planUserPrompt).not.toContain('"type":"text"');
    expect(planUserPrompt).not.toContain('"title":"摘要"');
    expect(planUserPrompt).not.toContain('"headlineInstruction"');
    expect(planUserPrompt).toContain("不要输出主题编号、栏目展示名、标题、理由或其他字段");
    expect(planSystemPrompt).toContain("text block 不属于 sections");
    expect(planSystemPrompt).toContain("cluster 只是上游来源聚合线索");
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

  it("returns a topic-scoped notes patch with explicit topicId and noteLabel feedback", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        patches: [{ topicId: "topic-21", notes: [{ label: "数据", text: "补充关键数据" }] }],
      }) } }],
    });
    const provider = createAiProvider(
      { apiKey: "sk-test", baseURL: "https://example.com/v1", model: "test-model" },
      { dailyReport: { systemPrompt: "日报", promptTemplate: "{{articlesJson}}" } },
      { chat: { completions: { create } } },
    );
    const template = normalizeDailyReportTemplateConfig({
      ...DEFAULT_DAILY_REPORT_TEMPLATE,
      blocks: DEFAULT_DAILY_REPORT_TEMPLATE.blocks.map((block) => block.type === "section" && block.key === "data-insights"
        ? { ...block, item: { ...block.item, notes: [{ label: "数据", required: true, instruction: "列出关键数字。" }] } }
        : block),
    });

    await expect(provider.repairDailyReportDraft({
      draft: {
        blocks: [{
          type: "section",
          blockKey: "data-insights",
          title: "数据与洞察",
          items: [{ topicId: "topic-21", title: "数据条目", body: "原正文", notes: [] }],
        }],
      },
      violations: [{
        code: "draft_required_note_missing",
        stage: "draft",
        blockKey: "data-insights",
        topicId: "topic-21",
        candidateIds: [21],
        noteLabel: "数据",
        noteInstruction: "列出关键数字。",
        message: "主题 topic-21 缺少必填 note“数据”。",
      }],
      selectedTopics: [{
        topicId: "topic-21",
        blockKey: "data-insights",
        candidateIds: [21],
        representativeCandidateId: 21,
        candidates: [candidate],
      }],
      template,
    })).resolves.toEqual({
      patches: [{ topicId: "topic-21", notes: [{ label: "数据", text: "补充关键数据" }] }],
    });

    const payload = create.mock.calls[0]?.[0];
    const systemPrompt = payload.messages[0].content as string;
    const userPrompt = payload.messages[1].content as string;
    expect(systemPrompt).toContain("REPAIR");
    expect(systemPrompt).toContain("只返回 notes 补丁");
    expect(userPrompt).toContain("topicId");
    expect(userPrompt).toContain("noteLabel");
    expect(userPrompt).toContain("missingNotes");
    expect(userPrompt).not.toContain('"sourceIds"');
  });

  it("carries Review guidance into PLAN and WRITE retry prompts", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify({ schemaVersion: 2, sections: [{ blockKey: "hot-topics", topics: [{ candidateIds: [1] }] }] }) } }],
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify({ headline: "日报", blocks: [{ type: "section", blockKey: "hot-topics", title: "热点事件", items: [{ topicId: "topic-1", title: "模型发布", body: "修复后的正文", notes: [] }] }] }) } }],
      });
    const provider = createAiProvider(
      { apiKey: "sk-test", baseURL: "https://example.com/v1", model: "test-model" },
      { dailyReport: { systemPrompt: "日报", promptTemplate: "{{articlesJson}}" } },
      { chat: { completions: { create } } },
    );
    const template = normalizeDailyReportTemplateConfig(DEFAULT_DAILY_REPORT_TEMPLATE);
    const reviewFeedback = {
      violations: [{
        code: "candidate_omitted" as const,
        severity: "error" as const,
        message: "重要候选未进入日报",
        candidateIds: [1],
        evidence: "候选 1 为当日高价值内容，但当前草稿没有对应主题。",
        guidance: "重新规划时优先将候选 1 纳入合适栏目，并避免挤掉其他高价值主题。",
      }],
      instruction: "优先修复 Review 发现的问题。",
    };

    await provider.planDailyReport({
      candidateBriefs: [],
      template,
      reviewFeedback,
    });
    await provider.writeDailyReport({
      selectedTopics: [{
        topicId: "topic-1",
        blockKey: "hot-topics",
        candidateIds: [1],
        representativeCandidateId: 1,
        candidates: [candidate],
      }],
      template,
      reviewFeedback,
    });

    const prompts = create.mock.calls.map((call) => call[0]?.messages?.map((message: { content?: string }) => message.content ?? "").join("\n") ?? "").join("\n");
    expect(prompts).toContain('"reviewFeedback"');
    expect(prompts).toContain("重新规划时优先将候选 1 纳入合适栏目");
    expect(prompts).toContain("优先修复 Review 发现的问题");
    expect(prompts).toContain("PLAN 重试可以调整主题归纳");
    expect(prompts).toContain("WRITE 重试只能在 selectedTopics");
  });
});
