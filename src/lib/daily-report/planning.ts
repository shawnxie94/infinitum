import type {
  DailyReportTemplateSectionBlock,
  DailyReportTemplateTextBlock,
  NormalizedDailyReportTemplate,
} from "@/lib/daily-report/template";
import type {
  DailyReportCandidate,
  DailyReportCandidateAssessment,
  DailyReportDraft,
  DailyReportMergedTopic,
  DailyReportPlan,
  DailyReportPlanningCandidate,
  DailyReportViolation,
} from "@/lib/daily-report/types";

export type { NormalizedDailyReportTemplate } from "@/lib/daily-report/template";

export const DAILY_REPORT_ATTEMPT_MATRIX = [
  { stage: "PREPARE", maxAttempts: 1, retry: "none" },
  { stage: "ASSESS", maxAttempts: 2, retry: "same_batch" },
  { stage: "MERGE", maxAttempts: 1, retry: "none" },
  { stage: "PLAN", maxAttempts: 2, retry: "same_ledger" },
  { stage: "PLAN_VALIDATE", maxAttempts: 2, retry: "same_ledger" },
  { stage: "WRITE", maxAttempts: 2, retry: "same_plan" },
  { stage: "JSON_REPAIR", maxAttempts: 1, retry: "same_draft" },
  { stage: "VALIDATE", maxAttempts: 1, retry: "none" },
  { stage: "REPAIR", maxAttempts: 1, retry: "same_plan" },
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
    if (!nullableString(rawAssessment.exclusionReason)) {
      throw new Error(`ASSESS 候选 ${candidateId} 的 exclusionReason 必须是字符串或 null。`);
    }
    if (!rawAssessment.isWorthReading
      && (typeof rawAssessment.exclusionReason !== "string" || !rawAssessment.exclusionReason.trim())) {
      throw new Error(`ASSESS 候选 ${candidateId} 被排除时必须提供 exclusionReason。`);
    }
    if (!isRecord(rawAssessment.eventHint)
      || !nullableString(rawAssessment.eventHint.eventType)
      || !nullableString(rawAssessment.eventHint.eventSubject)
      || !nullableString(rawAssessment.eventHint.eventAction)
      || !nullableString(rawAssessment.eventHint.eventObject)
      || !nullableString(rawAssessment.eventHint.eventDate)) {
      throw new Error(`ASSESS 候选 ${candidateId} 的 eventHint 结构无效。`);
    }
    if (typeof rawAssessment.evidenceSummary !== "string" || !rawAssessment.evidenceSummary.trim()) {
      throw new Error(`ASSESS 候选 ${candidateId} 的 evidenceSummary 不能为空。`);
    }
    if (!isFiniteNumberInRange(rawAssessment.confidence, 0, 1)) {
      throw new Error(`ASSESS 候选 ${candidateId} 的 confidence 必须是 0 到 1 的有限数字。`);
    }
    assessments.push(rawAssessment as unknown as DailyReportCandidateAssessment);
  }
  if (returnedIds.size !== batchIds.size) throw new Error("ASSESS 未覆盖当前批次全部候选。");
  return assessments;
}

function normalized(value: string | null | undefined) {
  return (value ?? "").trim().toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function topicIdentity(candidate: DailyReportPlanningCandidate): { key: string; source: DailyReportMergedTopic["identitySource"] } {
  if (candidate.clusterId) return { key: `cluster:${candidate.clusterId}`, source: "cluster" };
  if (candidate.eventSubject && candidate.eventObject) {
    return {
      key: [candidate.eventType, candidate.eventSubject, candidate.eventAction, candidate.eventObject, candidate.eventDate]
        .map(normalized)
        .join("\u0000"),
      source: "event-identity",
    };
  }
  if (candidate.sourceKey) return { key: `source:${candidate.sourceKey}`, source: "source-key" };
  return { key: `candidate:${candidate.id}`, source: "standalone" };
}

export function mergeDailyReportTopics(
  candidates: DailyReportPlanningCandidate[],
  assessments: DailyReportCandidateAssessment[],
  sourceBatchIndexByCandidateId: ReadonlyMap<number, number> = new Map(),
): DailyReportMergedTopic[] {
  const assessmentById = new Map(assessments.map((assessment) => [assessment.candidateId, assessment]));
  const groups = new Map<string, DailyReportMergedTopic>();
  for (const candidate of candidates) {
    const assessment = assessmentById.get(candidate.id);
    if (!assessment?.isWorthReading) continue;
    const identity = topicIdentity(candidate);
    const existing = groups.get(identity.key);
    if (existing) {
      existing.candidateIds.push(candidate.id);
      const sourceBatchIndex = sourceBatchIndexByCandidateId.get(candidate.id);
      if (sourceBatchIndex !== undefined && !existing.sourceBatchIndexes?.includes(sourceBatchIndex)) {
        existing.sourceBatchIndexes = [...(existing.sourceBatchIndexes ?? []), sourceBatchIndex];
      }
      existing.evidenceCount += Math.max(1, candidate.sourceCount);
      existing.sourceKeys.push(candidate.sourceKey);
      existing.relevanceScore = Math.max(existing.relevanceScore, assessment.relevanceScore);
      continue;
    }
    groups.set(identity.key, {
      topicId: `topic-${groups.size + 1}`,
      candidateIds: [candidate.id],
      ...(sourceBatchIndexByCandidateId.has(candidate.id)
        ? { sourceBatchIndexes: [sourceBatchIndexByCandidateId.get(candidate.id)!] }
        : {}),
      identitySource: identity.source,
      titleHint: candidate.title,
      evidenceCount: Math.max(1, candidate.sourceCount),
      sourceKeys: [candidate.sourceKey],
      relevanceScore: assessment.relevanceScore,
      ambiguity: null,
    });
  }
  return [...groups.values()];
}

function sectionBlocks(template: NormalizedDailyReportTemplate) {
  return template.blocks.filter((block): block is DailyReportTemplateSectionBlock => block.type === "section");
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

function stringArray(value: unknown) {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value as string[]
    : null;
}

export function validateDailyReportPlan(
  plan: DailyReportPlan,
  topics: DailyReportMergedTopic[],
  candidates: DailyReportPlanningCandidate[],
  template: NormalizedDailyReportTemplate,
): DailyReportViolation[] {
  const violations: DailyReportViolation[] = [];
  if (!plan || plan.schemaVersion !== 1 || !Array.isArray(plan.sections)) {
    return [{ code: "plan_schema", stage: "plan", message: "计划必须是 schemaVersion=1 的对象。" }];
  }

  const topicById = new Map(topics.map((topic) => [topic.topicId, topic]));
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const selected = new Set<number>();
  const assignedTopics = new Set<string>();
  const assignedBlocks = new Set<string>();
  const templateSectionBlocks = sectionBlocks(template);
  const requiredMinimum = templateSectionBlocks
    .filter((block) => block.required)
    .reduce((total, block) => total + (block.minItems ?? 0), 0);
  const availableCandidateIds = new Set(topics.flatMap((topic) => topic.candidateIds));
  if (availableCandidateIds.size < requiredMinimum) {
    violations.push({
      code: "insufficient_required_candidates",
      stage: "plan",
      message: `可写候选仅 ${availableCandidateIds.size} 条，无法满足必需栏目最少 ${requiredMinimum} 条，任务不能发布。`,
    });
  }
  const blocks = new Map(templateSectionBlocks.filter((block) => block.key).map((block) => [block.key!, block]));
  for (const rawSection of plan.sections as unknown[]) {
    if (!isRecord(rawSection)) {
      violations.push({ code: "plan_schema", stage: "plan", message: "计划栏目必须是对象。" });
      continue;
    }
    const blockKey = typeof rawSection.blockKey === "string" ? rawSection.blockKey.trim() : "";
    const blockTitle = typeof rawSection.blockTitle === "string" ? rawSection.blockTitle.trim() : "";
    const topicIds = stringArray(rawSection.topicIds);
    const candidateIds = numberArray(rawSection.candidateIds);
    if (!blockKey || !topicIds || !candidateIds) {
      violations.push({ code: "plan_schema", stage: "plan", blockKey: blockKey || undefined, message: "计划栏目必须包含 blockKey、topicIds 和 candidateIds。" });
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
      if (blockTitle && blockTitle !== block.title) {
        violations.push({ code: "block_title_mismatch", stage: "plan", blockKey, message: `计划栏目标题与模板不一致：${block.title}。` });
      }
    }

    for (const topicId of topicIds) {
      const topic = topicById.get(topicId);
      if (!topic) violations.push({ code: "unknown_topic", stage: "plan", message: `计划引用未知主题 ${topicId}。` });
      if (assignedTopics.has(topicId)) violations.push({ code: "duplicate_topic", stage: "plan", message: `主题 ${topicId} 被重复分配。` });
      assignedTopics.add(topicId);
    }
    for (const candidateId of candidateIds) {
      const candidate = candidateById.get(candidateId);
      if (!candidate) violations.push({ code: "unknown_candidate", stage: "plan", candidateIds: [candidateId], message: `计划引用未知候选 ${candidateId}。` });
      if (selected.has(candidateId)) violations.push({ code: "duplicate_candidate", stage: "plan", candidateIds: [candidateId], message: `候选 ${candidateId} 被重复选择。` });
      selected.add(candidateId);
      const matchingTopic = topics.find((topic) => topic.candidateIds.includes(candidateId));
      if (candidate && (!matchingTopic || !topicIds.includes(matchingTopic.topicId))) {
        violations.push({ code: "candidate_topic_mismatch", stage: "plan", blockKey, candidateIds: [candidateId], message: `候选 ${candidateId} 不属于栏目引用的主题。` });
      }
    }
    if (block) {
      if (candidateIds.length < (block.minItems ?? 0)) violations.push({ code: "section_min_items", stage: "plan", blockKey, message: `${block.title} 未达到最小条数。` });
      if (block.maxItems != null && candidateIds.length > block.maxItems) violations.push({ code: "section_max_items", stage: "plan", blockKey, message: `${block.title} 超过最大条数。` });
    }
  }
  for (const block of sectionBlocks(template)) {
    if (block.required && block.key && !assignedBlocks.has(block.key)) {
      violations.push({ code: "missing_required_block", stage: "plan", blockKey: block.key, message: `计划缺少必需栏目 ${block.title}。` });
    }
  }
  const excludedCandidateIds = numberArray(plan.excludedCandidateIds) ?? [];
  if (!Array.isArray(plan.excludedCandidateIds)) {
    violations.push({ code: "plan_schema", stage: "plan", message: "excludedCandidateIds 必须是数字数组。" });
  }
  for (const id of excludedCandidateIds) {
    if (!candidateById.has(id)) violations.push({ code: "unknown_excluded_candidate", stage: "plan", candidateIds: [id], message: `计划排除了未知候选 ${id}。` });
    if (selected.has(id)) violations.push({ code: "selected_and_excluded", stage: "plan", candidateIds: [id], message: `候选 ${id} 同时被选择和排除。` });
  }
  if (selected.size === 0 && topics.length > 0 && assignedBlocks.size > 0) violations.push({ code: "empty_selection", stage: "plan", message: "有可写主题时计划不能完全为空。" });
  return violations;
}

export function validateDailyReportDraft(
  draft: DailyReportDraft,
  plan: DailyReportPlan,
  selectedCandidates: DailyReportPlanningCandidate[],
  template: NormalizedDailyReportTemplate,
): DailyReportViolation[] {
  const violations: DailyReportViolation[] = [];
  const blocks = Array.isArray(draft?.blocks) ? draft.blocks as unknown[] : null;
  if (!blocks) return [{ code: "draft_schema", stage: "draft", message: "草稿必须包含 blocks 数组。" }];
  const selectedIds = new Set(selectedCandidates.map((candidate) => candidate.id));
  const plannedIds = new Set(plan.sections.flatMap((section) => section.candidateIds));
  const templateSections = sectionBlocks(template);
  const templateTextBlocks = textBlocks(template);
  const templateSectionByKey = new Map(templateSections.filter((block) => block.key).map((block) => [block.key!, block]));
  const planSectionByKey = new Map(plan.sections.map((section) => [section.blockKey, section]));
  const seenBlockKeys = new Set<string>();
  const seenTextTitles = new Set<string>();
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
    for (const rawItem of items) {
      if (!isRecord(rawItem)) {
        violations.push({ code: "draft_schema", stage: "draft", blockKey: templateBlock.key, message: `${templateBlock.title} 包含无效条目。` });
        continue;
      }
      const itemSourceIds = numberArray(rawItem.sourceIds);
      if (!itemSourceIds) {
        violations.push({ code: "draft_schema", stage: "draft", blockKey: templateBlock.key, message: `${templateBlock.title} 条目的 sourceIds 必须是数字数组。` });
        continue;
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
      }
      if (typeof rawItem.title !== "string" || !rawItem.title.trim() || typeof rawItem.body !== "string" || !rawItem.body.trim()) {
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
          violations.push({ code: "draft_required_note_missing", stage: "draft", blockKey: templateBlock.key, message: `${templateBlock.title} 条目缺少必填要点 ${note.label}。` });
        }
      }
    }
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
  if (sourceIds.size === 0) violations.push({ code: "draft_empty", stage: "draft", message: "草稿没有合法来源引用。" });
  return violations;
}
