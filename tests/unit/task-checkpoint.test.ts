import { describe, expect, it } from "vitest";

import {
  parseTaskPipelineCheckpointJson,
  parseTaskWorkflowCheckpointJson,
  serializeTaskPipelineCheckpoint,
} from "@/lib/tasks/checkpoint";

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

  it("rejects unknown review status strings instead of casting them through", () => {
    // 此前 reviewStatus 只校验 typeof string 即 cast，非法枚举值会原样透传。
    const parsed = parseTaskCheckpointJsonSafe({ ...buildCheckpoint(), reviewStatus: "bogus" });

    expect(parsed?.reviewStatus).toBeUndefined();
  });

  it("returns null when required fields are missing or corrupted", () => {
    const missingInputHash = buildCheckpoint();
    delete (missingInputHash as Record<string, unknown>).inputHash;

    expect(parseTaskPipelineCheckpointJson(null)).toBeNull();
    expect(parseTaskPipelineCheckpointJson(undefined)).toBeNull();
    expect(parseTaskPipelineCheckpointJson("not-json")).toBeNull();
    expect(parseTaskPipelineCheckpointJson(JSON.stringify([1, 2, 3]))).toBeNull();
    expect(parseTaskCheckpointJsonSafe(missingInputHash)).toBeNull();
  });

  it("returns null for unknown checkpoint versions", () => {
    expect(parseTaskCheckpointJsonSafe({ ...buildCheckpoint(), version: 2 })).toBeNull();
  });

  it("drops optional fields with wrong types while keeping the checkpoint", () => {
    const parsed = parseTaskCheckpointJsonSafe({
      ...buildCheckpoint(),
      lastCompletedStage: 42,
      failedStage: 7,
      failureCode: {},
      resumeAttempt: "three",
      resumeFrom: "not-a-stage",
      stageAttempts: { assess: "no", write: 2, review: Number.NaN },
      data: "not-an-object",
    });

    expect(parsed).not.toBeNull();
    expect(parsed?.lastCompletedStage).toBeUndefined();
    expect(parsed?.failedStage).toBeUndefined();
    expect(parsed?.failureCode).toBeUndefined();
    expect(parsed?.resumeAttempt).toBeUndefined();
    expect(parsed?.resumeFrom).toBeUndefined();
    expect(parsed?.stageAttempts).toEqual({ write: 2 });
    expect(parsed?.data).toBeUndefined();
  });

  it("accepts stageLoop only with the minimal recovery structure and keeps payloads opaque", () => {
    const valid = parseTaskCheckpointJsonSafe({
      ...buildCheckpoint(),
      stageLoop: {
        stage: "write",
        repairRound: 1,
        cleanRetryAttempt: 0,
        messages: [{ role: "assistant", content: "draft" }],
        lastViolations: [{ code: "x" }],
      },
    });
    expect(valid?.stageLoop).toMatchObject({ stage: "write", repairRound: 1, cleanRetryAttempt: 0 });
    expect(valid?.stageLoop?.messages).toHaveLength(1);

    for (const bad of [
      { stage: "review", repairRound: 1, cleanRetryAttempt: 0 },
      { stage: "write", repairRound: "one", cleanRetryAttempt: 0 },
      { stage: "write", repairRound: 1 },
      "string",
      5,
    ]) {
      expect(parseTaskCheckpointJsonSafe({ ...buildCheckpoint(), stageLoop: bad })?.stageLoop).toBeUndefined();
    }
  });

  it("keeps business payloads like candidateSnapshot/plan/draft opaque without deep validation", () => {
    const shape = { rows: [{ id: 1 }], nested: { flag: true } };
    const parsed = parseTaskCheckpointJsonSafe({
      ...buildCheckpoint(),
      candidateSnapshot: shape,
      plan: { sections: [] },
      draft: "raw text",
      ledger: { entries: 3 },
    });

    expect(parsed?.candidateSnapshot).toEqual(shape);
    expect(parsed?.plan).toEqual({ sections: [] });
    expect(parsed?.draft).toBe("raw text");
    expect(parsed?.ledger).toEqual({ entries: 3 });
  });

  it("roundtrips a valid checkpoint through serialize without loss", () => {
    const checkpoint = parseTaskPipelineCheckpointJson(JSON.stringify(buildCheckpoint({
      resumeFrom: "write",
      stageLoop: { stage: "plan", repairRound: 0, cleanRetryAttempt: 2 },
    })));

    expect(checkpoint).not.toBeNull();
    const roundtripped = parseTaskPipelineCheckpointJson(serializeTaskPipelineCheckpoint(checkpoint));

    expect(roundtripped).toEqual(checkpoint);
  });

  it("serializes null checkpoints as null", () => {
    expect(serializeTaskPipelineCheckpoint(null)).toBeNull();
  });
});

describe("parseTaskWorkflowCheckpointJson", () => {
  it("returns null for non-record __mastra payloads and invalid JSON", () => {
    expect(parseTaskWorkflowCheckpointJson(null)).toBeNull();
    expect(parseTaskWorkflowCheckpointJson("nope")).toBeNull();
    expect(parseTaskWorkflowCheckpointJson(JSON.stringify({ __mastra: "string" }))).toBeNull();
    expect(parseTaskWorkflowCheckpointJson(JSON.stringify({ __mastra: [1] }))).toBeNull();
  });

  it("strips internal ai usage fields while keeping the rest of the mastra payload", () => {
    const workflow = parseTaskWorkflowCheckpointJson(JSON.stringify({
      __mastra: {
        stage: "write",
        lifecycle: { status: "running" },
        aiUsageBase: { promptTokens: 10 },
        aiUsageByStep: { plan: { totalTokens: 20 } },
      },
    }));

    expect(workflow).not.toBeNull();
    expect(workflow?.version).toBe(1);
    expect(workflow?.mastra).toEqual({
      stage: "write",
      lifecycle: { status: "running" },
    });
  });
});

function parseTaskCheckpointJsonSafe(value: unknown) {
  return parseTaskPipelineCheckpointJson(JSON.stringify(value));
}
