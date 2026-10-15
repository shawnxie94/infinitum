/** Offline preparation only: no provider/client, network, database, or credential access. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { buildAiUserContent, getAiTaskContract } from "../src/lib/ai/contracts";

export const INCLUDED_DEV_IDS = ["SR-02", "SR-04", "SR-05", "SR-06", "SR-08", "FN-01"] as const;
const evidenceSchema = z.object({
  sourceId: z.string().min(1), sourceUnit: z.string().min(1), url: z.string().url(),
  publishedAt: z.string().datetime({ offset: true }), contentText: z.string().min(1),
}).strict();
const sideSchema = z.object({
  id: z.string().min(1), itemCount: z.literal(1), title: z.string().min(1),
  summary: z.null(), eventType: z.null(), eventSubject: z.null(), eventAction: z.null(),
  eventObject: z.null(), eventDate: z.null(), sourceEvidence: evidenceSchema,
}).strict();
export const sourceInputSchema = z.object({ pairs: z.array(z.object({
  pair_id: z.string().regex(/^p[1-9]\d*$/), left: sideSchema, right: sideSchema,
}).strict()).min(1) }).strict();
const caseSchema = z.object({ caseId: z.string(), split: z.enum(["dev", "holdout"]), leftSourceId: z.string(), rightSourceId: z.string() });
const sourceSchema = z.object({
  sourceId: z.string(), title: z.string().min(1), url: z.string().url(), sourceUnit: z.string().min(1),
  contentText: z.string().optional(), fullReleaseBody: z.string().optional(),
  publishedAtIso: z.string().optional(), publishedAt: z.union([z.string(), z.number()]).optional(),
});
export type Dataset = { cases: unknown[]; sources: Record<string, unknown>; labelFile: string };
export const digest = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const jsonText = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

export function buildSourceReplayBundle(datasets: Dataset[], fragment: string) {
  if (!fragment.trim() || /SR-\d|FN-\d|holdout/.test(fragment)) throw new Error("Candidate must contain business rules, not case/history identifiers");
  const selected = INCLUDED_DEV_IDS.map((caseId) => {
    const matches = datasets.flatMap((dataset) => dataset.cases.map((raw) => ({ dataset, item: caseSchema.parse(raw) }))).filter(({ item }) => item.caseId === caseId);
    if (matches.length !== 1) throw new Error(`Expected exactly one case: ${caseId}`);
    const selected = matches[0];
    if (selected.item.split !== "dev") throw new Error(`Holdout is forbidden: ${caseId}`);
    return selected;
  });
  const mapping = selected.map(({ item, dataset }, i) => ({
    pairId: `p${i + 1}`, caseId: item.caseId, split: "dev", labelFile: dataset.labelFile,
    labelProvenance: item.caseId === "FN-01" ? "assisted_human_confirmation" : "initial_user_label_with_any_later_rationale_recorded_separately",
    leftSourceId: item.leftSourceId, rightSourceId: item.rightSourceId,
  }));
  const side = (dataset: Dataset, id: string) => {
    const source = sourceSchema.parse(dataset.sources[id]);
    if (source.sourceId !== id) throw new Error(`Source identity mismatch: ${id}`);
    const body = source.fullReleaseBody ?? source.contentText;
    const publishedAt = source.publishedAtIso ?? source.publishedAt;
    if (!body?.trim() || typeof publishedAt !== "string") throw new Error(`Missing original text/ISO publication time: ${id}`);
    return {
      id, itemCount: 1 as const, title: source.title, summary: null,
      eventType: null, eventSubject: null, eventAction: null, eventObject: null, eventDate: null,
      sourceEvidence: { sourceId: id, sourceUnit: source.sourceUnit, url: source.url, publishedAt, contentText: body },
    };
  };
  const input = sourceInputSchema.parse({ pairs: selected.map(({ item, dataset }, i) => ({
    pair_id: `p${i + 1}`, left: side(dataset, item.leftSourceId), right: side(dataset, item.rightSourceId),
  })) });
  const contract = getAiTaskContract("cluster_merge");
  const user = buildAiUserContent(contract.defaultUserInstruction, input);
  const parameters = { temperature: 0, maxTokens: 2000 };
  const makeRequest = (system: string) => ({
    generationParameters: parameters,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
  });
  const candidateSystem = `${contract.systemPrompt}\n\n${fragment.trim()}`;
  return {
    input, mapping, baseline: makeRequest(contract.systemPrompt), candidate: makeRequest(candidateSystem),
    contract: { version: contract.contractVersion, baselineContractHash: contract.contractHash,
      candidateContractHash: digest(`cluster_merge:${contract.contractVersion}:${candidateSystem}`) },
  };
}

const REVIEWS = "docs/eval/reviews";
const SOURCE_BATCH = `${REVIEWS}/cluster-relation-source-verified-2026-10-14`;
const FOLLOW_BATCH = `${REVIEWS}/cluster-relation-follow-up-2026-10-14`;
const FRAGMENT = `${REVIEWS}/cluster-relation-dev-boundary-2026-10-14/prompt-candidate-v2.txt`;
const RECHECK = `${REVIEWS}/cluster-relation-dev-recheck-2026-10-14/dev-recheck.json`;
export const REFERENCE_PATHS = [
  ...[SOURCE_BATCH, FOLLOW_BATCH].flatMap((p) => ["cases.json", "sources.json", "reviewed-v1.csv", "human-review-v1.json", "frozen-manifest.json"].map((f) => `${p}/${f}`)),
  FRAGMENT, RECHECK, "src/config/prompts.ts", "src/lib/ai/contracts.ts", "scripts/prepare-cluster-relation-source-replay.ts",
];
const loadJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const loadDatasets = (repo: string): Dataset[] => [SOURCE_BATCH, FOLLOW_BATCH].map((folder) => ({
  cases: loadJson(resolve(repo, folder, "cases.json")).cases,
  sources: loadJson(resolve(repo, folder, "sources.json")).sources,
  labelFile: `${folder}/reviewed-v1.csv`,
}));

export function prepareSourcePacket(repo: string, out: string) {
  if (existsSync(out)) throw new Error("Output already exists; frozen packets are never overwritten");
  const recheck = loadJson(resolve(repo, RECHECK));
  if (recheck.decisions?.["SR-01"]?.eligibleAsSettledBoundaryEvidence !== false) throw new Error("Recheck quarantine status changed; reassess the fixed case selection");
  const datasets = loadDatasets(repo);
  const references = Object.fromEntries(REFERENCE_PATHS.map((p) => [p, digest(readFileSync(resolve(repo, p)))]));
  const bundle = buildSourceReplayBundle(datasets, readFileSync(resolve(repo, FRAGMENT), "utf8"));
  const artifacts = {
    "input.json": jsonText(bundle.input), "mapping.json": jsonText(bundle.mapping),
    "baseline.request.json": jsonText(bundle.baseline), "candidate.request.json": jsonText(bundle.candidate),
  };
  const manifest = {
    schemaVersion: 1, inputContract: "source-evidence-dev-v1", track: "source_augmented_development_diagnostic", readyForReplay: false,
    generatedAt: new Date().toISOString(), caseIds: [...INCLUDED_DEV_IDS], pairCount: 6,
    excluded: { pending: ["SR-01"], holdout: ["SR-03", "SR-07", "FN-02"] },
    scope: { productionDtoEquivalent: false, productionCandidateAdmissionMeasured: false, sourceRecordPerSide: 1,
      extraInputField: "sourceEvidence", missingStructuredSignaturesAreNull: true, publicationIsNotEventDate: true,
      sameUserInputForBothArms: true, promptChangeOnly: "append unapplied v2 business-rule fragment to current baseline system prompt" },
    outputContract: { decisions: "one per pair_id", relationToReason: {
      same_event: ["same_event"], follow_up: ["follow_up_event"], synthesis: ["synthesis_article"],
      uncertain: ["insufficient_evidence"], unrelated: ["different_event", "object_conflict", "action_conflict", "date_conflict", "subject_conflict"],
    }, confidence: "integer 0..100", reasonText: "nonempty Chinese text", mergeOnly: "same_event" },
    provenance: { independentBlindFollowUpPositives: 0, assistedFollowUpDiagnosticCase: "FN-01", labelValuesNotIncludedInRequests: true },
    authorization: { sendAllowed: false, modelProvider: null, model: null, requestsSent: 0, retries: 0,
      plannedArms: 2, paidReplayRequiresNewAuthorization: true, priorAuthorizationNotReused: true },
    ready: { wireContractPrepared: true, modelBehaviorValidated: false, productionReleaseEligible: false, independentEffectEvidenceReady: false },
    ...bundle.contract, references,
    fileHashes: Object.fromEntries(Object.entries(artifacts).map(([name, text]) => [name, digest(text)])),
    inputContentSha256: digest(JSON.stringify(bundle.input)), userMessageSha256: digest(bundle.baseline.messages[1].content),
  };
  mkdirSync(dirname(out), { recursive: true });
  mkdirSync(out);
  for (const [name, text] of Object.entries(artifacts)) writeFileSync(resolve(out, name), text, { flag: "wx" });
  const manifestText = jsonText(manifest);
  writeFileSync(resolve(out, "manifest.json"), manifestText, { flag: "wx" });
  writeFileSync(resolve(out, "manifest.sha256"), digest(manifestText) + "\n", { flag: "wx" });
  verifySourcePacket(repo, out);
  return { pairCount: 6, manifestSha256: digest(manifestText), requestsSent: 0 };
}

export function verifySourcePacket(repo: string, packet: string, expectedManifestSha?: string) {
  const anchor = readFileSync(resolve(packet, "manifest.sha256"), "utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(anchor) || digest(readFileSync(resolve(packet, "manifest.json"))) !== anchor || (expectedManifestSha && expectedManifestSha !== anchor)) throw new Error("Manifest trust anchor mismatch");
  const manifest = loadJson(resolve(packet, "manifest.json"));
  if (manifest.inputContract !== "source-evidence-dev-v1" || JSON.stringify(manifest.caseIds) !== JSON.stringify(INCLUDED_DEV_IDS)) throw new Error("Unexpected input contract/selection");
  for (const [path, hash] of Object.entries(manifest.references)) if (digest(readFileSync(resolve(repo, path))) !== hash) throw new Error(`Source/Prompt reference drift: ${path}`);
  for (const [name, hash] of Object.entries(manifest.fileHashes)) if (digest(readFileSync(resolve(packet, name))) !== hash) throw new Error(`Frozen file drift: ${name}`);
  const input = sourceInputSchema.parse(loadJson(resolve(packet, "input.json")));
  const mapping = loadJson(resolve(packet, "mapping.json"));
  if (input.pairs.length !== 6 || mapping.length !== 6 || mapping.some((x: { caseId: string; split: string; pairId: string }, i: number) => x.caseId !== INCLUDED_DEV_IDS[i] || x.split !== "dev" || x.pairId !== input.pairs[i].pair_id)) throw new Error("Case mapping mismatch");
  const baseline = loadJson(resolve(packet, "baseline.request.json"));
  const candidate = loadJson(resolve(packet, "candidate.request.json"));
  const contract = getAiTaskContract("cluster_merge");
  const fragment = readFileSync(resolve(repo, FRAGMENT), "utf8").trim();
  const expectedBundle = buildSourceReplayBundle(loadDatasets(repo), fragment);
  if (JSON.stringify(input) !== JSON.stringify(expectedBundle.input) || JSON.stringify(mapping) !== JSON.stringify(expectedBundle.mapping)) throw new Error("Original source evidence/mapping mismatch");
  if (JSON.stringify(baseline) !== JSON.stringify(expectedBundle.baseline) || JSON.stringify(candidate) !== JSON.stringify(expectedBundle.candidate)) throw new Error("Request contract mismatch");
  const expectedSystem = [contract.systemPrompt, `${contract.systemPrompt}\n\n${fragment}`];
  for (const [i, request] of [baseline, candidate].entries()) {
    if (request.messages.length !== 2 || request.messages[0].role !== "system" || request.messages[0].content !== expectedSystem[i] || request.messages[1].role !== "user" || request.messages[1].content !== buildAiUserContent(contract.defaultUserInstruction, input)) throw new Error("Request contract mismatch");
    if (request.generationParameters.temperature !== 0 || request.generationParameters.maxTokens !== 2000) throw new Error("Generation parameter mismatch");
  }
  if (manifest.baselineContractHash !== contract.contractHash || manifest.candidateContractHash !== digest(`cluster_merge:${contract.contractVersion}:${expectedSystem[1]}`) || manifest.inputContentSha256 !== digest(JSON.stringify(input)) || manifest.userMessageSha256 !== digest(baseline.messages[1].content)) throw new Error("Content/contract hash mismatch");
  if (manifest.authorization.sendAllowed !== false || manifest.authorization.requestsSent !== 0 || manifest.authorization.retries !== 0 || manifest.authorization.model !== null || manifest.authorization.modelProvider !== null || manifest.authorization.paidReplayRequiresNewAuthorization !== true || manifest.authorization.priorAuthorizationNotReused !== true || manifest.readyForReplay !== false || manifest.ready.productionReleaseEligible !== false || manifest.ready.modelBehaviorValidated !== false || manifest.ready.independentEffectEvidenceReady !== false || manifest.scope.productionDtoEquivalent !== false || manifest.scope.productionCandidateAdmissionMeasured !== false) throw new Error("Invalid offline-only authorization state");
  return { pairCount: 6, manifestSha256: anchor, requestsSent: 0 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , action, path, expectedSha, ...extra] = process.argv;
  if (!path || extra.length || (action !== "--out" && action !== "--verify") || (action === "--out" && expectedSha)) {
    throw new Error("Usage: tsx scripts/prepare-cluster-relation-source-replay.ts --out NEW_DIR | --verify DIR [EXPECTED_MANIFEST_SHA256]; no send mode");
  }
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  console.log(JSON.stringify(action === "--out" ? prepareSourcePacket(repo, resolve(path)) : verifySourcePacket(repo, resolve(path), expectedSha)));
}
