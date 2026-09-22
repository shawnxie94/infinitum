#!/usr/bin/env node
/**
 * Overmerge 回归门——对生产误合并负例重放当前 LLM 合并决策链路。
 *
 * 背景：现有全部负例集（production-declined / embedding-mined / below-gray /
 * eval-sample 的 declined 行）都来自 declined 决策，即模型本来就会拒的对；
 * decision-layer FP（approved 但实为不同事件）此前零覆盖（2026-09-18 基线
 * approved 抽样仅 12 对）。本门用生产误合并聚类重建的 pair 级负例
 * （docs/eval/production-overmerge-2026-09-23.csv，diff/same 人工标注）守住
 * 决策层精度：任何 prompt / 阈值 / 模型变更后重跑，diff 对必须被 declined，
 * same 对（正向对照）必须保持 approved，防止「全部拒绝」的退化通过。
 *
 * 复用线上同源码：`buildClusterMergeInput` 组装与生产一致的输入 JSON，
 * `createAiProvider().assessClusterMergePairs` 走同一 prompt 契约与解析
 * （无 promptOverrides 时即生产默认提示词；cluster_merge 温度由
 * applySamplingContract 锁 0）。
 *
 * 用法：
 *   npx tsx scripts/eval-overmerge-gate.ts [--csv <path>] [--dry-run] [--out <json>]
 *   [--min-diff-declined <n>] [--min-same-approved <n>] [--batch-size <n>]
 *
 * 模型配置（env）：
 *   INFINITUM_EVAL_AI_URL / INFINITUM_EVAL_AI_KEY / INFINITUM_EVAL_AI_MODEL
 */
import fs from "node:fs";

// 相对路径导入：tsx 在 Node 26 下偶发丢失 tsconfig-paths 解析（CJS hook 路径），
// 门脚本要进 CI，避开 @/ 别名这条不稳定链路。
import { buildClusterMergeInput } from "../src/lib/clusters/helpers";
import type { ClusterMergeCandidate, ClusterMergeCandidateEdge } from "../src/lib/clusters/helpers";
import { createAiProvider } from "../src/lib/ai/provider-next";
import type { ClusterMergeDecisionVerdict } from "../src/lib/ai/provider-types";

type Args = {
  csv: string;
  dryRun: boolean;
  out: string;
  minDiffDeclined: number;
  minSameApproved: number;
  batchSize: number;
};

const DEFAULT_CSV = "docs/eval/production-overmerge-2026-09-23.csv";

function parseArgs(argv: string[]): Args {
  const args: Args = {
    csv: DEFAULT_CSV,
    dryRun: false,
    out: "",
    minDiffDeclined: 12,
    minSameApproved: 3,
    batchSize: 8,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--csv") args.csv = argv[i + 1] ?? args.csv;
    else if (flag === "--dry-run") args.dryRun = true;
    else if (flag === "--out") args.out = argv[i + 1] ?? "";
    else if (flag === "--min-diff-declined") args.minDiffDeclined = Number(argv[i + 1] ?? 12);
    else if (flag === "--min-same-approved") args.minSameApproved = Number(argv[i + 1] ?? 3);
    else if (flag === "--batch-size") args.batchSize = Math.max(1, Number(argv[i + 1] ?? 8));
  }
  return args;
}

/** RFC 4180：支持引号字段、"" 转义；fixture 已在生成时压平换行。 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.length > 0));
}

type OvermergePair = {
  pairKey: string;
  label: string;
  storedScore: number;
  clusterId: string;
  clusterTitle: string;
  left: ClusterMergeCandidate;
  right: ClusterMergeCandidate;
};

const SIG_FIELDS = ["subject", "action", "object", "type", "date"] as const;

function sideToCandidate(prefix: string, row: Record<string, string>): ClusterMergeCandidate {
  const title = row.title ?? "";
  return {
    id: prefix,
    title,
    summary: row.summary ?? "",
    fingerprint: `eval-overmerge-${prefix}`,
    eventType: row.type || null,
    eventSubject: row.subject || null,
    eventAction: row.action || null,
    eventObject: row.object || null,
    eventDate: row.date || null,
    itemCount: Number(row.itemCount ?? 1) || 1,
    latestPublishedAt: new Date(0),
  };
}

function loadPairs(csvPath: string): OvermergePair[] {
  const [header, ...rest] = parseCsv(fs.readFileSync(csvPath, "utf8"));
  const pairs: OvermergePair[] = [];
  for (const raw of rest) {
    const row = Object.fromEntries(header.map((h, i) => [h, raw[i] ?? ""]));
    const pairKey = row.pairKey ?? "";
    if (!pairKey) continue;
    const sideA = {
      ...row,
      title: row.titleA,
      summary: row.summaryA,
      itemCount: row.itemCountA,
      source: row.sourceA,
      ...Object.fromEntries(SIG_FIELDS.map((f) => [f, row[`${f}A`] ?? ""])),
    };
    const sideB = {
      ...row,
      title: row.titleB,
      summary: row.summaryB,
      itemCount: row.itemCountB,
      source: row.sourceB,
      ...Object.fromEntries(SIG_FIELDS.map((f) => [f, row[`${f}B`] ?? ""])),
    };
    pairs.push({
      pairKey,
      label: row.label ?? "uncertain",
      storedScore: Number(row.scoreForLabel ?? 0) || 0,
      clusterId: row.clusterId ?? "",
      clusterTitle: row.clusterTitle ?? "",
      left: sideToCandidate(`${pairKey}:A`, sideA),
      right: sideToCandidate(`${pairKey}:B`, sideB),
    });
  }
  return pairs;
}

function describeSide(candidate: ClusterMergeCandidate): string {
  const sig = [candidate.eventSubject, candidate.eventAction, candidate.eventObject]
    .filter(Boolean)
    .join("/");
  return `${candidate.title.slice(0, 40)}【${sig.slice(0, 50)}】×${candidate.itemCount}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.csv)) {
    console.error(`[overmerge-gate] fixture not found: ${args.csv}`);
    process.exit(2);
  }
  const pairs = loadPairs(args.csv);
  const diffPairs = pairs.filter((p) => p.label === "diff");
  const samePairs = pairs.filter((p) => p.label === "same");
  const uncertainPairs = pairs.filter((p) => p.label === "uncertain");
  console.log(
    `[overmerge-gate] fixture: ${pairs.length} pairs（diff ${diffPairs.length} / same ${samePairs.length} / uncertain ${uncertainPairs.length}），门槛 diff→declined ≥ ${args.minDiffDeclined}，same→approved ≥ ${args.minSameApproved}`,
  );

  if (args.dryRun) {
    for (const pair of pairs) {
      console.log(`  [${pair.label}] ${pair.pairKey}（stored ${pair.storedScore}）`);
      console.log(`    A: ${describeSide(pair.left)}`);
      console.log(`    B: ${describeSide(pair.right)}`);
    }
    console.log("[overmerge-gate] dry-run 结束（未调用模型）");
    return;
  }

  const apiKey = process.env.INFINITUM_EVAL_AI_KEY ?? "";
  const baseURL = process.env.INFINITUM_EVAL_AI_URL ?? "";
  const model = process.env.INFINITUM_EVAL_AI_MODEL ?? "";
  if (!apiKey || !baseURL || !model) {
    console.error("[overmerge-gate] 需要 INFINITUM_EVAL_AI_URL / INFINITUM_EVAL_AI_KEY / INFINITUM_EVAL_AI_MODEL");
    process.exit(2);
  }

  const provider = createAiProvider({ apiKey, baseURL, model });
  const verdictByKey = new Map<string, { verdict: ClusterMergeDecisionVerdict | null; error?: string }>();

  for (let offset = 0; offset < pairs.length; offset += args.batchSize) {
    const batch = pairs.slice(offset, offset + args.batchSize);
    const candidates = batch.flatMap((p) => [p.left, p.right]);
    const edges: ClusterMergeCandidateEdge[] = batch.map((p) => ({
      leftId: p.left.id,
      rightId: p.right.id,
      score: p.storedScore,
    }));
    const clustersJson = buildClusterMergeInput(candidates, edges);
    process.stdout.write(
      `[overmerge-gate] batch ${offset / args.batchSize + 1}/${Math.ceil(pairs.length / args.batchSize)}（${batch.length} 对）... `,
    );
    try {
      const decisions = await provider.assessClusterMergePairs(clustersJson);
      batch.forEach((pair, index) => {
        verdictByKey.set(pair.pairKey, { verdict: decisions[index]?.verdict ?? null });
      });
      console.log("ok");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      batch.forEach((pair) => verdictByKey.set(pair.pairKey, { verdict: null, error: message }));
      console.log(`failed: ${message.slice(0, 120)}`);
    }
  }

  let diffDeclined = 0;
  let sameApproved = 0;
  let callFailed = 0;
  const rows: Array<{ pairKey: string; label: string; storedScore: number; verdict: string; ok: boolean }> = [];
  for (const pair of pairs) {
    const outcome = verdictByKey.get(pair.pairKey);
    const verdict = outcome?.verdict ?? "call_failed";
    if (verdict === "call_failed") callFailed += 1;
    let ok: boolean;
    if (pair.label === "diff") ok = verdict === "declined";
    else if (pair.label === "same") ok = verdict === "approved";
    else ok = true; // uncertain 仅展示，不进门
    if (pair.label === "diff" && verdict === "declined") diffDeclined += 1;
    if (pair.label === "same" && verdict === "approved") sameApproved += 1;
    rows.push({ pairKey: pair.pairKey, label: pair.label, storedScore: pair.storedScore, verdict, ok });
    const mark = pair.label === "uncertain" ? " " : ok ? "✓" : "✗";
    console.log(`  ${mark} [${pair.label}] ${pair.pairKey} → ${verdict}`);
  }

  const result = {
    fixture: args.csv,
    totalPairs: pairs.length,
    diffDeclined,
    diffTotal: diffPairs.length,
    sameApproved,
    sameTotal: samePairs.length,
    callFailed,
    thresholds: { minDiffDeclined: args.minDiffDeclined, minSameApproved: args.minSameApproved },
    rows,
  };
  if (args.out) fs.writeFileSync(args.out, JSON.stringify(result, null, 2));

  console.log(
    `[overmerge-gate] diff→declined: ${diffDeclined}/${diffPairs.length}（需 ≥ ${args.minDiffDeclined}），same→approved: ${sameApproved}/${samePairs.length}（需 ≥ ${args.minSameApproved}），调用失败: ${callFailed}`,
  );
  if (callFailed > 0) {
    console.error("[overmerge-gate] FAIL — 存在模型调用失败，结果不完整，不能作为通过证据");
    process.exit(2);
  }
  if (diffDeclined >= args.minDiffDeclined && sameApproved >= args.minSameApproved) {
    console.log("[overmerge-gate] PASS — 决策层对生产误合并负例的拒合并能力达标");
    return;
  }
  console.error("[overmerge-gate] FAIL — 决策层假阳性回归（或正向对照被误拒），禁止放行相关变更");
  process.exit(1);
}

main().catch((err) => {
  console.error("[overmerge-gate] failed:", err?.message ?? err);
  process.exit(1);
});
