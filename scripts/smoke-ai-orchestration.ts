/**
 * 迁移冒烟（P1b-P4 接线）：真实 runtime + LibSQL 存储 + workflow 启动/终态镜像。
 * 用不存在的 taskRunId → sink 返回 null → step 返回 missing，不触碰业务数据。
 */
import { getAiRuntime, triggerTaskWorkflow } from "@/lib/ai-orchestration/runtime";

async function main() {
  const runtime = getAiRuntime();
  for (const kind of ["daily_report_generate", "ingestion", "item_processing_recovery"]) {
    const wf = runtime.mastra.getWorkflow(kind);
    if (!wf) throw new Error(`workflow ${kind} 未注册`);
    console.log(`registered: ${kind} id=${wf.id}`);
  }
  const result = await triggerTaskWorkflow("item_processing_recovery", "smoke-nonexistent-row");
  console.log("trigger result:", JSON.stringify(result));
  if (result.status !== "missing") throw new Error(`期望 missing，实际 ${result.status}`);
  console.log("SMOKE PASS");
  process.exit(0);
}

main().catch((error) => {
  console.error("SMOKE FAIL", error);
  process.exit(1);
});
