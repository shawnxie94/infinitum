import type { BackgroundTaskRun } from "@prisma/client";

import { createDomainTask, type DomainTaskDefinition } from "@infinitum/ai/orchestration/task-definition";
import {
  buildDailyReportStageIdentity,
  DAILY_REPORT_WORKFLOW_STAGES,
  executeDailyReportWorkflowStage,
} from "@/lib/daily-report/generation";

export function createDailyReportWorkflowDefinition(): DomainTaskDefinition {
  return createDomainTask({
    kind: "daily_report_generate",
    replayPolicy: "business_checkpointed",
    stages: DAILY_REPORT_WORKFLOW_STAGES.map((id) => ({
      id,
      replayPolicy: "business_checkpointed",
      execute: async (input, context) => {
        const taskRun = context.getTaskRun
          ? await context.getTaskRun()
          : input as BackgroundTaskRun;
        if (!taskRun) throw new Error(`Daily report task ${context.taskRunId} no longer exists.`);
        await executeDailyReportWorkflowStage(
          taskRun as BackgroundTaskRun,
          id,
          {
            onCheckpoint: context.projectCheckpoint,
            onProgress: context.projectProgress,
            onAiUsage: context.projectAiUsage,
            onPartial: context.markPartial,
          },
          buildDailyReportStageIdentity(context.taskRunId, {
            stepId: context.stepId,
            workflowId: context.workflowId,
            runId: context.runId,
          }),
        );
        return input;
      },
    })),
    effects: ["daily_report_revision", "daily_report_publish"],
    checkpoint: "pipelineCheckpointJson",
  });
}

export const DAILY_REPORT_WORKFLOW_DEFINITIONS = {
  daily_report_generate: createDailyReportWorkflowDefinition(),
} as const;
