import { describe, expect, it } from "vitest";

import { createMemorySingleFlight } from "../../packages/ai/src/orchestration/single-flight";
import { runTaskWithLifecycle } from "../../packages/ai/src/orchestration/lifecycle";
import { TaskCancellationError } from "../../packages/ai/src/orchestration/errors";
import { createDomainTask } from "../../packages/ai/src/orchestration/task-definition";
import { createUsageInterceptor } from "../../packages/ai/src/provider/usage";
import type { TaskRunSnapshot, WorkflowTaskSink } from "../../packages/ai/src/orchestration/types";
import { TASK_DEFINITIONS } from "../../src/lib/tasks/definitions";

const row: TaskRunSnapshot = {
  id: "task-1",
  kind: "daily_report_generate",
  entityId: null,
  triggerType: "manual",
  pipelineCheckpointJson: null,
  status: "running",
};

function createSink(overrides: Partial<WorkflowTaskSink> = {}) {
  const events: string[] = [];
  const sink: WorkflowTaskSink = {
    getTaskRun: async () => row,
    isCancellationRequested: async () => false,
    markStarted: async () => { events.push("started"); },
    markSucceeded: async () => { events.push("succeeded"); },
    markCancelled: async () => { events.push("cancelled"); },
    markFailed: async (_id, _message, kind) => { events.push(`failed:${kind}`); },
    projectLifecycle: async (event) => { events.push(event.event); },
    ...overrides,
  };
  return { sink, events };
}

describe("framework capability evolution", () => {
  it("enforces one active lease per kind and releases only its owner", async () => {
    const singleFlight = createMemorySingleFlight();
    await expect(singleFlight.acquire("ingestion", "a")).resolves.toBe(true);
    await expect(singleFlight.acquire("ingestion", "b")).resolves.toBe(false);
    await singleFlight.release("ingestion", "b");
    await expect(singleFlight.acquire("ingestion", "b")).resolves.toBe(false);
    await singleFlight.release("ingestion", "a");
    await expect(singleFlight.acquire("ingestion", "b")).resolves.toBe(true);
  });

  it("projects successful lifecycle and passes an abort-aware context", async () => {
    const { sink, events } = createSink();
    let checked = false;
    const result = await runTaskWithLifecycle({
      row,
      sink,
      body: async (_task, context) => {
        expect(context?.signal.aborted).toBe(false);
        await context?.checkCancellation();
        checked = true;
      },
    });
    expect(result.status).toBe("succeeded");
    expect(checked).toBe(true);
    expect(events).toEqual(["started", "start", "succeeded", "finish"]);
  });

  it("maps cooperative cancellation to cancelled instead of failed", async () => {
    const { sink, events } = createSink({
      isCancellationRequested: async () => true,
    });
    const result = await runTaskWithLifecycle({
      row,
      sink,
      body: async () => {
        throw new Error("body should not run");
      },
    });
    expect(result.status).toBe("cancelled");
    expect(events).toContain("cancelled");
    expect(events).toContain("cancel");
    expect(events.some((event) => event.startsWith("failed:"))).toBe(false);
  });

  it("classifies failures and keeps the domain task contract declarative", async () => {
    const { sink, events } = createSink();
    await expect(runTaskWithLifecycle({
      row,
      sink,
      body: async () => {
        throw new TaskCancellationError("cancelled by domain");
      },
    })).resolves.toMatchObject({ status: "cancelled", failureKind: "canceled" });
    expect(events).toContain("cancelled");

    expect(() => createDomainTask({
      kind: "demo",
      stages: [{ id: "one", execute: async (input) => input }],
    })).not.toThrow();
    expect(() => createDomainTask({
      kind: "demo",
      stages: [
        { id: "one", execute: async (input) => input },
        { id: "one", execute: async (input) => input },
      ],
    })).toThrow(/Duplicate/);
  });

  it("keeps every BackgroundTaskRun kind covered by one declarative host definition", () => {
    expect(TASK_DEFINITIONS).toHaveLength(11);
    expect(TASK_DEFINITIONS.filter((definition) => definition.mode === "workflow").map((definition) => definition.kind)).toEqual([
      "daily_report_generate",
      "ingestion",
      "item_processing_recovery",
    ]);
    expect(new Set(TASK_DEFINITIONS.map((definition) => definition.kind)).size).toBe(11);
  });

  it("separates usage by task label and retry taxonomy", () => {
    const usage = createUsageInterceptor();
    usage.record({ usageKey: "daily_report", attemptType: "initial", promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    usage.record({ usageKey: "daily_report", attemptType: "json_retry", promptTokens: 11, completionTokens: 4, totalTokens: 15 });
    usage.record({ usageKey: "daily_report", attemptType: "structured_fallback", promptTokens: 9, completionTokens: 3, totalTokens: 12 });
    expect(usage.summary()).toMatchObject({ calls: 3, byAttempt: { initial: 1, json_retry: 1, structured_fallback: 1 } });
    expect(usage.summary().byKey.daily_report.totalTokens).toBe(42);
  });
});
