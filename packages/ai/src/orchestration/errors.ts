export type TaskFailureKind =
  | "business"
  | "canceled"
  | "transient"
  | "context_overflow"
  | "unknown";

export class TaskExecutionError extends Error {
  readonly kind: TaskFailureKind;
  readonly retryable: boolean;

  constructor(message: string, options: { kind: TaskFailureKind; retryable?: boolean; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "TaskExecutionError";
    this.kind = options.kind;
    this.retryable = options.retryable ?? false;
  }
}

export class TaskCancellationError extends TaskExecutionError {
  constructor(message = "Task cancelled", cause?: unknown) {
    super(message, { kind: "canceled", cause });
    this.name = "TaskCancellationError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function classifyTaskError(error: unknown): TaskFailureKind {
  if (error instanceof TaskExecutionError) return error.kind;
  if (error instanceof Error && error.name === "AbortError") return "canceled";
  const message = errorMessage(error);
  if (/cancel|abort|取消|终止/iu.test(message)) return "canceled";
  if (/context\s*(length|window|limit)|maximum\s+context|too\s+many\s+tokens|token\s+limit|上下文.{0,8}(超|限制)|令牌.{0,8}(超|限制)/iu.test(message)) {
    return "context_overflow";
  }
  if (/timeout|timed out|network|fetch failed|429|500|502|503|504|temporar|瞬时|超时|网络/iu.test(message)) {
    return "transient";
  }
  if (error instanceof Error) return "business";
  return "unknown";
}

export function toTaskExecutionError(error: unknown): TaskExecutionError {
  if (error instanceof TaskExecutionError) return error;
  const kind = classifyTaskError(error);
  return new TaskExecutionError(errorMessage(error), { kind, retryable: kind === "transient", cause: error });
}

export function isCancellationError(error: unknown): boolean {
  return classifyTaskError(error) === "canceled";
}
