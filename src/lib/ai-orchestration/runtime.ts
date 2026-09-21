import type { BackgroundTaskRun } from "@prisma/client";

import { prisma } from "@/lib/db";
import { runIngestionTask } from "@/lib/ingestion/service";
import { executeItemProcessingRecoveryTask } from "@/lib/items/processing-recovery";
import { executeDailyReportTask } from "@/lib/daily-report/generation";
import { createAiRuntime, restartActiveWorkflowRuns, type AiRuntime } from "@infinitum/ai/orchestration/runtime";
import { createTaskRunWorkflow, type TaskBody, type WorkflowTaskSink } from "@infinitum/ai/orchestration/workflow-factory";

/**
 * 主仓侧编排接线（spec P1b-P4/D11）：
 * - sink 把 BackgroundTaskRun 读写映射给 packages/ai（依赖倒置，D9 所有权边界）
 * - 三个 AI 批量 kind 的 workflow 业务体 = 原 handler 执行体（状态簿记/取消轮询/检查点恢复语义不变）
 * - runtime 单例：Next.js 与 worker 进程各自内嵌（D11），共享 SQLite 存储
 */

type WorkflowKind = "daily_report_generate" | "ingestion" | "item_processing_recovery";

const WORKFLOW_KINDS: Record<WorkflowKind, TaskBody> = {
  daily_report_generate: executeDailyReportTask as unknown as TaskBody,
  ingestion: runIngestionTask as unknown as TaskBody,
  item_processing_recovery: executeItemProcessingRecoveryTask as unknown as TaskBody,
};

const sink: WorkflowTaskSink = {
  async getTaskRun(taskRunId) {
    // 返回完整行：执行体及其下游（timeline/进度等）会消费 startedAt 等投影外字段
    const row = await prisma.backgroundTaskRun.findUnique({
      where: { id: taskRunId },
    });
    return (row as unknown as BackgroundTaskRun) ?? null;
  },
  async markFailed(taskRunId, message) {
    // D6 终态兜底：业务体在写入自身终态前崩溃时，避免 BackgroundTaskRun 卡 running
    await prisma.backgroundTaskRun.updateMany({
      where: { id: taskRunId, status: { in: ["queued", "running"] } },
      data: {
        status: "failed",
        finishedAt: new Date(),
        errorSummary: message.slice(0, 500),
      },
    });
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
      Object.entries(WORKFLOW_KINDS).map(([kind, body]) => [
        kind,
        createTaskRunWorkflow({
          id: kind,
          description: `Infinitum ${kind} (Mastra migration)`,
          body,
          sink,
        }),
      ]),
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
  return kind in WORKFLOW_KINDS;
}
