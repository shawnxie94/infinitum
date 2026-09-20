import type { BackgroundTaskRun } from "@prisma/client";

import { isWorkflowKind, triggerTaskWorkflow } from "@/lib/ai-orchestration/runtime";
import { executeTaskRun } from "@/lib/tasks/handlers";

/**
 * D10 执行归属路由表（spec Revision 2）：同一 task kind 只有一条执行路径。
 * 3 个 AI 批量链 → Mastra workflow（@infinitum/ai runtime）；
 * 其余 8 个 kind → 原 handler 直调（单次 AI 短任务 tick 直调 + 切新 provider 层，见分类）。
 * 回滚 = 把对应 kind 移出 workflow 集合（拨路由不回滚代码）。
 */
export async function dispatchTaskRun(taskRun: BackgroundTaskRun): Promise<void> {
  if (isWorkflowKind(taskRun.kind)) {
    await triggerTaskWorkflow(taskRun.kind, taskRun.id);
    return;
  }
  await executeTaskRun(taskRun);
}
