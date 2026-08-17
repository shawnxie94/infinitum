import { Prisma } from "@prisma/client";

import {
  claimTaskRun,
  createTaskRun,
  findNextQueuedTaskRun,
  findRecentTaskRuns,
  upsertDefaultDailyReportSchedule,
  upsertDefaultIngestionSchedule,
  upsertDefaultItemCleanupSchedule,
} from "@/lib/tasks/repository";
import {
  computeNextRunAt,
  DEFAULT_CLEANUP_RETENTION_DAYS,
  DEFAULT_AGGREGATION_SPLIT_MAX_EVENTS,
  DEFAULT_DAILY_REPORT_CANDIDATE_LIMIT,
  DEFAULT_DAILY_REPORT_OFFSET_DAYS,
  DEFAULT_DAILY_REPORT_RECENT_TOPIC_LOOKBACK_DAYS,
  isSchedulerHeartbeatStale,
  MAX_CLEANUP_RETENTION_DAYS,
  MAX_DAILY_REPORT_CANDIDATE_LIMIT,
  MAX_DAILY_REPORT_OFFSET_DAYS,
  MIN_CLEANUP_RETENTION_DAYS,
  MIN_DAILY_REPORT_CANDIDATE_LIMIT,
  MIN_DAILY_REPORT_OFFSET_DAYS,
  MIN_DAILY_REPORT_RECENT_TOPIC_LOOKBACK_DAYS,
  normalizeScheduleInput,
} from "@/lib/tasks/scheduler";
import {
  DEFAULT_INGESTION_SCHEDULE_KEY,
  DEFAULT_DAILY_REPORT_SCHEDULE_KEY,
  DEFAULT_ITEM_CLEANUP_SCHEDULE_KEY,
  type TaskAiCallBreakdownKey,
  type TaskAiCallBreakdownSnapshot,
  type BackgroundTaskMonitorSnapshot,
  type EnqueueTaskRunInput,
  type TaskStageTimingSnapshot,
  type TaskTimelineMetricSnapshot,
  type TaskTimelineNodeKey,
  type TaskTimelineNodeSnapshot,
  type TaskTimelineNodeStatus,
  type TaskPipelineCheckpoint,
  type TaskRunSnapshot,
  type TaskScheduleSnapshot,
  type BackgroundTaskRunKind,
  type BackgroundTaskRunStatus,
} from "@/lib/tasks/types";
import { prisma } from "@/lib/db";
import { parseTaskPipelineCheckpointJson, serializeTaskPipelineCheckpoint } from "@/lib/tasks/checkpoint";

export const TASK_RUN_CANCELLED_MESSAGE = "管理员手动终止任务。";
export const TASK_RUN_CANCELLED_LABEL = "任务已终止";
const DEFAULT_DAILY_REPORT_CHANNEL_IDS = ["important"];

const TASK_AI_CALL_BREAKDOWN_LABELS: Record<TaskAiCallBreakdownKey, string> = {
  item_understanding: "条目理解",
  cluster_match: "聚合匹配",
  cluster_summary: "聚合摘要",
  cluster_merge: "聚合合并",
  daily_report: "AI 日报",
};

function getDefaultTaskAiCallBreakdown(): TaskAiCallBreakdownSnapshot[] {
  return (Object.keys(TASK_AI_CALL_BREAKDOWN_LABELS) as TaskAiCallBreakdownKey[]).map((key) => ({
    key,
    label: TASK_AI_CALL_BREAKDOWN_LABELS[key],
    actual: 0,
    estimated: 0,
  }));
}

function normalizeTaskAiCallBreakdownSnapshot(value: unknown): TaskAiCallBreakdownSnapshot | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const maybeSnapshot = value as Record<string, unknown>;

  if (
    maybeSnapshot.key !== "item_understanding" &&
    maybeSnapshot.key !== "cluster_match" &&
    maybeSnapshot.key !== "cluster_summary" &&
    maybeSnapshot.key !== "cluster_merge" &&
    maybeSnapshot.key !== "daily_report"
  ) {
    return null;
  }

  return {
    key: maybeSnapshot.key,
    label:
      typeof maybeSnapshot.label === "string"
        ? maybeSnapshot.label
        : TASK_AI_CALL_BREAKDOWN_LABELS[maybeSnapshot.key],
    actual:
      typeof maybeSnapshot.actual === "number" && Number.isFinite(maybeSnapshot.actual)
        ? maybeSnapshot.actual
        : 0,
    estimated:
      typeof maybeSnapshot.estimated === "number" && Number.isFinite(maybeSnapshot.estimated)
        ? maybeSnapshot.estimated
        : 0,
  };
}

function parseTaskAiCallBreakdownJson(value: string | null | undefined): TaskAiCallBreakdownSnapshot[] {
  const defaultBreakdown = getDefaultTaskAiCallBreakdown();

  if (!value) {
    return defaultBreakdown;
  }

  try {
    const parsed = JSON.parse(value) as unknown;

    if (!Array.isArray(parsed)) {
      return defaultBreakdown;
    }

    const parsedEntries = parsed
      .map(normalizeTaskAiCallBreakdownSnapshot)
      .filter((snapshot): snapshot is TaskAiCallBreakdownSnapshot => snapshot !== null);
    const parsedMap = new Map(parsedEntries.map((entry) => [entry.key, entry]));

    return defaultBreakdown.map((entry) => parsedMap.get(entry.key) ?? entry);
  } catch {
    return defaultBreakdown;
  }
}

function serializeTaskAiCallBreakdown(value: TaskAiCallBreakdownSnapshot[] | null) {
  if (!value) {
    return null;
  }

  return JSON.stringify(value);
}

function normalizeTaskStageTimingSnapshot(value: unknown): TaskStageTimingSnapshot | null {
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

  return {
    key: maybeSnapshot.key,
    label: maybeSnapshot.label,
    startedAt,
    finishedAt,
    durationMs,
  };
}

function parseTaskStageTimingsJson(value: string | null | undefined): TaskStageTimingSnapshot[] {
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

function serializeTaskStageTimings(stageTimings: TaskStageTimingSnapshot[] | null) {
  if (!stageTimings) {
    return null;
  }

  return JSON.stringify(stageTimings);
}

function normalizeTaskTimelineMetricSnapshot(value: unknown): TaskTimelineMetricSnapshot | null {
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

function normalizeTaskTimelineNodeSnapshot(value: unknown): TaskTimelineNodeSnapshot | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const maybeNode = value as Record<string, unknown>;
  const key = maybeNode.key;
  const status = maybeNode.status;
  const supportedKeys = new Set<TaskTimelineNodeKey>([
    "daily_report_generate",
    "daily_report_prepare",
    "daily_report_assess",
    "daily_report_merge",
    "daily_report_plan",
    "daily_report_plan_validate",
    "daily_report_validate",
    "daily_report_write",
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
  const supportedStatuses = new Set<TaskTimelineNodeStatus>([
    "pending",
    "running",
    "succeeded",
    "failed",
    "partial",
    "cancelled",
    "skipped",
  ]);

  if (
    typeof key !== "string" ||
    !supportedKeys.has(key as TaskTimelineNodeKey) ||
    typeof maybeNode.label !== "string" ||
    typeof status !== "string" ||
    !supportedStatuses.has(status as TaskTimelineNodeStatus)
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

  return {
    key: key as TaskTimelineNodeKey,
    label: maybeNode.label,
    status: status as TaskTimelineNodeStatus,
    startedAt,
    finishedAt,
    durationMs,
    modelName,
    metrics,
  };
}

function parseTaskTimelineJson(value: string | null | undefined): TaskTimelineNodeSnapshot[] {
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

function serializeTaskTimeline(taskTimeline: TaskTimelineNodeSnapshot[] | null) {
  if (!taskTimeline) {
    return null;
  }

  return JSON.stringify(taskTimeline);
}

export function parseDailyReportChannelIdsJson(value: string | null | undefined) {
  if (!value) {
    return DEFAULT_DAILY_REPORT_CHANNEL_IDS;
  }

  try {
    const parsed = JSON.parse(value) as unknown;

    if (!Array.isArray(parsed)) {
      return DEFAULT_DAILY_REPORT_CHANNEL_IDS;
    }

    const channelIds = parsed
      .filter((channelId): channelId is string => typeof channelId === "string" && channelId.trim().length > 0)
      .map((channelId) => channelId.trim());

    const uniqueChannelIds = [...new Set(channelIds)];
    return uniqueChannelIds.length > 0 ? uniqueChannelIds : DEFAULT_DAILY_REPORT_CHANNEL_IDS;
  } catch {
    return DEFAULT_DAILY_REPORT_CHANNEL_IDS;
  }
}

function serializeDailyReportChannelIds(channelIds: string[]) {
  return JSON.stringify([...new Set(channelIds.map((channelId) => channelId.trim()).filter(Boolean))]);
}

function getHeartbeatScheduleKeyForTaskKind(kind: BackgroundTaskRunKind) {
  if (kind === "daily_report_generate") {
    return DEFAULT_DAILY_REPORT_SCHEDULE_KEY;
  }

  if (kind === "item_cleanup") {
    return DEFAULT_ITEM_CLEANUP_SCHEDULE_KEY;
  }

  return DEFAULT_INGESTION_SCHEDULE_KEY;
}

export async function ensureDefaultIngestionSchedule() {
  return upsertDefaultIngestionSchedule();
}

export async function ensureDefaultDailyReportSchedule() {
  return upsertDefaultDailyReportSchedule();
}

export async function ensureDefaultItemCleanupSchedule() {
  return upsertDefaultItemCleanupSchedule();
}

export async function enqueueTaskRun(input: EnqueueTaskRunInput) {
  return createTaskRun(input);
}

export async function claimNextQueuedTaskRun() {
  const nextQueuedTaskRun = await findNextQueuedTaskRun();

  if (!nextQueuedTaskRun) {
    return null;
  }

  return claimTaskRun(nextQueuedTaskRun.id);
}

export async function listRecentTaskRuns(input: { limit: number }) {
  return findRecentTaskRuns(input.limit);
}

async function findTaskMonitorRuns(opts: {
  pageSize?: number;
  skip?: number;
  status?: BackgroundTaskRunStatus | { in: BackgroundTaskRunStatus[] } | null;
  kind?: BackgroundTaskRunKind | null;
  startedAt?: { gte: Date } | null;
}) {
  const normalizedStatuses = typeof opts.status === "object" && opts.status && "in" in opts.status
    ? opts.status.in
    : opts.status
      ? [opts.status]
      : [null];

  const runs = await Promise.all(normalizedStatuses.map((status) => prisma.backgroundTaskRun.findMany({
    where: {
      ...(status ? { status } : {}),
      ...(opts.kind ? { kind: opts.kind } : {}),
      ...(opts.startedAt ? { startedAt: opts.startedAt } : {}),
    },
  })));

  return runs
    .flat()
    .sort((left, right) => {
      const leftTime = (left.startedAt ?? left.createdAt).getTime();
      const rightTime = (right.startedAt ?? right.createdAt).getTime();
      return rightTime - leftTime || right.id.localeCompare(left.id);
    })
    .slice(opts.skip ?? 0, (opts.skip ?? 0) + (opts.pageSize ?? Number.MAX_SAFE_INTEGER));
}

export async function updateTaskRun(
  id: string,
  data: {
    status?: "queued" | "running" | "succeeded" | "failed" | "partial" | "cancelled";
    progressCurrent?: number;
    progressTotal?: number;
    progressLabel?: string | null;
    itemsAdded?: number;
    fullTextFetchedCount?: number;
    aiCallCountActual?: number;
    aiCallCountEstimated?: number;
    aiCallBreakdown?: TaskAiCallBreakdownSnapshot[] | null;
    cancelRequestedAt?: Date | null;
    startedAt?: Date | null;
    finishedAt?: Date | null;
    errorSummary?: string | null;
    stageTimings?: TaskStageTimingSnapshot[] | null;
    taskTimeline?: TaskTimelineNodeSnapshot[] | null;
    pipelineCheckpoint?: TaskPipelineCheckpoint | null;
  },
) {
  const now = new Date();
  const { stageTimings, aiCallBreakdown, taskTimeline, pipelineCheckpoint, ...taskRunData } = data;
  const taskRun = await prisma.$transaction(async (tx) => {
    const updatedTaskRun = await tx.backgroundTaskRun.update({
      where: { id },
      data: {
        ...taskRunData,
        aiCallBreakdownJson:
          aiCallBreakdown === undefined ? undefined : serializeTaskAiCallBreakdown(aiCallBreakdown),
        stageTimingsJson:
          stageTimings === undefined ? undefined : serializeTaskStageTimings(stageTimings),
        taskTimelineJson:
          taskTimeline === undefined ? undefined : serializeTaskTimeline(taskTimeline),
        pipelineCheckpointJson:
          pipelineCheckpoint === undefined ? undefined : serializeTaskPipelineCheckpoint(pipelineCheckpoint),
      },
    });

    await tx.taskSchedule.updateMany({
      where: { key: getHeartbeatScheduleKeyForTaskKind(updatedTaskRun.kind) },
      data: {
        lastHeartbeatAt: now,
      },
    });

    return updatedTaskRun;
  });

  return taskRun;
}

export function toTaskRunSnapshot(taskRun: {
  id: string;
  kind: EnqueueTaskRunInput["kind"];
  triggerType: EnqueueTaskRunInput["triggerType"];
  status: "queued" | "running" | "succeeded" | "failed" | "partial" | "cancelled";
  label: string;
  entityId: string | null;
  progressCurrent: number;
  progressTotal: number;
  progressLabel: string | null;
  itemsAdded: number;
  fullTextFetchedCount: number;
  aiCallCountActual: number;
  aiCallCountEstimated: number;
  aiCallBreakdownJson: string | null;
  cancelRequestedAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  errorSummary: string | null;
  stageTimingsJson: string | null;
  taskTimelineJson: string | null;
  pipelineCheckpointJson?: string | null;
}): TaskRunSnapshot {
  return {
    id: taskRun.id,
    kind: taskRun.kind,
    triggerType: taskRun.triggerType,
    status: taskRun.status,
    label: taskRun.label,
    entityId: taskRun.entityId,
    progressCurrent: taskRun.progressCurrent,
    progressTotal: taskRun.progressTotal,
    progressLabel: taskRun.progressLabel,
    itemsAdded: taskRun.itemsAdded,
    fullTextFetchedCount: taskRun.fullTextFetchedCount,
    aiCallCountActual: taskRun.aiCallCountActual,
    aiCallCountEstimated: taskRun.aiCallCountEstimated,
    aiCallBreakdown: parseTaskAiCallBreakdownJson(taskRun.aiCallBreakdownJson),
    cancelRequestedAt: taskRun.cancelRequestedAt?.toISOString() ?? null,
    startedAt: taskRun.startedAt?.toISOString() ?? null,
    finishedAt: taskRun.finishedAt?.toISOString() ?? null,
    errorSummary: taskRun.errorSummary,
    stageTimings: parseTaskStageTimingsJson(taskRun.stageTimingsJson),
    taskTimeline: parseTaskTimelineJson(taskRun.taskTimelineJson),
    pipelineCheckpoint: parseTaskPipelineCheckpointJson(taskRun.pipelineCheckpointJson),
  };
}

export function toTaskScheduleSnapshot(schedule: {
  key: string;
  enabled: boolean;
  cronExpression: string;
  sourceConcurrency: number;
  fullTextFetchThreshold: number;
  perSourceItemLimit: number | null;
  aggregationSplitMaxEvents?: number | null;
  dailyReportCandidateLimit: number | null;
  dailyReportPlanningBatchSize?: number | null;
  dailyReportOffsetDays: number | null;
  dailyReportRecentTopicLookbackDays?: number | null;
  dailyReportAutoPublish: boolean | null;
  dailyReportChannelIdsJson?: string | null;
  cleanupRetentionDays: number | null;
  processingStartAt: Date | null;
  timezone: string;
  lastHeartbeatAt: Date | null;
  lastRunStartedAt: Date | null;
  lastRunFinishedAt: Date | null;
  lastRunStatus: "queued" | "running" | "succeeded" | "failed" | "partial" | "cancelled" | null;
  nextRunAt: Date;
}, now = new Date()): TaskScheduleSnapshot {
  return {
    key: schedule.key as TaskScheduleSnapshot["key"],
    enabled: schedule.enabled,
    cronExpression: schedule.cronExpression,
    sourceConcurrency: schedule.sourceConcurrency,
    fullTextFetchThreshold: schedule.fullTextFetchThreshold,
    perSourceItemLimit: schedule.perSourceItemLimit ?? 20,
    aggregationSplitMaxEvents: schedule.aggregationSplitMaxEvents ?? DEFAULT_AGGREGATION_SPLIT_MAX_EVENTS,
    dailyReportCandidateLimit: schedule.dailyReportCandidateLimit ?? DEFAULT_DAILY_REPORT_CANDIDATE_LIMIT,
    dailyReportPlanningBatchSize: schedule.dailyReportPlanningBatchSize ?? null,
    dailyReportOffsetDays: schedule.dailyReportOffsetDays ?? DEFAULT_DAILY_REPORT_OFFSET_DAYS,
    dailyReportRecentTopicLookbackDays: schedule.dailyReportRecentTopicLookbackDays ?? DEFAULT_DAILY_REPORT_RECENT_TOPIC_LOOKBACK_DAYS,
    dailyReportAutoPublish: schedule.dailyReportAutoPublish ?? false,
    dailyReportChannelIds: parseDailyReportChannelIdsJson(schedule.dailyReportChannelIdsJson),
    cleanupRetentionDays: schedule.cleanupRetentionDays ?? DEFAULT_CLEANUP_RETENTION_DAYS,
    processingStartAt: schedule.processingStartAt?.toISOString() ?? null,
    timezone: schedule.timezone,
    lastHeartbeatAt: schedule.lastHeartbeatAt?.toISOString() ?? null,
    lastRunStartedAt: schedule.lastRunStartedAt?.toISOString() ?? null,
    lastRunFinishedAt: schedule.lastRunFinishedAt?.toISOString() ?? null,
    lastRunStatus: schedule.lastRunStatus,
    nextRunAt: schedule.nextRunAt.toISOString(),
    isHeartbeatStale: isSchedulerHeartbeatStale({
      lastHeartbeatAt: schedule.lastHeartbeatAt,
      now,
      maxAgeMs: 30_000,
    }),
  };
}

export async function updateDefaultIngestionSchedule(input: {
  enabled: boolean;
  cronExpression: string;
  sourceConcurrency: number;
  fullTextFetchThreshold: number;
  perSourceItemLimit: number;
  aggregationSplitMaxEvents?: number;
  processingStartAt?: string | null;
}) {
  const normalizedInput = normalizeScheduleInput(input);
  const currentSchedule = await ensureDefaultIngestionSchedule();
  const now = new Date();
  const nextRunAt = computeNextRunAt({
    cronExpression: normalizedInput.cronExpression,
    now,
    anchor: currentSchedule.lastRunFinishedAt ?? now,
    timezone: currentSchedule.timezone,
  });

  return prisma.taskSchedule.update({
    where: { id: currentSchedule.id },
    data: {
      enabled: normalizedInput.enabled,
      cronExpression: normalizedInput.cronExpression,
      sourceConcurrency: normalizedInput.sourceConcurrency,
      fullTextFetchThreshold: normalizedInput.fullTextFetchThreshold,
      perSourceItemLimit: normalizedInput.perSourceItemLimit,
      aggregationSplitMaxEvents: normalizedInput.aggregationSplitMaxEvents,
      processingStartAt: normalizedInput.processingStartAt ? new Date(normalizedInput.processingStartAt) : null,
      nextRunAt,
    },
  });
}

export async function updateDefaultDailyReportSchedule(input: {
  enabled: boolean;
  cronExpression: string;
  dailyReportCandidateLimit: number;
  dailyReportPlanningBatchSize?: number | null;
  dailyReportOffsetDays: number;
  dailyReportRecentTopicLookbackDays: number;
  dailyReportAutoPublish: boolean;
  dailyReportChannelIds?: string[];
}) {
  const cronExpression = input.cronExpression.trim();

  if (!cronExpression) {
    throw new Error("Cron expression is required.");
  }

  computeNextRunAt({
    cronExpression,
    now: new Date(),
    timezone: "Asia/Shanghai",
  });

  if (
    !Number.isInteger(input.dailyReportCandidateLimit) ||
    input.dailyReportCandidateLimit < MIN_DAILY_REPORT_CANDIDATE_LIMIT ||
    input.dailyReportCandidateLimit > MAX_DAILY_REPORT_CANDIDATE_LIMIT
  ) {
    throw new Error(
      `Daily report candidate limit must be an integer between ${MIN_DAILY_REPORT_CANDIDATE_LIMIT} and ${MAX_DAILY_REPORT_CANDIDATE_LIMIT}.`,
    );
  }

  if (
    input.dailyReportPlanningBatchSize !== null &&
    input.dailyReportPlanningBatchSize !== undefined &&
    (!Number.isInteger(input.dailyReportPlanningBatchSize) || input.dailyReportPlanningBatchSize < 1)
  ) {
    throw new Error("Daily report planning batch size must be null or a positive integer.");
  }

  if (
    !Number.isInteger(input.dailyReportOffsetDays) ||
    input.dailyReportOffsetDays < MIN_DAILY_REPORT_OFFSET_DAYS ||
    input.dailyReportOffsetDays > MAX_DAILY_REPORT_OFFSET_DAYS
  ) {
    throw new Error(
      `Daily report T- days must be an integer between ${MIN_DAILY_REPORT_OFFSET_DAYS} and ${MAX_DAILY_REPORT_OFFSET_DAYS}.`,
    );
  }

  if (
    !Number.isInteger(input.dailyReportRecentTopicLookbackDays) ||
    input.dailyReportRecentTopicLookbackDays < MIN_DAILY_REPORT_RECENT_TOPIC_LOOKBACK_DAYS
  ) {
    throw new Error(
      `Daily report recent topic lookback days must be an integer greater than or equal to ${MIN_DAILY_REPORT_RECENT_TOPIC_LOOKBACK_DAYS}.`,
    );
  }

  const dailyReportChannelIds = [...new Set((input.dailyReportChannelIds ?? []).map((channelId) => channelId.trim()).filter(Boolean))];
  if (dailyReportChannelIds.length === 0) {
    throw new Error("Daily report candidate channels must include at least one channel.");
  }

  const currentSchedule = await ensureDefaultDailyReportSchedule();
  const now = new Date();
  const nextRunAt = computeNextRunAt({
    cronExpression,
    now,
    anchor: currentSchedule.lastRunFinishedAt ?? now,
    timezone: currentSchedule.timezone,
  });

  return prisma.taskSchedule.update({
    where: { id: currentSchedule.id },
    data: {
      enabled: input.enabled,
      cronExpression,
      dailyReportCandidateLimit: input.dailyReportCandidateLimit,
      dailyReportPlanningBatchSize: input.dailyReportPlanningBatchSize ?? null,
      dailyReportOffsetDays: input.dailyReportOffsetDays,
      dailyReportRecentTopicLookbackDays: input.dailyReportRecentTopicLookbackDays,
      dailyReportAutoPublish: input.dailyReportAutoPublish,
      dailyReportChannelIdsJson: serializeDailyReportChannelIds(dailyReportChannelIds),
      nextRunAt,
    },
  });
}

export async function updateDefaultItemCleanupSchedule(input: {
  enabled: boolean;
  cronExpression: string;
  cleanupRetentionDays: number;
}) {
  const cronExpression = input.cronExpression.trim();

  if (!cronExpression) {
    throw new Error("Cron expression is required.");
  }

  computeNextRunAt({
    cronExpression,
    now: new Date(),
    timezone: "Asia/Shanghai",
  });

  if (
    !Number.isInteger(input.cleanupRetentionDays) ||
    input.cleanupRetentionDays < MIN_CLEANUP_RETENTION_DAYS ||
    input.cleanupRetentionDays > MAX_CLEANUP_RETENTION_DAYS
  ) {
    throw new Error(
      `Cleanup retention days must be an integer between ${MIN_CLEANUP_RETENTION_DAYS} and ${MAX_CLEANUP_RETENTION_DAYS}.`,
    );
  }

  const currentSchedule = await ensureDefaultItemCleanupSchedule();
  const now = new Date();
  const nextRunAt = computeNextRunAt({
    cronExpression,
    now,
    anchor: currentSchedule.lastRunFinishedAt ?? now,
    timezone: currentSchedule.timezone,
  });

  return prisma.taskSchedule.update({
    where: { id: currentSchedule.id },
    data: {
      enabled: input.enabled,
      cronExpression,
      cleanupRetentionDays: input.cleanupRetentionDays,
      nextRunAt,
    },
  });
}

export async function getTaskRun(id: string) {
  return prisma.backgroundTaskRun.findUnique({
    where: { id },
  });
}

export async function resumeTaskRun(id: string) {
  const taskRun = await getTaskRun(id);
  if (!taskRun) throw new Error("Task run not found.");
  if (taskRun.kind !== "daily_report_generate") throw new Error("只有日报任务支持断点恢复。");
  if (!["failed", "partial", "cancelled"].includes(taskRun.status)) throw new Error("只有失败或部分完成的日报任务支持断点恢复。");
  if (!taskRun.pipelineCheckpointJson) throw new Error("该任务没有可恢复的 checkpoint，请重新生成。");
  const checkpoint = parseTaskPipelineCheckpointJson(taskRun.pipelineCheckpointJson);
  if (!checkpoint) throw new Error("任务 checkpoint 已损坏，无法恢复。");
  if (!checkpoint.resumeEligible) throw new Error("该任务 checkpoint 不满足恢复条件。");
  checkpoint.resumeAttempt = (checkpoint.resumeAttempt ?? 0) + 1;
  checkpoint.failedStage = null;
  checkpoint.failureCode = null;
  const updated = await prisma.backgroundTaskRun.updateMany({
    where: {
      id,
      status: { in: ["failed", "partial", "cancelled"] },
    },
    data: {
      triggerType: "admin_action",
      status: "queued",
      progressCurrent: 0,
      progressTotal: 1,
      progressLabel: "等待断点恢复",
      errorSummary: null,
      cancelRequestedAt: null,
      startedAt: null,
      finishedAt: null,
      pipelineCheckpointJson: JSON.stringify(checkpoint),
    },
  });
  if (updated.count !== 1) throw new Error("任务状态已变化，请刷新后再试。");
  return prisma.backgroundTaskRun.findUniqueOrThrow({ where: { id } });
}

export async function isTaskRunCancellationRequested(id: string) {
  const taskRun = await getTaskRun(id);

  return Boolean(taskRun?.cancelRequestedAt);
}

export async function requestTaskRunCancellation(id: string) {
  const taskRun = await prisma.backgroundTaskRun.findUnique({
    where: { id },
  });

  if (!taskRun) {
    throw new Error("Task run not found.");
  }

  if (taskRun.status === "cancelled") {
    return taskRun;
  }

  const now = new Date();

  if (taskRun.status === "queued") {
    return prisma.backgroundTaskRun.update({
      where: { id },
      data: {
        status: "cancelled",
        cancelRequestedAt: taskRun.cancelRequestedAt ?? now,
        progressLabel: TASK_RUN_CANCELLED_LABEL,
        finishedAt: now,
        errorSummary: TASK_RUN_CANCELLED_MESSAGE,
      },
    });
  }

  if (taskRun.status !== "running") {
    throw new Error("Task is no longer active.");
  }

  return prisma.backgroundTaskRun.update({
    where: { id },
    data: {
      cancelRequestedAt: taskRun.cancelRequestedAt ?? now,
      errorSummary: taskRun.errorSummary ?? TASK_RUN_CANCELLED_MESSAGE,
    },
  });
}

export async function getBackgroundTaskMonitorSnapshot(
  now = new Date(),
  opts?: {
    page?: number;
    pageSize?: number;
    status?: BackgroundTaskRunStatus | null;
    kind?: BackgroundTaskRunKind | null;
    timeRange?: "today" | "week" | "month" | null;
    rangeDays?: 1 | 3 | 7 | null;
  },
): Promise<BackgroundTaskMonitorSnapshot> {
  const schedule = await ensureDefaultIngestionSchedule();
  await ensureDefaultDailyReportSchedule();
  const page = opts?.page ?? 1;
  const pageSize = opts?.pageSize ?? 20;
  const skip = (page - 1) * pageSize;
  const where = buildBackgroundTaskMonitorWhere(now, opts);
  const runningStatus = getRunningTaskStatusFilter(opts?.status);

  const [runningTasks, recentTasks, recentTotal] = await Promise.all([
    runningStatus
      ? findTaskMonitorRuns({
          status: runningStatus,
          kind: opts?.kind ?? null,
          startedAt: getTaskMonitorStartedAtRange(now, opts?.timeRange, opts?.rangeDays),
        })
      : Promise.resolve([]),
    findTaskMonitorRuns({
      status: opts?.status ?? null,
      kind: opts?.kind ?? null,
      startedAt: getTaskMonitorStartedAtRange(now, opts?.timeRange, opts?.rangeDays),
      pageSize,
      skip,
    }),
    prisma.backgroundTaskRun.count({ where }),
  ]);

  return {
    schedule: toTaskScheduleSnapshot(schedule, now),
    runningTasks: await attachTaskEntityTitles(runningTasks.map(toTaskRunSnapshot)),
    recentTasks: await attachTaskEntityTitles(recentTasks.map(toTaskRunSnapshot)),
    recentTotal,
    page,
    pageSize,
  };
}

function getRunningTaskStatusFilter(status?: BackgroundTaskRunStatus | null) {
  if (!status) {
    return { in: ["queued", "running"] } satisfies Prisma.EnumBackgroundTaskStatusFilter;
  }

  return status === "queued" || status === "running" ? status : null;
}

function getLocalDayStart(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function getTaskMonitorStartedAtRange(
  now: Date,
  timeRange?: "today" | "week" | "month" | null,
  rangeDays?: 1 | 3 | 7 | null,
) {
  if (rangeDays) {
    return { gte: new Date(now.getTime() - rangeDays * 24 * 60 * 60 * 1000) };
  }

  if (!timeRange) {
    return null;
  }

  const start = getLocalDayStart(now);
  if (timeRange === "week") {
    start.setDate(start.getDate() - 6);
  } else if (timeRange === "month") {
    start.setDate(start.getDate() - 29);
  }

  return { gte: start };
}

function buildBackgroundTaskMonitorWhere(
  now: Date,
  opts?: {
    status?: BackgroundTaskRunStatus | null;
    kind?: BackgroundTaskRunKind | null;
    timeRange?: "today" | "week" | "month" | null;
    rangeDays?: 1 | 3 | 7 | null;
  },
): Prisma.BackgroundTaskRunWhereInput {
  const startedAt = getTaskMonitorStartedAtRange(now, opts?.timeRange, opts?.rangeDays);

  return {
    ...(opts?.status ? { status: opts.status } : {}),
    ...(opts?.kind ? { kind: opts.kind } : {}),
    ...(startedAt ? { startedAt } : {}),
  };
}

async function attachTaskEntityTitles(tasks: TaskRunSnapshot[]): Promise<TaskRunSnapshot[]> {
  const itemIds = Array.from(
    new Set(
      tasks
        .filter((task) => task.entityId && task.kind.startsWith("item_"))
        .map((task) => task.entityId as string),
    ),
  );
  const clusterIds = Array.from(
    new Set(
      tasks
        .filter((task) => task.entityId && task.kind.startsWith("cluster_"))
        .map((task) => task.entityId as string),
    ),
  );

  if (itemIds.length === 0 && clusterIds.length === 0) {
    return tasks;
  }

  const [items, clusters] = await Promise.all([
    itemIds.length > 0
      ? prisma.item.findMany({
          where: { id: { in: itemIds } },
          select: { id: true, translatedTitle: true, originalTitle: true },
        })
      : [],
    clusterIds.length > 0
      ? prisma.contentCluster.findMany({
          where: { id: { in: clusterIds } },
          select: { id: true, title: true },
        })
      : [],
  ]);
  const itemTitles = new Map(items.map((item) => [item.id, item.translatedTitle?.trim() || item.originalTitle]));
  const clusterTitles = new Map(clusters.map((cluster) => [cluster.id, cluster.title]));

  return tasks.map((task) => {
    if (!task.entityId) {
      return task;
    }

    const entityTitle = task.kind.startsWith("item_")
      ? itemTitles.get(task.entityId)
      : task.kind.startsWith("cluster_")
        ? clusterTitles.get(task.entityId)
        : null;

    return entityTitle ? { ...task, entityTitle } : task;
  });
}
