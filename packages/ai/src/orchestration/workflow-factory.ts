/**
 * 任务 workflow 工厂（spec P1b/P2/P3/P4，D1 粗步幅方案）：
 * 一个 task kind = 一个托管 step，业务体（含阶段循环/修复/检查点恢复）整体在步内执行——
 * 进程级崩溃恢复由 Mastra（restartAllActiveWorkflowRuns）承接，阶段级恢复沿用业务体
 * 内置的 BackgroundTaskRun 检查点（四件套 guard 已在其中实现，D2）。
 * 取消走跨进程 cancelRequestedAt flag（业务体内已轮询，D7 主路径）。
 */
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

import { runTaskWithLifecycle, type TaskExecutionContext } from "./lifecycle";
import type { TaskBody, TaskRunSnapshot, WorkflowTaskSink } from "./types";

const inputSchema = z.object({ taskRunId: z.string() });
const outputSchema = z.object({ status: z.string() });

export function createTaskRunWorkflow(input: {
  id: string;
  description?: string;
  body: TaskBody;
  sink: WorkflowTaskSink;
}) {
  const step = createStep({
    id: `${input.id}-execute`,
    inputSchema,
    outputSchema,
    execute: async ({ inputData, abortSignal, runId, retryCount }) => {
      const row = await input.sink.getTaskRun(inputData.taskRunId);
      if (!row) {
        return { status: "missing" };
      }
      const result = await runTaskWithLifecycle({
        row,
        body: input.body,
        sink: input.sink,
        signal: abortSignal,
        workflowId: input.id,
        stepId: `${input.id}-execute`,
        runId,
        retryCount,
        cancelPollMs: 1_000,
      });
      return { status: result.status };
    },
  });

  return createWorkflow({
    id: input.id,
    description: input.description,
    inputSchema,
    outputSchema,
    // 业务体内部已有瞬态重试/修复循环；步级不自动重试，避免副作用翻倍。
    retryConfig: { attempts: 1 },
  })
    .then(step)
    .commit();
}

export type TaskWorkflowStage = {
  id: string;
  body: (taskRun: TaskRunSnapshot, context: TaskExecutionContext) => Promise<void>;
};

/**
 * Compatibility contract for domain services that still own a coupled
 * multi-phase transaction. The boundary names are metadata only: the service
 * body is deliberately invoked once, so adapting it to a staged workflow
 * cannot repeat AI/DB side effects. Callers must not present these boundaries
 * as independently resumable until the service supplies stage-local state.
 */
export type MonolithicStageAdapter = {
  boundaries: readonly string[];
  body: TaskBody;
};

export function createMonolithicStageAdapter(input: {
  id: string;
  description?: string;
  adapter: MonolithicStageAdapter;
  sink: WorkflowTaskSink;
}) {
  if (input.adapter.boundaries.length === 0) {
    throw new Error(`${input.id} needs at least one declared boundary.`);
  }
  const uniqueBoundaries = new Set(input.adapter.boundaries);
  if (uniqueBoundaries.size !== input.adapter.boundaries.length) {
    throw new Error(`${input.id} has duplicate declared boundaries.`);
  }

  const boundaryDescription = `declared boundaries: ${input.adapter.boundaries.join(", ")}`;
  return createStagedTaskRunWorkflow({
    id: input.id,
    description: [input.description, boundaryDescription].filter(Boolean).join("; "),
    // One Mastra step is intentional. The legacy service is not safely
    // split yet; the contract keeps its existing phase names visible without
    // pretending that a retry can resume between them.
    stages: [{ id: "execute", body: input.adapter.body }],
    sink: input.sink,
  });
}

/**
 * Multi-step variant used by P10. Each business stage persists its own Mastra
 * snapshot while BackgroundTaskRun remains running until the final stage.
 */
export function createStagedTaskRunWorkflow(input: {
  id: string;
  description?: string;
  stages: readonly TaskWorkflowStage[];
  sink: WorkflowTaskSink;
}) {
  if (input.stages.length === 0) throw new Error(`${input.id} needs at least one workflow stage.`);
  const stagedOutputSchema = z.object({ taskRunId: z.string(), status: z.string() });
  let workflow = createWorkflow({
    id: input.id,
    description: input.description,
    inputSchema,
    outputSchema: stagedOutputSchema,
    retryConfig: { attempts: 1 },
  });
  input.stages.forEach((stage, index) => {
    const step = createStep({
      id: `${input.id}-${stage.id}`,
      inputSchema,
      outputSchema: stagedOutputSchema,
      execute: async ({ inputData, abortSignal, runId, retryCount }) => {
        const row = await input.sink.getTaskRun(inputData.taskRunId);
        if (!row) return { taskRunId: inputData.taskRunId, status: "missing" };
        const result = await runTaskWithLifecycle({
          row,
          body: (taskRun, context) => stage.body(taskRun, context!),
          sink: input.sink,
          signal: abortSignal,
          workflowId: input.id,
          stepId: `${input.id}-${stage.id}`,
          runId,
          retryCount,
          terminal: index === input.stages.length - 1,
          startLifecycle: index === 0,
          finishLifecycle: index === input.stages.length - 1,
          cancelPollMs: 1_000,
        });
        return { taskRunId: inputData.taskRunId, status: result.status };
      },
    });
    workflow = workflow.then(step) as unknown as typeof workflow;
  });
  return workflow.commit();
}

export async function startTaskWorkflow(workflow: {
  createRun: (options?: { runId?: string }) => Promise<{
    runId: string;
    start: (args: { inputData: { taskRunId: string } }) => Promise<unknown>;
  }>;
  id: string;
}, taskRunId: string): Promise<{ runId: string; status: string }> {
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

export type { TaskBody, TaskRunSnapshot, WorkflowTaskSink };
