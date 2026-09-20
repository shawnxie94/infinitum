/**
 * 内嵌 Mastra runtime（spec D11）：双进程（Next.js + worker）各自内嵌实例，
 * 共享 LibSQL 存储；同 kind 唯一执行者由触发层 DB 信号量仲裁（D5）。
 */
import { Mastra } from "@mastra/core";
import { LibSQLStore } from "@mastra/libsql";
import type { Workflow } from "@mastra/core/workflows";

export type AiRuntime = {
  mastra: Mastra;
  shutdown: () => Promise<void>;
};

export function resolveStorageUrl(databaseUrl: string | undefined): string {
  const raw = databaseUrl || "file:./prisma/dev.db";
  // Prisma 风格相对路径（file:./prisma/dev.db）以进程 cwd 为基准，与主仓一致。
  return raw.startsWith("file:") ? raw : `file:${raw}`;
}

export function createAiRuntime(input: {
  databaseUrl?: string;
  workflows: Record<string, Workflow<any, any, any, any, any, any, any>>;
}): AiRuntime {
  const storage = new LibSQLStore({
    id: "infinitum-ai-store",
    url: resolveStorageUrl(input.databaseUrl ?? process.env.DATABASE_URL),
  });
  const mastra = new Mastra({
    storage,
    workflows: input.workflows,
  });

  return {
    mastra,
    async shutdown() {
      const disposable = mastra as unknown as { shutdown?: () => Promise<void> };
      if (typeof disposable.shutdown === "function") {
        await disposable.shutdown();
      }
    },
  };
}

/** worker 启动时调用：把崩溃进程遗留的 active run 重新拉起（spec G5 已验证）。 */
export async function restartActiveWorkflowRuns(runtime: AiRuntime): Promise<void> {
  const api = runtime.mastra as unknown as { restartAllActiveWorkflowRuns?: () => Promise<void> };
  if (typeof api.restartAllActiveWorkflowRuns === "function") {
    await api.restartAllActiveWorkflowRuns();
  }
}
