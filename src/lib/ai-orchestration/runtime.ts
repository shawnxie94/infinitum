import type { BackgroundTaskRun } from "@prisma/client";

import { prisma } from "@/lib/db";
import { DAILY_REPORT_WORKFLOW_STAGES, executeDailyReportWorkflowStage } from "@/lib/daily-report/generation";
import { HANDLER_TASK_DEFINITIONS, TASK_BODIES } from "@/lib/tasks/domain-bodies";
import { createAiRuntime, restartActiveWorkflowRuns, type AiRuntime } from "@infinitum/ai/orchestration/runtime";
import { createStagedTaskRunWorkflow, createTaskRunWorkflow, type TaskBody, type WorkflowTaskSink } from "@infinitum/ai/orchestration/workflow-factory";
import { createDomainTaskRunWorkflow } from "@infinitum/ai/orchestration/task-definition";
import type { TaskLifecycleEvent } from "@infinitum/ai/orchestration/lifecycle";

/**
 * 主仓侧编排接线（spec P1b-P4/D11）：
 * - sink 把 BackgroundTaskRun 读写映射给 packages/ai（依赖倒置，D9 所有权边界）
 * - 11 个 task kind 均由 Mastra workflow 承载；handler-mode kind 仍由 domain body 负责副作用
 *   （状态簿记/取消轮询/检查点恢复语义不变）
 * - runtime 单例：Next.js 与 worker 进程各自内嵌（D11），共享 SQLite 存储
 */

type WorkflowKind = BackgroundTaskRun["kind"];

const WORKFLOW_KINDS: Record<WorkflowKind, TaskBody> = TASK_BODIES;

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
      Object.entries(WORKFLOW_KINDS).map(([kind, body]) => [
        kind,
        kind === "daily_report_generate"
          ? createStagedTaskRunWorkflow({
              id: kind,
              description: `Infinitum ${kind} (Mastra staged workflow)`,
              stages: DAILY_REPORT_WORKFLOW_STAGES.map((stage) => ({
                id: stage,
                body: async (row) => executeDailyReportWorkflowStage(row as unknown as BackgroundTaskRun, stage),
              })),
              sink,
            })
          : HANDLER_TASK_DEFINITIONS[kind as keyof typeof HANDLER_TASK_DEFINITIONS]
            ? createDomainTaskRunWorkflow({
                definition: HANDLER_TASK_DEFINITIONS[kind as keyof typeof HANDLER_TASK_DEFINITIONS],
                sink,
              })
            : createTaskRunWorkflow({
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
