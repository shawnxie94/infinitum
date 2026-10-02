#!/usr/bin/env node
/**
 * Offline cluster-quality human-review foundation.
 *
 * prepare: freeze a blinded review packet (blind-review.csv + private frozen
 * manifest) from the pending hard-case CSV + sampling manifest + read-only
 * snapshot DB. No network, no AI, no writes outside --out-dir.
 *
 * assess: evaluate a human-backfilled blind CSV for readiness only. It never
 * emits quality_passed; the best outcome is ready_for_replay. With zero
 * labels the expected result is status=insufficient_truth with exit code 2.
 *
 * Baseline note: the legacy replay (scripts/eval-bm25-vs-lexical.ts) scores a
 * legacy lexical scorer, NOT the current production strategy and NOT the
 * end-to-end AI pipeline. Its replay is deferred until human labels exist and
 * is recorded here as diagnostic_only / deferred, never as a quality result.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Default packet dir is a repo-relative durable path, not /tmp; date-stamped per run. */
export function defaultOutDir(now = new Date()): string {
  return `docs/eval/reviews/cluster-quality-${now.toISOString().slice(0, 10)}`;
}
export const FROZEN_MANIFEST_NAME = "frozen-manifest.json";
export const FROZEN_MANIFEST_SHA_NAME = "frozen-manifest.sha256";
export const BLIND_CSV_NAME = "blind-review.csv";
export const ASSESS_REPORT_NAME = "readiness-report.json";

/** Extra legacy column tolerated in the pending packet; not part of the blind contract. */
export const LEGACY_PENDING_EXTRA_COLUMNS = ["reviewerNotes"] as const;

export const INPUT_FIELDS = [
  "pairKey",
  "leftTitle",
  "leftSummary",
  "leftEventType",
  "leftEventSubject",
  "leftEventAction",
  "leftEventObject",
  "leftEventDate",
  "leftItemCount",
  "leftLatestPublishedAt",
  "rightTitle",
  "rightSummary",
  "rightEventType",
  "rightEventSubject",
  "rightEventAction",
  "rightEventObject",
  "rightEventDate",
  "rightItemCount",
  "rightLatestPublishedAt",
] as const;

export const HUMAN_FIELDS = ["reviewStatus", "humanLabel", "humanReason", "reviewer", "reviewedAt"] as const;

export const BLIND_COLUMNS = ["caseId", ...INPUT_FIELDS, ...HUMAN_FIELDS];

export const EXIT_OK = 0;
export const EXIT_INVALID_INPUT = 1;
export const EXIT_INSUFFICIENT_TRUTH = 2;

export class SplitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SplitError";
  }
}

export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInputError";
  }
}

export function sha256File(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * RFC 4180 CSV parser: quoted fields, escaped quotes, embedded newlines.
 * Strict: unclosed quoted fields and quotes inside unquoted fields are errors.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (field.length > 0) {
        throw new InvalidInputError(`illegal quote inside unquoted CSV field at offset ${i}`);
      }
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (inQuotes) {
    throw new InvalidInputError("unclosed quoted CSV field at end of input");
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

export function stringifyCsv(rows: string[][]): string {
  return (
    rows
      .map((row) =>
        row
          .map((value) => {
            const v = value ?? "";
            return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
          })
          .join(","),
      )
      .join("\n") + "\n"
  );
}

export function csvRecords(text: string): Array<Record<string, string>> {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const header = rows[0];
  return rows.slice(1).map((row, index) => {
    if (row.length !== header.length) {
      throw new InvalidInputError(`ragged CSV row ${index + 2}: got ${row.length} cells, header has ${header.length}`);
    }
    const record: Record<string, string> = {};
    header.forEach((name, cellIndex) => {
      record[name] = row[cellIndex] ?? "";
    });
    return record;
  });
}

/**
 * Header-validated CSV loading: column names must be unique, all required
 * columns present, and every column must be in the allowlist (unknown input
 * columns are rejected; the human-column set is part of the contract).
 */
export function loadCsvTable(
  text: string,
  requiredColumns: readonly string[],
  allowedColumns: readonly string[],
  label: string,
): Array<Record<string, string>> {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new InvalidInputError(`${label}: empty CSV`);
  const header = rows[0];
  const duplicates = [...new Set(header.filter((name, index) => header.indexOf(name) !== index))];
  if (duplicates.length > 0) throw new InvalidInputError(`${label}: duplicate columns: ${duplicates.join(", ")}`);
  const missing = requiredColumns.filter((name) => !header.includes(name));
  if (missing.length > 0) throw new InvalidInputError(`${label}: missing required columns: ${missing.join(", ")}`);
  const unknown = header.filter((name) => !allowedColumns.includes(name));
  if (unknown.length > 0) throw new InvalidInputError(`${label}: unknown columns: ${unknown.join(", ")}`);
  return rows.slice(1).map((row, index) => {
    if (row.length !== header.length) {
      throw new InvalidInputError(`${label}: ragged row ${index + 2}: got ${row.length} cells, header has ${header.length}`);
    }
    const record: Record<string, string> = {};
    header.forEach((name, cellIndex) => {
      record[name] = row[cellIndex] ?? "";
    });
    return record;
  });
}

/** Checksum over case input columns only; human-editable fields are excluded. */
export function canonicalInputSha(caseId: string, values: Record<string, string>): string {
  const canonical = JSON.stringify([caseId, ...INPUT_FIELDS.map((f) => values[f] ?? "")]);
  return sha256Text(canonical);
}

export type ReviewCase = {
  caseId: string;
  pairKey: string;
  leftClusterId: string;
  rightClusterId: string;
  sourceStratum: string;
  snapshotSha256: string;
};

export function pairKeyClusters(pairKey: string): [string, string] {
  const parts = pairKey.split("|");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new InvalidInputError(`malformed pairKey: ${pairKey}`);
  }
  return [parts[0], parts[1]];
}

/** Connected components over cases sharing any cluster id (unordered direction). */
export function buildComponents(cases: ReviewCase[]): Array<{ caseIds: string[]; minCaseId: string }> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  const union = (a: string, b: string) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const c of cases) {
    parent.set(c.caseId, c.caseId);
  }
  const byCluster = new Map<string, string[]>();
  for (const c of cases) {
    for (const clusterId of pairKeyClusters(c.pairKey)) {
      const list = byCluster.get(clusterId) ?? [];
      list.push(c.caseId);
      byCluster.set(clusterId, list);
    }
  }
  for (const members of byCluster.values()) {
    for (let i = 1; i < members.length; i += 1) union(members[0], members[i]);
  }
  const groups = new Map<string, string[]>();
  for (const c of cases) {
    const root = find(c.caseId);
    const list = groups.get(root) ?? [];
    list.push(c.caseId);
    groups.set(root, list);
  }
  return [...groups.values()]
    .map((caseIds) => ({ caseIds: caseIds.sort(), minCaseId: [...caseIds].sort()[0] }))
    .sort((a, b) => b.caseIds.length - a.caseIds.length || (a.minCaseId < b.minCaseId ? -1 : 1));
}

/**
 * Deterministic dev/holdout split by whole connected components, balancing
 * strata toward a 2:1 dev:holdout share (counts are best-effort, not forced).
 * Throws SplitError("cannot_split") when no non-empty holdout is possible.
 */
export function assignSplits(
  components: Array<{ caseIds: string[]; minCaseId: string }>,
  stratumByCase: Record<string, string>,
): { dev: string[]; holdout: string[] } {
  const sides = ["dev", "holdout"] as const;
  const grand: Record<(typeof sides)[number], number> = { dev: 0, holdout: 0 };
  const stratumDev: Record<string, number> = {};
  const stratumHoldout: Record<string, number> = {};

  for (const component of components) {
    let bestSide: (typeof sides)[number] = "dev";
    let bestCost = Number.POSITIVE_INFINITY;
    for (const side of sides) {
      let cost = 0;
      for (const stratum of new Set(component.caseIds.map((id) => stratumByCase[id] ?? "unknown"))) {
        const add = component.caseIds.filter((id) => (stratumByCase[id] ?? "unknown") === stratum).length;
        const d = (stratumDev[stratum] ?? 0) + (side === "dev" ? add : 0);
        const h = (stratumHoldout[stratum] ?? 0) + (side === "holdout" ? add : 0);
        cost += Math.abs(h / (d + h) - 1 / 3);
      }
      const globalHoldout = (grand.holdout + (side === "holdout" ? component.caseIds.length : 0)) /
        (grand.dev + grand.holdout + component.caseIds.length);
      cost += Math.abs(globalHoldout - 1 / 3);
      if (cost < bestCost - 1e-12) {
        bestCost = cost;
        bestSide = side;
      } else if (Math.abs(cost - bestCost) <= 1e-12 && grand[side] < grand[bestSide]) {
        bestCost = cost;
        bestSide = side;
      }
    }
    for (const id of component.caseIds) {
      const stratum = stratumByCase[id] ?? "unknown";
      (bestSide === "dev" ? stratumDev : stratumHoldout)[stratum] =
        ((bestSide === "dev" ? stratumDev : stratumHoldout)[stratum] ?? 0) + 1;
    }
    grand[bestSide] += component.caseIds.length;
    (component as { side?: string }).side = bestSide;
  }

  const dev: string[] = [];
  const holdout: string[] = [];
  for (const component of components) {
    const target = (component as { side?: string }).side ?? "dev";
    for (const id of component.caseIds) (target === "dev" ? dev : holdout).push(id);
  }
  if (dev.length === 0 || holdout.length === 0) {
    throw new SplitError(
      `cannot_split: no stable dev/holdout split exists (${dev.length} dev / ${holdout.length} holdout); refusing to fabricate a holdout`,
    );
  }
  dev.sort();
  holdout.sort();
  return { dev, holdout };
}

export function validatePendingAgainstManifest(
  rows: Array<Record<string, string>>,
  manifestCases: ReviewCase[],
  expectedSnapshotSha: string,
): Map<string, Record<string, string>> {
  const problems: string[] = [];
  const byId = new Map<string, Record<string, string>>();
  for (const row of rows) {
    if (byId.has(row.caseId)) problems.push(`duplicate caseId in pending csv: ${row.caseId}`);
    byId.set(row.caseId, row);
  }
  const manifestById = new Map(manifestCases.map((c) => [c.caseId, c]));
  for (const [caseId, row] of byId) {
    const mc = manifestById.get(caseId);
    if (!mc) {
      problems.push(`pending case not in manifest: ${caseId}`);
      continue;
    }
    if (row.pairKey !== mc.pairKey) problems.push(`pairKey mismatch for ${caseId}`);
    const [a, b] = pairKeyClusters(row.pairKey);
    if (!(a === mc.leftClusterId && b === mc.rightClusterId) && !(a === mc.rightClusterId && b === mc.leftClusterId)) {
      problems.push(`cluster direction mismatch for ${caseId}`);
    }
    if (mc.snapshotSha256 !== expectedSnapshotSha) problems.push(`manifest case snapshot sha mismatch for ${caseId}`);
  }
  for (const mc of manifestCases) {
    if (!byId.has(mc.caseId)) problems.push(`manifest case missing from pending csv: ${mc.caseId}`);
  }
  if (problems.length > 0) throw new InvalidInputError(`pending/manifest inconsistent:\n- ${problems.join("\n- ")}`);
  return byId;
}

type FrozenManifest = {
  schemaVersion: 1;
  purpose: string;
  createdAt: string;
  asOf: string;
  baseCommit: string;
  methodVersion: string;
  strategyNote: string;
  snapshot: { path: string; sha256: string };
  sourceFiles: { pendingCsv: { path: string; sha256: string }; samplingManifest: { path: string; sha256: string } };
  baseline: { status: "deferred"; note: string; legacyCli: { path: string; sha256: string } };
  splitPolicy: string;
  clusterComponents: Array<{ caseIds: string[] }>;
  cases: Array<{
    caseId: string;
    split: "dev" | "holdout";
    sourceStratum: string;
    inputSha256: string;
    clusterIds: [string, string];
  }>;
};

function gitBaseCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export function buildFrozenManifest(input: {
  now?: Date;
  snapshotPath: string;
  samplingManifestPath: string;
  samplingManifest: { createdAt?: string; snapshot?: { sha256?: string } };
  pendingCsvPath: string;
  cases: Array<{ caseId: string; split: "dev" | "holdout"; sourceStratum: string; inputSha256: string; clusterIds: [string, string] }>;
  components: Array<{ caseIds: string[] }>;
}): FrozenManifest {
  const scriptPath = fileURLToPath(import.meta.url);
  const legacyCliPath = path.join(path.dirname(scriptPath), "eval-bm25-vs-lexical.ts");
  return {
    schemaVersion: 1,
    purpose: "Private frozen fixture for cluster-quality human review; do not hand to blind reviewers.",
    createdAt: (input.now ?? new Date()).toISOString(),
    asOf: input.samplingManifest.createdAt ?? "unknown",
    baseCommit: gitBaseCommit(),
    methodVersion: sha256File(scriptPath),
    strategyNote:
      "Split policy code is frozen via methodVersion; current git HEAD is recorded as a parameter only. The legacy lexical scorer in eval-bm25-vs-lexical.ts is NOT the current production strategy.",
    snapshot: { path: input.snapshotPath, sha256: sha256File(input.snapshotPath) },
    sourceFiles: {
      pendingCsv: { path: input.pendingCsvPath, sha256: sha256File(input.pendingCsvPath) },
      samplingManifest: { path: input.samplingManifestPath, sha256: sha256File(input.samplingManifestPath) },
    },
    baseline: {
      status: "deferred",
      note: "Baseline deferred, not completed: no human labels exist yet. The legacy replay output would be diagnostic_only (legacy lexical vs BM25), not the current end-to-end AI pipeline, and must never be presented as a quality result.",
      legacyCli: { path: legacyCliPath, sha256: fs.existsSync(legacyCliPath) ? sha256File(legacyCliPath) : "missing" },
    },
    splitPolicy: "whole connected components over shared cluster ids; deterministic 2:1 dev:holdout strata balancing; no component spans splits",
    clusterComponents: input.components,
    cases: input.cases,
  };
}

export function writePrepareOutputs(outDir: string, frozen: FrozenManifest, blindRows: string[][]): void {
  // Collision guard before touching anything: a populated target dir may hold
  // human labels from a previous review; refuse instead of overwriting. There
  // is no --force; pick a fresh (date-stamped) directory.
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) {
    throw new InvalidInputError(
      `out-dir already exists and is not empty: ${outDir}; refusing to overwrite existing review files — choose a new directory`,
    );
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, BLIND_CSV_NAME), stringifyCsv(blindRows), "utf8");
  const manifestPath = path.join(outDir, FROZEN_MANIFEST_NAME);
  fs.writeFileSync(manifestPath, JSON.stringify(frozen, null, 2), "utf8");
  // Convenience sidecar only: the real trust anchor is the manifest digest the
  // root records externally (assess requires --expected-manifest-sha). A side
  // file in the same directory cannot protect against an attacker who can
  // rewrite both files.
  fs.writeFileSync(path.join(outDir, FROZEN_MANIFEST_SHA_NAME), `${sha256File(manifestPath)}\n`, "utf8");
}

export function runPrepare(args: {
  snapshot: string;
  labels: string;
  manifest: string;
  outDir: string;
  now?: Date;
}): { dev: number; holdout: number; outDir: string } {
  const samplingManifest = JSON.parse(fs.readFileSync(args.manifest, "utf8"));
  const expectedSnapshotSha: string = samplingManifest?.snapshot?.sha256;
  if (!expectedSnapshotSha) throw new InvalidInputError("sampling manifest has no snapshot.sha256");
  const actualSnapshotSha = sha256File(args.snapshot);
  if (actualSnapshotSha !== expectedSnapshotSha) {
    throw new InvalidInputError(`snapshot sha mismatch: expected ${expectedSnapshotSha}, got ${actualSnapshotSha}`);
  }

  const pendingRows = loadCsvTable(
    fs.readFileSync(args.labels, "utf8"),
    ["caseId", ...INPUT_FIELDS, ...HUMAN_FIELDS],
    [...BLIND_COLUMNS, ...LEGACY_PENDING_EXTRA_COLUMNS],
    "pending csv",
  );
  const manifestCases: ReviewCase[] = samplingManifest.cases;
  if (!Array.isArray(manifestCases) || manifestCases.length !== samplingManifest.caseCount) {
    throw new InvalidInputError("sampling manifest caseCount inconsistent with cases array");
  }
  if (pendingRows.length !== manifestCases.length) {
    throw new InvalidInputError(`expected ${manifestCases.length} pending rows, got ${pendingRows.length}`);
  }
  validatePendingAgainstManifest(pendingRows, manifestCases, expectedSnapshotSha);
  for (const row of pendingRows) {
    if (!row.leftTitle?.trim()) throw new InvalidInputError(`pending case ${row.caseId}: leftTitle must not be empty`);
    if (row.reviewStatus && row.reviewStatus !== "pending") {
      throw new InvalidInputError(`pending case ${row.caseId}: reviewStatus must be pending in a pending packet`);
    }
    const filledHuman = HUMAN_FIELDS.filter((f) => f !== "reviewStatus" && row[f]?.trim());
    if (filledHuman.length > 0) {
      throw new InvalidInputError(`pending case ${row.caseId}: human fields must be blank in a pending packet (${filledHuman.join(", ")})`);
    }
  }

  const reviewCases = manifestCases.map((mc) => ({
    caseId: mc.caseId,
    pairKey: mc.pairKey,
    leftClusterId: mc.leftClusterId,
    rightClusterId: mc.rightClusterId,
    sourceStratum: mc.sourceStratum,
    snapshotSha256: mc.snapshotSha256,
  }));
  const components = buildComponents(reviewCases);
  const stratumByCase: Record<string, string> = Object.fromEntries(reviewCases.map((c) => [c.caseId, c.sourceStratum]));
  const { dev, holdout } = assignSplits(components, stratumByCase);
  const splitOf = new Map<string, "dev" | "holdout">();
  for (const id of dev) splitOf.set(id, "dev");
  for (const id of holdout) splitOf.set(id, "holdout");

  const header: string[] = [...BLIND_COLUMNS];
  const blindRows: string[][] = [header];
  const frozenCases: FrozenManifest["cases"] = [];
  for (const row of pendingRows) {
    const inputSha = canonicalInputSha(row.caseId, row);
    blindRows.push([
      row.caseId,
      ...INPUT_FIELDS.map((f) => row[f] ?? ""),
      "pending",
      "",
      "",
      "",
      "",
    ]);
    const mc = manifestCases.find((c) => c.caseId === row.caseId)!;
    frozenCases.push({
      caseId: row.caseId,
      split: splitOf.get(row.caseId)!,
      sourceStratum: mc.sourceStratum,
      inputSha256: inputSha,
      clusterIds: pairKeyClusters(row.pairKey),
    });
  }
  frozenCases.sort((a, b) => (a.caseId < b.caseId ? -1 : 1));

  const frozen = buildFrozenManifest({
    now: args.now,
    snapshotPath: args.snapshot,
    samplingManifestPath: args.manifest,
    samplingManifest,
    pendingCsvPath: args.labels,
    cases: frozenCases,
    components: components.map((c) => ({ caseIds: c.caseIds })),
  });
  writePrepareOutputs(args.outDir, frozen, blindRows);
  return { dev: dev.length, holdout: holdout.length, outDir: args.outDir };
}

export type ReadinessRow = {
  caseId: string;
  inputSha256: string;
  reviewStatus: string;
  humanLabel: string;
  reviewer: string;
  reviewedAt: string;
};

export type ReadinessResult = {
  status: "ready_for_replay" | "insufficient_truth";
  qualityPassed: false;
  qualityPassedNote: string;
  aiCounts: "not_measured";
  aiCost: "not_measured";
  baseline: "deferred_not_completed";
  invalid: string[];
  coverage: { total: number; eligible: number; reviewedUncertain: number; pending: number; excluded: number };
  metrics: null | {
    dev: SplitMetrics;
    holdout: SplitMetrics;
  };
};

type SplitMetrics = { scorable: boolean; eligible: number; same: number; diff: number; uncertain: number };

function parseReviewedAt(value: string): boolean {
  if (!value?.trim()) return false;
  const t = Date.parse(value);
  return Number.isFinite(t);
}

/**
 * Pure readiness assessment. Fail-closed: any structural problem (unknown /
 * duplicate / missing case, tampered input checksum) is invalid input.
 * Uncertain labels are counted separately and never counted as diff.
 * Rows with blank reviewer or unparseable reviewedAt are excluded, not scored.
 */
export function assessReadiness(
  frozen: Pick<FrozenManifest, "cases" | "snapshot">,
  labelsRows: Array<Record<string, string>>,
  opts: { snapshotShaActual?: string } = {},
): ReadinessResult {
  const invalid: string[] = [];
  const frozenById = new Map(frozen.cases.map((c) => [c.caseId, c]));
  const seen = new Set<string>();
  const byId = new Map<string, Record<string, string>>();

  for (const row of labelsRows) {
    const id = row.caseId;
    if (!frozenById.has(id)) {
      invalid.push(`unknown case in labels: ${id}`);
      continue;
    }
    if (seen.has(id)) {
      invalid.push(`duplicate case in labels: ${id}`);
      continue;
    }
    seen.add(id);
    byId.set(id, row);
    const expected = frozenById.get(id)!.inputSha256;
    const actual = canonicalInputSha(id, row);
    if (actual !== expected) invalid.push(`input checksum mismatch for ${id} (inputs must not change after freeze)`);
  }
  for (const c of frozen.cases) {
    if (!byId.has(c.caseId)) invalid.push(`missing case in labels: ${c.caseId}`);
  }
  if (opts.snapshotShaActual !== undefined && opts.snapshotShaActual !== frozen.snapshot.sha256) {
    invalid.push(`snapshot sha mismatch: frozen ${frozen.snapshot.sha256}, actual ${opts.snapshotShaActual}`);
  }

  const result: ReadinessResult = {
    status: "insufficient_truth",
    qualityPassed: false,
    qualityPassedNote: "quality_passed is never emitted by this tool; the best outcome is ready_for_replay",
    aiCounts: "not_measured",
    aiCost: "not_measured",
    baseline: "deferred_not_completed",
    invalid,
    coverage: { total: frozen.cases.length, eligible: 0, reviewedUncertain: 0, pending: 0, excluded: 0 },
    metrics: null,
  };
  if (invalid.length > 0) return result;

  const labelsById = new Map(frozen.cases.map((c) => [c.caseId, c.split]));
  const perSplit: Record<"dev" | "holdout", SplitMetrics> = {
    dev: { scorable: false, eligible: 0, same: 0, diff: 0, uncertain: 0 },
    holdout: { scorable: false, eligible: 0, same: 0, diff: 0, uncertain: 0 },
  };
  for (const row of labelsRows) {
    const split = labelsById.get(row.caseId);
    if (!split) continue;
    const reviewed = row.reviewStatus === "reviewed";
    const reviewerOk = Boolean(row.reviewer?.trim());
    const timeOk = parseReviewedAt(row.reviewedAt);
    if (!reviewed) {
      result.coverage.pending += 1;
      continue;
    }
    if (!reviewerOk || !timeOk) {
      result.coverage.excluded += 1;
      continue;
    }
    if (row.humanLabel === "uncertain") {
      result.coverage.reviewedUncertain += 1;
      perSplit[split].uncertain += 1;
      continue;
    }
    if (row.humanLabel !== "same" && row.humanLabel !== "diff") {
      result.coverage.excluded += 1;
      continue;
    }
    result.coverage.eligible += 1;
    perSplit[split].eligible += 1;
    if (row.humanLabel === "same") perSplit[split].same += 1;
    else perSplit[split].diff += 1;
  }

  const holdoutIncomplete = perSplit.holdout.same === 0 || perSplit.holdout.diff === 0;
  const devIncomplete = perSplit.dev.same === 0 || perSplit.dev.diff === 0;
  if (
    result.coverage.eligible === 0 ||
    result.coverage.pending > 0 ||
    holdoutIncomplete ||
    devIncomplete
  ) {
    return { ...result, metrics: null };
  }
  perSplit.dev.scorable = true;
  perSplit.holdout.scorable = true;
  return { ...result, status: "ready_for_replay", metrics: { dev: perSplit.dev, holdout: perSplit.holdout } };
}

export function validateFrozenManifest(frozen: unknown): FrozenManifest {
  if (typeof frozen !== "object" || frozen === null) throw new InvalidInputError("frozen manifest is not an object");
  const m = frozen as Record<string, unknown>;
  if (m.schemaVersion !== 1) throw new InvalidInputError(`unsupported frozen manifest schemaVersion: ${String(m.schemaVersion)}`);
  if (typeof m.methodVersion !== "string" || !m.methodVersion.trim()) {
    throw new InvalidInputError("frozen manifest methodVersion must be a non-empty string");
  }
  if (typeof m.snapshot !== "object" || m.snapshot === null || typeof (m.snapshot as Record<string, unknown>).sha256 !== "string") {
    throw new InvalidInputError("frozen manifest snapshot.sha256 missing");
  }
  if (!Array.isArray(m.cases) || m.cases.length === 0) throw new InvalidInputError("frozen manifest cases must be a non-empty array");
  for (const c of m.cases as Array<Record<string, unknown>>) {
    if (typeof c.caseId !== "string" || !c.caseId) throw new InvalidInputError("frozen manifest case missing caseId");
    if (c.split !== "dev" && c.split !== "holdout") throw new InvalidInputError(`case ${String(c.caseId)}: invalid split`);
    if (typeof c.inputSha256 !== "string" || !/^[0-9a-f]{64}$/.test(c.inputSha256)) {
      throw new InvalidInputError(`case ${String(c.caseId)}: invalid inputSha256`);
    }
  }
  return frozen as FrozenManifest;
}

export function runAssess(args: {
  frozen: string;
  expectedManifestSha: string;
  labels: string;
  out: string;
}): { status: string; report: ReadinessResult; manifestShaActual: string } {
  if (!args.expectedManifestSha?.trim()) {
    throw new InvalidInputError("expectedManifestSha is required: the trust anchor is the digest recorded externally by the root, not the sidecar file");
  }
  // Verify the manifest digest BEFORE parsing it or trusting any path inside.
  const manifestShaActual = sha256File(args.frozen);
  if (manifestShaActual !== args.expectedManifestSha.trim().toLowerCase()) {
    throw new InvalidInputError(`frozen manifest sha mismatch: expected ${args.expectedManifestSha.trim().toLowerCase()}, actual ${manifestShaActual}`);
  }
  const frozen = validateFrozenManifest(JSON.parse(fs.readFileSync(args.frozen, "utf8")));
  const snapshotShaActual = fs.existsSync(frozen.snapshot.path) ? sha256File(frozen.snapshot.path) : "missing";
  const labelsRows = loadCsvTable(fs.readFileSync(args.labels, "utf8"), BLIND_COLUMNS, BLIND_COLUMNS, "labels csv");
  const result = assessReadiness(frozen, labelsRows, { snapshotShaActual });
  const status = result.invalid.length > 0 ? "invalid_input" : result.status;
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify({ ...result, status }, null, 2), "utf8");
  return { status, report: result, manifestShaActual };
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key.startsWith("--")) throw new InvalidInputError(`unexpected argument: ${key}`);
    args[key.slice(2)] = argv[i + 1] ?? "";
  }
  return args;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));
  try {
    if (command === "prepare") {
      const result = runPrepare({
        snapshot: args.snapshot,
        labels: args.labels,
        manifest: args.manifest,
        outDir: args["out-dir"] || defaultOutDir(),
      });
      console.log(
        `[cluster-quality-review] prepared dev=${result.dev} holdout=${result.holdout} out=${result.outDir} (blind-review.csv + frozen-manifest.json; baseline deferred, no AI/network)`,
      );
      process.exitCode = EXIT_OK;
      return;
    }
    if (command === "assess") {
      const { status } = runAssess({
        frozen: args.frozen,
        expectedManifestSha: args["expected-manifest-sha"] ?? "",
        labels: args.labels,
        out: args.out,
      });
      console.log(`[cluster-quality-review] assess status=${status}`);
      process.exitCode =
        status === "invalid_input" ? EXIT_INVALID_INPUT : status === "insufficient_truth" ? EXIT_INSUFFICIENT_TRUTH : EXIT_OK;
      return;
    }
    throw new InvalidInputError(`unknown command: ${command}; usage: prepare|assess`);
  } catch (error) {
    if (error instanceof SplitError || error instanceof InvalidInputError) {
      console.error(`[cluster-quality-review] ${error.name}: ${error.message}`);
      process.exitCode = EXIT_INVALID_INPUT;
      return;
    }
    throw error;
  }
}

const isCli =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  void main();
}
