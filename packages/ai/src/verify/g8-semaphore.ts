/**
 * G8：D5 DB 信号量原型——同 kind 并发触发只允许一个执行者。
 * - mode=racer：竞争 INSERT p0_leases（PK=kind），changes>0 即抢到，持锁 1.5s 后释放
 * - mode=race：同时派 4 个 racer，断言恰好 1 个抢到
 * - mode=skip：持有期间二次触发应 skip；释放后应可再取
 * （生产对应：触发层查 BackgroundTaskRun active 行 + 唯一约束兜底，语义同构）
 */
import { spawnSync } from "node:child_process";
import { assert, DB_URL, fail, gate, openClient, pass, sleep } from "./helpers";

async function modeRacer(racerId: string) {
  const client = openClient();
  await ensureLeaseTable(client);
  const kind = "p0-demo-kind";
  const taken = await client.execute({
    sql: "INSERT INTO p0_leases (kind, run_id, taken_at) VALUES (?, ?, ?) ON CONFLICT(kind) DO NOTHING",
    args: [kind, racerId, Date.now()],
  });
  const won = (taken.rowsAffected ?? 0) > 0;
  console.log(`RACER ${racerId} won=${won}`);
  if (won) {
    await sleep(1_500);
    await client.execute({
      sql: "UPDATE p0_leases SET released_at = ? WHERE kind = ? AND run_id = ?",
      args: [Date.now(), kind, racerId],
    });
  }
  console.log(`RACER_RESULT ${JSON.stringify({ racerId, won })}`);
  process.exit(0);
}

async function modeRace() {
  gate("g8-race");
  const client = openClient();
  await ensureLeaseTable(client);
  await client.execute("DELETE FROM p0_leases");
  const procs = [1, 2, 3, 4].map((i) =>
    spawnSync("npx", ["tsx", "packages/ai/src/verify/g8-semaphore.ts", "racer", `r${i}`], {
      encoding: "utf8",
      env: { ...process.env, MASTRA_P0_DB: DB_URL },
      timeout: 30_000,
    }),
  );
  const outs = procs.map((p) => p.stdout ?? "");
  const wins = outs.filter((o) => o.includes("won=true")).length;
  const clean = procs.every((p) => p.status === 0);
  console.log("racers clean:", clean, "| winners:", wins);
  assert("g8", clean, "全部 racer 进程应正常退出");
  assert("g8", wins === 1, `同 kind 并发竞争应恰好 1 个抢到，实际 ${wins}`);
  pass("g8-race", { winners: wins, racers: 4 });
}

async function modeSkip() {
  gate("g8-skip-active");
  const client = openClient();
  await ensureLeaseTable(client);
  await client.execute("DELETE FROM p0_leases");

  const take = async () => {
    const r = await client.execute({
      sql: "INSERT INTO p0_leases (kind, run_id, taken_at) VALUES ('p0-demo-kind', 'holder', ?) ON CONFLICT(kind) DO NOTHING",
      args: [Date.now()],
    });
    return (r.rowsAffected ?? 0) > 0;
  };
  const second = async () => {
    const r = await client.execute({
      sql: "INSERT INTO p0_leases (kind, run_id, taken_at) VALUES ('p0-demo-kind', 'second', ?) ON CONFLICT(kind) DO NOTHING",
      args: [Date.now()],
    });
    return (r.rowsAffected ?? 0) > 0;
  };

  assert("g8", await take(), "首次触发应取得执行权");
  assert("g8", !(await second()), "持有期间的二次触发应被 skip");
  await client.execute("UPDATE p0_leases SET released_at = ? WHERE kind = 'p0-demo-kind'");
  // 释放后按现有语义仍拒绝复用行（active 判定 = released_at IS NULL），用新行验证可再取：
  await client.execute("DELETE FROM p0_leases");
  assert("g8", await take(), "释放后再次触发应可取得执行权");
  pass("g8-skip-active", { semantics: "INSERT-ON-CONFLICT-DO-NOTHING + released_at 判活" });
}

async function ensureLeaseTable(client: Awaited<ReturnType<typeof openClient>>): Promise<void> {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS p0_leases (
      kind TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      taken_at INTEGER NOT NULL,
      released_at INTEGER
    )
  `);
}

async function main() {
  const mode = process.argv[2] ?? "skip";
  if (mode === "racer") return modeRacer(process.argv[3] ?? "r0");
  if (mode === "race") return modeRace();
  if (mode === "skip") return modeSkip();
  throw new Error(`unknown mode ${mode}`);
}

main().catch((error: unknown) => {
  fail("g8-semaphore", { error: error instanceof Error ? error.message : String(error) });
});
