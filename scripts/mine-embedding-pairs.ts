#!/usr/bin/env node
/**
 * 基于向量的同事件候选对挖掘（扩充人工标注样例）。
 *
 * 动机：eval-sample-30d.csv 的 240 对随机样本只产出 12 个 approved 正例，
 * 无法支撑 Phase 1 召回效果检验。本脚本从冻结快照挖「向量高相似但管线未合并」
 * 的聚类对——正是规则漏掉的同事件对的高产矿层；另采一组中相似度对照对。
 * 输出与 eval-sample-30d.csv 同 schema 的 CSV，verdictStored=pending，
 * 由 AI 辅助标注 + 人工抽检（Phase 0 先例）。
 *
 * Usage:
 *   INFINITUM_EMBED_URL=... INFINITUM_EMBED_MODEL=... INFINITUM_EMBED_KEY=... \
 *   npx tsx scripts/mine-embedding-pairs.ts --db <snapshot> [--days 30] \
 *     [--min-sim 0.72] [--top 120] [--controls 25] --out docs/eval/embedding-mined-pairs.csv
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- standalone eval tool: DB rows are untyped */
import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

// @ts-expect-error node:sqlite has no type declarations in @types/node@20
import { DatabaseSync } from "node:sqlite";

type SqlRow = Record<string, any>;

const DAY_MS = 24 * 60 * 60 * 1000;

function parseArgs(argv: string[]) {
  const args: {
    db: string;
    days: number;
    minSim: number;
    controlMin: number;
    controlMax: number;
    top: number;
    controls: number;
    maxPartners: number;
    out: string;
    cache: string;
    embedUrl: string;
    embedModel: string;
    embedKeyEnv: string;
  } = {
    db: process.env.INFINITUM_EVAL_DB ?? "",
    days: 30,
    minSim: 0.72,
    controlMin: 0.6,
    controlMax: 0.72,
    top: 120,
    controls: 25,
    maxPartners: 3,
    out: "docs/eval/embedding-mined-pairs.csv",
    cache: path.join(os.tmpdir(), "infinitum-eval-embedding-cache.json"),
    embedUrl: process.env.INFINITUM_EMBED_URL ?? "",
    embedModel: process.env.INFINITUM_EMBED_MODEL ?? "",
    embedKeyEnv: "INFINITUM_EMBED_KEY",
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--db") args.db = argv[++i] ?? "";
    else if (arg === "--days") args.days = Number(argv[++i] ?? 30);
    else if (arg === "--min-sim") args.minSim = Number(argv[++i] ?? 0.72);
    else if (arg === "--control-min") args.controlMin = Number(argv[++i] ?? 0.6);
    else if (arg === "--control-max") args.controlMax = Number(argv[++i] ?? 0.72);
    else if (arg === "--top") args.top = Number(argv[++i] ?? 120);
    else if (arg === "--controls") args.controls = Number(argv[++i] ?? 25);
    else if (arg === "--max-partners") args.maxPartners = Number(argv[++i] ?? 3);
    else if (arg === "--out") args.out = argv[++i] ?? "";
    else if (arg === "--cache") args.cache = argv[++i] ?? "";
    else if (arg === "--embed-url") args.embedUrl = argv[++i] ?? "";
    else if (arg === "--embed-model") args.embedModel = argv[++i] ?? "";
    else if (arg === "--embed-key-env") args.embedKeyEnv = argv[++i] ?? "";
  }
  if (!args.db) throw new Error("missing DB snapshot: pass --db <path> or set INFINITUM_EVAL_DB");
  if (!fs.existsSync(args.db)) throw new Error(`DB snapshot not found: ${args.db}`);
  if (!args.embedUrl || !args.embedModel) throw new Error("missing embedding endpoint (env/args)");
  return args;
}

type ClusterRow = {
  id: string;
  title: string;
  summary: string;
  fingerprint: string;
  eventFingerprint: string | null;
  eventType: string | null;
  eventSubject: string | null;
  eventAction: string | null;
  eventObject: string | null;
  eventDate: string | null;
  itemCount: number;
  latestPublishedAt: number;
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

function hashOf(model: string, text: string): string {
  return createHash("sha256").update(`${model}\n${text}`).digest("hex");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function csvCell(value: string | null | undefined): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return `"${text.replaceAll('"', '""')}"`;
}

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

async function main() {
  const args = parseArgs(process.argv);
  const embedKey = process.env[args.embedKeyEnv] ?? "";
  if (!embedKey) throw new Error(`missing embedding API key: set ${args.embedKeyEnv}`);

  const db = new DatabaseSync(args.db, { readOnly: true });
  const newestRow = db.prepare(`SELECT MAX(latestPublishedAt) m FROM content_clusters`).get();
  const now = Number(newestRow?.m ?? Date.now());
  const since = now - args.days * DAY_MS;

  const rows = db
    .prepare(
      `SELECT id, title, summary, fingerprint, eventFingerprint, eventType, eventSubject,
              eventAction, eventObject, eventDate, itemCount, latestPublishedAt
         FROM content_clusters
        WHERE latestPublishedAt >= ? AND status = 'active' AND itemCount > 0`,
    )
    .all(since) as SqlRow[];
  const clusters: ClusterRow[] = rows.map((row) => ({
    id: row.id,
    title: row.title ?? "",
    summary: (row.summary ?? "").replace(/\s+/g, " ").trim(),
    fingerprint: row.fingerprint ?? "",
    eventFingerprint: row.eventFingerprint ?? null,
    eventType: row.eventType ?? null,
    eventSubject: row.eventSubject ?? null,
    eventAction: row.eventAction ?? null,
    eventObject: row.eventObject ?? null,
    eventDate: row.eventDate ?? null,
    itemCount: row.itemCount ?? 0,
    latestPublishedAt: Number(row.latestPublishedAt),
  }));
  console.log(`[mine] window clusters: ${clusters.length}`);

  // 已合并/已进灰区的对不算「未合并」候选
  const grayKeys = new Set<string>(
    (db.prepare(`SELECT pairKey FROM cluster_merge_clean_pair_candidates`).all() as SqlRow[]).map(
      (row) => row.pairKey as string,
    ),
  );

  const cache = loadCache(args.cache, args.embedModel);
  const embed = async (texts: string[]) => {
    const hash = (text: string) => hashOf(args.embedModel, text);
    const missing = texts.filter((text) => !cache.vectors[hash(text)]);
    const batchSize = 32;
    for (let start = 0; start < missing.length; start += batchSize) {
      const slice = missing.slice(start, start + batchSize);
      let data: Array<{ embedding?: number[]; index?: number }> = [];
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const response = await fetch(`${args.embedUrl.replace(/\/$/, "")}/embeddings`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${embedKey}` },
          body: JSON.stringify({ model: args.embedModel, input: slice }),
        });
        if (response.ok) {
          const body = (await response.json()) as { data?: Array<{ embedding?: number[]; index?: number }> };
          data = body.data ?? [];
          break;
        }
        if (attempt === 3) throw new Error(`embedding API ${response.status}`);
        await sleep(attempt * 2000);
      }
      data.forEach((row, position) => {
        const target = typeof row.index === "number" ? row.index : position;
        if (row.embedding) cache.vectors[hash(slice[target]!)] = row.embedding;
      });
      fs.writeFileSync(args.cache, JSON.stringify(cache));
      process.stdout.write(`[mine] embedded ${Math.min(start + batchSize, missing.length)}/${missing.length}\r`);
      await sleep(150);
    }
    if (missing.length > 0) process.stdout.write("\n");
    return texts.map((text) => cache.vectors[hash(text)]!);
  };

  const texts = clusters.map((c) => `${c.title}\n${c.summary}`);
  const vectors = await embed(texts);
  fs.writeFileSync(args.cache, JSON.stringify(cache));

  // 归一化 + 扁平化，内层用紧凑 dot 循环
  const dim = vectors[0]!.length;
  const flat = new Float32Array(clusters.length * dim);
  for (let i = 0; i < clusters.length; i += 1) {
    const vec = vectors[i]!;
    let norm = 0;
    for (let d = 0; d < dim; d += 1) norm += vec[d]! * vec[d]!;
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < dim; d += 1) flat[i * dim + d] = vec[d]! / norm;
  }

  const pairKeyOf = (a: string, b: string) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const sameIdentity = (a: ClusterRow, b: ClusterRow) =>
    (a.fingerprint && a.fingerprint === b.fingerprint) ||
    (a.eventFingerprint && a.eventFingerprint === b.eventFingerprint);

  const startedAt = Date.now();
  const candidates: Array<{ i: number; j: number; sim: number }> = [];
  for (let i = 0; i < clusters.length; i += 1) {
    const base = i * dim;
    for (let j = i + 1; j < clusters.length; j += 1) {
      if (sameIdentity(clusters[i]!, clusters[j]!)) continue;
      const other = j * dim;
      let dot = 0;
      for (let d = 0; d < dim; d += 1) dot += flat[base + d]! * flat[other + d]!;
      if (dot >= args.controlMin) candidates.push({ i, j, sim: dot });
    }
    if (i % 1000 === 0) {
      process.stdout.write(`[mine] pairs scan ${i}/${clusters.length} (${candidates.length} hits, ${Math.round((Date.now() - startedAt) / 1000)}s)\r`);
    }
  }
  console.log(`[mine] scan done: ${candidates.length} pairs >= ${args.controlMin} in ${Math.round((Date.now() - startedAt) / 1000)}s`);

  candidates.sort((left, right) => right.sim - left.sim);

  const partnerCount = new Map<number, number>();
  const mined: Array<{ i: number; j: number; sim: number }> = [];
  const controls: Array<{ i: number; j: number; sim: number }> = [];
  const usedPairs = new Set<string>();
  for (const candidate of candidates) {
    if (mined.length >= args.top) break;
    if (candidate.sim < args.minSim) break;
    const key = pairKeyOf(clusters[candidate.i]!.id, clusters[candidate.j]!.id);
    if (grayKeys.has(key) || usedPairs.has(key)) continue;
    if ((partnerCount.get(candidate.i) ?? 0) >= args.maxPartners) continue;
    if ((partnerCount.get(candidate.j) ?? 0) >= args.maxPartners) continue;
    partnerCount.set(candidate.i, (partnerCount.get(candidate.i) ?? 0) + 1);
    partnerCount.set(candidate.j, (partnerCount.get(candidate.j) ?? 0) + 1);
    usedPairs.add(key);
    mined.push(candidate);
  }

  const rng = mulberry32(fnv1a(`controls:${args.db}:${args.days}`));
  const band = candidates.filter((c) => c.sim >= args.controlMin && c.sim < args.controlMax);
  while (controls.length < args.controls && band.length > 0) {
    const candidate = band[Math.floor(rng() * band.length)]!;
    const key = pairKeyOf(clusters[candidate.i]!.id, clusters[candidate.j]!.id);
    if (!usedPairs.has(key)) {
      usedPairs.add(key);
      controls.push(candidate);
    }
    if (usedPairs.size > candidates.length) break;
  }

  const header =
    "pairKey,verdictStored,scoreForLabel,aExists,bExists,titleA,titleB,summaryA,summaryB,subjectA,subjectB,objectA,objectB,actionA,actionB,typeA,typeB,dateA,dateB,itemCountA,itemCountB,createdAt";
  const toRow = (candidate: { i: number; j: number; sim: number }, label: string) => {
    // 固定 A=id 较小一侧，pairKey 与 eval-cluster-baseline 口径一致
    const swap = clusters[candidate.i]!.id > clusters[candidate.j]!.id;
    const a = clusters[swap ? candidate.j : candidate.i]!;
    const b = clusters[swap ? candidate.i : candidate.j]!;
    const createdAt = Math.max(a.latestPublishedAt, b.latestPublishedAt);
    return [
      `"${pairKeyOf(a.id, b.id)}"`,
      label,
      `"${candidate.sim.toFixed(4)}"`,
      "true",
      "true",
      csvCell(a.title),
      csvCell(b.title),
      csvCell(a.summary.slice(0, 600)),
      csvCell(b.summary.slice(0, 600)),
      csvCell(a.eventSubject),
      csvCell(b.eventSubject),
      csvCell(a.eventObject),
      csvCell(b.eventObject),
      csvCell(a.eventAction),
      csvCell(b.eventAction),
      csvCell(a.eventType),
      csvCell(b.eventType),
      csvCell(a.eventDate),
      csvCell(b.eventDate),
      String(a.itemCount),
      String(b.itemCount),
      String(createdAt),
    ].join(",");
  };

  const lines = [header];
  for (const candidate of mined) lines.push(toRow(candidate, "pending"));
  for (const candidate of controls) lines.push(toRow(candidate, "pending"));
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${lines.join("\n")}\n`);
  console.log(`[mine] mined=${mined.length} (>= ${args.minSim}), controls=${controls.length} (${args.controlMin}-${args.controlMax})`);
  console.log(`[mine] → ${args.out}（verdictStored=pending，待标注）`);
  process.exit(0);
}

main().catch((error) => {
  console.error("[mine] failed:", error);
  process.exit(1);
});
