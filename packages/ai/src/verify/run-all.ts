/**
 * P0 验证门编排器：顺序执行 G1-G8，产出逐门 PASS/FAIL 与 results.json。
 * 前置：prisma/dev.db 已存在（npm run db:setup）。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { parseGateResult } from "./helpers";

const ROOT = process.cwd();
const ENV = { ...process.env, MASTRA_P0_DB: process.env.MASTRA_P0_DB ?? "file:" + path.join(ROOT, "prisma", "dev.db") };
const results: { gate: string; verdict: string; detail?: string }[] = [];

function record(gate: string, verdict: string, detail?: string): void {
  results.push({ gate, verdict, detail });
  console.log(`>>> ${gate}: ${verdict}${detail ? ` — ${detail}` : ""}`);
}

function runSync(name: string, cmd: string, args: string[], opts: { timeout?: number } = {}): string {
  const p = spawnSync(cmd, args, { encoding: "utf8", env: ENV, cwd: ROOT, timeout: opts.timeout ?? 120_000 });
  const out = `${p.stdout ?? ""}\n${p.stderr ?? ""}`;
  const line = (p.stdout ?? "").split("\n").find((l) => l.startsWith("GATE_RESULT "));
  const parsed = line ? parseGateResult(line) : null;
  const verdict = p.status === 0 && parsed?.verdict === "PASS" ? "PASS" : "FAIL";
  record(name, verdict, verdict === "FAIL" ? out.slice(-800) : undefined);
  return out;
}

/** 后台子进程：抓取 KEY value 行并等待退出。 */
async function runBackground(
  name: string,
  args: string[],
  keys: string[],
  opts: { timeout?: number } = {},
): Promise<{ code: number | null; captured: Record<string, string> }> {
  return await new Promise((resolve) => {
    const child = spawn("npx", ["tsx", ...args], { env: ENV, cwd: ROOT });
    const captured: Record<string, string> = {};
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeout ?? 60_000);
    const rl = readline.createInterface({ input: child.stdout ?? process.stdin });
    rl.on("line", (line) => {
      for (const key of keys) {
        if (line.startsWith(`${key} `)) captured[key] = line.slice(key.length + 1).trim();
      }
      console.log(`  [${name}] ${line}`);
    });
    child.stderr?.on("data", (d) => console.error(`  [${name}!err] ${String(d).slice(0, 300)}`));
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, captured });
    });
  });
}

async function gateNextRoute(): Promise<void> {
  const port = 3123;
  const child = spawn("npx", ["next", "dev", "-p", String(port)], { env: ENV, cwd: ROOT });
  let log = "";
  child.stdout?.on("data", (d) => (log += String(d)));
  child.stderr?.on("data", (d) => (log += String(d)));
  try {
    const deadline = Date.now() + 150_000;
    let body: unknown = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2_000));
      try {
        const res = await fetch(`http://localhost:${port}/api/mastra-p0`);
        if (res.ok) {
          body = await res.json();
          break;
        }
      } catch {
        /* 还在启动 */
      }
    }
    const out = body as { status?: string; result?: { message?: string } } | null;
    if (out?.status === "success" && out.result?.message) {
      record("g3b-next-route", "PASS", JSON.stringify(out.result));
    } else {
      record("g3b-next-route", "FAIL", `body=${JSON.stringify(body)}\nlog tail: ${log.slice(-600)}`);
    }
  } finally {
    child.kill("SIGTERM");
  }
}

async function main(): Promise<void> {
  const dbPath = path.join(ROOT, "prisma", "dev.db");
  if (!existsSync(dbPath)) {
    console.error(`缺少 ${dbPath}——先跑 npm run db:setup`);
    process.exit(2);
  }
  const envPath = path.join(ROOT, ".env");
  if (!existsSync(envPath)) {
    writeFileSync(
      envPath,
      ["DATABASE_URL=\"file:./prisma/dev.db\"", "ADMIN_PASSWORD=p0-dev-only", "ADMIN_SESSION_SECRET=p0-dev-secret"].join("\n") + "\n",
    );
  }

  // G2 钉版
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "packages/ai/package.json"), "utf8"));
  const core = String(pkg.dependencies["@mastra/core"]);
  const libsql = String(pkg.dependencies["@mastra/libsql"]);
  const pinned = core === "1.67.0" && libsql === "1.23.0";
  record("g2-pinned-versions", pinned ? "PASS" : "FAIL", `core=${core} libsql=${libsql}`);

  // G1 workspace build
  const build = spawnSync("npm", ["run", "build", "-w", "@infinitum/ai"], { encoding: "utf8", cwd: ROOT, env: ENV, timeout: 120_000 });
  record("g1-workspace-build", build.status === 0 ? "PASS" : "FAIL", build.status === 0 ? undefined : `${build.stdout}\n${build.stderr}`.slice(-800));

  // G3 node hello
  runSync("g3-hello-node", "npx", ["tsx", "packages/ai/src/verify/g3-hello-node.ts"]);

  // G3b Next route
  await gateNextRoute();

  // G4 存储与双进程
  runSync("g4-tables", "npx", ["tsx", "packages/ai/src/verify/g4-storage.ts", "tables"]);
  const susp = await runBackground("g4-suspend-child", ["packages/ai/src/verify/g4-storage.ts", "suspend-child"], ["CHILD_RUNID"], { timeout: 60_000 });
  if (susp.code === 0 && susp.captured.CHILD_RUNID) {
    const runId = susp.captured.CHILD_RUNID.replace(/^"|"$/g, "");
    runSync("g4-restart-resume", "npx", ["tsx", "packages/ai/src/verify/g4-storage.ts", "resume-parent", runId], { timeout: 90_000 });
  } else {
    record("g4-restart-resume", "FAIL", `suspend-child 未产出 runId (code=${susp.code})`);
  }
  runSync("g4-dual-process", "npx", ["tsx", "packages/ai/src/verify/g4-storage.ts", "dual"], { timeout: 180_000 });

  // G5 崩溃恢复
  const victim = await runBackground("g5-victim", ["packages/ai/src/verify/g5-crash-recovery.ts", "victim"], ["VICTIM_RUNID"], { timeout: 45_000 });
  if (victim.captured.VICTIM_RUNID) {
    const runId = victim.captured.VICTIM_RUNID.replace(/^"|"$/g, "");
    runSync("g5-crash-recovery", "npx", ["tsx", "packages/ai/src/verify/g5-crash-recovery.ts", "recover", runId], { timeout: 120_000 });
  } else {
    record("g5-crash-recovery", "FAIL", `victim 未产出 runId (code=${victim.code})`);
  }

  // G6 取消 / G7 事件 / G8 信号量
  runSync("g6-cancel", "npx", ["tsx", "packages/ai/src/verify/g6-cancel.ts", "all"], { timeout: 180_000 });
  runSync("g7-events", "npx", ["tsx", "packages/ai/src/verify/g7-events.ts"], { timeout: 90_000 });
  runSync("g8-semaphore-skip", "npx", ["tsx", "packages/ai/src/verify/g8-semaphore.ts", "skip"]);
  runSync("g8-semaphore-race", "npx", ["tsx", "packages/ai/src/verify/g8-semaphore.ts", "race"], { timeout: 90_000 });

  const failed = results.filter((r) => r.verdict === "FAIL");
  console.log("\n================ P0 验证汇总 ================");
  for (const r of results) console.log(`${r.verdict === "PASS" ? "✅" : "❌"} ${r.gate}`);
  writeFileSync(path.join(ROOT, "packages/ai/src/verify/results.json"), JSON.stringify(results, null, 2) + "\n");
  console.log(`\n${results.length - failed.length}/${results.length} PASS；明细在 packages/ai/verify/results.json`);
  process.exit(failed.length > 0 ? 1 : 0);
}

void main();
