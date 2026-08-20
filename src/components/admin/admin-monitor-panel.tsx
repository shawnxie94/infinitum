"use client";
import type { ReactNode } from "react";
import { useEffect, useRef, useState, useTransition } from "react";

import { PageShell } from "@/components/ui/page-shell";
import { useToast } from "@/components/ui/toast";
import { StatusBanner } from "@/components/ui/status-banner";
import {
  MAX_AGGREGATION_SPLIT_MAX_EVENTS,
  MAX_FULL_TEXT_FETCH_THRESHOLD,
  MAX_SOURCE_CONCURRENCY,
  MIN_AGGREGATION_SPLIT_MAX_EVENTS,
  MIN_FULL_TEXT_FETCH_THRESHOLD,
  MIN_SOURCE_CONCURRENCY,
  MAX_PER_SOURCE_ITEM_LIMIT,
  MIN_PER_SOURCE_ITEM_LIMIT,
} from "@/lib/tasks/scheduler";
import type {
  BackgroundTaskMonitorSnapshot,
  TaskRunSnapshot,
} from "@/lib/tasks/types";
import { cx } from "@/lib/ui/cx";

type AdminMonitorPanelProps = {
  initialSnapshot: BackgroundTaskMonitorSnapshot;
  embedMode?: boolean;
  showSchedule?: boolean;
  showScheduleOnly?: boolean;
};

type SchedulePayload = {
  error?: string;
  schedule?: BackgroundTaskMonitorSnapshot["schedule"];
};

type CancelPayload = {
  error?: string;
  task?: BackgroundTaskMonitorSnapshot["runningTasks"][number];
};

const triggerTypeLabels = {
  admin_action: "后台操作",
  manual: "手动触发",
  scheduled: "定时调度",
} as const;

const statusLabels = {
  cancelled: "已取消",
  failed: "失败",
  partial: "部分成功",
  queued: "已排队",
  running: "运行中",
  succeeded: "已成功",
} as const;

const taskKindLabels = {
  cluster_merge_precompute_clean_pairs: "合并候选预计算",
  cluster_regenerate_summary: "聚合摘要重生成",
  daily_report_generate: "AI 日报生成",
  ingestion: "抓取任务",
  precompute: "预计算",
  item_reanalyze: "内容重分析",
  item_processing_recovery: "抓取失败补偿",
  item_regenerate_summary: "摘要重生成",
  item_regenerate_translation: "译文重生成",
  item_cleanup: "文章自动清理",
  item_reparse_aggregations: "聚合内容重拆",
} as const;

function getTaskKindLabel(kind: string) {
  return taskKindLabels[kind as keyof typeof taskKindLabels] ?? kind;
}

const surfaceCardClassName =
  "rounded-[1.35rem] border border-[color:var(--line)] bg-[color-mix(in_srgb,var(--surface)_95%,transparent)] shadow-[var(--shadow-sm)]";
const subtleCardClassName =
  "rounded-[1rem] border border-[color:var(--line)] bg-[var(--surface-muted)] shadow-[var(--shadow-sm)]";
const primaryButtonClassName =
  "inline-flex min-h-10 items-center justify-center rounded-xl bg-[var(--accent)] px-3.5 py-2.5 text-sm font-semibold text-white shadow-[0_14px_28px_rgba(37,99,235,0.18)] transition hover:bg-[var(--accent-strong)] disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:bg-[var(--accent)]";
const secondaryButtonClassName =
  "inline-flex min-h-10 items-center justify-center rounded-xl border border-[color:var(--line)] bg-[var(--surface)] px-3.5 py-2.5 text-sm font-medium text-[var(--foreground)] shadow-[var(--shadow-sm)] transition hover:bg-[var(--surface-muted)] disabled:cursor-not-allowed disabled:opacity-55";
const inputClassName =
  "min-h-10 rounded-xl border border-[color:var(--line)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--foreground)] outline-none transition placeholder:text-[var(--muted)] focus:border-[color:var(--accent)] focus:ring-2 focus:ring-[color:var(--accent-soft)]";
const chipBaseClassName =
  "inline-flex items-center rounded-full border px-2.5 py-1 font-mono text-[11px] font-medium uppercase tracking-[0.18em]";
function formatDateTime(value: string | null) {
  if (!value) {
    return "暂无";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Shanghai",
  }).format(new Date(value));
}

function toDateTimeLocalValue(value: string | null | undefined) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const offsetDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return offsetDate.toISOString().slice(0, 16);
}

function toIsoDateTimeOrNull(value: string) {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function getAiCallLabel(task: TaskRunSnapshot) {
  if (task.aiCallCountActual <= 0 && task.aiCallCountEstimated <= 0) {
    return null;
  }

  const countLabel = task.aiCallCountEstimated > 0
    ? `AI 调用：${task.aiCallCountActual} / ${task.aiCallCountEstimated}`
    : `AI 调用：${task.aiCallCountActual}`;
  const totalTokens = (task.aiCallBreakdown ?? []).reduce(
    (sum, entry) => sum + (entry.totalTokens ?? 0),
    0,
  );
  return totalTokens > 0 ? `${countLabel} · 上下文 ${formatTokenCount(totalTokens)}` : countLabel;
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

function isMonitorSnapshot(
  value: unknown,
): value is BackgroundTaskMonitorSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }

  return (
    "schedule" in value && "runningTasks" in value && "recentTasks" in value
  );
}

async function readJson<T>(response: Response) {
  return (await response.json()) as T;
}

function TaskFact({ label, value }: { label: string; value: string }) {
  return (
    <div className={cx(subtleCardClassName, "p-3")}>
      <p className="font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-[var(--muted)]">
        {label}
      </p>
      <p className="mt-2 text-sm leading-6 text-[var(--foreground)]">{value}</p>
    </div>
  );
}

function TaskToneBadge({
  children,
  tone,
}: {
  children: ReactNode;
  tone: "accent" | "danger" | "muted" | "success" | "warning";
}) {
  const toneClassName = {
    accent:
      "border-[color:var(--accent-soft)] bg-[var(--accent-soft)] text-[var(--accent-strong)]",
    danger:
      "border-[color:var(--danger-line)] bg-[var(--danger-surface)] text-[var(--danger-ink)]",
    muted: "border-[color:var(--line)] bg-[var(--surface)] text-[var(--muted)]",
    success:
      "border-[color:var(--success-line)] bg-[var(--success-surface)] text-[var(--success-ink)]",
    warning:
      "border-[color:var(--warning-line)] bg-[var(--warning-surface)] text-[var(--warning-ink)]",
  } as const;

  return (
    <span className={cx(chipBaseClassName, toneClassName[tone])}>
      {children}
    </span>
  );
}

function TaskCard({
  cancellable,
  cancellingTaskId,
  emphasis = "normal",
  emptyProgressLabel,
  onCancel,
  task,
}: {
  cancellable: boolean;
  cancellingTaskId: string | null;
  emphasis?: "normal" | "strong";
  emptyProgressLabel: string;
  onCancel: (taskId: string) => Promise<void>;
  task: TaskRunSnapshot;
}) {
  const statusTone =
    task.status === "failed"
      ? "danger"
      : task.status === "running"
        ? "accent"
        : task.status === "succeeded"
          ? "success"
          : task.status === "partial"
            ? "warning"
            : "muted";

  return (
    <article
      className={cx(
        "overflow-hidden rounded-[1.15rem] border p-4 shadow-[var(--shadow-sm)] sm:p-5",
        emphasis === "strong"
          ? "border-[color:var(--line-strong)] bg-[color-mix(in_srgb,var(--surface)_95%,transparent)]"
          : "border-[color:var(--line)] bg-[var(--surface)]",
      )}
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-4">
          <div className="space-y-3">
            <h3 className="text-lg font-semibold tracking-[-0.03em] text-[var(--foreground)]">
              {task.label}
            </h3>
            <div className="flex flex-wrap gap-2">
              <TaskToneBadge tone="muted">
                {triggerTypeLabels[task.triggerType]}
              </TaskToneBadge>
              <TaskToneBadge tone={statusTone}>
                {statusLabels[task.status]}
              </TaskToneBadge>
              <TaskToneBadge tone="muted">
                {getTaskKindLabel(task.kind)}
              </TaskToneBadge>
              {task.cancelRequestedAt ? (
                <TaskToneBadge tone="warning">终止请求已提交</TaskToneBadge>
              ) : null}
            </div>
          </div>

          <p className="text-sm leading-6 text-[var(--foreground)]">
            {task.progressLabel ?? emptyProgressLabel}
          </p>
        </div>

        {cancellable ? (
          <button
            className={secondaryButtonClassName}
            type="button"
            disabled={
              Boolean(task.cancelRequestedAt) || cancellingTaskId === task.id
            }
            onClick={() => void onCancel(task.id)}
          >
            {task.cancelRequestedAt ? "终止中" : "终止任务"}
          </button>
        ) : null}
      </div>

      <div className="mt-4 grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <TaskFact
          label="AI Calls"
          value={getAiCallLabel(task) ?? "AI 调用：0"}
        />
        <TaskFact label="Started" value={formatDateTime(task.startedAt)} />
        <TaskFact label="Finished" value={formatDateTime(task.finishedAt)} />
        <TaskFact label="Task ID" value={task.id} />
      </div>

      {task.errorSummary ? (
        <StatusBanner className="mt-4 rounded-[1rem] px-4 py-3" tone="error">
          {task.errorSummary}
        </StatusBanner>
      ) : null}
    </article>
  );
}

export function AdminMonitorPanel({
  initialSnapshot,
  embedMode,
  showSchedule = true,
  showScheduleOnly = false,
}: AdminMonitorPanelProps) {
  const { showToast } = useToast();
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [enabled, setEnabled] = useState(initialSnapshot.schedule.enabled);
  const [cronExpression, setCronExpression] = useState(
    initialSnapshot.schedule.cronExpression,
  );
  const [sourceConcurrency, setSourceConcurrency] = useState(
    String(initialSnapshot.schedule.sourceConcurrency),
  );
  const [fullTextFetchThreshold, setFullTextFetchThreshold] = useState(
    String(initialSnapshot.schedule.fullTextFetchThreshold),
  );
  const [perSourceItemLimit, setPerSourceItemLimit] = useState(
    String(initialSnapshot.schedule.perSourceItemLimit),
  );
  const [aggregationSplitMaxEvents, setAggregationSplitMaxEvents] = useState(
    String(initialSnapshot.schedule.aggregationSplitMaxEvents),
  );
  const [processingStartAt, setProcessingStartAt] = useState(
    toDateTimeLocalValue(initialSnapshot.schedule.processingStartAt),
  );
  const [isPending, startTransition] = useTransition();
  const [cancellingTaskId, setCancellingTaskId] = useState<string | null>(null);
  const isScheduleDirtyRef = useRef(false);
  const hasShownRefreshErrorRef = useRef(false);
  const isScheduleDirty =
    enabled !== snapshot.schedule.enabled ||
    cronExpression.trim() !== snapshot.schedule.cronExpression ||
    sourceConcurrency.trim() !== String(snapshot.schedule.sourceConcurrency) ||
    fullTextFetchThreshold.trim() !== String(snapshot.schedule.fullTextFetchThreshold) ||
    perSourceItemLimit.trim() !== String(snapshot.schedule.perSourceItemLimit) ||
    aggregationSplitMaxEvents.trim() !== String(snapshot.schedule.aggregationSplitMaxEvents) ||
    processingStartAt.trim() !== toDateTimeLocalValue(snapshot.schedule.processingStartAt);

  isScheduleDirtyRef.current = isScheduleDirty;

  useEffect(() => {
    let disposed = false;

    const refreshSnapshot = async () => {
      try {
        const response = await fetch("/api/admin/monitor");
        const payload = await readJson<
          BackgroundTaskMonitorSnapshot | { error?: string }
        >(response);

        if (disposed) {
          return;
        }

        if (!response.ok || !isMonitorSnapshot(payload)) {
          if (!hasShownRefreshErrorRef.current) {
            showToast("任务监控刷新失败。", "error");
            hasShownRefreshErrorRef.current = true;
          }
          return;
        }

        setSnapshot(payload);
        hasShownRefreshErrorRef.current = false;

        if (!isScheduleDirtyRef.current) {
          setEnabled(payload.schedule.enabled);
          setCronExpression(payload.schedule.cronExpression);
          setSourceConcurrency(String(payload.schedule.sourceConcurrency));
          setFullTextFetchThreshold(String(payload.schedule.fullTextFetchThreshold));
          setPerSourceItemLimit(String(payload.schedule.perSourceItemLimit));
          setAggregationSplitMaxEvents(String(payload.schedule.aggregationSplitMaxEvents));
          setProcessingStartAt(toDateTimeLocalValue(payload.schedule.processingStartAt));
        }
      } catch {
        if (!disposed) {
          if (!hasShownRefreshErrorRef.current) {
            showToast("任务监控刷新失败。", "error");
            hasShownRefreshErrorRef.current = true;
          }
        }
      }
    };

    const timer = window.setInterval(
      () => {
        void refreshSnapshot();
      },
      snapshot.runningTasks.length > 0 ? 2_500 : 10_000,
    );

    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [showToast, snapshot.runningTasks.length]);

  const saveSchedule = () => {
    const parsedSourceConcurrency = Number.parseInt(sourceConcurrency.trim(), 10);
    const parsedFullTextFetchThreshold = Number.parseInt(fullTextFetchThreshold.trim(), 10);
    const parsedPerSourceItemLimit = Number.parseInt(perSourceItemLimit.trim(), 10);
    const parsedAggregationSplitMaxEvents = Number.parseInt(aggregationSplitMaxEvents.trim(), 10);

    if (
      !Number.isInteger(parsedSourceConcurrency) ||
      parsedSourceConcurrency < MIN_SOURCE_CONCURRENCY ||
      parsedSourceConcurrency > MAX_SOURCE_CONCURRENCY
    ) {
      showToast(
        `源抓取并发需为 ${MIN_SOURCE_CONCURRENCY}-${MAX_SOURCE_CONCURRENCY} 的整数。`,
        "error",
      );
      return;
    }

    if (
      !Number.isInteger(parsedPerSourceItemLimit) ||
      parsedPerSourceItemLimit < MIN_PER_SOURCE_ITEM_LIMIT ||
      parsedPerSourceItemLimit > MAX_PER_SOURCE_ITEM_LIMIT
    ) {
      showToast(
        `每源处理上限需为 ${MIN_PER_SOURCE_ITEM_LIMIT}-${MAX_PER_SOURCE_ITEM_LIMIT} 的整数。`,
        "error",
      );
      return;
    }

    if (
      !Number.isInteger(parsedFullTextFetchThreshold) ||
      parsedFullTextFetchThreshold < MIN_FULL_TEXT_FETCH_THRESHOLD ||
      parsedFullTextFetchThreshold > MAX_FULL_TEXT_FETCH_THRESHOLD
    ) {
      showToast(
        `正文补抓阈值需为 ${MIN_FULL_TEXT_FETCH_THRESHOLD}-${MAX_FULL_TEXT_FETCH_THRESHOLD} 的整数。`,
        "error",
      );
      return;
    }

    if (
      !Number.isInteger(parsedAggregationSplitMaxEvents) ||
      parsedAggregationSplitMaxEvents < MIN_AGGREGATION_SPLIT_MAX_EVENTS ||
      parsedAggregationSplitMaxEvents > MAX_AGGREGATION_SPLIT_MAX_EVENTS
    ) {
      showToast(
        `单条聚合拆分上限需为 ${MIN_AGGREGATION_SPLIT_MAX_EVENTS}-${MAX_AGGREGATION_SPLIT_MAX_EVENTS} 的整数。`,
        "error",
      );
      return;
    }

    startTransition(async () => {
      try {
        const response = await fetch(
          "/api/admin/monitor/schedule/ingestion-default",
          {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({
              enabled,
              cronExpression,
              sourceConcurrency: parsedSourceConcurrency,
              fullTextFetchThreshold: parsedFullTextFetchThreshold,
              perSourceItemLimit: parsedPerSourceItemLimit,
              aggregationSplitMaxEvents: parsedAggregationSplitMaxEvents,
              processingStartAt: toIsoDateTimeOrNull(processingStartAt),
            }),
          },
        );
        const payload = await readJson<SchedulePayload>(response);

        if (!response.ok || payload.error || !payload.schedule) {
          showToast(payload.error ?? "调度配置保存失败。", "error");
          return;
        }

        const schedule = payload.schedule;

        setSnapshot((current) => ({
          ...current,
          schedule,
        }));
        setSourceConcurrency(String(schedule.sourceConcurrency));
        setFullTextFetchThreshold(String(schedule.fullTextFetchThreshold));
        setPerSourceItemLimit(String(schedule.perSourceItemLimit));
        setAggregationSplitMaxEvents(String(schedule.aggregationSplitMaxEvents));
        setProcessingStartAt(toDateTimeLocalValue(schedule.processingStartAt));
        showToast("调度配置已保存。", "success");
      } catch {
        showToast("调度配置保存失败。", "error");
      }
    });
  };

  const cancelTask = async (taskId: string) => {
    setCancellingTaskId(taskId);

    try {
      const response = await fetch(
        `/api/admin/monitor/tasks/${taskId}/cancel`,
        {
          method: "POST",
        },
      );
      const payload = await readJson<CancelPayload>(response);

      if (!response.ok || payload.error || !payload.task) {
        showToast(payload.error ?? "终止任务失败。", "error");
        return;
      }

      setSnapshot((current) => ({
        ...current,
        runningTasks: current.runningTasks.map((task) =>
          task.id === payload.task!.id ? payload.task! : task,
        ),
        recentTasks: current.recentTasks.map((task) =>
          task.id === payload.task!.id ? payload.task! : task,
        ),
      }));
      showToast("终止请求已提交。", "success");
    } catch {
      showToast("终止任务失败。", "error");
    } finally {
      setCancellingTaskId(null);
    }
  };

  const scheduleSection = (
    <section
      aria-labelledby="monitor-schedule-heading"
      className={cx(surfaceCardClassName, "space-y-5 p-4 sm:p-5")}
    >
      <div className="flex flex-col gap-4 border-b border-[color:var(--line)] pb-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="font-mono text-[11px] font-medium uppercase tracking-[0.24em] text-[var(--accent-strong)]">
              Default Ingestion
            </p>
            <h2
              id="monitor-schedule-heading"
              className="mt-2 text-lg font-semibold tracking-[-0.03em] text-[var(--foreground)]"
            >
              调度设置
            </h2>
          </div>
          <TaskToneBadge
            tone={snapshot.schedule.enabled ? "success" : "muted"}
          >
            {snapshot.schedule.enabled ? "启用中" : "已停用"}
          </TaskToneBadge>
        </div>

        <p className="text-sm leading-6 text-[var(--muted)]">
          控制默认抓取任务的频率与开关，同时查看调度器健康状态。
        </p>
      </div>

      <div className="grid gap-3">
        <div className="grid gap-3 lg:grid-cols-3">
          <label
            className={cx(
              subtleCardClassName,
              "flex cursor-pointer flex-col gap-3 p-3.5",
            )}
          >
            <span className="font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-[var(--muted)]">
              Scheduler
            </span>
            <div className="space-y-2">
              <p className="text-sm font-medium text-[var(--foreground)]">
                启用默认抓取任务
              </p>
              <p className="text-sm leading-6 text-[var(--muted)]">
                停用后不会继续自动拉取新内容，但历史任务记录仍会保留。
              </p>
            </div>
            <span className="inline-flex items-center gap-3">
              <span
                aria-hidden="true"
                className={cx(
                  "relative inline-flex h-7 w-12 rounded-full border transition",
                  enabled
                    ? "border-[color:var(--accent)] bg-[var(--accent)]"
                    : "border-[color:var(--line)] bg-[var(--surface)]",
                )}
              >
                <span
                  className={cx(
                    "absolute left-0.5 top-0.5 h-6 w-6 rounded-full bg-[var(--surface-highlight)] shadow-[var(--shadow-sm)] transition-transform",
                    enabled ? "translate-x-5" : "translate-x-0",
                  )}
                />
              </span>
              <input
                aria-label="启用默认抓取任务"
                checked={enabled}
                className="sr-only"
                type="checkbox"
                onChange={(event) => setEnabled(event.target.checked)}
              />
              <span className="text-sm font-medium text-[var(--foreground)]">
                {enabled ? "当前已启用" : "当前已停用"}
              </span>
            </span>
          </label>

          <label
            className={cx(subtleCardClassName, "flex flex-col gap-3 p-3.5")}
          >
            <span className="font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-[var(--muted)]">
              Cron
            </span>
            <span className="text-sm font-medium text-[var(--foreground)]">
              Cron 表达式
            </span>
            <input
              aria-label="Cron 表达式"
              className={inputClassName}
              type="text"
              value={cronExpression}
              onChange={(event) => setCronExpression(event.target.value)}
            />
          </label>

          <label
            className={cx(subtleCardClassName, "flex flex-col gap-3 p-3.5")}
          >
            <span className="font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-[var(--muted)]">
              Start Time
            </span>
            <span className="text-sm font-medium text-[var(--foreground)]">
              处理开始时间点
            </span>
            <input
              aria-label="处理开始时间点"
              className={inputClassName}
              type="datetime-local"
              value={processingStartAt}
              onChange={(event) => setProcessingStartAt(event.target.value)}
            />
          </label>
        </div>

        <label
          className={cx(subtleCardClassName, "flex flex-col gap-3 p-3.5")}
        >
          <span className="font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-[var(--muted)]">
            Sources
          </span>
          <span className="text-sm font-medium text-[var(--foreground)]">
            源抓取并发
          </span>
          <input
            aria-label="源抓取并发"
            className={inputClassName}
            type="number"
            min={MIN_SOURCE_CONCURRENCY}
            max={MAX_SOURCE_CONCURRENCY}
            step={1}
            value={sourceConcurrency}
            onChange={(event) => setSourceConcurrency(event.target.value)}
          />
          <span className="text-sm leading-6 text-[var(--muted)]">
            控制同一轮任务里并发抓取多少个信息源；条目级 AI 并发仍由默认模型配置控制。
          </span>
        </label>

        <label
          className={cx(subtleCardClassName, "flex flex-col gap-3 p-3.5")}
        >
          <span className="font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-[var(--muted)]">
            Full Text
          </span>
          <span className="text-sm font-medium text-[var(--foreground)]">
            正文补抓阈值
          </span>
          <input
            aria-label="正文补抓阈值"
            className={inputClassName}
            type="number"
            min={MIN_FULL_TEXT_FETCH_THRESHOLD}
            max={MAX_FULL_TEXT_FETCH_THRESHOLD}
            step={1}
            value={fullTextFetchThreshold}
            onChange={(event) => setFullTextFetchThreshold(event.target.value)}
          />
          <span className="text-sm leading-6 text-[var(--muted)]">
            当 RSS 正文或摘要长度低于该值时，任务会尝试补抓页面全文。
          </span>
        </label>

        <label
          className={cx(subtleCardClassName, "flex flex-col gap-3 p-3.5")}
        >
          <span className="font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-[var(--muted)]">
            Item Limit
          </span>
          <span className="text-sm font-medium text-[var(--foreground)]">
            每源处理上限
          </span>
          <input
            aria-label="每源处理上限"
            className={inputClassName}
            type="number"
            min={MIN_PER_SOURCE_ITEM_LIMIT}
            max={MAX_PER_SOURCE_ITEM_LIMIT}
            step={1}
            value={perSourceItemLimit}
            onChange={(event) => setPerSourceItemLimit(event.target.value)}
          />
          <span className="text-sm leading-6 text-[var(--muted)]">
            控制每个信息源单轮最多准备处理多少条 RSS 文章。
          </span>
        </label>

        <label
          className={cx(subtleCardClassName, "flex flex-col gap-3 p-3.5")}
        >
          <span className="font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-[var(--muted)]">
            Split Limit
          </span>
          <span className="text-sm font-medium text-[var(--foreground)]">
            单条聚合拆分上限
          </span>
          <input
            aria-label="单条聚合拆分上限"
            className={inputClassName}
            type="number"
            min={MIN_AGGREGATION_SPLIT_MAX_EVENTS}
            max={MAX_AGGREGATION_SPLIT_MAX_EVENTS}
            step={1}
            value={aggregationSplitMaxEvents}
            onChange={(event) => setAggregationSplitMaxEvents(event.target.value)}
          />
          <span className="text-sm leading-6 text-[var(--muted)]">
            控制每篇聚合内容最多拆出多少个子事件，代码和提示词共用该上限。
          </span>
        </label>

      </div>

      <div className="grid gap-2.5 sm:grid-cols-2">
        <TaskFact
          label="Health"
          value={
            snapshot.schedule.isHeartbeatStale
              ? "调度器离线"
              : "调度器在线"
          }
        />
        <TaskFact
          label="Last Status"
          value={
            snapshot.schedule.lastRunStatus
              ? statusLabels[snapshot.schedule.lastRunStatus]
              : "暂无"
          }
        />
        <TaskFact
          label="Source Concurrency"
          value={String(snapshot.schedule.sourceConcurrency)}
        />
        <TaskFact
          label="Full Text Threshold"
          value={String(snapshot.schedule.fullTextFetchThreshold)}
        />
        <TaskFact
          label="Per Source Limit"
          value={String(snapshot.schedule.perSourceItemLimit)}
        />
        <TaskFact
          label="Split Event Limit"
          value={String(snapshot.schedule.aggregationSplitMaxEvents)}
        />
        <TaskFact
          label="Processing Start"
          value={formatDateTime(snapshot.schedule.processingStartAt ?? null)}
        />
        <TaskFact label="Timezone" value={snapshot.schedule.timezone} />
      </div>

      <div className="flex flex-col gap-3">
        <button
          className={primaryButtonClassName}
          type="button"
          disabled={isPending}
          onClick={saveSchedule}
        >
          保存调度设置
        </button>
      </div>
    </section>
  );

  const tasksSection = (
    <div className="grid gap-4">
      <section
        aria-labelledby="monitor-running-heading"
        className={cx(
          surfaceCardClassName,
          "space-y-5 border-[color:var(--line-strong)] bg-[linear-gradient(180deg,color-mix(in_srgb,var(--surface)_98%,transparent),color-mix(in_srgb,var(--accent-soft)_52%,var(--surface)))] p-4 sm:p-5",
        )}
      >
        <div className="flex flex-col gap-4 border-b border-[color:var(--line)] pb-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="font-mono text-[11px] font-medium uppercase tracking-[0.24em] text-[var(--accent-strong)]">
                Live Queue
              </p>
              <h2
                id="monitor-running-heading"
                className="mt-2 text-lg font-semibold tracking-[-0.03em] text-[var(--foreground)]"
              >
                运行中任务
              </h2>
            </div>
            <TaskToneBadge
              tone={snapshot.runningTasks.length > 0 ? "accent" : "muted"}
            >
              {snapshot.runningTasks.length > 0
                ? `${snapshot.runningTasks.length} 个活动任务`
                : "队列空闲"}
            </TaskToneBadge>
          </div>

          <p className="text-sm leading-6 text-[var(--muted)]">
            优先展示正在执行或等待终止的任务，保留终止入口与关键运行指标。
          </p>
        </div>

        <div className="grid gap-3">
          {snapshot.runningTasks.length > 0 ? (
            snapshot.runningTasks.map((task) => (
              <TaskCard
                key={task.id}
                cancellable={task.kind === "ingestion"}
                cancellingTaskId={cancellingTaskId}
                emphasis="strong"
                emptyProgressLabel="等待处理"
                task={task}
                onCancel={cancelTask}
              />
            ))
          ) : (
            <div
              className={cx(
                subtleCardClassName,
                "p-4 text-sm leading-6 text-[var(--muted)]",
              )}
            >
              当前没有运行中的后台任务。
            </div>
          )}
        </div>
      </section>

      <section
        aria-labelledby="monitor-recent-heading"
        className={cx(surfaceCardClassName, "space-y-5 p-4 sm:p-5")}
      >
        <div className="flex flex-col gap-4 border-b border-[color:var(--line)] pb-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="font-mono text-[11px] font-medium uppercase tracking-[0.24em] text-[var(--accent-strong)]">
                Recent Runs
              </p>
              <h2
                id="monitor-recent-heading"
                className="mt-2 text-lg font-semibold tracking-[-0.03em] text-[var(--foreground)]"
              >
                最近任务
              </h2>
            </div>
            <TaskToneBadge tone="muted">
              {snapshot.recentTasks.length} 条记录
            </TaskToneBadge>
          </div>

          <p className="text-sm leading-6 text-[var(--muted)]">
            最近任务沿用与运行中任务一致的状态、触发方式、AI
            调用数和错误摘要样式。
          </p>
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          {snapshot.recentTasks.length > 0 ? (
            snapshot.recentTasks.map((task) => (
              <TaskCard
                key={task.id}
                cancellable={false}
                cancellingTaskId={cancellingTaskId}
                emptyProgressLabel="暂无进度信息"
                task={task}
                onCancel={cancelTask}
              />
            ))
          ) : (
            <div
              className={cx(
                subtleCardClassName,
                "p-4 text-sm leading-6 text-[var(--muted)]",
              )}
            >
              当前还没有后台任务记录。
            </div>
          )}
        </div>
      </section>
    </div>
  );

  const content = (
    <section className="space-y-4">
      <h1 className="sr-only">任务监控</h1>

      {showScheduleOnly ? (
        scheduleSection
      ) : (
        <div className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)] xl:items-start">
          {showSchedule && scheduleSection}
          {tasksSection}
        </div>
      )}
    </section>
  );

  if (embedMode) {
    return content;
  }

  return (
    <PageShell
      header={{ activeNav: null, isAdmin: true }}
      contentClassName="gap-4 sm:gap-5"
      contentWidth="workspace"
    >
      {content}
    </PageShell>
  );
}
