/** Explicitly authorized two-arm source-dev replay; direct transport has no retries/fallback. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { digest } from "./prepare-cluster-relation-source-replay";
import { FROZEN_PACKET, FROZEN_SHA, loadScoringContext, parseStrictResponse, scoreDecisions, type ScoringContext } from "./score-cluster-relation-source-replay";

const shaSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const authorizationSchema = z.object({ schemaVersion: z.literal(1), taskRunId: z.literal("2026-10-14-cluster-relation-real-replay"),
  userGrant: z.literal("真实回放吧，可以使用本地Docker库里api配置数据"), createdAt: z.string().datetime(), expiresAt: z.string().datetime(),
  manifestSha256: z.literal(FROZEN_SHA), dockerContext: z.literal("desktop-linux"), container: z.literal("infinitum"),
  databasePath: z.literal("/app/data/dev.db"), modelConfigId: z.literal("cmqv0x84p0004qn01bnsbii66"),
  promptConfigId: z.literal("cmqq311w50006o101uaje7asd"), providerBaseUrl: z.literal("https://api.minimaxi.com/v1"), model: z.literal("MiniMax-M3"),
  maxRequests: z.literal(2), maxRetries: z.literal(0), temperature: z.literal(0), maxTokens: z.literal(2000),
  timeoutMs: z.literal(180000), senderSha256: shaSchema, scorerSha256: shaSchema,
}).strict();
export type Authorization = z.infer<typeof authorizationSchema>;
export type Connection = { id: string; baseUrl: string; modelName: string; apiKey: string; customHeaders: Record<string, string> };
export type Transport = (url: string, init: RequestInit) => Promise<Pick<Response, "status" | "text">>;
const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
const loadJson = (p: string): unknown => JSON.parse(readFileSync(p, "utf8"));
const writeNew = (p: string, v: unknown) => writeFileSync(p, json(v), { flag: "wx" });
const senderPath = "scripts/replay-cluster-relation-source.ts";
const scorerPath = "scripts/score-cluster-relation-source-replay.ts";

export function verifyAuthorization(repo: string, root: string, expectedSha: string, forSend = false) {
  const file = readFileSync(resolve(root, "authorization.json"));
  if (digest(file) !== expectedSha) throw new Error("Authorization trust anchor mismatch");
  const auth = authorizationSchema.parse(JSON.parse(file.toString()));
  if (digest(readFileSync(resolve(repo, senderPath))) !== auth.senderSha256 || digest(readFileSync(resolve(repo, scorerPath))) !== auth.scorerSha256) throw new Error("Sender/scorer code drift");
  if (Date.parse(auth.expiresAt) <= Date.parse(auth.createdAt)) throw new Error("Invalid authorization time window");
  if (forSend && (Date.now() < Date.parse(auth.createdAt) || Date.now() >= Date.parse(auth.expiresAt))) throw new Error("Authorization expired/not yet valid");
  const context = loadScoringContext(repo, resolve(repo, FROZEN_PACKET), auth.manifestSha256);
  return { auth, context };
}

/** stdout stays in this process; no secret-bearing command output goes to the terminal. */
export function readDockerConnection(auth: Authorization): Connection {
  const run = (args: string[]) => {
    try { return execFileSync("docker", ["--context", auth.dockerContext, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1024 * 1024 }); }
    catch { throw new Error("Local Docker read failed (details suppressed to avoid credential exposure)"); }
  };
  if (!run(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}", auth.dockerContext]).trim().startsWith("unix://")) throw new Error("Nonlocal Docker endpoint forbidden");
  const query = (sql: string): unknown => JSON.parse(run(["exec", auth.container, "sqlite3", "-readonly", "-json", auth.databasePath, sql]));
  const prompt = z.array(z.object({ id: z.string(), modelApiConfigId: z.string().nullable() })).parse(query("SELECT id,modelApiConfigId FROM prompt_configs WHERE type='cluster_merge' AND isEnabled=1 AND isDefault=1 ORDER BY createdAt ASC;"));
  if (prompt.length !== 1 || prompt[0].id !== auth.promptConfigId || (prompt[0].modelApiConfigId !== null && prompt[0].modelApiConfigId !== auth.modelConfigId)) throw new Error("Effective cluster_merge model selection drift");
  const selector = prompt[0].modelApiConfigId ? `id='${auth.modelConfigId}' AND isEnabled=1 AND type='chat'` : "isEnabled=1 AND isDefault=1 AND type='chat'";
  const models = z.array(z.object({ id: z.string(), baseUrl: z.string(), modelName: z.string(), apiKey: z.string(), customHeaders: z.string() })).parse(query(`SELECT id,baseUrl,modelName,apiKey,customHeaders FROM model_api_configs WHERE ${selector} ORDER BY createdAt ASC;`));
  if (models.length !== 1) throw new Error("Ambiguous enabled effective model");
  const m = models[0]; const customHeaders = z.record(z.string(), z.string()).parse(JSON.parse(m.customHeaders || "{}"));
  return { ...m, customHeaders };
}

const receiptSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal("model_receipt"), arm: z.enum(["baseline", "candidate"]),
  authorizationSha256: shaSchema, manifestSha256: shaSchema, requestSha256: shaSchema, wireBodySha256: shaSchema,
  startedAt: z.string().datetime(), finishedAt: z.string().datetime(), transportMode: z.enum(["direct_http", "injected_test_transport"]),
  transportStatus: z.enum(["received", "network_error", "secret_echo_blocked"]),
  httpStatus: z.number().int().nullable(), responseBody: z.string().nullable(), responseBodySha256: shaSchema.nullable(),
}).strict();
export type ModelReceipt = z.infer<typeof receiptSchema>;
const packetRequest = z.object({ messages: z.array(z.object({ role: z.enum(["system", "user"]), content: z.string() }).strict()),
  generationParameters: z.object({ temperature: z.literal(0), maxTokens: z.literal(2000) }).strict() }).strict();
export function wireBody(repo: string, auth: Authorization, arm: ModelReceipt["arm"]) {
  const r = packetRequest.parse(loadJson(resolve(repo, FROZEN_PACKET, `${arm}.request.json`)));
  return JSON.stringify({ model: auth.model, messages: r.messages, temperature: r.generationParameters.temperature, max_tokens: r.generationParameters.maxTokens, stream: false });
}
const tokens = z.number().int().nonnegative().nullable();
const providerResponse = z.object({ model: z.string().min(1), choices: z.array(z.object({
  finish_reason: z.string(), message: z.object({ content: z.string() }),
})).length(1), usage: z.object({ prompt_tokens: tokens.optional(), completion_tokens: tokens.optional(), total_tokens: tokens.optional() }).optional() });

export function scoreModelReceipt(repo: string, context: ScoringContext, auth: Authorization, authSha: string, arm: ModelReceipt["arm"], raw: unknown) {
  let reportedModel: string | null = null;
  let usage: z.infer<typeof providerResponse>["usage"] | null = null;
  try {
    const r = receiptSchema.parse(raw);
    if (r.arm !== arm || r.authorizationSha256 !== authSha || r.manifestSha256 !== context.manifestSha256 || r.requestSha256 !== context.requestHashes[arm] || r.wireBodySha256 !== digest(wireBody(repo, auth, arm))) throw new Error("Model receipt binding mismatch");
    if (Date.parse(r.finishedAt) < Date.parse(r.startedAt) || Date.parse(r.startedAt) < Date.parse(auth.createdAt) || Date.parse(r.startedAt) >= Date.parse(auth.expiresAt)) throw new Error("Invalid receipt time window");
    if (r.transportStatus !== "received" || r.httpStatus !== 200 || r.responseBody === null || r.responseBodySha256 !== digest(r.responseBody)) throw new Error("No valid successful provider response");
    const responseJson = JSON.parse(r.responseBody);
    const modelResult = z.string().min(1).safeParse(responseJson.model); reportedModel = modelResult.success ? modelResult.data : null;
    const usageResult = z.object({ prompt_tokens: tokens.optional(), completion_tokens: tokens.optional(), total_tokens: tokens.optional() }).safeParse(responseJson.usage);
    usage = usageResult.success ? usageResult.data : null;
    const response = providerResponse.parse(responseJson);
    if (response.choices[0].finish_reason !== "stop") return { status: "protocol_failed" as const, failure: "Incomplete/non-stop completion", metrics: null, byProvenance: null, reportedModel: response.model, usage };
    const decisions = parseStrictResponse(response.choices[0].message.content, context.pairs);
    const byProvenance = Object.fromEntries([...new Set(context.pairs.map((p) => p.labelProvenance))].map((provenance) => {
      const indexes = context.pairs.map((p, i) => p.labelProvenance === provenance ? i : -1).filter((i) => i >= 0);
      return [provenance, scoreDecisions(indexes.map((i) => context.pairs[i]), indexes.map((i) => decisions[i]))];
    }));
    return { status: "valid" as const, metrics: scoreDecisions(context.pairs, decisions), byProvenance, reportedModel: response.model, usage, failure: null };
  } catch { return { status: "protocol_failed" as const, metrics: null, byProvenance: null, reportedModel, usage, failure: "Strict receipt/output validation failed; not a negative decision" }; }
}
export function buildReport(repo: string, root: string, auth: Authorization, context: ScoringContext, authSha: string) {
  const get = (arm: ModelReceipt["arm"]) => existsSync(resolve(root, `${arm}.model-receipt.json`)) ? scoreModelReceipt(repo, context, auth, authSha, arm, loadJson(resolve(root, `${arm}.model-receipt.json`))) :
    { status: "not_sent" as const, metrics: null, byProvenance: null, reportedModel: null, usage: null, failure: "No model receipt; never infer a negative decision" };
  const baseline = get("baseline"), candidate = get("candidate");
  const comparable = baseline.metrics !== null && candidate.metrics !== null && baseline.reportedModel === candidate.reportedModel;
  const paired = comparable ? {
    relationAccuracyDelta: candidate.metrics!.relationAccuracy! - baseline.metrics!.relationAccuracy!,
    falseMergeDelta: candidate.metrics!.falseMerge - baseline.metrics!.falseMerge, missedSameDelta: candidate.metrics!.missedSame - baseline.metrics!.missedSame,
    changes: context.pairs.flatMap((p, i) => baseline.metrics!.cases[i].predicted === candidate.metrics!.cases[i].predicted ? [] : [{
      caseId: p.caseId, pairId: p.pairId, gold: p.gold, baseline: baseline.metrics!.cases[i].predicted, candidate: candidate.metrics!.cases[i].predicted,
    }]),
  } : null;
  const attempts = ["baseline", "candidate"].filter((a) => existsSync(resolve(root, `${a}.dispatch-started.json`))).length;
  const receipts = ["baseline", "candidate"].flatMap((a) => existsSync(resolve(root, `${a}.model-receipt.json`)) ? [receiptSchema.parse(loadJson(resolve(root, `${a}.model-receipt.json`)))] : []);
  const simulated = receipts.some((r) => r.transportMode === "injected_test_transport");
  const providerResponsesReceived = receipts.filter((r) => r.transportStatus === "received").length;
  return { schemaVersion: 1, kind: simulated ? "test_transport_diagnostic" : "real_source_dev_diagnostic", status: paired ? "scored" : "incomplete_or_protocol_failed", authorizationSha256: authSha,
    sourceManifestSha256: context.manifestSha256, requestedModel: auth.model, providerBaseUrl: auth.providerBaseUrl,
    attempts, providerResponsesReceived, retries: 0, maximumPossibleBillableCalls: simulated ? 0 : attempts, baseline, candidate, paired,
    interpretation: { simulated, vendorCryptographicAttestation: false, modelOutputObserved: !simulated && providerResponsesReceived > 0,
      independentBlindFollowUpPositives: 0, productionDtoEquivalent: false, holdoutMeasured: false, qualityPassed: false, releaseEligible: false,
      labelComparisonsOnly: true, pairedComparisonRequiresBothCompleteAndSameReportedModel: true, protocolFailureNotNegativeDecision: true,
      providerCostAmount: null, providerCostCurrency: null, costNotEstimatedFromUnverifiedPricing: true },
  };
}

/** One-time output directory + authorization claim: a crash consumes the budget; no resumption/retry. */
export async function sendReplay(repo: string, root: string, authSha: string, getConnection = readDockerConnection, transport: Transport = fetch) {
  const { auth, context } = verifyAuthorization(repo, root, authSha, true);
  if (existsSync(resolve(root, "authorization.used.json"))) throw new Error("Authorization already consumed; no retry/resume/new-output reuse");
  const config = getConnection(auth);
  if (config.id !== auth.modelConfigId || config.baseUrl !== auth.providerBaseUrl || config.modelName !== auth.model || !config.apiKey || Object.keys(config.customHeaders).length !== 0) throw new Error("Docker connection drift/missing credential/unreviewed custom headers");
  writeNew(resolve(root, "authorization.used.json"), { authorizationSha256: authSha, claimedAt: new Date().toISOString(), maxRequests: 2, maxRetries: 0 });
  for (const arm of ["baseline", "candidate"] as const) {
    const startedAt = new Date().toISOString();
    if (Date.parse(startedAt) >= Date.parse(auth.expiresAt)) break;
    const body = wireBody(repo, auth, arm);
    writeNew(resolve(root, `${arm}.dispatch-started.json`), { arm, authorizationSha256: authSha, manifestSha256: context.manifestSha256,
      requestSha256: context.requestHashes[arm], wireBodySha256: digest(body), startedAt });
    const receipt: ModelReceipt = { schemaVersion: 1, kind: "model_receipt", arm, authorizationSha256: authSha,
      manifestSha256: context.manifestSha256, requestSha256: context.requestHashes[arm], wireBodySha256: digest(body), startedAt,
      finishedAt: startedAt, transportMode: transport === fetch ? "direct_http" : "injected_test_transport",
      transportStatus: "network_error", httpStatus: null, responseBody: null, responseBodySha256: null };
    try {
      const response = await transport(`${auth.providerBaseUrl}/chat/completions`, { method: "POST", redirect: "error",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` }, body, signal: AbortSignal.timeout(auth.timeoutMs) });
      receipt.httpStatus = response.status; const responseBody = await response.text();
      if (responseBody.includes(config.apiKey)) receipt.transportStatus = "secret_echo_blocked";
      else { receipt.transportStatus = "received"; receipt.responseBody = responseBody; receipt.responseBodySha256 = digest(responseBody); }
    } catch { /* Never log exception objects, request headers, credentials, or an implicit retry. */ }
    receipt.finishedAt = new Date().toISOString(); writeNew(resolve(root, `${arm}.model-receipt.json`), receipt);
    if (receipt.transportStatus !== "received" || receipt.httpStatus !== 200) break;
  }
  const report = buildReport(repo, root, auth, context, authSha); writeNew(resolve(root, "real.report.json"), report);
  const names = ["authorization.json", "authorization.used.json", "real.report.json", ...["baseline", "candidate"].flatMap((a) => [`${a}.dispatch-started.json`, `${a}.model-receipt.json`]).filter((name) => existsSync(resolve(root, name)))];
  const manifest = { schemaVersion: 1, authorizationSha256: authSha, fileHashes: Object.fromEntries(names.map((name) => [name, digest(readFileSync(resolve(root, name)))])) };
  writeNew(resolve(root, "execution-manifest.json"), manifest);
  const executionSha256 = digest(readFileSync(resolve(root, "execution-manifest.json")));
  writeFileSync(resolve(root, "execution-manifest.sha256"), executionSha256 + "\n", { flag: "wx" });
  return { status: report.status, attempts: report.attempts, retries: 0, executionSha256, qualityPassed: false };
}

export function verifyReplay(repo: string, root: string, expectedExecutionSha?: string) {
  const anchor = readFileSync(resolve(root, "execution-manifest.sha256"), "utf8").trim();
  if (expectedExecutionSha && anchor !== expectedExecutionSha) throw new Error("External execution trust anchor mismatch");
  if (!shaSchema.safeParse(anchor).success || digest(readFileSync(resolve(root, "execution-manifest.json"))) !== anchor) throw new Error("Execution manifest hash mismatch");
  const manifest = z.object({ schemaVersion: z.literal(1), authorizationSha256: shaSchema, fileHashes: z.record(z.string(), shaSchema) }).strict().parse(loadJson(resolve(root, "execution-manifest.json")));
  const { auth, context } = verifyAuthorization(repo, root, manifest.authorizationSha256);
  const names = ["authorization.json", "authorization.used.json", "real.report.json", ...["baseline", "candidate"].flatMap((a) => [`${a}.dispatch-started.json`, `${a}.model-receipt.json`]).filter((name) => existsSync(resolve(root, name)))];
  if (JSON.stringify(Object.keys(manifest.fileHashes).sort()) !== JSON.stringify(names.sort())) throw new Error("Execution file coverage mismatch");
  for (const name of names) if (digest(readFileSync(resolve(root, name))) !== manifest.fileHashes[name]) throw new Error("Execution file drift");
  const claim = z.object({ authorizationSha256: shaSchema, claimedAt: z.string().datetime(), maxRequests: z.literal(2), maxRetries: z.literal(0) }).strict().parse(loadJson(resolve(root, "authorization.used.json")));
  if (claim.authorizationSha256 !== manifest.authorizationSha256) throw new Error("Consumed authorization mismatch");
  const report = buildReport(repo, root, auth, context, manifest.authorizationSha256);
  if (JSON.stringify(report) !== JSON.stringify(loadJson(resolve(root, "real.report.json")))) throw new Error("Real report reconstruction mismatch");
  for (const arm of ["baseline", "candidate"] as const) {
    const path = resolve(root, `${arm}.model-receipt.json`); if (!existsSync(path)) continue;
    const receipt = receiptSchema.parse(loadJson(path)); const event = loadJson(resolve(root, `${arm}.dispatch-started.json`));
    if (JSON.stringify(event) !== JSON.stringify({ arm, authorizationSha256: manifest.authorizationSha256, manifestSha256: context.manifestSha256,
      requestSha256: context.requestHashes[arm], wireBodySha256: digest(wireBody(repo, auth, arm)), startedAt: receipt.startedAt })) throw new Error("Dispatch/receipt binding mismatch");
  }
  return { status: report.status, attempts: report.attempts, retries: 0, executionSha256: anchor, qualityPassed: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , action, root, sha, ...extra] = process.argv; const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (!root || extra.length || (action !== "--verify" && action !== "--send") || (action === "--send" && !sha)) throw new Error("Usage: --send AUTH_DIR TRUSTED_AUTH_SHA | --verify RUN_DIR [TRUSTED_EXECUTION_SHA]; send consumes authorization once");
  const main = async () => {
    const result = action === "--send" ? await sendReplay(repo, resolve(root), sha!) : verifyReplay(repo, resolve(root), sha);
    console.log(JSON.stringify(result)); if (result.status !== "scored") process.exitCode = 2;
  };
  main().catch(() => { console.error("Replay stopped; inspect safe local receipts. No retry was attempted."); process.exitCode = 1; });
}
