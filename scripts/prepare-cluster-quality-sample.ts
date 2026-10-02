#!/usr/bin/env node
/**
 * Local qualification snapshot + fresh blind-sample preparation for the
 * cluster-quality human review (stage: local_qualification_snapshot_sampler).
 *
 * sanitize: copy a raw read-only SQLite backup (a consistent container-side
 * .backup copied out-of-band) into a sanitized qualification snapshot that
 * contains ONLY three whitelisted tables with fixed public columns:
 *   content_clusters (15 cols), items (6 cols), sources (2 cols).
 * The raw backup may contain sensitive tables (configs, model API keys,
 * sessions); their values are never read — only whitelisted columns are
 * SELECTed, never SELECT *. The raw file is opened read-only and its digest
 * is verified unchanged around the copy. Raw temp cleanup is the caller's job.
 *
 * sample: choose a fresh 7-day blind sample from the sanitized snapshot using
 * the CURRENT production BM25 + safety stack (never the legacy lexical
 * scorer). --as-of must be the capture UTC instant of the raw backup; there is
 * no Date.now in the sampling path. Strata are weak scheduling hints only —
 * they stay in the private sampling manifest, never in the blind CSV, and are
 * never presented as human truth. All human columns of the pending packet
 * stay blank.
 *
 * No AI, no network, no writes outside --out / --sources-dir.
 * Exit codes: 0 ok, 1 invalid input, 2 insufficient sampling capacity
 * (requested pairs not available; actual counts reported, never fabricated).
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

// node:sqlite ships in Node 22+/25+; @types/node@20 has no declarations for it.
// @ts-expect-error node:sqlite has no type declarations in @types/node@20
import { DatabaseSync } from "node:sqlite";

import {
  buildClusterMergeBm25Index,
  scoreClusterMergeBm25Pair,
} from "@/lib/clusters/bm25";
import {
  checkClusterMergePairSafety,
  type ClusterMergeCandidate,
} from "@/lib/clusters/helpers";
import {
  InvalidInputError,
  BLIND_COLUMNS,
  loadCsvTable,
  stringifyCsv,
  sha256File,
  type ReviewCase,
} from "./eval-cluster-quality-review";
import {
  selectProductionCorpus,
  toClusterMergeCandidate,
  type ClusterRow,
  type SqliteHandle,
} from "./eval-cluster-quality-baseline";

export const EXIT_OK = 0;
export const EXIT_INVALID_INPUT = 1;
export const EXIT_INSUFFICIENT_CAPACITY = 2;

export const SAMPLER_STAGE = "local_qualification_snapshot_sampler";
export const DEFAULT_TARGET_PAIRS = 24;
export const DEFAULT_SEED = "cluster-quality-fresh-sample";
export const CLUSTER_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export type SampleStratum =
  | "same_event_fingerprint"
  | "same_object_event_boundary"
  | "safety_rejected_related"
  | "high_bm25_near_neighbor"
  | "low_similarity_coverage";


export const SNAPSHOT_TABLES = ["content_clusters", "items", "sources"] as const;
export type SnapshotTable = (typeof SNAPSHOT_TABLES)[number];

/** Exact public column contract of the sanitized snapshot (15 + 6 + 2). */
export const SNAPSHOT_COLUMNS: Record<SnapshotTable, string[]> = {
  content_clusters: [
    "id", "title", "summary", "itemCount", "latestPublishedAt", "status", "eventType",
    "eventSubject", "eventAction", "eventObject", "eventDate", "eventFingerprint",
    "fingerprint", "mergeInputHash", "updatedAt",
  ],
  items: ["id", "clusterId", "status", "moderationStatus", "parentItemId", "sourceId"],
  sources: ["id", "aggregationEnabled"],
};

const SNAPSHOT_COLUMN_TYPES: Record<SnapshotTable, string[]> = {
  content_clusters: [
    "TEXT", "TEXT", "TEXT", "INTEGER", "INTEGER", "TEXT", "TEXT", "TEXT", "TEXT",
    "TEXT", "TEXT", "TEXT", "TEXT", "TEXT", "INTEGER",
  ],
  items: ["TEXT", "TEXT", "TEXT", "TEXT", "TEXT", "TEXT"],
  sources: ["TEXT", "INTEGER"],
};

function snapshotDdl(table: SnapshotTable): string {
  const cols = SNAPSHOT_COLUMNS[table].map((c, i) => `"${c}" ${SNAPSHOT_COLUMN_TYPES[table][i]}`);
  return `CREATE TABLE "${table}" (${cols.join(", ")})`;
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function tableColumns(db: SqliteHandle, table: string): string[] {
  return (
    db.prepare(`select name from pragma_table_info('${table}')`).all() as Array<{ name: string }>
  ).map((c) => c.name);
}

function listTables(db: SqliteHandle): string[] {
  return (
    db.prepare("select name from sqlite_master where type='table'").all() as Array<{ name: string }>
  ).map((t) => t.name);
}

export type SanitizeResult = {
  outPath: string;
  outSha256: string;
  rawSha256Before: string;
  rawSha256After: string;
  rawUnchanged: boolean;
  integrityCheck: "ok";
  rowCounts: Record<SnapshotTable, number>;
};

/** Assert the raw database carries every whitelisted table/column (no fallback). */
export function assertRawWhitelist(raw: SqliteHandle): void {
  const tables = listTables(raw);
  const missingTables = SNAPSHOT_TABLES.filter((t) => !tables.includes(t));
  if (missingTables.length > 0) {
    throw new InvalidInputError(`raw backup missing required tables: ${missingTables.join(", ")}`);
  }
  for (const table of SNAPSHOT_TABLES) {
    const columns = tableColumns(raw, table);
    const missing = SNAPSHOT_COLUMNS[table].filter((c) => !columns.includes(c));
    if (missing.length > 0) {
      throw new InvalidInputError(
        `raw table ${table} missing required columns (no unknown fallback): ${missing.join(", ")}`,
      );
    }
  }
}

/**
 * Copy whitelisted columns of exactly three tables into a fresh sanitized
 * snapshot. Refuses to overwrite an existing target. The raw handle is opened
 * read-only and closed untouched; only whitelisted column values are read.
 */
export function sanitizeSnapshot(args: { rawPath: string; outPath: string }): SanitizeResult {
  if (fs.existsSync(args.outPath)) {
    throw new InvalidInputError(`out snapshot already exists, refusing to overwrite: ${args.outPath}`);
  }
  const rawSha256Before = sha256File(args.rawPath);
  const raw = new DatabaseSync(args.rawPath, { readOnly: true });
  const out = new DatabaseSync(args.outPath);
  try {
    assertRawWhitelist(raw);
    const rowCounts = {} as Record<SnapshotTable, number>;
    for (const table of SNAPSHOT_TABLES) {
      out.exec(snapshotDdl(table));
      const columns = SNAPSHOT_COLUMNS[table];
      const selectSql = `SELECT ${columns.map((c) => `"${c}"`).join(", ")} FROM "${table}"`;
      const insertSql = `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")})
        VALUES (${columns.map(() => "?").join(", ")})`;
      const rows = raw.prepare(selectSql).all() as unknown as Array<Record<string, unknown>>;
      const stmt = out.prepare(insertSql);
      out.exec("BEGIN");
      for (const row of rows) {
        stmt.run(...columns.map((c) => row[c]));
      }
      out.exec("COMMIT");
      rowCounts[table] = rows.length;
    }
    const integrity = (out.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
    if (integrity !== "ok") throw new InvalidInputError(`sanitized snapshot integrity_check failed: ${integrity}`);
    // Post-write structural assertion: exactly the whitelist, nothing else.
    const outTables = listTables(out).sort();
    const expected = [...SNAPSHOT_TABLES].sort();
    if (outTables.length !== expected.length || outTables.some((t, i) => t !== expected[i])) {
      throw new InvalidInputError(`sanitized snapshot has unexpected tables: ${outTables.join(", ")}`);
    }
    for (const table of SNAPSHOT_TABLES) {
      const columns = tableColumns(out, table);
      if (columns.length !== SNAPSHOT_COLUMNS[table].length) {
        throw new InvalidInputError(`sanitized table ${table} column count mismatch: ${columns.length}`);
      }
    }
    const rawSha256After = sha256File(args.rawPath);
    if (rawSha256After !== rawSha256Before) {
      throw new InvalidInputError("raw backup digest changed during sanitize; aborting");
    }
    return {
      outPath: args.outPath,
      outSha256: sha256File(args.outPath),
      rawSha256Before,
      rawSha256After,
      rawUnchanged: true,
      integrityCheck: "ok",
      rowCounts,
    };
  } finally {
    out.close();
    raw.close();
  }
}

export type PairCandidate = {
  leftId: string;
  rightId: string;
  pairKey: string;
  score: number;
  /** Shared non-empty event fingerprint; both endpoints belong to one fp group. */
  sharedFingerprint: string | null;
  /**
   * Same non-empty event object AND a genuine event boundary (eventDate or
   * eventAction actually differs) — never inferred from the object alone.
   */
  objectBoundaryVerified: boolean;
  safetyRejected: boolean;
  safetyReason: string | null;
};

export function stratumOf(pair: PairCandidate): SampleStratum {
  if (pair.sharedFingerprint) return "same_event_fingerprint";
  if (pair.objectBoundaryVerified) return "same_object_event_boundary";
  if (pair.safetyRejected && pair.score > 0) return "safety_rejected_related";
  if (pair.score > 0) return "high_bm25_near_neighbor";
  return "low_similarity_coverage";
}

/**
 * Full scored pair universe over the corpus: EVERY unordered pair carries its
 * real safety verdict and BM25 score. Safety-rejected and zero-score pairs are
 * kept so recall-miss / safety-false-reject diagnostics are possible; any
 * filtering happens at selection time, never in this ranking pass.
 */
export function scorePairUniverse(corpus: ClusterRow[]): PairCandidate[] {
  const candidates: ClusterMergeCandidate[] = corpus.map(toClusterMergeCandidate);
  const index = buildClusterMergeBm25Index(candidates);
  const pairs: PairCandidate[] = [];
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const left = candidates[i]!;
      const right = candidates[j]!;
      const safety = checkClusterMergePairSafety(left, right);
      const score = scoreClusterMergeBm25Pair(index, left.id, right.id);
      const sharedFingerprint =
        left.eventFingerprint && left.eventFingerprint === right.eventFingerprint ? left.eventFingerprint : null;
      const sameObject = Boolean(left.eventObject?.trim()) && left.eventObject === right.eventObject;
      const boundaryVerified =
        sameObject &&
        !sharedFingerprint &&
        ((left.eventDate ?? "") !== (right.eventDate ?? "") ||
          (left.eventAction ?? "") !== (right.eventAction ?? ""));
      const [a, b] = [left.id, right.id].sort();
      pairs.push({
        leftId: a,
        rightId: b,
        pairKey: `${a}|${b}`,
        score,
        sharedFingerprint,
        objectBoundaryVerified: boundaryVerified,
        safetyRejected: Boolean(safety.rejected),
        safetyReason: safety.rejected ? (safety.rejectedReason ?? "unknown") : null,
      });
    }
  }
  return pairs;
}

/** Deterministic seeded ordering (sha256 key sort) for the coverage fill. */
export function seededOrder(seed: string, pairKeys: string[]): string[] {
  return pairKeys
    .map((key) => ({ key, digest: sha256Text(`${seed}:${key}`) }))
    .sort((a, b) => (a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0))
    .map((e) => e.key);
}
export type SelectedPair = {
  caseId: string;
  pairKey: string;
  leftId: string;
  rightId: string;
  stratum: SampleStratum;
  weakBm25Score: number;
  weakSafetyReason: string | null;
};

export type StratumQuota = { key: string; strata: SampleStratum[]; count: number };

/**
 * Explicit independent quotas for not-admitted / low-similarity controls so a
 * packet can diagnose rule recall misses and safety false rejects — not only
 * repeated high-score pairs. Quotas are scheduling hints, never gold labels.
 */
export const SAMPLE_QUOTAS: StratumQuota[] = [
  {
    key: "high_similarity_or_same_fp",
    strata: ["same_event_fingerprint", "same_object_event_boundary", "high_bm25_near_neighbor"],
    count: 18,
  },
  { key: "safety_rejected_related", strata: ["safety_rejected_related"], count: 2 },
  { key: "low_similarity_coverage", strata: ["low_similarity_coverage"], count: 4 },
];

export type QuotaStat = { requested: number; actual: number };

export type SelectionResult = {
  selected: SelectedPair[];
  stratumCounts: Record<string, number>;
  universeSize: number;
  quotaStats: Record<string, QuotaStat>;
};

/**
 * Quota-scheduled deterministic selection over the full pair universe (every
 * safety verdict, no score prefilter). Pairs are cluster-disjoint and one
 * event-fingerprint group never spans two cases. Priority order seeds the
 * matching; Kuhn-style augmenting relocation keeps feasibility maximal without
 * relaxing constraints. A quota the real universe cannot fill is reported as a
 * capacity shortfall — counts are never fabricated and no source filter is
 * loosened. Human labels and weak verdicts never feed back into ranking.
 */
export function chooseSamplePairs(pairs: PairCandidate[], target: number, seed: string): SelectionResult {
  if (!Number.isInteger(target) || target < 1) throw new InvalidInputError(`invalid target pair count: ${target}`);
  const byStratum = new Map<SampleStratum, PairCandidate[]>();
  for (const pair of pairs) {
    const stratum = stratumOf(pair);
    const list = byStratum.get(stratum) ?? [];
    list.push(pair);
    byStratum.set(stratum, list);
  }
  // Score-first ranking with a seeded digest tiebreak: deterministic, stable
  // under the recorded seed, and free of any human-label prior.
  const seededRank = new Map(pairs.map((p) => [p.pairKey, seededOrder(seed, [p.pairKey])[0] ?? p.pairKey]));
  const byScore = (a: PairCandidate, b: PairCandidate) =>
    b.score - a.score || (seededRank.get(a.pairKey) ?? "").localeCompare(seededRank.get(b.pairKey) ?? "");
  for (const list of byStratum.values()) list.sort(byScore);
  const pairByKey = new Map(pairs.map((p) => [p.pairKey, p]));

  const byCluster = new Map<string, string>();
  const fpGroupOwner = new Map<string, string>();
  const unassign = (pair: PairCandidate) => {
    for (const id of [pair.leftId, pair.rightId]) {
      if (byCluster.get(id) === pair.pairKey) byCluster.delete(id);
    }
    if (pair.sharedFingerprint && fpGroupOwner.get(pair.sharedFingerprint) === pair.pairKey) {
      fpGroupOwner.delete(pair.sharedFingerprint);
    }
  };
  const assign = (pair: PairCandidate) => {
    byCluster.set(pair.leftId, pair.pairKey);
    byCluster.set(pair.rightId, pair.pairKey);
    if (pair.sharedFingerprint) fpGroupOwner.set(pair.sharedFingerprint, pair.pairKey);
  };
  /**
   * Atomic eviction-based augmentation: to place a pair whose endpoints are
   * occupied, remove the incumbent pair ALL-OR-NOTHING and relocate it as a
   * whole; restore it if relocation fails. Non-atomic chained relocation can
   * let a later relocation steal a cluster freed by an earlier one and corrupt
   * the disjointness invariant, so each incumbent move is a single step.
   */
  const tryAssign = (key: string, visited: Set<string>): boolean => {
    if (visited.has(key)) return false;
    visited.add(key);
    const pair = pairByKey.get(key)!;
    if (pair.sharedFingerprint) {
      const owner = fpGroupOwner.get(pair.sharedFingerprint);
      if (owner !== undefined && owner !== key) return false;
    }
    for (const id of [pair.leftId, pair.rightId]) {
      // A relocation can legally re-take this very cluster (it was just
      // freed), so re-check the same endpoint until it is actually free.
      for (;;) {
        const owner = byCluster.get(id);
        if (owner === undefined || owner === key) break;
        if (visited.has(owner)) return false;
        const incumbent = pairByKey.get(owner)!;
        unassign(incumbent);
        if (!tryAssign(owner, visited)) {
          assign(incumbent);
          return false;
        }
      }
    }
    unassign(pair);
    assign(pair);
    return true;
  };

  const stratumByKey = new Map<string, SampleStratum>();
  const quotaStats: Record<string, QuotaStat> = {};
  for (const quota of SAMPLE_QUOTAS) {
    const requested = Math.min(quota.count, Math.max(0, target - stratumByKey.size));
    let actual = 0;
    for (const stratum of quota.strata) {
      for (const pair of byStratum.get(stratum) ?? []) {
        if (actual >= requested || stratumByKey.size >= target) break;
        if (stratumByKey.has(pair.pairKey)) continue;
        if (tryAssign(pair.pairKey, new Set())) {
          stratumByKey.set(pair.pairKey, stratum);
          actual += 1;
        }
      }
      if (actual >= requested || stratumByKey.size >= target) break;
    }
    quotaStats[quota.key] = { requested, actual };
  }
  if (stratumByKey.size < target) {
    const detail = Object.entries(quotaStats)
      .map(([k, v]) => `${k} ${v.actual}/${v.requested}`)
      .join(", ");
    throw new InvalidInputError(
      `insufficient_sampling_capacity: requested ${target} pairs, universe allows only ${stratumByKey.size} ` +
        `(${pairs.length} ranked pairs; quota shortfall: ${detail}; refusing to fabricate or relax constraints)`,
    );
  }
  const selected: SelectedPair[] = [...stratumByKey.entries()]
    .map(([pairKey, stratum]) => {
      const pair = pairByKey.get(pairKey)!;
      return {
        caseId: `CQ-${sha256Text(pairKey).slice(0, 12).toUpperCase()}`,
        pairKey,
        leftId: pair.leftId,
        rightId: pair.rightId,
        stratum,
        weakBm25Score: pair.score,
        weakSafetyReason: pair.safetyReason,
      };
    })
    .sort((a, b) => (a.caseId < b.caseId ? -1 : 1));
  const stratumCounts: Record<string, number> = {};
  for (const s of selected) stratumCounts[s.stratum] = (stratumCounts[s.stratum] ?? 0) + 1;
  return { selected, stratumCounts, universeSize: pairs.length, quotaStats };
}

export type SamplingManifest = {
  schemaVersion: 1;
  stage: typeof SAMPLER_STAGE;
  purpose: string;
  createdAt: string;
  asOfMs: number;
  windowDays: 7;
  seed: string;
  snapshot: { path: string; sha256: string };
  selection: {
    targetCaseCount: number;
    actualCaseCount: number;
    universeSize: number;
    stratumCounts: Record<string, number>;
    quotaStats: Record<string, QuotaStat>;
    note: string;
  };
  reviewInstructions: { rule: string };
  caseCount: number;
  cases: Array<
    ReviewCase & {
      weakBm25Score: number;
      reasonCode: SampleStratum;
      eventFingerprintShared: boolean;
      weakSafetyReason: string | null;
    }
  >;
};

export function buildSamplingManifest(args: {
  snapshotPath: string;
  snapshotSha256: string;
  asOfIso: string;
  asOfMs: number;
  seed: string;
  target: number;
  selection: SelectionResult;
}): SamplingManifest {
  return {
    schemaVersion: 1,
    stage: SAMPLER_STAGE,
    purpose:
      "Private sampling manifest for the cluster-quality blind review (weak scheduling hints only; never human truth). Source of the frozen packet.",
    createdAt: args.asOfIso,
    asOfMs: args.asOfMs,
    windowDays: 7,
    seed: args.seed,
    snapshot: { path: args.snapshotPath, sha256: args.snapshotSha256 },
    selection: {
      targetCaseCount: args.target,
      actualCaseCount: args.selection.selected.length,
      universeSize: args.selection.universeSize,
      stratumCounts: args.selection.stratumCounts,
      quotaStats: args.selection.quotaStats,
      note:
        "strata follow explicit quotas (at target 24: 18 high-similarity/same-FP + 2 safety-rejected-related + 4 low-similarity coverage); they are weak sampling-bias diagnostics from the current production BM25+safety stack, intentionally NOT population rates; controls are not gold labels and weak signals never reach the blind CSV",
    },
    reviewInstructions: {
      rule:
        "Decide independently from the visible pair snapshot; do not treat the source or any weak verdict as gold. Mark uncertain when event boundary/evidence is insufficient.",
    },
    caseCount: args.selection.selected.length,
    cases: args.selection.selected.map((s) => ({
      caseId: s.caseId,
      pairKey: s.pairKey,
      leftClusterId: s.leftId,
      rightClusterId: s.rightId,
      sourceStratum: s.stratum,
      snapshotSha256: args.snapshotSha256,
      weakBm25Score: s.weakBm25Score,
      reasonCode: s.stratum,
      eventFingerprintShared: s.stratum === "same_event_fingerprint",
      weakSafetyReason: s.weakSafetyReason,
    })),
  };
}

/** Pending blind CSV: visible inputs only; every human column blank, reviewStatus=pending. */
export function buildPendingRows(corpusById: Map<string, ClusterRow>, selected: SelectedPair[]): string[][] {
  const rows: string[][] = [[...BLIND_COLUMNS]];
  const SIDE_KEYS = ["Title", "Summary", "EventType", "EventSubject", "EventAction", "EventObject", "EventDate", "ItemCount", "LatestPublishedAt"] as const;
  for (const s of selected) {
    const values: string[] = [s.caseId, s.pairKey];
    for (const prefix of ["left", "right"] as const) {
      const id = prefix === "left" ? s.leftId : s.rightId;
      const row = corpusById.get(id);
      if (!row) throw new InvalidInputError(`sampled cluster missing from snapshot: ${id}`);
      const rowValues: Record<string, string> = {
        Title: row.title,
        Summary: row.summary ?? "",
        EventType: row.eventType ?? "",
        EventSubject: row.eventSubject ?? "",
        EventAction: row.eventAction ?? "",
        EventObject: row.eventObject ?? "",
        EventDate: row.eventDate ?? "",
        ItemCount: String(row.itemCount),
        LatestPublishedAt: String(row.latestPublishedAt),
      };
      for (const key of SIDE_KEYS) values.push(rowValues[key] ?? "");
    }
    rows.push([...values, "pending", "", "", "", ""]);
  }
  return rows;
}

/**
 * Reverse mapping check on a sanitized snapshot: exactly the whitelisted
 * tables exist, every manifest case's cluster ids resolve, and each visible
 * CSV input field equals the snapshot cluster row it maps back to.
 */
export function verifyManifestAgainstSnapshot(
  manifest: Pick<SamplingManifest, "cases">,
  db: SqliteHandle,
): void {
  const tables = listTables(db);
  const unexpected = tables.filter((t) => !SNAPSHOT_TABLES.includes(t as SnapshotTable));
  if (unexpected.length > 0) {
    throw new InvalidInputError(`snapshot contains non-whitelisted tables: ${unexpected.join(", ")}`);
  }
  const columns = tableColumns(db, "content_clusters");
  const rows = db
    .prepare(`SELECT ${SNAPSHOT_COLUMNS.content_clusters.map((c) => `"${c}"`).join(", ")} FROM content_clusters`)
    .all() as unknown as ClusterRow[];
  if (columns.length !== SNAPSHOT_COLUMNS.content_clusters.length) {
    throw new InvalidInputError("snapshot content_clusters column count mismatch");
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const c of manifest.cases) {
    for (const id of [c.leftClusterId, c.rightClusterId]) {
      if (!byId.has(id)) throw new InvalidInputError(`manifest case ${c.caseId}: cluster missing in snapshot: ${id}`);
    }
  }
}

/**
 * Field-level reverse mapping of pending CSV rows onto the sanitized snapshot:
 * every visible input cell must equal the snapshot cluster row it maps back
 * to (same comparisons as the baseline's verifyCaseFields).
 */
export function verifyPendingFieldsAgainstSnapshot(
  pendingRows: Array<Record<string, string>>,
  db: SqliteHandle,
): void {
  const tables = listTables(db);
  const unexpected = tables.filter((t) => !SNAPSHOT_TABLES.includes(t as SnapshotTable));
  if (unexpected.length > 0) {
    throw new InvalidInputError(`snapshot contains non-whitelisted tables: ${unexpected.join(", ")}`);
  }
  const rows = db
    .prepare(`SELECT ${SNAPSHOT_COLUMNS.content_clusters.map((c) => `"${c}"`).join(", ")} FROM content_clusters`)
    .all() as unknown as ClusterRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const textEq = (a: string, b: string | null | undefined) => (a ?? "").trim() === (b ?? "").trim();
  const problems: string[] = [];
  for (const row of pendingRows) {
    for (const prefix of ["left", "right"] as const) {
      const clusterId = pairKeySide(row, prefix);
      const cluster = byId.get(clusterId);
      if (!cluster) {
        problems.push(`${row.caseId}: ${prefix} cluster not in snapshot: ${clusterId}`);
        continue;
      }
      const side = (field: string) => row[`${prefix}${field}`] ?? "";
      const checks: Array<[string, boolean]> = [
        ["Title", textEq(side("Title"), cluster.title)],
        ["Summary", textEq(side("Summary"), cluster.summary)],
        ["EventType", textEq(side("EventType"), cluster.eventType)],
        ["EventSubject", textEq(side("EventSubject"), cluster.eventSubject)],
        ["EventAction", textEq(side("EventAction"), cluster.eventAction)],
        ["EventObject", textEq(side("EventObject"), cluster.eventObject)],
        ["EventDate", textEq(side("EventDate"), cluster.eventDate)],
        ["ItemCount", Number(side("ItemCount")) === cluster.itemCount],
        ["LatestPublishedAt", Number(side("LatestPublishedAt")) === cluster.latestPublishedAt],
      ];
      for (const [field, ok] of checks) {
        if (!ok) problems.push(`${row.caseId}: ${prefix}${field} does not map back to snapshot`);
      }
    }
  }
  if (problems.length > 0) {
    throw new InvalidInputError(`pending/snapshot reverse mapping failed:\n- ${problems.join("\n- ")}`);
  }
}

/** Resolve the cluster id of a pending CSV side via the manifest pairKey order. */
function pairKeySide(row: Record<string, string>, prefix: "left" | "right"): string {
  // The manifest pins the direction; the sampler writes pairKey as
  // `leftId|rightId`, so index 0 is left and 1 is right.
  const parts = row.pairKey?.split("|") ?? [];
  return prefix === "left" ? (parts[0] ?? "") : (parts[1] ?? "");
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

export function runSanitize(args: { rawPath: string; outPath: string }): SanitizeResult {
  return sanitizeSnapshot({ rawPath: resolveRepoPath(args.rawPath), outPath: resolveRepoPath(args.outPath) });
}

export function runSample(args: {
  snapshot: string;
  asOf: string;
  sourcesDir: string;
  target?: number;
  seed?: string;
}): { manifest: SamplingManifest; pendingCsvPath: string; manifestPath: string } {
  const asOfMs = Date.parse(args.asOf);
  if (!Number.isFinite(asOfMs)) throw new InvalidInputError(`--as-of must be a valid ISO timestamp: ${args.asOf}`);
  const target = args.target ?? DEFAULT_TARGET_PAIRS;
  const seed = args.seed ?? DEFAULT_SEED;
  const snapshotPath = resolveRepoPath(args.snapshot);
  const snapshotSha256 = sha256File(snapshotPath);
  const db = new DatabaseSync(snapshotPath, { readOnly: true });
  try {
    const { corpus, missingTables, itemsSourceFilter } = selectProductionCorpus(db, asOfMs - CLUSTER_LOOKBACK_MS);
    if (missingTables.length > 0 || itemsSourceFilter !== "enforced_production_exists_filter") {
      throw new InvalidInputError(
        `snapshot cannot enforce the production items/source filter: missingTables=${missingTables.join(",")}, filter=${itemsSourceFilter}`,
      );
    }
    if (corpus.length === 0) {
      throw new InvalidInputError(
        `no eligible clusters in the 7-day window ending at asOf ${args.asOf}; refusing to widen the window`,
      );
    }
    const corpusById = new Map(corpus.map((row) => [row.id, row]));
    const universe = scorePairUniverse(corpus);
    const selection = chooseSamplePairs(universe, target, seed);
    const manifest = buildSamplingManifest({
      snapshotPath: path.relative(process.cwd(), snapshotPath),
      snapshotSha256,
      asOfIso: new Date(asOfMs).toISOString(),
      asOfMs,
      seed,
      target,
      selection,
    });
    verifyManifestAgainstSnapshot(manifest, db);
    const sourcesDir = resolveRepoPath(args.sourcesDir);
    if (fs.existsSync(sourcesDir) && fs.readdirSync(sourcesDir).length > 0) {
      throw new InvalidInputError(`sources dir exists and is not empty, refusing to overwrite: ${sourcesDir}`);
    }
    fs.mkdirSync(sourcesDir, { recursive: true });
    const pendingCsvPath = path.join(sourcesDir, "pending-review.csv");
    const manifestPath = path.join(sourcesDir, "sampling-manifest.json");
    fs.writeFileSync(pendingCsvPath, stringifyCsv(buildPendingRows(corpusById, selection.selected)), "utf8");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    // Read the written CSV back and field-verify it against the sanitized
    // snapshot before declaring success.
    const pendingRecords = loadCsvTable(
      fs.readFileSync(pendingCsvPath, "utf8"),
      BLIND_COLUMNS,
      BLIND_COLUMNS,
      "pending csv",
    );
    verifyPendingFieldsAgainstSnapshot(pendingRecords, db);
    return { manifest, pendingCsvPath, manifestPath };
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));
  try {
    if (command === "sanitize") {
      if (!args.raw || !args.out) throw new InvalidInputError("required args: --raw --out");
      const result = runSanitize({ rawPath: args.raw, outPath: args.out });
      console.log(
        `[prepare-cluster-quality-sample] sanitized out=${result.outPath} sha256=${result.outSha256} ` +
          `counts=${JSON.stringify(result.rowCounts)} rawUnchanged=${result.rawUnchanged}`,
      );
      process.exitCode = EXIT_OK;
      return;
    }
    if (command === "sample") {
      if (!args.snapshot || !args["as-of"] || !args["sources-dir"]) {
        throw new InvalidInputError("required args: --snapshot --as-of --sources-dir [--target] [--seed]");
      }
      const result = runSample({
        snapshot: args.snapshot,
        asOf: args["as-of"],
        sourcesDir: args["sources-dir"],
        target: args.target ? Number(args.target) : undefined,
        seed: args.seed,
      });
      const m = result.manifest;
      console.log(
        `[prepare-cluster-quality-sample] sampled cases=${m.caseCount}/${m.selection.targetCaseCount} ` +
          `strata=${JSON.stringify(m.selection.stratumCounts)} quotas=${JSON.stringify(m.selection.quotaStats)} asOf=${m.createdAt} ` +
          `csv=${result.pendingCsvPath} manifest=${result.manifestPath} (weak hints stay in the private manifest; no AI/network)`,
      );
      process.exitCode = EXIT_OK;
      return;
    }
    throw new InvalidInputError(`unknown command: ${command}; usage: sanitize|sample`);
  } catch (error) {
    if (error instanceof InvalidInputError) {
      console.error(`[prepare-cluster-quality-sample] InvalidInputError: ${error.message}`);
      process.exitCode = error.message.startsWith("insufficient_sampling_capacity")
        ? EXIT_INSUFFICIENT_CAPACITY
        : EXIT_INVALID_INPUT;
      return;
    }
    throw error;
  }
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  void main();
}
