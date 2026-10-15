/** Offline receipt validation/scoring. No model client, network, credentials, or database writes. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { digest, verifySourcePacket } from "./prepare-cluster-relation-source-replay";

export const FROZEN_PACKET = "docs/eval/reviews/cluster-relation-offline-contract-2026-10-14/packet";
export const FROZEN_SHA = "1495ed0fb7576e0304e9045554abb4ad77d18b88be7bf83bf454396146b4fb40";
export const RELATIONS = ["same_event", "follow_up", "synthesis", "unrelated", "uncertain"] as const;
const relationSchema = z.enum(RELATIONS);
export type Relation = z.infer<typeof relationSchema>;
const reasons: Record<Relation, readonly string[]> = {
  same_event: ["same_event"], follow_up: ["follow_up_event"], synthesis: ["synthesis_article"],
  unrelated: ["different_event", "object_conflict", "action_conflict", "date_conflict", "subject_conflict"], uncertain: ["insufficient_evidence"],
};
const decisionSchema = z.object({ pair_id: z.string(), relation: relationSchema,
  confidence: z.number().int().min(0).max(100), reasonCode: z.string(),
  reasonText: z.string().trim().min(1).regex(/[\u3400-\u9fff]/, "reasonText must include Chinese text"),
}).strict().superRefine((d, ctx) => {
  if (!reasons[d.relation].includes(d.reasonCode)) ctx.addIssue({ code: "custom", message: "relation/reasonCode mismatch" });
});
export type Decision = z.infer<typeof decisionSchema>;
const receiptSchema = z.object({ schemaVersion: z.literal(1), kind: z.enum(["simulation", "model_receipt"]),
  arm: z.enum(["baseline", "candidate"]), manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  requestSha256: z.string().regex(/^[a-f0-9]{64}$/), responseSha256: z.string().regex(/^[a-f0-9]{64}$/),
  rawResponse: z.string(),
}).strict();
export type Receipt = z.infer<typeof receiptSchema>;
export type ScoringPair = { pairId: string; caseId: string; gold: Relation; labelProvenance: string };
export type ScoringContext = { manifestSha256: string; requestHashes: Record<"baseline" | "candidate", string>; pairs: ScoringPair[] };
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const loadJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

/** RFC4180-style parsing; do not split quoted human reasons on commas/newlines. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []; let row: string[] = []; let field = ""; let quoted = false; let closed = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else field += c;
    } else if (c === '"') {
      if (field || closed) throw new Error("Malformed CSV quoting"); quoted = true;
    } else if (c === ",") { row.push(field); field = ""; closed = false; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); if (row.some((x) => x !== "")) rows.push(row); row = []; field = ""; closed = false;
    } else { if (closed) throw new Error("Unexpected characters after CSV quote"); field += c; }
  }
  if (quoted) throw new Error("Unclosed CSV quote");
  if (field || row.length || closed) { row.push(field); rows.push(row); }
  const header = rows.shift();
  if (!header?.length || new Set(header).size !== header.length) throw new Error("Missing/duplicate CSV headers");
  return rows.map((r) => { if (r.length !== header.length) throw new Error("CSV column mismatch"); return Object.fromEntries(header.map((key, i) => [key, r[i]])); });
}

const mapSchema = z.array(z.object({ pairId: z.string(), caseId: z.string(), split: z.literal("dev"), labelFile: z.string(),
  labelProvenance: z.string(), leftSourceId: z.string(), rightSourceId: z.string() }).strict());
export function loadScoringContext(repo: string, packet: string, expectedSha: string): ScoringContext {
  verifySourcePacket(repo, packet, expectedSha);
  const mapping = mapSchema.parse(loadJson(resolve(packet, "mapping.json")));
  const pairs = mapping.map((m) => {
    const rows = parseCsv(readFileSync(resolve(repo, m.labelFile), "utf8")).filter((r) => r.caseId === m.caseId);
    if (rows.length !== 1 || rows[0].split !== "dev" || rows[0].pairKey !== `${m.leftSourceId}|${m.rightSourceId}`) throw new Error(`Gold identity/split mismatch: ${m.caseId}`);
    return { pairId: m.pairId, caseId: m.caseId, gold: relationSchema.parse(rows[0].humanLabel), labelProvenance: m.labelProvenance };
  });
  return { manifestSha256: expectedSha, requestHashes: {
    baseline: digest(readFileSync(resolve(packet, "baseline.request.json"))),
    candidate: digest(readFileSync(resolve(packet, "candidate.request.json"))),
  }, pairs };
}

export function parseStrictResponse(raw: string, pairs: ScoringPair[]): Decision[] {
  const { decisions } = z.object({ decisions: z.array(decisionSchema) }).strict().parse(JSON.parse(raw));
  const expected = new Set(pairs.map((p) => p.pairId));
  if (expected.size !== pairs.length || decisions.length !== pairs.length) throw new Error("Decision coverage mismatch");
  const byId = new Map<string, Decision>();
  for (const d of decisions) {
    if (!expected.has(d.pair_id) || byId.has(d.pair_id)) throw new Error("Unknown/duplicate pair_id");
    byId.set(d.pair_id, d);
  }
  return pairs.map((p) => { const d = byId.get(p.pairId); if (!d) throw new Error("Missing pair_id"); return d; });
}

const rate = (numerator: number, denominator: number) => denominator ? numerator / denominator : null;
export function scoreDecisions(pairs: ScoringPair[], decisions: Decision[]) {
  if (pairs.length !== decisions.length || pairs.some((p, i) => p.pairId !== decisions[i].pair_id)) throw new Error("Aligned decisions required");
  const confusion = Object.fromEntries(RELATIONS.map((gold) => [gold, Object.fromEntries(RELATIONS.map((pred) => [pred, 0]))])) as Record<Relation, Record<Relation, number>>;
  let exact = 0, known = 0, decisive = 0, binaryCorrect = 0, goldSame = 0, goldDifferent = 0;
  let falseMerge = 0, missedSame = 0, explicitRejectedSame = 0, heldSame = 0, abstentions = 0;
  const cases = pairs.map((p, i) => {
    const d = decisions[i]; confusion[p.gold][d.relation]++;
    if (p.gold === d.relation) exact++;
    if (d.relation === "uncertain") abstentions++;
    if (p.gold !== "uncertain") {
      known++;
      if (d.relation !== "uncertain") { decisive++; if ((p.gold === "same_event") === (d.relation === "same_event")) binaryCorrect++; }
      if (p.gold === "same_event") {
        goldSame++; if (d.relation !== "same_event") { missedSame++; if (d.relation === "uncertain") heldSame++; else explicitRejectedSame++; }
      } else { goldDifferent++; if (d.relation === "same_event") falseMerge++; }
    }
    return { pairId: p.pairId, caseId: p.caseId, gold: p.gold, predicted: d.relation, relationCorrect: p.gold === d.relation,
      action: d.relation === "same_event" ? "merge" : d.relation === "uncertain" ? "manual_hold" : "do_not_merge", labelProvenance: p.labelProvenance };
  });
  return { pairs: pairs.length, relationMatches: exact, relationAccuracy: rate(exact, pairs.length),
    binaryDecisivePairs: decisive, binaryMatchesOnDecisive: binaryCorrect, binaryAccuracyOnDecisive: rate(binaryCorrect, decisive),
    decisiveCoverage: rate(decisive, known), abstentions, goldUncertain: pairs.length - known,
    goldSame, goldDifferent, falseMerge, falseMergeRate: rate(falseMerge, goldDifferent),
    missedSame, missedSameRate: rate(missedSame, goldSame), explicitRejectedSame, heldSame, confusion, cases };
}

function scoreArm(context: ScoringContext, arm: Receipt["arm"], unknownReceipt: unknown) {
  try {
    const receipt = receiptSchema.parse(unknownReceipt);
    if (receipt.kind !== "simulation") throw new Error("Real-model receipts require a separately authorized and verified replay stage");
    if (receipt.arm !== arm || receipt.manifestSha256 !== context.manifestSha256 || receipt.requestSha256 !== context.requestHashes[arm] || receipt.responseSha256 !== digest(receipt.rawResponse)) throw new Error("Receipt arm/request/manifest/response binding mismatch");
    const decisions = parseStrictResponse(receipt.rawResponse, context.pairs);
    const byProvenance = Object.fromEntries([...new Set(context.pairs.map((p) => p.labelProvenance))].map((provenance) => {
      const indexes = context.pairs.map((p, i) => p.labelProvenance === provenance ? i : -1).filter((i) => i >= 0);
      return [provenance, scoreDecisions(indexes.map((i) => context.pairs[i]), indexes.map((i) => decisions[i]))];
    }));
    return { status: "valid" as const, metrics: scoreDecisions(context.pairs, decisions), byProvenance, decisions, failure: null };
  } catch (e) {
    return { status: "protocol_failed" as const, metrics: null, byProvenance: null, decisions: null,
      failure: e instanceof Error ? e.message : "Unknown receipt validation failure" };
  }
}

export function compareReceipts(context: ScoringContext, baselineReceipt: unknown, candidateReceipt: unknown) {
  const baseline = scoreArm(context, "baseline", baselineReceipt); const candidate = scoreArm(context, "candidate", candidateReceipt);
  const paired = baseline.metrics && candidate.metrics ? {
    relationAccuracyDelta: candidate.metrics.relationAccuracy !== null && baseline.metrics.relationAccuracy !== null ? candidate.metrics.relationAccuracy - baseline.metrics.relationAccuracy : null,
    binaryAccuracyOnDecisiveDelta: candidate.metrics.binaryAccuracyOnDecisive !== null && baseline.metrics.binaryAccuracyOnDecisive !== null ? candidate.metrics.binaryAccuracyOnDecisive - baseline.metrics.binaryAccuracyOnDecisive : null,
    falseMergeDelta: candidate.metrics.falseMerge - baseline.metrics.falseMerge,
    missedSameDelta: candidate.metrics.missedSame - baseline.metrics.missedSame,
    changes: context.pairs.flatMap((p, i) => baseline.decisions![i].relation === candidate.decisions![i].relation ? [] : [{
      caseId: p.caseId, pairId: p.pairId, gold: p.gold, baseline: baseline.decisions![i].relation, candidate: candidate.decisions![i].relation,
    }]),
  } : null;
  return { schemaVersion: 1, status: paired ? "simulation_scored" : "simulation_protocol_failure", receiptKind: "simulation",
    manifestSha256: context.manifestSha256, requestsSent: 0, baseline, candidate, paired,
    interpretation: { numericResultsAreSimulated: true, modelBehaviorValidated: false, productionEffectValidated: false,
      independentBlindFollowUpPositives: 0, independentHoldoutEffectEvidence: false, qualityPassed: false, releaseEligible: false,
      ratesUseExplicitDenominators: true, uncertainIsManualHoldNotConfidentRejection: true,
      missedSameIncludesHeldSameWithSeparateCounts: true, protocolFailuresAreNotNegativeDecisions: true },
  };
}

export function makeSimulationReceipt(context: ScoringContext, arm: Receipt["arm"], relations: Relation[]): Receipt {
  if (relations.length !== context.pairs.length) throw new Error("Mock coverage mismatch");
  const rawResponse = JSON.stringify({ decisions: relations.map((relation, i) => ({ pair_id: context.pairs[i].pairId, relation,
    confidence: 90, reasonCode: reasons[relation][0], reasonText: "模拟测试结果，仅用于验证离线处理代码，不代表模型判断。" })) });
  return { schemaVersion: 1, kind: "simulation", arm, manifestSha256: context.manifestSha256,
    requestSha256: context.requestHashes[arm], responseSha256: digest(rawResponse), rawResponse };
}

function writeNew(folder: string, files: Record<string, unknown>) {
  if (existsSync(folder)) throw new Error("Output exists; never overwrite receipts/reports");
  mkdirSync(dirname(folder), { recursive: true }); mkdirSync(folder);
  for (const [name, value] of Object.entries(files)) writeFileSync(resolve(folder, name), json(value), { flag: "wx" });
}
export function runMock(repo: string, out: string) {
  const context = loadScoringContext(repo, resolve(repo, FROZEN_PACKET), FROZEN_SHA);
  const candidateRelations = context.pairs.map((p) => p.gold); // Explicitly mock oracle, never a model prediction.
  const baselineRelations = candidateRelations.map((r, i) => i === 0 ? "same_event" as const : i === 1 ? "uncertain" as const : r);
  const baseline = makeSimulationReceipt(context, "baseline", baselineRelations);
  const candidate = makeSimulationReceipt(context, "candidate", candidateRelations);
  const report = compareReceipts(context, baseline, candidate);
  writeNew(out, { "baseline.simulation.json": baseline, "candidate.simulation.json": candidate, "simulation.report.json": report });
  return verifyMock(repo, out);
}
export function verifyMock(repo: string, folder: string) {
  const context = loadScoringContext(repo, resolve(repo, FROZEN_PACKET), FROZEN_SHA);
  const recomputed = compareReceipts(context, loadJson(resolve(folder, "baseline.simulation.json")), loadJson(resolve(folder, "candidate.simulation.json")));
  if (recomputed.status !== "simulation_scored" || JSON.stringify(loadJson(resolve(folder, "simulation.report.json"))) !== JSON.stringify(recomputed)) throw new Error("Mock report does not match bound receipts/gold");
  return { pairs: context.pairs.length, receiptKind: "simulation", requestsSent: 0, qualityPassed: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , action, ...args] = process.argv; const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if ((action === "--mock" || action === "--verify-mock") && args.length === 1) {
    console.log(JSON.stringify(action === "--mock" ? runMock(repo, resolve(args[0])) : verifyMock(repo, resolve(args[0]))));
  } else if (action === "--score" && args.length === 6) {
    const [packet, sha, baselinePath, candidatePath, out, tag] = args;
    if (tag !== "simulation") throw new Error("Only explicit simulation scoring is enabled in this stage");
    const context = loadScoringContext(repo, resolve(packet), sha);
    const report = compareReceipts(context, loadJson(resolve(baselinePath)), loadJson(resolve(candidatePath)));
    writeNew(resolve(out), { "simulation.report.json": report }); console.log(JSON.stringify({ status: report.status, requestsSent: 0 }));
    if (report.status !== "simulation_scored") process.exitCode = 2;
  } else throw new Error("Usage: --mock NEW_DIR | --verify-mock DIR | --score PACKET SHA BASELINE CANDIDATE NEW_OUT simulation; no send mode");
}
