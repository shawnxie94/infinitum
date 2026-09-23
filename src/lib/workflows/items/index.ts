import type { BackgroundTaskRun } from "@prisma/client";

import { createDomainTask, type DomainTaskDefinition } from "@infinitum/ai/orchestration/task-definition";
import type { ItemUnderstandingResult } from "@/lib/ai/provider-types";
import {
  deleteExpiredItems,
  executeItemReparseWorkflowStage,
  finalizeItemCleanup,
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
import { createTaskAiUsageTracker } from "@/lib/tasks/ai-usage";

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

export function createItemReparseWorkflowDefinition(): DomainTaskDefinition {
  const stages = ["read", "ai_call", "cluster_finalize"] as const;
  return createDomainTask({
    kind: "item_reparse_aggregations",
    stages: stages.map((id) => ({
      id,
      replayPolicy: id === "ai_call" ? "at_least_once" : "replay_safe",
      execute: async (input, context) => executeItemReparseWorkflowStage(id, input, {
        onAiUsage: async (usage) => context.projectAiUsage?.(usage),
      }),
    })),
    effects: ["item_write", "cluster_write"],
    checkpoint: "pipelineCheckpointJson",
  });
}

export function createItemReanalyzeWorkflowDefinition(): DomainTaskDefinition {
  return createDomainTask({
    kind: "item_reanalyze",
    stages: [
      {
        id: "read",
        replayPolicy: "replay_safe",
        execute: async (input) => {
          const taskRun = asBackgroundTaskRun(input);
          if (!taskRun.entityId) throw new Error("Task entityId is required.");
          return { itemId: taskRun.entityId };
        },
      },
      {
        id: "ai_call",
        replayPolicy: "at_least_once",
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
        replayPolicy: "replay_safe",
        execute: async (input) => {
          const payload = input as { itemId: string; understanding: ItemUnderstandingResult };
          if (!payload.understanding?.diagnostics) throw new Error("Item reanalysis result is missing diagnostics.");
          return payload;
        },
      },
      {
        id: "writeback",
        replayPolicy: "at_least_once",
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

export function createItemCleanupWorkflowDefinition(): DomainTaskDefinition {
  return createDomainTask({
    kind: "item_cleanup",
    stages: [
      {
        id: "read",
        replayPolicy: "replay_safe",
        execute: async () => {
          const plan = await prepareItemCleanup();
          return { plan: { ...plan, cutoff: plan.cutoff.toISOString() } } satisfies ItemCleanupStagePayload;
        },
      },
      {
        id: "delete",
        replayPolicy: "at_least_once",
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
        replayPolicy: "at_least_once",
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

export function createItemRegenerationWorkflowDefinition(
  kind: "item_regenerate_translation" | "item_regenerate_summary",
  target: RegenerationTarget,
): DomainTaskDefinition {
  return createDomainTask({
    kind,
    stages: [
      {
        id: "read",
        replayPolicy: "replay_safe",
        execute: async (input) => {
          const taskRun = asBackgroundTaskRun(input);
          if (!taskRun.entityId) throw new Error("Task entityId is required.");
          return { item: await readItemForRegeneration(taskRun.entityId) } satisfies ItemRegenerationStagePayload;
        },
      },
      {
        id: "ai_call",
        replayPolicy: "at_least_once",
        execute: async (input, context) => {
          const payload = input as ItemRegenerationStagePayload;
          const aiUsage = createTaskAiUsageTracker(1, "item_understanding");
          const aiProvider = aiUsage.wrapProvider(await resolveAiProvider(), { understandItemEstimated: false });
          const understanding = await generateItemRegenerationUnderstanding(payload.item, { aiProvider });
          await context.projectAiUsage?.(aiUsage.snapshot());
          return { ...payload, understanding } satisfies ItemRegenerationStagePayload;
        },
      },
      {
        id: "validate",
        replayPolicy: "replay_safe",
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
        replayPolicy: "at_least_once",
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

export const ITEM_WORKFLOW_DEFINITIONS: Partial<Record<BackgroundTaskRun["kind"], DomainTaskDefinition>> = {
  item_reparse_aggregations: createItemReparseWorkflowDefinition(),
  item_reanalyze: createItemReanalyzeWorkflowDefinition(),
  item_cleanup: createItemCleanupWorkflowDefinition(),
  item_regenerate_translation: createItemRegenerationWorkflowDefinition("item_regenerate_translation", "translation"),
  item_regenerate_summary: createItemRegenerationWorkflowDefinition("item_regenerate_summary", "summary"),
};
