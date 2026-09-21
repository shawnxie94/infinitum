import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

export type DomainTaskContext = {
  signal: AbortSignal;
  taskRunId: string;
  attempt: number;
  checkCancellation: () => Promise<void>;
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
      execute: async ({ inputData, abortSignal }) => {
        const context: DomainTaskContext = {
          signal: abortSignal ?? new AbortController().signal,
          taskRunId: inputData.taskRunId,
          attempt: 1,
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
