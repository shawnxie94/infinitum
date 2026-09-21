import type { BackgroundTaskRun } from "@prisma/client";

import { createDomainTask, type DomainTaskDefinition } from "@infinitum/ai/orchestration/task-definition";
import { executeClusterMergeCleanPairPrecomputeTask, executeClusterSummaryTask } from "@/lib/clusters/service";
import { executeDailyReportTask } from "@/lib/daily-report/generation";
import { runIngestionTask } from "@/lib/ingestion/service";
import { executeItemProcessingRecoveryTask } from "@/lib/items/processing-recovery";
import { executeItemCleanupTask, executeItemReanalyzeTask, executeItemRegenerationTask, executeItemReparseAggregationsTask } from "@/lib/items/service";
import { executePrecomputeTask } from "@/lib/precompute/service";
import { getTaskDefinition } from "@/lib/tasks/definitions";
import type { TaskBody } from "@infinitum/ai/orchestration/workflow-factory";

const HANDLER_KINDS = [
  "item_reanalyze",
  "item_regenerate_translation",
  "item_regenerate_summary",
  "cluster_regenerate_summary",
  "precompute",
  "cluster_merge_precompute_clean_pairs",
  "item_cleanup",
  "item_reparse_aggregations",
] as const;

type HandlerKind = typeof HANDLER_KINDS[number];

function asBackgroundTaskRun(input: unknown): BackgroundTaskRun {
  return input as BackgroundTaskRun;
}

/**
 * Domain-owned execution bodies. These remain compatibility exports for
 * direct callers, while the worker's default route uses the declarative
 * definitions below through the Mastra workflow adapter.
 */
export const TASK_BODIES: Record<BackgroundTaskRun["kind"], TaskBody> = {
  daily_report_generate: executeDailyReportTask as unknown as TaskBody,
  ingestion: runIngestionTask as unknown as TaskBody,
  item_processing_recovery: executeItemProcessingRecoveryTask as unknown as TaskBody,
  item_reanalyze: async (taskRun) => { await executeItemReanalyzeTask(asBackgroundTaskRun(taskRun)); },
  item_regenerate_translation: async (taskRun) => { await executeItemRegenerationTask(asBackgroundTaskRun(taskRun), "translation"); },
  item_regenerate_summary: async (taskRun) => { await executeItemRegenerationTask(asBackgroundTaskRun(taskRun), "summary"); },
  cluster_regenerate_summary: async (taskRun) => { await executeClusterSummaryTask(asBackgroundTaskRun(taskRun)); },
  precompute: async (taskRun) => { await executePrecomputeTask(asBackgroundTaskRun(taskRun)); },
  cluster_merge_precompute_clean_pairs: async (taskRun) => { await executeClusterMergeCleanPairPrecomputeTask(asBackgroundTaskRun(taskRun)); },
  item_cleanup: async (taskRun) => { await executeItemCleanupTask(asBackgroundTaskRun(taskRun)); },
  item_reparse_aggregations: async (taskRun) => { await executeItemReparseAggregationsTask(asBackgroundTaskRun(taskRun)); },
};

const HANDLER_STAGE_BODIES: Record<HandlerKind, (input: unknown) => Promise<void>> = {
  item_reanalyze: async (input) => { await executeItemReanalyzeTask(asBackgroundTaskRun(input)); },
  item_regenerate_translation: async (input) => { await executeItemRegenerationTask(asBackgroundTaskRun(input), "translation"); },
  item_regenerate_summary: async (input) => { await executeItemRegenerationTask(asBackgroundTaskRun(input), "summary"); },
  cluster_regenerate_summary: async (input) => { await executeClusterSummaryTask(asBackgroundTaskRun(input)); },
  precompute: async (input) => { await executePrecomputeTask(asBackgroundTaskRun(input)); },
  cluster_merge_precompute_clean_pairs: async (input) => { await executeClusterMergeCleanPairPrecomputeTask(asBackgroundTaskRun(input)); },
  item_cleanup: async (input) => { await executeItemCleanupTask(asBackgroundTaskRun(input)); },
  item_reparse_aggregations: async (input) => { await executeItemReparseAggregationsTask(asBackgroundTaskRun(input)); },
};

/** One declarative stage per handler kind; stage policy comes from TASK_DEFINITIONS. */
export const HANDLER_TASK_DEFINITIONS: Record<HandlerKind, DomainTaskDefinition> = Object.fromEntries(
  HANDLER_KINDS.map((kind) => {
    const definition = getTaskDefinition(kind);
    return [kind, createDomainTask({
      kind,
      stages: definition.stages.map((id) => ({
        id,
        execute: async (input) => {
          await HANDLER_STAGE_BODIES[kind](input);
          return input;
        },
      })),
      effects: [...definition.effects],
      checkpoint: definition.checkpoint,
    })];
  }),
) as Record<HandlerKind, DomainTaskDefinition>;
