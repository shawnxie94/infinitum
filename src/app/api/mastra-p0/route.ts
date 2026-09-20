import { NextResponse } from "next/server";

import { createP0Runtime } from "@infinitum/ai/runtime";

/**
 * P0 验证路由（G3b）：Next.js 进程内启动 hello workflow。
 * P0 临时产物，P1a 建 runtime 单例时移除。
 */
export async function GET() {
  const mastra = createP0Runtime();
  const run = await mastra.getWorkflow("p0_hello").createRun();
  const result = (await run.start({ inputData: { name: "nextjs" } })) as unknown as {
    status: string;
    result?: { message?: string; at?: string };
  };
  return NextResponse.json({ status: result.status, result: result.result ?? null, runId: run.runId });
}
