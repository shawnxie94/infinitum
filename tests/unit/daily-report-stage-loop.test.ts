import { describe, expect, it } from "vitest";

import { runDailyReportStageLoop } from "@/lib/daily-report/stage-loop";
import type { DailyReportStageContext } from "@/lib/ai/provider";

describe("daily report stage loop", () => {
  it("reuses the stage context for validation feedback and keeps clean retries isolated", async () => {
    const contexts: DailyReportStageContext[] = [];
    let callCount = 0;

    const result = await runDailyReportStageLoop({
      stage: "plan",
      inputHash: "plan-input",
      maxRepairRounds: 1,
      run: async (context, feedback) => {
        contexts.push(context);
        callCount += 1;
        if (callCount === 1) return { valid: false, feedbackStage: feedback?.stage ?? null };
        return { valid: true, feedbackStage: feedback?.stage ?? null };
      },
      validate: (value) => value.valid
        ? []
        : [{ code: "duplicate_candidate", stage: "plan", message: "候选重复" }],
    });

    expect(result.value.valid).toBe(true);
    expect(result.repairRounds).toBe(1);
    expect(result.cleanRetryCount).toBe(0);
    expect(contexts).toHaveLength(2);
    expect(contexts[0]).toBe(contexts[1]);
    expect(contexts[1].lastViolations).toEqual([]);
  });

  it("starts one clean retry after an unrepaired stage result", async () => {
    const contexts: DailyReportStageContext[] = [];
    let callCount = 0;

    const result = await runDailyReportStageLoop({
      stage: "write",
      inputHash: "write-input",
      maxRepairRounds: 0,
      run: async (context) => {
        contexts.push(context);
        callCount += 1;
        return { attempt: callCount };
      },
      validate: () => [{ code: "draft_schema", stage: "draft", message: "草稿结构错误" }],
    }).catch((error) => error);

    expect(result.name).toBe("DailyReportStageLoopError");
    expect(contexts).toHaveLength(2);
    expect(contexts[0]).not.toBe(contexts[1]);
    expect(contexts[0].cleanRetryAttempt).toBe(0);
    expect(contexts[1].cleanRetryAttempt).toBe(1);
  });

  it("stops before full-result repair when the caller selects a scoped repair path", async () => {
    let calls = 0;
    await expect(runDailyReportStageLoop({
      stage: "write",
      run: async () => {
        calls += 1;
        return { valid: false };
      },
      validate: () => [{
        code: "draft_required_note_missing",
        stage: "draft",
        topicId: "topic-21",
        noteLabel: "数据",
        message: "缺少数据 note",
      }],
      stopOnValidation: () => true,
    })).rejects.toMatchObject({ name: "DailyReportStageLoopError", cleanRetryCount: 0 });
    expect(calls).toBe(1);
  });

  it("includes topicId and noteLabel in validation feedback", async () => {
    let callCount = 0;
    let feedback: { missingNotes?: unknown[] } | undefined;
    const result = await runDailyReportStageLoop({
      stage: "write",
      maxRepairRounds: 1,
      run: async (_context, nextFeedback) => {
        callCount += 1;
        feedback = nextFeedback;
        return { valid: callCount > 1 };
      },
      validate: (value) => value.valid ? [] : [
        {
          code: "draft_required_note_missing",
          stage: "draft" as const,
          topicId: "topic-21",
          noteLabel: "数据",
          noteInstruction: "列出关键数字。",
          message: "缺少数据 note",
        },
      ],
    });

    expect(result.value.valid).toBe(true);
    expect(feedback).toEqual(expect.objectContaining({
      missingNotes: [{
        topicId: "topic-21",
        noteLabel: "数据",
        noteInstruction: "列出关键数字。",
      }],
    }));
  });

  it("skips same-context repair for an explicitly non-repairable violation", async () => {
    let calls = 0;
    await expect(runDailyReportStageLoop({
      stage: "plan",
      run: async () => {
        calls += 1;
        return { valid: false };
      },
      validate: () => [{
        code: "insufficient_required_candidates",
        stage: "plan",
        message: "候选不足",
      }],
      isRepairable: (violations) => !violations.some(
        (violation) => violation.code === "insufficient_required_candidates",
      ),
    })).rejects.toMatchObject({ name: "DailyReportStageLoopError", cleanRetryCount: 1 });
    expect(calls).toBe(2);
  });

  it("starts one clean retry after a context overflow", async () => {
    let calls = 0;
    await expect(runDailyReportStageLoop({
      stage: "assess",
      run: async () => {
        calls += 1;
        throw new Error("context length exceeded");
      },
      validate: () => [],
    })).rejects.toMatchObject({ name: "DailyReportStageLoopError", cleanRetryCount: 1 });
    expect(calls).toBe(2);
  });
});
