import { describe, expect, it } from "vitest";

import {
  getDailyReportRecoveryStages,
  getRecommendedDailyReportRecoveryStage,
} from "@/lib/daily-report/recovery";
import type { TaskPipelineCheckpoint } from "@/lib/tasks/types";

function buildCheckpoint(overrides: Partial<TaskPipelineCheckpoint> = {}): TaskPipelineCheckpoint {
  return {
    version: 1,
    pipelineVersion: "daily-report-topic-first-review-v1",
    stage: "validate",
    completedStages: ["prepare", "assess", "merge", "plan", "plan_validate", "write"],
    inputHash: "input",
    templateSignature: "template",
    candidateSnapshotHash: "candidates",
    resumeEligible: false,
    assessmentBatches: [{ index: 0, candidateIds: [1], status: "succeeded", attempt: 1 }],
    ledger: { schemaVersion: 1 },
    planningCandidateBriefs: [{ candidateId: 1 }],
    plan: { schemaVersion: 2, sections: [] },
    draft: { headline: "日报", blocks: [] },
    violations: [{ code: "draft_topic_missing", stage: "draft", message: "缺少主题" }],
    ...overrides,
  };
}

describe("daily report recovery options", () => {
  it("offers manual recovery stages even when automatic resume is disabled", () => {
    const checkpoint = buildCheckpoint();

    expect(getDailyReportRecoveryStages(checkpoint)).toEqual(["assess", "plan", "write"]);
    expect(getRecommendedDailyReportRecoveryStage(checkpoint)).toBe("write");
  });

  it("keeps WRITE as the only AI recovery stage for notes-only violations", () => {
    const checkpoint = buildCheckpoint({
      violations: [{ code: "draft_required_note_missing", stage: "draft", message: "缺少重点" }],
    });

    expect(getDailyReportRecoveryStages(checkpoint)).toEqual(["assess", "plan", "write"]);
    expect(getRecommendedDailyReportRecoveryStage(checkpoint)).toBe("write");
  });

  it("does not offer REPAIR when the draft has mixed structural violations", () => {
    const checkpoint = buildCheckpoint({
      violations: [
        { code: "draft_required_note_missing", stage: "draft", message: "缺少重点" },
        { code: "draft_topic_missing", stage: "draft", message: "缺少主题" },
      ],
    });

    expect(getDailyReportRecoveryStages(checkpoint)).toEqual(["assess", "plan", "write"]);
    expect(getRecommendedDailyReportRecoveryStage(checkpoint)).toBe("write");
  });

  it("offers REVIEW for a completed draft when review was rejected or unavailable", () => {
    const checkpoint = buildCheckpoint({
      completedStages: ["prepare", "assess", "merge", "plan", "plan_validate", "write", "validate", "review"],
      reviewStatus: "unavailable",
      reviewAttempts: 1,
      violations: [],
    });

    expect(getDailyReportRecoveryStages(checkpoint)).toEqual(["assess", "plan", "write", "review"]);
    expect(getRecommendedDailyReportRecoveryStage(checkpoint)).toBe("review");
  });
});
