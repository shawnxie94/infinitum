import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

/**
 * G4/G5：可挂起 + 可崩溃恢复的最小工作流。
 * checkpoint → gate(suspend/resume) → finish。
 */
export const recoverableWorkflow = createWorkflow({
  id: "p0_recoverable",
  inputSchema: z.object({ token: z.string() }),
  outputSchema: z.object({ token: z.string(), resumedFromSuspend: z.boolean() }),
})
  .then(
    createStep({
      id: "checkpoint",
      inputSchema: z.object({ token: z.string() }),
      outputSchema: z.object({ token: z.string() }),
      execute: async ({ inputData }) => ({ token: inputData.token }),
    }),
  )
  .then(
    createStep({
      id: "gate",
      inputSchema: z.object({ token: z.string() }),
      outputSchema: z.object({ token: z.string() }),
      resumeSchema: z.object({ approved: z.boolean() }),
      suspendSchema: z.object({ reason: z.string() }),
      execute: async ({ inputData, resumeData, suspend }) => {
        if (!resumeData?.approved) {
          await suspend({ reason: "waiting-for-approval" });
        }
        return { token: inputData.token };
      },
    }),
  )
  .then(
    createStep({
      id: "finish",
      inputSchema: z.object({ token: z.string() }),
      outputSchema: z.object({ token: z.string(), resumedFromSuspend: z.boolean() }),
      execute: async ({ inputData }) => ({ token: inputData.token, resumedFromSuspend: true }),
    }),
  )
  .commit();
