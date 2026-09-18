#!/usr/bin/env node
/**
 * 合并预筛灰区门评测（第二层向量预筛）。
 *
 * 在生产快照 + 标注集上对比两种灰区提名门：
 *   rule-only : 现行预筛（score >= CLUSTER_MERGE_AI_PAIR_GRAY_SCORE 且非 rejected）
 *   rule+vec  : 并集向量准入（sim >= CLUSTER_MERGE_VECTOR_GRAY_SIM、object_conflict 仍否决）
 *
 * 标注集：docs/eval/embedding-mined-pairs.csv（117 approved / 26 declined，AI 标注待抽检）
 * 及 --csv 传入的其他标注文件。另对照快照 cluster_decisions 估计「新鲜提名」
 * （排除已有 declined/ambiguous 决策、会被合并 pass 阻断的对）与增量评审量。
 *
 * Usage:
 *   INFINITUM_EMBED_URL=... INFINITUM_EMBED_MODEL=... INFINITUM_EMBED_KEY=... \
 *   npx tsx scripts/eval-merge-gray-gate.ts --db <snapshot> [--csv a.csv,b.csv] [--out result.json]
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- standalone eval tool: DB rows are untyped */
import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { scoreClusterMergeCandidatePair } from "@/lib/clusters/helpers";
import { resolveMergePairAdmission } from "@/lib/clusters/embedding-recall";

// @ts-expect-error node:sqlite has no type declarations in @types/node@20
import { DatabaseSync } from "node:sqlite";

type SqlRow = Record<string, any>;

const GRAY_SCORE = 55; // CLUSTER_MERGE_AI_PAIR_GRAY_SCORE
const VECTOR_GRAY_SIM = 0.72; // CLUSTER_MERGE_VECTOR_GRAY_SIM
const CONFLICT_OVERRIDE_SIM = 0.9; // CLUSTER_MERGE_VECTOR_CONFLICT_OVERRIDE_SIM

function parseArgs(argv: string[]) {
  const args: {
    db: string;
    minSim: number;
    conflictOverride: number;
    csv: string;
    embedUrl: string;
    embedModel: string;
    embedKeyEnv: string;
    cache: string;
    out: string;
  } = {
    db: process.env.INFINITUM_EVAL_DB ?? "",
    minSim: VECTOR_GRAY_SIM,
    conflictOverride: CONFLICT_OVERRIDE_SIM,
    csv: "docs/eval/eval-sample-30d.csv,docs/eval/embedding-mined-pairs.csv",
    embedUrl: process.env.INFINITUM_EMBED_URL ?? "",
    embedModel: process.env.INFINITUM_EMBED_MODEL ?? "",
    embedKeyEnv: "INFINITUM_EMBED_KEY",
    cache: path.join(os.tmpdir(), "infinitum-eval-embedding-cache.json"),
    out: "",
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--db") args.db = argv[++i] ?? "";
    else if (arg === "--min-sim") args.minSim = Number(argv[++i] ?? VECTOR_GRAY_SIM);
    else if (arg === "--conflict-override") args.conflictOverride = Number(argv[++i] ?? CONFLICT_OVERRIDE_SIM);
    else if (arg === "--csv") args.csv = argv[++i] ?? "";
    else if (arg === "--embed-url") args.embedUrl = argv[++i] ?? "";
    else if (arg === "--embed-model") args.embedModel = argv[++i] ?? "";
    else if (arg === "--embed-key-env") args.embedKeyEnv = argv[++i] ?? "";
    else if (arg === "--cache") args.cache = argv[++i] ?? "";
    else if (arg === "--out") args.out = argv[++i] ?? "";
  }
  if (!args.db) throw new Error("missing DB snapshot: pass --db <path> or set INFINITUM_EVAL_DB");
  if (!fs.existsSync(args.db)) throw new Error(`DB snapshot not found: ${args.db}`);
  if (!args.embedUrl || !args.embedModel) throw new Error("missing embedding endpoint (env/args)");
  return args;
}

type LabeledPair = {
  key: string;
  verdict: "approved" | "declined";
  titleA: string;
  summaryA: string;
  titleB: string;
  summaryB: string;
  subjectA: string | null;
  objectA: string | null;
  actionA: string | null;
  typeA: string | null;
  dateA: string | null;
  subjectB: string | null;
  objectB: string | null;
  actionB: string | null;
  typeB: string | null;
  dateB: string | null;
  idA: string;
  idB: string;
};

type EmbeddingCacheFile = { model: string; vectors: Record<string, number[]> };

function loadCache(file: string, model: string): EmbeddingCacheFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as EmbeddingCacheFile;
    if (parsed.model === model && parsed.vectors) return parsed;
  } catch {
    // missing/corrupt cache → fresh
  }
  return { model, vectors: {} };
}

function cosine(left: number[], right: number[]): number {
  let dot = 0;
  let ln = 0;
  let rn = 0;
  for (let i = 0; i < left.length; i += 1) {
    dot += left[i]! * right[i]!;
    ln += left[i]! * left[i]!;
    rn += right[i]! * right[i]!;
  }
  if (ln === 0 || rn === 0) return 0;
  return dot / (Math.sqrt(ln) * Math.sqrt(rn));
}

async function main() {
  const args = parseArgs(process.argv);
  const embedKey = process.env[args.embedKeyEnv] ?? "";
  if (!embedKey) throw new Error(`missing embedding API key: set ${args.embedKeyEnv}`);

  console.log(`[gray-gate] DB snapshot: ${args.db}`);
  const db = new DatabaseSync(args.db, { readOnly: true });

  // ---- 标注对 ----
  const pairs: LabeledPair[] = [];
  for (const csvPath of args.csv.split(",").map((p) => p.trim()).filter(Boolean)) {
    if (!fs.existsSync(csvPath)) continue;
    const lines = fs.readFileSync(csvPath, "utf8").trim().split("\n");
    const parseLine = (line: string): string[] => {
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
    };
    const header = parseLine(lines[0]!);
    const cell = (cells: string[], name: string) => {
      const i = header.indexOf(name);
      return i >= 0 ? cells[i] ?? "" : "";
    };
    for (const line of lines.slice(1)) {
      const cells = parseLine(line);
      const verdict = cell(cells, "verdictStored");
      if (verdict !== "approved" && verdict !== "declined") continue;
      const pairKey = cell(cells, "pairKey");
      pairs.push({
        key: pairKey,
        verdict,
        idA: pairKey.split("_")[0] ?? `a-${pairs.length}`,
        idB: pairKey.split("_")[1] ?? `b-${pairs.length}`,
        titleA: cell(cells, "titleA"),
        summaryA: cell(cells, "summaryA"),
        titleB: cell(cells, "titleB"),
        summaryB: cell(cells, "summaryB"),
        subjectA: cell(cells, "subjectA") || null,
        objectA: cell(cells, "objectA") || null,
        actionA: cell(cells, "actionA") || null,
        typeA: cell(cells, "typeA") || null,
        dateA: cell(cells, "dateA") || null,
        subjectB: cell(cells, "subjectB") || null,
        objectB: cell(cells, "objectB") || null,
        actionB: cell(cells, "actionB") || null,
        typeB: cell(cells, "typeB") || null,
        dateB: cell(cells, "dateB") || null,
      });
    }
  }
  console.log(`[gray-gate] labeled pairs: approved=${pairs.filter((p) => p.verdict === "approved").length}, declined=${pairs.filter((p) => p.verdict === "declined").length}`);

  // ---- 快照已有决策（近似合并 pass 的阻断：declined/ambiguous 决策存在即阻断）----
  const decidedPairKeys = new Set<string>();
  const decisionRows = db
    .prepare(
      `SELECT leftClusterId, rightClusterId, verdict FROM cluster_decisions
        WHERE kind = 'cluster_pair' AND verdict IN ('declined','ambiguous')`,
    )
    .all() as SqlRow[];
  for (const row of decisionRows) {
    const key = [row.leftClusterId as string, row.rightClusterId as string].sort().join("|");
    decidedPairKeys.add(key);
  }
  console.log(`[gray-gate] snapshot declined/ambiguous decided pairs: ${decidedPairKeys.size}`);

  // ---- 向量（磁盘缓存；mining/此前 eval 已写入全部所需文本）----
  const cache = loadCache(args.cache, args.embedModel);
  const hashOf = (text: string) => createHash("sha256").update(`${args.embedModel}\n${text}`).digest("hex");
  const embedText = (title: string, summary: string): number[] | null => {
    const text = `${title}\n${(summary ?? "").trim()}`;
    return cache.vectors[hashOf(text)] ?? null;
  };

  // ---- 逐对评测 ----
  const stats = {
    approved: { total: 0, ruleAdmitted: 0, fusedAdmitted: 0, vectorNewFresh: 0, vectorNewBlocked: 0 },
    declined: { total: 0, ruleAdmitted: 0, fusedAdmitted: 0, vectorNewFresh: 0, vectorNewBlocked: 0 },
  };

  for (const pair of pairs) {
    const rule = scoreClusterMergeCandidatePair(
      {
        id: pair.idA,
        title: pair.titleA,
        summary: pair.summaryA,
        fingerprint: "",
        eventType: pair.typeA,
        eventSubject: pair.subjectA,
        eventAction: pair.actionA,
        eventObject: pair.objectA,
        eventDate: pair.dateA,
        itemCount: 1,
        latestPublishedAt: new Date(0),
      },
      {
        id: pair.idB,
        title: pair.titleB,
        summary: pair.summaryB,
        fingerprint: "",
        eventType: pair.typeB,
        eventSubject: pair.subjectB,
        eventAction: pair.actionB,
        eventObject: pair.objectB,
        eventDate: pair.dateB,
        itemCount: 1,
        latestPublishedAt: new Date(0),
      },
    );

    const vecA = embedText(pair.titleA, pair.summaryA);
    const vecB = embedText(pair.titleB, pair.summaryB);
    const sim = vecA && vecB ? cosine(vecA, vecB) : null;

    const ruleOnly = resolveMergePairAdmission(rule, null, GRAY_SCORE, args.minSim, args.conflictOverride);
    const fused = resolveMergePairAdmission(rule, sim, GRAY_SCORE, args.minSim, args.conflictOverride);
    const bucket = stats[pair.verdict];
    bucket.total += 1;
    if (ruleOnly.admitted) bucket.ruleAdmitted += 1;
    if (fused.admitted) bucket.fusedAdmitted += 1;

    // 向量新增提名（规则不可见 → 融合可见）：区分新鲜/被既有决策阻断
    if (fused.admitted && !ruleOnly.admitted) {
      const decidedKey = [pair.idA, pair.idB].sort().join("|");
      if (decidedPairKeys.has(decidedKey)) bucket.vectorNewBlocked += 1;
      else bucket.vectorNewFresh += 1;
    }
  }

  const pct = (part: number, total: number) => (total === 0 ? 0 : (part / total) * 100);
  const report = {
    generatedAt: new Date().toISOString(),
    db: args.db,
    grayScore: GRAY_SCORE,
    vectorGraySim: args.minSim,
    conflictOverrideSim: args.conflictOverride,
    csv: args.csv,
    approved: {
      ...stats.approved,
      ruleAdmittedPct: pct(stats.approved.ruleAdmitted, stats.approved.total),
      fusedAdmittedPct: pct(stats.approved.fusedAdmitted, stats.approved.total),
    },
    declined: {
      ...stats.declined,
      ruleAdmittedPct: pct(stats.declined.ruleAdmitted, stats.declined.total),
      fusedAdmittedPct: pct(stats.declined.fusedAdmitted, stats.declined.total),
    },
    note: "admitted=进入灰区获得 AI 评审提名；vectorNewFresh=向量新增且无既有决策（真实增量评审量）；vectorNewBlocked=向量新增但已有 declined/ambiguous 决策（合并 pass 会阻断，不产生评审）。评估以标注对直接重放，未模拟输入哈希过期判定。",
  };

  console.log(`\n== approved（应被灰区接住）==`);
  console.log(`  rule-only 提名率: ${report.approved.ruleAdmittedPct.toFixed(1)}%  →  rule+vector: ${report.approved.fusedAdmittedPct.toFixed(1)}%`);
  console.log(`  向量新增提名: 新鲜 ${stats.approved.vectorNewFresh} 对 / 被既有决策阻断 ${stats.approved.vectorNewBlocked} 对`);
  console.log(`\n== declined（提名即评审成本）==`);
  console.log(`  rule-only 提名率: ${report.declined.ruleAdmittedPct.toFixed(1)}%  →  rule+vector: ${report.declined.fusedAdmittedPct.toFixed(1)}%`);
  console.log(`  向量新增提名: 新鲜 ${stats.declined.vectorNewFresh} 对 / 被既有决策阻断 ${stats.declined.vectorNewBlocked} 对`);

  if (args.out) {
    fs.writeFileSync(args.out, JSON.stringify(report, null, 2));
    console.log(`\n[gray-gate] results → ${args.out}`);
  }

  process.exit(0);
}

main().catch((error) => {
  console.error("[gray-gate] failed:", error);
  process.exit(1);
});
