"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterSelect } from "@/components/ui/filter-select";
import { ModalShell } from "@/components/ui/modal-shell";
import { PaginationControls } from "@/components/ui/pagination-controls";
import { SelectField } from "@/components/ui/select-field";
import { StatusTag } from "@/components/ui/status-tag";
import { useToast } from "@/components/ui/toast";
import { IconButton } from "@/components/ui/icon-button";
import { IconRotateCw, IconSquare } from "@/components/ui/icons";
import {
  DAILY_REPORT_RECOVERY_STAGE_LABELS,
  getDailyReportRecoveryStages,
  getRecommendedDailyReportRecoveryStage,
} from "@/lib/daily-report/recovery";
import { getDailyReportFailureSummary } from "@/lib/daily-report/review";
import type {
  BackgroundTaskMonitorSnapshot,
  BackgroundTaskRunStatus,
  DailyReportRecoveryStage,
  TaskRunSnapshot,
  TaskStageTimingSnapshot,
  TaskTimelineNodeKey,
  TaskTimelineNodeStatus,
} from "@/lib/tasks/types";
import { cx } from "@/lib/ui/cx";

// Task status filter options
type TaskStatusFilter = "" | BackgroundTaskRunStatus;
type TaskKindFilter = "" | TaskRunSnapshot["kind"];
type TimeRangeFilter = "" | "day1" | "day3" | "day7" | "month";

const statusOptions: Array<{ value: TaskStatusFilter; label: string }> = [
  { value: "", label: "全部" },
  { value: "queued", label: "待处理" },
  { value: "running", label: "运行中" },
  { value: "succeeded", label: "已成功" },
  { value: "failed", label: "失败" },
  { value: "partial", label: "部分成功" },
  { value: "cancelled", label: "已取消" },
];

const timeRangeOptions: Array<{ value: TimeRangeFilter; label: string }> = [
  { value: "", label: "全部时间" },
  { value: "day1", label: "最近1天" },
  { value: "day3", label: "最近3天" },
  { value: "day7", label: "最近7天" },
  { value: "month", label: "最近30天" },
];

const statusLabels: Record<BackgroundTaskRunStatus, string> = {
  queued: "待处理",
  running: "运行中",
  succeeded: "已成功",
  failed: "失败",
  partial: "部分成功",
  cancelled: "已取消",
};

const kindLabels: Record<TaskRunSnapshot["kind"], string> = {
  ingestion: "抓取任务",
  precompute: "预计算",
  item_reanalyze: "内容重分析",
  item_processing_recovery: "抓取失败补偿",
  item_regenerate_summary: "摘要重生成",
  item_regenerate_translation: "译文重生成",
  cluster_regenerate_summary: "聚合摘要重生成",
  cluster_merge_precompute_clean_pairs: "旧版聚合合并缓存预计算",
  daily_report_generate: "AI 日报生成",
  item_cleanup: "文章自动清理",
  item_reparse_aggregations: "旧版聚合内容重拆",
};

const kindOptions: Array<{ value: TaskKindFilter; label: string }> = [
  { value: "", label: "全部" },
  ...(Object.entries(kindLabels) as Array<[TaskRunSnapshot["kind"], string]>).map(([value, label]) => ({
    value,
    label,
  })),
];

function getTaskKindLabel(kind: string) {
  return kindLabels[kind as TaskRunSnapshot["kind"]] ?? kind;
}

function getDailyReportReviewStatusLabel(task: TaskRunSnapshot) {
  const status = task.pipelineCheckpoint?.reviewStatus;
  if (status === "passed") return "已通过";
  if (status === "rejected") return "未通过（草稿）";
  if (status === "unavailable") return "审核不可用（草稿）";
  if (status === "disabled") return "未启用";
  return null;
}

function getDailyReportTaskIssueSummary(task: TaskRunSnapshot) {
  if (task.kind !== "daily_report_generate") return null;
  const checkpoint = task.pipelineCheckpoint;
  return getDailyReportFailureSummary({
    status: checkpoint?.reviewStatus,
    audit: checkpoint?.reviewAudit,
    violations: checkpoint?.reviewViolations,
    partial: task.status === "partial",
    omittedTopicCount: checkpoint?.data && typeof checkpoint.data.omittedTopicCount === "number"
      ? checkpoint.data.omittedTopicCount
      : undefined,
  });
}

function canResumeDailyReportTask(task: TaskRunSnapshot | null) {
  return Boolean(
    task?.kind === "daily_report_generate" &&
    ["failed", "partial", "cancelled"].includes(task.status) &&
    task.pipelineCheckpoint?.version === 1 &&
    task.pipelineCheckpoint.resumeEligible,
  );
}

function getTaskRetryActionLabel(task: TaskRunSnapshot | null) {
  return task?.kind === "daily_report_generate"
    ? "重新生成"
    : canResumeDailyReportTask(task) ? "继续执行" : "重新生成";
}

type DailyReportRetryChoice = "all" | DailyReportRecoveryStage;

function getDailyReportRetryOptions(task: TaskRunSnapshot | null) {
  if (task?.kind !== "daily_report_generate") return [];

  const stages = getDailyReportRecoveryStages(task.pipelineCheckpoint);
  return [
    {
      value: "all" as const,
      label: "全部重试",
      description: "从准备候选开始完整重新生成，创建新的任务。",
      recommended: false,
    },
    ...stages.map((stage) => ({
      value: stage,
      label: `从 ${DAILY_REPORT_RECOVERY_STAGE_LABELS[stage]} 继续`,
      description: stage === "write"
        ? "复用 PLAN 结果，丢弃旧草稿并重新生成完整日报；阶段内会自动处理校验反馈。"
        : stage === "plan"
        ? "复用 ASSESS 结果，重新规划主题和栏目。"
        : stage === "review"
          ? "复用已经生成的日报草稿，仅重新执行审核；审核不可用时不会自动发布草稿。"
          : "从候选评估开始重新执行后续阶段。",
      recommended: stage === getRecommendedDailyReportRecoveryStage(task.pipelineCheckpoint),
    })),
  ];
}

const triggerLabels: Record<TaskRunSnapshot["triggerType"], string> = {
  scheduled: "定时调度",
  manual: "手动触发",
  admin_action: "后台操作",
};

function formatDateTime(value: string | null) {
  if (!value) return "-";
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDuration(durationMs: number | null) {
  if (durationMs === null) {
    return "进行中";
  }

  if (durationMs < 1_000) {
    return `${durationMs}ms`;
  }

  if (durationMs < 60_000) {
    return `${(durationMs / 1_000).toFixed(1)}s`;
  }

  const minutes = Math.floor(durationMs / 60_000);
  const seconds = ((durationMs % 60_000) / 1_000).toFixed(1);
  return `${minutes}分 ${seconds}s`;
}

function getTaskTimelineNode(task: TaskRunSnapshot, key: NonNullable<TaskRunSnapshot["taskTimeline"]>[number]["key"]) {
  return task.taskTimeline?.find((node) => node.key === key) ?? null;
}

function findTaskTimelineMetric(
  task: TaskRunSnapshot,
  key: NonNullable<TaskRunSnapshot["taskTimeline"]>[number]["key"],
  labels: string | string[],
) {
  const node = getTaskTimelineNode(task, key);
  const labelList = Array.isArray(labels) ? labels : [labels];
  return node?.metrics.find((metric) => labelList.includes(metric.label))?.value ?? null;
}

function getTaskTimelineMetric(
  task: TaskRunSnapshot,
  key: NonNullable<TaskRunSnapshot["taskTimeline"]>[number]["key"],
  labels: string | string[],
) {
  return findTaskTimelineMetric(task, key, labels) ?? 0;
}

function parseFailureCount(progressLabel: string | null) {
  const match = progressLabel?.match(/失败\s*(\d+)\s*项/);
  return match ? Number(match[1]) : 0;
}

function parseItemFailureCount(progressLabel: string | null, sourceFailureCount: number) {
  const explicitItemFailureMatch = progressLabel?.match(/内容失败\s*(\d+)\s*项/);
  if (explicitItemFailureMatch) {
    return Number(explicitItemFailureMatch[1]);
  }

  return Math.max(0, parseFailureCount(progressLabel) - sourceFailureCount);
}

function parseSourceFailureCount(errorSummary: string | null) {
  if (!errorSummary) {
    return 0;
  }

  return errorSummary
    .split(/\s+\|\s+/)
    .filter((entry) => /RSS fetch failed/i.test(entry))
    .length;
}

function getSourceFailureCount(task: TaskRunSnapshot) {
  return findTaskTimelineMetric(task, "source_fetch", "失败源") ?? parseSourceFailureCount(task.errorSummary);
}

function buildIngestionSummaryDetail(task: TaskRunSnapshot) {
  if (task.kind !== "ingestion") {
    return null;
  }

  const sourceFailureCount = getSourceFailureCount(task);
  const itemFailureCount = parseItemFailureCount(task.progressLabel, sourceFailureCount);
  const fetched = getTaskTimelineMetric(task, "source_fetch", "抓取内容") || task.progressTotal;
  const reusedExisting = getTaskTimelineMetric(task, "rule_filter", "复用已有处理");
  const ruleFiltered = getTaskTimelineMetric(task, "rule_filter", ["命中规则过滤", "命中黑名单"]);
  const aiFiltered = getTaskTimelineMetric(task, "item_understanding", "过滤");
  const updatedExisting = findTaskTimelineMetric(task, "item_understanding", "更新/重处理");
  const accountedTotal =
    task.itemsAdded +
    aiFiltered +
    (updatedExisting ?? 0) +
    reusedExisting +
    ruleFiltered +
    itemFailureCount;
  const parts = [
    `${task.itemsAdded} (最终新增)`,
    `${aiFiltered} (AI 过滤)`,
    updatedExisting === null ? "更新/重处理暂无精确数据" : `${updatedExisting} (更新/重处理)`,
    `${reusedExisting} (重复过滤)`,
  ];

  if (ruleFiltered > 0) {
    parts.push(`${ruleFiltered} (规则过滤)`);
  }

  if (itemFailureCount > 0) {
    parts.push(`${itemFailureCount} (处理失败)`);
  }

  const leftSide = updatedExisting !== null && accountedTotal === fetched
    ? String(fetched)
    : `${accountedTotal}/${fetched} 已精确分类`;
  const sourceFailureDetail = sourceFailureCount > 0 ? `；源抓取失败 ${sourceFailureCount} 个` : "";
  return `${leftSide} = ${parts.join(" + ")}${sourceFailureDetail}`;
}

function getDailyReportCheckpointMetric(task: TaskRunSnapshot, label: string) {
  if (task.kind !== "daily_report_generate" || !task.pipelineCheckpoint) return null;
  const checkpoint = task.pipelineCheckpoint;

  const plan = checkpoint.plan as { sections?: Array<{ topics?: Array<{ candidateIds?: unknown[] }> }> } | undefined;
  if (plan && Array.isArray(plan.sections)) {
    if (label === "计划栏目") return plan.sections.length;
    if (label === "最终主题") {
      return plan.sections.reduce((total, section) => total + (section.topics?.length ?? 0), 0);
    }
    if (label === "关联候选" || label === "计划入选") {
      return plan.sections.reduce((total, section) => total + (section.topics ?? []).reduce(
        (topicTotal, topic) => topicTotal + (Array.isArray(topic.candidateIds) ? topic.candidateIds.length : 0),
        0,
      ), 0);
    }
  }

  if (label === "总候选数" && Array.isArray(checkpoint.candidateSnapshot)) {
    return checkpoint.candidateSnapshot.length;
  }
  if (label === "批次数" && Array.isArray(checkpoint.assessmentBatches)) {
    return checkpoint.assessmentBatches.length;
  }
  if (label === "可规划候选" && Array.isArray(checkpoint.planningCandidateBriefs)) {
    return checkpoint.planningCandidateBriefs.length;
  }
  if (label === "入选数") {
    const draft = checkpoint.draft as { blocks?: Array<{ items?: unknown[] }> } | undefined;
    if (draft && Array.isArray(draft.blocks)) {
      return draft.blocks.reduce((total, block) => total + (Array.isArray(block.items) ? block.items.length : 0), 0);
    }
  }
  if (label === "审核次数" && typeof checkpoint.reviewAttempts === "number") {
    return checkpoint.reviewAttempts;
  }
  if (label === "审核阻断发布") {
    return checkpoint.reviewStatus === "unavailable" || checkpoint.reviewStatus === "rejected" ? 1 : 0;
  }

  if (label === "裁剪主题" || label === "截取主题") {
    const planningAudit = checkpoint.planningAudit as { truncatedTopicCount?: unknown } | undefined;
    return typeof planningAudit?.truncatedTopicCount === "number" ? planningAudit.truncatedTopicCount : null;
  }

  if (label === "违规数" && Array.isArray(checkpoint.violations)) {
    return checkpoint.violations.length;
  }

  if (label === "批次大小" && checkpoint.data && Object.prototype.hasOwnProperty.call(checkpoint.data, "batchSize")) {
    return typeof checkpoint.data.batchSize === "number" ? checkpoint.data.batchSize : 0;
  }

  if (label === "历史重复过滤" && checkpoint.data && Object.prototype.hasOwnProperty.call(checkpoint.data, "historyFilteredCount")) {
    return typeof checkpoint.data.historyFilteredCount === "number" ? checkpoint.data.historyFilteredCount : 0;
  }

  return null;
}

function formatTaskTimelineDetail(task: TaskRunSnapshot, node: NonNullable<TaskRunSnapshot["taskTimeline"]>[number]) {
  const metricMap = new Map(node.metrics.map((metric) => [metric.label, metric.value]));
  const getValue = (label: string | string[]) => {
    const labels = Array.isArray(label) ? label : [label];
    for (const currentLabel of labels) {
      const value = metricMap.get(currentLabel);
      if (value !== undefined) {
        return value;
      }
      const checkpointValue = getDailyReportCheckpointMetric(task, currentLabel);
      if (checkpointValue !== null) {
        return checkpointValue;
      }
    }
    return 0;
  };

  switch (node.key) {
    case "daily_report_generate":
      return `总候选数 ${getValue("总候选数")}`;
    case "daily_report_prepare":
      return `候选快照 ${getValue("总候选数")}`;
    case "daily_report_assess":
      return `固定批次 ${getValue("批次大小") > 0 ? `${getValue("批次大小")} 条` : "整批"} · ${getValue("批次数")} 个 · 历史重复过滤 ${getValue("历史重复过滤")} 条`;
    case "daily_report_merge":
      return `准备 ${getValue("可规划候选")} 个候选供全局规划`;
    case "daily_report_plan":
      return `规划 ${getValue("计划栏目")} 个栏目 · 主题 ${getValue("最终主题")} 个 · 关联候选 ${getValue("关联候选")} 个 · 裁剪 ${getValue("裁剪主题")} 个`;
    case "daily_report_plan_validate":
      return `计划结构校验 · 违规 ${getValue("违规数")} 条`;
    case "daily_report_validate":
      return `草稿结构校验 · 违规 ${getValue("违规数")} 条`;
    case "daily_report_write":
      return `按计划写作 ${getValue("入选数")} 条`;
    case "daily_report_review":
      return `审核 ${getValue("审核次数")} 次 · 调用重试 ${getValue("审核调用重试")} 次 · ${
        getValue("审核阻断发布") > 0 ? "已阻断自动发布" : "未阻断自动发布"
      }`;
    case "daily_report_repair":
      return node.status === "skipped"
        ? "无违规，跳过语义修复"
        : `语义修复 ${getValue("修复次数")} 次`;
    case "daily_report_persist_publish":
      return `入选 ${getValue("入选数")} 条`;
    case "task_finished":
      return `最后入选数 ${getValue("最后入选数")}`;
    case "source_fetch": {
      const sourceFailureCount = getSourceFailureCount(task);
      const parts = [`抓取 ${getValue("抓取源")} 个源`];
      if (sourceFailureCount > 0) {
        parts.push(`失败 ${sourceFailureCount} 个源`);
      }
      parts.push(`${getValue("抓取内容")} 篇内容`, `正文补抓 ${getValue("正文补抓")} 篇`);
      return parts.join(" · ");
    }
    case "rule_filter":
      return `规则过滤 ${getValue(["命中规则过滤", "命中黑名单"])} · 复用 ${getValue("复用已有处理")}`;
    case "item_understanding":
      return `摘要 ${getValue("摘要完成")}/${getValue("摘要失败")} · 分析 ${getValue("分析完成")}/${getValue("分析失败")} · 拆分 ${getValue("拆分成功")}/${getValue("拆分失败")} · 子事件 ${getValue("子事件")} · 过滤 ${getValue("过滤")} · 更新/重处理 ${getValue("更新/重处理")}`;
    case "cluster_assignment":
      return `指纹命中 ${getValue("指纹命中")} · 本地直连 ${getValue("本地直连")} · AI归组 ${getValue("AI归组")} · 跳过 ${getValue("跳过")} · 新建 ${getValue("新建")}`;
    case "cluster_merge": {
      const parts = [
        `候选 ${getValue("候选组")}/${getValue("裁剪前")}`,
        `Dirty ${getValue("Dirty候选")}`,
        `Hash跳过 ${getValue("Hash跳过")}`,
      ];

      parts.push(
        `AI返回 ${getValue("AI返回组")}`,
        `移动 ${getValue("移动条目")}`,
        `失败 ${getValue("失败组")}`,
        getValue("跳过") ? "已跳过" : "已合并",
        `合并后 ${getValue("合并后")} 组`,
      );

      return parts.join(" · ");
    }
    case "cluster_finalize":
      return `摘要完成 ${getValue("摘要完成")} · 摘要失败 ${getValue(["摘要失败", "摘要未完成"])}`;
    default:
      return statusLabels[task.status];
  }
}

function formatTaskTimelineTitle(node: NonNullable<TaskRunSnapshot["taskTimeline"]>[number]) {
  return node.label;
}

function formatTokenCount(value: number) {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  return String(value);
}

function formatCachedTokenCount(entry: NonNullable<TaskRunSnapshot["aiCallBreakdown"]>[number]) {
  return formatTokenCount(entry.cachedTokens ?? 0);
}

const DAILY_REPORT_STAGE_KEYS: Record<string, TaskTimelineNodeKey> = {
  prepare: "daily_report_prepare",
  assess: "daily_report_assess",
  merge: "daily_report_merge",
  plan: "daily_report_plan",
  plan_validate: "daily_report_plan",
  write: "daily_report_write",
  validate: "daily_report_write",
  repair: "daily_report_write",
  review: "daily_report_review",
  persist_publish: "daily_report_persist_publish",
};

const DAILY_REPORT_STAGE_LABELS: Record<string, string> = {
  prepare: "准备候选",
  assess: "评估",
  merge: "准备规划输入",
  plan: "规划",
  plan_validate: "规划",
  write: "写作",
  validate: "写作",
  repair: "写作",
  review: "审核",
  persist_publish: "持久化/发布",
};

const INGESTION_STAGE_NODE_KEYS: Record<string, string[]> = {
  source_sync: ["source_fetch"],
  item_processing: ["rule_filter", "item_understanding", "cluster_assignment"],
  cluster_merge: ["cluster_merge"],
  cluster_finalize: ["cluster_finalize"],
};

// 单次 AI 调用的简单任务：时间线合并为一个节点，只保留关键处理信息
const SINGLE_NODE_TIMELINE_KINDS = new Set<string>([
  "item_reanalyze",
  "item_regenerate_summary",
  "item_regenerate_translation",
  "cluster_regenerate_summary",
]);

function getStageTimingStatus(timing: TaskStageTimingSnapshot): TaskTimelineNodeStatus {
  if (timing.status) return timing.status;
  return timing.finishedAt ? "succeeded" : "running";
}

function formatStageTimingDetail(timing: TaskStageTimingSnapshot) {
  return timing.detail ?? "";
}

function appendTimelineDetail(primary: string, secondary: string) {
  if (!secondary) return primary;
  return primary ? `${primary} · ${secondary}` : secondary;
}

function getSafeFinishedProgressLabel(task: TaskRunSnapshot) {
  if (task.status !== "succeeded" && task.status !== "partial" && task.status !== "failed" && task.status !== "cancelled") return "";
  const label = task.progressLabel?.trim();
  if (!label || /^步骤\s+[^：:]+[：:]/.test(label) || /^日报阶段：/.test(label) || label === "编排运行中") return "";
  return label;
}

function buildTaskTimeline(task: TaskRunSnapshot) {
  const timeline: Array<{
    key: string;
    title: string;
    time: string | null;
    detail: string;
    durationMs: number | null;
    isActive: boolean;
  }> = (task.taskTimeline ?? [])
    .filter((node) => node.key !== "task_finished" && node.key !== "daily_report_generate")
    .map((node) => ({
    key: node.key,
    title: formatTaskTimelineTitle(node),
    time: node.finishedAt ?? node.startedAt,
    detail: formatTaskTimelineDetail(task, node),
    durationMs: node.durationMs,
    isActive: node.status === "running",
  }));

  for (const stageTiming of task.stageTimings) {
    const dailyReportKey = task.kind === "daily_report_generate" ? DAILY_REPORT_STAGE_KEYS[stageTiming.key] : undefined;
    const timelineKeys = task.kind === "ingestion"
      ? INGESTION_STAGE_NODE_KEYS[stageTiming.key] ?? [stageTiming.key]
      : [dailyReportKey ?? stageTiming.key];
    const matchingNodes = timeline.filter((node) => timelineKeys.includes(node.key));
    const existing = matchingNodes[0];
    const timingDetail = formatStageTimingDetail(stageTiming);
    if (existing) {
      for (const matchedNode of matchingNodes) {
        if (timingDetail && !matchedNode.detail.includes(timingDetail)) matchedNode.detail = appendTimelineDetail(matchedNode.detail, timingDetail);
        matchedNode.time = stageTiming.finishedAt ?? stageTiming.startedAt ?? matchedNode.time;
        matchedNode.durationMs = stageTiming.durationMs;
        matchedNode.isActive = getStageTimingStatus(stageTiming) === "running";
      }
      continue;
    }

    const dailyReportDetail = dailyReportKey
      ? formatTaskTimelineDetail(task, {
          key: dailyReportKey,
          label: stageTiming.label,
          status: getStageTimingStatus(stageTiming),
          startedAt: stageTiming.startedAt,
          finishedAt: stageTiming.finishedAt,
          durationMs: stageTiming.durationMs,
          metrics: [],
        })
      : "";
    timeline.push({
      key: dailyReportKey ?? `mastra:${stageTiming.key}`,
      title: dailyReportKey ? DAILY_REPORT_STAGE_LABELS[stageTiming.key] ?? stageTiming.label : stageTiming.label,
      time: stageTiming.finishedAt ?? stageTiming.startedAt,
      detail: dailyReportDetail ? appendTimelineDetail(dailyReportDetail, timingDetail) : timingDetail,
      durationMs: stageTiming.durationMs,
      isActive: getStageTimingStatus(stageTiming) === "running",
    });
  }

  const sorted = timeline.sort((left, right) => {
    if (!left.time) return right.time ? 1 : 0;
    if (!right.time) return -1;
    return new Date(left.time).getTime() - new Date(right.time).getTime();
  });

  if (!SINGLE_NODE_TIMELINE_KINDS.has(task.kind) || sorted.length <= 1) {
    return sorted;
  }
  // 各阶段的 "AI 调用 N 次" 汇总为一条，其余细节按原顺序去重拼接
  let aiCallTotal = 0;
  let hasAiUsage = false;
  const rawDetails = sorted
    .map((node) => node.detail)
    .filter(Boolean)
    .map((detail) => detail.replace(/AI 调用 (\d+) 次/g, (_, count: string) => {
      hasAiUsage = true;
      aiCallTotal += Number(count);
      return "";
    }).split("·").map((part) => part.trim()).filter(Boolean).join(" · "));
  const details = [
    ...(hasAiUsage ? [`AI 调用 ${aiCallTotal} 次`] : []),
    ...rawDetails,
  ];
  const totalDurationMs = sorted.some((node) => node.durationMs !== null)
    ? sorted.reduce((sum, node) => sum + (node.durationMs ?? 0), 0)
    : null;
  return [{
    key: "simple_processing",
    title: "处理",
    time: sorted.map((node) => node.time).filter(Boolean).at(-1) ?? null,
    detail: [...new Set(details.filter(Boolean))].join(" · "),
    durationMs: totalDurationMs,
    isActive: sorted.some((node) => node.isActive),
  }];
}

function getStatusTone(status: BackgroundTaskRunStatus) {
  switch (status) {
    case "succeeded":
      return "success";
    case "failed":
      return "danger";
    case "running":
      return "info";
    case "cancelled":
      return "neutral";
    case "partial":
      return "warning";
    default:
      return "warning";
  }
}

function getLocalDateString(date: Date): string {
  // Use browser's local timezone and return YYYY-MM-DD format
  return date.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function filterTasks(
  tasks: TaskRunSnapshot[],
  statusFilter: TaskStatusFilter,
  kindFilter: TaskKindFilter,
  timeRangeFilter: TimeRangeFilter,
) {
  return tasks.filter((task) => {
    if (statusFilter && task.status !== statusFilter) return false;
    if (kindFilter) {
      if (task.kind !== kindFilter) return false;
    }
    if (timeRangeFilter && task.startedAt) {
      const taskDate = new Date(task.startedAt);
      const now = new Date();

      if (timeRangeFilter === "day1" || timeRangeFilter === "day3" || timeRangeFilter === "day7") {
        const rangeDays = Number(timeRangeFilter.replace("day", ""));
        if (taskDate.getTime() < now.getTime() - rangeDays * 24 * 60 * 60 * 1000) return false;
        return true;
      }

      // Get local timezone dates
      const taskLocalDate = getLocalDateString(taskDate);
      const nowLocalDate = getLocalDateString(now);

      // Parse dates for comparison
      const [taskYear, taskMonth, taskDay] = taskLocalDate.split("/").map(Number);
      const [nowYear, nowMonth, nowDay] = nowLocalDate.split("/").map(Number);

      // Calculate days difference based on local dates
      const taskLocalTime = new Date(taskYear, taskMonth - 1, taskDay).getTime();
      const nowLocalTime = new Date(nowYear, nowMonth - 1, nowDay).getTime();
      const diffDays = (nowLocalTime - taskLocalTime) / (1000 * 60 * 60 * 24);

      if (timeRangeFilter === "month" && (diffDays < 0 || diffDays > 29)) return false;
    }
    return true;
  });
}

interface TaskDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  task: TaskRunSnapshot | null;
  onRefresh?: () => void;
  isRefreshing?: boolean;
  onRetrigger?: (taskId: string) => void;
  isRetriggering?: boolean;
  onCancel?: (taskId: string) => void;
  isCancelling?: boolean;
}

function TaskDetailModal({
  isOpen,
  onClose,
  task,
  onRefresh,
  isRefreshing,
  onRetrigger,
  isRetriggering,
  onCancel,
  isCancelling,
}: TaskDetailModalProps) {
  if (!task) return null;

  const summaryDetail = buildIngestionSummaryDetail(task) || getSafeFinishedProgressLabel(task);
  const issueSummary = task.errorSummary?.trim() || getDailyReportTaskIssueSummary(task);

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      title="任务详情"
      widthClassName="max-w-5xl"
      panelClassName="flex max-h-[calc(100vh-2rem)] flex-col"
      headerClassName="border-b border-[color:var(--line)] p-6"
      bodyClassName="overflow-y-auto p-6"
      footerClassName="border-t border-[color:var(--line)] bg-[var(--bg-muted)] p-6"
      footer={
        <div className="flex justify-end gap-2">
          {task && (task.status === "running" || task.status === "queued") && onCancel && (
            <Button
              onClick={() => onCancel(task.id)}
              variant="danger"
              disabled={isCancelling}
            >
              <IconSquare className={cx("h-4 w-4 mr-1", isCancelling && "animate-pulse")} />
              停止任务
            </Button>
          )}
          {task && task.status !== "running" && task.status !== "queued" && onRetrigger && (
            <Button
              onClick={() => onRetrigger(task.id)}
              variant="secondary"
              disabled={isRetriggering}
            >
              <IconRotateCw className={cx("h-4 w-4 mr-1", isRetriggering && "animate-spin")} />
              {getTaskRetryActionLabel(task)}
            </Button>
          )}
          <Button onClick={onClose} variant="secondary">
            关闭
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {/* Basic Info */}
        <div className="rounded-lg border border-[color:var(--line)] bg-[var(--bg-muted)] p-4 text-sm text-[var(--text-2)]">
          <div className="font-medium text-[var(--text-1)] mb-2">
            {task.label}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <span className="text-[var(--text-3)]">任务ID:</span> {task.id}
            </div>
            <div>
              <span className="text-[var(--text-3)]">类型:</span>{" "}
              {getTaskKindLabel(task.kind)}
            </div>
            <div>
              <span className="text-[var(--text-3)]">触发方式:</span>{" "}
              {triggerLabels[task.triggerType]}
            </div>
            <div>
              <span className="text-[var(--text-3)]">状态:</span>{" "}
              <StatusTag tone={getStatusTone(task.status)}>
                {statusLabels[task.status]}
              </StatusTag>
            </div>
            {task.entityTitle ? (
              <div className="col-span-2 min-w-0">
                <span className="text-[var(--text-3)]">
                  {task.kind.startsWith("cluster_") ? "聚合标题:" : "条目标题:"}
                </span>{" "}
                <span className="break-words text-[var(--text-2)]">{task.entityTitle}</span>
              </div>
            ) : null}
            {task.kind === "daily_report_generate" && getDailyReportReviewStatusLabel(task) ? (
              <div>
                <span className="text-[var(--text-3)]">日报审核:</span>{" "}
                {getDailyReportReviewStatusLabel(task)}
              </div>
            ) : null}
          </div>
        </div>

        {summaryDetail || task.aiCallBreakdown?.some((entry) => entry.actual > 0 || (entry.totalTokens ?? 0) > 0) ? (
          <section className="space-y-2">
            <h4 className="text-sm font-semibold text-[var(--text-1)]">
              摘要
            </h4>
            {summaryDetail ? (
              <div className="rounded-md border border-[color:var(--line)] bg-[var(--bg-muted)] px-3 py-2 text-sm text-[var(--text-2)]">
                {summaryDetail}
              </div>
            ) : null}
            {task.aiCallBreakdown?.some((entry) => entry.actual > 0 || (entry.totalTokens ?? 0) > 0) ? (
              <div className="overflow-x-auto rounded-md border border-[color:var(--line)] bg-[var(--bg-muted)]">
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-[color:var(--line)] text-xs text-[var(--text-3)]">
                      <th className="px-3 py-2 font-medium">用途</th>
                      <th className="px-3 py-2 font-medium">模型</th>
                      <th className="px-3 py-2 font-medium">调用</th>
                      <th className="px-3 py-2 font-medium">输入 tokens</th>
                      <th className="px-3 py-2 font-medium">输出 tokens</th>
                      <th className="px-3 py-2 font-medium">缓存 tokens</th>
                      <th className="px-3 py-2 font-medium">总 tokens</th>
                      <th className="px-3 py-2 font-medium">统计来源</th>
                    </tr>
                  </thead>
                  <tbody>
                    {task.aiCallBreakdown
                      .filter((entry) => entry.actual > 0 || (entry.totalTokens ?? 0) > 0)
                      .map((entry) => (
                        <tr key={entry.key} className="border-b border-[color:var(--line)] last:border-0">
                          <td className="px-3 py-2 text-[var(--text-1)]">{entry.label}</td>
                          <td className="px-3 py-2 text-[var(--text-2)]">{entry.modelNames?.join("、") || "未提供"}</td>
                          <td className="px-3 py-2 text-[var(--text-2)]">
                            {entry.estimated > 0 ? `${entry.actual} / ${entry.estimated}` : entry.actual}
                          </td>
                          <td className="px-3 py-2 text-[var(--text-2)]">{formatTokenCount(entry.promptTokens ?? 0)}</td>
                          <td className="px-3 py-2 text-[var(--text-2)]">{formatTokenCount(entry.completionTokens ?? 0)}</td>
                          <td className="px-3 py-2 text-[var(--text-2)]">{formatCachedTokenCount(entry)}</td>
                          <td className="px-3 py-2 text-[var(--text-2)]">{formatTokenCount(entry.totalTokens ?? 0)}</td>
                          <td className="px-3 py-2 text-[var(--text-2)]">
                            {entry.tokenUsageSource === "provider"
                              ? "模型返回"
                              : entry.tokenUsageSource === "mixed"
                                ? "混合"
                                : "估算"}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </section>
        ) : null}

        {/* Timeline */}
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <h4 className="text-sm font-semibold text-[var(--text-1)]">
              时间线
            </h4>
            {onRefresh ? (
              <IconButton
                onClick={onRefresh}
                variant="secondary"
                size="sm"
                title="刷新进度"
                disabled={isRefreshing}
              >
                <IconRotateCw className={cx("h-4 w-4", isRefreshing && "animate-spin")} />
              </IconButton>
            ) : null}
          </div>
          <div className="space-y-3">
            {buildTaskTimeline(task).length === 0 ? (
              <div className="rounded-md border border-[color:var(--line)] bg-[var(--bg-muted)] px-3 py-2 text-sm text-[var(--text-3)]">
                暂无时间线数据
              </div>
            ) : buildTaskTimeline(task).map((entry, index, entries) => (
              <div key={entry.key} className="flex gap-3">
                <div className="relative flex w-5 justify-center">
                  <span
                    className={cx(
                      "mt-1 h-2.5 w-2.5 rounded-full border-2",
                      entry.isActive
                        ? "border-[var(--accent)] bg-[var(--accent)]"
                        : "border-[color:var(--line-strong)] bg-[var(--surface)]",
                    )}
                  />
                  {index < entries.length - 1 ? (
                    <span className="absolute top-4 h-[calc(100%+0.25rem)] w-px bg-[color:var(--line)]" />
                  ) : null}
                </div>
                <div className="min-w-0 flex-1 rounded-md border border-[color:var(--line)] bg-[var(--bg-muted)] px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-medium text-[var(--text-1)]">
                        {entry.title}
                      </span>
                      {entry.durationMs !== null ? (
                        <span className="shrink-0 text-xs text-[var(--text-3)]">
                          耗时 {formatDuration(entry.durationMs)}
                        </span>
                      ) : null}
                    </div>
                    <span className="shrink-0 text-xs text-[var(--text-3)]">
                      {formatDateTime(entry.time)}
                    </span>
                  </div>
                  {entry.detail ? (
                    <div className="mt-1 text-sm text-[var(--text-2)]">
                      {entry.detail}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Error */}
        {issueSummary && (
          <div className="space-y-2">
            <h4 className="text-sm font-semibold text-[var(--danger-ink)]">
              错误信息
            </h4>
            <div className="rounded-md border border-[var(--danger-line)] bg-[var(--danger-surface)] p-3 text-sm text-[var(--danger-ink)]">
              {issueSummary}
            </div>
          </div>
        )}
      </div>
    </ModalShell>
  );
}

interface TaskMonitorPanelProps {
  runningTasks?: TaskRunSnapshot[];
  recentTasks?: TaskRunSnapshot[];
  initialFocusTaskId?: string | null;
  initialPage?: number | null;
  initialPageSize?: number | null;
  initialStatusFilter?: TaskStatusFilter | null;
  initialKindFilter?: TaskKindFilter | null;
  initialTimeRangeFilter?: TimeRangeFilter | null;
  onDetailRouteChange?: (taskId: string | null, state: { page: number; pageSize: number }) => void;
}

function isTaskMonitorSnapshot(value: unknown): value is BackgroundTaskMonitorSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }

  return "schedule" in value && "runningTasks" in value && "recentTasks" in value;
}

export function TaskMonitorPanel({
  runningTasks = [],
  recentTasks = [],
  initialFocusTaskId = null,
  initialPage = null,
  initialPageSize = null,
  initialStatusFilter = null,
  initialKindFilter = null,
  initialTimeRangeFilter = null,
  onDetailRouteChange,
}: TaskMonitorPanelProps) {
  const { showToast } = useToast();
  const [taskLists, setTaskLists] = useState(() => ({
    runningTasks,
    recentTasks,
  }));
  const [statusFilter, setStatusFilter] = useState<TaskStatusFilter>(initialStatusFilter ?? "");
  const [kindFilter, setKindFilter] = useState<TaskKindFilter>(initialKindFilter ?? "");
  const [timeRangeFilter, setTimeRangeFilter] = useState<TimeRangeFilter>(initialTimeRangeFilter ?? "");
  const [page, setPage] = useState(initialPage ?? 1);
  const [pageSize, setPageSize] = useState(initialPageSize ?? 10);
  const [recentTotal, setRecentTotal] = useState(0);
  const [isRefreshingSnapshot, setIsRefreshingSnapshot] = useState(
    runningTasks.length === 0 && recentTasks.length === 0,
  );
  const [selectedTask, setSelectedTask] = useState<TaskRunSnapshot | null>(
    null
  );
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [retriggeringTaskId, setRetriggeringTaskId] = useState<string | null>(
    null
  );
  const [cancellingTaskId, setCancellingTaskId] = useState<string | null>(
    null
  );
  const [confirmTask, setConfirmTask] = useState<TaskRunSnapshot | null>(null);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<"retrigger" | "cancel">("retrigger");
  const [recoveryTask, setRecoveryTask] = useState<TaskRunSnapshot | null>(null);
  const [recoveryChoice, setRecoveryChoice] = useState<DailyReportRetryChoice>("all");
  const [isRecoveryOpen, setIsRecoveryOpen] = useState(false);
  const pendingRouteTaskIdRef = useRef<string | null>(null);

  const allTasks = useMemo(() => {
    // Merge and deduplicate by task id (runningTasks takes precedence)
    const taskMap = new Map<string, TaskRunSnapshot>();
    for (const task of taskLists.recentTasks) {
      taskMap.set(task.id, task);
    }
    for (const task of taskLists.runningTasks) {
      taskMap.set(task.id, task);
    }
    return Array.from(taskMap.values());
  }, [taskLists]);

  const recoveryOptions = getDailyReportRetryOptions(recoveryTask);
  const detailLoadingTaskIdsRef = useRef(new Set<string>());

  const loadTaskDetail = useCallback(async (taskId: string) => {
    try {
      const response = await fetch(`/api/admin/monitor/tasks/${taskId}`);
      const payload = (await response.json()) as { task?: TaskRunSnapshot; error?: string };
      if (!response.ok || !payload.task) {
        showToast(payload.error || "加载任务详情失败", "error");
        return null;
      }
      return payload.task;
    } catch {
      showToast("加载任务详情失败", "error");
      return null;
    }
  }, [showToast]);

  useEffect(() => {
    if (!selectedTask) {
      return;
    }

    const latestSelectedTask = allTasks.find((task) => task.id === selectedTask.id);
    if (latestSelectedTask && latestSelectedTask !== selectedTask && selectedTask.isDetailLoaded !== true) {
      setSelectedTask(latestSelectedTask);
    }
  }, [allTasks, selectedTask]);

  useEffect(() => {
    if (!isDetailOpen || !selectedTask || selectedTask.isDetailLoaded !== false) {
      return;
    }
    if (detailLoadingTaskIdsRef.current.has(selectedTask.id)) {
      return;
    }

    detailLoadingTaskIdsRef.current.add(selectedTask.id);
    void loadTaskDetail(selectedTask.id).then((detail) => {
      if (detail) setSelectedTask(detail);
    }).finally(() => {
      detailLoadingTaskIdsRef.current.delete(selectedTask.id);
    });
  }, [isDetailOpen, loadTaskDetail, selectedTask]);

  useEffect(() => {
    if (initialFocusTaskId === pendingRouteTaskIdRef.current) {
      pendingRouteTaskIdRef.current = null;
    }

    if (!initialFocusTaskId) {
      if (pendingRouteTaskIdRef.current) {
        return;
      }
      if (isDetailOpen) {
        setIsDetailOpen(false);
        setSelectedTask(null);
      }
      return;
    }

    const initialTask = allTasks.find((task) => task.id === initialFocusTaskId);
    if (!initialTask) {
      return;
    }

    if (selectedTask?.id !== initialTask.id || !isDetailOpen) {
      // Don't re-open if the user just manually closed the modal
      if (closedByUserRef.current) {
        closedByUserRef.current = false;
        return;
      }
      setSelectedTask(initialTask);
      setIsDetailOpen(true);
    }
  }, [allTasks, initialFocusTaskId, isDetailOpen, selectedTask?.id]);

  const visibleRecentTasks = useMemo(
    () => filterTasks(taskLists.recentTasks, statusFilter, kindFilter, timeRangeFilter),
    [kindFilter, statusFilter, taskLists.recentTasks, timeRangeFilter],
  );

  // recentTotal from the API already counts all tasks (including running).
  const mergedTotal = recentTotal;
  const totalPages = Math.ceil(mergedTotal / pageSize) || 1;
  // The API returns the current page in recentTasks. runningTasks is kept for
  // detail updates, but must not be merged into every page.
  const paginatedTasks = visibleRecentTasks;

  const hasFilters = statusFilter || kindFilter || timeRangeFilter;

  const refreshSnapshot = useCallback(async () => {
    setIsRefreshingSnapshot(true);

    try {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("pageSize", String(pageSize));
      if (statusFilter) {
        params.set("status", statusFilter);
      }
      if (kindFilter) {
        params.set("kind", kindFilter);
      }
      if (timeRangeFilter) {
        if (timeRangeFilter === "day1" || timeRangeFilter === "day3" || timeRangeFilter === "day7") {
          params.set("rangeDays", timeRangeFilter.replace("day", ""));
        } else {
          params.set("timeRange", timeRangeFilter);
        }
      }

      const response = await fetch(`/api/admin/monitor?${params.toString()}`);
      const payload = (await response.json()) as BackgroundTaskMonitorSnapshot | { error?: string };

      if (!response.ok || !isTaskMonitorSnapshot(payload)) {
        showToast(
          "error" in payload && payload.error ? payload.error : "刷新任务监控失败",
          "error",
        );
        return;
      }

      setTaskLists({
        runningTasks: payload.runningTasks,
        recentTasks: payload.recentTasks,
      });
      setRecentTotal(payload.recentTotal ?? 0);
    } catch {
      showToast("刷新任务监控失败", "error");
    } finally {
      setIsRefreshingSnapshot(false);
    }
  }, [kindFilter, page, pageSize, showToast, statusFilter, timeRangeFilter]);

  // Fetch on mount and whenever page/filter state changes
  useEffect(() => {
    void refreshSnapshot();
  }, [refreshSnapshot]);

  const handleRefresh = async () => {
    setIsRefreshingSnapshot(true);
    try {
      await refreshSnapshot();
      if (selectedTask?.isDetailLoaded) {
        const detail = await loadTaskDetail(selectedTask.id);
        if (detail) setSelectedTask(detail);
      }
    } finally {
      setIsRefreshingSnapshot(false);
    }
  };

  const handleClearFilters = () => {
    setStatusFilter("");
    setKindFilter("");
    setTimeRangeFilter("");
    setPage(1);
  };

  const handleOpenRecovery = async (task: TaskRunSnapshot) => {
    const detail = task.isDetailLoaded === false ? await loadTaskDetail(task.id) : task;
    if (!detail) return;
    const options = getDailyReportRetryOptions(detail);
    const recommended = options.find((option) => option.recommended);
    setRecoveryTask(detail);
    setRecoveryChoice(recommended?.value ?? "all");
    setIsRecoveryOpen(true);
  };

  const handleCloseRecovery = () => {
    setIsRecoveryOpen(false);
    setRecoveryTask(null);
    setRecoveryChoice("all");
  };

  const handleOpenConfirm = (task: TaskRunSnapshot, action: "retrigger" | "cancel") => {
    if (action === "retrigger" && task.kind === "daily_report_generate") {
      void handleOpenRecovery(task);
      return;
    }
    setConfirmTask(task);
    setConfirmAction(action);
    setIsConfirmOpen(true);
  };

  const handleCloseConfirm = () => {
    setIsConfirmOpen(false);
    setConfirmTask(null);
  };

  const handleConfirmAction = () => {
    if (!confirmTask) return;
    if (confirmAction === "retrigger") {
      void handleLegacyRetrigger(confirmTask.id);
    } else {
      void handleCancel(confirmTask.id);
    }
    handleCloseConfirm();
  };

  const handleOpenDetail = (task: TaskRunSnapshot) => {
    pendingRouteTaskIdRef.current = task.id;
    setSelectedTask(task);
    setIsDetailOpen(true);
    onDetailRouteChange?.(task.id, { page, pageSize });
  };

  const closedByUserRef = useRef(false);

  const handleCloseDetail = () => {
    closedByUserRef.current = true;
    pendingRouteTaskIdRef.current = null;
    setIsDetailOpen(false);
    onDetailRouteChange?.(null, { page, pageSize });
  };

  // Defer clearing the selected task until the modal has fully unmounted.
  // Clearing it simultaneously with isOpen causes the scrollable body content
  // to vanish before the overlay, producing a visible jump/flash.
  useEffect(() => {
    if (!isDetailOpen) {
      setSelectedTask(null);
    }
  }, [isDetailOpen]);

  const handleLegacyRetrigger = async (taskId: string) => {
    setRetriggeringTaskId(taskId);
    const targetTask = allTasks.find((task) => task.id === taskId) ?? null;
    const actionLabel = getTaskRetryActionLabel(targetTask);

    try {
      const response = await fetch(`/api/admin/monitor/tasks/${taskId}/retrigger`, {
        method: "POST",
      });

      const data = await response.json();

      if (!response.ok || data.error) {
        showToast(data.error || "重新触发任务失败", "error");
        return;
      }

      showToast(`任务已${actionLabel}`, "success");

      // Refresh the task list after a short delay
      setTimeout(() => {
        void refreshSnapshot();
      }, 500);
    } catch {
      showToast("重新触发任务失败", "error");
    } finally {
      setRetriggeringTaskId(null);
    }
  };

  const handleRetrigger = (taskId: string) => {
    const targetTask = allTasks.find((task) => task.id === taskId) ?? null;
    if (targetTask?.kind === "daily_report_generate") {
      void handleOpenRecovery(targetTask);
      return;
    }
    void handleLegacyRetrigger(taskId);
  };

  const handleSubmitRecovery = async () => {
    if (!recoveryTask) return;
    const taskId = recoveryTask.id;
    setRetriggeringTaskId(taskId);

    try {
      const response = await fetch(`/api/admin/monitor/tasks/${taskId}/retrigger`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retryFrom: recoveryChoice }),
      });
      const data = await response.json();

      if (!response.ok || data.error) {
        showToast(data.error || "重新触发任务失败", "error");
        return;
      }

      showToast(recoveryChoice === "all" ? "任务已全部重试" : `任务已从 ${DAILY_REPORT_RECOVERY_STAGE_LABELS[recoveryChoice]} 继续`, "success");
      handleCloseRecovery();
      setTimeout(() => {
        void refreshSnapshot();
      }, 500);
    } catch {
      showToast("重新触发任务失败", "error");
    } finally {
      setRetriggeringTaskId(null);
    }
  };

  const handleCancel = async (taskId: string) => {
    setCancellingTaskId(taskId);

    try {
      const response = await fetch(`/api/admin/monitor/tasks/${taskId}/cancel`, {
        method: "POST",
      });

      const data = await response.json();

      if (!response.ok || data.error) {
        showToast(data.error || "停止任务失败", "error");
        return;
      }

      showToast("任务已停止", "success");

      // Refresh the task list after a short delay
      setTimeout(() => {
        void refreshSnapshot();
      }, 500);
    } catch {
      showToast("停止任务失败", "error");
    } finally {
      setCancellingTaskId(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold text-[var(--foreground)]">
            任务监控
          </h2>
          <p className="text-sm text-[var(--muted)]">
            查看和管理后台任务运行状态
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={handleClearFilters}
            variant="secondary"
            disabled={!hasFilters}
          >
            清空筛选
          </Button>
          <Button
            onClick={handleRefresh}
            variant="secondary"
            disabled={isRefreshingSnapshot}
          >
            刷新
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <FilterSelect
          label="状态"
          value={statusFilter}
          onChange={(value) => {
            setStatusFilter(value as TaskStatusFilter);
            setPage(1);
          }}
          options={statusOptions}
          showSearch={false}
        />
        <FilterSelect
          label="任务类型"
          value={kindFilter}
          onChange={(value) => {
            setKindFilter(value as TaskKindFilter);
            setPage(1);
          }}
          options={kindOptions}
          showSearch={false}
        />
        <FilterSelect
          label="开始时间"
          value={timeRangeFilter}
          onChange={(value) => {
            setTimeRangeFilter(value as TimeRangeFilter);
            setPage(1);
          }}
          options={timeRangeOptions}
          showSearch={false}
        />
      </div>

      {/* Task List */}
      {isRefreshingSnapshot ? (
        <EmptyState>加载中...</EmptyState>
      ) : paginatedTasks.length === 0 ? (
        <EmptyState>{hasFilters ? "暂无匹配任务" : "暂无任务"}</EmptyState>
      ) : (
        <div className="w-full overflow-x-auto">
          <table className="w-full table-auto text-sm">
            <thead className="bg-[var(--bg-muted)] text-[var(--muted)]">
              <tr>
                <th className="w-[25%] text-left px-4 py-3">任务</th>
                <th className="w-[12%] whitespace-nowrap text-left px-4 py-3">
                  状态
                </th>
                <th className="w-[15%] whitespace-nowrap text-left px-4 py-3">
                  类型
                </th>
                <th className="w-[20%] whitespace-nowrap text-left px-4 py-3">
                  时间
                </th>
                <th className="w-[15%] whitespace-nowrap text-right px-4 py-3">
                  操作
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--line)]">
              {paginatedTasks.map((task) => (
                <tr
                  key={task.id}
                  className="hover:bg-[var(--bg-muted)] transition-colors"
                >
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => handleOpenDetail(task)}
                      className="w-full text-left group"
                    >
                      <div className="font-medium text-[var(--foreground)] group-hover:text-[var(--accent)] transition-colors">
                        {task.label}
                      </div>
                      <div className="text-xs text-[var(--muted)]">
                        #{task.id.slice(0, 8)}
                      </div>
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <StatusTag tone={getStatusTone(task.status)}>
                      {statusLabels[task.status]}
                    </StatusTag>
                  </td>
                  <td className="px-4 py-3 text-[var(--text-2)]">
                    {getTaskKindLabel(task.kind)}
                  </td>
                  <td className="px-4 py-3 text-[var(--text-3)] text-xs">
                    <div>开始: {formatDateTime(task.startedAt)}</div>
                    {task.finishedAt && (
                      <div>完成: {formatDateTime(task.finishedAt)}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {task.status === "running" || task.status === "queued" ? (
                        <IconButton
                          onClick={() => handleOpenConfirm(task, "cancel")}
                          variant="ghost"
                          size="sm"
                          title="停止任务"
                          disabled={cancellingTaskId === task.id}
                        >
                          <IconSquare className={cx("h-4 w-4", cancellingTaskId === task.id && "animate-pulse")} />
                        </IconButton>
                      ) : (
                        <IconButton
                          onClick={() => handleOpenConfirm(task, "retrigger")}
                          variant="ghost"
                          size="sm"
                          title={getTaskRetryActionLabel(task)}
                          disabled={retriggeringTaskId === task.id}
                        >
                          <IconRotateCw className={cx("h-4 w-4", retriggeringTaskId === task.id && "animate-spin")} />
                        </IconButton>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {mergedTotal > 0 && (
        <PaginationControls
          totalItems={mergedTotal}
          page={page}
          totalPages={totalPages}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={(nextPageSize) => {
            setPageSize(nextPageSize);
            setPage(1);
          }}
        />
      )}

      {/* Detail Modal */}
      <TaskDetailModal
        isOpen={isDetailOpen}
        onClose={handleCloseDetail}
        task={selectedTask}
        onRefresh={handleRefresh}
        isRefreshing={isRefreshingSnapshot}
        onRetrigger={handleRetrigger}
        isRetriggering={retriggeringTaskId === selectedTask?.id}
        onCancel={handleCancel}
        isCancelling={cancellingTaskId === selectedTask?.id}
      />

      {/* Daily report recovery modal */}
      <ModalShell
        isOpen={isRecoveryOpen}
        onClose={handleCloseRecovery}
        title="选择日报重试方式"
        widthClassName="max-w-lg"
        headerClassName="border-b border-[color:var(--line)] p-4"
        bodyClassName="p-4"
        footerClassName="border-t border-[color:var(--line)] bg-[var(--bg-muted)] p-4"
        footer={
          <div className="flex justify-end gap-2">
            <Button onClick={handleCloseRecovery} variant="secondary">
              取消
            </Button>
            <Button onClick={() => void handleSubmitRecovery()} variant="primary" disabled={retriggeringTaskId === recoveryTask?.id}>
              {retriggeringTaskId === recoveryTask?.id ? "提交中..." : "确认重试"}
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-[var(--text-2)]">
            {recoveryTask?.label}：请选择重新执行范围。
          </p>
          <div className="space-y-2">
            <SelectField
              id="daily-report-recovery"
              aria-label="日报重试方式"
              value={recoveryChoice}
              options={recoveryOptions.map((option) => ({ value: option.value, label: option.label }))}
              showSearch={false}
              onChange={(value) => setRecoveryChoice(String(value) as DailyReportRetryChoice)}
            />
          </div>
        </div>
      </ModalShell>

      {/* Confirm Modal */}
      <ModalShell
        isOpen={isConfirmOpen}
        onClose={handleCloseConfirm}
        title={confirmAction === "retrigger" ? `确认${getTaskRetryActionLabel(confirmTask)}` : "确认停止任务"}
        widthClassName="max-w-md"
        headerClassName="border-b border-[color:var(--line)] p-4"
        bodyClassName="p-4"
        footerClassName="border-t border-[color:var(--line)] bg-[var(--bg-muted)] p-4"
        footer={
          <div className="flex justify-end gap-2">
            <Button onClick={handleCloseConfirm} variant="secondary">
              取消
            </Button>
            <Button
              onClick={handleConfirmAction}
              variant={confirmAction === "cancel" ? "danger" : "primary"}
            >
              {confirmAction === "retrigger" ? getTaskRetryActionLabel(confirmTask) : "停止任务"}
            </Button>
          </div>
        }
      >
        <p className="text-sm text-[var(--text-2)]">
          {confirmAction === "retrigger"
            ? `确定要${getTaskRetryActionLabel(confirmTask)}任务 "${confirmTask?.label}" 吗？`
            : `确定要停止任务 "${confirmTask?.label}" 吗？`}
        </p>
      </ModalShell>
    </div>
  );
}
