#!/usr/bin/env node
/**
 * Cluster merge evaluation baseline.
 *
 * Reads a read-only snapshot of the production SQLite DB and recomputes the
 * local merge-rule score for candidate cluster pairs inside a configurable
 * lookback window, then compares against the decisions the pipeline recorded
 * (cluster_decisions.kind='cluster_pair').
 *
 * Two measurement strata (important — they differ in what can be measured):
 *   1. APPROVED pairs: the pipeline merged them, so the source cluster was
 *      deleted. Only the stored localScore can be used (the rule cannot be
 *      re-run without the vanished side).
 *   2. DECLINED / FAILED / AMBIGUOUS pairs: both clusters usually still exist,
 *      so the current rule score is recomputed and compared with the actual
 *      decision.
 *
 * Outputs:
 *   - decision volume & verdict distribution in window
 *   - stored localScore distribution for approved (merged) vs declined
 *   - recomputed rule score vs actual verdict agreement (declined side)
 *   - a stratified CSV sample (`--samples <n>`) for human/AI labeling
 *
 * Usage:
 *   npx tsx scripts/eval-cluster-baseline.ts --db <snapshot> [--days 30] [--samples 300]
 *
 * DB path may come from env INFINITUM_EVAL_DB. The DB must be a read-only copy
 * of the production snapshot; the script never writes to it.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- standalone eval tool: DB rows are untyped */
import fs from "node:fs";
import path from "node:path";

import { scoreClusterMergeCandidatePair } from "@/lib/clusters/helpers";

// node:sqlite ships in Node 22+/25+; @types/node@20 has no declarations for it.
// @ts-expect-error node:sqlite has no type declarations in @types/node@20
import { DatabaseSync } from "node:sqlite";

type SqlRow = Record<string, any>;

type DecisionRecord = {
  leftClusterId: string;
  rightClusterId: string;
  verdict: string;
  localScoreStored: number | null;
  reasonCode: string | null;
  confidence: number | null;
  appliedAt: number | null;
  createdAt: number;
  aExists: boolean;
  bExists: boolean;
  existBoth: boolean;
  titleA: string;
  summaryA: string;
  subjectA: string | null;
  objectA: string | null;
  actionA: string | null;
  typeA: string | null;
  dateA: string | null;
  itemCountA: number;
  titleB: string;
  summaryB: string;
  subjectB: string | null;
  objectB: string | null;
  actionB: string | null;
  typeB: string | null;
  dateB: string | null;
  itemCountB: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function parseArgs(argv: string[]) {
  const args: { db: string; days: number; samples: number; out: string; json: string; freeze: string } = {
    db: process.env.INFINITUM_EVAL_DB ?? "",
    days: 30,
    samples: 0,
    out: "",
    json: "",
    freeze: "",
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--db") args.db = argv[++i] ?? "";
    else if (arg === "--days") args.days = Number(argv[++i] ?? 30);
    else if (arg === "--samples") args.samples = Number(argv[++i] ?? 0);
    else if (arg === "--out") args.out = argv[++i] ?? "";
    else if (arg === "--json") args.json = argv[++i] ?? "";
    else if (arg === "--freeze") args.freeze = argv[++i] ?? "";
  }
  if (!args.db) throw new Error("missing DB snapshot: pass --db <path> or set INFINITUM_EVAL_DB");
  if (!fs.existsSync(args.db)) throw new Error(`DB snapshot not found: ${args.db}`);
  return args;
}

function toClusterCandidate(row: Record<string, unknown>) {
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

function decisionBucket(score: number | null) {
  if (score === null) return "null";
  if (score >= 95) return ">=95";
  if (score >= 70) return "70-95";
  if (score >= 55) return "55-70";
  return "<55";
}

function median(vals: number[]) {
  if (vals.length === 0) return NaN;
  const s = [...vals].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function mean(vals: number[]) {
  if (vals.length === 0) return NaN;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

async function main() {
  const args = parseArgs(process.argv);
  console.log(
    `[eval] DB snapshot: ${args.db} (${(fs.statSync(args.db).size / 1024 / 1024).toFixed(1)} MB), window=${args.days}d`,
  );

  const db = new DatabaseSync(args.db, { readOnly: true });

  // Anchor the window on the newest decision timestamp in the snapshot to avoid
  // skew between this machine's clock and the production snapshot's clock.
  const newestRow = db
    .prepare(
      `SELECT MAX(createdAt) m FROM cluster_decisions WHERE kind = 'cluster_pair' AND createdAt IS NOT NULL`,
    )
    .get();
  const now = Number(newestRow?.m ?? Date.now());
  const since = now - args.days * DAY_MS;
  console.log(`[eval] window anchor=${new Date(now).toISOString()} since=${new Date(since).toISOString()}`);

  // ---- 1. Window clusters (coverage report) ----
  const clustersRaw = db
    .prepare(
      `SELECT id, title, summary, fingerprint, eventType, eventSubject, eventAction,
              eventObject, eventDate, itemCount, latestPublishedAt, eventFingerprint, eventBucket
         FROM content_clusters
        WHERE latestPublishedAt >= ? AND status IN ('active','hidden')`,
    )
    .all(since) as SqlRow[];
  const clusters = clustersRaw.map((row) => toClusterCandidate(row));
  console.log(`[eval] window clusters (latestPublishedAt): ${clusters.length}`);
  const sigComplete = clusters.filter(
    (c) => c.eventSubject && c.eventObject && (c.eventAction || c.eventType),
  ).length;
  console.log(`[eval] event-signature complete: ${sigComplete}/${clusters.length} (${((sigComplete / clusters.length) * 100).toFixed(1)}%)`);

  // ---- 2. All cluster-pair decisions in window (with existence flags) ----
  const decisionsRaw = db
    .prepare(
      `SELECT d.leftClusterId, d.rightClusterId, d.verdict, d.localScore, d.reasonCode,
              d.confidence, d.appliedAt, d.createdAt,
              (a.id IS NOT NULL) AS aExists, (b.id IS NOT NULL) AS bExists,
              a.title AS titleA, a.summary AS summaryA, a.eventSubject AS subjectA,
              a.eventObject AS objectA, a.eventAction AS actionA, a.eventType AS typeA,
              a.eventDate AS dateA, a.itemCount AS itemCountA,
              b.title AS titleB, b.summary AS summaryB, b.eventSubject AS subjectB,
              b.eventObject AS objectB, b.eventAction AS actionB, b.eventType AS typeB,
              b.eventDate AS dateB, b.itemCount AS itemCountB
         FROM cluster_decisions d
         LEFT JOIN content_clusters a ON a.id = d.leftClusterId
         LEFT JOIN content_clusters b ON b.id = d.rightClusterId
        WHERE d.kind = 'cluster_pair' AND d.createdAt >= ?`,
    )
    .all(since) as SqlRow[];
  const decisions = decisionsRaw.map((row): DecisionRecord => ({
      leftClusterId: row.leftClusterId,
      rightClusterId: row.rightClusterId,
      verdict: row.verdict,
      localScoreStored: row.localScore,
      reasonCode: row.reasonCode,
      confidence: row.confidence,
      appliedAt: row.appliedAt,
      createdAt: row.createdAt,
      aExists: Boolean(row.aExists),
      bExists: Boolean(row.bExists),
      existBoth: Boolean(row.aExists && row.bExists),
      titleA: row.titleA ?? "",
      summaryA: row.summaryA ?? "",
      subjectA: row.subjectA ?? null,
      objectA: row.objectA ?? null,
      actionA: row.actionA ?? null,
      typeA: row.typeA ?? null,
      dateA: row.dateA ?? null,
      itemCountA: row.itemCountA ?? 0,
      titleB: row.titleB ?? "",
      summaryB: row.summaryB ?? "",
      subjectB: row.subjectB ?? null,
      objectB: row.objectB ?? null,
      actionB: row.actionB ?? null,
      typeB: row.typeB ?? null,
      dateB: row.dateB ?? null,
      itemCountB: row.itemCountB ?? 0,
    }));
  console.log(`[eval] window pair decisions: ${decisions.length}`);

  // ---- 3. Per-verdict overview (fresh counts, no dedup) ----
  const verdictCount = new Map();
  for (const d of decisions) verdictCount.set(d.verdict, (verdictCount.get(d.verdict) ?? 0) + 1);
  console.log("\n=== verdict distribution (window) ===");
  for (const v of ["approved", "declined", "ambiguous", "failed"]) {
    if (verdictCount.has(v)) console.log(`${v}\t${verdictCount.get(v)}`);
  }

  // ---- 4. Stored localScore for approved (merged) vs declined ----
  const approvedScores = decisions
    .filter((d) => d.verdict === "approved" && d.localScoreStored != null)
    .map((d) => d.localScoreStored as number);
  const declinedScores = decisions
    .filter((d) => d.verdict === "declined" && d.localScoreStored != null)
    .map((d) => d.localScoreStored as number);
  console.log("\n=== stored localScore (the score the pipeline saw when merging/declining) ===");
  console.log(
    `approved: n=${approvedScores.length} mean=${mean(approvedScores).toFixed(1)} median=${median(approvedScores)} min=${approvedScores.length ? Math.min(...approvedScores) : "-"} max=${approvedScores.length ? Math.max(...approvedScores) : "-"}`,
  );
  console.log(
    `declined: n=${declinedScores.length} mean=${mean(declinedScores).toFixed(1)} median=${median(declinedScores)} min=${declinedScores.length ? Math.min(...declinedScores) : "-"} max=${declinedScores.length ? Math.max(...declinedScores) : "-"}`,
  );
  // overlap histogram in stores
  const hist = (vals: number[], bucketFn: (v: number) => string) => {
    const m = new Map();
    for (const v of vals) {
      const b = bucketFn(v);
      m.set(b, (m.get(b) ?? 0) + 1);
    }
    return m;
  };
  const apHist = hist(approvedScores, decisionBucket);
  const dcHist = hist(declinedScores, decisionBucket);
  console.log("approved score buckets:", [...apHist.entries()].map(([k, v]) => `${k}:${v}`).join(" "));
  console.log("declined score buckets:", [...dcHist.entries()].map(([k, v]) => `${k}:${v}`).join(" "));

  // ---- 5. Recompute rule score for pairs whose clusters BOTH still exist ----
  console.log("\n=== recomputed rule score on ALIVE pairs (decisions where both clusters exist) ===");
  const aliveRows: Array<DecisionRecord & {
    recomputedScore: number;
    rejected: boolean;
    rejectedReason: string | null;
  }> = [];
  for (const d of decisions) {
    if (!d.existBoth) continue;
    const a = {
      id: d.leftClusterId,
      title: d.titleA,
      summary: d.summaryA,
      fingerprint: "",
      eventType: d.typeA,
      eventSubject: d.subjectA,
      eventAction: d.actionA,
      eventObject: d.objectA,
      eventDate: d.dateA,
      itemCount: d.itemCountA,
      latestPublishedAt: new Date(0),
    };
    const b = {
      id: d.rightClusterId,
      title: d.titleB,
      summary: d.summaryB,
      fingerprint: "",
      eventType: d.typeB,
      eventSubject: d.subjectB,
      eventAction: d.actionB,
      eventObject: d.objectB,
      eventDate: d.dateB,
      itemCount: d.itemCountB,
      latestPublishedAt: new Date(0),
    };
    const result = scoreClusterMergeCandidatePair(a, b);
    aliveRows.push({ ...d, recomputedScore: result.score, rejected: result.rejected, rejectedReason: result.rejectedReason });
  }
  console.log(`alive pairs: ${aliveRows.length} (of ${decisions.length})`);

  // alive approved pairs are rare (approved usually deletes), but if any exist, use them too
  const aliveApproved = aliveRows.filter((r) => r.verdict === "approved");
  console.log(`alive approved pairs (can re-score): ${aliveApproved.length}`);

  const bucketAgg = new Map();
  for (const r of aliveRows) {
    const bucket = decisionBucket(r.recomputedScore);
    const agg = bucketAgg.get(bucket) ?? { count: 0, approved: 0, declined: 0, ambiguous: 0, failed: 0, rejected: 0 };
    agg.count += 1;
    agg[r.verdict] += 1;
    if (r.rejected) agg.rejected += 1;
    bucketAgg.set(bucket, agg);
  }
  console.log(
    ["bucket", "pairs", "approved", "declined", "ambiguous", "failed", "ruleRejected"].join("\t"),
  );
  for (const bucket of ["null", ">=95", "70-95", "55-70", "<55"]) {
    const agg = bucketAgg.get(bucket);
    if (!agg) continue;
    console.log([bucket, agg.count, agg.approved, agg.declined, agg.ambiguous, agg.failed, agg.rejected].join("\t"));
  }

  // ---- 6. Rule-vs-decision quality signals ----
  const recomputedStrong = aliveRows.filter((r) => !r.rejected && r.recomputedScore >= 95);
  const strongDeclined = recomputedStrong.filter((r) => r.verdict === "declined");
  const ruleRejectedApproved = aliveRows.filter((r) => r.verdict === "approved" && r.rejected);
  console.log("\n=== rule vs decision ==");
  console.log(`alive pairs rule-strong (>=95, non-rejected): ${recomputedStrong.length}`);
  console.log(
    `  but AI declined: ${strongDeclined.length} (${recomputedStrong.length ? ((strongDeclined.length / recomputedStrong.length) * 100).toFixed(1) : 0}%)`,
  );
  console.log(`approved pairs that current rule REJECTS: ${ruleRejectedApproved.length}`);

  // Rule "would merge" threshold exercise on alive pairs vs actual decision
  const aliveNonFailed = aliveRows.filter((r) => r.verdict !== "failed");
  for (const thr of [55, 70, 95]) {
    const wouldMerge = aliveNonFailed.filter((r) => !r.rejected && r.recomputedScore >= thr);
    const wouldReject = aliveNonFailed.filter((r) => (r.rejected || r.recomputedScore < thr));
    const tp = wouldMerge.filter((r) => r.verdict === "approved").length;
    const fp = wouldMerge.filter((r) => r.verdict === "declined").length;
    const fn = wouldReject.filter((r) => r.verdict === "approved").length;
    const tn = wouldReject.filter((r) => r.verdict === "declined").length;
    const precision = tp + fp > 0 ? (tp / (tp + fp)) : 0;
    const recall = tp + fn > 0 ? (tp / (tp + fn)) : 0;
    console.log(
      `threshold >=${thr}: tp=${tp} fp=${fp} fn=${fn} tn=${tn} precision=${(precision * 100).toFixed(1)}% recall=${(recall * 100).toFixed(1)}%`,
    );
  }

  // ---- 7. Fragmentation proxy & per-day coverage ----
  console.log("\n=== clusters per day ===");
  const byDay = db
    .prepare(
      `SELECT date(latestPublishedAt/1000,'unixepoch','localtime') d, COUNT(*) n
         FROM content_clusters WHERE latestPublishedAt >= ?
        GROUP BY d ORDER BY d`,
    )
    .all(since);
  for (const row of byDay) console.log(`${row.d}\t${row.n}`);

  // ---- 8b. Fragmentation detection ----
  // Same event fingerprint (exact signature match) split into multiple clusters.
  const fragGroups = db
    .prepare(
      `SELECT eventFingerprint, COUNT(*) n, SUM(itemCount) items, group_concat(id, '|') ids
         FROM content_clusters
        WHERE eventFingerprint IS NOT NULL AND status IN ('active','hidden') AND itemCount >= 1
          AND latestPublishedAt >= ?
        GROUP BY eventFingerprint HAVING n > 1
        ORDER BY n DESC`,
    )
    .all(since);
  console.log("\n=== fragmentation (same eventFingerprint split into multiple clusters) ===");
  const fragmentClusters = fragGroups.reduce((s: number, g: any) => s + g.n, 0);
  console.log(`groups: ${fragGroups.length}, fragment clusters: ${fragmentClusters}`);
  for (const g of fragGroups) {
    console.log(`  fp=${g.eventFingerprint.slice(0, 14)}... n=${g.n} items=${g.items}`);
  }

  // ---- 7b. Machine-readable regression metrics (--json <out>) ----
  if (args.json) {
    const recomputedStrong = aliveRows.filter((r) => !r.rejected && r.recomputedScore >= 95);
    const strongDeclined = recomputedStrong.filter((r) => r.verdict === "declined");
    const metrics = {
      schema_version: 1,
      windowDays: args.days,
      generatedAt: new Date(now).toISOString(),
      snapshot: args.db,
      verdict: {
        approved: verdictCount.get("approved") ?? 0,
        declined: verdictCount.get("declined") ?? 0,
        ambiguous: verdictCount.get("ambiguous") ?? 0,
        failed: verdictCount.get("failed") ?? 0,
      },
      ruleStrong: {
        total: recomputedStrong.length,
        declined: strongDeclined.length,
        declinedRatePct: recomputedStrong.length
          ? Number(((strongDeclined.length / recomputedStrong.length) * 100).toFixed(1))
          : 0,
      },
      fragmentation: {
        groups: fragGroups.length,
        fragmentClusters,
      },
    };
    const jsonText = `${JSON.stringify(metrics, null, 2)}\n`;
    if (args.json === "-") {
      process.stdout.write(jsonText);
    } else {
      fs.mkdirSync(path.dirname(args.json), { recursive: true });
      fs.writeFileSync(args.json, jsonText);
      console.log(`[eval] regression metrics written to ${args.json}`);
    }
  }

  // ---- 7c. Snapshot freeze (--freeze <out.json>) ----
  // Pair-level baseline of THIS snapshot: every alive pair with its recomputed
  // rule score and stored verdict. The gate replays the same snapshot against
  // this freeze to detect per-pair judgment changes without data drift.
  if (args.freeze) {
    const freezeDoc = {
      schema_version: 1,
      generatedAt: new Date(now).toISOString(),
      snapshot: args.db,
      windowDays: args.days,
      pairs: aliveRows.map((r) => ({
        key: `${r.leftClusterId}_${r.rightClusterId}`,
        score: r.recomputedScore,
        rejected: r.rejected,
        verdict: r.verdict,
      })),
    };
    const freezeText = `${JSON.stringify(freezeDoc, null, 2)}\n`;
    if (args.freeze === "-") {
      process.stdout.write(freezeText);
    } else {
      fs.mkdirSync(path.dirname(args.freeze), { recursive: true });
      fs.writeFileSync(args.freeze, freezeText);
      console.log(`[eval] snapshot freeze written to ${args.freeze} (${freezeDoc.pairs.length} pairs)`);
    }
  }

  // ---- 8. Stratified sample for labeling ----
  if (args.samples > 0) {
    // Sample from ALL decisions (alive or not) so the label set includes both
    // merged-positive and rejected-negative cases. For vanished pairs use stored
    // score; for alive pairs use recomputed score.
    const labeledPool = decisions.map((d) => {
      const score = d.existBoth ? recomputedScoreOf(d, aliveRows) : d.localScoreStored;
      return { ...d, labelScore: score };
    });
    const bucketsDef = [
      { key: "strong", pred: (_r: unknown, x: number | null) => x != null && x >= 95 },
      { key: "mid", pred: (_r: unknown, x: number | null) => x != null && x >= 70 && x < 95 },
      { key: "gray", pred: (_r: unknown, x: number | null) => x != null && x >= 55 && x < 70 },
      { key: "low", pred: (_r: unknown, x: number | null) => x != null && x < 55 },
      { key: "nullscore", pred: (_r: unknown, x: number | null) => x == null },
    ];
    const perBucket = Math.max(1, Math.floor(args.samples / bucketsDef.length));
    const sampleRows = [];
    for (const def of bucketsDef) {
      const pool = labeledPool.filter((r) => def.pred(r, r.labelScore));
      pool.sort((x, y) => hashStr(x.leftClusterId + x.rightClusterId) - hashStr(y.leftClusterId + y.rightClusterId));
      sampleRows.push(...pool.slice(0, perBucket));
    }

    const out = args.out || path.join(process.cwd(), "eval-cluster-baseline-sample.csv");
    const header = [
      "pairKey", "verdictStored", "scoreForLabel", "aExists", "bExists",
      "titleA", "titleB", "summaryA", "summaryB",
      "subjectA", "subjectB", "objectA", "objectB",
      "actionA", "actionB", "typeA", "typeB", "dateA", "dateB",
      "itemCountA", "itemCountB", "createdAt",
    ].join(",");
    const lines = sampleRows.map((r) =>
      [
        `"${r.leftClusterId}_${r.rightClusterId}"`,
        r.verdict,
        r.labelScore ?? "",
        r.aExists ? 1 : 0,
        r.bExists ? 1 : 0,
        csvField(r.titleA),
        csvField(r.titleB),
        csvField(r.summaryA),
        csvField(r.summaryB),
        csvField(r.subjectA),
        csvField(r.subjectB),
        csvField(r.objectA),
        csvField(r.objectB),
        csvField(r.actionA),
        csvField(r.actionB),
        csvField(r.typeA),
        csvField(r.typeB),
        csvField(r.dateA),
        csvField(r.dateB),
        r.itemCountA,
        r.itemCountB,
        csvField(String(r.createdAt)),
      ].join(","),
    );
    fs.writeFileSync(out, [header, ...lines].join("\n"));
    console.log(`\n[sample] wrote ${sampleRows.length} rows -> ${out}`);
    console.log("[sample] bucketed distribution:");
    for (const def of bucketsDef) {
      console.log(`  ${def.key}: ${sampleRows.filter((r) => def.pred(r, r.labelScore)).length}`);
    }
  }

  db.close();
  console.log("\n[eval] done");
}

function recomputedScoreOf(
  d: DecisionRecord,
  aliveRows: Array<{ leftClusterId: string; rightClusterId: string; recomputedScore: number }>,
) {
  const hit = aliveRows.find(
    (r) => r.leftClusterId === d.leftClusterId && r.rightClusterId === d.rightClusterId,
  );
  return hit != null ? hit.recomputedScore : d.localScoreStored;
}

function hashStr(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function csvField(v: unknown) {
  const s = String(v ?? "").replace(/"/g, '""');
  return `"${s}"`;
}

main().catch((err) => {
  console.error("[eval] failed:", err?.message ?? err);
  process.exit(1);
});
