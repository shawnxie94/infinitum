import { createDomainTask } from "@infinitum/ai/orchestration/task-definition";
import type { BackgroundTaskRunKind } from "@/lib/tasks/types";

export type TaskExecutionMode = "workflow" | "handler";
export type TaskStageExecution = "staged" | "monolithic_boundary_adapter";

export type TaskDefinition = {
  kind: BackgroundTaskRunKind;
  mode: TaskExecutionMode;
  stageExecution?: TaskStageExecution;
  stages: readonly string[];
  effects: readonly string[];
  checkpoint?: string;
};

/**
 * Host-owned task catalog. Framework code executes every declared task through
 * the Mastra workflow adapter; mode remains the policy label for the domain
 * implementation shape. Domain modules own stage implementations and effects.
 */
export const TASK_DEFINITIONS: readonly TaskDefinition[] = [
  {
    kind: "daily_report_generate",
    mode: "workflow",
    stageExecution: "staged",
    stages: ["prepare", "assess", "merge", "plan", "plan_validate", "write", "validate", "repair", "review", "persist_publish"],
    effects: ["daily_report_revision", "daily_report_publish"],
    checkpoint: "pipelineCheckpointJson",
  },
  {
    kind: "ingestion",
    mode: "workflow",
    // The service still couples these phases through in-memory state. Keep the
    // names as an explicit boundary contract, but do not expose false
    // stage-level retry/resume semantics yet.
    stageExecution: "monolithic_boundary_adapter",
    stages: ["source_sync", "item_processing", "cluster_merge", "cluster_finalize"],
    effects: ["item_write", "cluster_write", "embedding_write"],
    checkpoint: "pipelineCheckpointJson",
  },
  {
    kind: "item_processing_recovery",
    mode: "workflow",
    // Candidate selection, retries and persistence currently share mutable
    // recovery state; splitting them would risk repeating item side effects.
    stageExecution: "monolithic_boundary_adapter",
    stages: ["recovery_batch", "recovery_persist"],
    effects: ["item_write", "cluster_write"],
    checkpoint: "pipelineCheckpointJson",
  },
  { kind: "item_reanalyze", mode: "handler", stages: ["reanalyze"], effects: ["item_write"] },
  { kind: "item_regenerate_translation", mode: "handler", stages: ["read", "ai_call", "validate", "writeback"], effects: ["item_write"] },
  { kind: "item_regenerate_summary", mode: "handler", stages: ["read", "ai_call", "validate", "writeback"], effects: ["item_write"] },
  { kind: "cluster_regenerate_summary", mode: "handler", stages: ["summarize"], effects: ["cluster_write"] },
  { kind: "precompute", mode: "handler", stages: ["precompute"], effects: ["entity_write", "embedding_write"] },
  { kind: "cluster_merge_precompute_clean_pairs", mode: "handler", stages: ["clean_pair_precompute"], effects: ["embedding_write"] },
  { kind: "item_cleanup", mode: "handler", stages: ["read", "delete", "cluster_finalize"], effects: ["item_delete"] },
  { kind: "item_reparse_aggregations", mode: "handler", stages: ["reparse"], effects: ["item_write"] },
];

// Validate the host catalog against the framework's declarative stage contract.
for (const definition of TASK_DEFINITIONS) {
  createDomainTask({
    kind: definition.kind,
    stages: definition.stages.map((id) => ({ id, execute: async (input) => input })),
    effects: [...definition.effects],
    checkpoint: definition.checkpoint,
  });
}

const definitionsByKind = new Map(TASK_DEFINITIONS.map((definition) => [definition.kind, definition]));

export function getTaskDefinition(kind: BackgroundTaskRunKind): TaskDefinition {
  const definition = definitionsByKind.get(kind);
  if (!definition) throw new Error(`No task definition registered for ${kind}.`);
  return definition;
}
