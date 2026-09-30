import { DAILY_REPORT_RECOVERY_STAGES, DAILY_REPORT_LEGACY_RECOVERY_STAGES } from "@/lib/tasks/types";
import type { TaskPipelineCheckpoint, TaskWorkflowCheckpoint } from "@/lib/tasks/types";

const REVIEW_STATUSES = ["disabled", "passed", "rejected", "unavailable"] as const;

// stageLoop 承载恢复断点；仅校验驱动恢复循环的必填结构，消息/违规等负载保持透明。
function isStageLoopLike(value: unknown): value is NonNullable<TaskPipelineCheckpoint["stageLoop"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const stageLoop = value as Record<string, unknown>;
  return (stageLoop.stage === "assess" || stageLoop.stage === "plan" || stageLoop.stage === "write")
    && typeof stageLoop.repairRound === "number" && Number.isFinite(stageLoop.repairRound)
    && typeof stageLoop.cleanRetryAttempt === "number" && Number.isFinite(stageLoop.cleanRetryAttempt);
}

export function parseTaskPipelineCheckpointJson(value: string | null | undefined): TaskPipelineCheckpoint | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<TaskPipelineCheckpoint>;
    if (
      parsed.version !== 1 ||
      typeof parsed.pipelineVersion !== "string" ||
      typeof parsed.stage !== "string" ||
      !Array.isArray(parsed.completedStages) ||
      !parsed.completedStages.every((stage) => typeof stage === "string") ||
      typeof parsed.inputHash !== "string" ||
      (parsed.templateSignature !== null && typeof parsed.templateSignature !== "string") ||
      typeof parsed.candidateSnapshotHash !== "string" ||
      typeof parsed.resumeEligible !== "boolean"
    ) {
      return null;
    }
    return {
      version: 1,
      pipelineVersion: parsed.pipelineVersion,
      stage: parsed.stage,
      completedStages: parsed.completedStages,
      inputHash: parsed.inputHash,
      templateSignature: parsed.templateSignature ?? null,
      candidateSnapshotHash: parsed.candidateSnapshotHash,
      resumeEligible: parsed.resumeEligible,
      ...(typeof parsed.lastCompletedStage === "string" ? { lastCompletedStage: parsed.lastCompletedStage } : {}),
      ...(typeof parsed.failedStage === "string" || parsed.failedStage === null ? { failedStage: parsed.failedStage } : {}),
      ...(typeof parsed.failureCode === "string" || parsed.failureCode === null ? { failureCode: parsed.failureCode } : {}),
      ...(typeof parsed.resumeAttempt === "number" ? { resumeAttempt: parsed.resumeAttempt } : {}),
      ...(typeof parsed.resumeFrom === "string" && DAILY_REPORT_RECOVERY_STAGES.includes(parsed.resumeFrom as typeof DAILY_REPORT_RECOVERY_STAGES[number])
        ? { resumeFrom: parsed.resumeFrom as TaskPipelineCheckpoint["resumeFrom"] }
        : String(parsed.resumeFrom) === DAILY_REPORT_LEGACY_RECOVERY_STAGES[0]
          ? { resumeFrom: "write" as const }
          : {}),
      ...(isStageLoopLike(parsed.stageLoop) ? { stageLoop: parsed.stageLoop } : {}),
      ...(parsed.stageAttempts && typeof parsed.stageAttempts === "object" && !Array.isArray(parsed.stageAttempts)
        ? { stageAttempts: Object.fromEntries(Object.entries(parsed.stageAttempts).filter(([, attempt]) => typeof attempt === "number" && Number.isFinite(attempt))) as Record<string, number> }
        : {}),
      ...(parsed.candidateSnapshot !== undefined ? { candidateSnapshot: parsed.candidateSnapshot } : {}),
      ...(parsed.planningAudit !== undefined ? { planningAudit: parsed.planningAudit } : {}),
      ...(Array.isArray(parsed.assessmentBatches) ? { assessmentBatches: parsed.assessmentBatches as TaskPipelineCheckpoint["assessmentBatches"] } : {}),
      ...(parsed.ledger !== undefined ? { ledger: parsed.ledger } : {}),
      ...(Array.isArray(parsed.planningCandidateBriefs) ? { planningCandidateBriefs: parsed.planningCandidateBriefs } : {}),
      ...(parsed.plan !== undefined ? { plan: parsed.plan } : {}),
      ...(parsed.draft !== undefined ? { draft: parsed.draft } : {}),
      ...(Array.isArray(parsed.violations) ? { violations: parsed.violations } : {}),
      ...(typeof parsed.reviewStatus === "string" && REVIEW_STATUSES.includes(parsed.reviewStatus)
        ? { reviewStatus: parsed.reviewStatus as TaskPipelineCheckpoint["reviewStatus"] }
        : {}),
      ...(typeof parsed.reviewAttempts === "number" ? { reviewAttempts: parsed.reviewAttempts } : {}),
      ...(typeof parsed.reviewRetryStage === "string" && (parsed.reviewRetryStage === "plan" || parsed.reviewRetryStage === "write")
        ? { reviewRetryStage: parsed.reviewRetryStage as TaskPipelineCheckpoint["reviewRetryStage"] }
        : {}),
      ...(Array.isArray(parsed.reviewViolations) ? { reviewViolations: parsed.reviewViolations } : {}),
      ...(parsed.reviewAudit && typeof parsed.reviewAudit === "object" && !Array.isArray(parsed.reviewAudit)
        ? { reviewAudit: parsed.reviewAudit as Record<string, unknown> }
        : {}),
      ...(parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data) ? { data: parsed.data as Record<string, unknown> } : {}),
    };
  } catch {
    return null;
  }
}

export function parseTaskWorkflowCheckpointJson(value: string | null | undefined): TaskWorkflowCheckpoint | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { __mastra?: unknown };
    if (!parsed.__mastra || typeof parsed.__mastra !== "object" || Array.isArray(parsed.__mastra)) return null;
    const mastra = parsed.__mastra as Record<string, unknown>;
    const publicMastra = Object.fromEntries(
      Object.entries(mastra).filter(([key]) => key !== "aiUsageBase" && key !== "aiUsageByStep"),
    );
    return { version: 1, mastra: publicMastra };
  } catch {
    return null;
  }
}

export function serializeTaskPipelineCheckpoint(checkpoint: TaskPipelineCheckpoint | null) {
  return checkpoint ? JSON.stringify(checkpoint) : null;
}
