#!/usr/bin/env node
/**
 * B0 真值补盲抽样：从生产快照（只读）抽取「规则层看不见/判负、但向量语义高度相似」
 * 的候选对，供人工/AI 辅助标注形成银标真值集。
 *
 * 三个抽样层：
 *   below-gray      : 规则分 < 灰区线（55）且从未进入 AI 仲裁的对（合并盲区主体）
 *   anchor-highsim  : no_event_anchor 拒绝但向量相似度高（词汇锚点缺失层）
 *   conflict-highsim: object_conflict 硬否决但向量相似度高（实体否决误杀审查）
 *
 * 另输出实体别名覆盖率：窗口内 subject/object mention 能被 entities/entity_aliases
 * 解析的比例（决定实体归一化层的预期收益上限）。
 *
 * Usage:
 *   INFINITUM_EMBED_URL=... INFINITUM_EMBED_MODEL=... INFINITUM_EMBED_KEY=... \
 *   npx tsx scripts/sample-below-gray-pairs.ts --db <snapshot> [--days 30] \
 *     [--sim-threshold 0.6] [--per-stratum 40] --out docs/eval/below-gray-sample.csv
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- standalone eval tool: DB rows are untyped */
import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { scoreClusterMergeCandidatePair } from "@/lib/clusters/helpers";

// @ts-expect-error node:sqlite has no type declarations in @types/node@20
import { DatabaseSync } from "node:sqlite";

type SqlRow = Record<string, any>;

const DAY_MS = 24 * 60 * 60 * 1000;
const GRAY_SCORE = 55;

function parseArgs(argv: string[]) {
  const args = {
    db: process.env.INFINITUM_EVAL_DB ?? "",
    days: 30,
    simThreshold: 0.6,
    perStratum: 40,
    embedUrl: process.env.INFINITUM_EMBED_URL ?? "",
    embedModel: process.env.INFINITUM_EMBED_MODEL ?? "",
    embedKeyEnv: "INFINITUM_EMBED_KEY",
    cache: path.join(os.tmpdir(), "infinitum-eval-embedding-cache.json"),
    out: "",
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--db") args.db = argv[++i] ?? "";
    else if (arg === "--days") args.days = Number(argv[++i] ?? 30);
    else if (arg === "--sim-threshold") args.simThreshold = Number(argv[++i] ?? 0.6);
    else if (arg === "--per-stratum") args.perStratum = Number(argv[++i] ?? 40);
    else if (arg === "--embed-url") args.embedUrl = argv[++i] ?? "";
    else if (arg === "--embed-model") args.embedModel = argv[++i] ?? "";
    else if (arg === "--embed-key-env") args.embedKeyEnv = argv[++i] ?? "";
    else if (arg === "--cache") args.cache = argv[++i] ?? "";
    else if (arg === "--out") args.out = argv[++i] ?? "";
  }
  if (!args.db) throw new Error("missing DB snapshot: pass --db <path>");
  if (!fs.existsSync(args.db)) throw new Error(`DB snapshot not found: ${args.db}`);
  if (!args.embedUrl || !args.embedModel) {
    throw new Error("missing embedding endpoint: pass --embed-url/--embed-model (or env)");
  }
  return args;
}

type ClusterRow = {
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
  latestPublishedAt: number;
};

function loadCache(file: string, model: string): { model: string; vectors: Record<string, number[]> } {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed.model === model && parsed.vectors) return parsed;
  } catch {
    // fresh cache
  }
  return { model, vectors: {} };
}

async function embedAll(
  config: { url: string; model: string; key: string },
  texts: string[],
  cache: { model: string; vectors: Record<string, number[]> },
  cachePath: string,
): Promise<Float32Array[]> {
  const hashOf = (text: string) => createHash("sha256").update(`${config.model}\n${text}`).digest("hex");
  const vectors = new Array<Float32Array | null>(texts.length).fill(null);
  const misses: number[] = [];
  texts.forEach((text, i) => {
    const hit = cache.vectors[hashOf(text)];
    if (hit) vectors[i] = new Float32Array(hit);
    else misses.push(i);
  });

  const batchSize = 32;
  for (let start = 0; start < misses.length; start += batchSize) {
    const slice = misses.slice(start, start + batchSize);
    let data: Array<{ embedding?: number[]; index?: number }> = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await fetch(`${config.url.replace(/\/$/, "")}/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.key}` },
        body: JSON.stringify({ model: config.model, input: slice.map((i) => texts[i]) }),
      });
      if (response.ok) {
        const body = (await response.json()) as { data?: Array<{ embedding?: number[]; index?: number }> };
        data = body.data ?? [];
        break;
      }
      if (attempt === 3) throw new Error(`embedding API ${response.status}: ${(await response.text()).slice(0, 200)}`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
    if (data.length !== slice.length) throw new Error(`embedding API returned ${data.length}/${slice.length}`);
    data.forEach((row, position) => {
      const target = typeof row.index === "number" ? row.index : position;
      const vector = new Float32Array(row.embedding ?? []);
      vectors[slice[target]!] = vector;
      cache.vectors[hashOf(texts[slice[target]!]!)] = Array.from(vector);
    });
    if ((start / batchSize) % 20 === 0) {
      fs.writeFileSync(cachePath, JSON.stringify(cache));
      console.log(`[sample] embedded ${Math.min(start + batchSize, misses.length)}/${misses.length} (cache saved)`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return vectors as Float32Array[];
}

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function main() {
  const args = parseArgs(process.argv);
  const embedKey = process.env[args.embedKeyEnv] ?? "";
  if (!embedKey) throw new Error(`missing embedding API key: set ${args.embedKeyEnv}`);

  console.log(`[sample] DB snapshot: ${args.db}, window=${args.days}d, sim>=${args.simThreshold}`);
  const db = new DatabaseSync(args.db, { readOnly: true });

  const newestRow = db
    .prepare(`SELECT MAX(latestPublishedAt) m FROM content_clusters WHERE latestPublishedAt IS NOT NULL`)
    .get();
  const now = Number(newestRow?.m ?? Date.now());
  const since = now - args.days * DAY_MS;

  const clusterRows = db
    .prepare(
      `SELECT id, title, summary, fingerprint, eventType, eventSubject, eventAction,
              eventObject, eventDate, itemCount, latestPublishedAt
         FROM content_clusters
        WHERE latestPublishedAt >= ? AND status = 'active' AND itemCount > 0`,
    )
    .all(since) as SqlRow[];
  const clusters: ClusterRow[] = clusterRows.map((row) => ({
    id: row.id,
    title: row.title ?? "",
    summary: row.summary ?? "",
    fingerprint: row.fingerprint ?? "",
    eventType: row.eventType ?? null,
    eventSubject: row.eventSubject ?? null,
    eventAction: row.eventAction ?? null,
    eventObject: row.eventObject ?? null,
    eventDate: row.eventDate ?? null,
    itemCount: Number(row.itemCount ?? 0),
    latestPublishedAt: Number(row.latestPublishedAt ?? now),
  }));
  console.log(`[sample] window active clusters: ${clusters.length}`);

  // ---- embedding + top-k neighbor search ----
  const texts = clusters.map((c) => `${c.title}\n${c.summary.trim()}`);
  const cache = loadCache(args.cache, args.embedModel);
  const vectors = await embedAll(
    { url: args.embedUrl, model: args.embedModel, key: embedKey },
    texts,
    cache,
    args.cache,
  );
  fs.writeFileSync(args.cache, JSON.stringify(cache));
  console.log(`[sample] vectors ready: ${vectors.length} (cache: ${Object.keys(cache.vectors).length})`);

  // bge-m3 输出为单位归一化向量，点积即余弦
  const neighbors: Array<Array<{ j: number; sim: number }>> = clusters.map(() => []);
  for (let i = 0; i < clusters.length; i += 1) {
    const vi = vectors[i]!;
    for (let j = i + 1; j < clusters.length; j += 1) {
      const vj = vectors[j]!;
      let dot = 0;
      for (let d = 0; d < vi.length; d += 1) dot += vi[d]! * vj[d]!;
      if (dot >= args.simThreshold) {
        neighbors[i]!.push({ j, sim: dot });
        neighbors[j]!.push({ j: i, sim: dot });
      }
    }
  }

  // ---- 打分分层（每聚类每层最多 3 对，避免枢纽聚类垄断样本） ----
  const seen = new Set<string>();
  const perClusterCap = 3;
  const bucketUsage = new Map<string, Map<string, number>>();
  const canAdmit = (stratum: string, aId: string, bId: string) => {
    const usage = bucketUsage.get(stratum) ?? new Map<string, number>();
    bucketUsage.set(stratum, usage);
    return (usage.get(aId) ?? 0) < perClusterCap && (usage.get(bId) ?? 0) < perClusterCap;
  };
  const admit = (stratum: string, aId: string, bId: string) => {
    const usage = bucketUsage.get(stratum)!;
    usage.set(aId, (usage.get(aId) ?? 0) + 1);
    usage.set(bId, (usage.get(bId) ?? 0) + 1);
  };
  const belowGray: Array<Record<string, unknown>> = [];
  const anchorHighSim: Array<Record<string, unknown>> = [];
  const conflictHighSim: Array<Record<string, unknown>> = [];
  const stats = { pairsScored: 0, belowGrayAll: 0, anchorAll: 0, conflictAll: 0 };

  const toRecord = (a: ClusterRow, b: ClusterRow, sim: number, result: ReturnType<typeof scoreClusterMergeCandidatePair>, stratum: string) => ({
    pairKey: `${a.id}|${b.id}`,
    stratum,
    sim: sim.toFixed(4),
    ruleScore: result.score,
    rejectedReason: result.rejectedReason ?? "",
    titleA: a.title,
    summaryA: a.summary,
    subjA: a.eventSubject ?? "",
    objA: a.eventObject ?? "",
    dateA: a.eventDate ?? "",
    titleB: b.title,
    summaryB: b.summary,
    subjB: b.eventSubject ?? "",
    objB: b.eventObject ?? "",
    dateB: b.eventDate ?? "",
    aiLabel: "",
    labelNote: "",
    reviewVerdict: "",
  });

  for (let i = 0; i < clusters.length; i += 1) {
    for (const { j, sim } of neighbors[i]!) {
      const pairId = i < j ? `${i}|${j}` : `${j}|${i}`;
      if (seen.has(pairId)) continue;
      seen.add(pairId);
      const a = clusters[i]!;
      const b = clusters[j]!;
      // 评分器期望 Date 类型；行数据里是 epoch 毫秒
      const result = scoreClusterMergeCandidatePair(
        { ...a, latestPublishedAt: new Date(a.latestPublishedAt) },
        { ...b, latestPublishedAt: new Date(b.latestPublishedAt) },
      );
      stats.pairsScored += 1;

      if (result.rejectedReason === "object_conflict") {
        stats.conflictAll += 1;
        if (conflictHighSim.length < args.perStratum && canAdmit("conflict", a.id, b.id)) {
          conflictHighSim.push(toRecord(a, b, sim, result, "conflict-highsim"));
          admit("conflict", a.id, b.id);
        }
        continue;
      }
      if (result.rejectedReason === "no_event_anchor") {
        stats.anchorAll += 1;
        if (anchorHighSim.length < args.perStratum && canAdmit("anchor", a.id, b.id)) {
          anchorHighSim.push(toRecord(a, b, sim, result, "anchor-highsim"));
          admit("anchor", a.id, b.id);
        }
        continue;
      }
      if (result.score < GRAY_SCORE) {
        stats.belowGrayAll += 1;
        if (belowGray.length < args.perStratum && canAdmit("below", a.id, b.id)) {
          belowGray.push(toRecord(a, b, sim, result, "below-gray"));
          admit("below", a.id, b.id);
        }
      }
    }
  }
  console.log(
    `[sample] high-sim pairs scored=${stats.pairsScored} | below-gray=${stats.belowGrayAll} anchor=${stats.anchorAll} conflict=${stats.conflictAll}`,
  );

  // ---- 别名覆盖率 ----
  const canonical = new Set<string>();
  for (const row of db.prepare(`SELECT normalized FROM entities`).all() as SqlRow[]) {
    canonical.add(String(row.normalized ?? "").toLowerCase());
  }
  for (const row of db.prepare(`SELECT aliasNormalized FROM entity_aliases`).all() as SqlRow[]) {
    canonical.add(String(row.aliasNormalized ?? "").toLowerCase());
  }
  let mentions = 0;
  let covered = 0;
  for (const cluster of clusters) {
    for (const mention of [cluster.eventSubject, cluster.eventObject]) {
      const value = (mention ?? "").trim().toLowerCase();
      if (!value) continue;
      mentions += 1;
      if (canonical.has(value)) covered += 1;
    }
  }
  const coverage = mentions === 0 ? 0 : (covered / mentions) * 100;
  console.log(`[sample] 实体别名覆盖率: ${covered}/${mentions} (${coverage.toFixed(1)}%) — 解析层收益上限`);

  // ---- 输出 CSV ----
  const rows = [...belowGray, ...anchorHighSim, ...conflictHighSim];
  const header = [
    "pairKey", "stratum", "sim", "ruleScore", "rejectedReason",
    "titleA", "summaryA", "subjA", "objA", "dateA",
    "titleB", "summaryB", "subjB", "objB", "dateB",
    "aiLabel", "labelNote", "reviewVerdict",
  ];
  const csv = [header.join(",")]
    .concat(rows.map((row) => header.map((column) => csvCell(row[column])).join(",")))
    .join("\n");
  if (args.out) {
    fs.writeFileSync(args.out, csv);
    console.log(`[sample] ${rows.length} pairs → ${args.out}`);
  } else {
    console.log(csv);
  }

  process.exit(0);
}

main().catch((error) => {
  console.error("[sample] failed:", error);
  process.exit(1);
});
