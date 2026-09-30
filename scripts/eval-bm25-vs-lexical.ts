#!/usr/bin/env node
/** Offline replay: production BM25 module vs. the legacy merge scorer. No network or model calls. */
import fs from "node:fs";
import { performance } from "node:perf_hooks";

import { getReviewedHumanLabel } from "./eval-bm25-labels";
import { CLUSTER_MERGE_RELATED_PAIR_LIMIT } from "../src/config/constants";
import {
  buildClusterMergeBm25Index,
  CLUSTER_MERGE_BM25_SCORE_SCALE,
  scoreClusterMergeBm25Documents,
  type Bm25ClusterDocument,
} from "../src/lib/clusters/bm25";
import {
  checkClusterMergePairSafety,
  scoreClusterMergeCandidatePair,
  type ClusterMergeCandidate,
} from "../src/lib/clusters/helpers";

// @ts-expect-error node:sqlite has no type declarations in @types/node@20
import { DatabaseSync } from "node:sqlite";

type Args = {
  db: string;
  out: string;
  labels: string;
  manifest: string;
  windowDays: number;
};

type Side = {
  id: string;
  title: string;
  summary: string;
  subject: string;
  object: string;
  action: string;
  eventType: string;
  eventDate: string;
  itemCount: number;
  latestPublishedAt: number;
};

type LabeledPair = {
  key: string;
  dataset: string;
  stratum: string;
  label: "same" | "diff";
  a: Side;
  b: Side;
};

type ScoredPair = LabeledPair & {
  currentScore: number;
  currentRejected: string | null;
  bm25Score: number;
  bm25SafetyRejected: string | null;
  bm25Admitted: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    db: "docs/eval/snapshots/prod-snapshot-2026-09-21.db",
    out: "/tmp/infinitum-bm25-integrated-eval.json",
    labels: "docs/eval/bm25-hard-cases-review-2026-09-26.csv",
    manifest: "docs/eval/bm25-hard-cases-manifest-2026-09-26.json",
    windowDays: 30,
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--db") args.db = argv[++index] ?? args.db;
    else if (argv[index] === "--out") args.out = argv[++index] ?? args.out;
    else if (argv[index] === "--labels") args.labels = argv[++index] ?? args.labels;
    else if (argv[index] === "--manifest") args.manifest = argv[++index] ?? args.manifest;
    else if (argv[index] === "--window-days") args.windowDays = Number(argv[++index] ?? args.windowDays);
  }
  return args;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inQuotes) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((values) => values.some((value) => value.length > 0));
}

function csvRecords(path: string): Array<Record<string, string>> {
  const [header = [], ...rows] = parseCsv(fs.readFileSync(path, "utf8"));
  return rows.map((values) => Object.fromEntries(header.map((key, index) => [key, values[index] ?? ""])));
}

function sideFrom(row: Record<string, string>, prefix: string, id: string, fallbackMs = 0): Side {
  const field = (suffix: string, ...aliases: string[]) =>
    [
      `${prefix}${suffix}`,
      `${suffix.charAt(0).toLowerCase()}${suffix.slice(1)}${prefix}`,
      ...aliases.flatMap((alias) => [
        `${prefix}${alias}`,
        `${alias.charAt(0).toLowerCase()}${alias.slice(1)}${prefix}`,
      ]),
    ].map((key) => row[key]).find((value) => value !== undefined) ?? "";
  const date = field("LatestPublishedAt", "PublishedAt");
  const eventDate = field("EventDate", "Date");
  const parsedDate = Number(date) || Date.parse(eventDate);
  return {
    id,
    title: field("Title"),
    summary: field("Summary"),
    subject: field("EventSubject", "Subject", "Subj"),
    object: field("EventObject", "Object", "Obj"),
    action: field("EventAction", "Action"),
    eventType: field("EventType", "Type"),
    eventDate,
    itemCount: Number(field("ItemCount")) || 1,
    latestPublishedAt: Number.isFinite(parsedDate) && parsedDate > 0 ? parsedDate : fallbackMs,
  };
}

function toCandidate(side: Side): ClusterMergeCandidate {
  return {
    id: side.id,
    title: side.title,
    summary: side.summary,
    fingerprint: `eval-${side.id}`,
    eventType: side.eventType || null,
    eventSubject: side.subject || null,
    eventAction: side.action || null,
    eventObject: side.object || null,
    eventDate: side.eventDate || null,
    itemCount: side.itemCount,
    latestPublishedAt: new Date(side.latestPublishedAt || 0),
  };
}

function toBm25Document(side: Side): Bm25ClusterDocument {
  return {
    id: side.id,
    title: side.title,
    summary: side.summary,
    eventSubject: side.subject || null,
    eventObject: side.object || null,
  };
}

function loadHardCases(labelsPath: string, manifestPath: string, fallbackMs: number): { pairs: LabeledPair[]; excludedLabels: Record<string, number> } {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    cases: Array<{ caseId: string; sourceStratum: string; scoreBand?: string | null }>;
  };
  const strataByCaseId = new Map(manifest.cases.map((entry) => [entry.caseId, entry]));
  const excludedLabels: Record<string, number> = {};
  const pairs = csvRecords(labelsPath).flatMap((row) => {
    const label = getReviewedHumanLabel(row);
    if (!label) {
      const exclusion = row.reviewStatus !== "reviewed"
        ? `status:${row.reviewStatus || "empty"}`
        : !row.reviewer?.trim()
          ? "missing-reviewer"
          : `label:${row.humanLabel || "empty"}`;
      excludedLabels[exclusion] = (excludedLabels[exclusion] ?? 0) + 1;
      return [];
    }
    const metadata = strataByCaseId.get(row.caseId);
    const [leftId = `${row.caseId}:left`, rightId = `${row.caseId}:right`] = (row.pairKey ?? "").split("|");
    return [{
      key: row.caseId,
      dataset: "human-reviewed-hard-cases",
      stratum: metadata ? [metadata.sourceStratum, metadata.scoreBand].filter(Boolean).join("/") : "unstratified",
      label,
      a: sideFrom(row, "left", leftId, fallbackMs),
      b: sideFrom(row, "right", rightId, fallbackMs),
    }];
  });
  return { pairs, excludedLabels };
}

function loadOvermerge(path: string, fallbackMs: number): LabeledPair[] {
  return csvRecords(path)
    .filter((row) => (row.label === "same" || row.label === "diff") && row.titleA && row.titleB)
    .map((row) => ({
      key: row.pairKey,
      dataset: "production-overmerge",
      stratum: row.label,
      label: row.label as "same" | "diff",
      a: sideFrom(row, "A", row.clusterId || `${row.pairKey}:A`, fallbackMs),
      b: sideFrom(row, "B", `${row.pairKey}:B`, fallbackMs),
    }));
}

function loadBelowGray(path: string, fallbackMs: number): LabeledPair[] {
  return csvRecords(path)
    .filter((row) => (row.aiLabel === "yes" || row.aiLabel === "no") && row.titleA && row.titleB)
    .map((row) => {
      const [aId = `${row.pairKey}:A`, bId = `${row.pairKey}:B`] = row.pairKey.split("|");
      return {
        key: row.pairKey,
        dataset: "below-gray-truth",
        stratum: row.stratum || "below-gray",
        label: row.aiLabel === "yes" ? ("same" as const) : ("diff" as const),
        a: sideFrom(row, "A", aId, fallbackMs),
        b: sideFrom(row, "B", bId, fallbackMs),
      };
    });
}

function loadEvalSample(path: string, fallbackMs: number): LabeledPair[] {
  return csvRecords(path)
    .filter((row) => (row.verdictStored === "approved" || row.verdictStored === "declined") && row.titleA && row.titleB)
    .map((row) => {
      const [aId = `${row.pairKey}:A`, bId = `${row.pairKey}:B`] = row.pairKey.split("_");
      return {
        key: row.pairKey,
        dataset: "eval-sample-30d",
        stratum: row.verdictStored,
        label: row.verdictStored === "approved" ? "same" as const : "diff" as const,
        a: sideFrom(row, "A", aId, fallbackMs),
        b: sideFrom(row, "B", bId, fallbackMs),
      };
    });
}

function loadCorpus(dbPath: string, windowDays: number): { documents: Bm25ClusterDocument[]; anchorMs: number } {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const anchor = db.prepare("SELECT MAX(latestPublishedAt) AS maxTs FROM content_clusters WHERE status = 'active'").get() as { maxTs: number | null };
    const anchorMs = anchor.maxTs ?? Date.now();
    const rows = db.prepare(
      `SELECT id, title, summary, eventSubject, eventObject FROM content_clusters
       WHERE status = 'active' AND latestPublishedAt >= ?`,
    ).all(anchorMs - windowDays * 24 * 60 * 60 * 1000) as Array<Record<string, unknown>>;
    return {
      anchorMs,
      documents: rows.map((row) => ({
        id: String(row.id),
        title: String(row.title ?? ""),
        summary: String(row.summary ?? ""),
        eventSubject: typeof row.eventSubject === "string" ? row.eventSubject : null,
        eventObject: typeof row.eventObject === "string" ? row.eventObject : null,
      })),
    };
  } finally {
    db.close();
  }
}

function auc(same: number[], diff: number[]): number {
  if (same.length === 0 || diff.length === 0) return Number.NaN;
  let wins = 0;
  let ties = 0;
  for (const sameScore of same) {
    for (const diffScore of diff) {
      if (sameScore > diffScore) wins += 1;
      else if (sameScore === diffScore) ties += 1;
    }
  }
  return (wins + ties / 2) / (same.length * diff.length);
}

function recallAtFpr(same: number[], diff: number[], fpr: number): number {
  if (same.length === 0 || diff.length === 0) return Number.NaN;
  const sorted = [...diff].sort((a, b) => b - a);
  const threshold = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fpr))]!;
  return same.filter((score) => score >= threshold).length / same.length * 100;
}

function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function metrics(rows: ScoredPair[], scoreOf: (row: ScoredPair) => number) {
  const same = rows.filter((row) => row.label === "same").map(scoreOf);
  const diff = rows.filter((row) => row.label === "diff").map(scoreOf);
  return {
    pairs: rows.length,
    same: same.length,
    diff: diff.length,
    auc: Number(auc(same, diff).toFixed(4)),
    medianSame: Number(median(same).toFixed(3)),
    medianDiff: Number(median(diff).toFixed(3)),
    recallAtFpr1: Number(recallAtFpr(same, diff, 0.01).toFixed(1)),
    recallAtFpr5: Number(recallAtFpr(same, diff, 0.05).toFixed(1)),
    recallAtFpr10: Number(recallAtFpr(same, diff, 0.1).toFixed(1)),
  };
}

function candidateCounts(rows: ScoredPair[], scorer: "current" | "bm25") {
  const byLeft = new Map<string, ScoredPair[]>();
  for (const row of rows) {
    const group = byLeft.get(row.a.id) ?? [];
    group.push(row);
    byLeft.set(row.a.id, group);
  }

  let admittedPairs = 0;
  let selectedWithinTopK = 0;
  let groupsWithCandidates = 0;
  for (const group of byLeft.values()) {
    const eligible = scorer === "bm25"
      ? group.filter((row) => row.bm25Admitted)
      : (() => {
        const related = group.filter((row) => !row.currentRejected && row.currentScore >= 55);
        return related.filter((row) => row.currentScore >= 70 || (row.currentScore >= 55 && related.length <= 2));
      })();
    admittedPairs += eligible.length;
    if (eligible.length > 0) groupsWithCandidates += 1;
    selectedWithinTopK += Math.min(CLUSTER_MERGE_RELATED_PAIR_LIMIT, eligible.length);
  }
  return {
    admittedPairs,
    selectedWithinTopK,
    topK: CLUSTER_MERGE_RELATED_PAIR_LIMIT,
    groupsWithCandidates,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const input of [args.db, args.labels, args.manifest, "docs/eval/production-overmerge-2026-09-23.csv", "docs/eval/below-gray-truth-2026-09-19.csv", "docs/eval/eval-sample-30d.csv"]) {
    if (!fs.existsSync(input)) throw new Error(`missing input: ${input}`);
  }

  const { documents, anchorMs } = loadCorpus(args.db, args.windowDays);
  const indexStartedAt = performance.now();
  const index = buildClusterMergeBm25Index(documents);
  const indexBuildMs = Number((performance.now() - indexStartedAt).toFixed(2));
  const hardCases = loadHardCases(args.labels, args.manifest, anchorMs);
  const datasets = [
    { name: "human-reviewed-hard-cases", pairs: hardCases.pairs },
    { name: "production-overmerge", pairs: loadOvermerge("docs/eval/production-overmerge-2026-09-23.csv", anchorMs) },
    { name: "below-gray-truth", pairs: loadBelowGray("docs/eval/below-gray-truth-2026-09-19.csv", anchorMs) },
    { name: "eval-sample-30d", pairs: loadEvalSample("docs/eval/eval-sample-30d.csv", anchorMs) },
  ];
  const scoringStartedAt = performance.now();
  const summaries: Record<string, unknown> = {};
  const allRows: ScoredPair[] = [];

  for (const dataset of datasets) {
    const scored = dataset.pairs.map((pair): ScoredPair => {
      const left = toCandidate(pair.a);
      const right = toCandidate(pair.b);
      const current = scoreClusterMergeCandidatePair(left, right);
      const safety = checkClusterMergePairSafety(left, right);
      const bm25Score = scoreClusterMergeBm25Documents(index, toBm25Document(pair.a), toBm25Document(pair.b));
      return {
        ...pair,
        currentScore: current.score,
        currentRejected: current.rejectedReason,
        bm25Score,
        bm25SafetyRejected: safety.rejectedReason,
        bm25Admitted: !safety.rejected && bm25Score > 0,
      };
    });
    allRows.push(...scored);
    const strata: Record<string, ReturnType<typeof metrics>> = {};
    for (const stratum of new Set(scored.map((row) => row.stratum))) {
      strata[stratum] = metrics(scored.filter((row) => row.stratum === stratum), (row) => row.bm25Score);
    }
    summaries[dataset.name] = {
      current: metrics(scored, (row) => row.currentRejected ? -1e9 : row.currentScore),
      bm25: metrics(scored, (row) => row.bm25Score),
      candidateCounts: {
        current: candidateCounts(scored, "current"),
        bm25: candidateCounts(scored, "bm25"),
      },
      strata,
    };
  }
  const scoringMs = Number((performance.now() - scoringStartedAt).toFixed(2));
  const result = {
    generatedAt: new Date().toISOString(),
    inputs: { db: args.db, labels: args.labels, manifest: args.manifest },
    corpus: {
      clusterCount: index.docCount,
      windowDays: args.windowDays,
      anchorLatestPublishedAt: new Date(anchorMs).toISOString(),
      averageDocumentLength: Number(index.averageDocumentLength.toFixed(2)),
      indexBuildMs,
      scoringMs,
    },
    excludedHumanLabels: hardCases.excludedLabels,
    candidateCountNote: `Admission and top-K counts are measured only within each labeled slice; top-K=${CLUSTER_MERGE_RELATED_PAIR_LIMIT} per left-side group. They are not a production-distribution estimate.`,
    bm25: { k1: 1.2, b: 0.75, pair: `symmetric mean; binary term presence; production scorer fixed-point ×${CLUSTER_MERGE_BM25_SCORE_SCALE}` },
    summary: summaries,
    pairs: allRows,
  };
  fs.writeFileSync(args.out, JSON.stringify(result, null, 2));
  console.log(`[bm25-replay] corpus=${index.docCount} avgDocLen=${index.averageDocumentLength.toFixed(1)} index=${indexBuildMs}ms scoring=${scoringMs}ms`);
  for (const dataset of datasets) {
    const summary = summaries[dataset.name] as { current: { auc: number }; bm25: { auc: number }; candidateCounts: { current: { admittedPairs: number; selectedWithinTopK: number }; bm25: { admittedPairs: number; selectedWithinTopK: number } } };
    console.log(`[${dataset.name}] pairs=${dataset.pairs.length} currentAUC=${summary.current.auc} bm25AUC=${summary.bm25.auc} admissions=${summary.candidateCounts.current.admittedPairs}->${summary.candidateCounts.bm25.admittedPairs} topK=${summary.candidateCounts.current.selectedWithinTopK}->${summary.candidateCounts.bm25.selectedWithinTopK}`);
  }
  console.log(`[bm25-replay] excluded human labels=${JSON.stringify(hardCases.excludedLabels)} output=${args.out}`);
}

main().catch((error: unknown) => {
  console.error("[bm25-replay] failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
