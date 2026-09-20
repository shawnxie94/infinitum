import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

/** G3：双步最小链——验证 createWorkflow/createStep/start/commit 与步间类型传递。 */
export const helloWorkflow = createWorkflow({
  id: "p0_hello",
  inputSchema: z.object({ name: z.string() }),
  outputSchema: z.object({ message: z.string(), at: z.string() }),
  retryConfig: { attempts: 2, delay: 50 },
})
  .then(
    createStep({
      id: "greet",
      inputSchema: z.object({ name: z.string() }),
      outputSchema: z.object({ greeting: z.string() }),
      execute: async ({ inputData }) => ({ greeting: `hello ${inputData.name}` }),
    }),
  )
  .then(
    createStep({
      id: "shout",
      inputSchema: z.object({ greeting: z.string() }),
      outputSchema: z.object({ message: z.string(), at: z.string() }),
      execute: async ({ inputData }) => ({
        message: `${inputData.greeting}!`.toUpperCase(),
        at: new Date().toISOString(),
      }),
    }),
  )
  .commit();
