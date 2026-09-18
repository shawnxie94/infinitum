/**
 * 基线回归门（eval:baseline-gate）——基于「固定评测集」的聚合规则回归检查。
 *
 * 评测集 = docs/eval/eval-sample-30d.csv（240 对分层抽样，含 stored verdict 与
 * 双侧完整签名）。样本固定、跨版本可比，不依赖生产快照（快照会随数据增长
 * 漂移，导致全量指标不可直接跨发布比较）。
 *
 * 对评测集每一对用当前代码的 scoreClusterMergeCandidatePair 重算规则分，与存储
 * 判定（verdictStored）对比，得样本级指标；与 baseline-regression.json 的
 * sample_metrics 基准比较，变差即 exit 1（阻断发布）。
 *
 * 用法：
 *   node scripts/baseline-gate.ts [--samples <csv>] [--baseline <json>]
 * 依赖 tsx：npm script 内置，或 npx tsx scripts/baseline-gate.ts
 */
import fs from "node:fs";
import path from "node:path";


import { scoreClusterMergeCandidatePair, type ClusterMergeCandidate } from "@/lib/clusters/helpers";

type GateArgs = { samples: string; baseline: string; writeBaseline: boolean };
const argv = process.argv.slice(2);
const args: GateArgs = { samples: "", baseline: "", writeBaseline: false };
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--samples") args.samples = argv[i + 1] ?? "";
  else if (argv[i] === "--baseline") args.baseline = argv[i + 1] ?? "";
  else if (argv[i] === "--write-baseline") args.writeBaseline = true;
}
args.samples ||= path.resolve(process.cwd(), "docs/eval/eval-sample-30d.csv");
args.baseline ||= path.resolve(process.cwd(), "docs/eval/baseline-regression.json");
for (const [k, p] of [["samples", args.samples], ["baseline", args.baseline]] as const) {
  if (!fs.existsSync(p)) {
    console.error(`[baseline-gate] ${k} not found: ${p}`);
    process.exit(2);
  }
}

// ---- minimal CSV parse (eval CSV is quoted with embedded commas) ----
const csvText = fs.readFileSync(args.samples, "utf8").trim();
const lines = csvText.split("\n");
const header = parseCsvLine(lines[0]!);
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let inQ = false;
  for (const ch of line) {
    if (ch === '"') inQ = !inQ;
    else if (ch === "," && !inQ) { cells.push(cur); cur = ""; }
    else cur += ch;
  }
  cells.push(cur);
  return cells;
}
const cell = (cells: string[], name: string): string => {
  const i = header.indexOf(name);
  return i >= 0 ? cells[i] ?? "" : "";
};

function toCandidate(cells: string[], side: "A" | "B"): ClusterMergeCandidate {
  const pairKey = cell(cells, "pairKey");
  const id = pairKey.split("_")[side === "A" ? 0 : 1] || `side-${side}`;
  return {
    id,
    title: cell(cells, `title${side}`),
    summary: cell(cells, `summary${side}`),
    fingerprint: pairKey,
    eventFingerprint: null,
    eventType: (cell(cells, `type${side}`) || null) as ClusterMergeCandidate["eventType"],
    eventSubject: cell(cells, `subject${side}`) || null,
    eventAction: cell(cells, `action${side}`) || null,
    eventObject: cell(cells, `object${side}`) || null,
    eventDate: cell(cells, `date${side}`) || null,
    itemCount: Number(cell(cells, `itemCount${side}`)) || 0,
    latestPublishedAt: new Date(Number(cell(cells, "createdAt")) || Date.UTC(2026, 8, 18)),
  };
}

// ---- evaluate each pair with current rule scorer ----
type PairEval = { verdict: string; score: number; rejected: boolean };
const pairs = lines.slice(1).map(parseCsvLine).map<PairEval>((cells) => {
  const left = toCandidate(cells, "A");
  const right = toCandidate(cells, "B");
  const result = scoreClusterMergeCandidatePair(left, right);
  return { verdict: cell(cells, "verdictStored"), score: result.score, rejected: result.rejected };
});

const alive = pairs.filter((e) => e.verdict !== "failed");
const strong = alive.filter((e) => !e.rejected && e.score >= 95);
const strongDeclined = strong.filter((e) => e.verdict === "declined");
const approved = alive.filter((e) => e.verdict === "approved");
const approvedRecall = approved.filter((e) => e.score >= 55).length;

const metrics = {
  evaluatedPairs: pairs.length,
  alivePairs: alive.length,
  verdictApproved: approved.length,
  ruleStrong: {
    total: strong.length,
    declined: strongDeclined.length,
    declinedRatePct: strong.length
      ? Number(((strongDeclined.length / strong.length) * 100).toFixed(1))
      : 0,
  },
  approvedRecallPairs: approvedRecall,
};

const baselineDoc = JSON.parse(fs.readFileSync(args.baseline, "utf8")) as Record<string, unknown> & { sample_metrics?: Record<string, unknown> };
const base = baselineDoc.sample_metrics;

if (args.writeBaseline) {
  baselineDoc.sample_metrics = {
    ruleStrongDeclinedRatePct: metrics.ruleStrong.declinedRatePct,
    ruleStrongTotal: metrics.ruleStrong.total,
    approvedRecallPairs: metrics.approvedRecallPairs,
    evaluatedPairs: metrics.evaluatedPairs,
    alivePairs: metrics.alivePairs,
    verdictApproved: metrics.verdictApproved,
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(args.baseline, `${JSON.stringify(baselineDoc, null, 2)}\n`);
  console.log(`[baseline-gate] sample_metrics 已写入 ${args.baseline}`);
  console.log("[baseline-gate] PASS — 基准已更新");
  process.exit(0);
}
const baseNum = (k: string) => Number(base?.[k] ?? 0);
const gt = (name: string, got: number, want: number) => {
  const fmt = Number.isInteger(want) ? `${got} vs 基准 ${want}` : `${got}% vs 基准 ${want}%`;
  console.log(`  ${name}: ${fmt}`);
  return got > want;
};
if (!base) {
  console.error("[baseline-gate] baseline-regression.json 缺少 sample_metrics；请先用 --write-baseline 模式生成基准");
  process.exit(2);
}

const issues: string[] = [];
if (gt("ruleStrong.declinedRatePct", metrics.ruleStrong.declinedRatePct, baseNum("ruleStrongDeclinedRatePct") + 5)) {
  issues.push("  ✗ rule-strong 假阳率升高 >+5pp（规则打高分却多被判定不同事件）");
}
if (metrics.approvedRecallPairs < baseNum("approvedRecallPairs") * 0.5) {
  issues.push(`  ✗ approvedRecallPairs ${metrics.approvedRecallPairs} < 基准 ${baseNum("approvedRecallPairs")} ×0.5（召回退化）`);
}
if (metrics.ruleStrong.total > baseNum("ruleStrongTotal") + Math.max(5, baseNum("ruleStrongTotal") * 0.2)) {
  issues.push(`  ✗ ruleStrong.total ${metrics.ruleStrong.total} 远超基准 ${baseNum("ruleStrongTotal")}（+20%+5）`);
}

console.log("[baseline-gate] 固定评测集样本指标（当前代码）:");
console.log(`  评测对: ${metrics.evaluatedPairs}（有效 ${metrics.alivePairs}）`);
console.log(`  verdict approved: ${metrics.verdictApproved}`);
console.log(`  rule≥95: ${metrics.ruleStrong.total} 对，其中 declined ${metrics.ruleStrong.declined}（${metrics.ruleStrong.declinedRatePct}%）`);
console.log(`  approved 且规则≥55: ${metrics.approvedRecallPairs}`);
console.log("  对比基准 sample_metrics:");

if (issues.length === 0) {
  console.log("[baseline-gate] PASS — 固定评测集指标未劣于基准");
  process.exit(0);
}
console.error("[baseline-gate] FAIL:");
for (const l of issues) console.error(l);
process.exit(1);
