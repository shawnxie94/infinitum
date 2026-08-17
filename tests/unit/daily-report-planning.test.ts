import { describe, expect, it } from "vitest";

import { DEFAULT_DAILY_REPORT_TEMPLATE } from "@/lib/daily-report/template";
import { normalizeDailyReportTemplateConfig } from "@/lib/daily-report/template";
import {
  mergeDailyReportTopics,
  splitDailyReportCandidates,
  validateDailyReportAssessments,
  validateDailyReportDraft,
  validateDailyReportPlan,
} from "@/lib/daily-report/planning";
import type { DailyReportCandidateAssessment, DailyReportDraft, DailyReportPlanningCandidate } from "@/lib/daily-report/types";

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
    exclusionReason: null,
    eventHint: { eventType: "release", eventSubject: "主体", eventAction: "发布", eventObject: `对象-${id}`, eventDate: "2026-08-14" },
    evidenceSummary: "有明确来源证据",
    confidence: 0.9,
    ...overrides,
  };
}

describe("daily report planning contracts", () => {
  it("uses null batch size as one complete batch and fixed positive sizes without dynamic splitting", () => {
    const candidates = [candidate(1), candidate(2), candidate(3), candidate(4), candidate(5)];
    expect(splitDailyReportCandidates(candidates, null).map((batch) => batch.map((item) => item.id))).toEqual([[1, 2, 3, 4, 5]]);
    expect(splitDailyReportCandidates(candidates, 2).map((batch) => batch.map((item) => item.id))).toEqual([[1, 2], [3, 4], [5]]);
    expect(() => splitDailyReportCandidates(candidates, 0)).toThrow("正整数");
  });

  it("merges only deterministic identities and preserves ambiguous topics as separate", () => {
    const candidates = [
      candidate(1, { clusterId: "cluster-a" }),
      candidate(2, { clusterId: "cluster-a" }),
      candidate(3, { eventObject: "独立对象" }),
    ];
    const topics = mergeDailyReportTopics(
      candidates,
      [assessment(1), assessment(2), assessment(3)],
      new Map([[1, 0], [2, 1], [3, 1]]),
    );
    expect(topics).toHaveLength(2);
    expect(topics[0]?.candidateIds).toEqual([1, 2]);
    expect(topics[0]?.identitySource).toBe("cluster");
    expect(topics[0]?.sourceBatchIndexes).toEqual([0, 1]);
    expect(topics[1]?.candidateIds).toEqual([3]);
  });

  it("validates the complete ASSESS DTO before merging", () => {
    const batch = [candidate(1), candidate(2)];
    expect(validateDailyReportAssessments(batch, [assessment(1), assessment(2)])).toHaveLength(2);
    expect(() => validateDailyReportAssessments(batch, [assessment(1, { confidence: 2 }), assessment(2)])).toThrow("confidence");
    expect(() => validateDailyReportAssessments(batch, [assessment(1, { isWorthReading: false }), assessment(2)])).toThrow("exclusionReason");
    expect(() => validateDailyReportAssessments(batch, [{ ...assessment(1), eventHint: null }, assessment(2)])).toThrow("eventHint");
    expect(() => validateDailyReportAssessments(batch, [assessment(1, { evidenceSummary: "" }), assessment(2)])).toThrow("evidenceSummary");
  });

  it("rejects plan references outside the complete candidate/topic ledger", () => {
    const topics = mergeDailyReportTopics([candidate(1)], [assessment(1)]);
    const plan = {
      schemaVersion: 1 as const,
      headlineHint: null,
      sections: [{ blockKey: "missing", blockTitle: "不存在", topicIds: ["topic-404"], candidateIds: [404] }],
      excludedCandidateIds: [],
      selectionRationale: "",
    };
    const violations = validateDailyReportPlan(plan, topics, [candidate(1)], normalizeDailyReportTemplateConfig(DEFAULT_DAILY_REPORT_TEMPLATE));
    expect(violations.map((violation) => violation.code)).toEqual(expect.arrayContaining(["unknown_block", "unknown_topic", "unknown_candidate"]));
  });

  it("requires feasible required sections and preserves topic-to-candidate ownership", () => {
    const candidates = [candidate(1), candidate(2), candidate(3), candidate(4), candidate(5)];
    const topics = mergeDailyReportTopics(candidates, candidates.map((item) => assessment(item.id)));
    const template = normalizeDailyReportTemplateConfig(DEFAULT_DAILY_REPORT_TEMPLATE);
    const violations = validateDailyReportPlan({
      schemaVersion: 1,
      headlineHint: null,
      sections: [{ blockKey: "hot-topics", blockTitle: "热点事件", topicIds: ["topic-1"], candidateIds: [2] }],
      excludedCandidateIds: [],
      selectionRationale: "",
    }, topics, candidates, template);
    expect(violations.map((violation) => violation.code)).toEqual(expect.arrayContaining([
      "candidate_topic_mismatch",
      "section_min_items",
      "missing_required_block",
    ]));
  });

  it("rejects an impossible required-cardinality plan instead of relaxing template bounds", () => {
    const candidates = [candidate(1), candidate(2), candidate(3), candidate(4)];
    const topics = mergeDailyReportTopics(candidates, candidates.map((item) => assessment(item.id)));
    const template = normalizeDailyReportTemplateConfig(DEFAULT_DAILY_REPORT_TEMPLATE);
    const violations = validateDailyReportPlan({
      schemaVersion: 1,
      headlineHint: null,
      sections: [
        { blockKey: "hot-topics", blockTitle: "热点事件", topicIds: ["topic-1", "topic-2", "topic-3"], candidateIds: [1, 2, 3] },
        { blockKey: "changes-practice", blockTitle: "变更与实践", topicIds: ["topic-4"], candidateIds: [4] },
      ],
      excludedCandidateIds: [],
      selectionRationale: "",
    }, topics, candidates, template);
    expect(violations.map((violation) => violation.code)).toContain("insufficient_required_candidates");
    expect(violations.map((violation) => violation.code)).toContain("section_min_items");
  });

  it("validates draft block identity, non-empty item content and source ownership", () => {
    const candidates = [candidate(1), candidate(2)];
    const template = normalizeDailyReportTemplateConfig(DEFAULT_DAILY_REPORT_TEMPLATE);
    const plan = {
      schemaVersion: 1 as const,
      headlineHint: null,
      sections: [
        { blockKey: "hot-topics", blockTitle: "热点事件", topicIds: [], candidateIds: [1] },
        { blockKey: "changes-practice", blockTitle: "变更与实践", topicIds: [], candidateIds: [2] },
      ],
      excludedCandidateIds: [],
      selectionRationale: "",
    };
    const violations = validateDailyReportDraft({
      blocks: [
        {
          type: "section",
          blockKey: "hot-topics",
          title: "未知栏目",
          items: [{ title: "", body: "", sourceIds: [999] }],
        },
      ],
    }, plan, candidates, template);
    expect(violations.map((violation) => violation.code)).toEqual(expect.arrayContaining([
      "block_title_mismatch",
      "draft_item_empty",
      "draft_source_not_planned",
      "missing_text_block",
    ]));
  });

  it("rejects empty source references instead of treating the item as valid", () => {
    const candidates = [candidate(1), candidate(2), candidate(3), candidate(4), candidate(5)];
    const template = normalizeDailyReportTemplateConfig(DEFAULT_DAILY_REPORT_TEMPLATE);
    const plan = {
      schemaVersion: 1 as const,
      headlineHint: null,
      sections: [
        { blockKey: "hot-topics", blockTitle: "热点事件", topicIds: [], candidateIds: [1, 2, 3] },
        { blockKey: "changes-practice", blockTitle: "变更与实践", topicIds: [], candidateIds: [4, 5] },
      ],
      excludedCandidateIds: [],
      selectionRationale: "",
    };
    const violations = validateDailyReportDraft({
      blocks: [
        { type: "text", title: "摘要", body: "摘要内容" },
        { type: "section", blockKey: "hot-topics", title: "热点事件", items: [{ title: "条目", body: "正文", sourceIds: [] }] },
        { type: "section", blockKey: "changes-practice", title: "变更与实践", items: [{ title: "条目", body: "正文", sourceIds: [4] }, { title: "条目 2", body: "正文", sourceIds: [5] }] },
        { type: "text", title: "趋势观察", body: "趋势内容" },
      ],
    }, plan, candidates, template);
    expect(violations.map((violation) => violation.code)).toContain("draft_source_empty");
  });

  it("requires exact block keys, required notes, and unique source references", () => {
    const candidates = [candidate(1), candidate(2), candidate(3), candidate(4), candidate(5)];
    const template = normalizeDailyReportTemplateConfig(DEFAULT_DAILY_REPORT_TEMPLATE);
    const plan = {
      schemaVersion: 1 as const,
      headlineHint: null,
      sections: [
        { blockKey: "hot-topics", blockTitle: "热点事件", topicIds: [], candidateIds: [1, 2, 3] },
        { blockKey: "changes-practice", blockTitle: "变更与实践", topicIds: [], candidateIds: [4, 5] },
      ],
      excludedCandidateIds: [],
      selectionRationale: "",
    };
    const draft: DailyReportDraft = {
      blocks: [
        {
          type: "section",
          blockKey: "hot-topics",
          title: "热点事件",
          items: [
            { title: "候选 1", body: "正文", sourceIds: [1] },
            { title: "候选 2", body: "正文", sourceIds: [1] },
            { title: "候选 3", body: "正文", sourceIds: [3], notes: [{ label: "重点", text: "值得关注" }] },
          ],
        },
        {
          type: "section",
          blockKey: "changes-practice",
          title: "变更与实践",
          items: [
            { title: "候选 4", body: "正文", sourceIds: [4] },
            { title: "候选 5", body: "正文", sourceIds: [5] },
          ],
        },
      ],
    };
    const violations = validateDailyReportDraft(draft, plan, candidates, template);
    const wrongKeyViolations = validateDailyReportDraft({
      ...draft,
      blocks: draft.blocks.map((block, index) => index === 0 && block.type === "section"
        ? { ...block, blockKey: "热点事件" }
        : block),
    }, plan, candidates, template);
    expect(violations.map((violation) => violation.code)).toEqual(expect.arrayContaining([
      "draft_duplicate_source",
      "draft_required_note_missing",
    ]));
    expect(wrongKeyViolations.map((violation) => violation.code)).toContain("unknown_block");
  });
});
