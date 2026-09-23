import type { BackgroundTaskRun } from "@prisma/client";

import { createDomainTask, type DomainTaskDefinition } from "@infinitum/ai/orchestration/task-definition";
import { executePrecomputeWorkflowStage, type PrecomputeWorkflowPayload } from "@/lib/precompute/service";

export function createPrecomputeWorkflowDefinition(): DomainTaskDefinition {
  const stages = ["cluster_merge_clean_pairs", "entity_alias_check", "entity_suggestion_candidates"] as const;
  return createDomainTask({
    kind: "precompute",
    stages: stages.map((id) => ({
      id,
      replayPolicy: "at_least_once",
      execute: async (input) => executePrecomputeWorkflowStage(id, (input as PrecomputeWorkflowPayload | undefined) ?? undefined),
    })),
    effects: ["entity_write", "embedding_write"],
    checkpoint: "pipelineCheckpointJson",
  });
}

export const PRECOMPUTE_WORKFLOW_DEFINITIONS: Partial<Record<BackgroundTaskRun["kind"], DomainTaskDefinition>> = {
  precompute: createPrecomputeWorkflowDefinition(),
};
