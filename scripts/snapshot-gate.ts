/**
 * 快照冻结维度回归门（方案A）——对同一冻结快照重放当前代码，逐 pair 对比判定。
 *
 * 无漂移原理：冻结快照（--freeze 基线 JSON）记录了该快照上每个 alive pair 的
 * recomputed rule score/rejected/verdict；本 gate 用【同一快照】（--snapshot db）
 * 重跑当前代码生成当前 pair 级基线，与冻结版逐 pair 对比：
 *   - score 跨 95 阈值（≥95 ↔ <95）
 *   - rejected 翻转（accept ↔ reject）
 * 任一判定变化即视为回归候选（列出变化数；默认只告警不阻断，--strict 时阻断）。
 *
 * 用法：
 *   npx tsx scripts/snapshot-gate.ts --snapshot <db> --freeze <frozen.json> [--strict]
 *   或经 npm run eval:snapshot-gate -- --snapshot <db> --freeze <frozen.json>
 *
 * 冻结（换基线时）：
 *   npx tsx scripts/eval-cluster-baseline.ts --db <snapshot> --days 30 --freeze docs/eval/baseline-snapshot-<date>.json
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

type Args = { snapshot: string; freeze: string; strict: boolean };
const argv = process.argv.slice(2);
const args: Args = { snapshot: "", freeze: "", strict: false };
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--snapshot") args.snapshot = argv[i + 1] ?? "";
  else if (argv[i] === "--freeze") args.freeze = argv[i + 1] ?? "";
  else if (argv[i] === "--strict") args.strict = true;
}
for (const [k, p] of [["snapshot", args.snapshot], ["freeze", args.freeze]] as const) {
  if (!fs.existsSync(p)) {
    console.error(`[snapshot-gate] ${k} not found: ${p}`);
    process.exit(2);
  }
}

// ---- replay current code on the same snapshot ----
const evalScript = path.resolve(process.cwd(), "scripts/eval-cluster-baseline.ts");
let currentText = "";
try {
  currentText = execFileSync(
    "npx", ["tsx", evalScript, "--db", args.snapshot, "--days", "30", "--freeze", "-"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
} catch (err) {
  const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? "";
  console.error(`[snapshot-gate] eval replay failed: ${stderr.slice(0, 500)}`);
  process.exit(2);
}
// stdout has logs + trailing freeze JSON; extract last balanced object
let current = null;
const lastBrace = currentText.lastIndexOf("}");
if (lastBrace >= 0) {
  let depth = 0;
  let start = -1;
  for (let i = lastBrace; i >= 0; i -= 1) {
    const ch = currentText[i];
    if (ch === "}") depth += 1;
    else if (ch === "{") {
      depth -= 1;
      if (depth === 0) { start = i; break; }
    }
  }
  if (start >= 0) {
    try { current = JSON.parse(currentText.slice(start, lastBrace + 1)); } catch { current = null; }
  }
}
if (!current) {
  console.error("[snapshot-gate] failed to parse current freeze from eval replay");
  process.exit(2);
}

const frozen = JSON.parse(fs.readFileSync(args.freeze, "utf8")) as {
  pairs: Array<{ key: string; score: number; rejected: boolean; verdict: string }>;
};
const frozenByKey = new Map(frozen.pairs.map((p) => [p.key, p]));

// ---- per-pair diff ----
let changed = 0;
let scoreCross = 0;
let rejectFlip = 0;
const examples: string[] = [];
for (const cur of (current as { pairs: Array<{ key: string; score: number; rejected: boolean; verdict: string }> }).pairs) {
  const old = frozenByKey.get(cur.key);
  if (!old) continue; // pair not in frozen set (snapshot identical → should not happen)
  const oldStrong = !old.rejected && old.score >= 95;
  const curStrong = !cur.rejected && cur.score >= 95;
  if (oldStrong !== curStrong) {
    scoreCross += 1;
    changed += 1;
    if (examples.length < 5) examples.push(`score ${old.score}->${cur.score} ${cur.key}`);
  }
  if (old.rejected !== cur.rejected) {
    rejectFlip += 1;
    changed += 1;
    if (examples.length < 5) examples.push(`reject ${old.rejected}->${cur.rejected} ${cur.key}`);
  }
}

console.log(`[snapshot-gate] 冻结快照重放对比: ${(current as { pairs: unknown[] }).pairs.length} 对`);
console.log(`  判定变化: ${changed}（score 跨95: ${scoreCross}, reject 翻转: ${rejectFlip}）`);
for (const ex of examples) console.log(`    e.g. ${ex}`);

const threshold = args.strict ? 0 : 10;
if (changed <= threshold) {
  console.log(`[snapshot-gate] PASS — 判定变化 ${changed} ≤ 阈值 ${threshold}`);
  process.exit(0);
}
console.error(`[snapshot-gate] FAIL — 判定变化 ${changed} > 阈值 ${threshold}（${args.strict ? "strict" : "默认 10"}，疑似规则回归）`);
process.exit(1);