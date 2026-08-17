import type { TaskPipelineCheckpoint } from "@/lib/tasks/types";
import type { TaskAiUsageSnapshot } from "@/lib/tasks/ai-usage";

const TASK_RUN_CANCELLED_MESSAGE = "管理员手动终止任务。";

export class DailyReportGenerationError extends Error {
  aiUsage: TaskAiUsageSnapshot;
  checkpoint: TaskPipelineCheckpoint | null;

  constructor(error: unknown, aiUsage: TaskAiUsageSnapshot, checkpoint: TaskPipelineCheckpoint | null = null) {
    super(error instanceof Error ? error.message : "AI 日报生成失败。");
    this.name = "DailyReportGenerationError";
    this.aiUsage = aiUsage;
    this.checkpoint = checkpoint;
  }
}

export class DailyReportCancellationError extends Error {
  aiUsage: TaskAiUsageSnapshot;
  checkpoint: TaskPipelineCheckpoint | null;

  constructor(aiUsage: TaskAiUsageSnapshot, checkpoint: TaskPipelineCheckpoint | null) {
    super(TASK_RUN_CANCELLED_MESSAGE);
    this.name = "DailyReportCancellationError";
    this.aiUsage = aiUsage;
    this.checkpoint = checkpoint;
  }
}
