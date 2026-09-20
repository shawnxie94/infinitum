/**
 * 任务 workflow 编排类型：主仓业务体通过注入接入 Mastra（依赖倒置，
 * packages/ai 不 import 主仓模块——D9 所有权边界）。
 */
import type { Workflow } from "@mastra/core/workflows";

/** BackgroundTaskRun 行的最小投影（body 启动时由 sink 重新读取，保证拿到最新检查点）。 */
export type TaskRunSnapshot = {
  id: string;
  kind: string;
  entityId: string | null;
  triggerType: string;
  pipelineCheckpointJson: string | null;
  /** body 执行前的行状态（queued/running/...）；workflow 结束后再读一次用于终态镜像。 */
  status?: string;
};

/** 业务执行体：原 executeTaskRun handler 语义（自己负责 BackgroundTaskRun 状态簿记、取消轮询、检查点）。 */
export type TaskBody = (taskRun: TaskRunSnapshot) => Promise<void>;

export type WorkflowTaskSink = {
  getTaskRun(taskRunId: string): Promise<TaskRunSnapshot | null>;
  isCancellationRequested(taskRunId: string): Promise<boolean>;
};

export type TaskWorkflow = Workflow<any, any, any, any, any, any, any>;
