/**
 * G4：LibSQL 文件存储与双进程同库访问。
 * - mode=tables：查 mastra_% 表与 journal_mode（WAL/busy_timeout）
 * - mode=suspend-child：启动 recoverable 至挂起，打印 runId 后退出
 * - mode=resume-parent：新进程 resume 挂起 run（验证跨进程持久化）
 * - mode=dual：双进程并发跑 hello + 直写（lock 冲突观测）
 * - mode=dual-worker：dual 的子进程
 */
import { spawnSync } from "node:child_process";
import { createP0Runtime } from "../runtime";
import { assert, DB_URL, fail, gate, openClient, pass } from "./helpers";

const tsx = ["npx", "tsx"];

async function modeTables() {
  gate("g4-tables");
  const client = openClient();
  const journal = await client.execute("PRAGMA journal_mode");
  const tables = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'mastra%' ORDER BY name",
  );
  assert("g4", tables.rows.length > 0, `mastra tables=${tables.rows.length}`);
  console.log("journal_mode:", JSON.stringify(journal.rows[0]));
  console.log("mastra tables:", tables.rows.map((r) => String(r.name)).join(", "));
  pass("g4-tables", { journalMode: String(journal.rows[0]?.journal_mode ?? "?"), tableCount: tables.rows.length });
}

async function modeSuspendChild() {
  const mastra = createP0Runtime();
  const run = await mastra.getWorkflow("p0_recoverable").createRun();
  const started = (await run.start({
    inputData: { token: "tok-" + Date.now() },
  })) as unknown as { status: string };
  if (started.status !== "suspended") {
    console.log(`CHILD_ERROR status=${started.status}`);
    process.exit(1);
  }
  console.log(`CHILD_RUNID ${run.runId}`);
  process.exit(0);
}

async function modeResumeParent(childRunId: string) {
  gate("g4-restart-resume");
  // 新进程、新 runtime 实例：证明状态确实持久化在文件而非进程内。
  const mastra = createP0Runtime();
  const workflow = mastra.getWorkflow("p0_recoverable");
  const run = await workflow.createRun({ runId: childRunId });
  const out = (await run.resume({
    step: "gate",
    resumeData: { approved: true },
  })) as unknown as { status: string; result?: { token?: string; resumedFromSuspend?: boolean } };
  assert("g4", out.status === "success", `resume status=${out.status}`);
  assert("g4", out.result?.resumedFromSuspend === true, `result=${JSON.stringify(out.result)}`);
  pass("g4-restart-resume", { runId: childRunId, result: out.result });
}

async function modeDual() {
  gate("g4-dual-process");
  const env = { ...process.env, MASTRA_P0_DB: DB_URL };
  const procs = ["a", "b"].map((w) =>
    spawnSync(tsx[0], [...tsx.slice(1), "packages/ai/src/verify/g4-storage.ts", "dual-worker", w], {
      encoding: "utf8",
      env,
      timeout: 120_000,
    }),
  );
  const errors = procs
    .map((p, i) => ({ w: ["a", "b"][i], status: p.status, stderr: p.stderr, stdout: p.stdout }))
    .filter((p) => p.status !== 0);
  for (const e of errors) {
    console.log(`worker ${e.w} failed:\n--- stdout\n${e.stdout}\n--- stderr\n${e.stderr}`);
  }
  assert("g4", errors.length === 0, `${errors.length}/2 dual workers failed`);
  const client = openClient();
  const rows = await client.execute("SELECT COUNT(*) AS n FROM p0_dual_writes");
  const n = Number(rows.rows[0]?.n ?? 0);
  assert("g4", n >= 6, `dual direct writes=${n}`);
  pass("g4-dual-process", { directWrites: n });
}

async function modeDualWorker(worker: string) {
  const mastra = createP0Runtime();
  const client = openClient();
  await client.execute(`
    CREATE TABLE IF NOT EXISTS p0_dual_writes (
      worker TEXT NOT NULL,
      seq INTEGER NOT NULL,
      at INTEGER NOT NULL
    )
  `);
  for (let i = 0; i < 3; i += 1) {
    const run = await mastra.getWorkflow("p0_hello").createRun();
    const result = (await run.start({ inputData: { name: `dual-${worker}-${i}` } })) as unknown as {
      status: string;
    };
    if (result.status !== "success") throw new Error(`workflow ${worker}-${i} status=${result.status}`);
    await client.execute({ sql: "INSERT INTO p0_dual_writes (worker, seq, at) VALUES (?, ?, ?)", args: [worker, i, Date.now()] });
  }
  console.log(`WORKER_DONE ${worker}`);
  process.exit(0);
}

async function main() {
  const mode = process.argv[2] ?? "tables";
  if (mode === "tables") return modeTables();
  if (mode === "suspend-child") return modeSuspendChild();
  if (mode === "resume-parent") return modeResumeParent(process.argv[3] ?? "");
  if (mode === "dual") return modeDual();
  if (mode === "dual-worker") return modeDualWorker(process.argv[3] ?? "a");
  throw new Error(`unknown mode ${mode}`);
}

main().catch((error: unknown) => {
  fail("g4-storage", { error: error instanceof Error ? error.message : String(error) });
});
