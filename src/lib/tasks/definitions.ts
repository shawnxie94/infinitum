import type { BackgroundTaskRunKind } from "@/lib/tasks/types";
import { WORKFLOW_TASK_DEFINITIONS } from "@/lib/workflows/catalog";

export type TaskExecutionMode = "workflow";
export type TaskDefinition = {
  kind: BackgroundTaskRunKind;
  mode: TaskExecutionMode;
  stages: readonly string[];
  stageReplayPolicies: Readonly<Record<string, "replay_safe" | "at_least_once" | "business_checkpointed">>;
  effects: readonly string[];
  checkpoint?: string;
};

const RETIRED_TASK_KINDS = new Set<BackgroundTaskRunKind>([
  "cluster_merge_precompute_clean_pairs",
  "item_reparse_aggregations",
]);

/** Current task catalog; retired persisted kinds are excluded from new work. */
export const TASK_DEFINITIONS: readonly TaskDefinition[] = Object.values(WORKFLOW_TASK_DEFINITIONS)
  .filter((definition): definition is NonNullable<typeof definition> => Boolean(definition) && !RETIRED_TASK_KINDS.has(definition.kind as BackgroundTaskRunKind))
  .map((definition) => ({
    kind: definition.kind as BackgroundTaskRunKind,
    mode: "workflow",
    stages: definition.stages.map((stage) => stage.id),
    stageReplayPolicies: Object.fromEntries(
      definition.stages.map((stage) => [stage.id, stage.replayPolicy ?? "at_least_once"]),
    ),
    effects: definition.effects ?? [],
    ...(definition.checkpoint ? { checkpoint: definition.checkpoint } : {}),
  }));

export function getTaskDefinition(kind: BackgroundTaskRunKind): TaskDefinition {
  const definition = TASK_DEFINITIONS.find((entry) => entry.kind === kind);
  if (!definition) throw new Error(`No task definition registered for ${kind}.`);
  return definition;
}
