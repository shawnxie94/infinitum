import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAiTaskContract } from "@/lib/ai/contracts";
import {
  buildSourceReplayBundle, digest, INCLUDED_DEV_IDS, prepareSourcePacket,
  sourceInputSchema, verifySourcePacket, type Dataset,
} from "../../scripts/prepare-cluster-relation-source-replay";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const folders: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const p of folders.splice(0)) rmSync(p, { recursive: true, force: true }); });
const fixture = (): Dataset[] => {
  const sources: Record<string, unknown> = {};
  const cases: Dataset["cases"] = INCLUDED_DEV_IDS.map((caseId, index) => {
    const ids = [`source-${index}-left`, `source-${index}-right`];
    for (const sourceId of ids) sources[sourceId] = {
      sourceId, title: sourceId, sourceUnit: "retained_rss_article", url: "https://example.org/" + sourceId,
      publishedAt: 1791514800000, publishedAtIso: "2026-10-09T11:00:00+00:00", contentText: "Literal original source text.",
      humanLabel: "LABEL_SENTINEL", humanReason: "REASON_SENTINEL", summary: "SUMMARY_SENTINEL",
    };
    return { caseId, split: "dev", leftSourceId: ids[0], rightSourceId: ids[1], humanLabel: "LABEL_SENTINEL" };
  });
  cases.push({ caseId: "SR-01", split: "dev", leftSourceId: "missing", rightSourceId: "missing", humanLabel: "LABEL_SENTINEL" });
  cases.push({ caseId: "SR-03", split: "holdout", leftSourceId: "missing", rightSourceId: "missing", humanLabel: "LABEL_SENTINEL" });
  return [{ cases, sources, labelFile: "separate-gold.csv" }];
};
const makePacket = () => {
  const parent = mkdtempSync(join(tmpdir(), "infinitum-source-contract-")); folders.push(parent);
  const path = join(parent, "packet"); const result = prepareSourcePacket(repo, path);
  return { path, result };
};
const rewriteAndReseal = (path: string, name: string, value: unknown) => {
  const text = JSON.stringify(value, null, 2) + "\n";
  writeFileSync(join(path, name), text);
  const manifest = JSON.parse(readFileSync(join(path, "manifest.json"), "utf8"));
  if (name !== "manifest.json") manifest.fileHashes[name] = digest(text);
  const manifestText = JSON.stringify(name === "manifest.json" ? value : manifest, null, 2) + "\n";
  writeFileSync(join(path, "manifest.json"), manifestText);
  writeFileSync(join(path, "manifest.sha256"), digest(manifestText) + "\n");
};

describe("offline source-evidence replay contract", () => {
  it("selects exactly stable dev cases and excludes pending/holdout before source lookup", () => {
    const b = buildSourceReplayBundle(fixture(), "核对具体发生。");
    expect(b.mapping.map((x) => x.caseId)).toEqual([...INCLUDED_DEV_IDS]);
    expect(b.input.pairs.map((x) => x.pair_id)).toEqual(["p1", "p2", "p3", "p4", "p5", "p6"]);
    expect(b.mapping.every((x) => x.split === "dev")).toBe(true);
  });
  it("does not transmit labels, rationales, reviewer mapping, or derived summaries", () => {
    const b = buildSourceReplayBundle(fixture(), "核对具体发生。");
    const wire = JSON.stringify([b.baseline, b.candidate]);
    for (const value of ["LABEL_SENTINEL", "REASON_SENTINEL", "SUMMARY_SENTINEL", "separate-gold.csv", "SR-04", "FN-01"]) expect(wire).not.toContain(value);
    expect(b.mapping[5].labelProvenance).toBe("assisted_human_confirmation");
  });
  it("preserves source content/time, leaving event date and signatures null", () => {
    const b = buildSourceReplayBundle(fixture(), "核对具体发生。");
    const side = b.input.pairs[0].left;
    expect(side.sourceEvidence.publishedAt).toBe("2026-10-09T11:00:00+00:00");
    expect(side.sourceEvidence.contentText).toBe("Literal original source text.");
    expect(side.eventDate).toBeNull(); expect(side.eventSubject).toBeNull(); expect(side.summary).toBeNull();
  });
  it("uses the full release text rather than only a curated excerpt", () => {
    const data = fixture(); const id = "source-5-left";
    data[0].sources[id] = { ...(data[0].sources[id] as object), fullReleaseBody: "Complete release body", reviewExcerpt: "excerpt" };
    expect(buildSourceReplayBundle(data, "规则").input.pairs[5].left.sourceEvidence.contentText).toBe("Complete release body");
  });
  it("keeps input/wrapper/generation parameters equal, changing only the system fragment", () => {
    const b = buildSourceReplayBundle(fixture(), "规则"); const c = getAiTaskContract("cluster_merge");
    expect(b.baseline.messages[1]).toEqual(b.candidate.messages[1]);
    expect(b.baseline.generationParameters).toEqual(b.candidate.generationParameters);
    expect(b.baseline.messages[0].content).toBe(c.systemPrompt);
    expect(b.candidate.messages[0].content).toBe(c.systemPrompt + "\n\n规则");
    expect(b.contract.baselineContractHash).toBe(c.contractHash);
  });
  it.each(["SR-02 规则", "FN-01 规则", "holdout 规则", ""]) ("rejects case/history-bearing or empty candidate: %s", (fragment) => {
    expect(() => buildSourceReplayBundle(fixture(), fragment)).toThrow("Candidate");
  });
  it("fails closed if an included case is missing, duplicated, or held out", () => {
    const missing = fixture(); missing[0].cases.shift(); expect(() => buildSourceReplayBundle(missing, "规则")).toThrow("exactly one");
    const duplicate = fixture(); duplicate[0].cases.push(duplicate[0].cases[0]); expect(() => buildSourceReplayBundle(duplicate, "规则")).toThrow("exactly one");
    const held = fixture(); (held[0].cases[0] as { split: string }).split = "holdout"; expect(() => buildSourceReplayBundle(held, "规则")).toThrow("Holdout");
  });
  it("rejects missing evidence, invalid publication time, or inconsistent source identity", () => {
    for (const change of [{ contentText: "" }, { publishedAtIso: "bad-date" }, { sourceId: "wrong-id" }]) {
      const data = fixture(); data[0].sources["source-0-left"] = { ...(data[0].sources["source-0-left"] as object), ...change };
      expect(() => buildSourceReplayBundle(data, "规则")).toThrow();
    }
  });
  it("strict input validation rejects gold properties and invented event dates", () => {
    const input = structuredClone(buildSourceReplayBundle(fixture(), "规则").input);
    expect(() => sourceInputSchema.parse({ ...input, humanLabel: "same_event" })).toThrow();
    expect(() => sourceInputSchema.parse({ pairs: [{ ...input.pairs[0], left: { ...input.pairs[0].left, eventDate: "2026-10-09" } }] })).toThrow();
  });
  it("prepares/verifies the real six-case packet without sending or reading a model", () => {
    const network = vi.fn(() => { throw new Error("network forbidden"); }); vi.stubGlobal("fetch", network);
    const { path, result } = makePacket();
    expect(verifySourcePacket(repo, path, result.manifestSha256)).toEqual(result);
    expect(network).not.toHaveBeenCalled();
    const m = JSON.parse(readFileSync(join(path, "manifest.json"), "utf8"));
    expect(m.readyForReplay).toBe(false); expect(m.authorization.sendAllowed).toBe(false); expect(m.authorization.model).toBeNull();
    expect(m.scope.productionDtoEquivalent).toBe(false); expect(m.provenance.independentBlindFollowUpPositives).toBe(0);
  });
  it("never overwrites an existing freeze", () => {
    const { path } = makePacket(); expect(() => prepareSourcePacket(repo, path)).toThrow("never overwritten");
  });
  it("detects frozen-file drift and a mismatched externally trusted anchor", () => {
    const { path } = makePacket();
    expect(() => verifySourcePacket(repo, path, "0".repeat(64))).toThrow("trust anchor");
    writeFileSync(join(path, "input.json"), "{}\n"); expect(() => verifySourcePacket(repo, path)).toThrow("Frozen file drift");
  });
  it("rejects changed source text even if local manifest file hashes are re-sealed", () => {
    const { path } = makePacket(); const input = JSON.parse(readFileSync(join(path, "input.json"), "utf8"));
    input.pairs[0].left.sourceEvidence.contentText = "invented evidence";
    rewriteAndReseal(path, "input.json", input); expect(() => verifySourcePacket(repo, path)).toThrow("Original source evidence");
  });
  it("rejects a changed candidate user prompt even after file hash resealing", () => {
    const { path } = makePacket(); const request = JSON.parse(readFileSync(join(path, "candidate.request.json"), "utf8"));
    request.messages[1].content += "label hint"; rewriteAndReseal(path, "candidate.request.json", request);
    expect(() => verifySourcePacket(repo, path)).toThrow("Request contract");
  });
  it("rejects pretending source-only preparation is production validation", () => {
    const { path } = makePacket(); const manifest = JSON.parse(readFileSync(join(path, "manifest.json"), "utf8"));
    manifest.scope.productionDtoEquivalent = true; rewriteAndReseal(path, "manifest.json", manifest);
    expect(() => verifySourcePacket(repo, path)).toThrow("offline-only");
  });
});
