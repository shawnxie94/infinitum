import type { BackgroundTaskRun } from "@prisma/client";

import { createDomainTask, type DomainTaskDefinition } from "@infinitum/ai/orchestration/task-definition";
import {
  generateClusterSummaryWorkflow,
  persistClusterSummaryWorkflow,
  readClusterSummaryWorkflow,
  resolveClusterSummaryProvider,
  type ClusterSummaryWorkflowPayload,
} from "@/lib/clusters/service";
import { createTaskAiUsageTracker } from "@/lib/tasks/ai-usage";

function asBackgroundTaskRun(input: unknown): BackgroundTaskRun {
  return input as BackgroundTaskRun;
}

export function createClusterSummaryWorkflowDefinition(): DomainTaskDefinition {
  return createDomainTask({
    kind: "cluster_regenerate_summary",
    stages: [
      {
        id: "read",
        replayPolicy: "replay_safe",
        execute: async (input) => readClusterSummaryWorkflow(asBackgroundTaskRun(input).entityId ?? ""),
      },
      {
        id: "ai_call",
        replayPolicy: "at_least_once",
        execute: async (input, context) => {
          const payload = input as ClusterSummaryWorkflowPayload;
          const aiUsage = createTaskAiUsageTracker(1, "cluster_summary");
          const resolved = await resolveClusterSummaryProvider({
            onUsage: (usage, usageKey) => aiUsage.addUsageByKey(usageKey, usage),
          });
          const aiProvider = resolved ? aiUsage.wrapProvider(resolved, { summarizeClusterEstimated: false }) : undefined;
          const next = await generateClusterSummaryWorkflow(payload, aiProvider);
          await context.projectAiUsage?.(aiUsage.snapshot());
          return next;
        },
      },
      {
        id: "writeback",
        replayPolicy: "at_least_once",
        execute: async (input, context) => {
          const result = await persistClusterSummaryWorkflow(input as ClusterSummaryWorkflowPayload);
          await context.projectProgress?.(`__mastra_stage_summary__${context.stepId}\n聚类摘要已写回`);
          return result;
        },
      },
    ],
    effects: ["cluster_write"],
    checkpoint: "pipelineCheckpointJson",
  });
}

export const CLUSTER_WORKFLOW_DEFINITIONS: Partial<Record<BackgroundTaskRun["kind"], DomainTaskDefinition>> = {
  cluster_regenerate_summary: createClusterSummaryWorkflowDefinition(),
};
