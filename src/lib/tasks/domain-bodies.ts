import type { BackgroundTaskRun } from "@prisma/client";

import { createDomainTask, type DomainTaskDefinition } from "@infinitum/ai/orchestration/task-definition";
import {
  executeClusterMergeCleanPairPrecomputeTask,
  executeClusterMergeCleanPairWorkflow,
  executeClusterSummaryTask,
  generateClusterSummaryWorkflow,
  persistClusterSummaryWorkflow,
  readClusterSummaryWorkflow,
  type ClusterSummaryWorkflowPayload,
} from "@/lib/clusters/service";
import { executeDailyReportTask } from "@/lib/daily-report/generation";
import { runIngestionTask } from "@/lib/ingestion/service";
import { executeItemProcessingRecoveryTask } from "@/lib/items/processing-recovery";
import {
  executeItemCleanupTask,
  executeItemReanalyzeTask,
  executeItemRegenerationTask,
  executeItemReparseAggregationsTask,
  deleteExpiredItems,
  finalizeItemCleanup,
  generateItemRegenerationUnderstanding,
  persistItemRegeneration,
  prepareItemCleanup,
  readItemForRegeneration,
  type ItemRegenerationInput,
  type RegenerationTarget,
} from "@/lib/items/service";
import type { ItemUnderstandingResult } from "@/lib/ai/provider";
import { executePrecomputeTask, executePrecomputeWorkflowStage, type PrecomputeWorkflowPayload } from "@/lib/precompute/service";
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

type ItemRegenerationStagePayload = {
  item: ItemRegenerationInput;
  understanding?: ItemUnderstandingResult;
  result?: ItemRegenerationInput;
};

type ItemCleanupStagePayload = {
  plan: { cutoff: string; estimatedTotal: number; affectedClusterIds: string[] };
  totalDeleted?: number;
  result?: { totalDeleted: number; affectedClusterCount: number };
};

function createClusterMergeCleanPairDefinition(): DomainTaskDefinition {
  return createDomainTask({
    kind: "cluster_merge_precompute_clean_pairs",
    stages: [
      { id: "read", execute: async () => ({ preparedAt: new Date().toISOString() }) },
      { id: "compute", execute: async () => executeClusterMergeCleanPairWorkflow() },
      { id: "writeback", execute: async (input) => input },
    ],
    effects: ["embedding_write"],
    checkpoint: "pipelineCheckpointJson",
  });
}

function createClusterSummaryDefinition(): DomainTaskDefinition {
  return createDomainTask({
    kind: "cluster_regenerate_summary",
    stages: [
      { id: "read", execute: async (input) => readClusterSummaryWorkflow(asBackgroundTaskRun(input).entityId ?? "") },
      { id: "ai_call", execute: async (input) => generateClusterSummaryWorkflow(input as ClusterSummaryWorkflowPayload) },
      { id: "writeback", execute: async (input) => persistClusterSummaryWorkflow(input as ClusterSummaryWorkflowPayload) },
    ],
    effects: ["cluster_write"],
    checkpoint: "pipelineCheckpointJson",
  });
}

function createPrecomputeDefinition(): DomainTaskDefinition {
  const stages = ["cluster_merge_clean_pairs", "entity_alias_check", "entity_suggestion_candidates"] as const;
  return createDomainTask({
    kind: "precompute",
    stages: stages.map((id) => ({
      id,
      execute: async (input) => executePrecomputeWorkflowStage(id, (input as PrecomputeWorkflowPayload | undefined) ?? undefined),
    })),
    effects: ["entity_write", "embedding_write"],
    checkpoint: "pipelineCheckpointJson",
  });
}

function createItemCleanupDefinition(): DomainTaskDefinition {
  return createDomainTask({
    kind: "item_cleanup",
    stages: [
      {
        id: "read",
        execute: async () => {
          const plan = await prepareItemCleanup();
          return { plan: { ...plan, cutoff: plan.cutoff.toISOString() } } satisfies ItemCleanupStagePayload;
        },
      },
      {
        id: "delete",
        execute: async (input, context) => {
          const payload = input as ItemCleanupStagePayload;
          const totalDeleted = await deleteExpiredItems(
            { ...payload.plan, cutoff: new Date(payload.plan.cutoff) },
            { checkCancellation: context.checkCancellation },
          );
          return { ...payload, totalDeleted };
        },
      },
      {
        id: "cluster_finalize",
        execute: async (input) => {
          const payload = input as ItemCleanupStagePayload;
          const result = await finalizeItemCleanup(
            { ...payload.plan, cutoff: new Date(payload.plan.cutoff) },
            payload.totalDeleted ?? 0,
          );
          return { ...payload, result };
        },
      },
    ],
    effects: ["item_delete"],
    checkpoint: "pipelineCheckpointJson",
  });
}

function createItemRegenerationDefinition(kind: HandlerKind, target: RegenerationTarget): DomainTaskDefinition {
  return createDomainTask({
    kind,
    stages: [
      {
        id: "read",
        execute: async (input) => {
          const taskRun = asBackgroundTaskRun(input);
          if (!taskRun.entityId) throw new Error("Task entityId is required.");
          return { item: await readItemForRegeneration(taskRun.entityId) } satisfies ItemRegenerationStagePayload;
        },
      },
      {
        id: "ai_call",
        execute: async (input) => {
          const payload = input as ItemRegenerationStagePayload;
          return {
            ...payload,
            understanding: await generateItemRegenerationUnderstanding(payload.item),
          } satisfies ItemRegenerationStagePayload;
        },
      },
      {
        id: "validate",
        execute: async (input) => {
          const payload = input as ItemRegenerationStagePayload;
          if (!payload.understanding) throw new Error("Item regeneration AI result is missing.");
          if (target === "summary" && (!payload.understanding.diagnostics.summaryValid || !payload.understanding.summary)) {
            throw new Error("Item understanding returned an invalid summary");
          }
          return payload;
        },
      },
      {
        id: "writeback",
        execute: async (input) => {
          const payload = input as ItemRegenerationStagePayload;
          if (!payload.understanding) throw new Error("Item regeneration AI result is missing.");
          return {
            ...payload,
            result: await persistItemRegeneration(payload.item, target, payload.understanding),
          } satisfies ItemRegenerationStagePayload;
        },
      },
    ],
    effects: ["item_write"],
    checkpoint: "pipelineCheckpointJson",
  });
}

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
    if (kind === "cluster_merge_precompute_clean_pairs") {
      return [kind, createClusterMergeCleanPairDefinition()];
    }
    if (kind === "cluster_regenerate_summary") {
      return [kind, createClusterSummaryDefinition()];
    }
    if (kind === "precompute") {
      return [kind, createPrecomputeDefinition()];
    }
    if (kind === "item_cleanup") {
      return [kind, createItemCleanupDefinition()];
    }
    if (kind === "item_regenerate_translation" || kind === "item_regenerate_summary") {
      return [kind, createItemRegenerationDefinition(kind, kind.endsWith("translation") ? "translation" : "summary")];
    }
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
