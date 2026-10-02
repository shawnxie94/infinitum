import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

// node:sqlite ships in Node 22+/25+; @types/node@20 has no declarations for it.
// @ts-expect-error node:sqlite has no type declarations in @types/node@20
import { DatabaseSync } from "node:sqlite";

import {
  DEFAULT_SEED,
  DEFAULT_TARGET_PAIRS,
  SNAPSHOT_COLUMNS,
  SNAPSHOT_TABLES,
  assertRawWhitelist,
  buildPendingRows,
  buildSamplingManifest,
  chooseSamplePairs,
  sanitizeSnapshot,
  scorePairUniverse,
  seededOrder,
  stratumOf,
  verifyManifestAgainstSnapshot,
  verifyPendingFieldsAgainstSnapshot,
  type PairCandidate,
  type SelectedPair,
} from "../../scripts/prepare-cluster-quality-sample";
import { InvalidInputError } from "../../scripts/eval-cluster-quality-review";
import type { ClusterRow } from "../../scripts/eval-cluster-quality-baseline";

const tmpRoots: string[] = [];

afterAll(() => {
  for (const root of tmpRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeTmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cluster-quality-sample-"));
  tmpRoots.push(root);
  return root;
}

function sha256File(p: string): string {
  return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

const RAW_DDL = `
CREATE TABLE content_clusters(
  id TEXT, title TEXT, summary TEXT, itemCount INT, latestPublishedAt NUM, status TEXT,
  eventType TEXT, eventSubject TEXT, eventAction TEXT, eventObject TEXT, eventDate TEXT,
  eventFingerprint TEXT, fingerprint TEXT, mergeInputHash TEXT, updatedAt NUM);
CREATE TABLE items(
  id TEXT, clusterId TEXT, status TEXT, moderationStatus TEXT, parentItemId TEXT, sourceId TEXT);
CREATE TABLE sources(id TEXT, aggregationEnabled INT);
CREATE TABLE settings(key TEXT, value TEXT);
CREATE TABLE model_api_configs(id TEXT, api_key TEXT);
INSERT INTO settings VALUES('modelApiKey','sk-secret-should-never-leak');
INSERT INTO model_api_configs VALUES('m1','sk-raw-key-value');
`;

function fixtureCluster(overrides: Partial<ClusterRow> & { id: string }): ClusterRow {
  return {
    title: `标题 ${overrides.id}`,
    summary: `摘要 ${overrides.id}`,
    itemCount: 1,
    latestPublishedAt: 1_800_000_000_000,
    status: "active",
    eventType: "release",
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

function createRawDb(root: string, clusters: ClusterRow[]): string {
  const dbPath = path.join(root, "raw.db");
  const db = new DatabaseSync(dbPath);
  db.exec(RAW_DDL);
  const insert = db.prepare(
    `INSERT INTO content_clusters VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const c of clusters) {
    insert.run(
      c.id, c.title, c.summary, c.itemCount, c.latestPublishedAt, c.status, c.eventType,
      c.eventSubject, c.eventAction, c.eventObject, c.eventDate, c.eventFingerprint,
      c.fingerprint, c.mergeInputHash, c.updatedAt,
    );
  }
  db.prepare(`INSERT INTO items VALUES (?,?,?,?,?,?)`).run("it1", clusters[0]?.id ?? "c1", "processed", "allowed", null, "s1");
  db.prepare(`INSERT INTO sources VALUES (?,?)`).run("s1", 1);
  db.close();
  return dbPath;
}

describe("sanitizeSnapshot", () => {
  it("copies exactly the 3 whitelisted tables with 15/6/2 columns and never copies secrets", () => {
    const root = makeTmpRoot();
    const raw = createRawDb(root, [fixtureCluster({ id: "c1" })]);
    const out = path.join(root, "snapshot.db");
    const result = sanitizeSnapshot({ rawPath: raw, outPath: out });

    const db = new DatabaseSync(out, { readOnly: true });
    const tables = (
      db.prepare("select name from sqlite_master where type='table' order by name").all() as Array<{ name: string }>
    ).map((t) => t.name);
    expect(tables).toEqual([...SNAPSHOT_TABLES].sort());
    for (const table of SNAPSHOT_TABLES) {
      const columns = (
        db.prepare(`select name from pragma_table_info('${table}')`).all() as Array<{ name: string }>
      ).map((c) => c.name);
      expect(columns).toEqual(SNAPSHOT_COLUMNS[table]);
    }
    expect((db.prepare("select count(*) n from content_clusters").get() as { n: number }).n).toBe(1);
    expect((db.prepare("select count(*) n from items").get() as { n: number }).n).toBe(1);
    expect((db.prepare("select count(*) n from sources").get() as { n: number }).n).toBe(1);
    db.close();

    const bytes = fs.readFileSync(out).toString("latin1");
    expect(bytes).not.toContain("sk-secret-should-never-leak");
    expect(bytes).not.toContain("sk-raw-key-value");
    expect(result.integrityCheck).toBe("ok");
    expect(result.rowCounts).toEqual({ content_clusters: 1, items: 1, sources: 1 });
  });

  it("verifies the raw digest is unchanged around the copy and pins the output hash", () => {
    const root = makeTmpRoot();
    const raw = createRawDb(root, [fixtureCluster({ id: "c1" })]);
    const before = sha256File(raw);
    const out = path.join(root, "snapshot.db");
    const result = sanitizeSnapshot({ rawPath: raw, outPath: out });
    expect(result.rawSha256Before).toBe(before);
    expect(result.rawSha256After).toBe(before);
    expect(result.outSha256).toBe(sha256File(out));
  });

  it("refuses to overwrite an existing target", () => {
    const root = makeTmpRoot();
    const raw = createRawDb(root, [fixtureCluster({ id: "c1" })]);
    const out = path.join(root, "snapshot.db");
    fs.writeFileSync(out, "existing");
    expect(() => sanitizeSnapshot({ rawPath: raw, outPath: out })).toThrow(InvalidInputError);
  });

  it("fails closed when a required whitelist column is missing (no unknown fallback)", () => {
    const root = makeTmpRoot();
    const raw = createRawDb(root, [fixtureCluster({ id: "c1" })]);
    const db = new DatabaseSync(raw);
    db.exec("DROP TABLE content_clusters");
    db.exec(`CREATE TABLE content_clusters(id TEXT, title TEXT, summary TEXT, itemCount INT,
      latestPublishedAt NUM, status TEXT, eventType TEXT, eventSubject TEXT, eventAction TEXT,
      eventObject TEXT, eventDate TEXT, eventFingerprint TEXT, fingerprint TEXT, updatedAt NUM)`);
    db.close();
    const probe = new DatabaseSync(raw, { readOnly: true });
    expect(() => assertRawWhitelist(probe)).toThrow(/missing required columns/);
    probe.close();
  });
});

function pair(leftId: string, rightId: string, overrides: Partial<PairCandidate> = {}): PairCandidate {
  const [a, b] = [leftId, rightId].sort();
  return {
    leftId: a,
    rightId: b,
    pairKey: `${a}|${b}`,
    score: 50,
    sharedFingerprint: null,
    objectBoundaryVerified: false,
    safetyRejected: false,
    safetyReason: null,
    ...overrides,
  };
}

describe("chooseSamplePairs", () => {
  it("prefers same-fingerprint, then boundary, then high-BM25 strata and records actual counts", () => {
    const pairs = [
      pair("h1", "h2", { score: 90 }),
      pair("b1", "b2", { objectBoundaryVerified: true, score: 40 }),
      pair("f1", "f2", { sharedFingerprint: "fp-1", score: 10 }),
    ];
    const result = chooseSamplePairs(pairs, 3, DEFAULT_SEED);
    // Output is sorted by caseId, so assert the pairKey→stratum mapping and the
    // per-stratum counts — selection order itself is exercised by the quota
    // scheduling below.
    expect(Object.fromEntries(result.selected.map((s) => [s.pairKey, s.stratum]))).toEqual({
      "f1|f2": "same_event_fingerprint",
      "b1|b2": "same_object_event_boundary",
      "h1|h2": "high_bm25_near_neighbor",
    });
    expect(result.stratumCounts).toEqual({
      same_event_fingerprint: 1,
      same_object_event_boundary: 1,
      high_bm25_near_neighbor: 1,
    });
    expect(result.quotaStats.high_similarity_or_same_fp).toEqual({ requested: 3, actual: 3 });
  });

  it("keeps pairs cluster-disjoint and never repeats an event-fingerprint group across cases", () => {
    const pairs = [
      pair("a1", "a2", { sharedFingerprint: "fp-A" }),
      pair("a2", "a3"), // shares a cluster with the first pair
      pair("b1", "b2", { sharedFingerprint: "fp-A" }), // same fp group as the first pair
      pair("c1", "c2", { sharedFingerprint: "fp-C" }),
    ];
    const result = chooseSamplePairs(pairs, 2, DEFAULT_SEED);
    const clusterIds = result.selected.flatMap((s) => [s.leftId, s.rightId]);
    expect(new Set(clusterIds).size).toBe(clusterIds.length);
    const fpPairs = result.selected.filter((s) => s.stratum === "same_event_fingerprint");
    // Only one of the two fp-A pairs may appear.
    expect(fpPairs).toHaveLength(2);
    expect(new Set(fpPairs.map((s) => s.pairKey))).toEqual(new Set(["a1|a2", "c1|c2"]));
  });

  it("is deterministic for the same universe, seed and target", () => {
    const pairs = Array.from({ length: 40 }, (_, i) => pair(`x${i}`, `y${i}`, { score: 100 - i }));
    const first = chooseSamplePairs(pairs, 8, "seed-fixed");
    const second = chooseSamplePairs(pairs, 8, "seed-fixed");
    expect(first.selected).toEqual(second.selected);
    expect(seededOrder("seed-fixed", first.selected.map((s) => s.pairKey))).toEqual(
      seededOrder("seed-fixed", first.selected.map((s) => s.pairKey)),
    );
  });

  it("fails closed with insufficient_sampling_capacity instead of fabricating cases", () => {
    expect(() => chooseSamplePairs([pair("a", "b")], DEFAULT_TARGET_PAIRS, DEFAULT_SEED)).toThrow(
      /insufficient_sampling_capacity/,
    );
    expect(() => chooseSamplePairs([], 1, DEFAULT_SEED)).toThrow(/insufficient_sampling_capacity/);
  });
});

describe("quota strata and controls", () => {
  it("selects safety-rejected related and low-similarity controls as explicit independent strata", () => {
    const pairs = [
      ...Array.from({ length: 18 }, (_, i) => pair(`h${i}`, `h${i}r`, { score: 90 - i })),
      pair("s1", "s2", { safetyRejected: true, safetyReason: "object_conflict", score: 60 }),
      pair("s3", "s4", { safetyRejected: true, safetyReason: "date_conflict", score: 55 }),
      pair("z1", "z2", { score: 0 }),
      pair("z3", "z4", { score: 0 }),
      pair("z5", "z6", { score: 0 }),
      pair("z7", "z8", { score: 0 }),
    ];
    const result = chooseSamplePairs(pairs, 24, DEFAULT_SEED);
    expect(result.quotaStats).toEqual({
      high_similarity_or_same_fp: { requested: 18, actual: 18 },
      safety_rejected_related: { requested: 2, actual: 2 },
      low_similarity_coverage: { requested: 4, actual: 4 },
    });
    const rejected = result.selected.filter((s) => s.stratum === "safety_rejected_related");
    expect(rejected.map((s) => s.weakSafetyReason).sort()).toEqual(["date_conflict", "object_conflict"]);
    expect(result.selected.filter((s) => s.stratum === "low_similarity_coverage")).toHaveLength(4);
  });

  it("keeps controls cluster-disjoint and fingerprint-group-unique alongside the main strata", () => {
    const pairs = [
      // 19 high-similarity pairs for 18 slots, with h0|h0r ranked lowest so the
      // scheduler can leave h0 free for the overlapping rejected pair below.
      ...Array.from({ length: 18 }, (_, i) => pair(`h${i + 1}`, `h${i + 1}r`, { score: 90 - i })),
      pair("h0", "h0r", { score: 10 }),
      pair("h0", "s1", { safetyRejected: true, safetyReason: "object_conflict", score: 60 }), // overlaps h0
      pair("s2", "s3", { safetyRejected: true, safetyReason: "date_conflict", score: 55 }),
      pair("z1", "z2", { score: 0 }),
      pair("z3", "z4", { score: 0 }),
      pair("z5", "z6", { score: 0 }),
      pair("z7", "z8", { score: 0 }),
    ];
    const result = chooseSamplePairs(pairs, 24, DEFAULT_SEED);
    const clusterIds = result.selected.flatMap((s) => [s.leftId, s.rightId]);
    expect(new Set(clusterIds).size).toBe(clusterIds.length);
    // Contract is disjointness, not a specific relocation outcome: with
    // augmenting relocation the overlapping rejected pair (h0|s1) may be
    // selected, but then h0|h0r must be gone — never both.
    const used = new Set(result.selected.map((s) => s.pairKey));
    // Exactly one of the two h0 pairs may appear; here the scheduler prefers
    // the higher-scored rejected control.
    expect(used.has("h0|s1")).toBe(true);
    expect(used.has("h0|h0r")).toBe(false);
    expect(result.quotaStats.safety_rejected_related.actual).toBe(2);
  });

  it("fails closed with per-quota shortfall instead of fabricating full coverage", () => {
    const pairs = [
      ...Array.from({ length: 18 }, (_, i) => pair(`h${i}`, `h${i}r`, { score: 90 - i })),
      pair("s1", "s2", { safetyRejected: true, safetyReason: "object_conflict", score: 60 }),
      // only one low-similarity pair available; quota wants 4
      pair("z1", "z2", { score: 0 }),
    ];
    try {
      chooseSamplePairs(pairs, 24, DEFAULT_SEED);
      throw new Error("should have failed closed");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidInputError);
      expect((error as Error).message).toContain("insufficient_sampling_capacity");
      expect((error as Error).message).toContain("low_similarity_coverage 1/4");
      expect((error as Error).message).not.toContain("24/24");
    }
  });

  it("does not call an object pair an event boundary unless date or action really differs", () => {
    const pairs = [
      pair("o1", "o2", { objectBoundaryVerified: false, score: 70 }),
      pair("d1", "d2", { objectBoundaryVerified: true, score: 70 }),
    ];
    expect(stratumOf(pairs[0]!)).toBe("high_bm25_near_neighbor");
    expect(stratumOf(pairs[1]!)).toBe("same_object_event_boundary");
  });

  it("keeps control metadata private: manifest cases carry weak reason, blind CSV never does", () => {
    const corpusById = new Map<string, ClusterRow>([
      ["L1", fixtureCluster({ id: "L1", title: "左标题" })],
      ["R1", fixtureCluster({ id: "R1", title: "右标题" })],
      ["L2", fixtureCluster({ id: "L2", title: "左标题二" })],
      ["R2", fixtureCluster({ id: "R2", title: "右标题二" })],
    ]);
    const selected: SelectedPair[] = [
      {
        caseId: "CQ-CONTROL00001",
        pairKey: "L1|R1",
        leftId: "L1",
        rightId: "R1",
        stratum: "safety_rejected_related",
        weakBm25Score: 60,
        weakSafetyReason: "object_conflict",
      },
    ];
    const manifest = buildSamplingManifest({
      snapshotPath: "docs/eval/snapshots/x.db",
      snapshotSha256: "b".repeat(64),
      asOfIso: "2026-10-02T11:41:35.000Z",
      asOfMs: Date.parse("2026-10-02T11:41:35.000Z"),
      seed: DEFAULT_SEED,
      target: 1,
      selection: {
        selected,
        stratumCounts: { safety_rejected_related: 1 },
        universeSize: 4,
        quotaStats: { safety_rejected_related: { requested: 1, actual: 1 } },
      },
    });
    expect(manifest.cases[0]!.weakSafetyReason).toBe("object_conflict");
    expect(manifest.cases[0]!.sourceStratum).toBe("safety_rejected_related");
    // Control selection is a weak scheduling hint — it is not a human "diff" label.
    expect(manifest).not.toHaveProperty("cases[0].humanLabel");
    const rows = buildPendingRows(corpusById, selected);
    const text = rows.map((r) => r.join(",")).join("\n");
    expect(text).not.toContain("object_conflict");
    expect(text).not.toContain("safety_rejected_related");
    const header = rows[0]!;
    const reviewIdx = header.indexOf("reviewStatus");
    // reviewStatus sits at the head of the human block; the 4 fields after it
    // must stay blank in a pending packet.
    expect(
      rows
        .slice(1)
        .every((r) => r[reviewIdx] === "pending" && r.slice(reviewIdx + 1).every((v) => v === "")),
    ).toBe(true);
  });
});

describe("scorePairUniverse", () => {
  const base = 1_800_000_000_000;

  it("marks same-fingerprint and same-object-different-event pairs by the real BM25+safety stack", () => {
    const shared = { eventSubject: "开源社区", eventObject: "CLI 工具", eventAction: "发布" };
    const corpus: ClusterRow[] = [
      fixtureCluster({
        id: "p1",
        title: "开源发布新版 CLI 工具",
        summary: "开源社区发布新版 CLI 工具，支持命令行自动聚合",
        eventFingerprint: "fp-1",
        ...shared,
        latestPublishedAt: base,
      }),
      fixtureCluster({
        id: "p2",
        title: "开源发布 CLI 工具补丁",
        summary: "同一开源 CLI 工具发布补丁，命令行聚合更稳",
        eventFingerprint: "fp-1",
        ...shared,
        latestPublishedAt: base,
      }),
      fixtureCluster({
        id: "p3",
        title: "开源发布 CLI 工具路线图",
        summary: "同一开源 CLI 工具公布下一季度路线图",
        eventFingerprint: "fp-2",
        ...shared,
        eventDate: "2026-09-28",
        latestPublishedAt: base,
      }),
    ];
    void corpus;
    const universe = scorePairUniverse(corpus);
    const p12 = universe.find((u) => u.pairKey === "p1|p2");
    const p13 = universe.find((u) => u.pairKey === "p1|p3");
    expect(p12).toBeDefined();
    expect(stratumOf(p12!)).toBe("same_event_fingerprint");
    expect(p13).toBeDefined();
    expect(p13!.objectBoundaryVerified).toBe(true);
    expect(stratumOf(p13!)).toBe("same_object_event_boundary");
  });
});

describe("pending packet construction", () => {
  const corpus = new Map<string, ClusterRow>([
    ["L1", fixtureCluster({ id: "L1", title: "左标题", latestPublishedAt: 123 })],
    ["R1", fixtureCluster({ id: "R1", title: "右标题", latestPublishedAt: 456 })],
  ]);
  const selected: SelectedPair[] = [
    {
      caseId: "CQ-ABCDEF123456",
      pairKey: "L1|R1",
      leftId: "L1",
      rightId: "R1",
      stratum: "high_bm25_near_neighbor",
      weakBm25Score: 77,
      weakSafetyReason: null,
    },
  ];

  it("emits visible inputs only; every human column blank and reviewStatus pending", () => {
    const rows = buildPendingRows(corpus, selected);
    // pairKey is part of the frozen public input contract and must stay in the
    // blind CSV header; weak fields (stratum/score/reason) must never appear.
    const header = rows[0]!;
    expect(header).toEqual([
      "caseId", "pairKey", "leftTitle", "leftSummary", "leftEventType", "leftEventSubject",
      "leftEventAction", "leftEventObject", "leftEventDate", "leftItemCount", "leftLatestPublishedAt",
      "rightTitle", "rightSummary", "rightEventType", "rightEventSubject", "rightEventAction",
      "rightEventObject", "rightEventDate", "rightItemCount", "rightLatestPublishedAt",
      "reviewStatus", "humanLabel", "humanReason", "reviewer", "reviewedAt",
    ]);
    expect(header.some((name) => /weak|stratum|quota|safety/i.test(name))).toBe(false);
    const data = rows[1]!;
    expect(data[0]).toBe("CQ-ABCDEF123456");
    expect(data[1]).toBe("L1|R1");
    expect(data[2]).toBe("左标题");
    expect(data.slice(-5)).toEqual(["pending", "", "", "", ""]);
    const csvText = rows.map((r) => r.join(",")).join("\n");
    expect(csvText).not.toContain("77"); // weak scores never reach the blind CSV
  });

  it("manifest keeps weak hints private and round-trips cluster ids", () => {
    const manifest = buildSamplingManifest({
      snapshotPath: "docs/eval/snapshots/x.db",
      snapshotSha256: "a".repeat(64),
      asOfIso: "2026-10-02T11:41:35.000Z",
      asOfMs: Date.parse("2026-10-02T11:41:35.000Z"),
      seed: DEFAULT_SEED,
      target: 1,
      selection: { selected, stratumCounts: { high_bm25_near_neighbor: 1 }, universeSize: 5, quotaStats: {} },
    });
    expect(manifest.caseCount).toBe(1);
    expect(manifest.selection.actualCaseCount).toBe(1);
    expect(manifest.cases[0]!.snapshotSha256).toBe("a".repeat(64));
    expect(JSON.stringify(manifest)).toContain("weakBm25Score");

    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE content_clusters(
      id TEXT, title TEXT, summary TEXT, itemCount INT, latestPublishedAt NUM, status TEXT,
      eventType TEXT, eventSubject TEXT, eventAction TEXT, eventObject TEXT, eventDate TEXT,
      eventFingerprint TEXT, fingerprint TEXT, mergeInputHash TEXT, updatedAt NUM);
      CREATE TABLE items(id TEXT, clusterId TEXT, status TEXT, moderationStatus TEXT, parentItemId TEXT, sourceId TEXT);
      CREATE TABLE sources(id TEXT, aggregationEnabled INT);`);
    const ins = db.prepare(`INSERT INTO content_clusters VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const row of corpus.values()) {
      ins.run(row.id, row.title, row.summary, row.itemCount, row.latestPublishedAt, row.status, row.eventType,
        row.eventSubject, row.eventAction, row.eventObject, row.eventDate, row.eventFingerprint,
        row.fingerprint, row.mergeInputHash, row.updatedAt);
    }
    expect(() => verifyManifestAgainstSnapshot(manifest, db)).not.toThrow();
    db.exec("CREATE TABLE settings(k TEXT)");
    expect(() => verifyManifestAgainstSnapshot(manifest, db)).toThrow(/non-whitelisted tables/);
    db.close();
  });

  it("reverse-maps pending CSV fields against the sanitized snapshot and rejects drift", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE content_clusters(
      id TEXT, title TEXT, summary TEXT, itemCount INT, latestPublishedAt NUM, status TEXT,
      eventType TEXT, eventSubject TEXT, eventAction TEXT, eventObject TEXT, eventDate TEXT,
      eventFingerprint TEXT, fingerprint TEXT, mergeInputHash TEXT, updatedAt NUM);
      CREATE TABLE items(id TEXT, clusterId TEXT, status TEXT, moderationStatus TEXT, parentItemId TEXT, sourceId TEXT);
      CREATE TABLE sources(id TEXT, aggregationEnabled INT);`);
    const ins = db.prepare(`INSERT INTO content_clusters VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const row of corpus.values()) {
      ins.run(row.id, row.title, row.summary, row.itemCount, row.latestPublishedAt, row.status, row.eventType,
        row.eventSubject, row.eventAction, row.eventObject, row.eventDate, row.eventFingerprint,
        row.fingerprint, row.mergeInputHash, row.updatedAt);
    }
    const pendingRows = buildPendingRows(corpus, selected).slice(1).map((cells) => {
      const header = buildPendingRows(corpus, selected)[0]!;
      return Object.fromEntries(header.map((name, i) => [name, cells[i] ?? ""]));
    });
    expect(() => verifyPendingFieldsAgainstSnapshot(pendingRows, db)).not.toThrow();
    pendingRows[0]!.leftTitle = "被篡改的标题";
    expect(() => verifyPendingFieldsAgainstSnapshot(pendingRows, db)).toThrow(/leftTitle/);
    db.close();
  });
});
