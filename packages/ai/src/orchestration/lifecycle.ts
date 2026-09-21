import { classifyTaskError, isCancellationError, toTaskExecutionError, type TaskFailureKind } from "./errors";
import type { TaskBody, TaskRunSnapshot, WorkflowTaskSink } from "./types";

export type TaskExecutionContext = {
  readonly signal: AbortSignal;
  readonly runId?: string;
  readonly attempt: number;
  readonly checkCancellation: () => Promise<void>;
};

export type TaskLifecycleEvent = {
  taskRunId: string;
  runId?: string;
  kind: string;
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
  /** Staged workflows keep the task running between business stages. */
  terminal?: boolean;
  startLifecycle?: boolean;
  finishLifecycle?: boolean;
}): Promise<{ status: "succeeded" | "failed" | "partial" | "cancelled"; failureKind?: TaskFailureKind }> {
  const attempt = input.attempt ?? 1;
  const controller = createAbortController(input.signal);
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
    attempt,
  };

  const terminal = input.terminal ?? true;
  const startLifecycle = input.startLifecycle ?? true;
  const finishLifecycle = input.finishLifecycle ?? terminal;
  if (startLifecycle) {
    await input.sink.markStarted?.(input.row.id, input.runId);
    await emit({ ...base, event: "start", status: "running", at: new Date().toISOString() }, input.hooks?.onStart);
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
      attempt,
      checkCancellation,
    });
    await checkCancellation();
    if (!terminal) return { status: "succeeded" };
    const after = await input.sink.getTaskRun(input.row.id);
    if (after?.status === "cancelled") {
      const event: TaskLifecycleEvent = { ...base, event: "cancel", status: "cancelled", failureKind: "canceled", at: new Date().toISOString() };
      await emit(event, input.hooks?.onError);
      return { status: "cancelled", failureKind: "canceled" };
    }
    if (after?.status === "failed" || after?.status === "partial") {
      const status = after.status as "failed" | "partial";
      const event: TaskLifecycleEvent = { ...base, event: "finish", status, at: new Date().toISOString() };
      await emit(event, input.hooks?.onFinish);
      return { status };
    }
    await checkCancellation();
    await input.sink.markSucceeded?.(input.row.id, input.runId);
    if (finishLifecycle) {
      await emit({ ...base, event: "finish", status: "succeeded", at: new Date().toISOString() }, input.hooks?.onFinish);
    }
    return { status: "succeeded" };
  } catch (error) {
    const normalized = toTaskExecutionError(error);
    const failureKind = isCancellationError(error) ? "canceled" : classifyTaskError(normalized);
    if (failureKind === "canceled") {
      await input.sink.markCancelled?.(input.row.id, messageOf(error));
      const event: TaskLifecycleEvent = { ...base, event: "cancel", status: "cancelled", failureKind, errorMessage: messageOf(error), at: new Date().toISOString() };
      await emit(event, input.hooks?.onError);
      return { status: "cancelled", failureKind };
    }
    await input.sink.markFailed?.(input.row.id, messageOf(error), failureKind);
    const event: TaskLifecycleEvent = { ...base, event: "error", status: "failed", failureKind, errorMessage: messageOf(error), at: new Date().toISOString() };
    await emit(event, input.hooks?.onError);
    throw normalized;
  } finally {
    if (pollTimer) clearInterval(pollTimer);
  }
}
