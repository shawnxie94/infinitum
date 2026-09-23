import type { BackgroundTaskRun } from "@prisma/client";

import { isWorkflowKind, triggerTaskWorkflow } from "@/lib/ai-orchestration/runtime";
import { getTaskDefinition } from "@/lib/tasks/definitions";

/**
 * D10 执行归属路由表（spec Revision 2）：同一 task kind 只有一条执行路径。
 * 10 个当前 kind → Mastra workflow（@infinitum/ai runtime）；
 * 每个 kind 都由声明式 domain stages 提供业务能力，生命周期与执行入口统一由 framework 托管。
 * 回滚 = 把对应 kind 移出 workflow 集合（拨路由不回滚代码）。
 */
export async function dispatchTaskRun(taskRun: BackgroundTaskRun): Promise<void> {
  // Drain rows created by retired kinds without breaking historical queues:
  // the old precompute kind maps to the unified pipeline, while old reparse
  // rows retain their executor. New task creation rejects both kinds.
  if (taskRun.kind === "cluster_merge_precompute_clean_pairs") {
    await triggerTaskWorkflow("precompute", taskRun.id);
    return;
  }
  if (taskRun.kind === "item_reparse_aggregations" && isWorkflowKind(taskRun.kind)) {
    await triggerTaskWorkflow(taskRun.kind, taskRun.id);
    return;
  }
  getTaskDefinition(taskRun.kind);
  if (isWorkflowKind(taskRun.kind)) {
    await triggerTaskWorkflow(taskRun.kind, taskRun.id);
    return;
  }
  throw new Error(`Task ${taskRun.kind} is declared but has no workflow runtime.`);
}
