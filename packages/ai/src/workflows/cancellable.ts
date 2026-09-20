import type { Client } from "@libsql/client";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

/** G6：D6 wrapper 协作取消原型的取消信号（走 DB flag，跨进程可读）。 */
export class P0CooperativeCancelError extends Error {
  readonly kind = "p0-cooperative-cancel";
}

/** 协作取消脚手架：DB flag 表 + 读取器，等价 D6 wrapper 的「步边界检查」雏形。 */
export async function ensureCancelFlagTable(client: Client): Promise<void> {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS p0_cancel_flags (
      lease_key TEXT PRIMARY KEY,
      requested_at INTEGER NOT NULL
    )
  `);
}

export async function requestCancel(client: Client, leaseKey: string): Promise<void> {
  await ensureCancelFlagTable(client);
  await client.execute({
    sql: "INSERT INTO p0_cancel_flags (lease_key, requested_at) VALUES (?, ?) ON CONFLICT(lease_key) DO UPDATE SET requested_at = excluded.requested_at",
    args: [leaseKey, Date.now()],
  });
}

export type CancelFlagReader = (leaseKey: string) => Promise<boolean>;

export function createCancelFlagReader(client: Client): CancelFlagReader {
  return async (leaseKey) => {
    const rows = await client.execute({
      sql: "SELECT requested_at FROM p0_cancel_flags WHERE lease_key = ?",
      args: [leaseKey],
    });
    return rows.rows.length > 0;
  };
}

/**
 * G6：带协作取消的长循环工作流。
 * 步内每轮检查 DB flag（跨进程主路径，D7）与原生 abortSignal（同进程优化），
 * 命中则写取消标记并抛 P0CooperativeCancelError；跑到 30 轮自然完成。
 */
export function createCancellableWorkflow({ readCancelFlag }: { readCancelFlag: CancelFlagReader }) {
  return createWorkflow({
    id: "p0_cancellable",
    inputSchema: z.object({ leaseKey: z.string() }),
    outputSchema: z.object({ iterations: z.number(), outcome: z.string() }),
    retryConfig: { attempts: 1 },
  })
    .then(
      createStep({
        id: "loop",
        inputSchema: z.object({ leaseKey: z.string() }),
        outputSchema: z.object({ iterations: z.number(), outcome: z.string() }),
        execute: async ({ inputData, abortSignal }) => {
          let iterations = 0;
          for (;;) {
            if (await readCancelFlag(inputData.leaseKey)) {
              throw new P0CooperativeCancelError("cancelled via DB flag");
            }
            if (abortSignal?.aborted) {
              throw new P0CooperativeCancelError("cancelled via abortSignal");
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
            iterations += 1;
            if (iterations >= 30) {
              return { iterations, outcome: "completed" };
            }
          }
        },
      }),
    )
    .commit();
}
