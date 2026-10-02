#!/usr/bin/env node
/**
 * Snapshot counterfactual baseline for the CURRENT production rule-based
 * cluster-merge candidate selector (stage:
 * production_candidate_selector_snapshot_counterfactual).
 *
 * This is NOT a historical full online replay and NOT a final-merge evaluation:
 * it rebuilds the production corpus window from a frozen read-only snapshot DB,
 * runs the real pure helper buildClusterMergeCandidateSelection once over the
 * full corpus with the reviewed endpoints forced live, and reports which
 * human-labeled same/diff pairs were admitted as merge CANDIDATES.
 *
 * Vector recall channel is disabled and reported as not_measured. No AI, no
 * network, no DB writes; the snapshot is opened readOnly and re-checksummed
 * after the run.
 *
 * Exit codes: 0 = diagnostic complete, 1 = invalid input, 2 = diagnostic
 * incomplete (expected evaluation-coverage insufficiency, not a crash).
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// node:sqlite ships in Node 22+/25+; @types/node@20 has no declarations for it.
// @ts-expect-error node:sqlite has no type declarations in @types/node@20
import { DatabaseSync } from "node:sqlite";

import {
  CLUSTER_MERGE_CANDIDATE_LIMIT,
  CLUSTER_MERGE_RELATED_PAIR_LIMIT,
  CLUSTER_MERGE_SCAN_CLUSTER_LIMIT,
} from "@/config/constants";
import {
  buildClusterMergeBm25Index,
  scoreClusterMergeBm25Pair,
} from "@/lib/clusters/bm25";
import {
  buildClusterMergeCandidateSelection,
  checkClusterMergePairSafety,
  type ClusterMergeCandidate,
  type ClusterMergeCandidateDiagnostics,
} from "@/lib/clusters/helpers";
import {
  BLIND_COLUMNS,
  InvalidInputError,
  canonicalInputSha,
  loadCsvTable,
  sha256File,
  validateFrozenManifest,
} from "./eval-cluster-quality-review";

export const EXIT_OK = 0;
export const EXIT_INVALID_INPUT = 1;
export const EXIT_DIAGNOSTIC_INCOMPLETE = 2;

export const STAGE = "production_candidate_selector_snapshot_counterfactual";
const CLUSTER_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export type ClusterRow = {
  id: string;
  title: string;
  summary: string | null;
  itemCount: number;
  latestPublishedAt: number;
  status: string;
  eventType: string | null;
  eventSubject: string | null;
  eventAction: string | null;
  eventObject: string | null;
  eventDate: string | null;
  eventFingerprint: string | null;
  fingerprint: string | null;
  mergeInputHash: string | null;
  updatedAt: number;
};

export type FrozenCaseInput = {
  caseId: string;
  split: "dev" | "holdout";
  inputSha256: string;
  /** Unordered: frozen manifest clusterIds are NOT a left/right direction. */
  clusterIdsUnordered: [string, string];
};

export type FrozenInput = {
  snapshotSha256: string;
  samplingManifestSha256: string;
  cases: FrozenCaseInput[];
};

export type SamplingCase = {
  caseId: string;
  leftClusterId: string;
  rightClusterId: string;
  sourceStratum: string;
};

export type SamplingManifest = { cases: SamplingCase[] };

/**
 * Aggregate sampling strata from the frozen sampling manifest cases. Cases with
 * a missing/empty sourceStratum are reported as "unknown" — never inferred into
 * a human-truth stratum. The report note must reflect whatever the manifest
 * actually contains (old 36-case and new 24-case packets both render faithfully).
 */
export function summarizeSamplingStrata(cases: Array<{ sourceStratum?: string }>): Array<{ stratum: string; count: number }> {
  const counts = new Map<string, number>();
  for (const c of cases) {
    const stratum = c.sourceStratum?.trim() ? c.sourceStratum.trim() : "unknown";
    counts.set(stratum, (counts.get(stratum) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([stratum, count]) => ({ stratum, count }))
    .sort((a, b) => a.stratum.localeCompare(b.stratum));
}

/** Minimal DB handle interface so tests can inject a temp sqlite instance. */
export type SqliteHandle = {
  prepare(sql: string): { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] };
};

const CLUSTER_SELECT_COLUMNS = `id, title, summary, itemCount, latestPublishedAt, status, eventType,
  eventSubject, eventAction, eventObject, eventDate, eventFingerprint, fingerprint, mergeInputHash, updatedAt`;

export function toClusterMergeCandidate(row: ClusterRow): ClusterMergeCandidate {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary ?? "",
    fingerprint: row.fingerprint ?? "",
    mergeInputHash: row.mergeInputHash,
    eventFingerprint: row.eventFingerprint,
    eventType: row.eventType,
    eventSubject: row.eventSubject,
    eventAction: row.eventAction,
    eventObject: row.eventObject,
    eventDate: row.eventDate,
    itemCount: row.itemCount,
    latestPublishedAt: new Date(row.latestPublishedAt),
  };
}

/**
 * Strict SQLite translation of the production loadRecentMergeClusters window:
 * status=active, latestPublishedAt >= lookbackSince, production order-by and
 * scan cap. When the items/sources tables exist the production EXISTS filter
 * (items processed/allowed|restored, source.aggregationEnabled OR
 * parentItemId) is enforced literally; when the tables are missing the caller
 * must report the filter as unavailable_missing_tables — never a silent loose
 * fallback. Missing schema columns are a hard invalid-input error.
 */
export function selectProductionCorpus(
  db: SqliteHandle,
  lookbackSinceMs: number,
): { corpus: ClusterRow[]; missingTables: string[]; itemsSourceFilter: string } {
  const tables = (db.prepare("select name from sqlite_master where type='table'").all() as Array<{ name: string }>).map(
    (t) => t.name,
  );
  const missingTables = ["items", "sources"].filter((name) => !tables.includes(name));
  const clusterColumns = (
    db.prepare("select name from pragma_table_info('content_clusters')").all() as Array<{ name: string }>
  ).map((c) => c.name);
  const requiredColumns = [
    "id", "title", "summary", "itemCount", "latestPublishedAt", "status", "eventType", "eventSubject",
    "eventAction", "eventObject", "eventDate", "eventFingerprint", "fingerprint", "mergeInputHash", "updatedAt",
  ];
  const missingColumns = requiredColumns.filter((c) => !clusterColumns.includes(c));
  if (missingColumns.length > 0) {
    throw new InvalidInputError(
      `snapshot content_clusters missing required columns (no loose defaults): ${missingColumns.join(", ")}`,
    );
  }
  let itemsSourceFilter: string;
  let itemsExistsClause = "";
  if (missingTables.length === 0) {
    const itemsColumns = (db.prepare("select name from pragma_table_info('items')").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    const sourcesColumns = (
      db.prepare("select name from pragma_table_info('sources')").all() as Array<{ name: string }>
    ).map((c) => c.name);
    const missingJoinColumns = [
      ...["id", "clusterId", "status", "moderationStatus", "parentItemId", "sourceId"].filter(
        (c) => !itemsColumns.includes(c),
      ),
      ...["id", "aggregationEnabled"].filter((c) => !sourcesColumns.includes(c)),
    ];
    if (missingJoinColumns.length > 0) {
      throw new InvalidInputError(
        `snapshot items/sources missing required columns (no loose defaults): ${missingJoinColumns.join(", ")}`,
      );
    }
    itemsExistsClause = `
       AND EXISTS (
         SELECT 1 FROM items
         JOIN sources ON items.sourceId = sources.id
         WHERE items.clusterId = content_clusters.id
           AND items.status = 'processed'
           AND items.moderationStatus IN ('allowed', 'restored')
           AND (sources.aggregationEnabled = 1 OR items.parentItemId IS NOT NULL)
       )`;
    itemsSourceFilter = "enforced_production_exists_filter";
  } else {
    itemsSourceFilter = `unavailable_missing_tables:${missingTables.join(",")}`;
  }
  const corpus = db
    .prepare(
      `SELECT ${CLUSTER_SELECT_COLUMNS}
       FROM content_clusters
       WHERE status = 'active' AND latestPublishedAt >= ?${itemsExistsClause}
       ORDER BY latestPublishedAt DESC, updatedAt DESC, itemCount DESC, id ASC
       LIMIT ?`,
    )
    .all(lookbackSinceMs, CLUSTER_MERGE_SCAN_CLUSTER_LIMIT) as unknown as ClusterRow[];
  return { corpus, missingTables, itemsSourceFilter };
}

export function loadClustersById(db: SqliteHandle): Map<string, ClusterRow> {
  const rows = db.prepare(`SELECT ${CLUSTER_SELECT_COLUMNS} FROM content_clusters`).all() as unknown as ClusterRow[];
  return new Map(rows.map((row) => [row.id, row]));
}

/** asOf is fixed from the snapshot, never Date.now. */
export function snapshotAsOfMs(db: SqliteHandle): number {
  const row = db
    .prepare("SELECT MAX(latestPublishedAt) AS m FROM content_clusters WHERE status = 'active'")
    .get() as { m: number | null } | undefined;
  if (!row || row.m === null || !Number.isFinite(row.m)) {
    throw new InvalidInputError("snapshot has no active clusters; cannot fix asOf from MAX(latestPublishedAt)");
  }

  return row.m;
}

export type AsOfBasis = "snapshot_active_max_latestPublishedAt" | "capture_utc_explicit";

/**
 * Pure asOf resolution. Default keeps the legacy snapshot MAX(latestPublishedAt)
 * anchor for old packets. An explicit --as-of must parse as a valid timestamp
 * and be semantically equal (same instant) to the frozen-manifest asOf; a
 * capture-time asOf newer than the snapshot MAX is allowed and expected for
 * fresh packets. Returns { ms, basis }; never consults Date.now.
 */
export function chooseAsOf(args: {
  explicit?: string;
  frozenAsOf?: string;
  snapshotMaxMs: number;
}): { ms: number; basis: AsOfBasis } {
  if (args.explicit === undefined || args.explicit === "") {
    return { ms: args.snapshotMaxMs, basis: "snapshot_active_max_latestPublishedAt" };
  }
  const ms = Date.parse(args.explicit);
  if (!Number.isFinite(ms)) {
    throw new InvalidInputError(`--as-of is not a valid timestamp: ${args.explicit}`);
  }
  if (args.frozenAsOf && args.frozenAsOf !== "unknown") {
    const frozenMs = Date.parse(args.frozenAsOf);
    if (!Number.isFinite(frozenMs)) {
      throw new InvalidInputError(`frozen manifest asOf is not a valid timestamp: ${args.frozenAsOf}`);
    }
    if (frozenMs !== ms) {
      throw new InvalidInputError(
        `--as-of must equal the frozen manifest asOf (semantically): as-of ${new Date(ms).toISOString()}, frozen ${new Date(frozenMs).toISOString()}`,
      );
    }
  }
  return { ms, basis: "capture_utc_explicit" };
}

function normalizeEventDateForCompare(value: string): string {
  const match = value.trim().match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (!match) return value.trim();
  return `${match[1]}-${match[2]!.padStart(2, "0")}-${match[3]!.padStart(2, "0")}`;
}

function textEq(a: string, b: string | null | undefined): boolean {
  return (a ?? "").trim() === (b ?? "").trim();
}

const SIDE_PREFIXES = ["left", "right"] as const;

/**
 * Field-level verification of the human-frozen CSV inputs against the snapshot
 * cluster rows, mapped through the sampling-manifest left/right direction
 * (frozen clusterIds are unordered and must not be used for direction). Drift
 * only yields field names for the stale_field_not_reconstructed exclusion; the
 * human input is never replaced by newer DB values.
 */
export function verifyCaseFields(
  csvRow: Record<string, string>,
  sampling: SamplingCase,
  clustersById: Map<string, ClusterRow>,
): { driftFields: string[]; missingIds: string[]; inactiveIds: string[] } {
  const driftFields: string[] = [];
  const missingIds: string[] = [];
  const inactiveIds: string[] = [];
  for (const prefix of SIDE_PREFIXES) {
    const clusterId = prefix === "left" ? sampling.leftClusterId : sampling.rightClusterId;
    const row = clustersById.get(clusterId);
    if (!row) {
      missingIds.push(clusterId);
      continue;
    }
    if (row.status !== "active") inactiveIds.push(clusterId);
    const side = (field: string) => csvRow[`${prefix}${field}`] ?? "";
    const checks: Array<[string, boolean]> = [
      ["Title", textEq(side("Title"), row.title)],
      ["Summary", textEq(side("Summary"), row.summary)],
      ["EventType", textEq(side("EventType"), row.eventType)],
      ["EventSubject", textEq(side("EventSubject"), row.eventSubject)],
      ["EventAction", textEq(side("EventAction"), row.eventAction)],
      ["EventObject", textEq(side("EventObject"), row.eventObject)],
      [
        "EventDate",
        normalizeEventDateForCompare(side("EventDate")) === normalizeEventDateForCompare(row.eventDate ?? ""),
      ],
      ["ItemCount", Number(side("ItemCount")) === row.itemCount],
      ["LatestPublishedAt", Number(side("LatestPublishedAt")) === row.latestPublishedAt],
    ];
    for (const [field, ok] of checks) {
      if (!ok) driftFields.push(`${prefix}${field}`);
    }
  }
  return { driftFields, missingIds, inactiveIds };
}

export type CaseOutcome = {
  caseId: string;
  split: "dev" | "holdout";
  sourceStratum: string;
  humanLabel: "same" | "diff";
  eligibility: "eligible" | "excluded";
  excludedReason?:
    | "missing_cluster_id"
    | "inactive_cluster"
    | "out_of_lookback_window"
    | "stale_field_not_reconstructed"
    | "scan_cap_excluded"
    | "invalid_or_unreviewed_or_uncertain"
    | "no_eligible_items_not_evaluable";
  fieldDrift?: string[];
  admitted: boolean | null;
  rejectionReason?: string;
};

export type SplitBaselineMetrics = {
  aggregationOnly: boolean;
  eligible: number;
  same: { total: number; admitted: number; notAdmitted: number };
  diff: { total: number; admitted: number; notAdmitted: number };
  sameEventCandidateAdmissionRecall: number | null;
  differentEventCandidateAdmissionRate: number | null;
};

/** Excluded and uncertain cases are never negative-correct or missed-recall; denominators are eligible-only. */
export function computeSplitMetrics(outcomes: CaseOutcome[], split: "dev" | "holdout"): SplitBaselineMetrics {
  const inSplit = outcomes.filter((o) => o.split === split && o.eligibility === "eligible");
  const same = { total: 0, admitted: 0, notAdmitted: 0 };
  const diff = { total: 0, admitted: 0, notAdmitted: 0 };
  for (const o of inSplit) {
    const bucket = o.humanLabel === "same" ? same : diff;
    bucket.total += 1;
    if (o.admitted) bucket.admitted += 1;
    else bucket.notAdmitted += 1;
  }
  return {
    aggregationOnly: split === "holdout",
    eligible: inSplit.length,
    same,
    diff,
    sameEventCandidateAdmissionRecall: same.total === 0 ? null : same.admitted / same.total,
    differentEventCandidateAdmissionRate: diff.total === 0 ? null : diff.admitted / diff.total,
  };
}

function edgeConnects(edge: { leftId: string; rightId: string }, a: string, b: string): boolean {
  return (edge.leftId === a && edge.rightId === b) || (edge.leftId === b && edge.rightId === a);
}

/**
 * Evidence-based rejection classification for a not-admitted dev pair: real
 * safety check and real BM25 score over the full-corpus index. There is no
 * production instrumentation for scan membership or related-rank position, so
 * beyond the concrete evidence categories below the fallback is the generic
 * not_selected_with_available_diagnostics — never a guessed reason.
 */
export function classifyRejection(
  left: ClusterMergeCandidate,
  right: ClusterMergeCandidate,
  bm25Index: ReturnType<typeof buildClusterMergeBm25Index>,
  liveClusterIds: Set<string>,
): string {
  const safety = checkClusterMergePairSafety(left, right);
  if (safety.rejected) return `safety_rejected:${safety.rejectedReason}`;
  const bm25Score = scoreClusterMergeBm25Pair(bm25Index, left.id, right.id);
  if (bm25Score <= 0) return "bm25_zero";
  const bothClean = !liveClusterIds.has(left.id) && !liveClusterIds.has(right.id);
  const sameFingerprint = Boolean(left.eventFingerprint) && left.eventFingerprint === right.eventFingerprint;
  if (bothClean && !sameFingerprint) return "clean_pair_not_scanned";
  return "not_selected_with_available_diagnostics";
}

export type SourceVersionFreeze = { gitHead: string; sourceCode: Record<string, string> };

export function collectSourceVersionFreeze(scriptPath = fileURLToPath(import.meta.url), repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")): SourceVersionFreeze {
  const sourceCode: Record<string, string> = {};
  for (const rel of [
    "src/lib/clusters/helpers.ts",
    "src/lib/clusters/bm25.ts",
    "src/config/constants.ts",
    "scripts/eval-cluster-quality-baseline.ts",
  ]) {
    const abs = rel === "scripts/eval-cluster-quality-baseline.ts" ? scriptPath : path.join(repoRoot, rel);
    sourceCode[rel] = fs.existsSync(abs) ? sha256File(abs) : "missing";
  }
  let gitHead = "unknown";
  try {
    gitHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    gitHead = "unknown";
  }
  return { gitHead, sourceCode };
}

/**
 * Canonical corpus fingerprint: every candidate's full fields in production
 * query order (index-based, no re-sorting that could mask order differences).
 */
export function fingerprintCorpus(corpus: ClusterRow[]): string {
  return createHash("sha256").update(JSON.stringify(corpus), "utf8").digest("hex");
}

export type DigestProvenance = {
  snapshotSha256: string;
  frozenManifestSha256: string;
  samplingManifestSha256: string;
  labelsCsvSha256: string;
  corpusFingerprint: string;
};

export type DigestScenario = {
  asOfMs: number;
  asOfBasis: "snapshot_active_max_latestPublishedAt" | "capture_utc_explicit";
  lookbackSinceMs: number;
  scanClusterLimit: number;
  candidateLimit: number;
  relatedPairLimit: number;
  liveClusterIds: string[];
  vectorMode: string;
  missingTables: string[];
  itemsSourceFilter: string;
};

/** Canonical stable digest: all evaluation-influencing inputs; no timestamps, no timing. */
export function buildStableDecisionDigest(input: {
  provenance: DigestProvenance;
  scenario: DigestScenario;
  outcomes: CaseOutcome[];
  metrics: { dev: SplitBaselineMetrics; holdout: SplitBaselineMetrics };
  sourceVersion: SourceVersionFreeze;
}): string {
  const canonical = {
    stage: STAGE,
    provenance: input.provenance,
    scenario: { ...input.scenario, liveClusterIds: [...input.scenario.liveClusterIds].sort() },
    outcomes: [...input.outcomes]
      .sort((a, b) => (a.caseId < b.caseId ? -1 : 1))
      .map((o) => ({
        caseId: o.caseId,
        split: o.split,
        humanLabel: o.humanLabel,
        eligibility: o.eligibility,
        excludedReason: o.excludedReason ?? null,
        fieldDrift: o.fieldDrift ?? null,
        admitted: o.admitted,
        rejectionReason: o.rejectionReason ?? null,
      })),
    metrics: input.metrics,
    sourceVersion: input.sourceVersion,
  };
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

export type BaselineReport = {
  schemaVersion: 1;
  stage: typeof STAGE;
  status: "diagnostic_incomplete" | "diagnostic_complete";
  releaseEligible: false;
  notMeasured: {
    aiCalls: "not_measured";
    aiTokens: "not_measured";
    modelCost: "not_measured";
    aiLatency: "not_measured";
    vectorRecallChannel: "disabled_not_measured";
  };
  scenarioFaithfulness: {
    asOfBasis: DigestScenario["asOfBasis"];
    lookbackDays: 7;
    scanClusterLimit: number;
    candidateLimit: number;
    relatedPairLimit: number;
    liveEndpoints: "counterfactual_reviewed_endpoints_live";
    corpusSize: number;
    liveClusterIdCount: number;
    missingTables: string[];
    itemsSourceFilter: string;
    samplingBiasNote: string;
    stageBoundaryNote: string;
  };
  inputs: {
    frozenManifestSha256: string;
    snapshotSha256: string;
    samplingManifestSha256: string;
    labelsCsvSha256: string;
    corpusFingerprint: string;
    snapshotUnchangedAfterRun: boolean;
    sourceVersion: SourceVersionFreeze;
  };
  coverage: {
    total: number;
    eligible: number;
    uncertain: number;
    invalid: string[];
    snapshotFieldComparison: {
      comparedCases: number;
      notComparedCases: number;
      note: string;
    };
    exclusions: Array<{ reason: string; count: number; caseIds: string[] }>;
    bySplit: Record<"dev" | "holdout", { total: number; eligible: number }>;
  };
  metrics: { dev: SplitBaselineMetrics; holdout: SplitBaselineMetrics };
  devRejectionReasons: Array<{ caseId: string; reason: string }>;
  diagnostics: ClusterMergeCandidateDiagnostics;
  stableDecisionDigest: string;
  offlineRuntimeMs: number;
};

export type BaselineInputs = {
  frozen: FrozenInput;
  frozenManifestShaActual: string;
  labelsRows: Array<Record<string, string>>;
  labelsCsvSha256: string;
  sampling: SamplingManifest;
  samplingManifestShaActual: string;
  snapshotShaActual: string;
  snapshotUnchangedAfterRun: boolean;
  corpus: ClusterRow[];
  clustersById: Map<string, ClusterRow>;
  asOfMs: number;
  asOfBasis: DigestScenario["asOfBasis"];
  lookbackSinceMs: number;
  missingTables: string[];
  itemsSourceFilter: string;
  sourceVersion: SourceVersionFreeze;
};

/**
 * Pure core: all verification and scoring on injected data classes; only the
 * CLI wrapper touches the filesystem.
 */
export function assessBaseline(input: BaselineInputs): { status: BaselineReport["status"]; report: BaselineReport; outcomes: CaseOutcome[] } {
  const invalid: string[] = [];
  if (input.snapshotShaActual !== input.frozen.snapshotSha256) {
    throw new InvalidInputError(`snapshot sha mismatch: frozen ${input.frozen.snapshotSha256}, actual ${input.snapshotShaActual}`);
  }
  if (input.samplingManifestShaActual !== input.frozen.samplingManifestSha256) {
    throw new InvalidInputError(
      `sampling manifest sha mismatch: pinned ${input.frozen.samplingManifestSha256}, actual ${input.samplingManifestShaActual}`,
    );
  }

  const frozenById = new Map(input.frozen.cases.map((c) => [c.caseId, c]));
  const samplingById = new Map(input.sampling.cases.map((c) => [c.caseId, c]));
  for (const c of input.frozen.cases) {
    const s = samplingById.get(c.caseId);
    if (!s) throw new InvalidInputError(`sampling manifest missing frozen case ${c.caseId}`);
    if (!c.clusterIdsUnordered.includes(s.leftClusterId) || !c.clusterIdsUnordered.includes(s.rightClusterId)) {
      throw new InvalidInputError(`sampling direction ids not in frozen clusterIds for ${c.caseId}`);
    }
  }

  // Frozen input checksums + reviewed identity/time, strict, before scoring.
  const seen = new Set<string>();
  const labelsById = new Map<string, Record<string, string>>();
  for (const row of input.labelsRows) {
    if (!frozenById.has(row.caseId)) {
      invalid.push(`unknown case in labels: ${row.caseId}`);
      continue;
    }
    if (seen.has(row.caseId)) {
      invalid.push(`duplicate case in labels: ${row.caseId}`);
      continue;
    }
    seen.add(row.caseId);
    labelsById.set(row.caseId, row);
    if (canonicalInputSha(row.caseId, row) !== frozenById.get(row.caseId)!.inputSha256) {
      invalid.push(`case ${row.caseId}: input checksum mismatch`);
    }
  }
  for (const c of input.frozen.cases) {
    if (!labelsById.has(c.caseId)) invalid.push(`missing case in labels: ${c.caseId}`);
  }
  for (const [caseId, row] of labelsById) {
    if (row.reviewStatus !== "reviewed") invalid.push(`case ${caseId}: reviewStatus must be reviewed`);
    if (!row.reviewer?.trim()) invalid.push(`case ${caseId}: reviewer missing`);
    if (!Number.isFinite(Date.parse(row.reviewedAt ?? ""))) invalid.push(`case ${caseId}: reviewedAt unparseable`);
    if (row.humanLabel !== "same" && row.humanLabel !== "diff" && row.humanLabel !== "uncertain") {
      invalid.push(`case ${caseId}: humanLabel must be same|diff|uncertain`);
    }
  }

  const corpusIds = new Set(input.corpus.map((row) => row.id));
  const corpusCandidates = input.corpus.map(toClusterMergeCandidate);

  // Phase 1: eligibility over all 36 inputs; excluded cases are reported per
  // reason and never enter the metric denominators.
  type Pending = { caseId: string; split: "dev" | "holdout"; label: "same" | "diff"; leftId: string; rightId: string };
  const pending: Pending[] = [];
  const outcomes: CaseOutcome[] = [];
  const exclusionCases = new Map<string, string[]>();
  const recordExclusion = (reason: string, caseId: string) => {
    const list = exclusionCases.get(reason) ?? [];
    list.push(caseId);
    exclusionCases.set(reason, list);
  };
  const caseInvalid = (caseId: string) =>
    invalid.some((msg) => msg === `case ${caseId}: input checksum mismatch` || msg.startsWith(`case ${caseId}: `));
  // Snapshot field comparison is only performed for cases that pass the
  // cluster-presence and window checks; cases excluded earlier are NOT
  // field-compared and must never be reported as "no drift".
  let fieldComparedCases = 0;
  for (const c of input.frozen.cases) {
    const row = labelsById.get(c.caseId);
    const s = samplingById.get(c.caseId)!;
    const label: "same" | "diff" = row?.humanLabel === "same" ? "same" : "diff";
    const base: CaseOutcome = {
      caseId: c.caseId,
      split: c.split,
      sourceStratum: s.sourceStratum,
      humanLabel: label,
      eligibility: "excluded",
      admitted: null,
    };
    if (!row || row.humanLabel === "uncertain" || caseInvalid(c.caseId)) {
      recordExclusion("invalid_or_unreviewed_or_uncertain", c.caseId);
      outcomes.push({ ...base, excludedReason: "invalid_or_unreviewed_or_uncertain" });
      continue;
    }
    const sideRows = [s.leftClusterId, s.rightClusterId].map((id) => input.clustersById.get(id));
    const missingIds = sideRows.filter((r) => !r).map((_, i) => [s.leftClusterId, s.rightClusterId][i]!);
    const inactiveIds = sideRows.filter((r) => r && r.status !== "active").map((r) => r!.id);
    const inWindow = sideRows.every((r) => r && r.latestPublishedAt >= input.lookbackSinceMs);
    const inCorpus = [s.leftClusterId, s.rightClusterId].every((id) => corpusIds.has(id));
    const outcome: CaseOutcome = { ...base };
    if (missingIds.length > 0) {
      outcome.excludedReason = "missing_cluster_id";
    } else if (inactiveIds.length > 0) {
      outcome.excludedReason = "inactive_cluster";
    } else if (!inWindow) {
      outcome.excludedReason = "out_of_lookback_window";
    } else {
      // Only in-window cases reach the snapshot field comparison.
      const v = verifyCaseFields(row!, s, input.clustersById);
      fieldComparedCases += 1;
      if (v.driftFields.length > 0) {
        outcome.excludedReason = "stale_field_not_reconstructed";
        outcome.fieldDrift = v.driftFields;
      } else if (!inCorpus) {
        outcome.excludedReason = "scan_cap_excluded";
      } else {
        outcome.eligibility = "eligible";
        outcome.admitted = false;
        pending.push({ caseId: c.caseId, split: c.split, label, leftId: s.leftClusterId, rightId: s.rightClusterId });
      }
    }
    if (outcome.eligibility === "excluded") {
      recordExclusion(outcome.excludedReason!, c.caseId);
    }
    outcomes.push(outcome);
  }

  // Phase 2: one real selection pass over the full corpus with the reviewed
  // endpoints forced live (counterfactual), vector channel disabled.
  const liveClusterIds = new Set(pending.flatMap((p) => [p.leftId, p.rightId]).filter((id) => corpusIds.has(id)));
  const selection = buildClusterMergeCandidateSelection(corpusCandidates, { liveClusterIds });

  // Phase 3: admission check + evidence-based dev rejection reasons.
  const bm25Index = buildClusterMergeBm25Index(corpusCandidates);
  const candidatesById = new Map(corpusCandidates.map((c) => [c.id, c]));
  const devRejectionReasons: Array<{ caseId: string; reason: string }> = [];
  for (const p of pending) {
    const outcome = outcomes.find((o) => o.caseId === p.caseId)!;
    outcome.admitted = selection.allowedPairs.some((edge) => edgeConnects(edge, p.leftId, p.rightId));
    if (!outcome.admitted && p.split === "dev") {
      const reason = classifyRejection(candidatesById.get(p.leftId)!, candidatesById.get(p.rightId)!, bm25Index, liveClusterIds);
      outcome.rejectionReason = reason;
      devRejectionReasons.push({ caseId: p.caseId, reason });
    }
  }

  const metrics = {
    dev: computeSplitMetrics(outcomes, "dev"),
    holdout: computeSplitMetrics(outcomes, "holdout"),
  };
  const classIncomplete = [metrics.dev, metrics.holdout].some((m) => m.same.total === 0 || m.diff.total === 0);
  const coverageIncomplete = outcomes.some((o) => o.eligibility === "excluded");
  const status: BaselineReport["status"] =
    invalid.length > 0 || classIncomplete || coverageIncomplete ? "diagnostic_incomplete" : "diagnostic_complete";

  const report: BaselineReport = {
    schemaVersion: 1,
    stage: STAGE,
    status,
    releaseEligible: false,
    notMeasured: {
      aiCalls: "not_measured",
      aiTokens: "not_measured",
      modelCost: "not_measured",
      aiLatency: "not_measured",
      vectorRecallChannel: "disabled_not_measured",
    },
    scenarioFaithfulness: {
      asOfBasis: input.asOfBasis,
      lookbackDays: 7,
      scanClusterLimit: CLUSTER_MERGE_SCAN_CLUSTER_LIMIT,
      candidateLimit: CLUSTER_MERGE_CANDIDATE_LIMIT,
      relatedPairLimit: CLUSTER_MERGE_RELATED_PAIR_LIMIT,
      liveEndpoints: "counterfactual_reviewed_endpoints_live",
      corpusSize: input.corpus.length,
      liveClusterIdCount: liveClusterIds.size,
      missingTables: input.missingTables,
      itemsSourceFilter: input.itemsSourceFilter,
      samplingBiasNote: `sampling strata are ${summarizeSamplingStrata(input.sampling.cases)
        .map((e) => `${e.count} ${e.stratum}`)
        .join(" + ")} hard cases; rates are biased-sample diagnostics, not a global error rate`,
      stageBoundaryNote:
        "admission counts candidate-selector pairs only; entity-alias normalization, cannot-link filtering, AI review, and final graph merging are out of stage and not measured",
    },
    inputs: {
      frozenManifestSha256: input.frozenManifestShaActual,
      snapshotSha256: input.snapshotShaActual,
      samplingManifestSha256: input.samplingManifestShaActual,
      labelsCsvSha256: input.labelsCsvSha256,
      corpusFingerprint: fingerprintCorpus(input.corpus),
      snapshotUnchangedAfterRun: input.snapshotUnchangedAfterRun,
      sourceVersion: input.sourceVersion,
    },
    coverage: {
      total: input.frozen.cases.length,
      eligible: outcomes.filter((o) => o.eligibility === "eligible").length,
      uncertain: [...labelsById.values()].filter((r) => r.humanLabel === "uncertain").length,
      invalid,
      snapshotFieldComparison: {
        comparedCases: fieldComparedCases,
        notComparedCases: input.frozen.cases.length - fieldComparedCases,
        note:
          "snapshot field comparison only ran for cases passing cluster-presence and window checks; earlier-excluded cases are not compared and no no-drift claim is made for them",
      },
      exclusions: [...exclusionCases.entries()]
        .map(([reason, caseIds]) => ({ reason, count: caseIds.length, caseIds: [...caseIds].sort() }))
        .sort((a, b) => a.reason.localeCompare(b.reason)),
      bySplit: {
        dev: { total: input.frozen.cases.filter((c) => c.split === "dev").length, eligible: metrics.dev.eligible },
        holdout: {
          total: input.frozen.cases.filter((c) => c.split === "holdout").length,
          eligible: metrics.holdout.eligible,
        },
      },
    },
    metrics,
    devRejectionReasons: devRejectionReasons.sort((a, b) => (a.caseId < b.caseId ? -1 : 1)),
    diagnostics: selection.diagnostics,
    stableDecisionDigest: "",
    offlineRuntimeMs: 0,
  };
  report.stableDecisionDigest = buildStableDecisionDigest({
    provenance: {
      snapshotSha256: input.snapshotShaActual,
      frozenManifestSha256: input.frozenManifestShaActual,
      samplingManifestSha256: input.samplingManifestShaActual,
      labelsCsvSha256: input.labelsCsvSha256,
      corpusFingerprint: fingerprintCorpus(input.corpus),
    },
    scenario: {
      asOfMs: input.asOfMs,
      asOfBasis: input.asOfBasis,
      lookbackSinceMs: input.lookbackSinceMs,
      scanClusterLimit: CLUSTER_MERGE_SCAN_CLUSTER_LIMIT,
      candidateLimit: CLUSTER_MERGE_CANDIDATE_LIMIT,
      relatedPairLimit: CLUSTER_MERGE_RELATED_PAIR_LIMIT,
      liveClusterIds: [...liveClusterIds],
      vectorMode: "disabled_not_measured",
      missingTables: input.missingTables,
      itemsSourceFilter: input.itemsSourceFilter,
    },
    outcomes,
    metrics,
    sourceVersion: input.sourceVersion,
  });
  return { status, report, outcomes };
}

/**
 * Minimal markdown renderer: every claim is derived from the report fields —
 * rejection reasons are quoted verbatim, drift is only mentioned when the
 * stale_field_not_reconstructed exclusion actually exists, and coverage is
 * reported as actual compared/not-compared counts.
 */
export function renderMarkdown(report: BaselineReport): string {
  const lines: string[] = [];
  const m = report.metrics;
  const exclusionSummary = report.coverage.exclusions
    .map((e) => `${e.reason} ${e.count}`)
    .join("、");
  lines.push(
    `# Baseline report — cluster-quality snapshot counterfactual`,
    "",
    `- status: \`${report.status}\`（CLI exit ${report.status === "diagnostic_incomplete" ? 2 : 0}）；release_eligible: ${report.releaseEligible}`,
    `- 输入 SHA：frozen \`${report.inputs.frozenManifestSha256.slice(0, 8)}\` / snapshot \`${report.inputs.snapshotSha256.slice(0, 8)}\` / sampling \`${report.inputs.samplingManifestSha256.slice(0, 8)}\` / labels \`${report.inputs.labelsCsvSha256.slice(0, 8)}\`；snapshot 运行后未变：${report.inputs.snapshotUnchangedAfterRun}`,
    `- 场景：corpus ${report.scenarioFaithfulness.corpusSize} 簇（scan cap ${report.scenarioFaithfulness.scanClusterLimit}），live endpoints ${report.scenarioFaithfulness.liveClusterIdCount}（${report.scenarioFaithfulness.liveEndpoints}）；vector ${report.notMeasured.vectorRecallChannel}；itemsSourceFilter ${report.scenarioFaithfulness.itemsSourceFilter}`,
    "",
    `## 覆盖`,
    "",
    `- total ${report.coverage.total}（dev ${report.coverage.bySplit.dev.total} / holdout ${report.coverage.bySplit.holdout.total}），eligible ${report.coverage.eligible}（dev ${report.coverage.bySplit.dev.eligible} / holdout ${report.coverage.bySplit.holdout.eligible}）`,
    `- 排除：${exclusionSummary || "无"}`,
    `- 快照字段比对：实际比对 ${report.coverage.snapshotFieldComparison.comparedCases}/${report.coverage.total}，未比对 ${report.coverage.snapshotFieldComparison.notComparedCases}（${report.coverage.snapshotFieldComparison.note}）`,
    `- CSV checksum 与冻结 inputSha256 校验：${report.coverage.invalid.length === 0 ? `${report.coverage.total}/${report.coverage.total} 通过` : `${report.coverage.invalid.length} 条失败`}`,
    "",
    `## Stage 准入指标（candidate-selector，非 final merging）`,
    "",
  );
  for (const split of ["dev", "holdout"] as const) {
    const s = m[split];
    lines.push(
      `- ${split}：same ${s.same.admitted}/${s.same.total} admitted（recall ${s.sameEventCandidateAdmissionRecall ?? "null"}），diff ${s.diff.admitted}/${s.diff.total} admitted（rate ${s.differentEventCandidateAdmissionRate ?? "null"}）`,
    );
  }
  lines.push("", `## Dev 未准入原因（逐字来自报告，无推测）`, "");
  if (report.devRejectionReasons.length === 0) {
    lines.push("- 无");
  } else {
    for (const r of report.devRejectionReasons) {
      lines.push(`- ${r.caseId}: ${r.reason}`);
    }
  }
  lines.push(
    "",
    `stableDecisionDigest: \`${report.stableDecisionDigest}\`（git HEAD \`${report.inputs.sourceVersion.gitHead.slice(0, 12)}\`；排除时间戳/timing）`,
    "",
    `局限：${report.scenarioFaithfulness.samplingBiasNote}`,
  );
  return lines.join("\n") + "\n";
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith("--")) throw new InvalidInputError(`unexpected argument: ${key}`);
    args[key.slice(2)] = argv[i + 1] ?? "";
  }
  return args;
}

function resolveRepoPath(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const args = parseArgs(process.argv.slice(2));
  try {
    const frozenPath = args.frozen;
    const expectedSha = args["expected-manifest-sha"]?.trim().toLowerCase();
    const labelsPath = args.labels;
    const snapshotPath = args.snapshot;
    const outPath = args.out;
    if (!frozenPath || !expectedSha || !labelsPath || !snapshotPath || !outPath) {
      throw new InvalidInputError("required args: --frozen --expected-manifest-sha --labels --snapshot --out");
    }
    // Trust anchor first: verify the manifest digest BEFORE parsing it or
    // trusting any path recorded inside it.
    const frozenManifestShaActual = sha256File(frozenPath);
    if (frozenManifestShaActual !== expectedSha) {
      throw new InvalidInputError(
        `frozen manifest sha mismatch: expected ${expectedSha}, actual ${frozenManifestShaActual}`,
      );
    }
    const frozenFile = validateFrozenManifest(JSON.parse(fs.readFileSync(frozenPath, "utf8"))) as unknown as {
      asOf?: string;
      snapshot: { path: string; sha256: string };
      sourceFiles: { samplingManifest: { path: string; sha256: string } };
      cases: Array<{ caseId: string; split: "dev" | "holdout"; inputSha256: string; clusterIds: [string, string] }>;
    };
    const frozen: FrozenInput = {
      snapshotSha256: frozenFile.snapshot.sha256,
      samplingManifestSha256: frozenFile.sourceFiles.samplingManifest.sha256,
      cases: frozenFile.cases.map((c) => ({
        caseId: c.caseId,
        split: c.split,
        inputSha256: c.inputSha256,
        clusterIdsUnordered: [...c.clusterIds],
      })),
    };

    const snapshotAbs = resolveRepoPath(snapshotPath);
    const snapshotShaActual = sha256File(snapshotAbs);
    if (snapshotShaActual !== frozen.snapshotSha256) {
      throw new InvalidInputError(`snapshot sha mismatch: frozen ${frozen.snapshotSha256}, actual ${snapshotShaActual}`);
    }
    const samplingPath = resolveRepoPath(frozenFile.sourceFiles.samplingManifest.path);
    const samplingManifestShaActual = sha256File(samplingPath);
    const sampling = JSON.parse(fs.readFileSync(samplingPath, "utf8")) as SamplingManifest;
    if (!Array.isArray(sampling.cases) || sampling.cases.length === 0) {
      throw new InvalidInputError("sampling manifest has no cases");
    }

    const labelsRows = loadCsvTable(fs.readFileSync(labelsPath, "utf8"), BLIND_COLUMNS, BLIND_COLUMNS, "labels csv");

    const db = new DatabaseSync(snapshotAbs, { readOnly: true });
    try {
      const snapshotMaxMs = snapshotAsOfMs(db);
      const asOf = chooseAsOf({
        explicit: args["as-of"] || undefined,
        frozenAsOf: frozenFile.asOf,
        snapshotMaxMs,
      });
      const asOfMs = asOf.ms;
      const asOfBasis = asOf.basis;
      const lookbackSinceMs = asOfMs - CLUSTER_LOOKBACK_MS;
      const { corpus, missingTables, itemsSourceFilter } = selectProductionCorpus(db, lookbackSinceMs);
      const clustersById = loadClustersById(db);
      const sourceVersion = collectSourceVersionFreeze();
      const { status, report } = assessBaseline({
        frozen,
        frozenManifestShaActual,
        labelsRows,
        labelsCsvSha256: sha256File(labelsPath),
        sampling,
        samplingManifestShaActual,
        snapshotShaActual,
        snapshotUnchangedAfterRun: sha256File(snapshotAbs) === snapshotShaActual,
        corpus,
        clustersById,
        asOfMs,
        asOfBasis,
        lookbackSinceMs,
        missingTables,
        itemsSourceFilter,
        sourceVersion,
      });
      report.offlineRuntimeMs = Date.now() - startedAt;
      fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
      const mdPath = outPath.replace(/\.json$/i, "") + ".md";
      fs.writeFileSync(mdPath, renderMarkdown(report), "utf8");
      console.log(
        `[cluster-quality-baseline] status=${status} corpus=${report.scenarioFaithfulness.corpusSize} eligible=${report.coverage.eligible}/${report.coverage.total} digest=${report.stableDecisionDigest.slice(0, 12)}`,
      );
      process.exitCode = status === "diagnostic_incomplete" ? EXIT_DIAGNOSTIC_INCOMPLETE : EXIT_OK;
    } finally {
      db.close();
    }
  } catch (error) {
    if (error instanceof InvalidInputError) {
      console.error(`[cluster-quality-baseline] InvalidInputError: ${error.message}`);
      process.exitCode = EXIT_INVALID_INPUT;
      return;
    }
    throw error;
  }
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  void main();
}
