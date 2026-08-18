import { describe, expect, it } from "vitest";

import {
  buildDailyReportCandidateBriefs,
  getDailyReportTopicPriority,
  materializeDailyReportPlan,
  normalizeDailyReportDraftForTemplate,
  orderAndLimitDailyReportPlan,
  orderAndLimitDailyReportPlanWithAudit,
  orderDailyReportDraft,
  splitDailyReportCandidates,
  validateDailyReportAssessments,
  validateDailyReportDraft,
  validateDailyReportPlan,
} from "@/lib/daily-report/planning";
import { normalizeDailyReportTemplateConfig } from "@/lib/daily-report/template";
import type {
  DailyReportCandidateAssessment,
  DailyReportPlanningCandidate,
  DailyReportPlanSelection,
} from "@/lib/daily-report/types";

function candidate(id: number, overrides: Partial<DailyReportPlanningCandidate> = {}): DailyReportPlanningCandidate {
  return {
    id,
    sourceNumber: id,
    sourceKey: `item:item-${id}`,
    itemId: `item-${id}`,
    clusterId: null,
    title: `候选 ${id} 标题`,
    itemTitle: `候选 ${id} 原标题`,
    sourceName: "测试来源",
    url: `https://example.com/${id}`,
    summary: "候选摘要",
    qualityScore: 80,
    candidateScore: 80,
    sourceCount: 1,
    itemCount: 1,
    createdAt: "2026-08-14T00:00:00.000Z",
    publishedAt: "2026-08-14T00:00:00.000Z",
    eventType: "release",
    eventSubject: "主体",
    eventAction: "发布",
    eventObject: `对象-${id}`,
    eventDate: "2026-08-14",
    evidence: [],
    ...overrides,
  };
}

function assessment(id: number, overrides: Partial<DailyReportCandidateAssessment> = {}): DailyReportCandidateAssessment {
  return {
    candidateId: id,
    relevanceScore: 80,
    isWorthReading: true,
    suggestedBlockKey: "hot-topics",
    ...overrides,
  };
}

function template() {
  return normalizeDailyReportTemplateConfig({
    schemaVersion: 2,
    headlineInstruction: "生成标题",
    recentTopicRules: [],
    globalRules: [],
    blocks: [
      { type: "text", title: "摘要", bodyInstruction: "生成摘要" },
      {
        type: "section",
        key: "hot-topics",
        title: "热点事件",
        description: "重要事件",
        required: true,
        minItems: 1,
        maxItems: 3,
        item: { bodyInstruction: "说明事件", notes: [] },
      },
    ],
  });
}

function orderedTemplate() {
  return normalizeDailyReportTemplateConfig({
    schemaVersion: 2,
    headlineInstruction: "生成标题",
    recentTopicRules: [],
    globalRules: [],
    blocks: [
      { type: "text", title: "摘要", bodyInstruction: "生成摘要" },
      {
        type: "section",
        key: "hot-topics",
        title: "热点事件",
        description: "重要事件",
        required: true,
        minItems: 1,
        maxItems: 2,
        item: { bodyInstruction: "说明事件", notes: [] },
      },
      {
        type: "section",
        key: "changes-practice",
        title: "变更与实践",
        description: "实践变化",
        required: false,
        minItems: 0,
        maxItems: 3,
        item: { bodyInstruction: "说明变化", notes: [] },
      },
    ],
  });
}

describe("daily report planning contracts", () => {
  it("uses null batch size as one complete batch and fixed positive sizes", () => {
    const candidates = [candidate(1), candidate(2), candidate(3), candidate(4), candidate(5)];
    expect(splitDailyReportCandidates(candidates, null).map((batch) => batch.map((item) => item.id))).toEqual([[1, 2, 3, 4, 5]]);
    expect(splitDailyReportCandidates(candidates, 2).map((batch) => batch.map((item) => item.id))).toEqual([[1, 2], [3, 4], [5]]);
    expect(() => splitDailyReportCandidates(candidates, 0)).toThrow("正整数");
  });

  it("builds one bounded brief per ASSESS-approved candidate without pre-grouping topics", () => {
    const candidates = [
      candidate(1, { clusterId: "cluster-a", summary: "候选一摘要".repeat(100) }),
      candidate(2, { clusterId: "cluster-a", summary: "候选二摘要".repeat(100) }),
      candidate(3, { clusterId: "cluster-b" }),
    ];
    const assessments = [
      assessment(1, { relevanceScore: 70 }),
      assessment(2, { relevanceScore: 95 }),
      assessment(3, { isWorthReading: false }),
    ];

    const briefs = buildDailyReportCandidateBriefs(candidates, assessments);

    expect(briefs).toHaveLength(2);
    expect(briefs.map((brief) => brief.candidateId)).toEqual([1, 2]);
    expect(briefs[0]).toMatchObject({ candidateId: 1, clusterId: "cluster-a", relevanceScore: 70 });
    expect(briefs[0]?.summaryExcerpt).toHaveLength(320);
    expect(briefs[1]?.summaryExcerpt).toHaveLength(320);
    expect(JSON.stringify(briefs)).not.toContain("https://example.com/");
  });

  it("keeps all readable candidates within the PLAN brief budget", () => {
    const candidates = Array.from({ length: 500 }, (_, index) => candidate(index + 1, {
      title: `超长候选标题 ${"标题".repeat(100)}`,
      sourceName: `超长来源 ${"来源".repeat(60)}`,
      summary: "超长摘要。".repeat(200),
      eventObject: `对象-${index}-${"对象".repeat(80)}`,
    }));
    const assessments = candidates.map((item) => assessment(item.id, { relevanceScore: item.id % 100 }));

    const briefs = buildDailyReportCandidateBriefs(candidates, assessments);

    expect(briefs).toHaveLength(500);
    expect(JSON.stringify(briefs).length).toBeLessThanOrEqual(220_000);
  });

  it("materializes PLAN topic IDs in code and allows cross-cluster grouping", () => {
    const selection: DailyReportPlanSelection = {
      schemaVersion: 2,
      sections: [{ blockKey: "hot-topics", topics: [{ candidateIds: [1, 2] }] }],
    };
    const plan = materializeDailyReportPlan(selection);

    expect(plan).toEqual({
      schemaVersion: 2,
      sections: [{ blockKey: "hot-topics", topics: [{ topicId: "topic-1", candidateIds: [1, 2] }] }],
    });
    expect(validateDailyReportPlan(plan, [candidate(1), candidate(2)], [assessment(1), assessment(2)], template())).toEqual([]);
  });

  it("orders topics by the shared priority rule and truncates Block overflow locally", () => {
    const candidates = [
      candidate(1, { candidateScore: 60, qualityScore: 70 }),
      candidate(2, { candidateScore: 95, qualityScore: 90 }),
      candidate(3, { candidateScore: 80, qualityScore: 85 }),
    ];
    const assessments = [
      assessment(1, { relevanceScore: 60 }),
      assessment(2, { relevanceScore: 95 }),
      assessment(3, { relevanceScore: 80 }),
    ];
    const plan = orderAndLimitDailyReportPlan(
      materializeDailyReportPlan({
        schemaVersion: 2,
        sections: [
          { blockKey: "changes-practice", topics: [{ candidateIds: [1] }] },
          { blockKey: "hot-topics", topics: [{ candidateIds: [1] }, { candidateIds: [2] }, { candidateIds: [3] }] },
        ],
      }),
      orderedTemplate(),
      candidates,
      assessments,
    );

    expect(getDailyReportTopicPriority(plan.sections[0]?.topics[0] ?? { topicId: "missing", candidateIds: [] }, candidates, assessments)).toBeGreaterThan(0);
    expect(getDailyReportTopicPriority({ topicId: "missing", candidateIds: [] }, candidates, assessments)).toBe(-Infinity);
    expect(plan.sections.map((section) => section.blockKey)).toEqual(["hot-topics", "changes-practice"]);
    expect(plan.sections[0]?.topics.map((topic) => topic.candidateIds)).toEqual([[2], [3]]);
  });

  it("records topic priority components and locally truncated topics for audit", () => {
    const result = orderAndLimitDailyReportPlanWithAudit(
      materializeDailyReportPlan({
        schemaVersion: 2,
        sections: [{ blockKey: "hot-topics", topics: [{ candidateIds: [1] }, { candidateIds: [2] }, { candidateIds: [3] }] }],
      }),
      template(),
      [
        candidate(1, { candidateScore: 60, qualityScore: 70 }),
        candidate(2, { candidateScore: 95, qualityScore: 90, sourceCount: 2, isFollowUp: true }),
        candidate(3, { candidateScore: 80, qualityScore: 85 }),
      ],
      [
        assessment(1, { relevanceScore: 60 }),
        assessment(2, { relevanceScore: 95 }),
        assessment(3, { relevanceScore: 80 }),
      ],
    );

    expect(result.audit).toMatchObject({
      schemaVersion: 1,
      topicPriorityVersion: "v1",
      inputTopicCount: 3,
      outputTopicCount: 3,
      truncatedTopicCount: 0,
    });
    expect(result.audit.sections[0]?.topics[0]).toMatchObject({
      candidateIds: [2],
      retained: true,
      priorityComponents: {
        candidateScore: 95,
        relevanceScore: 95,
        qualityScore: 90,
        evidenceBonus: 1.5,
        followUpBonus: 2,
      },
    });

    const overflow = orderAndLimitDailyReportPlanWithAudit(
      materializeDailyReportPlan({
        schemaVersion: 2,
        sections: [{ blockKey: "hot-topics", topics: [{ candidateIds: [1] }, { candidateIds: [2] }, { candidateIds: [3] }, { candidateIds: [4] }] }],
      }),
      template(),
      [candidate(1), candidate(2), candidate(3), candidate(4)],
      [assessment(1), assessment(2), assessment(3), assessment(4)],
    );
    expect(overflow.audit.truncatedTopicCount).toBe(1);
    expect(overflow.audit.sections[0]?.topics.find((topic) => !topic.retained)).toMatchObject({
      candidateIds: [4],
      retained: false,
      topicId: null,
    });
  });

  it("reorders generated blocks and items to the deterministic plan order", () => {
    const plan = orderAndLimitDailyReportPlan(
      materializeDailyReportPlan({
        schemaVersion: 2,
        sections: [
          { blockKey: "changes-practice", topics: [{ candidateIds: [3] }] },
          { blockKey: "hot-topics", topics: [{ candidateIds: [1] }, { candidateIds: [2] }] },
        ],
      }),
      orderedTemplate(),
      [candidate(1), candidate(2), candidate(3)],
      [assessment(1), assessment(2), assessment(3)],
    );
    const draft = orderDailyReportDraft({
      blocks: [
        {
          type: "section",
          blockKey: "changes-practice",
          title: "变更与实践",
          items: [{ topicId: "topic-3", title: "变化", body: "正文", sourceIds: [3] }],
        },
        {
          type: "text",
          title: "摘要",
          body: "摘要",
        },
        {
          type: "section",
          blockKey: "hot-topics",
          title: "热点事件",
          items: [
            { topicId: "topic-2", title: "热点二", body: "正文", sourceIds: [2] },
            { topicId: "topic-1", title: "热点一", body: "正文", sourceIds: [1] },
          ],
        },
      ],
    }, plan, orderedTemplate());

    expect(draft.blocks.map((block) => block.title)).toEqual(["摘要", "热点事件", "变更与实践"]);
    const hotBlock = draft.blocks.find((block) => block.type === "section" && block.blockKey === "hot-topics");
    expect(hotBlock?.type === "section" ? hotBlock.items.map((item) => item.topicId) : []).toEqual(["topic-1", "topic-2"]);
  });

  it("rejects duplicate candidate ownership across PLAN topics", () => {
    const plan = materializeDailyReportPlan({
      schemaVersion: 2,
      sections: [{ blockKey: "hot-topics", topics: [{ candidateIds: [1, 2] }, { candidateIds: [2, 3] }] }],
    });
    const violations = validateDailyReportPlan(
      plan,
      [candidate(1), candidate(2), candidate(3)],
      [assessment(1), assessment(2), assessment(3)],
      template(),
    );

    expect(violations.map((violation) => violation.code)).toContain("duplicate_candidate");
  });

  it("validates complete ASSESS coverage and excludes candidates marked not worth reading", () => {
    const batch = [candidate(1), candidate(2)];
    expect(validateDailyReportAssessments(batch, [assessment(1), assessment(2)])).toHaveLength(2);
    const plan = materializeDailyReportPlan({
      schemaVersion: 2,
      sections: [{ blockKey: "hot-topics", topics: [{ candidateIds: [1, 2] }] }],
    });
    const violations = validateDailyReportPlan(
      plan,
      batch,
      [assessment(1), assessment(2, { isWorthReading: false })],
      template(),
    );
    expect(violations.map((violation) => violation.code)).toContain("ineligible_candidate");
  });

  it("requires exactly one final draft item for every selected topic", () => {
    const plan = materializeDailyReportPlan({
      schemaVersion: 2,
      sections: [{ blockKey: "hot-topics", topics: [{ candidateIds: [1, 2] }] }],
    });
    const draft = {
      headline: "标题",
      blocks: [
        { type: "text" as const, title: "摘要", body: "摘要" },
        {
          type: "section" as const,
          blockKey: "hot-topics",
          title: "热点事件",
          items: [{ topicId: "topic-1", title: "主题条目", body: "正文", sourceIds: [1, 2], notes: [] }],
        },
      ],
    };

    expect(validateDailyReportDraft(draft, plan, [candidate(1), candidate(2)], template())).toEqual([]);
    expect(validateDailyReportDraft({
      ...draft,
      blocks: draft.blocks.map((block) => block.type === "section"
        ? { ...block, items: [...block.items, { ...block.items[0], title: "重复主题" }] }
        : block),
    }, plan, [candidate(1), candidate(2)], template()).map((violation) => violation.code)).toContain("draft_duplicate_topic");
  });

  it("applies title-only template sections before validation", () => {
    const baseTemplate = template();
    const titleOnlyTemplate = normalizeDailyReportTemplateConfig({
      ...baseTemplate,
      blocks: baseTemplate.blocks.map((block) => block.type === "section"
        ? { ...block, item: { ...block.item, bodyRequired: false, bodyInstruction: "" } }
        : block),
    });
    const draft = normalizeDailyReportDraftForTemplate({
      blocks: [{
        type: "section",
        blockKey: "hot-topics",
        title: "热点事件",
        items: [{ topicId: "topic-1", title: "一条信息", body: "不应展示", sourceIds: [1] }],
      }],
    }, titleOnlyTemplate);

    expect(draft.blocks[0]).toMatchObject({ items: [{ body: "" }] });
  });
});
