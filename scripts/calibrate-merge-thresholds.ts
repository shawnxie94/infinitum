#!/usr/bin/env node
/**
 * B4 阈值校准：在既有真值集上网格搜索合并预筛阈值（灰区线 / 向量准入线 /
 * 冲突豁免线），评估（approved 提名召回, declined 误提名成本）曲线。
 *
 * 真值源：
 *   - docs/eval/below-gray-truth-2026-09-19.csv（aiLabel yes/no；labelNote b: 为 borderline）
 *   - docs/eval/embedding-mined-pairs.csv（verdictStored approved/declined；scoreForLabel=sim）
 *   - docs/eval/eval-sample-30d.csv（verdictStored；无 sim，仅参与规则通道分析）
 *
 * 口径边界：真值集按相似度分层抽样（mined=高相似，below-gray=sim≥0.6），召回率
 * 是「标注人群上的召回」，非全量生产推断。item 分配路径阈值（35/105/20）无标签
 * 数据，不在本脚本范围。
 *
 * Usage: npx tsx scripts/calibrate-merge-thresholds.ts [--out docs/eval/threshold-calibration.json]
 */
import fs from "node:fs";

import { scoreClusterMergeCandidatePair } from "@/lib/clusters/helpers";

type LabeledPair = {
  key: string;
  label: "approved" | "declined";
  ruleScore: number | null;
  rejectedReason: string | null;
  sim: number | null;
  borderline: boolean;
  source: string;
};

const CURRENT = { gray: 55, vSim: 0.72, override: 0.9 };

function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text.trim().split("\n");
  const splitLine = (line: string): string[] => {
    const cells: string[] = [];
    let cur = "";
    let inQ = false;
    for (const ch of line) {
      if (ch === '"') inQ = !inQ;
      else if (ch === "," && !inQ) {
        cells.push(cur);
        cur = "";
      } else cur += ch;
    }
    cells.push(cur);
    return cells;
  };
  const header = splitLine(lines[0]!);
  return lines.slice(1).map((line) => {
    const cells = splitLine(line);
    const row: Record<string, string> = {};
    header.forEach((name, i) => {
      row[name] = cells[i] ?? "";
    });
    return row;
  });
}

function replayRuleScore(row: Record<string, string>): { score: number; rejectedReason: string | null } {
  const mk = (side: "A" | "B") => ({
    id: `${row.pairKey}-${side}`,
    title: row[`title${side}`] ?? "",
    summary: row[`summary${side}`] ?? "",
    fingerprint: "",
    eventType: row[`type${side}`] || null,
    eventSubject: row[`subject${side}`] || null,
    eventAction: row[`action${side}`] || null,
    eventObject: row[`object${side}`] || null,
    eventDate: row[`date${side}`] || null,
    itemCount: Number(row[`itemCount${side}`]) || 1,
    latestPublishedAt: new Date(Number(row.createdAt) || Date.UTC(2026, 8, 18)),
  });
  const result = scoreClusterMergeCandidatePair(mk("A"), mk("B"));
  return { score: result.score, rejectedReason: result.rejectedReason };
}

function loadPairs(): LabeledPair[] {
  const pairs: LabeledPair[] = [];

  const belowGray = parseCsv(fs.readFileSync("docs/eval/below-gray-truth-2026-09-19.csv", "utf8"));
  for (const row of belowGray) {
    if (row.aiLabel !== "yes" && row.aiLabel !== "no") continue;
    pairs.push({
      key: row.pairKey,
      label: row.aiLabel === "yes" ? "approved" : "declined",
      ruleScore: Number(row.ruleScore),
      rejectedReason: row.rejectedReason || null,
      sim: Number(row.sim),
      borderline: row.labelNote.startsWith("b:"),
      source: "below-gray",
    });
  }

  const mined = parseCsv(fs.readFileSync("docs/eval/embedding-mined-pairs.csv", "utf8"));
  for (const row of mined) {
    if (row.verdictStored !== "approved" && row.verdictStored !== "declined") continue;
    const { score, rejectedReason } = replayRuleScore(row);
    pairs.push({
      key: row.pairKey,
      label: row.verdictStored,
      ruleScore: score,
      rejectedReason,
      sim: Number(row.scoreForLabel),
      borderline: false,
      source: "mined",
    });
  }

  const sample = parseCsv(fs.readFileSync("docs/eval/eval-sample-30d.csv", "utf8"));
  for (const row of sample) {
    if (row.verdictStored !== "approved" && row.verdictStored !== "declined") continue;
    const { score, rejectedReason } = replayRuleScore(row);
    pairs.push({
      key: row.pairKey,
      label: row.verdictStored,
      ruleScore: score,
      rejectedReason,
      sim: null,
      borderline: false,
      source: "sample",
    });
  }

  return pairs;
}

// resolveMergePairAdmission 的镜像（src/lib/clusters/embedding-recall.ts）
function admitted(pair: LabeledPair, gray: number, vSim: number, override: number | null): boolean {
  const rejected = pair.rejectedReason !== null && pair.rejectedReason !== "";
  if (!rejected && (pair.ruleScore ?? 0) >= gray) {
    return true;
  }
  const conflictVeto =
    pair.rejectedReason === "object_conflict" &&
    (pair.sim === null || (override !== null && pair.sim < override));
  if (pair.sim !== null && pair.sim >= vSim && !conflictVeto) {
    return true;
  }
  return false;
}

function evaluate(pairs: LabeledPair[], gray: number, vSim: number, override: number | null) {
  let approvedHit = 0;
  let declinedHit = 0;
  let vectorOnlyHit = 0;
  for (const pair of pairs) {
    if (!admitted(pair, gray, vSim, override)) continue;
    if (pair.label === "approved") {
      approvedHit += 1;
      const ruleOk = pair.rejectedReason === null && (pair.ruleScore ?? 0) >= gray;
      if (!ruleOk) vectorOnlyHit += 1;
    } else {
      declinedHit += 1;
    }
  }
  const approvedTotal = pairs.filter((p) => p.label === "approved").length;
  const declinedTotal = pairs.filter((p) => p.label === "declined").length;
  return {
    approvedRecall: approvedTotal === 0 ? 0 : (approvedHit / approvedTotal) * 100,
    declinedNominated: declinedHit,
    declinedNominatedPct: declinedTotal === 0 ? 0 : (declinedHit / declinedTotal) * 100,
    vectorOnlyRecall: approvedTotal === 0 ? 0 : (vectorOnlyHit / approvedTotal) * 100,
    approvedTotal,
    declinedTotal,
  };
}

function main() {
  const out = process.argv.includes("--out")
    ? process.argv[process.argv.indexOf("--out") + 1]!
    : "docs/eval/threshold-calibration.json";

  const all = loadPairs();
  const strict = all.filter((pair) => !pair.borderline);
  console.log(
    `[calibrate] pairs=${all.length} (borderline excluded: ${all.length - strict.length}) | ` +
      `approved=${all.filter((p) => p.label === "approved").length} declined=${all.filter((p) => p.label === "declined").length}`,
  );

  const grayGrid = [45, 50, 55, 60, 65];
  const vSimGrid = [0.66, 0.72, 0.78, 0.85];
  const overrideGrid: Array<number | null> = [0.85, 0.9, 0.95, null];

  const results: Array<Record<string, unknown>> = [];
  for (const gray of grayGrid) {
    for (const vSim of vSimGrid) {
      for (const override of overrideGrid) {
        const allMetrics = evaluate(all, gray, vSim, override);
        const strictMetrics = evaluate(strict, gray, vSim, override);
        results.push({
          gray,
          vSim,
          override: override ?? "none",
          ...allMetrics,
          strictApprovedRecall: strictMetrics.approvedRecall,
          strictDeclinedNominatedPct: strictMetrics.declinedNominatedPct,
        });
      }
    }
  }

  results.sort(
    (left, right) =>
      (right.strictApprovedRecall as number) - (left.strictApprovedRecall as number) ||
      (left.declinedNominated as number) - (right.declinedNominated as number),
  );

  const current = results.find(
    (r) => r.gray === CURRENT.gray && r.vSim === CURRENT.vSim && r.override === CURRENT.override,
  );
  console.log(
    `[calibrate] 当前配置 gray=${CURRENT.gray} vSim=${CURRENT.vSim} override=${CURRENT.override}: ` +
      `strictRecall=${(current?.strictApprovedRecall as number | undefined)?.toFixed(1)}% declinedNominated=${current?.declinedNominated}`,
  );
  console.log("\nTop 8（strict 集召回降序，并列时误提名升序）：");
  for (const r of results.slice(0, 8)) {
    console.log(
      `  gray=${r.gray} vSim=${r.vSim} override=${r.override} | ` +
        `strictRecall=${(r.strictApprovedRecall as number).toFixed(1)}% declinedNominated=${r.declinedNominated} ` +
        `vectorOnlyRecall=${(r.vectorOnlyRecall as number).toFixed(1)}%`,
    );
  }

  fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), current: CURRENT, results }, null, 2));
  console.log(`\n[calibrate] ${results.length} combos → ${out}`);
}

main();
