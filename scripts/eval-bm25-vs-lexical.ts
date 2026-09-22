#!/usr/bin/env node
/**
 * 词汇打分通道 A/B 离线实验：BM25(in-code) 对照现有 scoreClusterMergeCandidatePair。
 *
 * 动机：评估「是否用标准 BM25 替换自定义词汇打分核心」（roadmap 讨论 2026-09-23）。
 * BM25 只需语料统计（in-window IDF），不需要 FTS5 索引即可离线对比。
 *
 * 方法：
 * - 语料：生产瘦身影子快照（content_clusters 全列），窗口 = max(latestPublishedAt) - 30 天，
 *   active/hidden，与 merge pass 加载的窗口聚类同源同量级。
 * - 切词：逐字复制生产 tokenizeMergeText（含 normalizeComparableText = trim+lowercase），
 *   唯一差别是不经 helpers 私有函数（helpers.ts 归属并行 run，不可改动）。
 * - 文档文本：镜像 buildMergeTextBlob = title + summary + eventSubject + eventObject。
 * - BM25：标准 k1=1.2/b=0.75，IDF = ln((N-df+0.5)/(df+0.5)+1)；pair 分 = 双向均值（另存单向 max）。
 * - 现有打分器：线上同源码 scoreClusterMergeCandidatePair。
 *
 * 指标（阈值无关为主）：
 * - AUC（Mann-Whitney：same 分数高于 diff 的概率）
 * - recall@FPR（diff 分布定阈值 1%/5%/10%，看 same 召回）
 * - same/diff 中位数；逐 pair 明细落 JSON
 *
 * 用法：npx tsx scripts/eval-bm25-vs-lexical.ts [--db <snapshot>] [--out <json>] [--window-days 30]
 */
import fs from "node:fs";

// 相对路径导入：规避 tsx 在 Node 26 下偶发的 tsconfig-paths 解析失败（同 eval-overmerge-gate）。
import { scoreClusterMergeCandidatePair } from "../src/lib/clusters/helpers";
import type { ClusterMergeCandidate } from "../src/lib/clusters/helpers";

// node:sqlite ships in Node 22+/25+; @types/node@20 has no declarations for it.
// @ts-expect-error node:sqlite has no type declarations in @types/node@20
import { DatabaseSync } from "node:sqlite";

type Args = { db: string; out: string; windowDays: number };

function parseArgs(argv: string[]): Args {
  const args: Args = {
    db: "docs/eval/snapshots/prod-snapshot-2026-09-21.db",
    out: "docs/eval/bm25-ab-result-2026-09-23.json",
    windowDays: 30,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--db") args.db = argv[i + 1] ?? args.db;
    else if (argv[i] === "--out") args.out = argv[i + 1] ?? args.out;
    else if (argv[i] === "--window-days") args.windowDays = Number(argv[i + 1] ?? 30);
  }
  return args;
}

/** RFC 4180 CSV 解析（引号字段 + "" 转义）。 */
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

function csvRows(path: string): Array<Record<string, string>> {
  const [header, ...rest] = parseCsv(fs.readFileSync(path, "utf8"));
  return rest.map((raw) => Object.fromEntries(header.map((h, i) => [h, raw[i] ?? ""])));
}

// ---- 生产同源切词（逐字复制自 src/lib/clusters/helpers.ts，勿单独改动）----

function normalizeComparableText(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function tokenizeMergeText(value: string | null | undefined): Set<string> {
  const normalized = normalizeComparableText(value);
  const words = normalized.match(/[a-z0-9]+|[\u4e00-\u9fff]+/g) ?? [];
  const tokens = new Set<string>();

  for (const word of words) {
    if (/^[\u4e00-\u9fff]+$/u.test(word)) {
      if (word.length <= 2) {
        tokens.add(word);
        continue;
      }

      for (let index = 0; index < word.length - 1; index += 1) {
        tokens.add(word.slice(index, index + 2));
      }
      continue;
    }

    if (word.length >= 2) {
      tokens.add(word);
    }
  }

  return tokens;
}

/** 镜像 buildMergeTextBlob：title + summary + eventSubject + eventObject。 */
function docText(side: { title: string; summary: string; subject: string; object: string }): string {
  return [side.title, side.summary, side.subject, side.object]
    .map((v) => v ?? "")
    .filter(Boolean)
    .join(" ");
}

// ---- BM25（in-code，无索引）----

const BM25_K1 = 1.2;
const BM25_B = 0.75;

type Bm25Index = {
  df: Map<string, number>;
  docCount: number;
  avgDocLen: number;
};

function buildBm25Index(docs: Array<Set<string>>): Bm25Index {
  const df = new Map<string, number>();
  let totalLen = 0;
  for (const tokens of docs) {
    totalLen += tokens.size;
    for (const token of tokens) {
      df.set(token, (df.get(token) ?? 0) + 1);
    }
  }
  return {
    df,
    docCount: docs.length,
    avgDocLen: docs.length > 0 ? totalLen / docs.length : 0,
  };
}

function bm25Idf(index: Bm25Index, token: string): number {
  const n = index.docCount;
  const df = index.df.get(token) ?? 0;
  return Math.log((n - df + 0.5) / (df + 0.5) + 1);
}

function bm25Score(index: Bm25Index, queryTokens: Set<string>, docTokens: Set<string>, docLen: number): number {
  if (docLen === 0 || index.avgDocLen === 0) return 0;
  let score = 0;
  for (const token of queryTokens) {
    if (!docTokens.has(token)) continue;
    const tf = 1; // docTokens 是 Set：词在文档内只计一次（与生产 Set 语义一致）
    const numerator = tf * (BM25_K1 + 1);
    const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / index.avgDocLen));
    score += bm25Idf(index, token) * (numerator / denominator);
  }
  return score;
}

// ---- 语料加载 ----

type Side = { title: string; summary: string; subject: string; object: string; action: string; eventType: string };

function toCandidate(side: Side, itemCount: number, eventDate: string, anchorMs: number): ClusterMergeCandidate {
  const publishedMs = Date.parse(eventDate);
  return {
    id: `eval-${Math.random().toString(36).slice(2, 10)}`,
    title: side.title ?? "",
    summary: side.summary ?? "",
    fingerprint: "eval-bm25-ab",
    eventType: side.eventType || null,
    eventSubject: side.subject || null,
    eventAction: side.action || null,
    eventObject: side.object || null,
    eventDate: eventDate || null,
    itemCount,
    // 缺失日期用窗口锚点兜底：生产里 latestPublishedAt 永远是近期时间，epoch 占位会误触发 date 守卫
    latestPublishedAt: Number.isFinite(publishedMs) ? new Date(publishedMs) : new Date(anchorMs),
  };
}

/** 守卫否决 = 该对永远不会因词汇分进入 AI 评审，排名语义上等价于 -∞。 */
const REJECTED_SENTINEL = -1e9;

function loadCorpus(dbPath: string, windowDays: number): { rows: Array<{ title: string; summary: string; eventSubject: string | null; eventObject: string | null }>; anchorMs: number } {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const anchorRow = db
    .prepare("SELECT MAX(latestPublishedAt) AS maxTs FROM content_clusters")
    .get() as { maxTs: number | null };
  const anchorMs = anchorRow.maxTs ?? Date.now();
  void anchorMs;
  const since = anchorMs - windowDays * 24 * 60 * 60 * 1000;
  const rows = db
    .prepare(
      `SELECT title, summary, eventSubject, eventObject FROM content_clusters
       WHERE status IN ('active','hidden') AND latestPublishedAt >= ?`,
    )
    .all(since) as Array<{ title: string; summary: string; eventSubject: string | null; eventObject: string | null }>;
  db.close();
  return { rows, anchorMs };
}

// ---- 标注集加载 ----

type LabeledPair = { key: string; dataset: string; label: "same" | "diff"; a: Side; b: Side; aCount: number; bCount: number; dateA?: string; dateB?: string };

function loadOvermerge(path: string): LabeledPair[] {
  return csvRows(path)
    .filter((r) => r.label === "same" || r.label === "diff")
    .filter((r) => (r.titleA ?? "").trim() && (r.titleB ?? "").trim())
    .map((r) => ({
      key: r.pairKey,
      dataset: "production-overmerge",
      label: r.label as "same" | "diff",
      a: { title: r.titleA ?? "", summary: r.summaryA ?? "", subject: r.subjectA ?? "", object: r.objectA ?? "", action: r.actionA ?? "", eventType: r.typeA ?? "" },
      b: { title: r.titleB ?? "", summary: r.summaryB ?? "", subject: r.subjectB ?? "", object: r.objectB ?? "", action: r.actionB ?? "", eventType: r.typeB ?? "" },
      aCount: Number(r.itemCountA ?? 1) || 1,
      bCount: Number(r.itemCountB ?? 1) || 1,
      dateA: r.dateA ?? "",
      dateB: r.dateB ?? "",
    }));
}

function loadBelowGray(path: string): LabeledPair[] {
  return csvRows(path)
    .filter((r) => r.aiLabel === "yes" || r.aiLabel === "no")
    .filter((r) => (r.titleA ?? "").trim() && (r.titleB ?? "").trim())
    .map((r) => ({
      key: r.pairKey,
      dataset: "below-gray-truth",
      label: r.aiLabel === "yes" ? "same" : "diff",
      a: { title: r.titleA ?? "", summary: r.summaryA ?? "", subject: r.subjA ?? "", object: r.objA ?? "", action: "", eventType: "" },
      b: { title: r.titleB ?? "", summary: r.summaryB ?? "", subject: r.subjB ?? "", object: r.objB ?? "", action: "", eventType: "" },
      aCount: 1,
      bCount: 1,
      dateA: r.dateA ?? "",
      dateB: r.dateB ?? "",
    }));
}

/**
 * eval-sample-30d：标签用 verdictStored 推导（approved 12 对因合并删侧在导出中缺一侧文本，被跳过——
 * 数据闭环 spec 的动机案例）；（approved→same / declined→diff，failed/ambiguous 剔除）。
 * 基线 §4.3 实测 stored verdict 与独立判断一致率约 99%（2 个 declined 边界错误），作为弱标签使用。
 */
function loadEvalSample(path: string): LabeledPair[] {
  return csvRows(path)
    .filter((r) => r.verdictStored === "approved" || r.verdictStored === "declined")
    .filter((r) => (r.titleA ?? "").trim() && (r.titleB ?? "").trim())
    .map((r) => ({
      key: r.pairKey,
      dataset: "eval-sample-30d",
      label: (r.verdictStored === "approved" ? "same" : "diff") as "same" | "diff",
      a: { title: r.titleA ?? "", summary: r.summaryA ?? "", subject: r.subjectA ?? "", object: r.objectA ?? "", action: r.actionA ?? "", eventType: r.typeA ?? "" },
      b: { title: r.titleB ?? "", summary: r.summaryB ?? "", subject: r.subjectB ?? "", object: r.objectB ?? "", action: r.actionB ?? "", eventType: r.typeB ?? "" },
      aCount: Number(r.itemCountA ?? 1) || 1,
      bCount: Number(r.itemCountB ?? 1) || 1,
      dateA: r.dateA ?? "",
      dateB: r.dateB ?? "",
    }));
}

// ---- 指标 ----

function auc(sameScores: number[], diffScores: number[]): number {
  if (sameScores.length === 0 || diffScores.length === 0) return Number.NaN;
  let wins = 0;
  let ties = 0;
  for (const s of sameScores) {
    for (const d of diffScores) {
      if (s > d) wins += 1;
      else if (s === d) ties += 1;
    }
  }
  return (wins + ties * 0.5) / (sameScores.length * diffScores.length);
}

function recallAtFpr(sameScores: number[], diffScores: number[], fpr: number): number {
  if (diffScores.length === 0 || sameScores.length === 0) return Number.NaN;
  const sortedDiff = [...diffScores].sort((a, b) => b - a);
  const cutoffIndex = Math.min(sortedDiff.length - 1, Math.floor(sortedDiff.length * fpr));
  const threshold = sortedDiff[cutoffIndex]!;
  const pass = sameScores.filter((s) => s >= threshold).length;
  return (pass / sameScores.length) * 100;
}

function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// ---- 主流程 ----

async function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const p of [args.db, "docs/eval/production-overmerge-2026-09-23.csv", "docs/eval/below-gray-truth-2026-09-19.csv", "docs/eval/eval-sample-30d.csv"]) {
    if (!fs.existsSync(p)) {
      console.error(`[bm25-ab] missing input: ${p}`);
      process.exit(2);
    }
  }

  const { rows: corpusRows, anchorMs } = loadCorpus(args.db, args.windowDays);
  const corpusDocs = corpusRows.map((row) =>
    tokenizeMergeText(docText({ title: row.title ?? "", summary: row.summary ?? "", subject: row.eventSubject ?? "", object: row.eventObject ?? "" })),
  );
  const index = buildBm25Index(corpusDocs);
  console.log(`[bm25-ab] corpus: ${index.docCount} clusters（窗口 ${args.windowDays} 天），avgDocLen=${index.avgDocLen.toFixed(1)} tokens`);

  const evalSample = loadEvalSample("docs/eval/eval-sample-30d.csv");
  const datasets: Array<{ name: string; pairs: LabeledPair[] }> = [
    { name: "below-gray-truth", pairs: loadBelowGray("docs/eval/below-gray-truth-2026-09-19.csv") },
    { name: "production-overmerge", pairs: loadOvermerge("docs/eval/production-overmerge-2026-09-23.csv") },
    { name: "eval-sample-30d", pairs: evalSample },
  ];
  console.log(`[bm25-ab] labeled pairs: below-gray ${datasets[0]!.pairs.length}，overmerge ${datasets[1]!.pairs.length}，eval-sample ${evalSample.length}`);

  const rows: Array<Record<string, unknown>> = [];
  const summary: Record<string, unknown> = {};

  for (const { name, pairs } of datasets) {
    const sameCurrent: number[] = [];
    const diffCurrent: number[] = [];
    const sameBm25: number[] = [];
    const diffBm25: number[] = [];
    const detail: Array<Record<string, unknown>> = [];
    const vetoByReason = new Map<string, number>();
    let sameVeto = 0;
    let diffVeto = 0;

    for (const pair of pairs) {
      const candA = toCandidate(pair.a, pair.aCount, pair.dateA ?? "", anchorMs);
      const candB = toCandidate(pair.b, pair.bCount, pair.dateB ?? "", anchorMs);
      const current = scoreClusterMergeCandidatePair(candA, candB);
      const currentScore = current.rejected ? REJECTED_SENTINEL : current.score;
      if (current.rejected) {
        const reason = current.rejectedReason ?? "rejected";
        const bucket = (vetoByReason.get(reason) ?? 0) + 1;
        vetoByReason.set(reason, bucket);
        if (pair.label === "same") sameVeto += 1;
        else diffVeto += 1;
      }

      const tokensA = tokenizeMergeText(docText(pair.a));
      const tokensB = tokenizeMergeText(docText(pair.b));
      // 语料内的 docLen 近似：用 pair 侧自身 token 数（BM25 长度归一）
      const aToB = bm25Score(index, tokensA, tokensB, tokensB.size);
      const bToA = bm25Score(index, tokensB, tokensA, tokensA.size);
      const bm25Mean = (aToB + bToA) / 2;
      const bm25Max = Math.max(aToB, bToA);

      (pair.label === "same" ? sameCurrent : diffCurrent).push(currentScore);
      (pair.label === "same" ? sameBm25 : diffBm25).push(bm25Mean);
      detail.push({
        key: pair.key,
        dataset: name,
        label: pair.label,
        currentScore: current.score,
        currentRejected: current.rejected ? current.rejectedReason ?? true : false,
        currentScoreEffective: currentScore,
        bm25Mean: Number(bm25Mean.toFixed(3)),
        bm25Max: Number(bm25Max.toFixed(3)),
      });
    }

    rows.push(...detail);
    summary[name] = {
      pairs: pairs.length,
      same: sameCurrent.length,
      diff: diffCurrent.length,
      current: {
        auc: Number(auc(sameCurrent, diffCurrent).toFixed(4)),
        medianSame: median(sameCurrent),
        medianDiff: median(diffCurrent),
        sameVeto,
        diffVeto,
        vetoByReason: Object.fromEntries(vetoByReason),
        recallAtFpr1: Number(recallAtFpr(sameCurrent, diffCurrent, 0.01).toFixed(1)),
        recallAtFpr5: Number(recallAtFpr(sameCurrent, diffCurrent, 0.05).toFixed(1)),
        recallAtFpr10: Number(recallAtFpr(sameCurrent, diffCurrent, 0.1).toFixed(1)),
      },
      bm25: {
        auc: Number(auc(sameBm25, diffBm25).toFixed(4)),
        medianSame: Number(median(sameBm25).toFixed(2)),
        medianDiff: Number(median(diffBm25).toFixed(2)),
        recallAtFpr1: Number(recallAtFpr(sameBm25, diffBm25, 0.01).toFixed(1)),
        recallAtFpr5: Number(recallAtFpr(sameBm25, diffBm25, 0.05).toFixed(1)),
        recallAtFpr10: Number(recallAtFpr(sameBm25, diffBm25, 0.1).toFixed(1)),
      },
    };
  }

  const result = {
    generatedAt: new Date().toISOString(),
    db: args.db,
    corpus: { docCount: index.docCount, windowDays: args.windowDays, avgDocLen: Number(index.avgDocLen.toFixed(1)) },
    bm25: { k1: BM25_K1, b: BM25_B, idf: "ln((N-df+0.5)/(df+0.5)+1)", pairScore: "mean of both directions" },
    note: "评分只比词汇通道本身：current=scoreClusterMergeCandidatePair（含守卫前的原始 score），BM25 无守卫。guard 语义（object_conflict 等）不在本实验替换范围。",
    summary,
    rows,
  };
  fs.writeFileSync(args.out, JSON.stringify(result, null, 2));

  type ScorerMetrics = {
    auc: number;
    medianSame: number;
    medianDiff: number;
    recallAtFpr1: number;
    recallAtFpr5: number;
    recallAtFpr10: number;
  };
  type DatasetSummary = { pairs: number; same: number; diff: number; current: ScorerMetrics; bm25: ScorerMetrics };
  for (const [name, s] of Object.entries(summary) as Array<[string, DatasetSummary]>) {
    console.log(`\n== ${name}（${s.pairs} 对，same ${s.same} / diff ${s.diff}）`);
    for (const scorer of ["current", "bm25"] as const) {
      const m = s[scorer];
      console.log(
        `  ${scorer.padEnd(7)} AUC=${m.auc}  median same/diff=${m.medianSame}/${m.medianDiff}  recall@FPR1/5/10=${m.recallAtFpr1}/${m.recallAtFpr5}/${m.recallAtFpr10}`,
      );
    }
  }
  console.log(`\n[bm25-ab] written: ${args.out}`);
}

main().catch((err) => {
  console.error("[bm25-ab] failed:", err?.message ?? err);
  process.exit(1);
});
