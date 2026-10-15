/** V2 transport-only replay: independent authorization, immutable wires, 8192 cap, reasoning_split. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { digest } from "./prepare-cluster-relation-source-replay";
import { authorizationSchema as v1Schema, type Connection, type Transport } from "./replay-cluster-relation-source";
import { FROZEN_PACKET, FROZEN_SHA, loadScoringContext, parseStrictResponse, scoreDecisions, type ScoringContext } from "./score-cluster-relation-source-replay";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const arms = ["baseline", "candidate"] as const;
type Arm = typeof arms[number];
const hashes = z.object({ baseline: sha, candidate: sha }).strict();
export const authorizationSchema = v1Schema.extend({ schemaVersion: z.literal(2),
  taskRunId: z.literal("2026-10-14-cluster-relation-real-replay-v2"), userGrant: z.literal("可以"),
  grantScope: z.literal("two arms once each; zero retries; symmetric 8192 token cap; separate reasoning output; same model/input/prompts"),
  maxTokens: z.literal(8192), reasoningSplit: z.literal(true),
  priorExecutionManifestSha256: z.literal("739685c4fad3292fe951bfa04140acd7d6afa018935765a835c86f7146e79021"),
  v1SenderSha256: sha, inputPreparerSha256: sha, wireFileHashes: hashes, wireBodyHashes: hashes,
}).strict();
export type Authorization = z.infer<typeof authorizationSchema>;
const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
const readJson = (p: string): unknown => JSON.parse(readFileSync(p, "utf8"));
const writeNew = (p: string, v: unknown) => writeFileSync(p, json(v), { flag: "wx" });
const sourcePaths = { senderSha256: "scripts/replay-cluster-relation-source-v2.ts", v1SenderSha256: "scripts/replay-cluster-relation-source.ts",
  scorerSha256: "scripts/score-cluster-relation-source-replay.ts", inputPreparerSha256: "scripts/prepare-cluster-relation-source-replay.ts" } as const;
export function expectedWire(repo: string, arm: Arm) {
  const r = z.object({ generationParameters: z.object({ temperature: z.literal(0), maxTokens: z.literal(2000) }).strict(),
    messages: z.array(z.object({ role: z.enum(["system", "user"]), content: z.string() }).strict()).length(2),
  }).strict().parse(readJson(resolve(repo, FROZEN_PACKET, `${arm}.request.json`)));
  return { model: "MiniMax-M3", messages: r.messages, temperature: 0, max_tokens: 8192, stream: false, reasoning_split: true };
}
export function verifyAuthorization(repo: string, root: string, anchor: string, forSend = false) {
  const bytes = readFileSync(resolve(root, "authorization.json"));
  if (digest(bytes) !== anchor) throw new Error("Authorization trust anchor mismatch");
  const auth = authorizationSchema.parse(JSON.parse(bytes.toString()));
  for (const [field, path] of Object.entries(sourcePaths)) if (digest(readFileSync(resolve(repo, path))) !== auth[field as keyof typeof sourcePaths]) throw new Error("Code reference drift");
  if (Date.parse(auth.expiresAt) <= Date.parse(auth.createdAt)) throw new Error("Invalid authorization window");
  if (forSend && (Date.now() < Date.parse(auth.createdAt) || Date.now() >= Date.parse(auth.expiresAt))) throw new Error("Authorization expired/not yet valid");
  if (digest(readFileSync(resolve(repo, "docs/eval/reviews/cluster-relation-real-replay-2026-10-14/execution-manifest.json"))) !== auth.priorExecutionManifestSha256) throw new Error("Prior execution anchor drift");
  const context = loadScoringContext(repo, resolve(repo, FROZEN_PACKET), FROZEN_SHA);
  for (const arm of arms) {
    const file = readFileSync(resolve(root, `${arm}.wire.json`)); const wire = JSON.parse(file.toString());
    if (digest(file) !== auth.wireFileHashes[arm] || digest(JSON.stringify(wire)) !== auth.wireBodyHashes[arm] || JSON.stringify(wire) !== JSON.stringify(expectedWire(repo, arm))) throw new Error("Frozen wire drift/original message mismatch");
  }
  return { auth, context };
}

/** All output is captured in memory; credential columns are never printed or serialized. */
export function readDockerConnection(auth: Authorization): Connection {
  const run = (args: string[]) => {
    try { return execFileSync("docker", ["--context", auth.dockerContext, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1024 * 1024 }); }
    catch { throw new Error("Docker read failed; details suppressed"); }
  };
  if (!run(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}", auth.dockerContext]).trim().startsWith("unix://")) throw new Error("Nonlocal Docker forbidden");
  const query = (sql: string): unknown => JSON.parse(run(["exec", auth.container, "sqlite3", "-readonly", "-json", auth.databasePath, sql]));
  const prompts = z.array(z.object({ id: z.string(), modelApiConfigId: z.string().nullable() })).parse(query("SELECT id,modelApiConfigId FROM prompt_configs WHERE type='cluster_merge' AND isEnabled=1 AND isDefault=1 ORDER BY createdAt ASC;"));
  if (prompts.length !== 1 || prompts[0].id !== auth.promptConfigId || (prompts[0].modelApiConfigId !== null && prompts[0].modelApiConfigId !== auth.modelConfigId)) throw new Error("Effective prompt/model binding drift");
  const where = prompts[0].modelApiConfigId ? `id='${auth.modelConfigId}' AND isEnabled=1 AND type='chat'` : "isEnabled=1 AND isDefault=1 AND type='chat'";
  const models = z.array(z.object({ id: z.string(), modelName: z.string(), baseUrl: z.string(), apiKey: z.string(), customHeaders: z.string() })).parse(query(`SELECT id,modelName,baseUrl,apiKey,customHeaders FROM model_api_configs WHERE ${where} ORDER BY createdAt ASC;`));
  if (models.length !== 1) throw new Error("Ambiguous model configuration");
  return { ...models[0], customHeaders: z.record(z.string(), z.string()).parse(JSON.parse(models[0].customHeaders || "{}")) };
}
const receiptSchema = z.object({ schemaVersion: z.literal(2), kind: z.literal("model_receipt"), arm: z.enum(arms),
  authorizationSha256: sha, sourceManifestSha256: z.literal(FROZEN_SHA), parentRequestSha256: sha, wireBodySha256: sha,
  startedAt: z.string().datetime(), finishedAt: z.string().datetime(), transportMode: z.enum(["direct_http", "injected_test_transport"]),
  transportStatus: z.enum(["received", "network_error", "secret_echo_blocked"]), httpStatus: z.number().int().nullable(),
  responseBody: z.string().nullable(), responseBodySha256: sha.nullable() }).strict();
type Receipt = z.infer<typeof receiptSchema>;
const usageSchema = z.object({ prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative(), total_tokens: z.number().int().nonnegative() });
const providerSchema = z.object({ model: z.string().min(1), choices: z.array(z.object({ finish_reason: z.string(), message: z.object({ content: z.string() }) })).length(1) });
export function scoreReceipt(context: ScoringContext, auth: Authorization, anchor: string, arm: Arm, value: unknown) {
  let usage: z.infer<typeof usageSchema> | null = null; let reportedModel: string | null = null;
  try {
    const r = receiptSchema.parse(value);
    if (r.arm !== arm || r.authorizationSha256 !== anchor || r.parentRequestSha256 !== context.requestHashes[arm] || r.wireBodySha256 !== auth.wireBodyHashes[arm]) throw new Error("Receipt binding mismatch");
    if (Date.parse(r.startedAt) < Date.parse(auth.createdAt) || Date.parse(r.startedAt) >= Date.parse(auth.expiresAt) || Date.parse(r.finishedAt) < Date.parse(r.startedAt)) throw new Error("Receipt time mismatch");
    if (r.transportStatus !== "received" || r.httpStatus !== 200 || r.responseBody === null || digest(r.responseBody) !== r.responseBodySha256) throw new Error("No valid complete HTTP response");
    const b = JSON.parse(r.responseBody); const model = z.string().min(1).safeParse(b.model); reportedModel = model.success ? model.data : null;
    const u = usageSchema.safeParse(b.usage); usage = u.success ? u.data : null;
    const response = providerSchema.parse(b);
    if (response.choices[0].finish_reason !== "stop") throw new Error("Incomplete completion");
    // Never extract decisions from reasoning_content, strip think/fences, or repair a partial JSON.
    const decisions = parseStrictResponse(response.choices[0].message.content, context.pairs);
    const byProvenance = Object.fromEntries([...new Set(context.pairs.map((p) => p.labelProvenance))].map((provenance) => {
      const indexes = context.pairs.map((p, i) => p.labelProvenance === provenance ? i : -1).filter((i) => i >= 0);
      return [provenance, scoreDecisions(indexes.map((i) => context.pairs[i]), indexes.map((i) => decisions[i]))];
    }));
    return { status: "valid" as const, metrics: scoreDecisions(context.pairs, decisions), byProvenance, reportedModel, usage, failure: null };
  } catch { return { status: "protocol_failed" as const, metrics: null, byProvenance: null, reportedModel, usage, failure: "Strict receipt/output validation failed; never count as negative" }; }
}
export function buildReport(root: string, context: ScoringContext, auth: Authorization, anchor: string) {
  const receipts = arms.flatMap((arm) => existsSync(resolve(root, `${arm}.model-receipt.json`)) ? [receiptSchema.parse(readJson(resolve(root, `${arm}.model-receipt.json`)))] : []);
  const get = (arm: Arm) => { const p = resolve(root, `${arm}.model-receipt.json`); return existsSync(p) ? scoreReceipt(context, auth, anchor, arm, readJson(p)) :
    { status: "not_sent" as const, metrics: null, byProvenance: null, reportedModel: null, usage: null, failure: "No receipt; never a negative decision" }; };
  const baseline = get("baseline"), candidate = get("candidate");
  const paired = baseline.metrics && candidate.metrics && baseline.reportedModel === candidate.reportedModel ? {
    relationAccuracyDelta: candidate.metrics.relationAccuracy! - baseline.metrics.relationAccuracy!,
    falseMergeDelta: candidate.metrics.falseMerge - baseline.metrics.falseMerge, missedSameDelta: candidate.metrics.missedSame - baseline.metrics.missedSame,
    changes: context.pairs.flatMap((p, i) => baseline.metrics!.cases[i].predicted === candidate.metrics!.cases[i].predicted ? [] : [{
      caseId: p.caseId, pairId: p.pairId, gold: p.gold, baseline: baseline.metrics!.cases[i].predicted, candidate: candidate.metrics!.cases[i].predicted }]),
  } : null;
  const simulated = receipts.some((r) => r.transportMode === "injected_test_transport");
  return { schemaVersion: 2, kind: simulated ? "test_transport_diagnostic" : "real_source_dev_diagnostic", status: paired ? "scored" : "incomplete_or_protocol_failed",
    authorizationSha256: anchor, sourceManifestSha256: FROZEN_SHA, requestedModel: auth.model, providerBaseUrl: auth.providerBaseUrl,
    attempts: arms.filter((a) => existsSync(resolve(root, `${a}.dispatch-started.json`))).length, retries: 0,
    providerResponsesReceived: receipts.filter((r) => r.transportStatus === "received").length,
    baseline, candidate, paired, interpretation: { simulated, modelOutputObserved: !simulated && receipts.some((r) => r.transportStatus === "received"),
      transportVersion: "source-dev-wire-v2", symmetricOverrides: { max_tokens: 8192, reasoning_split: true },
      thinkingDisabled: false, jsonModeAdded: false, v1MetricsRetrofitted: false, vendorCryptographicAttestation: false,
      independentBlindFollowUpPositives: 0, productionDtoEquivalent: false, holdoutMeasured: false, qualityPassed: false, releaseEligible: false,
      devLabelComparisonOnly: true, providerCostAmount: null, providerPricingNotAssumed: true } };
}
const executionNames = (root: string) => ["authorization.json", "authorization.used.json", "baseline.wire.json", "candidate.wire.json", "real.report.json",
  ...arms.flatMap((a) => [`${a}.dispatch-started.json`, `${a}.model-receipt.json`]).filter((n) => existsSync(resolve(root, n)))];
export async function sendReplay(repo: string, root: string, anchor: string, getConnection = readDockerConnection, transport: Transport = fetch) {
  const { auth, context } = verifyAuthorization(repo, root, anchor, true);
  if (existsSync(resolve(root, "authorization.used.json"))) throw new Error("Authorization consumed; no resume/retry");
  const bodies = Object.fromEntries(arms.map((arm) => {
    const body = JSON.stringify(readJson(resolve(root, `${arm}.wire.json`)));
    if (digest(body) !== auth.wireBodyHashes[arm]) throw new Error("Wire changed after verification");
    return [arm, body];
  }));
  const c = getConnection(auth);
  if (c.id !== auth.modelConfigId || c.baseUrl !== auth.providerBaseUrl || c.modelName !== auth.model || !c.apiKey || Object.keys(c.customHeaders).length) throw new Error("Connection drift/empty credential/unreviewed headers");
  writeNew(resolve(root, "authorization.used.json"), { authorizationSha256: anchor, claimedAt: new Date().toISOString(), maxRequests: 2, maxRetries: 0 });
  for (const arm of arms) {
    const startedAt = new Date().toISOString(); if (Date.parse(startedAt) >= Date.parse(auth.expiresAt)) break;
    const body = bodies[arm];
    const dispatch = { arm, authorizationSha256: anchor, sourceManifestSha256: FROZEN_SHA, parentRequestSha256: context.requestHashes[arm], wireBodySha256: digest(body), startedAt } as const;
    writeNew(resolve(root, `${arm}.dispatch-started.json`), dispatch);
    const r: Receipt = { schemaVersion: 2, kind: "model_receipt", ...dispatch, finishedAt: startedAt,
      transportMode: transport === fetch ? "direct_http" : "injected_test_transport", transportStatus: "network_error", httpStatus: null, responseBody: null, responseBodySha256: null };
    try {
      const result = await transport(`${c.baseUrl}/chat/completions`, { method: "POST", redirect: "error", headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.apiKey}` }, body, signal: AbortSignal.timeout(auth.timeoutMs) });
      r.httpStatus = result.status; const response = await result.text();
      if (response.includes(c.apiKey)) r.transportStatus = "secret_echo_blocked";
      else { r.transportStatus = "received"; r.responseBody = response; r.responseBodySha256 = digest(response); }
    } catch { /* No logging of exceptions/headers/secrets; no retries or fallback. */ }
    r.finishedAt = new Date().toISOString(); writeNew(resolve(root, `${arm}.model-receipt.json`), r);
    if (r.transportStatus !== "received" || r.httpStatus !== 200) break;
  }
  const report = buildReport(root, context, auth, anchor); writeNew(resolve(root, "real.report.json"), report);
  writeNew(resolve(root, "execution-manifest.json"), { schemaVersion: 2, authorizationSha256: anchor,
    fileHashes: Object.fromEntries(executionNames(root).map((n) => [n, digest(readFileSync(resolve(root, n)))])) });
  const executionSha256 = digest(readFileSync(resolve(root, "execution-manifest.json")));
  writeFileSync(resolve(root, "execution-manifest.sha256"), executionSha256 + "\n", { flag: "wx" });
  return { status: report.status, attempts: report.attempts, retries: 0, executionSha256, qualityPassed: false };
}
export function verifyReplay(repo: string, root: string, expectedSha?: string) {
  const anchor = readFileSync(resolve(root, "execution-manifest.sha256"), "utf8").trim();
  if (!sha.safeParse(anchor).success || digest(readFileSync(resolve(root, "execution-manifest.json"))) !== anchor || (expectedSha && expectedSha !== anchor)) throw new Error("Execution anchor mismatch");
  const m = z.object({ schemaVersion: z.literal(2), authorizationSha256: sha, fileHashes: z.record(z.string(), sha) }).strict().parse(readJson(resolve(root, "execution-manifest.json")));
  const { auth, context } = verifyAuthorization(repo, root, m.authorizationSha256);
  const names = executionNames(root);
  if (JSON.stringify(Object.keys(m.fileHashes).sort()) !== JSON.stringify(names.sort())) throw new Error("Execution file coverage mismatch");
  for (const n of names) if (digest(readFileSync(resolve(root, n))) !== m.fileHashes[n]) throw new Error("Execution file drift");
  const claim = z.object({ authorizationSha256: sha, claimedAt: z.string().datetime(), maxRequests: z.literal(2), maxRetries: z.literal(0) }).strict().parse(readJson(resolve(root, "authorization.used.json")));
  if (claim.authorizationSha256 !== m.authorizationSha256) throw new Error("Consumed authorization mismatch");
  const report = buildReport(root, context, auth, m.authorizationSha256);
  if (JSON.stringify(report) !== JSON.stringify(readJson(resolve(root, "real.report.json")))) throw new Error("Report reconstruction mismatch");
  for (const arm of arms) {
    if (!existsSync(resolve(root, `${arm}.model-receipt.json`))) continue;
    const r = receiptSchema.parse(readJson(resolve(root, `${arm}.model-receipt.json`)));
    const d = readJson(resolve(root, `${arm}.dispatch-started.json`));
    if (JSON.stringify(d) !== JSON.stringify({ arm, authorizationSha256: m.authorizationSha256, sourceManifestSha256: FROZEN_SHA, parentRequestSha256: context.requestHashes[arm], wireBodySha256: auth.wireBodyHashes[arm], startedAt: r.startedAt })) throw new Error("Dispatch binding mismatch");
  }
  return { status: report.status, attempts: report.attempts, retries: 0, executionSha256: anchor, qualityPassed: false };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , action, root, anchor, ...extra] = process.argv; const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (!root || extra.length || !["--send", "--verify"].includes(action) || (action === "--send" && !anchor)) throw new Error("Usage: --send AUTH_DIR TRUSTED_AUTH_SHA | --verify RUN_DIR [TRUSTED_EXECUTION_SHA]");
  const main = async () => { const r = action === "--send" ? await sendReplay(repo, resolve(root), anchor!) : verifyReplay(repo, resolve(root), anchor); console.log(JSON.stringify(r)); if (r.status !== "scored") process.exitCode = 2; };
  main().catch(() => { console.error("V2 replay stopped; inspect safe local evidence; no retry."); process.exitCode = 1; });
}
