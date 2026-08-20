import type { TaskPipelineCheckpoint, DailyReportRecoveryStage } from "@/lib/tasks/types";

export const DAILY_REPORT_RECOVERY_STAGE_LABELS: Record<DailyReportRecoveryStage, string> = {
  assess: "评估",
  plan: "规划",
  write: "写作",
  review: "审核",
};

function hasCompletedStage(checkpoint: TaskPipelineCheckpoint, stage: string) {
  return checkpoint.completedStages.includes(stage);
}

export function getDailyReportRecoveryStages(checkpoint: TaskPipelineCheckpoint | null | undefined): DailyReportRecoveryStage[] {
  if (!checkpoint) return [];

  const stages: DailyReportRecoveryStage[] = [];
  if (checkpoint.assessmentBatches?.length || hasCompletedStage(checkpoint, "assess")) {
    stages.push("assess");
  }
  if (hasCompletedStage(checkpoint, "assess") && (
    checkpoint.ledger !== undefined || checkpoint.planningCandidateBriefs !== undefined
  )) {
    stages.push("plan");
  }
  if ((hasCompletedStage(checkpoint, "plan") || hasCompletedStage(checkpoint, "plan_validate")) && checkpoint.plan !== undefined) {
    stages.push("write");
  }
  if (hasCompletedStage(checkpoint, "review") && checkpoint.draft !== undefined) {
    stages.push("review");
  }

  return stages;
}

export function getRecommendedDailyReportRecoveryStage(
  checkpoint: TaskPipelineCheckpoint | null | undefined,
): DailyReportRecoveryStage | null {
  const stages = getDailyReportRecoveryStages(checkpoint);
  if (stages.length === 0) return null;

  if (
    stages.includes("review") &&
    (checkpoint?.reviewStatus === "unavailable" || checkpoint?.reviewStatus === "rejected")
  ) {
    return "review";
  }

  if (stages.includes("write") && Array.isArray(checkpoint?.violations) && checkpoint.violations.length > 0) return "write";

  const failedStage = checkpoint?.failedStage;
  if (failedStage?.startsWith("ASSESS") && stages.includes("assess")) return "assess";
  if ((failedStage === "plan" || failedStage === "plan_validate") && stages.includes("plan")) return "plan";
  if ((failedStage === "write" || failedStage === "validate" || failedStage === "repair") && stages.includes("write")) return "write";

  return stages[stages.length - 1] ?? null;
}
