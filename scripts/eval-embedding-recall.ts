#!/usr/bin/env node
/**
 * Embedding + RRF 融合召回评估（Phase 1）。
 *
 * 在生产快照（只读）上对比两种候选切片策略：
 *   rule  : 现行规则排序 + score>=CLUSTER_AI_MIN_SCORE 准入（生产现状）
 *   fused : 规则排序与向量相似度排序做 RRF 融合（本次改造）
 *
 * 分层（银标，非人工全量真值）：
 *   gray-positives : cluster_merge_clean_pair_candidates（双侧存活，规则分>=灰区）
 *   declined-negs  : cluster_decisions verdict=declined 且双侧存活（不应被召回）
 *   csv-approved / csv-declined : --csv 标注集（eval-sample-30d + 向量挖掘标注集）
 *   feedback-approved / feedback-declined : cluster_pair_labels（Phase 3 人工反馈，
 *     来自管理台复核/拆分/移动动作的回写；旧快照无此表则自动跳过）
 *
 * 每个分层输出 rule分带(B侧) 分布（≥95/55-95/35-55/<35/rejected）——人工判定
 * 落在规则分轴的哪个位置，即阈值校准视图。
 *
 * 口径说明：approved 决策对的被合并侧 cluster 已删除、无法取文本，因此正例主要来自
 * 灰区候选表；「规则完全漏掉但语义同事件」的增量召回无法用生产数据度量，
 * 需等 Phase 3 人工反馈闭环积累真值。
 *
 * Usage:
 *   npx tsx scripts/eval-embedding-recall.ts --db <snapshot> [--days 30] \
 *     [--embed-url http://sarvismac-mini:3000/v1 --embed-model BAAI/bge-m3 --embed-key-env NAME] \
 *     [--pool-size 50] [--max-per-stratum 200] [--out result.json]
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- standalone eval tool: DB rows are untyped */
import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { scoreClusterMergeCandidatePair } from "@/lib/clusters/helpers";
import { fuseOrdersByRrf } from "@/lib/clusters/embedding-recall";

// node:sqlite ships in Node 22+/25+; @types/node@20 has no declarations for it.
// @ts-expect-error node:sqlite has no type declarations in @types/node@20
import { DatabaseSync } from "node:sqlite";

type SqlRow = Record<string, any>;

const DAY_MS = 24 * 60 * 60 * 1000;
const RULE_MIN_SCORE = 35; // CLUSTER_AI_MIN_SCORE：生产切片的规则准入线

function parseArgs(argv: string[]) {
  const args: {
    db: string;
    days: number;
    poolSize: number;
    maxPerStratum: number;
    embedUrl: string;
    embedModel: string;
    embedKeyEnv: string;
    cache: string;
    out: string;
    csv: string;
  } = {
    db: process.env.INFINITUM_EVAL_DB ?? "",
    days: 30,
    poolSize: 50,
    maxPerStratum: 200,
    embedUrl: process.env.INFINITUM_EMBED_URL ?? "",
    embedModel: process.env.INFINITUM_EMBED_MODEL ?? "",
    embedKeyEnv: "INFINITUM_EMBED_KEY",
    cache: path.join(os.tmpdir(), "infinitum-eval-embedding-cache.json"),
    out: "",
    csv: "docs/eval/eval-sample-30d.csv",
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--db") args.db = argv[++i] ?? "";
    else if (arg === "--days") args.days = Number(argv[++i] ?? 30);
    else if (arg === "--pool-size") args.poolSize = Number(argv[++i] ?? 50);
    else if (arg === "--max-per-stratum") args.maxPerStratum = Number(argv[++i] ?? 200);
    else if (arg === "--embed-url") args.embedUrl = argv[++i] ?? "";
    else if (arg === "--embed-model") args.embedModel = argv[++i] ?? "";
    else if (arg === "--embed-key-env") args.embedKeyEnv = argv[++i] ?? "";
    else if (arg === "--cache") args.cache = argv[++i] ?? "";
    else if (arg === "--out") args.out = argv[++i] ?? "";
    else if (arg === "--csv") args.csv = argv[++i] ?? "";
  }
  if (!args.db) throw new Error("missing DB snapshot: pass --db <path> or set INFINITUM_EVAL_DB");
  if (!fs.existsSync(args.db)) throw new Error(`DB snapshot not found: ${args.db}`);
  if (!args.embedUrl || !args.embedModel) {
    throw new Error("missing embedding endpoint: pass --embed-url/--embed-model (or env)");
  }
  return args;
}

type MergeCandidate = {
  id: string;
  title: string;
  summary: string;
  fingerprint: string;
  eventType: string | null;
  eventSubject: string | null;
  eventAction: string | null;
  eventObject: string | null;
  eventDate: string | null;
  itemCount: number;
  latestPublishedAt: Date;
};

function toMergeCandidate(row: SqlRow): MergeCandidate {
  return {
    id: row.id,
    title: row.title ?? "",
    summary: row.summary ?? "",
    fingerprint: row.fingerprint ?? "",
    eventType: row.eventType ?? null,
    eventSubject: row.eventSubject ?? null,
    eventAction: row.eventAction ?? null,
    eventObject: row.eventObject ?? null,
    eventDate: row.eventDate ?? null,
    itemCount: row.itemCount ?? 0,
    latestPublishedAt: new Date(Number(row.latestPublishedAt)),
  };
}

function buildEmbeddingText(title: string, summary: string): string {
  return `${title}\n${(summary ?? "").trim()}`;
}

function cosineSimilarity(left: number[], right: number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i += 1) {
    dot += left[i]! * right[i]!;
    leftNorm += left[i]! * left[i]!;
    rightNorm += right[i]! * right[i]!;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

// ---- deterministic per-pair distractor sampling ----
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mulberry32(seed: number) {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- embedding client with disk cache ----
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

async function embedTexts(
  config: { url: string; model: string; key: string; dimensions?: number | null },
  texts: string[],
  cache: EmbeddingCacheFile,
): Promise<number[][]> {
  const hashOf = (text: string) => createHash("sha256").update(`${config.model}\n${text}`).digest("hex");
  const vectors: Array<number[] | null> = texts.map((text) => cache.vectors[hashOf(text)] ?? null);
  const misses = vectors.map((v, i) => ({ v, i })).filter((entry) => entry.v === null).map((entry) => entry.i);

  const batchSize = 32;
  for (let start = 0; start < misses.length; start += batchSize) {
    const slice = misses.slice(start, start + batchSize);
    const payload: Record<string, unknown> = {
      model: config.model,
      input: slice.map((i) => texts[i]),
    };
    if (config.dimensions) payload.dimensions = config.dimensions;

    let data: Array<{ embedding?: number[]; index?: number }> = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await fetch(`${config.url.replace(/\/$/, "")}/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.key}` },
        body: JSON.stringify(payload),
      });
      if (response.ok) {
        const body = (await response.json()) as { data?: Array<{ embedding?: number[]; index?: number }> };
        data = body.data ?? [];
        break;
      }
      const detail = (await response.text()).slice(0, 200);
      if (attempt === 3) {
        throw new Error(`embedding API ${response.status} after 3 attempts: ${detail}`);
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }

    if (data.length !== slice.length) {
      throw new Error(`embedding API returned ${data.length} vectors for ${slice.length} texts`);
    }
    data.forEach((row, position) => {
      const target = typeof row.index === "number" ? row.index : position;
      if (row.embedding) vectors[slice[target]!] = row.embedding;
    });
  }

  texts.forEach((text, i) => {
    if (vectors[i]) cache.vectors[hashOf(text)] = vectors[i]!;
  });

  return vectors as number[][];
}

// ---- metrics ----
type RuleScoreBands = {
  strong: number; // ≥95 且未被拒
  gray: number; // 55-95
  low: number; // 35-55
  below: number; // <35
  rejected: number; // 规则拒绝（任意 rejectedReason）
};

type StratumMetrics = {
  pairs: number;
  ruleRecallAt5: number;
  ruleRecallAt10: number;
  ruleRecallAt15: number;
  fusedRecallAt5: number;
  fusedRecallAt10: number;
  fusedRecallAt15: number;
  ruleRankBMedian: number | null;
  fusedRankBMedian: number | null;
  negativePromoted: number;
  negativePromoted15: number;
  sliceChurn: number;
  ruleScoreBands: RuleScoreBands | null;
};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function pct(part: number, total: number): number {
  return total === 0 ? 0 : (part / total) * 100;
}

async function main() {
  const args = parseArgs(process.argv);
  const embedKey = process.env[args.embedKeyEnv] ?? "";
  if (!embedKey) throw new Error(`missing embedding API key: set ${args.embedKeyEnv}`);

  console.log(`[eval] DB snapshot: ${args.db}, window=${args.days}d, pool=${args.poolSize}`);
  const db = new DatabaseSync(args.db, { readOnly: true });

  const newestRow = db
    .prepare(`SELECT MAX(createdAt) m FROM cluster_decisions WHERE kind = 'cluster_pair' AND createdAt IS NOT NULL`)
    .get();
  const now = Number(newestRow?.m ?? Date.now());
  const since = now - args.days * DAY_MS;
  console.log(`[eval] window anchor=${new Date(now).toISOString()}`);

  // 生产候选池同口径：窗口内 active 聚类
  const distractorRows = db
    .prepare(
      `SELECT id, title, summary, fingerprint, eventType, eventSubject, eventAction,
              eventObject, eventDate, itemCount, latestPublishedAt
         FROM content_clusters
        WHERE latestPublishedAt >= ? AND status = 'active'`,
    )
    .all(since) as SqlRow[];
  const distractors = distractorRows.map(toMergeCandidate);
  console.log(`[eval] distractor pool (active clusters): ${distractors.length}`);

  const clusterStmt = db.prepare(
    `SELECT id, title, summary, fingerprint, eventType, eventSubject, eventAction,
            eventObject, eventDate, itemCount, latestPublishedAt
       FROM content_clusters WHERE id = ?`,
  );

  type PairSpec = { key: string; a: MergeCandidate; b: MergeCandidate };
  const positives: PairSpec[] = [];
  const negatives: PairSpec[] = [];

  // 灰区候选 = 银标正例（双侧存活）
  const grayRows = db
    .prepare(
      `SELECT c.pairKey, c.leftClusterId, c.rightClusterId, c.score, c.createdAt
         FROM cluster_merge_clean_pair_candidates c
        WHERE c.createdAt >= ?
        ORDER BY c.score DESC, c.pairKey ASC
        LIMIT ?`,
    )
    .all(since, args.maxPerStratum) as SqlRow[];
  for (const row of grayRows) {
    const a = clusterStmt.get(row.leftClusterId) as SqlRow | undefined;
    const b = clusterStmt.get(row.rightClusterId) as SqlRow | undefined;
    if (!a || !b) continue;
    positives.push({ key: `gray:${row.pairKey}`, a: toMergeCandidate(a), b: toMergeCandidate(b) });
  }

  // declined 且双侧存活 = 银标负例
  const declinedRows = db
    .prepare(
      `SELECT d.pairKeyOrOrder, d.leftClusterId, d.rightClusterId FROM (
           SELECT (d.leftClusterId || ':' || d.rightClusterId) AS pairKeyOrOrder,
                  d.leftClusterId, d.rightClusterId, d.createdAt
             FROM cluster_decisions d
             JOIN content_clusters a ON a.id = d.leftClusterId
             JOIN content_clusters b ON b.id = d.rightClusterId
            WHERE d.kind = 'cluster_pair' AND d.verdict = 'declined' AND d.createdAt >= ?
            ORDER BY d.createdAt DESC
       ) d LIMIT ?`,
    )
    .all(since, args.maxPerStratum) as SqlRow[];
  for (const row of declinedRows) {
    const a = clusterStmt.get(row.leftClusterId) as SqlRow | undefined;
    const b = clusterStmt.get(row.rightClusterId) as SqlRow | undefined;
    if (!a || !b) continue;
    negatives.push({ key: `declined:${row.pairKeyOrOrder}`, a: toMergeCandidate(a), b: toMergeCandidate(b) });
  }

  // 人工/挖掘标注样本（可选）：--csv 支持逗号分隔多个文件，读 approved + declined
  const humanPositives: PairSpec[] = [];
  const humanNegatives: PairSpec[] = [];
  const csvPaths = args.csv ? args.csv.split(",").map((p) => p.trim()).filter(Boolean) : [];
  for (const csvPath of csvPaths) {
    if (!fs.existsSync(csvPath)) continue;
    const csvText = fs.readFileSync(csvPath, "utf8").trim();
    const lines = csvText.split("\n");
    const parseCsvLine = (line: string): string[] => {
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
    const header = parseCsvLine(lines[0]!);
    const cell = (cells: string[], name: string) => {
      const i = header.indexOf(name);
      return i >= 0 ? cells[i] ?? "" : "";
    };
    for (const line of lines.slice(1)) {
      const cells = parseCsvLine(line);
      const verdict = cell(cells, "verdictStored");
      if (verdict !== "approved" && verdict !== "declined") continue;
      const mk = (side: "A" | "B"): MergeCandidate => ({
        id: cell(cells, "pairKey").split("_")[side === "A" ? 0 : 1] || `side-${side}`,
        title: cell(cells, `title${side}`),
        summary: cell(cells, `summary${side}`),
        fingerprint: "",
        eventType: cell(cells, `type${side}`) || null,
        eventSubject: cell(cells, `subject${side}`) || null,
        eventAction: cell(cells, `action${side}`) || null,
        eventObject: cell(cells, `object${side}`) || null,
        eventDate: cell(cells, `date${side}`) || null,
        itemCount: Number(cell(cells, `itemCount${side}`)) || 1,
        latestPublishedAt: new Date(Number(cell(cells, "createdAt")) || now),
      });
      const spec = { key: `csv:${cell(cells, "pairKey")}`, a: mk("A"), b: mk("B") };
      if (verdict === "approved") humanPositives.push(spec);
      else humanNegatives.push(spec);
    }
  }
  // Phase 3 人工反馈标签（cluster_pair_labels，可选：旧快照无此表则跳过）。
  // 同一对多次标注时保留最新判定。
  const feedbackPositives: PairSpec[] = [];
  const feedbackNegatives: PairSpec[] = [];
  try {
    const labelRows = db
      .prepare(
        `SELECT verdict, leftId, rightId, titleA, titleB, summaryA, summaryB,
                subjectA, subjectB, objectA, objectB, actionA, actionB, typeA, typeB,
                dateA, dateB, itemCountA, itemCountB, createdAt
           FROM cluster_pair_labels
          WHERE createdAt >= ?
          ORDER BY createdAt DESC
          LIMIT ?`,
      )
      .all(since, args.maxPerStratum * 2) as SqlRow[];
    const seen = new Set<string>();
    for (const row of labelRows) {
      const dedupeKey = `${row.leftId}:${row.rightId}`;
      if (seen.has(dedupeKey)) continue;
      if (row.verdict !== "approved" && row.verdict !== "declined") continue;
      seen.add(dedupeKey);
      const mkSide = (side: "A" | "B"): MergeCandidate => ({
        id: side === "A" ? row.leftId : row.rightId,
        title: row[`title${side}`] ?? "",
        summary: row[`summary${side}`] ?? "",
        fingerprint: "",
        eventType: row[`type${side}`] ?? null,
        eventSubject: row[`subject${side}`] ?? null,
        eventAction: row[`action${side}`] ?? null,
        eventObject: row[`object${side}`] ?? null,
        eventDate: row[`date${side}`] ?? null,
        itemCount: Number(row[`itemCount${side}`]) || 1,
        latestPublishedAt: new Date(Number(row.createdAt) || now),
      });
      const spec = { key: `feedback:${dedupeKey}`, a: mkSide("A"), b: mkSide("B") };
      if (row.verdict === "approved") feedbackPositives.push(spec);
      else feedbackNegatives.push(spec);
    }
  } catch {
    console.log("[eval] cluster_pair_labels 表不存在（旧快照），跳过 human-feedback 分层");
  }
  console.log(
    `[eval] strata: gray-positives=${positives.length}, declined-negatives=${negatives.length}, csv-approved=${humanPositives.length}, csv-declined=${humanNegatives.length}, feedback-approved=${feedbackPositives.length}, feedback-declined=${feedbackNegatives.length}`,
  );

  const cache = loadCache(args.cache, args.embedModel);
  let apiCalls = 0;
  const embed = async (texts: string[]) => {
    const before = Object.keys(cache.vectors).length;
    const vectors = await embedTexts(
      { url: args.embedUrl, model: args.embedModel, key: embedKey },
      texts,
      cache,
    );
    apiCalls += 1;
    if (Object.keys(cache.vectors).length !== before) {
      fs.writeFileSync(args.cache, JSON.stringify(cache));
    }
    // 温和限速：上游渠道可能有 RPM 限制
    await new Promise((resolve) => setTimeout(resolve, 150));
    return vectors;
  };

  const evaluateStratum = async (
    name: string,
    pairs: PairSpec[],
  ): Promise<StratumMetrics> => {
    const metrics: StratumMetrics = {
      pairs: 0,
      ruleRecallAt5: 0,
      ruleRecallAt10: 0,
      fusedRecallAt5: 0,
      fusedRecallAt10: 0,
      ruleRecallAt15: 0,
      fusedRecallAt15: 0,
      ruleRankBMedian: null,
      fusedRankBMedian: null,
      negativePromoted: 0,
      negativePromoted15: 0,
      sliceChurn: 0,
      ruleScoreBands: null,
    };
    const ruleRanks: number[] = [];
    const fusedRanks: number[] = [];
    const bands = { strong: 0, gray: 0, low: 0, below: 0, rejected: 0 };

    for (const pair of pairs) {
      const rng = mulberry32(fnv1a(pair.key));
      const pool: MergeCandidate[] = [pair.b];
      const excluded = new Set([pair.a.id, pair.b.id]);
      // 确定性洗牌后单次遍历取 distractor；候选去重后不足 poolSize 时自然终止
      const shuffled = [...distractors];
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      for (const candidate of shuffled) {
        if (pool.length >= args.poolSize) break;
        if (excluded.has(candidate.id)) continue;
        excluded.add(candidate.id);
        pool.push(candidate);
      }
      if (pool.length < 2) continue;

      const ruleScored = pool
        .map((candidate) => ({ candidate, result: scoreClusterMergeCandidatePair(pair.a, candidate) }))
        .map((entry) => {
          // object_conflict = 实体冲突，双向否决；no_event_anchor = 词汇锚点不足，
          // 恰是语义召回应处理的 case，不作为向量路径否决（与生产集成口径一致）
          const conflictVeto = entry.result.rejectedReason === "object_conflict";
          return {
            ...entry,
            conflictVeto,
            eligible: !conflictVeto && entry.result.score >= RULE_MIN_SCORE,
          };
        });

      // 校准视图：B 侧的规则分落在哪个带（人判同/异事件 vs 规则打分的分布）
      const bEntry = ruleScored.find((entry) => entry.candidate.id === pair.b.id);
      if (bEntry) {
        if (bEntry.result.rejected) bands.rejected += 1;
        else if (bEntry.result.score >= 95) bands.strong += 1;
        else if (bEntry.result.score >= 55) bands.gray += 1;
        else if (bEntry.result.score >= RULE_MIN_SCORE) bands.low += 1;
        else bands.below += 1;
      }

      // rule 切片口径：仅 eligible 参与，按分排序（生产现状）
      const ruleOrder = ruleScored
        .filter((entry) => entry.eligible)
        .sort((left, right) => right.result.score - left.result.score || left.candidate.id.localeCompare(right.candidate.id))
        .map((entry) => entry.candidate.id);

      // 向量排序口径：仅实体冲突否决，不受规则最低分/no_event_anchor 限制
      const texts = [
        buildEmbeddingText(pair.a.title, pair.a.summary),
        ...ruleScored
          .filter((entry) => !entry.conflictVeto)
          .map((entry) => buildEmbeddingText(entry.candidate.title, entry.candidate.summary)),
      ];
      const vectors = await embed(texts);
      const itemVector = vectors[0]!;
      const vecEligible = ruleScored.filter((entry) => !entry.conflictVeto);
      const vecOrder = vecEligible
        .map((entry, index) => ({
          id: entry.candidate.id,
          sim: cosineSimilarity(itemVector, vectors[index + 1]!),
          publishedAt: entry.candidate.latestPublishedAt.getTime(),
        }))
        .sort(
          (left, right) =>
            right.sim - left.sim || right.publishedAt - left.publishedAt || left.id.localeCompare(right.id),
        )
        .map((entry) => entry.id);

      const fusedOrder = fuseOrdersByRrf(ruleOrder, vecOrder, 60);
      const ruleRankOfB = ruleOrder.indexOf(pair.b.id);
      const fusedRankOfB = fusedOrder.indexOf(pair.b.id);

      metrics.pairs += 1;
      if (ruleRankOfB >= 0) {
        ruleRanks.push(ruleRankOfB + 1);
        if (ruleRankOfB < 5) metrics.ruleRecallAt5 += 1;
        if (ruleRankOfB < 10) metrics.ruleRecallAt10 += 1;
        if (ruleRankOfB < 15) metrics.ruleRecallAt15 += 1;
      }
      if (fusedRankOfB >= 0) {
        fusedRanks.push(fusedRankOfB + 1);
        if (fusedRankOfB < 5) metrics.fusedRecallAt5 += 1;
        if (fusedRankOfB < 10) metrics.fusedRecallAt10 += 1;
        if (fusedRankOfB < 15) metrics.fusedRecallAt15 += 1;
      }
      if (name.endsWith("declined") && fusedRankOfB >= 0 && fusedRankOfB < 10 && ruleRankOfB < 0) {
        metrics.negativePromoted += 1;
      }
      if (name.endsWith("declined") && fusedRankOfB >= 0 && fusedRankOfB < 15 && ruleRankOfB < 0) {
        metrics.negativePromoted15 += 1;
      }
      const ruleTop10 = new Set(ruleOrder.slice(0, 10));
      const fusedTop10 = new Set(fusedOrder.slice(0, 10));
      const same =
        ruleTop10.size === fusedTop10.size && [...ruleTop10].every((id) => fusedTop10.has(id));
      if (!same) metrics.sliceChurn += 1;
    }

    metrics.ruleRecallAt5 = pct(metrics.ruleRecallAt5, metrics.pairs);
    metrics.ruleRecallAt10 = pct(metrics.ruleRecallAt10, metrics.pairs);
    metrics.ruleRecallAt15 = pct(metrics.ruleRecallAt15, metrics.pairs);
    metrics.fusedRecallAt5 = pct(metrics.fusedRecallAt5, metrics.pairs);
    metrics.fusedRecallAt10 = pct(metrics.fusedRecallAt10, metrics.pairs);
    metrics.fusedRecallAt15 = pct(metrics.fusedRecallAt15, metrics.pairs);
    metrics.ruleRankBMedian = median(ruleRanks);
    metrics.fusedRankBMedian = median(fusedRanks);
    metrics.negativePromoted = pct(metrics.negativePromoted, metrics.pairs);
    metrics.negativePromoted15 = pct(metrics.negativePromoted15, metrics.pairs);
    metrics.sliceChurn = pct(metrics.sliceChurn, metrics.pairs);
    metrics.ruleScoreBands =
      metrics.pairs > 0
        ? {
            strong: pct(bands.strong, metrics.pairs),
            gray: pct(bands.gray, metrics.pairs),
            low: pct(bands.low, metrics.pairs),
            below: pct(bands.below, metrics.pairs),
            rejected: pct(bands.rejected, metrics.pairs),
          }
        : null;

    console.log(`\n== ${name} (n=${metrics.pairs}) ==`);
    console.log(
      `  recall@5  rule=${metrics.ruleRecallAt5.toFixed(1)}%  fused=${metrics.fusedRecallAt5.toFixed(1)}%`,
    );
    console.log(
      `  recall@10 rule=${metrics.ruleRecallAt10.toFixed(1)}%  fused=${metrics.fusedRecallAt10.toFixed(1)}%`,
    );
    console.log(
      `  recall@15 rule=${metrics.ruleRecallAt15.toFixed(1)}%  fused=${metrics.fusedRecallAt15.toFixed(1)}%`,
    );
    console.log(
      `  rankB median rule=${metrics.ruleRankBMedian ?? "-"}  fused=${metrics.fusedRankBMedian ?? "-"}`,
    );
    if (metrics.ruleScoreBands) {
      const b = metrics.ruleScoreBands;
      console.log(
        `  rule分带(B侧): ≥95 ${b.strong.toFixed(1)}% | 55-95 ${b.gray.toFixed(1)}% | 35-55 ${b.low.toFixed(1)}% | <35 ${b.below.toFixed(1)}% | rejected ${b.rejected.toFixed(1)}%`,
      );
    }
    if (name === "declined-negatives" || name === "csv-declined" || name === "feedback-declined") {
      console.log(`  负例新进入 top10/top15（rule 不可见 → fused 进入）: ${metrics.negativePromoted.toFixed(1)}% / ${metrics.negativePromoted15.toFixed(1)}%`);
    }
    console.log(`  切片变化率: ${metrics.sliceChurn.toFixed(1)}%`);
    return metrics;
  };

  const results: Record<string, StratumMetrics> = {};
  if (positives.length > 0) results["gray-positives"] = await evaluateStratum("gray-positives", positives);
  if (negatives.length > 0) results["declined-negatives"] = await evaluateStratum("declined-negatives", negatives);
  if (humanPositives.length > 0) results["csv-approved"] = await evaluateStratum("csv-approved", humanPositives);
  if (humanNegatives.length > 0) results["csv-declined"] = await evaluateStratum("csv-declined", humanNegatives);
  if (feedbackPositives.length > 0) results["feedback-approved"] = await evaluateStratum("feedback-approved", feedbackPositives);
  if (feedbackNegatives.length > 0) results["feedback-declined"] = await evaluateStratum("feedback-declined", feedbackNegatives);

  fs.writeFileSync(args.cache, JSON.stringify(cache));
  console.log(`\n[eval] embedding cache: ${Object.keys(cache.vectors).length} entries → ${args.cache}`);
  console.log(`[eval] embedding API calls this run: ${apiCalls}`);

  if (args.out) {
    fs.writeFileSync(
      args.out,
      JSON.stringify(
        { generatedAt: new Date().toISOString(), db: args.db, embedModel: args.embedModel, poolSize: args.poolSize, results },
        null,
        2,
      ),
    );
    console.log(`[eval] results → ${args.out}`);
  }

  process.exit(0);
}

main().catch((error) => {
  console.error("[eval] failed:", error);
  process.exit(1);
});
