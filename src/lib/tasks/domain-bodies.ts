import type { BackgroundTaskRun } from "@prisma/client";

import { createDomainTask, type DomainTaskDefinition } from "@infinitum/ai/orchestration/task-definition";
import {
  executeClusterMergeCleanPairWorkflow,
  generateClusterSummaryWorkflow,
  persistClusterSummaryWorkflow,
  readClusterSummaryWorkflow,
  type ClusterSummaryWorkflowPayload,
} from "@/lib/clusters/service";
import {
  deleteExpiredItems,
  finalizeItemCleanup,
  executeItemReparseWorkflowStage,
  generateItemReanalysisUnderstanding,
  generateItemRegenerationUnderstanding,
  persistItemRegeneration,
  prepareItemCleanup,
  readItemForRegeneration,
  reanalyzeItem,
  resolveAiProvider,
  type ItemRegenerationInput,
  type RegenerationTarget,
} from "@/lib/items/service";
import type { ItemUnderstandingResult } from "@/lib/ai/provider-types";
import { createTaskAiUsageTracker } from "@/lib/tasks/ai-usage";
import { executePrecomputeWorkflowStage, type PrecomputeWorkflowPayload } from "@/lib/precompute/service";
import { executeIngestionWorkflowStage, type IngestionWorkflowStage } from "@/lib/ingestion/workflow-stages";
import { executeRecoveryWorkflowStage } from "@/lib/items/recovery-workflow-stages";

const DOMAIN_STAGE_KINDS = [
  "item_reanalyze",
  "item_regenerate_translation",
  "item_regenerate_summary",
  "cluster_regenerate_summary",
  "precompute",
  "cluster_merge_precompute_clean_pairs",
  "item_cleanup",
  "item_reparse_aggregations",
] as const;

type DomainStageKind = typeof DOMAIN_STAGE_KINDS[number];

function asBackgroundTaskRun(input: unknown): BackgroundTaskRun {
  return input as BackgroundTaskRun;
}

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

function createIngestionDefinition(): DomainTaskDefinition {
  const stages: IngestionWorkflowStage[] = ["source_sync", "item_processing", "cluster_merge", "cluster_finalize"];
  return createDomainTask({
    kind: "ingestion",
    stages: stages.map((id) => ({
      id,
      execute: async (input, context) => executeIngestionWorkflowStage(id, input, context),
    })),
    effects: ["item_write", "cluster_write", "embedding_write"],
    checkpoint: "pipelineCheckpointJson",
  });
}

function createRecoveryDefinition(): DomainTaskDefinition {
  return createDomainTask({
    kind: "item_processing_recovery",
    stages: ["recovery_batch", "recovery_persist"].map((id) => ({
      id,
      execute: async (input, context) => executeRecoveryWorkflowStage(id as "recovery_batch" | "recovery_persist", input, context),
    })),
    effects: ["item_write", "cluster_write"],
    checkpoint: "pipelineCheckpointJson",
  });
}

function createItemReparseDefinition(): DomainTaskDefinition {
  const stages = ["read", "ai_call", "cluster_finalize"] as const;
  return createDomainTask({
    kind: "item_reparse_aggregations",
    stages: stages.map((id) => ({
      id,
      execute: async (input, context) => executeItemReparseWorkflowStage(id, input, {
        onAiUsage: async (usage) => context.projectAiUsage?.(usage),
      }),
    })),
    effects: ["item_write", "cluster_write"],
    checkpoint: "pipelineCheckpointJson",
  });
}

function createItemReanalyzeDefinition(): DomainTaskDefinition {
  return createDomainTask({
    kind: "item_reanalyze",
    stages: [
      {
        id: "read",
        execute: async (input) => {
          const taskRun = asBackgroundTaskRun(input);
          if (!taskRun.entityId) throw new Error("Task entityId is required.");
          return { itemId: taskRun.entityId };
        },
      },
      {
        id: "ai_call",
        execute: async (input, context) => {
          const payload = input as { itemId: string };
          const aiUsage = createTaskAiUsageTracker(1, "item_understanding");
          const aiProvider = aiUsage.wrapProvider(await resolveAiProvider(), { understandItemEstimated: false });
          const understanding = await generateItemReanalysisUnderstanding(payload.itemId, { aiProvider });
          await context.projectAiUsage?.(aiUsage.snapshot());
          return { ...payload, understanding };
        },
      },
      {
        id: "validate",
        execute: async (input) => {
          const payload = input as { itemId: string; understanding: ItemUnderstandingResult };
          if (!payload.understanding?.diagnostics) throw new Error("Item reanalysis result is missing diagnostics.");
          return payload;
        },
      },
      {
        id: "writeback",
        execute: async (input, context) => {
          const payload = input as { itemId: string; understanding: ItemUnderstandingResult };
          const aiUsage = createTaskAiUsageTracker();
          const aiProvider = aiUsage.wrapProvider(await resolveAiProvider());
          const result = await reanalyzeItem(payload.itemId, {
            aiProvider,
            precomputedUnderstanding: payload.understanding,
          });
          await context.projectAiUsage?.(aiUsage.snapshot());
          return { ...payload, result };
        },
      },
    ],
    effects: ["item_write", "cluster_write"],
    checkpoint: "pipelineCheckpointJson",
  });
}

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

function createItemRegenerationDefinition(kind: DomainStageKind, target: RegenerationTarget): DomainTaskDefinition {
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
        execute: async (input, context) => {
          const payload = input as ItemRegenerationStagePayload;
          const aiUsage = createTaskAiUsageTracker(1, "item_understanding");
          const aiProvider = aiUsage.wrapProvider(await resolveAiProvider(), { understandItemEstimated: false });
          const understanding = await generateItemRegenerationUnderstanding(payload.item, { aiProvider });
          await context.projectAiUsage?.(aiUsage.snapshot());
          return {
            ...payload,
            understanding,
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

/** Declarative domain stages; every definition is hosted by a Mastra workflow. */
export const DOMAIN_STAGE_TASK_DEFINITIONS: Record<DomainStageKind, DomainTaskDefinition> = Object.fromEntries(
  DOMAIN_STAGE_KINDS.map((kind) => {
    if (kind === "item_reparse_aggregations") {
      return [kind, createItemReparseDefinition()];
    }
    if (kind === "item_reanalyze") {
      return [kind, createItemReanalyzeDefinition()];
    }
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
    throw new Error(`Unhandled declarative domain stage kind ${kind}.`);
  }),
) as Record<DomainStageKind, DomainTaskDefinition>;

export const WORKFLOW_TASK_DEFINITIONS: Partial<Record<BackgroundTaskRun["kind"], DomainTaskDefinition>> = {
  ingestion: createIngestionDefinition(),
  item_processing_recovery: createRecoveryDefinition(),
  ...DOMAIN_STAGE_TASK_DEFINITIONS,
};
