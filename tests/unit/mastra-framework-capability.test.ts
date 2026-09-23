import { describe, expect, it } from "vitest";

import { createMemorySingleFlight } from "../../packages/ai/src/orchestration/single-flight";
import { runTaskWithLifecycle } from "../../packages/ai/src/orchestration/lifecycle";
import { TaskCancellationError } from "../../packages/ai/src/orchestration/errors";
import { createDomainTask } from "../../packages/ai/src/orchestration/task-definition";
import { createUsageInterceptor } from "../../packages/ai/src/provider/usage";
import type { TaskRunSnapshot, WorkflowTaskSink } from "../../packages/ai/src/orchestration/types";
import { TASK_DEFINITIONS } from "../../src/lib/tasks/definitions";
import { getAiRuntime, isWorkflowKind } from "../../src/lib/ai-orchestration/runtime";
import {
  buildDailyReportStageIdentity,
  DAILY_REPORT_WORKFLOW_STAGES,
} from "../../src/lib/daily-report/generation";
import { WORKFLOW_TASK_DEFINITIONS } from "@/lib/workflows/catalog";
import { parseTaskWorkflowCheckpointJson } from "../../src/lib/tasks/checkpoint";

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
  const stepEvents: string[] = [];
  const sink: WorkflowTaskSink = {
    getTaskRun: async () => row,
    isCancellationRequested: async () => false,
    markStarted: async () => { events.push("started"); },
    markSucceeded: async () => { events.push("succeeded"); },
    markCancelled: async () => { events.push("cancelled"); },
    markFailed: async (_id, _message, kind) => { events.push(`failed:${kind}`); },
    projectLifecycle: async (event) => { events.push(event.event); },
    projectStep: async (event) => { stepEvents.push(`${event.stepId}:${event.event}:${event.status}`); },
    ...overrides,
  };
  return { sink, events, stepEvents };
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

  it("increments the step attempt after replay from a persisted checkpoint", async () => {
    const { sink } = createSink();
    const replayRow: TaskRunSnapshot = {
      ...row,
      pipelineCheckpointJson: JSON.stringify({
        __mastra: { step: { stepId: "daily_report_generate-write", attempt: 2 } },
      }),
    };
    let observedAttempt = 0;

    await runTaskWithLifecycle({
      row: replayRow,
      sink,
      stepId: "daily_report_generate-write",
      body: async (_input, context) => { observedAttempt = context?.attempt ?? 0; },
    });

    expect(observedAttempt).toBe(3);
  });

  it("projects successful lifecycle and passes an abort-aware context", async () => {
    const { sink, events, stepEvents } = createSink();
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
    expect(stepEvents).toEqual([
      "daily_report_generate-task:start:running",
      "daily_report_generate-task:finish:succeeded",
    ]);
    expect(stepEvents.every((event) => event.includes("generate-task"))).toBe(true);
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

  it("projects the existing Mastra stage identity into daily-report AI attribution", () => {
    expect(buildDailyReportStageIdentity("task-1", {
      stepId: "daily_report_generate-assess",
      workflowId: "daily_report_generate",
      runId: "workflow-run-1",
    })).toEqual({
      stepId: "daily_report_generate-assess",
      workflowId: "daily_report_generate",
      workflowRunId: "workflow-run-1",
      taskRunId: "task-1",
    });
  });

  it("routes ingestion and recovery through Mastra workflows", () => {
    const runtime = getAiRuntime();

    expect(runtime.mastra.getWorkflow("ingestion")).toBeDefined();
    expect(runtime.mastra.getWorkflow("item_processing_recovery")).toBeDefined();
  });

  it("routes every declared BackgroundTaskRun kind through the workflow catalog", () => {
    for (const definition of TASK_DEFINITIONS) {
      expect(isWorkflowKind(definition.kind)).toBe(true);
    }
  });

  it("keeps framework checkpoints visible without confusing them with resumable pipelines", () => {
    const checkpoint = parseTaskWorkflowCheckpointJson(JSON.stringify({
      __mastra: { stage: "writeback", lifecycle: { status: "succeeded" } },
    }));
    expect(checkpoint).toEqual({
      version: 1,
      mastra: { stage: "writeback", lifecycle: { status: "succeeded" } },
    });
  });

  it("keeps every BackgroundTaskRun kind covered by one declarative host definition", () => {
    expect(TASK_DEFINITIONS).toHaveLength(11);
    expect(TASK_DEFINITIONS.every((definition) => definition.mode === "workflow")).toBe(true);
    expect(new Set(TASK_DEFINITIONS.map((definition) => definition.kind)).size).toBe(11);
    for (const workflowDefinition of Object.values(WORKFLOW_TASK_DEFINITIONS)) {
      expect(workflowDefinition).toBeDefined();
      expect(workflowDefinition!.stages.every((stage) => ["replay_safe", "at_least_once", "business_checkpointed"].includes(stage.replayPolicy ?? ""))).toBe(true);
      expect(TASK_DEFINITIONS.find((definition) => definition.kind === workflowDefinition!.kind)?.stageReplayPolicies).toEqual(
        Object.fromEntries(workflowDefinition!.stages.map((stage) => [stage.id, stage.replayPolicy])),
      );
    }
    expect(TASK_DEFINITIONS.find((definition) => definition.kind === "daily_report_generate")?.stages).toEqual([
      ...DAILY_REPORT_WORKFLOW_STAGES,
    ]);
    expect(Object.keys(WORKFLOW_TASK_DEFINITIONS).sort()).toEqual(TASK_DEFINITIONS.map((definition) => definition.kind).sort());
    expect(WORKFLOW_TASK_DEFINITIONS.ingestion?.stages.map((stage) => stage.id)).toEqual([
      "source_sync", "item_processing", "cluster_merge", "cluster_finalize",
    ]);
    expect(WORKFLOW_TASK_DEFINITIONS.item_processing_recovery?.stages.map((stage) => stage.id)).toEqual([
      "recovery_batch", "recovery_persist",
    ]);
    for (const definition of Object.values(WORKFLOW_TASK_DEFINITIONS)) {
      expect(definition.stages.length).toBeGreaterThanOrEqual(1);
      expect(definition.stages.every((stage) => typeof stage.execute === "function")).toBe(true);
    }
    expect(WORKFLOW_TASK_DEFINITIONS.item_regenerate_translation!.stages.map((stage) => stage.id)).toEqual([
      "read", "ai_call", "validate", "writeback",
    ]);
    expect(WORKFLOW_TASK_DEFINITIONS.item_regenerate_summary!.stages.map((stage) => stage.id)).toEqual([
      "read", "ai_call", "validate", "writeback",
    ]);
    expect(WORKFLOW_TASK_DEFINITIONS.item_cleanup!.stages.map((stage) => stage.id)).toEqual([
      "read", "delete", "cluster_finalize",
    ]);
    expect(WORKFLOW_TASK_DEFINITIONS.cluster_regenerate_summary!.stages.map((stage) => stage.id)).toEqual([
      "read", "ai_call", "writeback",
    ]);
    expect(WORKFLOW_TASK_DEFINITIONS.cluster_merge_precompute_clean_pairs!.stages.map((stage) => stage.id)).toEqual([
      "read", "compute", "writeback",
    ]);
    expect(WORKFLOW_TASK_DEFINITIONS.item_reanalyze!.stages.map((stage) => stage.id)).toEqual([
      "read", "ai_call", "validate", "writeback",
    ]);
    expect(WORKFLOW_TASK_DEFINITIONS.item_reparse_aggregations!.stages.map((stage) => stage.id)).toEqual([
      "read", "ai_call", "cluster_finalize",
    ]);
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
