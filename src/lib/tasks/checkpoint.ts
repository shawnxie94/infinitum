import type { TaskPipelineCheckpoint } from "@/lib/tasks/types";

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
      ...(parsed.stageAttempts && typeof parsed.stageAttempts === "object" && !Array.isArray(parsed.stageAttempts)
        ? { stageAttempts: Object.fromEntries(Object.entries(parsed.stageAttempts).filter(([, attempt]) => typeof attempt === "number" && Number.isFinite(attempt))) as Record<string, number> }
        : {}),
      ...(parsed.candidateSnapshot !== undefined ? { candidateSnapshot: parsed.candidateSnapshot } : {}),
      ...(Array.isArray(parsed.assessmentBatches) ? { assessmentBatches: parsed.assessmentBatches as TaskPipelineCheckpoint["assessmentBatches"] } : {}),
      ...(parsed.ledger !== undefined ? { ledger: parsed.ledger } : {}),
      ...(Array.isArray(parsed.mergedTopics) ? { mergedTopics: parsed.mergedTopics } : {}),
      ...(parsed.plan !== undefined ? { plan: parsed.plan } : {}),
      ...(parsed.draft !== undefined ? { draft: parsed.draft } : {}),
      ...(Array.isArray(parsed.violations) ? { violations: parsed.violations } : {}),
      ...(parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data) ? { data: parsed.data as Record<string, unknown> } : {}),
    };
  } catch {
    return null;
  }
}

export function serializeTaskPipelineCheckpoint(checkpoint: TaskPipelineCheckpoint | null) {
  return checkpoint ? JSON.stringify(checkpoint) : null;
}
