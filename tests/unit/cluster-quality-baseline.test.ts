// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

// node:sqlite ships in Node 22+/25+; @types/node@20 has no declarations for it.
// @ts-expect-error node:sqlite has no type declarations in @types/node@20
import { DatabaseSync } from "node:sqlite";

import { buildClusterMergeBm25Index } from "../../src/lib/clusters/bm25";
import {
  InvalidInputError, canonicalInputSha } from "../../scripts/eval-cluster-quality-review";
import {
  assessBaseline,
  buildStableDecisionDigest,
  classifyRejection,
  computeSplitMetrics,
  fingerprintCorpus,
  renderMarkdown,
  selectProductionCorpus,
  summarizeSamplingStrata,
  toClusterMergeCandidate,
  chooseAsOf,
  snapshotAsOfMs,
  verifyCaseFields,
  type CaseOutcome,
  type ClusterRow,
  type FrozenInput,
  type SamplingManifest,
  type SourceVersionFreeze,
} from "../../scripts/eval-cluster-quality-baseline";

const tmpRoots: string[] = [];

afterAll(() => {
  for (const root of tmpRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeTmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cluster-quality-baseline-"));
  tmpRoots.push(root);
  return root;
}

const CLUSTER_DDL = `CREATE TABLE content_clusters(
  id TEXT, title TEXT, summary TEXT, itemCount INT, latestPublishedAt NUM, status TEXT,
  eventType TEXT, eventSubject TEXT, eventAction TEXT, eventObject TEXT, eventDate TEXT,
  eventFingerprint TEXT, fingerprint TEXT, mergeInputHash TEXT, updatedAt NUM)`;

type FixtureCluster = Partial<ClusterRow> & { id: string };

function fixtureCluster(overrides: FixtureCluster): ClusterRow {
  return {
    title: `标题 ${overrides.id}`,
    summary: `摘要 ${overrides.id}`,
    itemCount: 1,
    latestPublishedAt: 1_800_000_000_000,
    status: "active",
    eventType: "other",
    eventSubject: `主体${overrides.id}`,
    eventAction: "发布",
    eventObject: `对象${overrides.id}`,
    eventDate: null,
    eventFingerprint: null,
    fingerprint: null,
    mergeInputHash: null,
    updatedAt: 1_800_000_000_000,
    ...overrides,
  };
}

function createFixtureDb(
  root: string,
  clusters: ClusterRow[],
  options: {
    withItemsSources?: boolean;
    minimalJoinColumns?: boolean;
    items?: Array<[id: string, clusterId: string, status: string, moderationStatus: string, parentItemId: string | null, sourceId: string]>;
    sources?: Array<[id: string, aggregationEnabled: number]>;
  } = {},
): string {
  const dbPath = path.join(root, "fixture.db");
  const db = new DatabaseSync(dbPath);
  db.exec(CLUSTER_DDL);
  db.exec("CREATE TABLE cluster_decisions(id TEXT)");
  if (options.withItemsSources) {
    if (options.minimalJoinColumns) {
      db.exec("CREATE TABLE items(id TEXT)");
      db.exec("CREATE TABLE sources(id TEXT)");
    } else {
      db.exec(
        "CREATE TABLE items(id TEXT, clusterId TEXT, status TEXT, moderationStatus TEXT, parentItemId TEXT, sourceId TEXT)",
      );
      db.exec("CREATE TABLE sources(id TEXT, aggregationEnabled INT)");
      // Fixture rows are written during setup; the selector is then exercised
      // through a readOnly connection so the real-snapshot protection is never
      // loosened.
      for (const row of options.sources ?? []) {
        db.prepare("INSERT INTO sources(id, aggregationEnabled) VALUES (?, ?)").run(...row);
      }
      for (const row of options.items ?? []) {
        db.prepare(
          "INSERT INTO items(id, clusterId, status, moderationStatus, parentItemId, sourceId) VALUES (?,?,?,?,?,?)",
        ).run(...row);
      }
    }
  }
  const insert = db.prepare(
    `INSERT INTO content_clusters(id, title, summary, itemCount, latestPublishedAt, status,
      eventType, eventSubject, eventAction, eventObject, eventDate, eventFingerprint, fingerprint,
      mergeInputHash, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const c of clusters) {
    insert.run(c.id, c.title, c.summary, c.itemCount, c.latestPublishedAt, c.status, c.eventType, c.eventSubject,
      c.eventAction, c.eventObject, c.eventDate, c.eventFingerprint, c.fingerprint, c.mergeInputHash, c.updatedAt);
  }
  db.close();
  return dbPath;
}

function sha256File(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function csvRowFor(row: Record<string, string>): Record<string, string> {
  return {
    reviewStatus: "reviewed",
    reviewer: "Shawn",
    reviewedAt: "2026-09-28T10:00:00Z",
    ...row,
  };
}

function buildInputs(options: {
  clusters: ClusterRow[];
  cases: Array<{ caseId: string; split: "dev" | "holdout"; leftId: string; rightId: string; label: "same" | "diff" }>;
  lookbackSinceMs: number;
}): Parameters<typeof assessBaseline>[0] {
  const clustersById = new Map(options.clusters.map((c) => [c.id, c]));
  const sampling: SamplingManifest = {
    cases: options.cases.map((c) => ({
      caseId: c.caseId,
      // Direction deliberately NOT sorted-id order: manifest is authoritative.
      leftClusterId: c.leftId,
      rightClusterId: c.rightId,
      sourceStratum: "high_lexical_score_declined",
    })),
  };
  const labelsRows = options.cases.map((c) => {
    const left = clustersById.get(c.leftId)!;
    const right = clustersById.get(c.rightId)!;
    return csvRowFor({
      caseId: c.caseId,
      pairKey: `${c.leftId}|${c.rightId}`,
      leftTitle: left.title,
      leftSummary: left.summary ?? "",
      leftEventType: left.eventType ?? "",
      leftEventSubject: left.eventSubject ?? "",
      leftEventAction: left.eventAction ?? "",
      leftEventObject: left.eventObject ?? "",
      leftEventDate: left.eventDate ?? "",
      leftItemCount: String(left.itemCount),
      leftLatestPublishedAt: String(left.latestPublishedAt),
      rightTitle: right.title,
      rightSummary: right.summary ?? "",
      rightEventType: right.eventType ?? "",
      rightEventSubject: right.eventSubject ?? "",
      rightEventAction: right.eventAction ?? "",
      rightEventObject: right.eventObject ?? "",
      rightEventDate: right.eventDate ?? "",
      rightItemCount: String(right.itemCount),
      rightLatestPublishedAt: String(right.latestPublishedAt),
      humanLabel: c.label,
    });
  });
  const frozen: FrozenInput = {
    snapshotSha256: "f".repeat(64),
    samplingManifestSha256: "e".repeat(64),
    cases: options.cases.map((c, i) => ({
      caseId: c.caseId,
      split: c.split,
      inputSha256: canonicalInputSha(c.caseId, labelsRows[i]!),
      clusterIdsUnordered: [c.leftId, c.rightId].sort() as [string, string],
    })),
  };
  const sourceVersion: SourceVersionFreeze = { gitHead: "test", sourceCode: { "scripts/eval-cluster-quality-baseline.ts": "test" } };
  return {
    frozen,
    frozenManifestShaActual: frozen.samplingManifestSha256,
    labelsRows,
    labelsCsvSha256: "d".repeat(64),
    sampling,
    samplingManifestShaActual: frozen.samplingManifestSha256,
    snapshotShaActual: frozen.snapshotSha256,
    snapshotUnchangedAfterRun: true,
    corpus: options.clusters,
    clustersById,
    asOfMs: 1_800_000_000_000,
    asOfBasis: "snapshot_active_max_latestPublishedAt",
    lookbackSinceMs: options.lookbackSinceMs,
    missingTables: ["items", "sources"],
    itemsSourceFilter: "unavailable_missing_tables:items,sources",
    sourceVersion,
  };
}

const BASE_MS = 1_800_000_000_000;
const LOOKBACK_MS = BASE_MS - 7 * 24 * 60 * 60 * 1000;

describe("input integrity", () => {
  it("rejects a snapshot sha mismatch (tamper/wrong sha)", () => {
    const root = makeTmpRoot();
    const clusters = [fixtureCluster({ id: "a" })];
    const dbPath = createFixtureDb(root, clusters);
    const before = sha256File(dbPath);
    const inputs = buildInputs({
      clusters,
      cases: [{ caseId: "C1", split: "dev", leftId: "a", rightId: "a", label: "same" }],
      lookbackSinceMs: LOOKBACK_MS,
    });
    // Same-fingerprint channel requires distinct clusters; a self-pair is fine here
    // because we only assert the sha gate, before any scoring.
    expect(() => assessBaseline({ ...inputs, snapshotShaActual: "0".repeat(64) })).toThrow(/snapshot sha mismatch/);
    expect(sha256File(dbPath)).toBe(before);
  });

  it("flags tampered frozen input fields as checksum mismatch and excludes the case", () => {
    const clusters = [fixtureCluster({ id: "a" }), fixtureCluster({ id: "b" })];
    const inputs = buildInputs({
      clusters,
      cases: [{ caseId: "C1", split: "dev", leftId: "a", rightId: "b", label: "same" }],
      lookbackSinceMs: LOOKBACK_MS,
    });
    const tampered = inputs.labelsRows.map((row) => ({ ...row, leftTitle: "被篡改的标题" }));
    const { report, outcomes } = assessBaseline({ ...inputs, labelsRows: tampered });
    expect(report.coverage.invalid.some((msg) => msg.includes("input checksum mismatch"))).toBe(true);
    expect(outcomes[0]!.eligibility).toBe("excluded");
    expect(outcomes[0]!.admitted).toBeNull();
    expect(report.status).toBe("diagnostic_incomplete");
  });
});

describe("direction mapping and field drift", () => {
  // Full field rows, not just titles: verifyCaseFields compares every input
  // column, so partial fixtures would report bogus drift.
  function csvRowForClusters(left: ClusterRow, right: ClusterRow): Record<string, string> {
    const side = (prefix: string, c: ClusterRow) => ({
      [`${prefix}Title`]: c.title,
      [`${prefix}Summary`]: c.summary ?? "",
      [`${prefix}EventType`]: c.eventType ?? "",
      [`${prefix}EventSubject`]: c.eventSubject ?? "",
      [`${prefix}EventAction`]: c.eventAction ?? "",
      [`${prefix}EventObject`]: c.eventObject ?? "",
      [`${prefix}EventDate`]: c.eventDate ?? "",
      [`${prefix}ItemCount`]: String(c.itemCount),
      [`${prefix}LatestPublishedAt`]: String(c.latestPublishedAt),
    });
    return csvRowFor({ ...side("left", left), ...side("right", right) });
  }

  it("maps CSV sides via sampling-manifest direction, not sorted ids", () => {
    const left = fixtureCluster({ id: "zzz" });
    const right = fixtureCluster({ id: "aaa", title: "另一个标题" });
    const byId = new Map([[left.id, left], [right.id, right]]);
    const row = csvRowForClusters(left, right);
    // Manifest says left=zzz though sorted order would put aaa first.
    const ok = verifyCaseFields(row, { caseId: "C", leftClusterId: "zzz", rightClusterId: "aaa", sourceStratum: "s" }, byId);
    expect(ok.driftFields).toEqual([]);
    const swapped = verifyCaseFields(row, { caseId: "C", leftClusterId: "aaa", rightClusterId: "zzz", sourceStratum: "s" }, byId);
    expect(swapped.driftFields).toContain("leftTitle");
    expect(swapped.driftFields).toContain("rightTitle");
  });

  it("excludes itemCount drift as stale_field_not_reconstructed without adopting newer DB values", () => {
    // CSV/frozen inputs record itemCount 5; the snapshot row only has 1 — the
    // frozen human input must never be silently replaced by the DB value.
    const csvClusters = [fixtureCluster({ id: "a" }), fixtureCluster({ id: "b", itemCount: 5 })];
    const dbClusters = [fixtureCluster({ id: "a" }), fixtureCluster({ id: "b", itemCount: 1 })];
    const inputs = buildInputs({
      clusters: csvClusters,
      cases: [{ caseId: "C1", split: "dev", leftId: "a", rightId: "b", label: "diff" }],
      lookbackSinceMs: LOOKBACK_MS,
    });
    const { report, outcomes } = assessBaseline({
      ...inputs,
      corpus: dbClusters,
      clustersById: new Map(dbClusters.map((c) => [c.id, c])),
    });
    expect(outcomes[0]!.excludedReason).toBe("stale_field_not_reconstructed");
    expect(outcomes[0]!.fieldDrift).toContain("rightItemCount");
    expect(report.coverage.eligible).toBe(0);
    expect(report.metrics.dev.diff.total).toBe(0);
  });

  it("does not count an expired case as a true negative", () => {
    const clusters = [
      fixtureCluster({ id: "a", latestPublishedAt: BASE_MS }),
      fixtureCluster({ id: "b", latestPublishedAt: BASE_MS }),
      fixtureCluster({ id: "old", latestPublishedAt: BASE_MS - 8 * 24 * 60 * 60 * 1000 }),
      fixtureCluster({ id: "old2", latestPublishedAt: BASE_MS - 8 * 24 * 60 * 60 * 1000 }),
    ];
    const inputs = buildInputs({
      clusters,
      cases: [{ caseId: "C1", split: "dev", leftId: "old", rightId: "old2", label: "diff" }],
      lookbackSinceMs: LOOKBACK_MS,
    });
    const { report, outcomes } = assessBaseline(inputs);
    expect(outcomes[0]!.excludedReason).toBe("out_of_lookback_window");
    expect(report.metrics.dev.diff).toEqual({ total: 0, admitted: 0, notAdmitted: 0 });
    expect(report.metrics.dev.differentEventCandidateAdmissionRate).toBeNull();
  });
});

describe("metrics semantics", () => {
  it("returns null rates for a missing class instead of a perfect pass", () => {
    const outcomes: CaseOutcome[] = [
      { caseId: "C1", split: "dev", sourceStratum: "s", humanLabel: "same", eligibility: "eligible", admitted: true },
    ];
    const metrics = computeSplitMetrics(outcomes, "dev");
    expect(metrics.sameEventCandidateAdmissionRecall).toBe(1);
    expect(metrics.differentEventCandidateAdmissionRate).toBeNull();
  });

  it("keeps dev and holdout isolated and marks holdout aggregation-only", () => {
    const outcomes: CaseOutcome[] = [
      { caseId: "D1", split: "dev", sourceStratum: "s", humanLabel: "same", eligibility: "eligible", admitted: false },
      { caseId: "H1", split: "holdout", sourceStratum: "s", humanLabel: "same", eligibility: "eligible", admitted: true },
    ];
    const dev = computeSplitMetrics(outcomes, "dev");
    const holdout = computeSplitMetrics(outcomes, "holdout");
    expect(dev.same).toEqual({ total: 1, admitted: 0, notAdmitted: 1 });
    expect(holdout.same).toEqual({ total: 1, admitted: 1, notAdmitted: 0 });
    expect(holdout.aggregationOnly).toBe(true);
    expect(dev.aggregationOnly).toBe(false);
  });
});

function integrationClusters(): ClusterRow[] {
  const sameEvent = {
    eventFingerprint: "fp-same",
    eventSubject: "苹果",
    eventAction: "发布",
    eventObject: "耳机",
  };
  return [
    fixtureCluster({ id: "same1", title: "苹果 发布 耳机 新品", eventFingerprint: sameEvent.eventFingerprint, eventSubject: sameEvent.eventSubject, eventObject: sameEvent.eventObject }),
    fixtureCluster({ id: "same2", title: "苹果 发布 耳机 评测", eventFingerprint: sameEvent.eventFingerprint, eventSubject: sameEvent.eventSubject, eventObject: sameEvent.eventObject }),
    fixtureCluster({ id: "diff1", title: "索尼 相机 旗舰 机型" }),
    fixtureCluster({ id: "diff2", title: "丰田 汽车 召回 通知" }),
  ];
}

describe("real helper integration on a fixture corpus", () => {
  it("admits the same-event pair as candidate and rejects the disjoint diff pair with evidence", () => {
    const clusters = integrationClusters();
    const inputs = buildInputs({
      clusters,
      cases: [
        { caseId: "S1", split: "dev", leftId: "same1", rightId: "same2", label: "same" },
        { caseId: "D9", split: "dev", leftId: "diff1", rightId: "diff2", label: "diff" },
      ],
      lookbackSinceMs: LOOKBACK_MS,
    });
    const { report, outcomes } = assessBaseline(inputs);
    const sameOutcome = outcomes.find((o) => o.caseId === "S1")!;
    const diffOutcome = outcomes.find((o) => o.caseId === "D9")!;
    expect(sameOutcome.eligibility).toBe("eligible");
    // Candidate admission via the real helper: the same-event pair must be an
    // allowedPair (a candidate for AI merge), NOT a final merge decision.
    expect(sameOutcome.admitted).toBe(true);
    expect(report.metrics.dev.sameEventCandidateAdmissionRecall).toBe(1);
    expect(diffOutcome.admitted).toBe(false);
    expect(diffOutcome.rejectionReason).toBeDefined();
    expect(diffOutcome.rejectionReason).toMatch(/^(bm25_zero|clean_pair_not_scanned|not_selected_with_available_diagnostics|safety_rejected:)/);
    expect(diffOutcome.rejectionReason).not.toBe("not_selected_topk");
    expect(report.metrics.dev.differentEventCandidateAdmissionRate).toBe(0);
    expect(report.stage).toBe("production_candidate_selector_snapshot_counterfactual");
  });

  it("marks the vector channel disabled and reports live endpoints as counterfactual", () => {
    const clusters = integrationClusters();
    const inputs = buildInputs({
      clusters,
      cases: [{ caseId: "S1", split: "dev", leftId: "same1", rightId: "same2", label: "same" }],
      lookbackSinceMs: LOOKBACK_MS,
    });
    const { report } = assessBaseline(inputs);
    expect(report.notMeasured.vectorRecallChannel).toBe("disabled_not_measured");
    expect(report.scenarioFaithfulness.liveEndpoints).toBe("counterfactual_reviewed_endpoints_live");
    expect(report.scenarioFaithfulness.liveClusterIdCount).toBe(2);
    expect(report.releaseEligible).toBe(false);
  });

  it("produces a deterministic stable digest excluding timing", () => {
    const clusters = integrationClusters();
    const inputs = buildInputs({
      clusters,
      cases: [
        { caseId: "S1", split: "dev", leftId: "same1", rightId: "same2", label: "same" },
        { caseId: "D9", split: "holdout", leftId: "diff1", rightId: "diff2", label: "diff" },
      ],
      lookbackSinceMs: LOOKBACK_MS,
    });
    const run1 = assessBaseline(inputs);
    const run2 = assessBaseline(inputs);
    // offlineRuntimeMs differs run-to-run but is excluded from the digest.
    run2.report.offlineRuntimeMs = run1.report.offlineRuntimeMs + 999;
    expect(run1.report.stableDecisionDigest).toBe(run2.report.stableDecisionDigest);
    const digestDirect = buildStableDecisionDigest({
      provenance: {
        snapshotSha256: inputs.snapshotShaActual,
        frozenManifestSha256: inputs.frozenManifestShaActual,
        samplingManifestSha256: inputs.samplingManifestShaActual,
        labelsCsvSha256: inputs.labelsCsvSha256,
        corpusFingerprint: fingerprintCorpus(inputs.corpus),
      },
      scenario: {
        asOfMs: BASE_MS,
        asOfBasis: "snapshot_active_max_latestPublishedAt",
        lookbackSinceMs: LOOKBACK_MS,
        scanClusterLimit: 2500,
        candidateLimit: 80,
        relatedPairLimit: 3,
        liveClusterIds: ["same1", "same2", "diff1", "diff2"],
        vectorMode: "disabled_not_measured",
        missingTables: ["items", "sources"],
        itemsSourceFilter: "unavailable_missing_tables:items,sources",
      },
      outcomes: run1.outcomes,
      metrics: run1.report.metrics,
      sourceVersion: inputs.sourceVersion,
    });
    expect(digestDirect).toBe(run1.report.stableDecisionDigest);
  });

  it("changes the digest when any provenance input SHA changes, same outcomes aside", () => {
    const clusters = integrationClusters();
    const inputs = buildInputs({
      clusters,
      cases: [{ caseId: "S1", split: "dev", leftId: "same1", rightId: "same2", label: "same" }],
      lookbackSinceMs: LOOKBACK_MS,
    });
    const run1 = assessBaseline(inputs);
    const run2 = assessBaseline({ ...inputs, labelsCsvSha256: "a".repeat(64) });
    expect(run2.report.stableDecisionDigest).not.toBe(run1.report.stableDecisionDigest);
    const run3 = assessBaseline({
      ...inputs,
      corpus: clusters.map((c) => ({ ...c, itemCount: c.itemCount + 1 })),
      clustersById: new Map(
        clusters.map((c) => [c.id, { ...c, itemCount: c.itemCount + 1 } as ClusterRow]),
      ),
    });
    expect(run3.report.stableDecisionDigest).not.toBe(run1.report.stableDecisionDigest);
  });
});

describe("snapshot DB translation", () => {
  it("selects the production window in order with the scan cap and reports missing items/sources tables", () => {
    const root = makeTmpRoot();
    const clusters = [
      fixtureCluster({ id: "recent1", latestPublishedAt: BASE_MS }),
      fixtureCluster({ id: "recent2", latestPublishedAt: BASE_MS - 1000 }),
      fixtureCluster({ id: "old", latestPublishedAt: LOOKBACK_MS - 1 }),
      fixtureCluster({ id: "inactive", latestPublishedAt: BASE_MS, status: "hidden" }),
    ];
    const dbPath = createFixtureDb(root, clusters);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(snapshotAsOfMs(db)).toBe(BASE_MS);
      const { corpus, missingTables, itemsSourceFilter } = selectProductionCorpus(db, LOOKBACK_MS);
      expect(corpus.map((c) => c.id)).toEqual(["recent1", "recent2"]);
      expect(missingTables).toEqual(["items", "sources"]);
      expect(itemsSourceFilter).toBe("unavailable_missing_tables:items,sources");
    } finally {
      db.close();
    }
    expect(sha256File(dbPath)).toBe(sha256File(dbPath));
  });

  it("enforces the production items/source EXISTS filter when both tables exist", () => {
    const root = makeTmpRoot();
    const clusters = [
      fixtureCluster({ id: "eligible", latestPublishedAt: BASE_MS }),
      fixtureCluster({ id: "noitems", latestPublishedAt: BASE_MS - 500 }),
    ];
    const dbPath = createFixtureDb(root, clusters, {
      withItemsSources: true,
      sources: [["s1", 1]],
      items: [
        ["i1", "eligible", "processed", "allowed", null, "s1"],
        ["i2", "noitems", "processed", "rejected", null, "s1"],
      ],
    });
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const { corpus, missingTables, itemsSourceFilter } = selectProductionCorpus(db, LOOKBACK_MS);
      expect(missingTables).toEqual([]);
      expect(itemsSourceFilter).toBe("enforced_production_exists_filter");
      expect(corpus.map((c) => c.id)).toEqual(["eligible"]);
    } finally {
      db.close();
    }
  });

  it("fails explicitly when required join columns are missing instead of loosening", () => {
    const root = makeTmpRoot();
    const clusters = [fixtureCluster({ id: "a" })];
    const dbPath = createFixtureDb(root, clusters, { withItemsSources: true, minimalJoinColumns: true });
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(() => selectProductionCorpus(db, LOOKBACK_MS)).toThrow(/missing required columns/);
    } finally {
      db.close();
    }
  });

  it("classifies a live pair with positive bm25 but absent edge as generic, not a guessed topk reason", () => {
    const clusters = [
      fixtureCluster({ id: "p1", title: "苹果 发布 耳机 新品介绍", eventSubject: "苹果", eventAction: "发布", eventObject: "耳机", eventFingerprint: "fp-x" }),
      fixtureCluster({ id: "p2", title: "苹果 发布 耳机 新品评测", eventSubject: "苹果", eventAction: "发布", eventObject: "耳机", eventFingerprint: "fp-y" }),
    ];
    const candidates = clusters.map(toClusterMergeCandidate);
    const index = buildClusterMergeBm25Index(candidates);
    const reason = classifyRejection(
      candidates[0]!,
      candidates[1]!,
      index,
      new Set(["p1", "p2"]),
    );
    expect(reason).toBe("not_selected_with_available_diagnostics");
  });

  it("reports field-comparison counts honestly: compared cases only, not a blanket no-drift claim", () => {
    const clusters = [
      fixtureCluster({ id: "a", latestPublishedAt: BASE_MS }),
      fixtureCluster({ id: "b", latestPublishedAt: BASE_MS }),
      fixtureCluster({ id: "o1", latestPublishedAt: BASE_MS - 8 * 24 * 60 * 60 * 1000 }),
      fixtureCluster({ id: "o2", latestPublishedAt: BASE_MS - 8 * 24 * 60 * 60 * 1000 }),
    ];
    const inputs = buildInputs({
      clusters,
      cases: [
        { caseId: "C1", split: "dev", leftId: "a", rightId: "b", label: "same" },
        { caseId: "C2", split: "dev", leftId: "o1", rightId: "o2", label: "diff" },
      ],
      lookbackSinceMs: LOOKBACK_MS,
    });
    const { report } = assessBaseline(inputs);
    expect(report.coverage.snapshotFieldComparison.comparedCases).toBe(1);
    expect(report.coverage.snapshotFieldComparison.notComparedCases).toBe(1);
    expect(report.coverage.eligible).toBe(1);
    expect(report.coverage.exclusions[0]!.reason).toBe("out_of_lookback_window");
  });
});

describe("markdown renderer", () => {
  it("renders actual counts and verbatim reasons without false topk or no-drift claims", () => {
    const clusters = [
      ...integrationClusters(),
      fixtureCluster({ id: "old8", latestPublishedAt: LOOKBACK_MS - 1 }),
      fixtureCluster({ id: "old9", latestPublishedAt: LOOKBACK_MS - 1 }),
    ];
    const inputs = buildInputs({
      clusters,
      cases: [
        { caseId: "S1", split: "dev", leftId: "same1", rightId: "same2", label: "same" },
        { caseId: "D9", split: "dev", leftId: "diff1", rightId: "diff2", label: "diff" },
        { caseId: "C3", split: "dev", leftId: "old9", rightId: "old8", label: "diff" },
      ],
      lookbackSinceMs: LOOKBACK_MS,
    });
    const { report } = assessBaseline(inputs);
    const md = renderMarkdown(report);
    expect(md).not.toContain("not_selected_topk");
    expect(md).not.toContain("无漂移");
    expect(md).toContain(`实际比对 ${report.coverage.snapshotFieldComparison.comparedCases}/${report.coverage.total}`);
    expect(md).toContain(`未比对 ${report.coverage.snapshotFieldComparison.notComparedCases}`);
    expect(md).toContain("out_of_lookback_window");
    for (const r of report.devRejectionReasons) {
      expect(md).toContain(r.reason);
    }
    expect(md).toContain(report.stableDecisionDigest);
  });
});

describe("sampling strata note", () => {
  const strataCases = (strata: string[]) => strata.map((sourceStratum, i) => ({ caseId: `C${i}`, sourceStratum }));
  const noteFor = (strata: string[]) =>
    `sampling strata are ${summarizeSamplingStrata(strataCases(strata))
      .map((e) => `${e.count} ${e.stratum}`)
      .join(" + ")} hard cases; rates are biased-sample diagnostics, not a global error rate`;

  it("aggregates legacy 36-case strata faithfully (12 + 24)", () => {
    const summary = summarizeSamplingStrata(
      strataCases([
        ...Array<string>(12).fill("same-event-fingerprint"),
        ...Array<string>(24).fill("high-lexical-score-declined"),
      ]),
    );
    expect(summary).toEqual([
      { stratum: "high-lexical-score-declined", count: 24 },
      { stratum: "same-event-fingerprint", count: 12 },
    ]);
    expect(summary.reduce((n, s) => n + s.count, 0)).toBe(36);
    const note = noteFor([
      ...Array<string>(12).fill("same-event-fingerprint"),
      ...Array<string>(24).fill("high-lexical-score-declined"),
    ]);
    expect(note).toContain("12 same-event-fingerprint");
    expect(note).toContain("24 high-lexical-score-declined");
  });

  it("aggregates the 24-case packet and never hardcodes the old 12/24 combination", () => {
    const strata = [
      ...Array<string>(18).fill("high_bm25_near_neighbor"),
      ...Array<string>(2).fill("safety_rejected_related"),
      ...Array<string>(4).fill("low_similarity_coverage"),
    ];
    const summary = summarizeSamplingStrata(strataCases(strata));
    expect(summary.reduce((n, s) => n + s.count, 0)).toBe(24);
    expect(summary).toEqual([
      { stratum: "high_bm25_near_neighbor", count: 18 },
      { stratum: "low_similarity_coverage", count: 4 },
      { stratum: "safety_rejected_related", count: 2 },
    ]);
    const note = noteFor(strata);
    // The stale 36-case wording must not appear in a 24-case report note.
    expect(note).not.toContain("12 same-event-fingerprint");
    expect(note).not.toContain("24 high-lexical-score");
    expect(note).toContain("18 high_bm25_near_neighbor");
    expect(note).toContain("2 safety_rejected_related");
    expect(note).toContain("4 low_similarity_coverage");
  });

  it("reports missing sourceStratum as unknown instead of inferring a stratum", () => {
    expect(summarizeSamplingStrata([{}, { sourceStratum: "" }])).toEqual([
      { stratum: "unknown", count: 2 },
    ]);
  });
});

describe("cli guard", () => {
  it("does not auto-execute the CLI on import", () => {
    expect(process.exitCode).toBeUndefined();
  });
});

describe("chooseAsOf", () => {
  const SNAPSHOT_MAX = 1_780_000_000_000; // below the 2026-10-02 capture epoch (~1.791e12)

  it("defaults to the legacy snapshot MAX anchor when --as-of is absent", () => {
    expect(chooseAsOf({ snapshotMaxMs: SNAPSHOT_MAX })).toEqual({
      ms: SNAPSHOT_MAX,
      basis: "snapshot_active_max_latestPublishedAt",
    });
    expect(chooseAsOf({ explicit: "", snapshotMaxMs: SNAPSHOT_MAX }).ms).toBe(SNAPSHOT_MAX);
  });

  it("accepts an explicit capture asOf that is newer than the snapshot MAX when it matches the frozen manifest", () => {
    const frozen = "2026-10-02T11:41:35.000Z";
    const result = chooseAsOf({
      explicit: "2026-10-02T19:41:35+08:00", // same instant, different notation
      frozenAsOf: frozen,
      snapshotMaxMs: SNAPSHOT_MAX,
    });
    expect(result.ms).toBe(Date.parse(frozen));
    expect(result.basis).toBe("capture_utc_explicit");
    expect(result.ms).toBeGreaterThan(SNAPSHOT_MAX);
  });

  it("rejects an explicit asOf that is not semantically equal to the frozen manifest asOf", () => {
    expect(() =>
      chooseAsOf({ explicit: "2026-10-02T11:41:36.000Z", frozenAsOf: "2026-10-02T11:41:35.000Z", snapshotMaxMs: SNAPSHOT_MAX }),
    ).toThrow(InvalidInputError);
  });

  it("rejects invalid explicit timestamps and invalid frozen asOf", () => {
    expect(() => chooseAsOf({ explicit: "not-a-time", snapshotMaxMs: SNAPSHOT_MAX })).toThrow(InvalidInputError);
    expect(() =>
      chooseAsOf({ explicit: "2026-10-02T11:41:35.000Z", frozenAsOf: "also-bad", snapshotMaxMs: SNAPSHOT_MAX }),
    ).toThrow(InvalidInputError);
  });
});
