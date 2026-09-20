import type { Workflow } from "@mastra/core/workflows";
import { createClient } from "@libsql/client";
import { Mastra } from "@mastra/core";
import { LibSQLStore } from "@mastra/libsql";
import path from "node:path";

import { createCancelFlagReader, createCancellableWorkflow } from "./workflows/cancellable";
import { helloWorkflow } from "./workflows/hello";
import { recoverableWorkflow } from "./workflows/recoverable";

/**
 * P0 验证用 DB 地址：默认复用仓内 prisma/dev.db（C1「同库共存」口径），
 * 验证门可用 MASTRA_P0_DB 指到独立文件。
 */
export function resolveP0DbUrl(): string {
  if (process.env.MASTRA_P0_DB) return process.env.MASTRA_P0_DB;
  return "file:" + path.join(process.cwd(), "prisma", "dev.db");
}

/**
 * P0 内嵌 runtime 原型：与生产目标一致——双进程各自内嵌 Mastra，
 * 共享同一 SQLite 文件（D11），并发仲裁交给触发层 DB 信号量（D5）。
 */
export function createP0Runtime({ dbUrl = resolveP0DbUrl() }: { dbUrl?: string } = {}) {
  const storage = new LibSQLStore({ id: "p0-store", url: dbUrl });
  const flagClient = createClient({ url: dbUrl });
  return new Mastra({
    storage,
    logger: false,
    workflows: {
      p0_hello: helloWorkflow,
      p0_recoverable: recoverableWorkflow,
      p0_cancellable: createCancellableWorkflow({ readCancelFlag: createCancelFlagReader(flagClient) }),
    },
  });
}

/* eslint-disable @typescript-eslint/no-explicit-any -- P0 占位类型：真实 workflow 泛型在 P1a 定型 */
export type P0Mastra = ReturnType<typeof createP0Runtime>;
export type P0Workflow = Workflow<any, any, any, any, any, any, any>;
