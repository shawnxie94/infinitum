import type {
  DailyReportTemplateSectionBlock,
  DailyReportTemplateTextBlock,
  NormalizedDailyReportTemplate,
} from "@/lib/daily-report/template";
import type {
  DailyReportCandidate,
  DailyReportCandidateAssessment,
  DailyReportDraft,
  DailyReportModelDraft,
  DailyReportPlan,
  DailyReportPlanTopic,
  DailyReportPlanSelection,
  DailyReportPlanningCandidate,
  DailyReportPlanningCandidateBrief,
  DailyReportPlanningAudit,
  DailyReportPlanningAuditSection,
  DailyReportPlanningAuditTopic,
  DailyReportRepairPatchResult,
  DailyReportSelectedTopic,
  DailyReportTopicPriorityComponents,
  DailyReportViolation,
} from "@/lib/daily-report/types";
import { DAILY_REPORT_HISTORY_DECISIONS } from "@/lib/daily-report/types";

export type { NormalizedDailyReportTemplate } from "@/lib/daily-report/template";

export const DAILY_REPORT_ATTEMPT_MATRIX = [
  { stage: "PREPARE", maxAttempts: 1, retry: "none" },
  { stage: "ASSESS", maxAttempts: 2, retry: "same_batch" },
  { stage: "MERGE", maxAttempts: 1, retry: "none" },
  { stage: "PLAN", maxAttempts: 2, retry: "same_ledger" },
  { stage: "WRITE", maxAttempts: 2, retry: "same_plan" },
  { stage: "VALIDATE", maxAttempts: 1, retry: "none" },
  { stage: "PERSIST_PUBLISH", maxAttempts: 2, retry: "db_only" },
] as const;

export function toDailyReportPlanningCandidate(candidate: DailyReportCandidate): DailyReportPlanningCandidate {
  return {
    ...candidate,
    sourceNumber: candidate.id,
    evidence: candidate.evidenceItems ?? [],
  };
}

export function splitDailyReportCandidates(
  candidates: DailyReportPlanningCandidate[],
  batchSize: number | null | undefined,
) {
  if (candidates.length === 0) return [];
  if (batchSize == null) return [candidates.slice()];
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error("日报规划 batch size 必须是正整数或 null。");
  }
  const batches: DailyReportPlanningCandidate[][] = [];
  for (let index = 0; index < candidates.length; index += batchSize) {
    batches.push(candidates.slice(index, index + batchSize));
  }
  return batches;
}

function nullableString(value: unknown) {
  return value === null || typeof value === "string";
}

function isFiniteNumberInRange(value: unknown, minimum: number, maximum: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

export function validateDailyReportAssessments(
  batch: DailyReportPlanningCandidate[],
  rawAssessments: unknown,
): DailyReportCandidateAssessment[] {
  if (!Array.isArray(rawAssessments)) {
    throw new Error("ASSESS 返回必须是数组。");
  }
  const batchIds = new Set(batch.map((candidate) => candidate.id));
  const returnedIds = new Set<number>();
  const assessments: DailyReportCandidateAssessment[] = [];
  for (const rawAssessment of rawAssessments) {
    if (!isRecord(rawAssessment)) throw new Error("ASSESS 返回包含无效评估对象。");
    const candidateId = rawAssessment.candidateId;
    if (typeof candidateId !== "number" || !Number.isInteger(candidateId) || !batchIds.has(candidateId)) {
      throw new Error(`ASSESS 返回未知候选 ${String(candidateId)}。`);
    }
    if (returnedIds.has(candidateId)) throw new Error(`ASSESS 重复返回候选 ${candidateId}。`);
    returnedIds.add(candidateId);
    if (!isFiniteNumberInRange(rawAssessment.relevanceScore, 0, 100)) {
      throw new Error(`ASSESS 候选 ${candidateId} 的 relevanceScore 必须是 0 到 100 的有限数字。`);
    }
    if (typeof rawAssessment.isWorthReading !== "boolean") {
      throw new Error(`ASSESS 候选 ${candidateId} 的 isWorthReading 必须是布尔值。`);
    }
    if (!nullableString(rawAssessment.suggestedBlockKey)
      || (typeof rawAssessment.suggestedBlockKey === "string" && !rawAssessment.suggestedBlockKey.trim())) {
      throw new Error(`ASSESS 候选 ${candidateId} 的 suggestedBlockKey 必须是非空字符串或 null。`);
    }
    if (
      typeof rawAssessment.historyDecision !== "string" ||
      !DAILY_REPORT_HISTORY_DECISIONS.includes(rawAssessment.historyDecision as typeof DAILY_REPORT_HISTORY_DECISIONS[number])
    ) {
      throw new Error(`ASSESS 候选 ${candidateId} 的 historyDecision 必须是 new、duplicate、follow_up 或 uncertain。`);
    }
    const historyDecision = rawAssessment.historyDecision as typeof DAILY_REPORT_HISTORY_DECISIONS[number];
    if (rawAssessment.matchedRecentTopicTitle !== undefined && !nullableString(rawAssessment.matchedRecentTopicTitle)) {
      throw new Error(`ASSESS 候选 ${candidateId} 的 matchedRecentTopicTitle 必须是字符串或 null。`);
    }
    const matchedRecentTopicTitle = typeof rawAssessment.matchedRecentTopicTitle === "string"
      ? rawAssessment.matchedRecentTopicTitle.trim() || null
      : null;
    if (historyDecision !== "duplicate" && matchedRecentTopicTitle !== null) {
      throw new Error(`ASSESS 候选 ${candidateId} 只有 historyDecision=duplicate 时才能填写 matchedRecentTopicTitle。`);
    }
    assessments.push({
      candidateId,
      relevanceScore: rawAssessment.relevanceScore as number,
      // A duplicate decision is a hard local boundary after the model has
      // compared the candidate with the supplied recent topics.
      isWorthReading: historyDecision === "duplicate" ? false : rawAssessment.isWorthReading as boolean,
      suggestedBlockKey: rawAssessment.suggestedBlockKey === null
        ? null
        : (rawAssessment.suggestedBlockKey as string).trim(),
      historyDecision,
      matchedRecentTopicTitle,
    });
  }
  if (returnedIds.size !== batchIds.size) throw new Error("ASSESS 未覆盖当前批次全部候选。");
  return assessments;
}

const DAILY_REPORT_PLAN_TOPIC_TITLE_MAX_CHARS = 160;
const DAILY_REPORT_PLAN_SOURCE_NAME_MAX_CHARS = 80;
const DAILY_REPORT_PLAN_TOPIC_SUMMARY_MAX_CHARS = 320;
const DAILY_REPORT_PLAN_TOTAL_SUMMARY_CHARS = 40_000;
const DAILY_REPORT_PLAN_MAX_BRIEF_CHARS = 220_000;

function truncateDailyReportPromptText(value: string | null | undefined, maxChars: number) {
  const normalized = value?.trim() ?? "";
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function fitDailyReportCandidateBriefsToBudget(briefs: DailyReportPlanningCandidateBrief[]) {
  if (JSON.stringify(briefs).length <= DAILY_REPORT_PLAN_MAX_BRIEF_CHARS) return briefs;

  const withoutEventDetails = briefs.map((candidate) => ({
    ...candidate,
    eventType: null,
    eventSubject: null,
    eventAction: null,
    eventObject: null,
    eventDate: null,
  }));
  if (JSON.stringify(withoutEventDetails).length <= DAILY_REPORT_PLAN_MAX_BRIEF_CHARS) return withoutEventDetails;

  const withShortSummaries = withoutEventDetails.map((topic) => ({
    ...topic,
    summaryExcerpt: truncateDailyReportPromptText(topic.summaryExcerpt, 160) || null,
    evidenceItems: topic.evidenceItems?.map((item) => ({
      ...item,
      summaryExcerpt: truncateDailyReportPromptText(item.summaryExcerpt, 100) || null,
    })),
  }));
  if (JSON.stringify(withShortSummaries).length <= DAILY_REPORT_PLAN_MAX_BRIEF_CHARS) return withShortSummaries;

  const compact = withShortSummaries.map((topic) => ({
    ...topic,
    title: truncateDailyReportPromptText(topic.title, 80),
    sourceName: truncateDailyReportPromptText(topic.sourceName, 48),
    summaryExcerpt: null,
    evidenceItems: topic.evidenceItems?.map((item) => ({
      title: truncateDailyReportPromptText(item.title, 60),
      sourceName: truncateDailyReportPromptText(item.sourceName, 36),
      publishedAt: item.publishedAt,
    })),
  }));
  if (JSON.stringify(compact).length <= DAILY_REPORT_PLAN_MAX_BRIEF_CHARS) return compact;

  return compact.map((topic) => ({
    ...topic,
    title: truncateDailyReportPromptText(topic.title, 40),
    sourceName: undefined,
    summaryExcerpt: null,
    evidenceItems: undefined,
    eventType: null,
    eventSubject: null,
    eventAction: null,
    eventObject: null,
    eventDate: null,
  }));
}

/**
 * Build the bounded candidate view that PLAN needs for global topic
 * synthesis. Full candidates remain available to WRITE; PLAN receives every
 * candidate that survived ASSESS, without a rule-generated topic grouping.
 */
export function buildDailyReportCandidateBriefs(
  candidates: DailyReportPlanningCandidate[],
  assessments: DailyReportCandidateAssessment[],
): DailyReportPlanningCandidateBrief[] {
  const assessmentById = new Map(assessments.map((assessment) => [assessment.candidateId, assessment]));
  let remainingSummaryChars = DAILY_REPORT_PLAN_TOTAL_SUMMARY_CHARS;

  const briefs = candidates
    .filter((candidate) => assessmentById.get(candidate.id)?.isWorthReading)
    .map((candidate) => {
      const assessment = assessmentById.get(candidate.id);
      const summaryExcerpt = remainingSummaryChars > 0
        ? truncateDailyReportPromptText(candidate.summary, Math.min(DAILY_REPORT_PLAN_TOPIC_SUMMARY_MAX_CHARS, remainingSummaryChars))
        : null;
      if (summaryExcerpt !== null) remainingSummaryChars -= summaryExcerpt.length;
      return {
        candidateId: candidate.id,
        title: truncateDailyReportPromptText(candidate.title, DAILY_REPORT_PLAN_TOPIC_TITLE_MAX_CHARS),
        clusterId: candidate.clusterId,
        sourceName: truncateDailyReportPromptText(candidate.sourceName, DAILY_REPORT_PLAN_SOURCE_NAME_MAX_CHARS),
        summaryExcerpt,
        evidenceItems: candidate.evidence.slice(0, 3).map((item) => ({
          title: truncateDailyReportPromptText(item.title, 120),
          sourceName: truncateDailyReportPromptText(item.sourceName, DAILY_REPORT_PLAN_SOURCE_NAME_MAX_CHARS),
          summaryExcerpt: truncateDailyReportPromptText(item.summary, 160) || null,
          publishedAt: item.publishedAt,
        })),
        qualityScore: candidate.qualityScore,
        candidateScore: candidate.candidateScore,
        relevanceScore: assessment?.relevanceScore ?? 0,
        suggestedBlockKey: assessment?.suggestedBlockKey ?? null,
        sourceCount: candidate.sourceCount,
        itemCount: candidate.itemCount,
        publishedAt: candidate.publishedAt,
        publishedAtKnown: candidate.publishedAtKnown,
        eventType: truncateDailyReportPromptText(candidate.eventType, 80) || null,
        eventSubject: truncateDailyReportPromptText(candidate.eventSubject, 120) || null,
        eventAction: truncateDailyReportPromptText(candidate.eventAction, 120) || null,
        eventObject: truncateDailyReportPromptText(candidate.eventObject, 160) || null,
        eventDate: candidate.eventDate,
        isFollowUp: candidate.isFollowUp,
        newItemCountOnDate: candidate.newItemCountOnDate,
        newSourceCountOnDate: candidate.newSourceCountOnDate,
        historyDecision: assessment?.historyDecision ?? "new",
      } satisfies DailyReportPlanningCandidateBrief;
    });

  return fitDailyReportCandidateBriefsToBudget(briefs);
}

export function materializeDailyReportPlan(
  selection: DailyReportPlanSelection,
): DailyReportPlan {
  let topicSequence = 0;
  return {
    schemaVersion: 2,
    sections: Array.isArray(selection?.sections)
      ? selection.sections.map((section) => ({
          blockKey: typeof section?.blockKey === "string" ? section.blockKey.trim() : "",
          topics: Array.isArray(section?.topics)
            ? section.topics.map((topic) => ({
                topicId: `topic-${++topicSequence}`,
                candidateIds: Array.isArray(topic?.candidateIds) ? [...topic.candidateIds] : [],
              }))
            : [],
        }))
      : [],
  };
}

export function toDailyReportModelDraft(draft: DailyReportDraft | DailyReportModelDraft): DailyReportModelDraft {
  if (!draft || typeof draft !== "object" || !Array.isArray(draft.blocks)) {
    return draft as DailyReportModelDraft;
  }
  return {
    ...draft,
    blocks: draft.blocks.map((block) => block.type === "section"
      ? {
          ...block,
          items: block.items.map((item) => {
            const modelItem = { ...item } as typeof item & { sourceIds?: number[] };
            delete modelItem.sourceIds;
            return modelItem;
          }),
        }
      : block),
  } as DailyReportModelDraft;
}

export function applyDailyReportRepairPatches(
  draft: DailyReportDraft | DailyReportModelDraft,
  result: DailyReportRepairPatchResult,
): DailyReportDraft | DailyReportModelDraft {
  if (!draft || !Array.isArray(draft.blocks)) return draft;
  const patchesByTopicId = new Map(
    (result?.patches ?? [])
      .filter((patch) => typeof patch?.topicId === "string" && Array.isArray(patch.notes))
      .map((patch) => [patch.topicId.trim(), patch] as const),
  );

  return {
    ...draft,
    blocks: draft.blocks.map((block) => block.type === "section"
      ? {
          ...block,
          items: block.items.map((item) => {
            const patch = item.topicId ? patchesByTopicId.get(item.topicId) : undefined;
            if (!patch) return item;
            const notesByLabel = new Map((item.notes ?? []).map((note) => [note.label, note]));
            for (const note of patch.notes) {
              if (typeof note?.label !== "string" || typeof note.text !== "string") continue;
              const label = note.label.trim();
              const text = note.text.trim();
              if (label && text) notesByLabel.set(label, { label, text });
            }
            return { ...item, notes: Array.from(notesByLabel.values()) };
          }),
        }
      : block),
  } as DailyReportDraft | DailyReportModelDraft;
}

export function omitInvalidOptionalDailyReportTopics(
  draft: DailyReportDraft | DailyReportModelDraft,
  violations: DailyReportViolation[],
  template: NormalizedDailyReportTemplate,
  alreadyOmittedTopicIds: ReadonlySet<string> = new Set(),
) {
  const sectionByKey = new Map(
    sectionBlocks(template)
      .filter((block) => block.key)
      .map((block) => [block.key!, block]),
  );
  const invalidTopicIdsByBlock = new Map<string, Set<string>>();
  for (const violation of violations) {
    if (violation.code !== "draft_required_note_missing") continue;
    if (!violation.topicId || !violation.blockKey) continue;
    const block = sectionByKey.get(violation.blockKey);
    if (!block || block.required) continue;
    const topicIds = invalidTopicIdsByBlock.get(violation.blockKey) ?? new Set<string>();
    topicIds.add(violation.topicId);
    invalidTopicIdsByBlock.set(violation.blockKey, topicIds);
  }

  const omittedTopicIds = new Set(alreadyOmittedTopicIds);
  if (!draft || !Array.isArray(draft.blocks)) return { draft, omittedTopicIds };
  const nextDraft = {
    ...draft,
    blocks: draft.blocks.map((block) => {
      if (block.type !== "section" || !block.blockKey) return block;
      const topicIds = invalidTopicIdsByBlock.get(block.blockKey);
      if (!topicIds) return block;
      const templateBlock = sectionByKey.get(block.blockKey);
      if (!templateBlock) return block;
      const removableCount = Math.max(0, block.items.length - (templateBlock.minItems ?? 0));
      let removedCount = 0;
      const items = block.items.filter((item) => {
        if (!item.topicId || !topicIds.has(item.topicId) || removedCount >= removableCount) return true;
        removedCount += 1;
        omittedTopicIds.add(item.topicId);
        return false;
      });
      return items.length === block.items.length ? block : { ...block, items };
    }),
  } as DailyReportDraft | DailyReportModelDraft;

  return { draft: nextDraft, omittedTopicIds };
}

export function buildDailyReportSelectedTopics(
  plan: DailyReportPlan,
  candidates: DailyReportPlanningCandidate[],
  assessments: DailyReportCandidateAssessment[],
): DailyReportSelectedTopic[] {
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const assessmentById = new Map(assessments.map((assessment) => [assessment.candidateId, assessment]));
  return plan.sections.flatMap((section) => section.topics.map((topic) => {
    const topicCandidates = topic.candidateIds
      .map((candidateId) => candidateById.get(candidateId))
      .filter((candidate): candidate is DailyReportPlanningCandidate => Boolean(candidate));
    const representative = [...topicCandidates].sort((left, right) => (
      (assessmentById.get(right.id)?.relevanceScore ?? 0) - (assessmentById.get(left.id)?.relevanceScore ?? 0)
      || right.candidateScore - left.candidateScore
      || right.sourceCount - left.sourceCount
      || left.id - right.id
    ))[0];
    return {
      topicId: topic.topicId,
      blockKey: section.blockKey,
      candidateIds: [...topic.candidateIds],
      representativeCandidateId: representative?.id ?? topic.candidateIds[0]!,
      candidates: topicCandidates,
    };
  }));
}

function maxTopicSignal(
  topic: DailyReportPlanTopic,
  candidatesById: ReadonlyMap<number, DailyReportPlanningCandidate>,
  assessmentsById: ReadonlyMap<number, DailyReportCandidateAssessment>,
  selector: (candidate: DailyReportPlanningCandidate, assessment: DailyReportCandidateAssessment | undefined) => number,
) {
  return topic.candidateIds.reduce((maximum, candidateId) => {
    const candidate = candidatesById.get(candidateId);
    if (!candidate) return maximum;
    return Math.max(maximum, selector(candidate, assessmentsById.get(candidateId)));
  }, 0);
}

function getDailyReportTopicPriorityComponents(
  topic: DailyReportPlanTopic,
  candidates: DailyReportPlanningCandidate[],
  assessments: DailyReportCandidateAssessment[],
): DailyReportTopicPriorityComponents | null {
  const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const assessmentsById = new Map(assessments.map((assessment) => [assessment.candidateId, assessment]));
  const topicCandidates = topic.candidateIds
    .map((candidateId) => candidatesById.get(candidateId))
    .filter((candidate): candidate is DailyReportPlanningCandidate => Boolean(candidate));
  if (topicCandidates.length === 0) return null;

  const candidateScore = maxTopicSignal(topic, candidatesById, assessmentsById, (candidate) => candidate.candidateScore);
  const relevanceScore = maxTopicSignal(topic, candidatesById, assessmentsById, (_, assessment) => assessment?.relevanceScore ?? 0);
  const qualityScore = maxTopicSignal(topic, candidatesById, assessmentsById, (candidate) => candidate.qualityScore);
  const evidenceCount = topicCandidates.reduce((total, candidate) => total + Math.max(0, candidate.sourceCount), 0);
  const freshnessSignal = Math.max(...topicCandidates.map((candidate) => (
    Math.max(0, candidate.newItemCountOnDate ?? 0) + Math.max(0, candidate.newSourceCountOnDate ?? 0)
  )), 0);

  return {
    candidateScore,
    relevanceScore,
    qualityScore,
    evidenceBonus: Math.min(6, Math.max(0, evidenceCount - 1) * 1.5),
    freshnessBonus: Math.min(4, freshnessSignal),
    followUpBonus: topicCandidates.some((candidate) => candidate.isFollowUp) ? 2 : 0,
  };
}

/**
 * Calculate one shared editorial priority for a final topic.
 *
 * The score intentionally uses the strongest member signals and bounded
 * evidence/freshness bonuses. It is only a local ordering signal; it is not
 * exposed to PLAN and does not change the Topic-Candidate mapping.
 */
export function getDailyReportTopicPriority(
  topic: DailyReportPlanTopic,
  candidates: DailyReportPlanningCandidate[],
  assessments: DailyReportCandidateAssessment[],
) {
  const components = getDailyReportTopicPriorityComponents(topic, candidates, assessments);
  if (!components) return Number.NEGATIVE_INFINITY;

  return Number((
    components.candidateScore * 0.45
    + components.relevanceScore * 0.35
    + components.qualityScore * 0.10
    + components.evidenceBonus
    + components.freshnessBonus
    + components.followUpBonus
  ).toFixed(4));
}

function compareDailyReportTopics(
  left: DailyReportPlanTopic,
  right: DailyReportPlanTopic,
  candidates: DailyReportPlanningCandidate[],
  assessments: DailyReportCandidateAssessment[],
) {
  const priorityDifference = getDailyReportTopicPriority(right, candidates, assessments)
    - getDailyReportTopicPriority(left, candidates, assessments);
  if (priorityDifference !== 0) return priorityDifference;
  return Math.min(...left.candidateIds) - Math.min(...right.candidateIds);
}

/**
 * Apply deterministic template ordering and the local maxItems guard before
 * PLAN validation. Overflow is intentionally truncated instead of causing an
 * extra model repair call; all other plan violations remain visible to the
 * validator.
 */
export function orderAndLimitDailyReportPlanWithAudit(
  plan: DailyReportPlan,
  template: NormalizedDailyReportTemplate,
  candidates: DailyReportPlanningCandidate[],
  assessments: DailyReportCandidateAssessment[],
): { plan: DailyReportPlan; audit: DailyReportPlanningAudit } {
  const sectionBlocksByTemplate = sectionBlocks(template);
  const blockOrder = new Map(
    sectionBlocksByTemplate
      .map((block, index) => [block.key ?? `__missing_key_${index}`, index] as const),
  );
  const fallbackBlockOrder = blockOrder.size;
  let topicSequence = 0;
  const audits: DailyReportPlanningAuditSection[] = [];
  const sections = plan.sections
    .map((section, index) => ({ section, index }))
    .sort((left, right) => (
      (blockOrder.get(left.section.blockKey) ?? fallbackBlockOrder) - (blockOrder.get(right.section.blockKey) ?? fallbackBlockOrder)
      || left.index - right.index
    ))
    .map(({ section }) => {
      const block = sectionBlocksByTemplate.find((candidate) => candidate.key === section.blockKey);
      const topics = [...section.topics].sort((left, right) => compareDailyReportTopics(left, right, candidates, assessments));
      const retainedTopics = block?.maxItems != null ? topics.slice(0, block.maxItems) : topics;
      const truncatedTopics = block?.maxItems != null ? topics.slice(block.maxItems) : [];
      const topicAudit = (topic: DailyReportPlanTopic, retained: boolean, topicId: string | null): DailyReportPlanningAuditTopic => ({
        topicId,
        candidateIds: [...topic.candidateIds],
        topicPriority: getDailyReportTopicPriority(topic, candidates, assessments),
        priorityComponents: getDailyReportTopicPriorityComponents(topic, candidates, assessments) ?? {
          candidateScore: 0,
          relevanceScore: 0,
          qualityScore: 0,
          evidenceBonus: 0,
          freshnessBonus: 0,
          followUpBonus: 0,
        },
        retained,
      });
      const sectionTopics = retainedTopics.map((topic) => ({
        ...topic,
        topicId: `topic-${++topicSequence}`,
      }));
      audits.push({
        blockKey: section.blockKey,
        maxItems: block?.maxItems ?? null,
        inputTopicCount: topics.length,
        outputTopicCount: sectionTopics.length,
        truncatedTopicCount: truncatedTopics.length,
        topics: [
          ...sectionTopics.map((topic) => topicAudit(topic, true, topic.topicId)),
          ...truncatedTopics.map((topic) => topicAudit(topic, false, null)),
        ],
      });
      return {
        ...section,
        topics: sectionTopics,
      };
    });
  return {
    plan: { ...plan, sections },
    audit: {
      schemaVersion: 1,
      topicPriorityVersion: "v1",
      inputTopicCount: audits.reduce((total, section) => total + section.inputTopicCount, 0),
      outputTopicCount: audits.reduce((total, section) => total + section.outputTopicCount, 0),
      truncatedTopicCount: audits.reduce((total, section) => total + section.truncatedTopicCount, 0),
      sections: audits,
    },
  };
}

export function orderAndLimitDailyReportPlan(
  plan: DailyReportPlan,
  template: NormalizedDailyReportTemplate,
  candidates: DailyReportPlanningCandidate[],
  assessments: DailyReportCandidateAssessment[],
): DailyReportPlan {
  return orderAndLimitDailyReportPlanWithAudit(plan, template, candidates, assessments).plan;
}

/**
 * Reconcile model draft order with the deterministic PLAN/template order.
 * Unknown blocks and topics stay at the end so validation can still report
 * them instead of silently dropping malformed model output.
 */
export function orderDailyReportDraft(
  draft: DailyReportDraft,
  plan: DailyReportPlan,
  template: NormalizedDailyReportTemplate,
): DailyReportDraft {
  if (!draft || typeof draft !== "object" || !Array.isArray(draft.blocks)) return draft as DailyReportDraft;
  const blockOrder = new Map<string, number>();
  template.blocks.forEach((block, index) => {
    blockOrder.set(block.title, index);
    if (block.type === "section" && block.key) blockOrder.set(block.key, index);
  });
  const topicOrder = new Map(
    getDailyReportPlanTopics(plan).map((topic, index) => [topic.topicId, index]),
  );
  return {
    ...draft,
    blocks: draft.blocks
      .map((block, index) => ({ block, index }))
      .sort((left, right) => (
        (blockOrder.get(left.block.type === "section" ? left.block.blockKey ?? left.block.title : left.block.title) ?? Number.MAX_SAFE_INTEGER)
        - (blockOrder.get(right.block.type === "section" ? right.block.blockKey ?? right.block.title : right.block.title) ?? Number.MAX_SAFE_INTEGER)
        || left.index - right.index
      ))
      .map(({ block }) => block.type === "section"
        ? {
            ...block,
            items: block.items
              .map((item, index) => ({ item, index }))
              .sort((left, right) => (
                (topicOrder.get(left.item.topicId ?? "") ?? Number.MAX_SAFE_INTEGER)
                - (topicOrder.get(right.item.topicId ?? "") ?? Number.MAX_SAFE_INTEGER)
                || left.index - right.index
              ))
              .map(({ item }) => item),
          }
        : block),
  } as DailyReportDraft;
}

/**
 * Rebuild source references from the validated topic mapping. Model output is
 * allowed to contain sourceIds for backward compatibility, but those values
 * are never authoritative and are always replaced here.
 */
export function attachDailyReportTopicSources(
  draft: DailyReportModelDraft | DailyReportDraft,
  plan: DailyReportPlan,
): DailyReportDraft {
  if (!draft || typeof draft !== "object" || !Array.isArray(draft.blocks)) return draft as DailyReportDraft;
  const topicById = new Map(getDailyReportPlanTopics(plan).map((topic) => [topic.topicId, topic]));
  return {
    ...draft,
    blocks: draft.blocks.map((block) => block.type === "section"
      ? {
          ...block,
          items: block.items.map((item) => ({
            ...item,
            sourceIds: topicById.get(item.topicId ?? "")?.candidateIds.slice() ?? [],
          })),
        }
      : block),
  } as DailyReportDraft;
}

export function getDailyReportPlanTopics(plan: DailyReportPlan) {
  return plan.sections.flatMap((section) => section.topics.map((topic) => ({
    ...topic,
    blockKey: section.blockKey,
  })));
}

export function getDailyReportPlanCandidateIds(plan: DailyReportPlan) {
  return getDailyReportPlanTopics(plan).flatMap((topic) => topic.candidateIds);
}

function sectionBlocks(template: NormalizedDailyReportTemplate) {
  return template.blocks.filter((block): block is DailyReportTemplateSectionBlock => block.type === "section");
}

/**
 * Apply template-owned presentation constraints before validation/persistence.
 * A section with bodyRequired=false is intentionally title/source-only; model
 * output must not be allowed to reintroduce a body into the rendered report.
 */
export function normalizeDailyReportDraftForTemplate(
  draft: DailyReportDraft,
  template: NormalizedDailyReportTemplate,
): DailyReportDraft {
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) return draft;
  const rawDraft = draft as unknown as Record<string, unknown>;
  if (!Array.isArray(rawDraft.blocks)) return draft;

  const bodylessSectionKeys = new Set(
    sectionBlocks(template)
      .filter((block) => block.item.bodyRequired === false && block.key)
      .map((block) => block.key as string),
  );
  const bodylessSectionTitles = new Set(
    sectionBlocks(template)
      .filter((block) => block.item.bodyRequired === false)
      .map((block) => block.title),
  );

  return {
    ...rawDraft,
    blocks: rawDraft.blocks.map((rawBlock) => {
      if (!rawBlock || typeof rawBlock !== "object" || Array.isArray(rawBlock)) return rawBlock;
      const block = rawBlock as Record<string, unknown>;
      if (block.type !== "section" || !Array.isArray(block.items)) return block;
      const blockKey = typeof block.blockKey === "string" ? block.blockKey.trim() : "";
      const blockTitle = typeof block.title === "string" ? block.title.trim() : "";
      const bodyless = bodylessSectionKeys.has(blockKey)
        || (!blockKey && bodylessSectionTitles.has(blockTitle));
      return {
        ...block,
        items: block.items.map((rawItem) => {
          if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) return rawItem;
          const item = rawItem as Record<string, unknown>;
          return {
            ...item,
            body: bodyless ? "" : typeof item.body === "string" ? item.body : "",
          };
        }),
      };
    }),
  } as unknown as DailyReportDraft;
}

function textBlocks(template: NormalizedDailyReportTemplate) {
  return template.blocks.filter((block): block is DailyReportTemplateTextBlock => block.type === "text");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberArray(value: unknown) {
  return Array.isArray(value) && value.every((item) => Number.isInteger(item))
    ? value as number[]
    : null;
}

export function validateDailyReportPlan(
  plan: DailyReportPlan,
  candidates: DailyReportPlanningCandidate[],
  assessments: DailyReportCandidateAssessment[],
  template: NormalizedDailyReportTemplate,
): DailyReportViolation[] {
  const violations: DailyReportViolation[] = [];
  if (!plan || plan.schemaVersion !== 2 || !Array.isArray(plan.sections)) {
    return [{ code: "plan_schema", stage: "plan", message: "计划必须是 schemaVersion=2 的对象。" }];
  }

  const eligibleCandidateIds = new Set(
    assessments.filter((assessment) => assessment.isWorthReading).map((assessment) => assessment.candidateId),
  );
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const selected = new Set<number>();
  const assignedTopics = new Set<string>();
  const assignedBlocks = new Set<string>();
  const templateSectionBlocks = sectionBlocks(template);
  const requiredMinimum = templateSectionBlocks
    .filter((block) => block.required)
    .reduce((total, block) => total + (block.minItems ?? 0), 0);
  if (eligibleCandidateIds.size < requiredMinimum) {
    violations.push({
      code: "insufficient_required_candidates",
      stage: "plan",
      message: `可规划候选仅 ${eligibleCandidateIds.size} 条，无法满足必需栏目最少 ${requiredMinimum} 条，任务不能发布。`,
    });
  }
  const blocks = new Map(templateSectionBlocks.filter((block) => block.key).map((block) => [block.key!, block]));
  for (const rawSection of plan.sections as unknown[]) {
    if (!isRecord(rawSection)) {
      violations.push({ code: "plan_schema", stage: "plan", message: "计划栏目必须是对象。" });
      continue;
    }
    const blockKey = typeof rawSection.blockKey === "string" ? rawSection.blockKey.trim() : "";
    const topics = Array.isArray(rawSection.topics) ? rawSection.topics : null;
    if (!blockKey || !topics) {
      violations.push({ code: "plan_schema", stage: "plan", blockKey: blockKey || undefined, message: "计划栏目必须包含 blockKey 和 topics 数组。" });
      continue;
    }
    const block = blocks.get(blockKey);
    if (!block) {
      violations.push({ code: "unknown_block", stage: "plan", blockKey, message: `计划引用未知栏目 ${blockKey}。` });
    } else {
      if (assignedBlocks.has(blockKey)) {
        violations.push({ code: "duplicate_block", stage: "plan", blockKey, message: `栏目 ${block.title} 被重复规划。` });
      }
      assignedBlocks.add(blockKey);
    }

    for (const rawTopic of topics) {
      if (!isRecord(rawTopic)) {
        violations.push({ code: "plan_schema", stage: "plan", blockKey, message: "计划主题必须是对象。" });
        continue;
      }
      const topicId = typeof rawTopic.topicId === "string" ? rawTopic.topicId.trim() : "";
      const candidateIds = numberArray(rawTopic.candidateIds);
      if (!topicId || !candidateIds) {
        violations.push({ code: "plan_schema", stage: "plan", blockKey, message: "计划主题必须包含 topicId 和 candidateIds 数组。" });
        continue;
      }
      if (candidateIds.length === 0) {
        violations.push({ code: "empty_topic", stage: "plan", blockKey, topicId, message: `主题 ${topicId} 不能没有候选。` });
      }
      if (assignedTopics.has(topicId)) violations.push({ code: "duplicate_topic", stage: "plan", message: `主题 ${topicId} 被重复分配。` });
      assignedTopics.add(topicId);
      for (const candidateId of candidateIds) {
        const candidate = candidateById.get(candidateId);
        if (!candidate) {
          violations.push({ code: "unknown_candidate", stage: "plan", topicId, candidateIds: [candidateId], message: `主题 ${topicId} 引用未知候选 ${candidateId}。` });
        } else if (!eligibleCandidateIds.has(candidateId)) {
          violations.push({ code: "ineligible_candidate", stage: "plan", topicId, candidateIds: [candidateId], message: `主题 ${topicId} 引用了未通过 ASSESS 的候选 ${candidateId}。` });
        }
        if (selected.has(candidateId)) violations.push({ code: "duplicate_candidate", stage: "plan", topicId, candidateIds: [candidateId], message: `候选 ${candidateId} 被多个主题选择。` });
        selected.add(candidateId);
      }
    }
    if (block) {
      if (topics.length < (block.minItems ?? 0)) violations.push({ code: "section_min_items", stage: "plan", blockKey, message: `${block.title} 未达到最小主题数。` });
      if (block.maxItems != null && topics.length > block.maxItems) violations.push({ code: "section_max_items", stage: "plan", blockKey, message: `${block.title} 超过最大主题数。` });
    }
  }
  for (const block of sectionBlocks(template)) {
    if (block.required && block.key && !assignedBlocks.has(block.key)) {
      violations.push({ code: "missing_required_block", stage: "plan", blockKey: block.key, message: `计划缺少必需栏目 ${block.title}。` });
    }
  }
  if (selected.size === 0 && eligibleCandidateIds.size > 0 && assignedBlocks.size > 0) violations.push({ code: "empty_selection", stage: "plan", message: "有可规划候选时计划不能完全为空。" });
  return violations;
}

export function validateDailyReportDraft(
  draft: DailyReportDraft,
  plan: DailyReportPlan,
  selectedCandidates: DailyReportPlanningCandidate[],
  template: NormalizedDailyReportTemplate,
  omittedTopicIds: ReadonlySet<string> = new Set(),
): DailyReportViolation[] {
  const violations: DailyReportViolation[] = [];
  const blocks = Array.isArray(draft?.blocks) ? draft.blocks as unknown[] : null;
  if (!blocks) return [{ code: "draft_schema", stage: "draft", message: "草稿必须包含 blocks 数组。" }];
  const selectedIds = new Set(selectedCandidates.map((candidate) => candidate.id));
  const plannedIds = new Set(getDailyReportPlanCandidateIds(plan));
  const planTopics = getDailyReportPlanTopics(plan);
  const planTopicById = new Map(planTopics.map((topic) => [topic.topicId, topic]));
  const templateSections = sectionBlocks(template);
  const templateTextBlocks = textBlocks(template);
  const templateSectionByKey = new Map(templateSections.filter((block) => block.key).map((block) => [block.key!, block]));
  const planSectionByKey = new Map(plan.sections.map((section) => [section.blockKey, section]));
  const seenBlockKeys = new Set<string>();
  const seenTextTitles = new Set<string>();
  const seenTopicIds = new Set<string>();
  const sourceIds = new Set<number>();
  for (const rawBlock of blocks) {
    if (!isRecord(rawBlock) || typeof rawBlock.type !== "string") {
      violations.push({ code: "draft_schema", stage: "draft", message: "草稿 block 必须包含 type。" });
      continue;
    }
    if (rawBlock.type === "text") {
      const title = typeof rawBlock.title === "string" ? rawBlock.title.trim() : "";
      const body = typeof rawBlock.body === "string" ? rawBlock.body.trim() : "";
      const templateBlock = templateTextBlocks.find((entry) => entry.title === title);
      if (!templateBlock) {
        violations.push({ code: "unknown_text_block", stage: "draft", message: `草稿引用未知文本块 ${title || "(空)"}。` });
      } else {
        if (seenTextTitles.has(title)) violations.push({ code: "duplicate_text_block", stage: "draft", message: `文本块 ${title} 被重复输出。` });
        seenTextTitles.add(title);
      }
      if (!body) violations.push({ code: "text_block_empty", stage: "draft", message: `文本块 ${title || "(空)"} 内容不能为空。` });
      continue;
    }
    if (rawBlock.type !== "section") {
      violations.push({ code: "unknown_draft_block", stage: "draft", message: `草稿包含未知 block 类型 ${rawBlock.type}。` });
      continue;
    }
    const hasExplicitBlockKey = typeof rawBlock.blockKey === "string" && rawBlock.blockKey.trim().length > 0;
    const blockKey = hasExplicitBlockKey
      ? (rawBlock.blockKey as string).trim()
      : typeof rawBlock.title === "string" ? rawBlock.title.trim() : "";
    const templateBlock = templateSectionByKey.get(blockKey)
      ?? (!hasExplicitBlockKey ? templateSections.find((entry) => entry.title === blockKey) : undefined);
    if (!templateBlock || !templateBlock.key) {
      violations.push({ code: "unknown_block", stage: "draft", blockKey, message: `草稿引用未知栏目 ${blockKey || "(空)"}。` });
      continue;
    }
    if (seenBlockKeys.has(templateBlock.key)) violations.push({ code: "duplicate_block", stage: "draft", blockKey: templateBlock.key, message: `栏目 ${templateBlock.title} 被重复输出。` });
    seenBlockKeys.add(templateBlock.key);
    if (rawBlock.title !== templateBlock.title) {
      violations.push({ code: "block_title_mismatch", stage: "draft", blockKey: templateBlock.key, message: `草稿栏目标题与模板不一致：${templateBlock.title}。` });
    }
    if (!planSectionByKey.has(templateBlock.key)) {
      violations.push({ code: "draft_block_not_planned", stage: "draft", blockKey: templateBlock.key, message: `草稿输出了未纳入计划的栏目 ${templateBlock.title}。` });
    }
    if (!Array.isArray(rawBlock.items)) {
      violations.push({ code: "draft_schema", stage: "draft", blockKey: templateBlock.key, message: `${templateBlock.title} 的 items 必须是数组。` });
      continue;
    }
    const items = rawBlock.items as unknown[];
    if (items.length < (templateBlock.minItems ?? 0)) {
      violations.push({ code: "draft_min_items", stage: "draft", blockKey: templateBlock.key, message: `${templateBlock.title} 未达到最小条数。` });
    }
    if (templateBlock.maxItems != null && items.length > templateBlock.maxItems) {
      violations.push({ code: "draft_max_items", stage: "draft", blockKey: templateBlock.key, message: `${templateBlock.title} 超过模板最大条数。` });
    }
    items.forEach((rawItem, itemIndex) => {
      if (!isRecord(rawItem)) {
        violations.push({ code: "draft_schema", stage: "draft", blockKey: templateBlock.key, message: `${templateBlock.title} 包含无效条目。` });
        return;
      }
      const itemSourceIds = numberArray(rawItem.sourceIds);
      const topicId = typeof rawItem.topicId === "string" ? rawItem.topicId.trim() : "";
      const planTopic = topicId ? planTopicById.get(topicId) : undefined;
      if (!topicId) {
        violations.push({ code: "draft_topic_missing", stage: "draft", blockKey: templateBlock.key, message: `${templateBlock.title} 条目必须包含 topicId。` });
      } else if (!planTopic) {
        violations.push({ code: "draft_topic_not_planned", stage: "draft", blockKey: templateBlock.key, topicId, message: `草稿条目引用了未纳入计划的主题 ${topicId}。` });
      } else {
        if (planTopic.blockKey !== templateBlock.key) {
          violations.push({ code: "draft_topic_block_mismatch", stage: "draft", blockKey: templateBlock.key, topicId, message: `主题 ${topicId} 不属于栏目 ${templateBlock.title}。` });
        }
        if (seenTopicIds.has(topicId)) {
          violations.push({ code: "draft_duplicate_topic", stage: "draft", blockKey: templateBlock.key, topicId, message: `主题 ${topicId} 在草稿中生成了多个条目。` });
        }
        seenTopicIds.add(topicId);
      }
      if (!itemSourceIds) {
        violations.push({ code: "draft_schema", stage: "draft", blockKey: templateBlock.key, message: `${templateBlock.title} 条目的 sourceIds 必须是数字数组。` });
        return;
      } else if (itemSourceIds.length === 0) {
        violations.push({ code: "draft_source_empty", stage: "draft", blockKey: templateBlock.key, message: `${templateBlock.title} 条目的 sourceIds 不能为空。` });
      }
      for (const sourceId of itemSourceIds) {
        if (sourceIds.has(sourceId)) {
          violations.push({ code: "draft_duplicate_source", stage: "draft", blockKey: templateBlock.key, candidateIds: [sourceId], message: `候选 ${sourceId} 在草稿中被重复引用。` });
        }
        sourceIds.add(sourceId);
        if (!selectedIds.has(sourceId) || !plannedIds.has(sourceId)) {
          violations.push({ code: "draft_source_not_planned", stage: "draft", candidateIds: [sourceId], message: `草稿引用了未纳入计划的候选 ${sourceId}。` });
        }
        if (planTopic && !planTopic.candidateIds.includes(sourceId)) {
          violations.push({ code: "draft_source_topic_mismatch", stage: "draft", blockKey: templateBlock.key, topicId, candidateIds: [sourceId], message: `候选 ${sourceId} 不属于主题 ${topicId}。` });
        }
      }
      const invalidTitle = typeof rawItem.title !== "string" || !rawItem.title.trim();
      const invalidBody = templateBlock.item.bodyRequired === false
        ? rawItem.body !== undefined && typeof rawItem.body !== "string"
        : typeof rawItem.body !== "string" || !rawItem.body.trim();
      if (invalidTitle || invalidBody) {
        violations.push({ code: "draft_item_empty", stage: "draft", blockKey: templateBlock.key, message: `${templateBlock.title} 存在标题或正文为空的条目。` });
      }
      if (rawItem.notes !== undefined && !Array.isArray(rawItem.notes)) {
        violations.push({ code: "draft_notes_schema", stage: "draft", blockKey: templateBlock.key, message: `${templateBlock.title} 条目的 notes 必须是数组。` });
      }
      const notes = Array.isArray(rawItem.notes) ? rawItem.notes : [];
      for (const note of templateBlock.item.notes.filter((entry) => entry.required)) {
        const matched = notes.some((rawNote) => isRecord(rawNote)
          && rawNote.label === note.label
          && typeof rawNote.text === "string"
          && rawNote.text.trim().length > 0);
        if (!matched) {
          const itemTitle = typeof rawItem.title === "string" && rawItem.title.trim()
            ? `「${rawItem.title.trim()}」`
            : "（标题为空）";
          const sourceSummary = itemSourceIds.length > 0 ? `，来源 ${itemSourceIds.join(", ")}` : "";
          violations.push({
            code: "draft_required_note_missing",
            stage: "draft",
            blockKey: templateBlock.key,
            topicId: topicId || undefined,
            candidateIds: itemSourceIds,
            itemIndex,
            itemTitle: typeof rawItem.title === "string" ? rawItem.title.trim() : undefined,
            noteLabel: note.label,
            noteInstruction: note.instruction,
            message: `${templateBlock.title} 第 ${itemIndex + 1} 条${itemTitle}${sourceSummary}缺少必填要点 ${note.label}（要求：${note.instruction}）。`,
          });
        }
      }
    });
  }
  for (const block of templateTextBlocks) {
    if (!seenTextTitles.has(block.title)) {
      violations.push({ code: "missing_text_block", stage: "draft", message: `草稿缺少文本块 ${block.title}。` });
    }
  }
  for (const block of templateSections) {
    if (block.required && block.key && !seenBlockKeys.has(block.key)) {
      violations.push({ code: "missing_required_block", stage: "draft", blockKey: block.key, message: `草稿缺少必需栏目 ${block.title}。` });
    }
  }
  for (const topic of planTopics) {
    if (!omittedTopicIds.has(topic.topicId) && !seenTopicIds.has(topic.topicId)) {
      violations.push({ code: "draft_topic_missing", stage: "draft", blockKey: topic.blockKey, topicId: topic.topicId, message: `草稿缺少主题 ${topic.topicId} 对应的日报条目。` });
    }
  }
  if (sourceIds.size === 0) violations.push({ code: "draft_empty", stage: "draft", message: "草稿没有合法来源引用。" });
  return violations;
}
