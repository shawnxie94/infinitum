import type { BackgroundTaskRun } from "@prisma/client";

import { isWorkflowKind, triggerTaskWorkflow } from "@/lib/ai-orchestration/runtime";
import { getTaskDefinition } from "@/lib/tasks/definitions";

/**
 * D10 执行归属路由表（spec Revision 2）：同一 task kind 只有一条执行路径。
 * 11 个 kind → Mastra workflow（@infinitum/ai runtime）；
 * handler-mode kind 仍复用原 domain service body，但生命周期与执行入口统一托管。
 * 回滚 = 把对应 kind 移出 workflow 集合（拨路由不回滚代码）。
 */
export async function dispatchTaskRun(taskRun: BackgroundTaskRun): Promise<void> {
  getTaskDefinition(taskRun.kind);
  if (isWorkflowKind(taskRun.kind)) {
    await triggerTaskWorkflow(taskRun.kind, taskRun.id);
    return;
  }
  throw new Error(`Task ${taskRun.kind} is declared but has no workflow runtime.`);
}
