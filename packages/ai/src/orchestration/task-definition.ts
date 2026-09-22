import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

import { runTaskWithLifecycle } from "./lifecycle";
import type { TaskStepCheckpoint, WorkflowTaskSink } from "./types";

export type DomainTaskContext = {
  signal: AbortSignal;
  taskRunId: string;
  workflowId?: string;
  stepId: string;
  retryCount: number;
  attempt: number;
  checkpoint: TaskStepCheckpoint;
  checkCancellation: () => Promise<void>;
  projectAiUsage?: (usage: unknown) => Promise<void>;
};

export type DomainTaskStage = {
  id: string;
  idempotent?: boolean;
  execute: (input: unknown, context: DomainTaskContext) => Promise<unknown>;
};

export type DomainTaskDefinition = {
  kind: string;
  inputSchema?: z.ZodType;
  outputSchema?: z.ZodType;
  stages: DomainTaskStage[];
  validate?: (output: unknown) => Promise<void> | void;
  effects?: string[];
  checkpoint?: string;
  metrics?: string[];
};

/**
 * Declarative task contract. It is intentionally framework-neutral so domain
 * modules can describe ownership without importing Mastra directly.
 */
export function createDomainTask(definition: DomainTaskDefinition): DomainTaskDefinition {
  if (!definition.kind.trim()) throw new Error("Domain task kind is required.");
  if (definition.stages.length === 0) throw new Error(`Domain task ${definition.kind} needs at least one stage.`);
  const ids = new Set<string>();
  for (const stage of definition.stages) {
    if (!stage.id.trim() || ids.has(stage.id)) throw new Error(`Duplicate or empty stage id in ${definition.kind}.`);
    ids.add(stage.id);
  }
  return {
    ...definition,
    inputSchema: definition.inputSchema ?? z.unknown(),
    outputSchema: definition.outputSchema ?? z.unknown(),
    stages: definition.stages.map((stage) => ({ ...stage, idempotent: stage.idempotent ?? false })),
  };
}

/**
 * Mastra adapter for declarative tasks. Domain effects/checkpoints stay in the
 * stage implementation; the adapter only carries the stage chain.
 */
export function createDomainTaskWorkflow(definition: DomainTaskDefinition) {
  const task = createDomainTask(definition);
  let workflow = createWorkflow({
    id: task.kind,
    description: `Infinitum domain task ${task.kind}`,
    inputSchema: z.object({ taskRunId: z.string(), payload: z.unknown() }),
    outputSchema: z.object({ payload: z.unknown() }),
    retryConfig: { attempts: 1 },
  });

  for (const stage of task.stages) {
    const step = createStep({
      id: `${task.kind}-${stage.id}`,
      inputSchema: z.object({ taskRunId: z.string(), payload: z.unknown() }),
      outputSchema: z.object({ taskRunId: z.string(), payload: z.unknown() }),
      execute: async ({ inputData, abortSignal, runId, retryCount }) => {
        const stepId = `${task.kind}-${stage.id}`;
        const context: DomainTaskContext = {
          signal: abortSignal ?? new AbortController().signal,
          taskRunId: inputData.taskRunId,
          workflowId: task.kind,
          stepId,
          retryCount: retryCount ?? 0,
          attempt: 1,
          checkpoint: {
            version: 1,
            taskRunId: inputData.taskRunId,
            workflowId: task.kind,
            workflowRunId: runId,
            stepId,
            attempt: 1,
            retryCount: retryCount ?? 0,
            status: "running",
            startedAt: new Date().toISOString(),
          },
          checkCancellation: async () => {
            if (abortSignal?.aborted) throw new Error("Task aborted");
          },
        };
        const payload = await stage.execute(inputData.payload, context);
        return { taskRunId: inputData.taskRunId, payload };
      },
    });
    workflow = workflow.then(step) as typeof workflow;
  }

  return workflow.commit();
}

/**
 * Host adapter for domain declarations backed by a BackgroundTaskRun. Each
 * declared stage is a persisted Mastra step; the sink/lifecycle wrapper owns
 * cancellation and terminal projection, while the domain stage owns effects.
 */
export function createDomainTaskRunWorkflow(input: {
  definition: DomainTaskDefinition;
  sink: WorkflowTaskSink;
}) {
  const task = createDomainTask(input.definition);
  const taskInputSchema = z.object({ taskRunId: z.string(), payload: z.unknown().optional() });
  const taskOutputSchema = z.object({ taskRunId: z.string(), status: z.string(), payload: z.unknown().optional() });
  let workflow = createWorkflow({
    id: task.kind,
    description: `Infinitum declarative domain task ${task.kind}`,
    inputSchema: taskInputSchema,
    outputSchema: taskOutputSchema,
    retryConfig: { attempts: 1 },
  });

  task.stages.forEach((stage, index) => {
    const step = createStep({
      id: `${task.kind}-${stage.id}`,
      inputSchema: taskInputSchema,
      outputSchema: taskOutputSchema,
      execute: async ({ inputData, abortSignal, runId, retryCount }) => {
        const row = await input.sink.getTaskRun(inputData.taskRunId);
        if (!row) return { taskRunId: inputData.taskRunId, status: "missing", payload: inputData.payload };
        let stagePayload: unknown = inputData.payload === undefined ? row : inputData.payload;
        const result = await runTaskWithLifecycle({
          row,
          sink: input.sink,
          signal: abortSignal,
          workflowId: task.kind,
          stepId: `${task.kind}-${stage.id}`,
          runId,
          retryCount,
          terminal: index === task.stages.length - 1,
          startLifecycle: index === 0,
          finishLifecycle: index === task.stages.length - 1,
          cancelPollMs: 1_000,
          body: async (taskRun, context) => {
            const domainContext: DomainTaskContext = {
              signal: context!.signal,
              taskRunId: inputData.taskRunId,
              workflowId: task.kind,
              stepId: `${task.kind}-${stage.id}`,
              retryCount: context!.retryCount,
              attempt: context!.attempt,
              checkpoint: context!.checkpoint,
              checkCancellation: context!.checkCancellation,
              projectAiUsage: async (usage) => input.sink.projectAiUsage?.(inputData.taskRunId, usage, {
                stepId: `${task.kind}-${stage.id}`,
                workflowId: task.kind,
                workflowRunId: context!.runId,
                attempt: context!.attempt,
                retryCount: context!.retryCount,
              }),
            };
            stagePayload = await stage.execute(stagePayload, domainContext);
            await input.sink.projectCheckpoint?.(inputData.taskRunId, {
              __mastra: {
                stage: stage.id,
                checkpoint: domainContext.checkpoint,
              },
            });
          },
        });
        return { taskRunId: inputData.taskRunId, status: result.status, payload: stagePayload };
      },
    });
    workflow = workflow.then(step) as unknown as typeof workflow;
  });
  return workflow.commit();
}
