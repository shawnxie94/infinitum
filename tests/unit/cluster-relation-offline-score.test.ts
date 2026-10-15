import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { digest } from "../../scripts/prepare-cluster-relation-source-replay";
import { compareReceipts, FROZEN_PACKET, FROZEN_SHA, loadScoringContext, makeSimulationReceipt,
  parseCsv, parseStrictResponse, runMock, scoreDecisions, verifyMock, type Receipt, type ScoringContext, type Relation,
} from "../../scripts/score-cluster-relation-source-replay";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const context = (): ScoringContext => ({ manifestSha256: "a".repeat(64), requestHashes: { baseline: "b".repeat(64), candidate: "c".repeat(64) }, pairs: [
  { pairId: "p1", caseId: "D1", gold: "same_event", labelProvenance: "initial" },
  { pairId: "p2", caseId: "D2", gold: "unrelated", labelProvenance: "initial" },
  { pairId: "p3", caseId: "D3", gold: "follow_up", labelProvenance: "assisted_human_confirmation" },
] });
const mutateResponse = (receipt: Receipt, mutate: (document: { decisions: Record<string, unknown>[] }) => void) => {
  const doc = JSON.parse(receipt.rawResponse); mutate(doc); const rawResponse = JSON.stringify(doc);
  return { ...receipt, rawResponse, responseSha256: digest(rawResponse) };
};
const dirs: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("strict offline receipt scoring", () => {
  it("parses reordered complete decisions by pair_id", () => {
    const c = context(); const r = mutateResponse(makeSimulationReceipt(c, "baseline", ["same_event", "unrelated", "follow_up"]), (d) => d.decisions.reverse());
    expect(parseStrictResponse(r.rawResponse, c.pairs).map((x) => x.pair_id)).toEqual(["p1", "p2", "p3"]);
  });
  it.each(["missing", "duplicate", "unknown", "extra", "bad-reason", "float-confidence", "range-confidence", "empty-reason", "english-reason", "extra-field", "legacy-verdict"])("rejects %s response as protocol failure, not negative labels", (kind) => {
    const c = context(); const base = makeSimulationReceipt(c, "baseline", ["same_event", "unrelated", "follow_up"]);
    const bad = mutateResponse(base, (d) => {
      if (kind === "missing") d.decisions.pop();
      if (kind === "duplicate") d.decisions[1].pair_id = "p1";
      if (kind === "unknown") d.decisions[1].pair_id = "p999";
      if (kind === "extra") d.decisions.push(d.decisions[0]);
      if (kind === "bad-reason") d.decisions[0].reasonCode = "synthesis_article";
      if (kind === "float-confidence") d.decisions[0].confidence = 90.5;
      if (kind === "range-confidence") d.decisions[0].confidence = 101;
      if (kind === "empty-reason") d.decisions[0].reasonText = "  ";
      if (kind === "english-reason") d.decisions[0].reasonText = "same event";
      if (kind === "extra-field") d.decisions[0].verdict = "approved";
      if (kind === "legacy-verdict") { delete d.decisions[0].relation; d.decisions[0].verdict = "approved"; }
    });
    const result = compareReceipts(c, bad, makeSimulationReceipt(c, "candidate", ["same_event", "unrelated", "follow_up"]));
    expect(result.baseline.status).toBe("protocol_failed"); expect(result.baseline.metrics).toBeNull(); expect(result.paired).toBeNull();
    expect(result.candidate.metrics?.pairs).toBe(3);
  });
  it.each(["arm", "manifest", "request", "response", "real-kind", "extra-envelope"])("rejects invalid %s binding/envelope", (kind) => {
    const c = context(); const base: Record<string, unknown> = { ...makeSimulationReceipt(c, "baseline", ["same_event", "unrelated", "follow_up"]) };
    if (kind === "arm") base.arm = "candidate";
    if (kind === "manifest") base.manifestSha256 = "d".repeat(64);
    if (kind === "request") base.requestSha256 = c.requestHashes.candidate;
    if (kind === "response") base.responseSha256 = "e".repeat(64);
    if (kind === "real-kind") base.kind = "model_receipt";
    if (kind === "extra-envelope") base.model = "unauthorized";
    expect(compareReceipts(c, base, makeSimulationReceipt(c, "candidate", ["same_event", "unrelated", "follow_up"])).baseline.metrics).toBeNull();
  });
  it("rejects malformed JSON and fenced JSON instead of repairing an evaluation receipt", () => {
    const c = context();
    for (const raw of ["{not json", "```json\n{}\n```", "[]", "{}", '{"decisions":[],"extra":1}']) expect(() => parseStrictResponse(raw, c.pairs)).toThrow();
  });
  it("separates false merge, explicit missed same, and uncertain holds", () => {
    const c = context();
    const r = makeSimulationReceipt(c, "baseline", ["uncertain", "same_event", "unrelated"]);
    const metrics = scoreDecisions(c.pairs, parseStrictResponse(r.rawResponse, c.pairs));
    expect(metrics).toMatchObject({ pairs: 3, relationMatches: 0, falseMerge: 1, goldDifferent: 2, falseMergeRate: .5,
      missedSame: 1, goldSame: 1, missedSameRate: 1, heldSame: 1, explicitRejectedSame: 0, abstentions: 1,
      binaryDecisivePairs: 2, binaryMatchesOnDecisive: 1, binaryAccuracyOnDecisive: .5, decisiveCoverage: 2 / 3 });
    expect(metrics.cases[0].action).toBe("manual_hold");
  });
  it("does not award binary correctness to all-uncertain output", () => {
    const c = context(); const r = makeSimulationReceipt(c, "baseline", ["uncertain", "uncertain", "uncertain"]);
    const metrics = scoreDecisions(c.pairs, parseStrictResponse(r.rawResponse, c.pairs));
    expect(metrics.binaryAccuracyOnDecisive).toBeNull(); expect(metrics.decisiveCoverage).toBe(0); expect(metrics.abstentions).toBe(3);
    expect(metrics.missedSame).toBe(1); expect(metrics.heldSame).toBe(1);
  });
  it("returns null rates for zero denominators and never treats uncertain gold as known negative", () => {
    const c = context(); c.pairs = [c.pairs[0]];
    const r = makeSimulationReceipt(c, "baseline", ["same_event"]);
    expect(scoreDecisions(c.pairs, parseStrictResponse(r.rawResponse, c.pairs)).falseMergeRate).toBeNull();
    c.pairs[0].gold = "uncertain";
    const score = scoreDecisions(c.pairs, parseStrictResponse(r.rawResponse, c.pairs));
    expect(score.goldUncertain).toBe(1); expect(score.falseMergeRate).toBeNull(); expect(score.binaryAccuracyOnDecisive).toBeNull();
    expect(scoreDecisions([], []).relationAccuracy).toBeNull();
  });
  it("rejects absent/misaligned scoring decisions", () => {
    const c = context(); expect(() => scoreDecisions(c.pairs, [])).toThrow("Aligned");
    const ds = parseStrictResponse(makeSimulationReceipt(c, "baseline", ["same_event", "unrelated", "follow_up"]).rawResponse, c.pairs);
    expect(() => scoreDecisions(c.pairs, ds.reverse())).toThrow("Aligned");
  });
  it("keeps assisted gold separate and never promotes simulated improvements to quality evidence", () => {
    const c = context(); const report = compareReceipts(c,
      makeSimulationReceipt(c, "baseline", ["uncertain", "same_event", "unrelated"]),
      makeSimulationReceipt(c, "candidate", ["same_event", "unrelated", "follow_up"]));
    expect(report.paired?.changes).toHaveLength(3);
    expect(report.candidate.byProvenance?.assisted_human_confirmation.pairs).toBe(1);
    expect(report.interpretation.numericResultsAreSimulated).toBe(true); expect(report.interpretation.qualityPassed).toBe(false);
    expect(report.interpretation.modelBehaviorValidated).toBe(false); expect(report.interpretation.independentBlindFollowUpPositives).toBe(0);
  });
  it("does not turn empty-data paired rates into zero", () => {
    const c = context(); c.pairs = [];
    const report = compareReceipts(c, makeSimulationReceipt(c, "baseline", []), makeSimulationReceipt(c, "candidate", []));
    expect(report.paired?.relationAccuracyDelta).toBeNull(); expect(report.paired?.binaryAccuracyOnDecisiveDelta).toBeNull();
  });
  it("handles quoted CSV reasons, escaped quotes, CRLF, BOM, and multiline data", () => {
    const rows = parseCsv('\uFEFFcaseId,humanReason\r\nD1,"a,b\n""quoted"""\r\n');
    expect(rows).toEqual([{ caseId: "D1", humanReason: 'a,b\n"quoted"' }]);
  });
  it.each(['a,a\n1,2', 'a,b\n1', 'a,b\n"unclosed,2', 'a,b\n"ok"bad,2']) ("rejects malformed CSV %s", (text) => expect(() => parseCsv(text)).toThrow());
  it("loads exactly the six bound dev labels without changing the packet", () => {
    const c = loadScoringContext(repo, resolve(repo, FROZEN_PACKET), FROZEN_SHA);
    expect(c.pairs.map((p) => p.caseId)).toEqual(["SR-02", "SR-04", "SR-05", "SR-06", "SR-08", "FN-01"]);
    expect(c.pairs.map((p) => p.gold)).toEqual(["unrelated", "same_event", "same_event", "same_event", "synthesis", "follow_up"]);
  });
  it("runs receipt→validate→score→report verification without network or overwrite", () => {
    const network = vi.fn(() => { throw new Error("network forbidden"); }); vi.stubGlobal("fetch", network);
    const dir = mkdtempSync(join(tmpdir(), "infinitum-offline-score-")); dirs.push(dir); const out = join(dir, "mock");
    expect(runMock(repo, out)).toMatchObject({ pairs: 6, receiptKind: "simulation", requestsSent: 0, qualityPassed: false });
    expect(network).not.toHaveBeenCalled(); expect(() => runMock(repo, out)).toThrow("never overwrite");
    const report = JSON.parse(readFileSync(join(out, "simulation.report.json"), "utf8")); report.interpretation.qualityPassed = true;
    writeFileSync(join(out, "simulation.report.json"), JSON.stringify(report)); expect(() => verifyMock(repo, out)).toThrow("does not match");
  });
  it("checks each relation/reason combination used by simulated outcomes", () => {
    const c = context();
    for (const r of ["same_event", "follow_up", "synthesis", "unrelated", "uncertain"] as Relation[]) expect(parseStrictResponse(makeSimulationReceipt(c, "baseline", [r, r, r]).rawResponse, c.pairs)).toHaveLength(3);
  });
});
