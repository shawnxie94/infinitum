import fs from "node:fs";

import { prisma } from "../../../src/lib/db";
import { createAiRuntime, restartActiveWorkflowRuns } from "../../../packages/ai/src/orchestration/runtime";
import {
  createDomainTask,
  createDomainTaskRunWorkflow,
} from "../../../packages/ai/src/orchestration/task-definition";
import type {
  TaskRunSnapshot,
  TaskStepLifecycleEvent,
  WorkflowTaskSink,
} from "../../../packages/ai/src/orchestration/types";
import { recoverWorkerStartupTasks } from "../../../src/lib/tasks/worker";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Crash-recovery test environment is missing ${name}.`);
  return value;
}

const taskRunId = requiredEnvironment("CRASH_TEST_TASK_ID");
const markerPath = requiredEnvironment("CRASH_TEST_MARKER");
const mode = requiredEnvironment("CRASH_TEST_MODE");

function incrementMarker(attempt: number) {
  let marker: { calls: number; attempts: number[] } = { calls: 0, attempts: [] };
  if (fs.existsSync(markerPath)) marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as typeof marker;
  marker.calls += 1;
  marker.attempts.push(attempt);
  fs.writeFileSync(markerPath, JSON.stringify(marker));
  return marker;
}

const sink: WorkflowTaskSink = {
  async getTaskRun(id) {
    const row = await prisma.backgroundTaskRun.findUnique({ where: { id } });
    return (row as unknown as TaskRunSnapshot) ?? null;
  },
  async isCancellationRequested(id) {
    const row = await prisma.backgroundTaskRun.findUnique({ where: { id }, select: { cancelRequestedAt: true } });
    return row?.cancelRequestedAt != null;
  },
  async markStarted(id) {
    await prisma.backgroundTaskRun.updateMany({
      where: { id, status: "queued" },
      data: { status: "running", startedAt: new Date() },
    });
  },
  async markSucceeded(id) {
    await prisma.backgroundTaskRun.updateMany({
      where: { id, status: { in: ["queued", "running"] } },
      data: { status: "succeeded", finishedAt: new Date() },
    });
  },
  async markCancelled(id, message) {
    await prisma.backgroundTaskRun.updateMany({
      where: { id, status: { in: ["queued", "running"] } },
      data: { status: "cancelled", errorSummary: message ?? "cancelled", finishedAt: new Date() },
    });
  },
  async markFailed(id, message) {
    await prisma.backgroundTaskRun.updateMany({
      where: { id, status: { in: ["queued", "running"] } },
      data: { status: "failed", errorSummary: message, finishedAt: new Date() },
    });
  },
  async projectStep(event: TaskStepLifecycleEvent) {
    const row = await prisma.backgroundTaskRun.findUnique({ where: { id: event.taskRunId }, select: { pipelineCheckpointJson: true } });
    let checkpoint: Record<string, unknown> = {};
    try {
      checkpoint = row?.pipelineCheckpointJson ? JSON.parse(row.pipelineCheckpointJson) as Record<string, unknown> : {};
    } catch {
      checkpoint = {};
    }
    const mastra = checkpoint.__mastra && typeof checkpoint.__mastra === "object"
      ? checkpoint.__mastra as Record<string, unknown>
      : {};
    await prisma.backgroundTaskRun.update({
      where: { id: event.taskRunId },
      data: {
        pipelineCheckpointJson: JSON.stringify({
          ...checkpoint,
          __mastra: { ...mastra, step: event.checkpoint, lifecycle: event },
        }),
      },
    });
  },
};

async function main() {
  if (mode === "start") {
    await prisma.backgroundTaskRun.create({
      data: {
        id: taskRunId,
        kind: "item_cleanup",
        triggerType: "manual",
        status: "queued",
        label: "Mastra crash recovery fixture",
      },
    });
  }

  const definition = createDomainTask({
    kind: "item_cleanup",
    stages: [{
      id: "crash_boundary",
      replayPolicy: "at_least_once",
      execute: async (_input, context) => {
        incrementMarker(context.attempt);
        if (mode === "start") await new Promise<void>(() => {});
        return { resumed: mode === "recover" };
      },
    }],
  });
  const workflow = createDomainTaskRunWorkflow({ definition, sink });
  const runtime = createAiRuntime({ workflows: { item_cleanup: workflow } });
  try {
    if (mode === "start") {
      const run = await runtime.mastra.getWorkflow("item_cleanup").createRun();
      void run.start({ inputData: { taskRunId } }).catch(() => undefined);
      const heartbeat = setInterval(() => process.stdout.write("waiting-for-crash\n"), 1_000);
      heartbeat.unref();
      await new Promise<void>(() => {});
    }
    if (mode === "recover") {
      await recoverWorkerStartupTasks(new Date(), () => restartActiveWorkflowRuns(runtime));
      const row = await prisma.backgroundTaskRun.findUniqueOrThrow({ where: { id: taskRunId } });
      if (row.status !== "succeeded") throw new Error(`Expected succeeded task, got ${row.status}.`);
      process.stdout.write("recovery-complete\n");
    } else {
      throw new Error(`Unknown crash-recovery mode: ${mode}`);
    }
  } finally {
    await runtime.shutdown();
    await prisma.$disconnect();
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
