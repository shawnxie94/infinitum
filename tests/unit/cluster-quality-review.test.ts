import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  assignSplits,
  assessReadiness,
  BLIND_COLUMNS,
  buildComponents,
  canonicalInputSha,
  csvRecords,
  defaultOutDir,
  EXIT_INSUFFICIENT_TRUTH,
  HUMAN_FIELDS,
  INPUT_FIELDS,
  InvalidInputError,
  loadCsvTable,
  parseCsv,
  runAssess,
  runPrepare,
  sha256File,
  SplitError,
  stringifyCsv,
  validatePendingAgainstManifest,
} from "../../scripts/eval-cluster-quality-review";

const tmpRoots: string[] = [];

function makeTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cqr-test-"));
  tmpRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const SNAPSHOT_SHA = "a".repeat(64);

type FixtureCase = { caseId: string; left: string; right: string; stratum: string; title: string };

function fixtureRows(cases: FixtureCase[], extraColumns: string[] = []): string[][] {
  const emptyInput = Object.fromEntries(INPUT_FIELDS.filter((f) => f !== "pairKey" && f !== "leftTitle").map((f) => [f, ""]));
  const header = ["caseId", ...INPUT_FIELDS, ...HUMAN_FIELDS, ...extraColumns];
  return [
    header,
    ...cases.map((c) => [
      c.caseId,
      `${c.left}|${c.right}`,
      c.title,
      ...INPUT_FIELDS.filter((f) => f !== "pairKey" && f !== "leftTitle").map((f) => emptyInput[f] ?? ""),
      ...HUMAN_FIELDS.map(() => ""),
      ...extraColumns.map(() => "extra"),
    ]),
  ];
}

function fixtureManifest(cases: FixtureCase[], snapshotSha = SNAPSHOT_SHA): Record<string, unknown> {
  return {
    schemaVersion: 1,
    createdAt: "2026-09-26T06:39:09.566850+00:00",
    snapshot: { path: "unused.db", sha256: snapshotSha },
    caseCount: cases.length,
    cases: cases.map((c) => ({
      caseId: c.caseId,
      pairKey: `${c.left}|${c.right}`,
      leftClusterId: c.left,
      rightClusterId: c.right,
      sourceStratum: c.stratum,
      snapshotSha256: snapshotSha,
    })),
  };
}

function writeFixture(dir: string, cases: FixtureCase[], snapshotSha?: string): { snapshot: string; labels: string; manifest: string } {
  const snapshot = path.join(dir, "snapshot.db");
  fs.writeFileSync(snapshot, `fake snapshot for ${dir}`);
  const manifestPath = path.join(dir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(fixtureManifest(cases, snapshotSha ?? sha256File(snapshot))));
  const labelsPath = path.join(dir, "pending.csv");
  fs.writeFileSync(labelsPath, stringifyCsv(fixtureRows(cases)));
  return { snapshot, labels: labelsPath, manifest: manifestPath };
}

const SIX_CASES: FixtureCase[] = [
  { caseId: "C-1", left: "cl-a", right: "cl-b", stratum: "fingerprint", title: "one" },
  { caseId: "C-2", left: "cl-b", right: "cl-c", stratum: "declined", title: "two" },
  { caseId: "C-3", left: "cl-d", right: "cl-e", stratum: "declined", title: "three" },
  { caseId: "C-4", left: "cl-f", right: "cl-g", stratum: "fingerprint", title: "four" },
  { caseId: "C-5", left: "cl-h", right: "cl-i", stratum: "declined", title: "five" },
  { caseId: "C-6", left: "cl-j", right: "cl-k", stratum: "fingerprint", title: "six" },
];

function prepareSix(dir: string): { outDir: string; frozenPath: string; labelsOut: string } {
  const outDir = path.join(dir, "packet");
  runPrepare({ ...writeFixture(dir, SIX_CASES), outDir, now: new Date("2026-10-01T00:00:00Z") });
  return { outDir, frozenPath: path.join(outDir, "frozen-manifest.json"), labelsOut: path.join(outDir, "blind-review.csv") };
}

function frozenOf(dir: string): ReturnType<typeof JSON.parse> {
  return JSON.parse(fs.readFileSync(path.join(dir, "packet", "frozen-manifest.json"), "utf8"));
}

describe("csv roundtrip", () => {
  it("handles quoted fields, embedded commas and newlines", () => {
    const rows = [["caseId", "leftSummary"], ["C-1", 'has "quotes", commas\nand a newline']];
    const text = stringifyCsv(rows);
    expect(parseCsv(text)).toEqual(rows);
    const records = csvRecords(text);
    expect(records[0].leftSummary).toBe('has "quotes", commas\nand a newline');
  });
});

describe("pending / manifest validation", () => {
  it("accepts swapped cluster-id direction when the pair matches as a set", () => {
    const dir = makeTmp();
    const cases = [...SIX_CASES];
    const manifest = fixtureManifest(cases) as { cases: Array<Record<string, string>> };
    for (const c of manifest.cases) {
      [c.leftClusterId, c.rightClusterId] = [c.rightClusterId, c.leftClusterId];
    }
    const manifestPath = path.join(dir, "manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const rows = csvRecords(stringifyCsv(fixtureRows(cases)));
    expect(() => validatePendingAgainstManifest(rows, manifest.cases as never, SNAPSHOT_SHA)).not.toThrow();
  });

  it("rejects duplicate ids, wrong direction and snapshot sha mismatch", () => {
    const rows = csvRecords(stringifyCsv(fixtureRows(SIX_CASES)));
    expect(() => validatePendingAgainstManifest([...rows, rows[0]], SIX_CASES.map((c) => ({
      caseId: c.caseId,
      pairKey: `${c.left}|${c.right}`,
      leftClusterId: c.left,
      rightClusterId: c.right,
      sourceStratum: c.stratum,
      snapshotSha256: SNAPSHOT_SHA,
    })), SNAPSHOT_SHA)).toThrow(InvalidInputError);

    const badDirection = SIX_CASES.map((c) => ({
      caseId: c.caseId,
      pairKey: `x|y`,
      leftClusterId: c.left,
      rightClusterId: c.right,
      sourceStratum: c.stratum,
      snapshotSha256: SNAPSHOT_SHA,
    }));
    expect(() => validatePendingAgainstManifest(rows, badDirection as never, SNAPSHOT_SHA)).toThrow(/pairKey mismatch/);
    expect(() => validatePendingAgainstManifest(rows, SIX_CASES.map((c) => ({
      caseId: c.caseId,
      pairKey: `${c.left}|${c.right}`,
      leftClusterId: c.left,
      rightClusterId: c.right,
      sourceStratum: c.stratum,
      snapshotSha256: SNAPSHOT_SHA,
    })), "b".repeat(64))).toThrow(/snapshot sha mismatch/);
  });
});

describe("component split", () => {
  it("keeps chain A-B, B-C in one split and is deterministic", () => {
    const stratum = Object.fromEntries([
      ["A", "s1"],
      ["B", "s1"],
      ["C", "s2"],
      ["D", "s2"],
    ]);
    const components = buildComponents([
      { caseId: "A", pairKey: "c1|c2", leftClusterId: "c1", rightClusterId: "c2", sourceStratum: "s1", snapshotSha256: "" },
      { caseId: "B", pairKey: "c2|c3", leftClusterId: "c2", rightClusterId: "c3", sourceStratum: "s1", snapshotSha256: "" },
      { caseId: "C", pairKey: "c4|c5", leftClusterId: "c4", rightClusterId: "c5", sourceStratum: "s2", snapshotSha256: "" },
      { caseId: "D", pairKey: "c6|c7", leftClusterId: "c6", rightClusterId: "c7", sourceStratum: "s2", snapshotSha256: "" },
    ]);
    expect(components.find((c) => c.caseIds.includes("A"))!.caseIds.sort()).toEqual(["A", "B", "C"].filter((x) => x !== "C").sort());
    const runs = [assignSplits(components, stratum), assignSplits(components, stratum)];
    const sideOf = (run: { dev: string[]; holdout: string[] }, id: string) => (run.dev.includes(id) ? "dev" : "holdout");
    for (const run of runs) {
      expect(sideOf(run, "A")).toBe(sideOf(run, "B"));
    }
    expect(runs[0]).toEqual(runs[1]);
  });

  it("throws cannot_split for a single all-cases component", () => {
    const components = buildComponents([
      { caseId: "A", pairKey: "c1|c2", leftClusterId: "c1", rightClusterId: "c2", sourceStratum: "s1", snapshotSha256: "" },
      { caseId: "B", pairKey: "c2|c3", leftClusterId: "c2", rightClusterId: "c3", sourceStratum: "s1", snapshotSha256: "" },
    ]);
    expect(() => assignSplits(components, { A: "s1", B: "s1" })).toThrow(SplitError);
    expect(() => assignSplits(components, { A: "s1", B: "s1" })).toThrow(/cannot_split/);
  });
});

describe("prepare fail-closed and outputs", () => {
  it("rejects snapshot checksum mismatch", () => {
    const dir = makeTmp();
    const fixture = writeFixture(dir, SIX_CASES, "b".repeat(64));
    expect(() => runPrepare({ ...fixture, outDir: path.join(dir, "out") })).toThrow(/snapshot sha mismatch/);
  });

  it("produces blind csv without weak signals and frozen manifest with checksums", () => {
    const dir = makeTmp();
    prepareSix(dir);
    const blindText = fs.readFileSync(path.join(dir, "packet", "blind-review.csv"), "utf8");
    const records = csvRecords(blindText);
    expect(records).toHaveLength(6);
    expect(Object.keys(records[0]).sort()).toEqual([...BLIND_COLUMNS].sort());
    const blindTextLower = blindText.toLowerCase();
    expect(blindTextLower).not.toContain("score");
    expect(blindTextLower).not.toContain("stratum");
    expect(blindTextLower).not.toContain("verdict");
    expect(blindTextLower).not.toContain("fingerprint");
    expect(records.every((r) => r.reviewStatus === "pending" && r.humanLabel === "" && r.reviewer === "")).toBe(true);

    const frozen = frozenOf(dir);
    expect(frozen.baseline.status).toBe("deferred");
    expect(frozen.cases).toHaveLength(6);
    for (const c of frozen.cases) {
      const row = records.find((r) => r.caseId === c.caseId)!;
      expect(canonicalInputSha(c.caseId, row)).toBe(c.inputSha256);
    }
    const devCases = frozen.cases.filter((c: { split: string }) => c.split === "dev").length;
    const holdoutCases = 6 - devCases;
    expect(devCases).toBeGreaterThan(holdoutCases);
    expect(holdoutCases).toBeGreaterThan(0);

    const splitByCase: Record<string, string> = Object.fromEntries(frozen.cases.map((c: { caseId: string; split: string }) => [c.caseId, c.split]));
    const clusterToCase = new Map<string, string[]>();
    for (const c of frozen.cases) {
      for (const clusterId of c.clusterIds) {
        clusterToCase.set(clusterId, [...(clusterToCase.get(clusterId) ?? []), c.caseId]);
      }
    }
    for (const [, caseIds] of clusterToCase) {
      const splits = new Set(caseIds.map((id) => splitByCase[id]));
      expect(splits.size).toBe(1);
    }
  });
});

describe("assess readiness", () => {
  function labelsFromPacket(dir: string, mutate: (rows: Array<Record<string, string>>) => void): Array<Record<string, string>> {
    const records = csvRecords(fs.readFileSync(path.join(dir, "packet", "blind-review.csv"), "utf8"));
    mutate(records);
    return records;
  }

  it("maps zero labels to insufficient_truth and exit code 2", () => {
    const dir = makeTmp();
    prepareSix(dir);
    const frozen = frozenOf(dir);
    const rows = labelsFromPacket(dir, () => {});
    const result = assessReadiness(frozen, rows);
    expect(result.status).toBe("insufficient_truth");
    expect(result.metrics).toBeNull();
    expect(result.coverage.pending).toBe(6);
    expect(EXIT_INSUFFICIENT_TRUTH).toBe(2);
  });

  it("excludes reviewed rows without reviewer or parseable time; uncertain counted separately", () => {
    const dir = makeTmp();
    prepareSix(dir);
    const frozen = frozenOf(dir);
    const rows = labelsFromPacket(dir, (records) => {
      records[0].reviewStatus = "reviewed";
      records[0].humanLabel = "same";
      records[0].reviewer = ""; // deliberately blank reviewer -> excluded
      records[0].reviewedAt = "2026-10-01T08:00:00Z";
      records[1].reviewStatus = "reviewed";
      records[1].humanLabel = "diff";
      records[1].reviewer = "alice";
      records[1].reviewedAt = "not-a-time";
      records[2].reviewStatus = "reviewed";
      records[2].humanLabel = "uncertain";
      records[2].reviewer = "alice";
      records[2].reviewedAt = "2026-10-01T08:00:00Z";
      for (const r of records.slice(3)) {
        r.reviewStatus = "reviewed";
        r.humanLabel = r.caseId === "C-4" ? "same" : "diff";
        r.reviewer = "bob";
        r.reviewedAt = "2026-10-01T08:00:00Z";
      }
    });
    const result = assessReadiness(frozen, rows);
    expect(result.coverage.excluded).toBe(2);
    expect(result.coverage.reviewedUncertain).toBe(1);
    expect(result.coverage.eligible).toBe(3);
    expect(result.status).toBe("insufficient_truth");
  });

  it("never converts uncertain to diff and blocks metrics while pending rows remain", () => {
    const dir = makeTmp();
    prepareSix(dir);
    const frozen = frozenOf(dir);
    const rows = labelsFromPacket(dir, (records) => {
      for (const r of records) {
        r.reviewStatus = "reviewed";
        r.humanLabel = r.caseId <= "C-3" ? "same" : "diff";
        r.reviewer = "alice";
        r.reviewedAt = "2026-10-01T08:00:00Z";
      }
      records[5].reviewStatus = "pending";
    });
    const result = assessReadiness(frozen, rows);
    expect(result.coverage.pending).toBe(1);
    expect(result.status).toBe("insufficient_truth");
    expect(result.metrics).toBeNull();
  });

  it("requires positive and negative labels in each split before ready_for_replay", () => {
    const dir = makeTmp();
    prepareSix(dir);
    const frozen = frozenOf(dir);
    const splitOf = new Map<string, string>(frozen.cases.map((c: { caseId: string; split: string }) => [c.caseId, c.split]));
    const rows = labelsFromPacket(dir, (records) => {
      const holdoutIds = records.filter((r) => splitOf.get(r.caseId) === "holdout").map((r) => r.caseId);
      for (const r of records) {
        r.reviewStatus = "reviewed";
        const isHoldout = splitOf.get(r.caseId) === "holdout";
        r.humanLabel = isHoldout ? (r.caseId === holdoutIds[0] ? "same" : "same") : r.caseId <= "C-3" ? "same" : "diff";
        r.reviewer = "alice";
        r.reviewedAt = "2026-10-01T08:00:00Z";
      }
    });
    const noNegative = assessReadiness(frozen, rows);
    expect(noNegative.status).toBe("insufficient_truth");

    const fixed = labelsFromPacket(dir, (records) => {
      for (const r of records) {
        r.reviewStatus = "reviewed";
        r.humanLabel = r.caseId <= "C-3" ? "same" : "diff";
        r.reviewer = "alice";
        r.reviewedAt = "2026-10-01T08:00:00Z";
      }
    });
    const ready = assessReadiness(frozen, fixed);
    expect(ready.status).toBe("ready_for_replay");
    expect(ready.metrics?.dev.same).toBeGreaterThan(0);
    expect(ready.metrics?.dev.diff).toBeGreaterThan(0);
    expect(ready.metrics?.holdout.same).toBeGreaterThan(0);
    expect(ready.metrics?.holdout.diff).toBeGreaterThan(0);
    expect(ready.qualityPassed).toBe(false);
    expect(ready.aiCounts).toBe("not_measured");
    expect(ready.aiCost).toBe("not_measured");
  });

  it("fail-closed on tampered inputs, unknown cases and duplicates", () => {
    const dir = makeTmp();
    prepareSix(dir);
    const frozen = frozenOf(dir);
    const base = labelsFromPacket(dir, (records) => {
      for (const r of records) {
        r.reviewStatus = "reviewed";
        r.humanLabel = "same";
        r.reviewer = "alice";
        r.reviewedAt = "2026-10-01T08:00:00Z";
      }
    });

    const tampered = structuredClone(base);
    tampered[0].leftTitle = "changed after freeze";
    expect(assessReadiness(frozen, tampered).invalid.some((m) => m.includes("input checksum mismatch"))).toBe(true);

    const unknown = [...structuredClone(base), { ...base[0], caseId: "C-UNKNOWN" }];
    expect(assessReadiness(frozen, unknown).invalid.some((m) => m.includes("unknown case"))).toBe(true);

    const missing = structuredClone(base).slice(1);
    expect(assessReadiness(frozen, missing).invalid.some((m) => m.includes("missing case"))).toBe(true);

    const duplicated = [...structuredClone(base), base[0]];
    expect(assessReadiness(frozen, duplicated).invalid.some((m) => m.includes("duplicate case"))).toBe(true);

    expect(assessReadiness(frozen, structuredClone(base), { snapshotShaActual: "b".repeat(64) }).invalid.some((m) =>
      m.includes("snapshot sha mismatch"),
    )).toBe(true);
  });
});

describe("round2 strict csv headers", () => {
  function writePendingOnly(dir: string, rows: string[][]): string {
    const labelsPath = path.join(dir, "pending.csv");
    fs.writeFileSync(labelsPath, stringifyCsv(rows));
    return labelsPath;
  }

  function prepareWithLabels(dir: string, labels: string): void {
    const snapshot = path.join(dir, "snapshot.db");
    fs.writeFileSync(snapshot, "fake");
    const manifestPath = path.join(dir, "manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(fixtureManifest(SIX_CASES, sha256File(snapshot))));
    runPrepare({ snapshot, labels, manifest: manifestPath, outDir: path.join(dir, "out"), now: new Date(0) });
  }

  it("rejects duplicate header columns", () => {
    const dir = makeTmp();
    const rows = fixtureRows(SIX_CASES);
    rows[0] = [...rows[0], "leftTitle"];
    rows.slice(1).forEach((r) => r.push(""));
    expect(() => loadCsvTable(stringifyCsv(rows), ["caseId"], ["caseId", "leftTitle"], "pending csv")).toThrow(/duplicate columns/);
    expect(() => prepareWithLabels(dir, writePendingOnly(dir, rows))).toThrow(/duplicate columns/);
  });

  it("rejects unknown input columns such as weakScore", () => {
    const dir = makeTmp();
    const rows = fixtureRows(SIX_CASES, ["weakScore"]);
    expect(() => prepareWithLabels(dir, writePendingOnly(dir, rows))).toThrow(/unknown columns: weakScore/);
  });

  it("rejects missing required input column at prepare", () => {
    const dir = makeTmp();
    const rows = fixtureRows(SIX_CASES);
    const idx = (rows[0] as string[]).indexOf("leftTitle");
    (rows[0] as string[]).splice(idx, 1);
    rows.slice(1).forEach((r) => r.splice(idx, 1));
    expect(() => prepareWithLabels(dir, writePendingOnly(dir, rows))).toThrow(/missing required columns: leftTitle/);
  });

  it("rejects empty leftTitle instead of freezing it", () => {
    const dir = makeTmp();
    const cases = SIX_CASES.map((c, i) => (i === 2 ? { ...c, title: "  " } : c));
    const fixture = writeFixture(dir, cases);
    expect(() => runPrepare({ ...fixture, outDir: path.join(dir, "out") })).toThrow(/leftTitle must not be empty/);
  });

  it("rejects non-blank human fields in a pending packet", () => {
    const dir = makeTmp();
    const rows = fixtureRows(SIX_CASES);
    (rows[1] as string[])[rows[0]!.indexOf("humanLabel")] = "same";
    expect(() => prepareWithLabels(dir, writePendingOnly(dir, rows))).toThrow(/human fields must be blank/);
  });

  it("rejects unclosed quotes, illegal quotes and ragged rows", () => {
    expect(() => parseCsv('a,b\n"x,2\n')).toThrow(/unclosed quoted CSV field/);
    expect(() => parseCsv('a,b\nab"c,2\n')).toThrow(/illegal quote/);
    expect(() => csvRecords("a,b\n1\n")).toThrow(/ragged CSV row/);
    expect(() => loadCsvTable("a,b,c\n1,2\n", ["a"], ["a", "b", "c"], "t")).toThrow(/ragged row 2/);
    expect(parseCsv('a,b\n"x,escaped""q",2\n')).toEqual([["a", "b"], ["x,escaped\"q", "2"]]);
  });

  it("assess reports missing label columns as invalid input, not a checksum error", () => {
    const dir = makeTmp();
    prepareSix(dir);
    const frozenPath = path.join(dir, "packet", "frozen-manifest.json");
    const sha = sha256File(frozenPath);
    const badLabels = path.join(dir, "bad-labels.csv");
    fs.writeFileSync(badLabels, stringifyCsv([["caseId", "humanLabel"], ["C-1", "same"]]));
    expect(() =>
      runAssess({ frozen: frozenPath, expectedManifestSha: sha, labels: badLabels, out: path.join(dir, "r.json") }),
    ).toThrow(/missing required columns/);
  });
});

describe("round2 frozen manifest trust root", () => {
  function packet(dir: string): { frozenPath: string; shaPath: string; labels: string; manifestSha: string } {
    prepareSix(dir);
    const frozenPath = path.join(dir, "packet", "frozen-manifest.json");
    const shaPath = path.join(dir, "packet", "frozen-manifest.sha256");
    const labels = path.join(dir, "packet", "blind-review.csv");
    return { frozenPath, shaPath, labels, manifestSha: sha256File(frozenPath) };
  }

  function rewriteFrozen(dir: string, mutate: (m: Record<string, unknown>) => void): string {
    const frozenPath = path.join(dir, "packet", "frozen-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(frozenPath, "utf8")) as Record<string, unknown>;
    mutate(manifest);
    fs.writeFileSync(frozenPath, JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(dir, "packet", "frozen-manifest.sha256"), `${sha256File(frozenPath)}\n`);
    return sha256File(frozenPath);
  }

  it("requires expectedManifestSha and rejects a bad one", () => {
    const dir = makeTmp();
    const p = packet(dir);
    expect(() => runAssess({ frozen: p.frozenPath, expectedManifestSha: "", labels: p.labels, out: path.join(dir, "r.json") }))
      .toThrow(/expectedManifestSha is required/);
    expect(() => runAssess({ frozen: p.frozenPath, expectedManifestSha: "c".repeat(64), labels: p.labels, out: path.join(dir, "r.json") }))
      .toThrow(/frozen manifest sha mismatch/);
  });

  it("maps zero truth to insufficient_truth / exit 2 with the correct digest", () => {
    const dir = makeTmp();
    const p = packet(dir);
    expect(fs.readFileSync(p.shaPath, "utf8").trim()).toBe(p.manifestSha);
    const { status, report } = runAssess({
      frozen: p.frozenPath,
      expectedManifestSha: p.manifestSha,
      labels: p.labels,
      out: path.join(dir, "r.json"),
    });
    expect(status).toBe("insufficient_truth");
    expect(report.metrics).toBeNull();
    expect(report.coverage.pending).toBe(6);
    expect(EXIT_INSUFFICIENT_TRUTH).toBe(2);
  });

  it("rejects the old digest even when the tampered manifest refreshes its sidecar", () => {
    const dir = makeTmp();
    const p = packet(dir);
    const oldSha = p.manifestSha;
    rewriteFrozen(dir, (m) => {
      (m.cases as Array<{ caseId: string }>)[0].caseId = "C-EVIL";
    });
    expect(() =>
      runAssess({ frozen: p.frozenPath, expectedManifestSha: oldSha, labels: p.labels, out: path.join(dir, "r.json") }),
    ).toThrow(/frozen manifest sha mismatch/);
  });

  it("rejects unsupported schemaVersion and undefined methodVersion with a matching digest", () => {
    const dir = makeTmp();
    packet(dir);
    const shaV2 = rewriteFrozen(dir, (m) => {
      m.schemaVersion = 2;
    });
    expect(() =>
      runAssess({ frozen: path.join(dir, "packet", "frozen-manifest.json"), expectedManifestSha: shaV2, labels: path.join(dir, "packet", "blind-review.csv"), out: path.join(dir, "r.json") }),
    ).toThrow(/schemaVersion/);

    const shaNoMethod = rewriteFrozen(dir, (m) => {
      m.schemaVersion = 1;
      delete m.methodVersion;
    });
    expect(() =>
      runAssess({ frozen: path.join(dir, "packet", "frozen-manifest.json"), expectedManifestSha: shaNoMethod, labels: path.join(dir, "packet", "blind-review.csv"), out: path.join(dir, "r.json") }),
    ).toThrow(/methodVersion/);
  });
});

describe("durable prepare output", () => {
  it("refuses a populated out-dir and preserves the existing human csv", () => {
    const dir = makeTmp();
    const fixture = writeFixture(dir, SIX_CASES);
    const outDir = path.join(dir, "packet");
    fs.mkdirSync(outDir, { recursive: true });
    const existing = path.join(outDir, "blind-review.csv");
    fs.writeFileSync(existing, "caseId,humanLabel\nC-1,same\n");
    expect(() => runPrepare({ ...fixture, outDir, now: new Date("2026-10-01T00:00:00Z") })).toThrow(
      InvalidInputError,
    );
    expect(() => runPrepare({ ...fixture, outDir, now: new Date("2026-10-01T00:00:00Z") })).toThrow(
      /refusing to overwrite/,
    );
    expect(fs.readFileSync(existing, "utf8")).toBe("caseId,humanLabel\nC-1,same\n");
    expect(fs.existsSync(path.join(outDir, "frozen-manifest.json"))).toBe(false);
  });

  it("defaults to a repo-relative dated dir, not /tmp", () => {
    const out = defaultOutDir(new Date("2026-10-01T00:00:00Z"));
    expect(out).toBe("docs/eval/reviews/cluster-quality-2026-10-01");
    expect(out.startsWith("/tmp")).toBe(false);
    expect(path.isAbsolute(out)).toBe(false);
  });
});
