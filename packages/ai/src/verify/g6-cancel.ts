/**
 * G6：取消行为钉版（@mastra/core 1.67.0）。
 * variant=complete：无取消基线（30 轮自然完成）
 * variant=flag：DB flag 协作取消（D7 主路径原型）—— 步内抛 P0CooperativeCancelError
 * variant=native：run.cancel()（abortController）—— 钉实际终态与是否中断步内循环
 */
import { createP0Runtime } from "../runtime";
import { ensureCancelFlagTable, requestCancel } from "../workflows/cancellable";
import { assert, fail, gate, openClient, pass, sleep } from "./helpers";

type RunView = {
  status: string;
  runId?: string;
  error?: unknown;
  result?: { iterations?: number; outcome?: string };
};

async function runVariant(kind: "native" | "flag" | "complete") {
  gate(`g6-cancel-${kind}`);
  const leaseKey = `g6-${kind}-${Date.now()}`;
  const mastra = createP0Runtime();
  const workflow = mastra.getWorkflow("p0_cancellable");
  const client = openClient();
  await ensureCancelFlagTable(client);

  const run = await workflow.createRun();
  const startedAt = Date.now();
  const finished = run.start({ inputData: { leaseKey } }) as unknown as Promise<RunView>;

  if (kind === "flag") {
    await sleep(800);
    await requestCancel(client, leaseKey);
  } else if (kind === "native") {
    await sleep(800);
    await run.cancel();
  }

  const result = await finished;
  const wallMs = Date.now() - startedAt;
  const errorText = result.error ? String(result.error).slice(0, 240) : null;
  console.log(`[${kind}] status=${result.status} wallMs=${wallMs} result=${JSON.stringify(result.result)}`);
  console.log(`[${kind}] error=${errorText}`);

  if (kind === "complete") {
    assert("g6", result.status === "success", `complete status=${result.status}`);
    assert("g6", result.result?.iterations === 30, `iterations=${result.result?.iterations}`);
    return { status: result.status, wallMs };
  }
  if (kind === "flag") {
    assert("g6", result.status === "failed", `flag 期望协作取消以 failed 终态返回，实际=${result.status}`);
    assert("g6", wallMs < 2_500, `flag 取消应快速终止，wallMs=${wallMs}`);
    return { status: result.status, wallMs, cancelledVia: "db-flag" };
  }
  // native：不预设通过条件，钉行为产出（预期二选一：'canceled' 边界生效 / 'failed' 步内 abortSignal 命中 /
  // 或社区报告的卡 suspended）。快慢对比：cancel@0.8s 后若 wallMs≈3000 说明步内循环未被中断（仅在边界生效）。
  return { status: result.status, wallMs, errorText, pinned: true };
}

async function main() {
  const variant = (process.argv[2] ?? "all") as "native" | "flag" | "complete" | "all";
  const results: Record<string, unknown> = {};
  if (variant === "all" || variant === "complete") results.complete = await runVariant("complete");
  if (variant === "all" || variant === "flag") results.flag = await runVariant("flag");
  if (variant === "all" || variant === "native") results.native = await runVariant("native");
  pass("g6-cancel", results);
}

main().catch((error: unknown) => {
  fail("g6-cancel", { error: error instanceof Error ? error.message : String(error) });
});
