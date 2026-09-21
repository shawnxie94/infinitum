/**
 * 任务 workflow 编排类型：主仓业务体通过注入接入 Mastra（依赖倒置，
 * packages/ai 不 import 主仓模块——D9 所有权边界）。
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- Mastra Workflow 占位泛型，P1a 定型后收敛 */
import type { Workflow } from "@mastra/core/workflows";

import type { TaskExecutionContext, TaskLifecycleEvent } from "./lifecycle";

export type TaskStepStatus = "running" | "succeeded" | "failed" | "partial" | "cancelled";

/** Durable step identity shared by Mastra, task lifecycle and provider usage audit. */
export type TaskStepIdentity = {
  stepId: string;
  workflowId?: string;
  workflowRunId?: string;
  taskRunId?: string;
};

/** The framework-owned checkpoint projection for one persisted Mastra step. */
export type TaskStepCheckpoint = TaskStepIdentity & {
  version: 1;
  attempt: number;
  retryCount: number;
  status: TaskStepStatus;
  startedAt: string;
  finishedAt?: string;
  failureKind?: string;
  errorMessage?: string;
};

export type TaskStepLifecycleEvent = TaskStepIdentity & {
  attempt: number;
  retryCount: number;
  event: "start" | "finish" | "error" | "cancel";
  status: TaskStepStatus;
  failureKind?: string;
  errorMessage?: string;
  checkpoint: TaskStepCheckpoint;
  at: string;
};

/** BackgroundTaskRun 行的最小投影（body 启动时由 sink 重新读取，保证拿到最新检查点）。 */
export type TaskRunSnapshot = {
  id: string;
  kind: string;
  entityId: string | null;
  triggerType: string;
  pipelineCheckpointJson: string | null;
  /** body 执行前的行状态（queued/running/...）；workflow 结束后再读一次用于终态镜像。 */
  status?: string;
};

/** 业务执行体：原 executeTaskRun handler 语义（自己负责 BackgroundTaskRun 状态簿记、取消轮询、检查点）。 */
export type TaskBody = (taskRun: TaskRunSnapshot, context?: TaskExecutionContext) => Promise<void>;

export type WorkflowTaskSink = {
  getTaskRun(taskRunId: string): Promise<TaskRunSnapshot | null>;
  isCancellationRequested(taskRunId: string): Promise<boolean>;
  markStarted?(taskRunId: string, runId?: string): Promise<void>;
  markSucceeded?(taskRunId: string, runId?: string): Promise<void>;
  markCancelled?(taskRunId: string, message?: string): Promise<void>;
  /** D6 终态兜底：业务体未写自身终态即崩溃时，把 BackgroundTaskRun 落到 failed。 */
  markFailed?(taskRunId: string, message: string, failureKind?: string): Promise<void>;
  /** 通用任务生命周期投影；不替代 step 级事件。 */
  projectLifecycle?(event: TaskLifecycleEvent): Promise<void>;
  /** 每个 Mastra step 的持久化生命周期与 checkpoint 投影。 */
  projectStep?(event: TaskStepLifecycleEvent): Promise<void>;
};

export type TaskWorkflow = Workflow<any, any, any, any, any, any, any>;
