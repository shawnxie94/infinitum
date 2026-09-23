import type { BackgroundTaskRun } from "@prisma/client";

import { prisma } from "@/lib/db";
import { WORKFLOW_TASK_DEFINITIONS } from "@/lib/workflows/catalog";
import { createAiRuntime, restartActiveWorkflowRuns, type AiRuntime } from "@infinitum/ai/orchestration/runtime";
import type { WorkflowTaskSink } from "@infinitum/ai/orchestration/types";
import { createDomainTaskRunWorkflow } from "@infinitum/ai/orchestration/task-definition";
import type { TaskLifecycleEvent } from "@infinitum/ai/orchestration/lifecycle";
import type { TaskStepIdentity, TaskStepLifecycleEvent } from "@infinitum/ai/orchestration/types";
import type { TaskAiCallBreakdownSnapshot, TaskStageTimingSnapshot } from "@/lib/tasks/types";

/**
 * 主仓侧编排接线（spec P1b-P4/D11）：
 * - sink 把 BackgroundTaskRun 读写映射给 packages/ai（依赖倒置，D9 所有权边界）
 * - 11 个 task kind 均由 Mastra workflow 承载；声明式 domain stage 只负责业务副作用，生命周期由 framework glue 统一托管
 * - runtime 单例：Next.js 与 worker 进程各自内嵌（D11），共享 SQLite 存储
 */

type WorkflowKind = BackgroundTaskRun["kind"];

const WORKFLOW_KINDS: readonly WorkflowKind[] = Object.keys(WORKFLOW_TASK_DEFINITIONS) as WorkflowKind[];

type CheckpointRecord = Record<string, unknown>;

function asCheckpointRecord(value: unknown): CheckpointRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as CheckpointRecord : {};
}

async function mergeTaskCheckpoint(taskRunId: string, value: unknown) {
  const current = await prisma.backgroundTaskRun.findUnique({
    where: { id: taskRunId },
    select: { pipelineCheckpointJson: true },
  });
  let existing: CheckpointRecord = {};
  if (current?.pipelineCheckpointJson) {
    try {
      existing = asCheckpointRecord(JSON.parse(current.pipelineCheckpointJson));
    } catch {
      existing = {};
    }
  }
  const next = asCheckpointRecord(value);
  const existingMastra = asCheckpointRecord(existing.__mastra);
  const nextMastra = asCheckpointRecord(next.__mastra);
  const merged = {
    ...existing,
    ...next,
    ...(Object.keys(existingMastra).length > 0 || Object.keys(nextMastra).length > 0
      ? { __mastra: { ...existingMastra, ...nextMastra } }
      : {}),
  };
  await prisma.backgroundTaskRun.updateMany({
    where: { id: taskRunId },
    data: { pipelineCheckpointJson: JSON.stringify(merged) },
  });
}

const WORKFLOW_STAGE_LABELS: Record<string, string> = {
  read: "读取数据",
  ai_call: "AI 分析",
  validate: "结果校验",
  writeback: "结果写回",
  source_sync: "信息源同步",
  item_processing: "内容处理",
  cluster_merge: "聚合合并",
  cluster_finalize: "聚合收尾",
  recovery_batch: "补偿处理",
  recovery_persist: "补偿写回",
  delete: "删除过期内容",
  compute: "计算候选",
  entity_alias_check: "实体别名判定",
  entity_suggestion_candidates: "实体候选生成",
  cluster_merge_clean_pairs: "聚合合并候选",
};

function stageKey(event: TaskStepLifecycleEvent) {
  const prefix = event.workflowId ? `${event.workflowId}-` : "";
  return event.stepId.startsWith(prefix) ? event.stepId.slice(prefix.length) : event.stepId;
}

function stageLabel(key: string) {
  return WORKFLOW_STAGE_LABELS[key] ?? key;
}

function parseStageTimings(value: string | null): TaskStageTimingSnapshot[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is TaskStageTimingSnapshot => (
        Boolean(entry)
        && typeof entry === "object"
        && typeof (entry as Record<string, unknown>).key === "string"
        && typeof (entry as Record<string, unknown>).label === "string"
      ))
      : [];
  } catch {
    return [];
  }
}

async function projectTaskStepTiming(event: TaskStepLifecycleEvent) {
  const current = await prisma.backgroundTaskRun.findUnique({
    where: { id: event.taskRunId },
    select: { stageTimingsJson: true },
  });
  const key = stageKey(event);
  const startedAt = event.checkpoint.startedAt;
  const finishedAt = event.checkpoint.finishedAt ?? null;
  const durationMs = finishedAt
    ? Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime())
    : null;
  const timings = parseStageTimings(current?.stageTimingsJson ?? null);
  const existingIndex = timings.findIndex((timing) => timing.key === key);
  const previous = existingIndex >= 0 ? timings[existingIndex] : undefined;
  const nextTiming: TaskStageTimingSnapshot = {
    key,
    label: stageLabel(key),
    startedAt,
    finishedAt,
    durationMs,
    status: event.status,
    ...(previous?.detail ? { detail: previous.detail } : {}),
  };
  if (existingIndex >= 0) timings[existingIndex] = nextTiming;
  else timings.push(nextTiming);
  await prisma.backgroundTaskRun.updateMany({
    where: { id: event.taskRunId },
    data: { stageTimingsJson: JSON.stringify(timings) },
  });
}

function parseAiBreakdown(value: string | null): TaskAiCallBreakdownSnapshot[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is TaskAiCallBreakdownSnapshot => (
        Boolean(entry)
        && typeof entry === "object"
        && typeof (entry as Record<string, unknown>).key === "string"
        && typeof (entry as Record<string, unknown>).label === "string"
      ))
      : [];
  } catch {
    return [];
  }
}

function compactAiBreakdown(entries: TaskAiCallBreakdownSnapshot[]) {
  return entries.filter((entry) => entry.actual > 0 || entry.estimated > 0 || (entry.totalTokens ?? 0) > 0);
}

function mergeCachedTokensStatus(
  previous: TaskAiCallBreakdownSnapshot["cachedTokensStatus"],
  next: TaskAiCallBreakdownSnapshot["cachedTokensStatus"],
): TaskAiCallBreakdownSnapshot["cachedTokensStatus"] {
  const previousStatus = previous ?? "unavailable";
  const nextStatus = next ?? "unavailable";
  if (previousStatus === nextStatus) return previousStatus;
  if (previousStatus === "unavailable" && nextStatus === "unavailable") return "unavailable";
  return "partial";
}

function mergeAiBreakdowns(groups: TaskAiCallBreakdownSnapshot[][]) {
  const merged = new Map<string, TaskAiCallBreakdownSnapshot>();
  for (const group of groups) {
    for (const entry of group) {
      const previous = merged.get(entry.key);
      const previousSource = previous?.tokenUsageSource;
      const nextSource = entry.tokenUsageSource;
      merged.set(entry.key, {
        ...entry,
        ...((previous?.modelNames?.length ?? 0) > 0 || (entry.modelNames?.length ?? 0) > 0
          ? { modelNames: [...new Set([...(previous?.modelNames ?? []), ...(entry.modelNames ?? [])])] }
          : {}),
        actual: (previous?.actual ?? 0) + entry.actual,
        estimated: (previous?.estimated ?? 0) + entry.estimated,
        ...(entry.promptTokens !== undefined || previous?.promptTokens !== undefined
          ? { promptTokens: (previous?.promptTokens ?? 0) + (entry.promptTokens ?? 0) }
          : {}),
        ...(entry.completionTokens !== undefined || previous?.completionTokens !== undefined
          ? { completionTokens: (previous?.completionTokens ?? 0) + (entry.completionTokens ?? 0) }
          : {}),
        ...(entry.totalTokens !== undefined || previous?.totalTokens !== undefined
          ? { totalTokens: (previous?.totalTokens ?? 0) + (entry.totalTokens ?? 0) }
          : {}),
        ...(entry.cachedTokens !== undefined || previous?.cachedTokens !== undefined
          ? { cachedTokens: (previous?.cachedTokens ?? 0) + (entry.cachedTokens ?? 0) }
          : {}),
        ...(entry.cachedTokensStatus !== undefined || previous?.cachedTokensStatus !== undefined
          || entry.cachedTokens !== undefined || previous?.cachedTokens !== undefined
          ? { cachedTokensStatus: mergeCachedTokensStatus(previous?.cachedTokensStatus, entry.cachedTokensStatus) }
          : {}),
        ...(previousSource && nextSource && previousSource !== nextSource
          ? { tokenUsageSource: "mixed" as const }
          : { tokenUsageSource: nextSource ?? previousSource }),
      });
    }
  }
  return compactAiBreakdown([...merged.values()]);
}

type AiUsageProjection = {
  actual: number;
  estimated: number;
  breakdown: TaskAiCallBreakdownSnapshot[];
};

type AiUsageIdentity = TaskStepIdentity & { attempt: number; retryCount: number };

function parseAiUsageProjection(value: unknown): AiUsageProjection | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const actual = typeof raw.actual === "number" && Number.isFinite(raw.actual) ? raw.actual : 0;
  const estimated = typeof raw.estimated === "number" && Number.isFinite(raw.estimated) ? raw.estimated : 0;
  const breakdown = Array.isArray(raw.breakdown)
    ? compactAiBreakdown(raw.breakdown.filter((entry): entry is TaskAiCallBreakdownSnapshot => (
      Boolean(entry)
      && typeof entry === "object"
      && typeof (entry as Record<string, unknown>).key === "string"
      && typeof (entry as Record<string, unknown>).label === "string"
    )))
    : [];
  return { actual, estimated, breakdown };
}

function summarizeAiUsageForStage(projection: AiUsageProjection) {
  const entries = projection.breakdown.filter((entry) => entry.actual > 0 || entry.totalTokens !== undefined);
  if (entries.length === 0) return null;
  const hasTokenUsage = entries.some((entry) => entry.promptTokens !== undefined
    || entry.completionTokens !== undefined
    || entry.totalTokens !== undefined);
  const promptTokens = entries.reduce((sum, entry) => sum + (entry.promptTokens ?? 0), 0);
  const completionTokens = entries.reduce((sum, entry) => sum + (entry.completionTokens ?? 0), 0);
  const cachedTokens = entries.reduce((sum, entry) => sum + (entry.cachedTokens ?? 0), 0);
  const statuses = entries.map((entry) => entry.cachedTokensStatus ?? "unavailable");
  const cachedTokensStatus = statuses.every((status) => status === "provider")
    ? "provider"
    : statuses.every((status) => status === "unavailable")
      ? "unavailable"
      : "partial";
  const cachedDetail = cachedTokensStatus === "provider"
    ? `缓存 ${cachedTokens} tokens`
    : cachedTokensStatus === "partial"
      ? `缓存 ${cachedTokens} tokens（部分返回）`
      : "缓存 tokens 未提供";
  const tokenDetail = hasTokenUsage
    ? `输入 ${promptTokens} tokens · 输出 ${completionTokens} tokens`
    : "tokens 未提供";
  return `AI 调用 ${entries.reduce((sum, entry) => sum + entry.actual, 0)} 次 · ${tokenDetail} · ${cachedDetail}`;
}

function mergeStageDetail(existing: string | undefined, detail: string) {
  const normalized = detail.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
  if (!normalized || existing?.includes(normalized)) return existing;
  return [existing, normalized].filter(Boolean).join(" · ").slice(0, 300);
}

function withStageUsageDetail(
  value: string | null,
  identity: AiUsageIdentity,
  detail: string,
): string | null {
  const prefix = identity.workflowId ? `${identity.workflowId}-` : "";
  const key = identity.stepId.startsWith(prefix) ? identity.stepId.slice(prefix.length) : identity.stepId;
  const timings = parseStageTimings(value);
  const index = timings.findIndex((timing) => timing.key === key);
  if (index < 0) return null;
  timings[index] = { ...timings[index], detail: mergeStageDetail(timings[index].detail, detail) };
  return JSON.stringify(timings);
}

async function projectTaskStageDetail(taskRunId: string, stepId: string, detail: string) {
  const current = await prisma.backgroundTaskRun.findUnique({
    where: { id: taskRunId },
    select: { stageTimingsJson: true },
  });
  const workflowId = Object.keys(WORKFLOW_TASK_DEFINITIONS).find((kind) => stepId.startsWith(`${kind}-`));
  const key = workflowId ? stepId.slice(workflowId.length + 1) : stepId;
  const timings = parseStageTimings(current?.stageTimingsJson ?? null);
  const index = timings.findIndex((timing) => timing.key === key);
  if (index < 0) return;
  const mergedDetail = mergeStageDetail(timings[index].detail, detail);
  if (!mergedDetail) return;
  timings[index] = { ...timings[index], detail: mergedDetail };
  await prisma.backgroundTaskRun.updateMany({
    where: { id: taskRunId },
    data: { stageTimingsJson: JSON.stringify(timings) },
  });
}

async function projectTaskAiUsage(taskRunId: string, value: unknown, identity?: AiUsageIdentity) {
  const projection = parseAiUsageProjection(value);
  if (!projection || (projection.actual === 0 && projection.estimated === 0 && projection.breakdown.length === 0)) return;
  const current = await prisma.backgroundTaskRun.findUnique({
    where: { id: taskRunId },
    select: {
      aiCallCountActual: true,
      aiCallCountEstimated: true,
      aiCallBreakdownJson: true,
      pipelineCheckpointJson: true,
      stageTimingsJson: true,
    },
  });
  if (!current) return;

  let checkpoint: CheckpointRecord = {};
  try {
    checkpoint = asCheckpointRecord(current.pipelineCheckpointJson ? JSON.parse(current.pipelineCheckpointJson) : {});
  } catch {
    checkpoint = {};
  }
  const mastra = asCheckpointRecord(checkpoint.__mastra);
  const rawByStep = asCheckpointRecord(mastra.aiUsageByStep);
  const usageKey = identity
    ? [identity.workflowRunId ?? "unknown-run", identity.stepId, identity.attempt, identity.retryCount].join(":")
    : null;
  if (usageKey && Object.prototype.hasOwnProperty.call(rawByStep, usageKey)) return;
  const stageDetail = identity ? summarizeAiUsageForStage(projection) : null;
  const stageTimingsJson = identity && stageDetail
    ? withStageUsageDetail(current.stageTimingsJson, identity, stageDetail)
    : null;

  if (!identity) {
    const existing = parseAiBreakdown(current.aiCallBreakdownJson);
    const merged = mergeAiBreakdowns([existing, projection.breakdown]);
    await prisma.backgroundTaskRun.updateMany({
      where: { id: taskRunId },
      data: {
        aiCallCountActual: current.aiCallCountActual + projection.actual,
        aiCallCountEstimated: current.aiCallCountEstimated + projection.estimated,
        aiCallBreakdownJson: JSON.stringify(merged),
      },
    });
    return;
  }

  const base = parseAiUsageProjection(mastra.aiUsageBase) ?? {
    actual: current.aiCallCountActual,
    estimated: current.aiCallCountEstimated,
    breakdown: parseAiBreakdown(current.aiCallBreakdownJson),
  };
  const byStep = {
    ...rawByStep,
    [usageKey as string]: projection,
  };
  const projections = Object.values(byStep)
    .map(parseAiUsageProjection)
    .filter((entry): entry is AiUsageProjection => entry !== null);
  const allBreakdowns = [base.breakdown, ...projections.map((entry) => entry.breakdown)];
  const nextCheckpoint = {
    ...checkpoint,
    __mastra: {
      ...mastra,
      aiUsageBase: base,
      aiUsageByStep: byStep,
    },
  };
  await prisma.backgroundTaskRun.updateMany({
    where: { id: taskRunId },
    data: {
      aiCallCountActual: base.actual + projections.reduce((sum, entry) => sum + entry.actual, 0),
      aiCallCountEstimated: base.estimated + projections.reduce((sum, entry) => sum + entry.estimated, 0),
      aiCallBreakdownJson: JSON.stringify(mergeAiBreakdowns(allBreakdowns)),
      pipelineCheckpointJson: JSON.stringify(nextCheckpoint),
      ...(stageTimingsJson ? { stageTimingsJson } : {}),
    },
  });
}

const sink: WorkflowTaskSink = {
  async getTaskRun(taskRunId) {
    // 返回完整行：执行体及其下游（timeline/进度等）会消费 startedAt 等投影外字段
    const row = await prisma.backgroundTaskRun.findUnique({
      where: { id: taskRunId },
    });
    return (row as unknown as BackgroundTaskRun) ?? null;
  },
  async markStarted(taskRunId) {
    await prisma.backgroundTaskRun.updateMany({
      where: { id: taskRunId, status: "queued" },
      data: { status: "running", startedAt: new Date() },
    });
  },
  async markSucceeded(taskRunId) {
    await prisma.backgroundTaskRun.updateMany({
      where: { id: taskRunId, status: { in: ["queued", "running"] } },
      data: { status: "succeeded", finishedAt: new Date() },
    });
  },
  async markCancelled(taskRunId, message) {
    await prisma.backgroundTaskRun.updateMany({
      where: { id: taskRunId, status: { in: ["queued", "running"] } },
      data: {
        status: "cancelled",
        finishedAt: new Date(),
        errorSummary: (message ?? "任务已取消").slice(0, 500),
      },
    });
  },
  async markFailed(taskRunId, message, failureKind) {
    // D6 终态兜底：业务体在写入自身终态前崩溃时，避免 BackgroundTaskRun 卡 running
    await prisma.backgroundTaskRun.updateMany({
      where: { id: taskRunId, status: { in: ["queued", "running"] } },
      data: {
        status: "failed",
        finishedAt: new Date(),
        errorSummary: `${failureKind ? `[${failureKind}] ` : ""}${message}`.slice(0, 500),
      },
    });
  },
  async projectStep(event: TaskStepLifecycleEvent) {
    if (event.errorMessage) {
      await prisma.backgroundTaskRun.updateMany({
        where: { id: event.taskRunId },
        data: { errorSummary: `[${event.failureKind ?? "unknown"}] ${event.errorMessage}`.slice(0, 500) },
      });
    }
    await projectTaskStepTiming(event);
    if (!event.taskRunId) return;
    await mergeTaskCheckpoint(event.taskRunId, {
      __mastra: {
        step: event.checkpoint,
        lifecycle: event,
        checkpoint: event.checkpoint,
      },
    });
  },
  async projectCheckpoint(taskRunId, checkpoint) {
    await mergeTaskCheckpoint(taskRunId, checkpoint);
  },
  async projectProgress(taskRunId, label) {
    const stageSummaryPrefix = "__mastra_stage_summary__";
    if (label.startsWith(stageSummaryPrefix)) {
      const separator = label.indexOf("\n", stageSummaryPrefix.length);
      if (separator > stageSummaryPrefix.length) {
        await projectTaskStageDetail(
          taskRunId,
          label.slice(stageSummaryPrefix.length, separator),
          label.slice(separator + 1),
        );
        return;
      }
    }
    await prisma.backgroundTaskRun.updateMany({
      where: { id: taskRunId, status: { in: ["queued", "running"] } },
      data: { progressLabel: label },
    });
  },
  async projectAiUsage(taskRunId, usage, identity) {
    await projectTaskAiUsage(taskRunId, usage, identity);
  },
  async projectLifecycle(event: TaskLifecycleEvent) {
    if (event.event === "start") {
      await prisma.backgroundTaskRun.updateMany({
        where: { id: event.taskRunId, status: "running", progressLabel: null },
        data: { progressLabel: "编排运行中" },
      });
    } else if (event.event === "error" && event.errorMessage) {
      await prisma.backgroundTaskRun.updateMany({
        where: { id: event.taskRunId, errorSummary: null },
        data: { errorSummary: `[${event.failureKind ?? "unknown"}] ${event.errorMessage}`.slice(0, 500) },
      });
    }
  },
  async isCancellationRequested(taskRunId) {
    const row = await prisma.backgroundTaskRun.findUnique({
      where: { id: taskRunId },
      select: { cancelRequestedAt: true },
    });
    return row?.cancelRequestedAt != null;
  },
};

let runtimeSingleton: AiRuntime | null = null;

export function getAiRuntime(): AiRuntime {
  if (!runtimeSingleton) {
    const workflows = Object.fromEntries(
      WORKFLOW_KINDS.map((kind) => {
        const definition = WORKFLOW_TASK_DEFINITIONS[kind];
        if (!definition) throw new Error(`No declarative workflow definition registered for ${kind}.`);
        return [kind, createDomainTaskRunWorkflow({ definition, sink })];
      }),
    );
    runtimeSingleton = createAiRuntime({ workflows });
  }
  return runtimeSingleton;
}

export async function triggerTaskWorkflow(
  kind: WorkflowKind,
  taskRunId: string,
): Promise<{ runId: string; status: string }> {
  const runtime = getAiRuntime();
  const workflow = runtime.mastra.getWorkflow(kind);
  const run = await workflow.createRun();
  const result = (await run.start({ inputData: { taskRunId } })) as {
    status?: string;
    result?: { status: string };
  };
  return {
    runId: run.runId,
    status: result.result?.status ?? result.status ?? "unknown",
  };
}

export async function restartActiveAiWorkflowRuns(): Promise<void> {
  await restartActiveWorkflowRuns(getAiRuntime());
}

export function isWorkflowKind(kind: BackgroundTaskRun["kind"]): kind is WorkflowKind {
  return WORKFLOW_KINDS.includes(kind);
}
