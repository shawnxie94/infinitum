export const DEFAULT_INGESTION_SCHEDULE_KEY = "ingestion_default" as const;
export const DEFAULT_DAILY_REPORT_SCHEDULE_KEY = "daily_report_default" as const;
export const DEFAULT_ITEM_CLEANUP_SCHEDULE_KEY = "item_cleanup_default" as const;
export const DEFAULT_INGESTION_TASK_LABEL = "默认抓取任务";
export const DEFAULT_DAILY_REPORT_TASK_LABEL = "AI 日报生成";
export const DEFAULT_ITEM_CLEANUP_TASK_LABEL = "文章自动清理";

export type DefaultIngestionScheduleKey = typeof DEFAULT_INGESTION_SCHEDULE_KEY;
export type DefaultDailyReportScheduleKey = typeof DEFAULT_DAILY_REPORT_SCHEDULE_KEY;
export type DefaultItemCleanupScheduleKey = typeof DEFAULT_ITEM_CLEANUP_SCHEDULE_KEY;

export type BackgroundTaskRunKind =
  | "ingestion"
  | "precompute"
  | "item_regenerate_translation"
  | "item_regenerate_summary"
  | "item_reanalyze"
  | "item_processing_recovery"
  | "cluster_regenerate_summary"
  | "cluster_merge_precompute_clean_pairs"
  | "daily_report_generate"
  | "item_cleanup"
  | "item_reparse_aggregations";

export type BackgroundTaskRunTrigger = "scheduled" | "manual" | "admin_action";

export type BackgroundTaskRunStatus = "queued" | "running" | "succeeded" | "failed" | "partial" | "cancelled";

export type ScheduleUpdateInput = {
  enabled: boolean;
  cronExpression: string;
  sourceConcurrency: number;
  fullTextFetchThreshold: number;
  perSourceItemLimit: number;
  aggregationSplitMaxEvents?: number;
  processingStartAt?: string | null;
};

export type EnqueueTaskRunInput = {
  kind: BackgroundTaskRunKind;
  triggerType: BackgroundTaskRunTrigger;
  label: string;
  entityId?: string | null;
};

export type TaskStageTimingSnapshot = {
  key: string;
  label: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
};

export type TaskTimelineNodeKey =
  | "daily_report_generate"
  | "daily_report_prepare"
  | "daily_report_assess"
  | "daily_report_merge"
  | "daily_report_plan"
  | "daily_report_plan_validate"
  | "daily_report_validate"
  | "daily_report_write"
  | "daily_report_repair"
  | "daily_report_persist_publish"
  | "task_finished"
  | "source_fetch"
  | "rule_filter"
  | "item_understanding"
  | "cluster_assignment"
  | "cluster_merge"
  | "cluster_finalize";

export type TaskTimelineNodeStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "partial"
  | "cancelled"
  | "skipped";

export type TaskTimelineMetricSnapshot = {
  label: string;
  value: number;
};

export type TaskTimelineNodeSnapshot = {
  key: TaskTimelineNodeKey;
  label: string;
  status: TaskTimelineNodeStatus;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  modelName?: string | null;
  metrics: TaskTimelineMetricSnapshot[];
};

export type TaskPipelineCheckpoint = {
  version: 1;
  pipelineVersion: string;
  stage: string;
  completedStages: string[];
  inputHash: string;
  templateSignature: string | null;
  candidateSnapshotHash: string;
  resumeEligible: boolean;
  lastCompletedStage?: string;
  failedStage?: string | null;
  failureCode?: string | null;
  resumeAttempt?: number;
  stageAttempts?: Record<string, number>;
  candidateSnapshot?: unknown;
  assessmentBatches?: Array<{
    index: number;
    candidateIds: number[];
    status: "pending" | "running" | "succeeded" | "failed";
    attempt: number;
    assessments?: unknown[];
    error?: string;
  }>;
  ledger?: unknown;
  mergedTopics?: unknown[];
  plan?: unknown;
  draft?: unknown;
  violations?: unknown[];
  data?: Record<string, unknown>;
};

export type TaskAiCallBreakdownKey =
  | "item_understanding"
  | "cluster_match"
  | "cluster_summary"
  | "cluster_merge"
  | "daily_report";

export type TaskAiCallBreakdownSnapshot = {
  key: TaskAiCallBreakdownKey;
  label: string;
  actual: number;
  estimated: number;
};

export type TaskRunSnapshot = {
  id: string;
  kind: BackgroundTaskRunKind;
  triggerType: BackgroundTaskRunTrigger;
  status: BackgroundTaskRunStatus;
  label: string;
  entityId: string | null;
  entityTitle?: string | null;
  progressCurrent: number;
  progressTotal: number;
  progressLabel: string | null;
  itemsAdded: number;
  fullTextFetchedCount?: number;
  aiCallCountActual: number;
  aiCallCountEstimated: number;
  aiCallBreakdown?: TaskAiCallBreakdownSnapshot[];
  cancelRequestedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  errorSummary: string | null;
  stageTimings: TaskStageTimingSnapshot[];
  taskTimeline?: TaskTimelineNodeSnapshot[];
  pipelineCheckpoint?: TaskPipelineCheckpoint | null;
};

export type TaskScheduleSnapshot = {
  key: DefaultIngestionScheduleKey | DefaultDailyReportScheduleKey | DefaultItemCleanupScheduleKey;
  enabled: boolean;
  cronExpression: string;
  sourceConcurrency: number;
  fullTextFetchThreshold: number;
  perSourceItemLimit: number;
  aggregationSplitMaxEvents: number;
  dailyReportCandidateLimit: number;
  dailyReportPlanningBatchSize?: number | null;
  dailyReportOffsetDays: number;
  dailyReportRecentTopicLookbackDays?: number;
  dailyReportAutoPublish: boolean;
  dailyReportChannelIds?: string[];
  cleanupRetentionDays: number;
  processingStartAt?: string | null;
  timezone: string;
  lastHeartbeatAt: string | null;
  lastRunStartedAt: string | null;
  lastRunFinishedAt: string | null;
  lastRunStatus: BackgroundTaskRunStatus | null;
  nextRunAt: string;
  isHeartbeatStale: boolean;
};

export type BackgroundTaskMonitorSnapshot = {
  schedule: TaskScheduleSnapshot;
  runningTasks: TaskRunSnapshot[];
  recentTasks: TaskRunSnapshot[];
  recentTotal?: number;
  page?: number;
  pageSize?: number;
};
