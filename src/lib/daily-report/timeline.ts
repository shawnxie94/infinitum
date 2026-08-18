import type { BackgroundTaskRun } from "@prisma/client";

import type { TaskTimelineNodeSnapshot } from "@/lib/tasks/types";
import type { DailyReportPlanningAudit } from "@/lib/daily-report/types";

export type DailyReportPipelineStage =
  | "prepare"
  | "assess"
  | "merge"
  | "plan"
  | "plan_validate"
  | "write"
  | "validate"
  | "repair"
  | "persist_publish";

type DailyReportTaskTimelineInput = {
  taskRun: BackgroundTaskRun;
  status: "running" | "succeeded" | "failed" | "cancelled" | "skipped";
  candidateCount?: number | null;
  historyFilteredCount?: number | null;
  selectedCount?: number | null;
  planningCandidateCount?: number | null;
  planSectionCount?: number | null;
  planSelectedCount?: number | null;
  planTruncatedTopicCount?: number | null;
  planningAudit?: DailyReportPlanningAudit | null;
  planViolationCount?: number | null;
  validationViolationCount?: number | null;
  repairCount?: number | null;
  activeStage?: DailyReportPipelineStage | null;
  batchCount?: number | null;
  batchSize?: number | null;
  finishedAt?: Date | null;
};

function getDailyReportTaskFinishedLabel(status: DailyReportTaskTimelineInput["status"]) {
  if (status === "running") return "进行中";
  if (status === "failed") return "失败";
  if (status === "cancelled") return "已取消";
  if (status === "skipped") return "已跳过";
  return "已完成";
}

export function buildDailyReportTaskTimeline(input: DailyReportTaskTimelineInput): TaskTimelineNodeSnapshot[] {
  const taskStartedAt = input.taskRun.startedAt ?? input.taskRun.createdAt;
  const startedAt = taskStartedAt.toISOString();
  const finishedAt = input.finishedAt?.toISOString() ?? null;
  const durationMs = input.finishedAt ? input.finishedAt.getTime() - taskStartedAt.getTime() : null;
  const stages = [
    ["daily_report_prepare", "准备候选"],
    ["daily_report_assess", "分批选题评估"],
    ["daily_report_merge", "准备规划输入"],
    ["daily_report_plan", "全局规划"],
    ["daily_report_plan_validate", "计划校验"],
    ["daily_report_write", "按计划写作"],
    ["daily_report_validate", "草稿校验"],
    ["daily_report_repair", "语义修复"],
    ["daily_report_persist_publish", "持久化/发布"],
  ] as const;
  const stageNames: DailyReportPipelineStage[] = ["prepare", "assess", "merge", "plan", "plan_validate", "write", "validate", "repair", "persist_publish"];
  const activeIndex = input.activeStage ? stageNames.indexOf(input.activeStage) : -1;
  const parentStatus: TaskTimelineNodeSnapshot["status"] = input.status === "running"
    ? "running"
    : input.status === "failed"
      ? "failed"
      : input.status === "cancelled"
        ? "cancelled"
        : input.status === "skipped" ? "skipped" : "succeeded";
  const nodes = stages.map(([key, label], index) => {
    const repairSkipped = key === "daily_report_repair" && input.status === "succeeded" && (input.repairCount ?? 0) === 0;
    const terminalFailureIndex = Math.max(activeIndex, 0);
    const nodeStatus = repairSkipped
      ? "skipped"
      : input.status === "failed"
        ? index < terminalFailureIndex ? "succeeded" : index === terminalFailureIndex ? "failed" : "pending"
        : input.status === "cancelled"
          ? index < terminalFailureIndex ? "succeeded" : index === terminalFailureIndex ? "cancelled" : "pending"
          : input.status === "running"
            ? index < activeIndex ? "succeeded" : index === activeIndex ? "running" : "pending"
            : input.status === "skipped"
              ? index === 0 ? "succeeded" : "skipped"
              : "succeeded";
    return {
      key,
      label,
      status: nodeStatus,
      startedAt: nodeStatus === "pending" || nodeStatus === "skipped" ? null : startedAt,
      finishedAt: nodeStatus === "running" || nodeStatus === "pending" ? null : finishedAt,
      durationMs: nodeStatus === "running" || nodeStatus === "pending" ? null : durationMs,
      metrics: [
        ...(index === 0 ? [{ label: "总候选数", value: input.candidateCount ?? 0 }] : []),
        ...(index === 1 ? [
          { label: "批次数", value: input.batchCount ?? 0 },
          { label: "批次大小", value: input.batchSize ?? 0 },
          { label: "历史重复过滤", value: input.historyFilteredCount ?? 0 },
        ] : []),
        ...(index === 2 ? [{ label: "可规划候选", value: input.planningCandidateCount ?? 0 }] : []),
        ...(index === 3 ? [
          { label: "计划栏目", value: input.planSectionCount ?? 0 },
          { label: "计划入选", value: input.planSelectedCount ?? input.selectedCount ?? 0 },
          { label: "截取主题", value: input.planTruncatedTopicCount ?? 0 },
        ] : []),
        ...(index === 4 ? [{ label: "违规数", value: input.planViolationCount ?? 0 }] : []),
        ...(index === 5 ? [{ label: "入选数", value: input.selectedCount ?? 0 }] : []),
        ...(index === 6 ? [{ label: "违规数", value: input.validationViolationCount ?? 0 }] : []),
        ...(index === 7 ? [{ label: "修复次数", value: input.repairCount ?? 0 }] : []),
      ],
      ...(key === "daily_report_plan" && input.planningAudit ? { audit: { planning: input.planningAudit } } : {}),
    } satisfies TaskTimelineNodeSnapshot;
  });
  return [
    {
      key: "daily_report_generate",
      label: "AI 日报生成",
      status: parentStatus,
      startedAt,
      finishedAt: input.status === "running" ? null : finishedAt,
      durationMs,
      metrics: [
        { label: "总候选数", value: input.candidateCount ?? 0 },
        { label: "批次数", value: input.batchCount ?? 0 },
        { label: "批次大小", value: input.batchSize ?? 0 },
        { label: "最后入选数", value: input.selectedCount ?? 0 },
      ],
    },
    ...nodes,
    {
      key: "task_finished",
      label: getDailyReportTaskFinishedLabel(input.status),
      status: input.status === "running"
        ? "running"
        : input.status === "failed"
          ? "failed"
          : input.status === "cancelled"
            ? "cancelled"
            : input.status === "skipped" ? "skipped" : "succeeded",
      startedAt: input.status === "running" ? startedAt : finishedAt,
      finishedAt: input.status === "running" ? null : finishedAt,
      durationMs: null,
      metrics: [
        { label: "最后入选数", value: input.selectedCount ?? 0 },
      ],
    },
  ];
}
