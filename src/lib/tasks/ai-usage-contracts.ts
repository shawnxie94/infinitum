import type {
  TaskAiCallBreakdownKey,
  TaskAiCallBreakdownSnapshot,
} from "@/lib/tasks/types";

/**
 * AI 用量 breakdown 的统一读取/规范化边界。
 * 存储侧 JSON 由多个历史版本写入：读取必须逐项容错（坏项丢弃、不中断后续），
 * 且按消费方区分严格（monitor 展示，仅已知 key）与宽松（runtime 合并/指标累计，
 * 未知 key 与缺失 label 也保留）两种模式。
 */

export const TASK_AI_CALL_BREAKDOWN_LABELS: Record<TaskAiCallBreakdownKey, string> = {
  item_understanding: "条目理解",
  cluster_match: "聚合匹配",
  cluster_summary: "聚合摘要",
  cluster_merge: "聚合合并",
  entity_alias_check: "实体别名判定",
  daily_report: "AI 日报",
  daily_report_assess: "评估",
  daily_report_plan: "规划",
  daily_report_write: "写作",
  daily_report_repair: "修复",
  daily_report_review: "审核",
};

/** 必需计量字段约定：有限且非负，否则回退 0；可选 token 字段非法时保持 undefined。 */
export function normalizeAiUsageCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function normalizeAiUsageTokenField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export type AiBreakdownParseMode = "known-keys-only" | "lenient";

export type AiBreakdownParseOptions = {
  mode?: AiBreakdownParseMode;
};

export function normalizeTaskAiCallBreakdownEntry(
  value: unknown,
  options: AiBreakdownParseOptions = {},
): TaskAiCallBreakdownSnapshot | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const maybeSnapshot = value as Record<string, unknown>;
  const rawKey = maybeSnapshot.key;
  if (typeof rawKey !== "string" || rawKey.length === 0) {
    return null;
  }

  const known = rawKey in TASK_AI_CALL_BREAKDOWN_LABELS;
  if (options.mode !== "lenient" && !known) {
    return null;
  }

  const key = known ? rawKey as TaskAiCallBreakdownKey : rawKey;
  const storedLabel = typeof maybeSnapshot.label === "string" && maybeSnapshot.label.length > 0
    ? maybeSnapshot.label
    : undefined;
  // 严格模式（monitor 展示）label 以标签表为准；宽松模式（runtime 合并/指标）保留历史 label。
  const label = options.mode === "lenient"
    ? storedLabel ?? key
    : known ? TASK_AI_CALL_BREAKDOWN_LABELS[key as TaskAiCallBreakdownKey] : key;

  const promptTokens = normalizeAiUsageTokenField(maybeSnapshot.promptTokens);
  const completionTokens = normalizeAiUsageTokenField(maybeSnapshot.completionTokens);
  const totalTokens = normalizeAiUsageTokenField(maybeSnapshot.totalTokens);
  const cachedTokens = normalizeAiUsageTokenField(maybeSnapshot.cachedTokens);
  const tokenUsageSource = maybeSnapshot.tokenUsageSource === "provider"
    || maybeSnapshot.tokenUsageSource === "estimated"
    || maybeSnapshot.tokenUsageSource === "mixed"
    ? maybeSnapshot.tokenUsageSource
    : undefined;
  const cachedTokensStatus = maybeSnapshot.cachedTokensStatus === "provider"
    || maybeSnapshot.cachedTokensStatus === "partial"
    || maybeSnapshot.cachedTokensStatus === "unavailable"
    ? maybeSnapshot.cachedTokensStatus
    : undefined;
  const modelNames = Array.isArray(maybeSnapshot.modelNames)
    ? [...new Set(maybeSnapshot.modelNames
      .filter((model): model is string => typeof model === "string" && model.trim().length > 0)
      .map((model) => model.trim()))]
    : [];
  const contractVersion = typeof maybeSnapshot.contractVersion === "string" ? maybeSnapshot.contractVersion : undefined;
  const contractHash = typeof maybeSnapshot.contractHash === "string" ? maybeSnapshot.contractHash : undefined;

  return {
    // 宽松模式下历史未知 key 保留原字符串（快照类型按已知 key 声明，此处仅读取边界放行）
    key: key as TaskAiCallBreakdownKey,
    label,
    ...(contractVersion ? { contractVersion } : {}),
    ...(contractHash ? { contractHash } : {}),
    ...(modelNames.length > 0 ? { modelNames } : {}),
    actual: normalizeAiUsageCount(maybeSnapshot.actual),
    estimated: normalizeAiUsageCount(maybeSnapshot.estimated),
    ...(totalTokens !== undefined || promptTokens !== undefined || completionTokens !== undefined
      ? {
          promptTokens: promptTokens ?? 0,
          completionTokens: completionTokens ?? 0,
          totalTokens: totalTokens ?? (promptTokens ?? 0) + (completionTokens ?? 0),
          cachedTokens: cachedTokens ?? 0,
          ...(cachedTokensStatus ? { cachedTokensStatus } : {}),
          ...(tokenUsageSource ? { tokenUsageSource } : {}),
        }
      : {}),
  };
}

/** 逐项容错解析：单个坏项丢弃，不影响后续条目。 */
export function parseTaskAiCallBreakdownArray(
  value: unknown,
  options: AiBreakdownParseOptions = {},
): TaskAiCallBreakdownSnapshot[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => normalizeTaskAiCallBreakdownEntry(entry, options))
    .filter((entry): entry is TaskAiCallBreakdownSnapshot => entry !== null);
}

export function parseTaskAiCallBreakdownJson(
  value: string | null | undefined,
  options: AiBreakdownParseOptions = {},
): TaskAiCallBreakdownSnapshot[] {
  if (!value) {
    return [];
  }
  try {
    return parseTaskAiCallBreakdownArray(JSON.parse(value) as unknown, options);
  } catch {
    return [];
  }
}

export function getDefaultTaskAiCallBreakdown(): TaskAiCallBreakdownSnapshot[] {
  return (Object.keys(TASK_AI_CALL_BREAKDOWN_LABELS) as TaskAiCallBreakdownKey[]).map((key) => ({
    key,
    label: TASK_AI_CALL_BREAKDOWN_LABELS[key],
    actual: 0,
    estimated: 0,
  }));
}
