import { classifyTaskError, isCancellationError, toTaskExecutionError, type TaskFailureKind } from "./errors";
import type {
  TaskBody,
  TaskRunSnapshot,
  TaskStepCheckpoint,
  TaskStepLifecycleEvent,
  WorkflowTaskSink,
} from "./types";

export type TaskExecutionContext = {
  readonly signal: AbortSignal;
  /** Mastra workflow run id. */
  readonly runId?: string;
  /** Stable workflow id and persisted step id. */
  readonly workflowId?: string;
  readonly stepId: string;
  /** Mastra retry count for this step; attempt is the task-level attempt bucket. */
  readonly retryCount: number;
  readonly attempt: number;
  readonly checkpoint: TaskStepCheckpoint;
  readonly checkCancellation: () => Promise<void>;
};

export type TaskLifecycleEvent = {
  taskRunId: string;
  runId?: string;
  kind: string;
  stepId: string;
  workflowId?: string;
  retryCount: number;
  attempt: number;
  event: "start" | "finish" | "error" | "cancel";
  status: "running" | "succeeded" | "failed" | "partial" | "cancelled";
  failureKind?: TaskFailureKind;
  errorMessage?: string;
  at: string;
};

export type TaskLifecycleHooks = {
  onStart?: (event: TaskLifecycleEvent) => Promise<void> | void;
  onFinish?: (event: TaskLifecycleEvent) => Promise<void> | void;
  onError?: (event: TaskLifecycleEvent) => Promise<void> | void;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createAbortController(signal?: AbortSignal): AbortController {
  const controller = new AbortController();
  if (!signal) return controller;
  if (signal.aborted) controller.abort(signal.reason);
  else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  return controller;
}

/**
 * Shared task lifecycle adapter. The domain body remains responsible for business
 * checkpoints and metrics; this function owns generic terminal-state behavior.
 */
export async function runTaskWithLifecycle(input: {
  row: TaskRunSnapshot;
  body: TaskBody;
  sink: WorkflowTaskSink;
  runId?: string;
  attempt?: number;
  signal?: AbortSignal;
  hooks?: TaskLifecycleHooks;
  cancelPollMs?: number;
  /** Mastra step identity; direct callers default to a synthetic task step. */
  stepId?: string;
  workflowId?: string;
  retryCount?: number;
  /** Staged workflows keep the task running between business stages. */
  terminal?: boolean;
  startLifecycle?: boolean;
  finishLifecycle?: boolean;
}): Promise<{ status: "succeeded" | "failed" | "partial" | "cancelled"; failureKind?: TaskFailureKind }> {
  const attempt = input.attempt ?? 1;
  const retryCount = input.retryCount ?? 0;
  const stepId = input.stepId ?? `${input.row.kind}-task`;
  const controller = createAbortController(input.signal);
  const stepStartedAt = new Date().toISOString();
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  const checkCancellation = async () => {
    if (controller.signal.aborted) throw new Error("Task aborted");
    if (await input.sink.isCancellationRequested(input.row.id)) {
      controller.abort("cancelRequestedAt");
      throw new Error("Task cancellation requested");
    }
  };

  const emit = async (event: TaskLifecycleEvent, handler?: (event: TaskLifecycleEvent) => Promise<void> | void) => {
    await input.sink.projectLifecycle?.(event);
    await handler?.(event);
  };
  const base = {
    taskRunId: input.row.id,
    runId: input.runId,
    kind: input.row.kind,
    stepId,
    workflowId: input.workflowId,
    retryCount,
    attempt,
  };
  const emitStep = async (event: TaskStepLifecycleEvent) => {
    await input.sink.projectStep?.(event);
  };
  const checkpoint = (status: TaskStepCheckpoint["status"], at: string, extra: Partial<TaskStepCheckpoint> = {}): TaskStepCheckpoint => ({
    version: 1,
    taskRunId: input.row.id,
    stepId,
    workflowId: input.workflowId,
    workflowRunId: input.runId,
    attempt,
    retryCount,
    status,
    startedAt: stepStartedAt,
    ...extra,
    ...(status === "running" ? {} : { finishedAt: at }),
  });
  const stepEvent = (
    event: TaskStepLifecycleEvent["event"],
    status: TaskStepLifecycleEvent["status"],
    at: string,
    extra: Partial<TaskStepLifecycleEvent> = {},
  ): TaskStepLifecycleEvent => ({
    taskRunId: input.row.id,
    stepId,
    workflowId: input.workflowId,
    workflowRunId: input.runId,
    attempt,
    retryCount,
    event,
    status,
    checkpoint: checkpoint(status, at, extra),
    at,
    ...extra,
  });
  await emitStep(stepEvent("start", "running", stepStartedAt));

  const terminal = input.terminal ?? true;
  const startLifecycle = input.startLifecycle ?? true;
  const finishLifecycle = input.finishLifecycle ?? terminal;
  if (startLifecycle) {
    await input.sink.markStarted?.(input.row.id, input.runId);
    await emit({ ...base, event: "start", status: "running", at: stepStartedAt }, input.hooks?.onStart);
  }
  if (input.cancelPollMs && input.cancelPollMs > 0) {
    pollTimer = setInterval(() => {
      void checkCancellation().catch(() => undefined);
    }, input.cancelPollMs);
  }

  try {
    await checkCancellation();
    await input.body(input.row, {
      signal: controller.signal,
      runId: input.runId,
      workflowId: input.workflowId,
      stepId,
      retryCount,
      attempt,
      checkpoint: checkpoint("running", stepStartedAt),
      checkCancellation,
    });
    await checkCancellation();
    if (!terminal) {
      await emitStep(stepEvent("finish", "succeeded", new Date().toISOString()));
      return { status: "succeeded" };
    }
    const after = await input.sink.getTaskRun(input.row.id);
    if (after?.status === "cancelled") {
      const at = new Date().toISOString();
      await emitStep(stepEvent("cancel", "cancelled", at, { failureKind: "canceled" }));
      const event: TaskLifecycleEvent = { ...base, event: "cancel", status: "cancelled", failureKind: "canceled", at };
      await emit(event, input.hooks?.onError);
      return { status: "cancelled", failureKind: "canceled" };
    }
    if (after?.status === "failed" || after?.status === "partial") {
      const status = after.status as "failed" | "partial";
      const at = new Date().toISOString();
      await emitStep(stepEvent("finish", status, at));
      const event: TaskLifecycleEvent = { ...base, event: "finish", status, at };
      await emit(event, input.hooks?.onFinish);
      return { status };
    }
    await checkCancellation();
    await input.sink.markSucceeded?.(input.row.id, input.runId);
    await emitStep(stepEvent("finish", "succeeded", new Date().toISOString()));
    if (finishLifecycle) {
      await emit({ ...base, event: "finish", status: "succeeded", at: new Date().toISOString() }, input.hooks?.onFinish);
    }
    return { status: "succeeded" };
  } catch (error) {
    const normalized = toTaskExecutionError(error);
    const failureKind = isCancellationError(error) ? "canceled" : classifyTaskError(normalized);
    if (failureKind === "canceled") {
      const at = new Date().toISOString();
      await input.sink.markCancelled?.(input.row.id, messageOf(error));
      await emitStep(stepEvent("cancel", "cancelled", at, { failureKind, errorMessage: messageOf(error) }));
      const event: TaskLifecycleEvent = { ...base, event: "cancel", status: "cancelled", failureKind, errorMessage: messageOf(error), at };
      await emit(event, input.hooks?.onError);
      return { status: "cancelled", failureKind };
    }
    const at = new Date().toISOString();
    await input.sink.markFailed?.(input.row.id, messageOf(error), failureKind);
    await emitStep(stepEvent("error", "failed", at, { failureKind, errorMessage: messageOf(error) }));
    const event: TaskLifecycleEvent = { ...base, event: "error", status: "failed", failureKind, errorMessage: messageOf(error), at };
    await emit(event, input.hooks?.onError);
    throw normalized;
  } finally {
    if (pollTimer) clearInterval(pollTimer);
  }
}
