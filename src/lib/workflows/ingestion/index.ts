import type { BackgroundTaskRun } from "@prisma/client";

import { createDomainTask, type DomainTaskDefinition } from "@infinitum/ai/orchestration/task-definition";
import { executeIngestionWorkflowStage, type IngestionWorkflowStage } from "@/lib/ingestion/workflow-stages";
import { executeRecoveryWorkflowStage } from "@/lib/items/recovery-workflow-stages";

export function createIngestionWorkflowDefinition(): DomainTaskDefinition {
  const stages: IngestionWorkflowStage[] = ["source_sync", "item_processing", "cluster_merge", "cluster_finalize"];
  return createDomainTask({
    kind: "ingestion",
    stages: stages.map((id) => ({
      id,
      replayPolicy: id === "cluster_finalize" ? "replay_safe" : "at_least_once",
      execute: async (input, context) => executeIngestionWorkflowStage(id, input, context),
    })),
    effects: ["item_write", "cluster_write", "embedding_write"],
    checkpoint: "pipelineCheckpointJson",
  });
}

export function createItemProcessingRecoveryWorkflowDefinition(): DomainTaskDefinition {
  return createDomainTask({
    kind: "item_processing_recovery",
    stages: (["recovery_batch", "recovery_persist"] as const).map((id) => ({
      id,
      replayPolicy: "at_least_once",
      execute: async (input, context) => executeRecoveryWorkflowStage(id, input, context),
    })),
    effects: ["item_write", "cluster_write"],
    checkpoint: "pipelineCheckpointJson",
  });
}

export const INGESTION_WORKFLOW_DEFINITIONS: Partial<Record<BackgroundTaskRun["kind"], DomainTaskDefinition>> = {
  ingestion: createIngestionWorkflowDefinition(),
  item_processing_recovery: createItemProcessingRecoveryWorkflowDefinition(),
};
