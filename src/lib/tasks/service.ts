import { Prisma } from "@prisma/client";

import {
  claimTaskRun,
  createScheduledTaskRunIfDue,
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
  type TaskAiCallBreakdownSnapshot,
  type BackgroundTaskMonitorSnapshot,
  type EnqueueTaskRunInput,
  type TaskStageTimingSnapshot,
  type TaskTimelineNodeSnapshot,
  type TaskPipelineCheckpoint,
  type TaskCheckpointSummary,
  type TaskRunSnapshot,
  type TaskScheduleSnapshot,
  type BackgroundTaskRunKind,
  type BackgroundTaskRunStatus,
  type DailyReportRecoveryStage,
} from "@/lib/tasks/types";
import { prisma } from "@/lib/db";
import {
  parseTaskPipelineCheckpointJson,
  parseTaskWorkflowCheckpointJson,
  serializeTaskPipelineCheckpoint,
} from "@/lib/tasks/checkpoint";
import {
  parseTaskStageTimingsJson,
  parseTaskTimelineJson,
  serializeTaskStageTimings,
  serializeTaskTimeline,
} from "@/lib/tasks/json-contracts";
import {
  getDefaultTaskAiCallBreakdown,
  parseTaskAiCallBreakdownArray,
} from "@/lib/tasks/ai-usage-contracts";
import { DAILY_REPORT_RECOVERY_STAGE_LABELS, getDailyReportRecoveryStages } from "@/lib/daily-report/recovery";

export const TASK_RUN_CANCELLED_MESSAGE = "管理员手动终止任务。";
export const TASK_RUN_CANCELLED_LABEL = "任务已终止";
const DEFAULT_DAILY_REPORT_CHANNEL_IDS = ["important"];

/** monitor 展示路径：仅已知 key、默认 11 键兜底、标签表顺序，last-key-wins。 */
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
    const parsedMap = new Map(
      parseTaskAiCallBreakdownArray(parsed).map((entry) => [entry.key, entry]),
    );
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

/**
 * scheduled 触发的任务到达终态后回写所属调度行的运行状态。
 * UI 监控面板的「Last Status」消费该字段；manual/admin_action 触发不回写。
 */
export async function markScheduledTaskRunFinished(
  kind: BackgroundTaskRunKind,
  taskRun: { startedAt: Date | null; createdAt: Date },
  status: "succeeded" | "partial" | "failed" | "cancelled",
) {
  const scheduleKey = getHeartbeatScheduleKeyForTaskKind(kind);

  const schedule = scheduleKey === DEFAULT_DAILY_REPORT_SCHEDULE_KEY
    ? await ensureDefaultDailyReportSchedule()
    : scheduleKey === DEFAULT_ITEM_CLEANUP_SCHEDULE_KEY
      ? await ensureDefaultItemCleanupSchedule()
      : await ensureDefaultIngestionSchedule();

  await prisma.taskSchedule.update({
    where: { id: schedule.id },
    data: {
      lastRunStartedAt: taskRun.startedAt ?? taskRun.createdAt,
      lastRunFinishedAt: new Date(),
      lastRunStatus: status,
    },
  });
}

export async function enqueueTaskRun(input: EnqueueTaskRunInput) {
  return createTaskRun(input);
}

export async function enqueueScheduledTaskRunIfDue(input: Parameters<typeof createScheduledTaskRunIfDue>[0]) {
  return createScheduledTaskRunIfDue(input);
}

export async function claimNextQueuedTaskRun() {
  const blockedKinds: string[] = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const nextQueuedTaskRun = await findNextQueuedTaskRun(blockedKinds);
    if (!nextQueuedTaskRun) return null;

    const claimed = await claimTaskRun(nextQueuedTaskRun.id);
    if (claimed) return claimed;
    if (!blockedKinds.includes(nextQueuedTaskRun.kind)) blockedKinds.push(nextQueuedTaskRun.kind);
  }
  return null;
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

function buildTaskCheckpointSummary(taskRun: { pipelineCheckpointJson?: string | null }): TaskCheckpointSummary {
  const pipeline = parseTaskPipelineCheckpointJson(taskRun.pipelineCheckpointJson);
  const workflow = parseTaskWorkflowCheckpointJson(taskRun.pipelineCheckpointJson);
  const mastra = workflow?.mastra ?? {};
  const lifecycle = mastra.lifecycle && typeof mastra.lifecycle === "object" && !Array.isArray(mastra.lifecycle)
    ? mastra.lifecycle as Record<string, unknown>
    : {};
  return {
    pipelineStage: pipeline?.stage ?? null,
    resumeEligible: pipeline?.resumeEligible ?? false,
    resumeFrom: pipeline?.resumeFrom ?? null,
    reviewStatus: pipeline?.reviewStatus ?? null,
    workflowStage: typeof mastra.stage === "string" ? mastra.stage : null,
    workflowStatus: typeof lifecycle.status === "string" ? lifecycle.status : null,
  };
}

export function toTaskRunSnapshot(taskRun: {
  id: string;
  kind: BackgroundTaskRunKind;
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
}, options: { isDetailLoaded?: boolean } = {}): TaskRunSnapshot {
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
    workflowCheckpoint: parseTaskWorkflowCheckpointJson(taskRun.pipelineCheckpointJson),
    checkpointSummary: buildTaskCheckpointSummary({ pipelineCheckpointJson: taskRun.pipelineCheckpointJson }),
    isDetailLoaded: options.isDetailLoaded ?? true,
  };
}

export function toTaskRunListSnapshot(taskRun: Parameters<typeof toTaskRunSnapshot>[0]): TaskRunSnapshot {
  const snapshot = toTaskRunSnapshot(taskRun, { isDetailLoaded: false });
  return {
    ...snapshot,
    aiCallBreakdown: undefined,
    stageTimings: [],
    taskTimeline: undefined,
    pipelineCheckpoint: undefined,
    workflowCheckpoint: undefined,
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
  processingWindowDays: number;
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
    processingWindowDays: schedule.processingWindowDays ?? 14,
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
  processingWindowDays?: number;
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
      processingStartAt: new Date(now.getTime() - normalizedInput.processingWindowDays! * 24 * 60 * 60 * 1000),
      processingWindowDays: normalizedInput.processingWindowDays!,
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

function resetStageAttemptsForDailyReportRecovery(
  stageAttempts: Record<string, number> | undefined,
  retryFrom: DailyReportRecoveryStage,
) {
  const resetPrefixes: Record<DailyReportRecoveryStage, string[]> = {
    assess: ["ASSESS", "MERGE", "PLAN", "PLAN_VALIDATE", "WRITE", "JSON_REPAIR", "VALIDATE", "REPAIR", "PERSIST_PUBLISH"],
    plan: ["PLAN", "PLAN_VALIDATE", "WRITE", "JSON_REPAIR", "VALIDATE", "REPAIR", "PERSIST_PUBLISH"],
    write: ["WRITE", "JSON_REPAIR", "VALIDATE", "REPAIR", "PERSIST_PUBLISH"],
    review: ["REVIEW", "PERSIST_PUBLISH"],
  };
  const prefixes = resetPrefixes[retryFrom];

  return Object.fromEntries(
    Object.entries(stageAttempts ?? {}).filter(([key]) => !prefixes.some((prefix) => key === prefix || key.startsWith(`${prefix}.`))),
  );
}

function resetDailyReportCheckpointForRecovery(
  checkpoint: TaskPipelineCheckpoint,
  retryFrom: DailyReportRecoveryStage,
) {
  const nextCheckpoint: TaskPipelineCheckpoint = {
    ...checkpoint,
    stage: retryFrom,
    resumeEligible: true,
    resumeAttempt: (checkpoint.resumeAttempt ?? 0) + 1,
    resumeFrom: retryFrom,
    failedStage: null,
    failureCode: null,
    stageAttempts: resetStageAttemptsForDailyReportRecovery(checkpoint.stageAttempts, retryFrom),
    data: {
      ...(checkpoint.data ?? {}),
      manualRetryFrom: retryFrom,
    },
  };
  delete nextCheckpoint.stageLoop;

  if (retryFrom === "assess") {
    nextCheckpoint.completedStages = ["prepare"];
    nextCheckpoint.assessmentBatches = nextCheckpoint.assessmentBatches?.map(({ index, candidateIds }) => ({
      index,
      candidateIds,
      status: "pending" as const,
      attempt: 0,
    }));
    delete nextCheckpoint.planningAudit;
    delete nextCheckpoint.ledger;
    delete nextCheckpoint.planningCandidateBriefs;
    delete nextCheckpoint.plan;
    delete nextCheckpoint.draft;
    delete nextCheckpoint.violations;
  } else if (retryFrom === "plan") {
    nextCheckpoint.completedStages = ["prepare", "assess", "merge"];
    delete nextCheckpoint.planningAudit;
    delete nextCheckpoint.plan;
    delete nextCheckpoint.draft;
    delete nextCheckpoint.violations;
  } else if (retryFrom === "write") {
    nextCheckpoint.completedStages = ["prepare", "assess", "merge", "plan", "plan_validate"];
    delete nextCheckpoint.draft;
    delete nextCheckpoint.violations;
  } else if (retryFrom === "review") {
    nextCheckpoint.completedStages = nextCheckpoint.completedStages.filter((stage) => stage !== "review");
    nextCheckpoint.lastCompletedStage = "validate";
    delete nextCheckpoint.reviewStatus;
    delete nextCheckpoint.reviewAttempts;
    delete nextCheckpoint.reviewRetryStage;
    delete nextCheckpoint.reviewViolations;
    delete nextCheckpoint.reviewAudit;
  }

  return nextCheckpoint;
}

export async function resumeTaskRun(id: string, options: { retryFrom?: DailyReportRecoveryStage } = {}) {
  const taskRun = await getTaskRun(id);
  if (!taskRun) throw new Error("Task run not found.");
  if (taskRun.kind !== "daily_report_generate") throw new Error("只有日报任务支持断点恢复。");
  if (!options.retryFrom && !["failed", "partial", "cancelled"].includes(taskRun.status)) {
    throw new Error("只有失败或部分完成的日报任务支持断点恢复。");
  }
  if (options.retryFrom && !["failed", "partial", "cancelled", "succeeded"].includes(taskRun.status)) {
    throw new Error("当前日报任务状态不支持中间阶段重新生成。");
  }
  if (!taskRun.pipelineCheckpointJson) throw new Error("该任务没有可恢复的 checkpoint，请重新生成。");
  const checkpoint = parseTaskPipelineCheckpointJson(taskRun.pipelineCheckpointJson);
  if (!checkpoint) throw new Error("任务 checkpoint 已损坏，无法恢复。");
  const retryFrom = options.retryFrom;
  const nextCheckpoint = retryFrom
    ? (() => {
        const recoveryStages = getDailyReportRecoveryStages(checkpoint);
        if (!recoveryStages.includes(retryFrom)) {
          throw new Error(`当前任务不支持从 ${DAILY_REPORT_RECOVERY_STAGE_LABELS[retryFrom]} 阶段继续，请选择其他阶段或全部重试。`);
        }
        return resetDailyReportCheckpointForRecovery(checkpoint, retryFrom);
      })()
    : (() => {
        if (!checkpoint.resumeEligible) throw new Error("该任务 checkpoint 不满足恢复条件。");
        return {
          ...checkpoint,
          resumeAttempt: (checkpoint.resumeAttempt ?? 0) + 1,
          failedStage: null,
          failureCode: null,
        };
      })();
  if (retryFrom) {
    const recoveryTask = await prisma.backgroundTaskRun.create({
      data: {
        kind: taskRun.kind,
        triggerType: "admin_action",
        status: "queued",
        label: `${taskRun.label}（从 ${DAILY_REPORT_RECOVERY_STAGE_LABELS[retryFrom]} 重新生成）`,
        entityId: taskRun.entityId,
        pipelineCheckpointJson: JSON.stringify(nextCheckpoint),
      },
    });
    return recoveryTask;
  }
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
      pipelineCheckpointJson: JSON.stringify(nextCheckpoint),
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
    includeDetails?: boolean;
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

  const snapshotMapper = opts?.includeDetails === false ? toTaskRunListSnapshot : toTaskRunSnapshot;

  return {
    schedule: toTaskScheduleSnapshot(schedule, now),
    runningTasks: await attachTaskEntityTitles(runningTasks.map((task) => snapshotMapper(task))),
    recentTasks: await attachTaskEntityTitles(recentTasks.map((task) => snapshotMapper(task))),
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

export async function attachTaskEntityTitles(tasks: TaskRunSnapshot[]): Promise<TaskRunSnapshot[]> {
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
