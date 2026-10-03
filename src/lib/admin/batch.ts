/**
 * 管理台批量操作的共用执行器。
 *
 * 约束来自产品决策：单次上限 50、逐条串行、成功/失败明细分开返回。
 * 串行是有意的——批量项之间往往共享聚类/实体状态，并发会互相踩。
 */

export const ADMIN_BATCH_MAX_ITEMS = 50;

export class AdminBatchLimitError extends Error {
  readonly status = 400;

  constructor(limit: number) {
    super(`单次批量操作最多 ${limit} 条，请缩小选择范围后重试。`);
    this.name = "AdminBatchLimitError";
  }
}

export function assertBatchSize(ids: readonly string[], limit = ADMIN_BATCH_MAX_ITEMS) {
  if (ids.length === 0) {
    throw new Error("请先选择要批量处理的内容。");
  }

  if (ids.length > limit) {
    throw new AdminBatchLimitError(limit);
  }

  const unique = [...new Set(ids)];
  if (unique.length !== ids.length) {
    throw new Error("选择中包含重复项，请刷新后重试。");
  }

  return unique;
}

export type BatchItemFailure = {
  id: string;
  error: string;
};

export type BatchExecutionResult = {
  succeeded: string[];
  failed: BatchItemFailure[];
  total: number;
};

function getItemErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return "处理失败";
}

/**
 * 逐条串行执行批量操作。单项失败不中断整批，失败原因逐条回传。
 */
export async function runAdminBatch<T>(
  items: readonly T[],
  getId: (item: T) => string,
  execute: (item: T) => Promise<unknown>,
): Promise<BatchExecutionResult> {
  const succeeded: string[] = [];
  const failed: BatchItemFailure[] = [];

  for (const item of items) {
    const id = getId(item);
    try {
      await execute(item);
      succeeded.push(id);
    } catch (error) {
      failed.push({ id, error: getItemErrorMessage(error) });
    }
  }

  return { succeeded, failed, total: items.length };
}
