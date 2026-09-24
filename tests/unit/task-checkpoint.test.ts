import { describe, expect, it } from "vitest";

import { parseTaskPipelineCheckpointJson } from "@/lib/tasks/checkpoint";

function buildCheckpoint(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    pipelineVersion: "daily-report-topic-first-review-v1",
    stage: "review",
    completedStages: ["prepare", "assess", "merge", "plan", "plan_validate", "write", "validate", "review"],
    inputHash: "input-hash",
    templateSignature: "template",
    candidateSnapshotHash: "snapshot-hash",
    resumeEligible: true,
    reviewStatus: "unavailable",
    reviewAttempts: 1,
    reviewRetryStage: "write",
    reviewViolations: [{ code: "draft_required_note_missing", stage: "draft" }],
    reviewAudit: { attempts: 1, retryError: "Review 触发的 WRITE 重试未通过校验" },
    ...overrides,
  };
}

describe("parseTaskPipelineCheckpointJson", () => {
  it("preserves review completion fields for downstream resume and display", () => {
    const parsed = parseTaskPipelineCheckpointJson(JSON.stringify(buildCheckpoint()));

    expect(parsed).not.toBeNull();
    expect(parsed?.reviewStatus).toBe("unavailable");
    expect(parsed?.reviewAttempts).toBe(1);
    expect(parsed?.reviewRetryStage).toBe("write");
    expect(parsed?.reviewViolations).toHaveLength(1);
    expect(parsed?.reviewAudit).toMatchObject({ retryError: expect.stringContaining("WRITE 重试未通过校验") });
  });

  it("drops malformed review fields while keeping the checkpoint parseable", () => {
    const parsed = parseTaskPipelineCheckpointJson(JSON.stringify(buildCheckpoint({
      reviewStatus: 123,
      reviewAttempts: "two",
      reviewRetryStage: "plan_validate",
      reviewViolations: "not-an-array",
      reviewAudit: [1, 2],
    })));

    expect(parsed).not.toBeNull();
    expect(parsed?.reviewStatus).toBeUndefined();
    expect(parsed?.reviewAttempts).toBeUndefined();
    expect(parsed?.reviewRetryStage).toBeUndefined();
    expect(parsed?.reviewViolations).toBeUndefined();
    expect(parsed?.reviewAudit).toBeUndefined();
  });
});
