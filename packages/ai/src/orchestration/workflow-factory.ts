/**
 * 任务 workflow 工厂（spec P1b/P2/P3/P4，D1 粗步幅方案）：
 * 一个 task kind = 一个托管 step，业务体（含阶段循环/修复/检查点恢复）整体在步内执行——
 * 进程级崩溃恢复由 Mastra（restartAllActiveWorkflowRuns）承接，阶段级恢复沿用业务体
 * 内置的 BackgroundTaskRun 检查点（四件套 guard 已在其中实现，D2）。
 * 取消走跨进程 cancelRequestedAt flag（业务体内已轮询，D7 主路径）。
 */
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

import { runTaskWithLifecycle } from "./lifecycle";
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
    execute: async ({ inputData, abortSignal }) => {
      const row = await input.sink.getTaskRun(inputData.taskRunId);
      if (!row) {
        return { status: "missing" };
      }
      const result = await runTaskWithLifecycle({
        row,
        body: input.body,
        sink: input.sink,
        signal: abortSignal,
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
