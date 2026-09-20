/**
 * G5：崩溃恢复 API 钉版。
 * - mode=victim：启动「慢步」工作流（每轮执行写 attempts 表），被父进程 SIGKILL 制造孤儿 running run
 * - mode=recover：新进程 listActiveWorkflowRuns → restartAllActiveWorkflowRuns → 轮询至成功
 * - 验证点：孤儿 run 被拾起、中断步重新执行（attempt 行数 ≥2）、终态 success
 * - 记录点：1.67 的 Config.recovery 只有 durableAgents（无 autoRestartActiveRuns 配置），
 *   自动恢复 = 显式调 restartAllActiveWorkflowRuns()（worker 启动时挂一次即可）
 */
import type { Client } from "@libsql/client";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { Mastra } from "@mastra/core";
import { LibSQLStore } from "@mastra/libsql";
import { DB_URL, ensureFlagTables, fail, gate, openClient, pass, sleep } from "./helpers";const SLOW_MS = 8_000;

async function slowStepSideEffect(client: Client, runId: string, attempt: number): Promise<void> {
  await ensureFlagTables(client);
  await client.execute({
    sql: "INSERT INTO p0_step_attempts (run_id, attempt, at) VALUES (?, ?, ?)",
    args: [runId, attempt, Date.now()],
  });
}

async function modeVictim() {
  const client = openClient();
  const storage = new LibSQLStore({ id: "p0-store", url: DB_URL });
  const workflow = createWorkflow({
    id: "p0_crashy",
    inputSchema: z.object({ token: z.string() }),
    outputSchema: z.object({ token: z.string() }),
  })
    .then(
      createStep({
        id: "slow",
        inputSchema: z.object({ token: z.string() }),
        outputSchema: z.object({ token: z.string() }),
        execute: async ({ inputData, runId, retryCount }) => {
          await slowStepSideEffect(client, runId, retryCount + 1);
          await sleep(SLOW_MS);
          return { token: inputData.token };
        },
      }),
    )
    .commit();
  const mastra = new Mastra({ storage, logger: false, workflows: { p0_crashy: workflow } });
  const run = await mastra.getWorkflow("p0_crashy").createRun();
  await run.startAsync({ inputData: { token: "crash-" + Date.now() } });
  console.log(`VICTIM_RUNID ${run.runId}`);
  await sleep(1_500); // 进入 slow 步中段
  process.exit(9); // 硬崩：无清理、无终态写入
}

async function modeRecover(victimRunId: string) {
  gate("g5-crash-recovery");
  const client = openClient();
  const mastra = new Mastra({
    storage: new LibSQLStore({ id: "p0-store", url: DB_URL }),
    logger: false,
    workflows: { p0_crashy: createCrashyWorkflow() },
  });
  const lister = mastra as unknown as {
    listActiveWorkflowRuns(): Promise<{ runs: { runId: string; workflowId?: string; status?: string }[] }>;
    restartAllActiveWorkflowRuns(): Promise<void>;
    recoveryConfig: unknown;
  };
  const active = await lister.listActiveWorkflowRuns();
  const runs = active.runs ?? [];
  console.log("active runs after crash:", JSON.stringify(runs.map((r) => ({ runId: r.runId, status: r.status }))));
  const orphan = runs.find((r) => r.runId === victimRunId) ?? runs[0];
  if (!orphan) return fail("g5-crash-recovery", { error: `orphan run ${victimRunId} not found`, active: runs });

  console.log("recoveryConfig:", JSON.stringify(lister.recoveryConfig));
  await lister.restartAllActiveWorkflowRuns();

  // 轮询终态（slow 步重跑约 8s）；1.67 的 run 状态存于 mastra_workflow_snapshot.snapshot JSON
  let finalStatus = "";
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    const res = await client.execute({
      sql: "SELECT json_extract(snapshot, '$.status') AS status FROM mastra_workflow_snapshot WHERE run_id = ?",
      args: [orphan.runId],
    });
    const st = String(res.rows[0]?.status ?? "");
    if (st === "success" || st === "failed") {
      finalStatus = st;
      break;
    }
  }

  const attempts = await client.execute({
    sql: "SELECT COUNT(*) AS n FROM p0_step_attempts WHERE run_id = ?",
    args: [orphan.runId],
  });
  const attemptCount = Number(attempts.rows[0]?.n ?? 0);
  console.log("final status:", finalStatus, "| attempts:", attemptCount);
  if (finalStatus !== "success") {
    return fail("g5-crash-recovery", { finalStatus, attemptCount, orphan: orphan.runId });
  }
  if (attemptCount < 2) {
    return fail("g5-crash-recovery", { error: "interrupted step not re-executed", attemptCount });
  }
  pass("g5-crash-recovery", { runId: orphan.runId, finalStatus, attemptCount });
}

function createCrashyWorkflow() {
  const client: Client = openClient();
  return createWorkflow({
    id: "p0_crashy",
    inputSchema: z.object({ token: z.string() }),
    outputSchema: z.object({ token: z.string() }),
  })
    .then(
      createStep({
        id: "slow",
        inputSchema: z.object({ token: z.string() }),
        outputSchema: z.object({ token: z.string() }),
        execute: async ({ inputData, runId, retryCount }) => {
          await slowStepSideEffect(client, runId, retryCount + 1);
          await sleep(SLOW_MS);
          return { token: inputData.token };
        },
      }),
    )
    .commit();
}

async function main() {
  const mode = process.argv[2] ?? "recover";
  if (mode === "victim") return modeVictim();
  if (mode === "recover") return modeRecover(process.argv[3] ?? "");
  throw new Error(`unknown mode ${mode}`);
}

main().catch((error: unknown) => {
  fail("g5-crash-recovery", { error: error instanceof Error ? error.message : String(error) });
});
