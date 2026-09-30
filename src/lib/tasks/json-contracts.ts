import type {
  TaskStageTimingSnapshot,
  TaskTimelineMetricSnapshot,
  TaskTimelineNodeKey,
  TaskTimelineNodeSnapshot,
  TaskTimelineNodeStatus,
} from "@/lib/tasks/types";

export const DAILY_REPORT_TIMELINE_LABELS: Partial<Record<TaskTimelineNodeKey, string>> = {
  daily_report_assess: "评估",
  daily_report_plan: "规划",
  daily_report_write: "写作",
  daily_report_review: "审核",
};

const TIMELINE_NODE_KEYS = new Set<TaskTimelineNodeKey>([
  "daily_report_generate",
  "daily_report_prepare",
  "daily_report_assess",
  "daily_report_merge",
  "daily_report_plan",
  "daily_report_plan_validate",
  "daily_report_validate",
  "daily_report_write",
  "daily_report_review",
  "daily_report_repair",
  "daily_report_persist_publish",
  "task_finished",
  "source_fetch",
  "rule_filter",
  "item_understanding",
  "cluster_assignment",
  "cluster_merge",
  "cluster_finalize",
]);

const TIMELINE_NODE_STATUSES = new Set<TaskTimelineNodeStatus>([
  "pending",
  "running",
  "succeeded",
  "failed",
  "partial",
  "cancelled",
  "skipped",
]);

export function normalizeTaskStageTimingSnapshot(value: unknown): TaskStageTimingSnapshot | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const maybeSnapshot = value as Record<string, unknown>;

  if (typeof maybeSnapshot.key !== "string" || typeof maybeSnapshot.label !== "string") {
    return null;
  }

  const startedAt =
    typeof maybeSnapshot.startedAt === "string" || maybeSnapshot.startedAt === null
      ? maybeSnapshot.startedAt
      : null;
  const finishedAt =
    typeof maybeSnapshot.finishedAt === "string" || maybeSnapshot.finishedAt === null
      ? maybeSnapshot.finishedAt
      : null;
  const durationMs =
    typeof maybeSnapshot.durationMs === "number" && Number.isFinite(maybeSnapshot.durationMs)
      ? maybeSnapshot.durationMs
      : null;

  const status = typeof maybeSnapshot.status === "string" && TIMELINE_NODE_STATUSES.has(maybeSnapshot.status as TaskTimelineNodeStatus)
    ? maybeSnapshot.status as TaskTimelineNodeStatus
    : undefined;
  const detail = typeof maybeSnapshot.detail === "string" ? maybeSnapshot.detail.slice(0, 300) : undefined;

  return {
    key: maybeSnapshot.key,
    label: maybeSnapshot.label,
    startedAt,
    finishedAt,
    durationMs,
    ...(status ? { status } : {}),
    ...(detail ? { detail } : {}),
  };
}

export function parseTaskStageTimingsJson(value: string | null | undefined): TaskStageTimingSnapshot[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map(normalizeTaskStageTimingSnapshot)
      .filter((snapshot): snapshot is TaskStageTimingSnapshot => snapshot !== null);
  } catch {
    return [];
  }
}

export function serializeTaskStageTimings(stageTimings: TaskStageTimingSnapshot[] | null) {
  if (!stageTimings) {
    return null;
  }

  return JSON.stringify(stageTimings);
}

export function normalizeTaskTimelineMetricSnapshot(value: unknown): TaskTimelineMetricSnapshot | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const maybeMetric = value as Record<string, unknown>;

  if (typeof maybeMetric.label !== "string") {
    return null;
  }

  return {
    label: maybeMetric.label,
    value:
      typeof maybeMetric.value === "number" && Number.isFinite(maybeMetric.value)
        ? maybeMetric.value
        : 0,
  };
}

export function normalizeTaskTimelineNodeSnapshot(value: unknown): TaskTimelineNodeSnapshot | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const maybeNode = value as Record<string, unknown>;
  const key = maybeNode.key;
  const status = maybeNode.status;

  if (
    typeof key !== "string" ||
    !TIMELINE_NODE_KEYS.has(key as TaskTimelineNodeKey) ||
    typeof maybeNode.label !== "string" ||
    typeof status !== "string" ||
    !TIMELINE_NODE_STATUSES.has(status as TaskTimelineNodeStatus)
  ) {
    return null;
  }

  const startedAt =
    typeof maybeNode.startedAt === "string" || maybeNode.startedAt === null
      ? maybeNode.startedAt
      : null;
  const finishedAt =
    typeof maybeNode.finishedAt === "string" || maybeNode.finishedAt === null
      ? maybeNode.finishedAt
      : null;
  const durationMs =
    typeof maybeNode.durationMs === "number" && Number.isFinite(maybeNode.durationMs)
      ? maybeNode.durationMs
      : null;
  const modelName =
    typeof maybeNode.modelName === "string" || maybeNode.modelName === null
      ? maybeNode.modelName
      : null;
  const metrics = Array.isArray(maybeNode.metrics)
    ? maybeNode.metrics
        .map(normalizeTaskTimelineMetricSnapshot)
        .filter((metric): metric is TaskTimelineMetricSnapshot => metric !== null)
    : [];
  const audit = maybeNode.audit && typeof maybeNode.audit === "object" && !Array.isArray(maybeNode.audit)
    ? maybeNode.audit as Record<string, unknown>
    : undefined;

  return {
    key: key as TaskTimelineNodeKey,
    label: DAILY_REPORT_TIMELINE_LABELS[key as TaskTimelineNodeKey] ?? maybeNode.label,
    status: status as TaskTimelineNodeStatus,
    startedAt,
    finishedAt,
    durationMs,
    modelName,
    metrics,
    ...(audit ? { audit } : {}),
  };
}

export function parseTaskTimelineJson(value: string | null | undefined): TaskTimelineNodeSnapshot[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map(normalizeTaskTimelineNodeSnapshot)
      .filter((node): node is TaskTimelineNodeSnapshot => node !== null);
  } catch {
    return [];
  }
}

export function serializeTaskTimeline(taskTimeline: TaskTimelineNodeSnapshot[] | null) {
  if (!taskTimeline) {
    return null;
  }

  return JSON.stringify(taskTimeline);
}
