/** Offline read-only state admission. Executes selected existing functions, never the service entrypoint. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { z } from "zod";
import * as constants from "../src/config/constants";
import { CLUSTER_MERGE_BM25_CACHE_VERSION, CLUSTER_MERGE_BM25_SCORE_SCALE } from "../src/lib/clusters/bm25";
import { buildClusterMergeCandidateInputHash, buildClusterMergeCandidateSelection, buildClusterMergeEdgeKey, buildClusterMergeInput, checkClusterMergePairSafety, scoreClusterMergeCandidatePair,
  type ClusterMergeCandidate, type ClusterMergeCandidateEdge } from "../src/lib/clusters/helpers";
import { compactClusterMergeInputForModel, splitClusterMergeInputBatches } from "../src/lib/ai/protocols/cluster";
import { normalizeEntityName } from "../src/lib/entities/normalization";
import { buildBridge, buildSnapshotSql, candidateOf, inventoryProof, loadInventory, REFERENCE_PATHS, snapshotSchema, verifyBridge,
  type Inventory, type Snapshot } from "./prepare-cluster-relation-production-bridge";
import { digest } from "./prepare-cluster-relation-source-replay";

export const PREVIOUS_PACKET = "docs/eval/reviews/cluster-relation-production-bridge-2026-10-14/packet";
export const PREVIOUS_SHA = "8972f3375abc15df9a0e587377ff9c0e9bee15b7def09999e6a90382a739df45";
const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
const readJson = (p: string): unknown => JSON.parse(readFileSync(p, "utf8"));
const quote = (s: string) => "'" + s.replace(/'/g, "''") + "'";
const time = z.union([z.number().int(), z.string()]); const maybeTime = time.nullable();
const key = z.string();
const cacheSchema = z.object({ id: key, pairKey: key, leftClusterId: key, rightClusterId: key, leftInputHash: key, rightInputHash: key,
  score: z.number().int(), recallSource: key.nullable(), bm25Score: z.number().nullable(), vectorSimilarity: z.number().nullable(), attemptCount: z.number().int().nonnegative(), expiresAt: time, updatedAt: time }).strict();
export const stateSchema = z.object({
  entities: z.array(z.object({ normalized: key, name: key }).strict()), aliases: z.array(z.object({ aliasNormalized: key, name: key }).strict()),
  cache: z.array(cacheSchema),
  members: z.array(z.object({ id: key, clusterId: key, status: key, moderationStatus: key }).strict()),
  constraints: z.array(z.object({ id: key, kind: key, scope: key, pairKey: key, expiresAt: maybeTime, createdAt: time }).strict()),
  decisions: z.array(z.object({ id: key, kind: key, pairKey: key, inputHash: key, relation: z.enum(["uncertain", "follow_up", "synthesis", "unrelated"]), attemptCount: z.number().int().nonnegative(), expiresAt: maybeTime, appliedAt: maybeTime, createdAt: time }).strict()),
}).strict();
export type State = z.infer<typeof stateSchema>;
export type Capture = { snapshot: Snapshot; state: State; containerImageId: string };
export function fullInventory(repo: string): Inventory {
  const inventory = loadInventory(repo); const included = new Set(inventory.cases.map((c) => c.caseId)); const excluded = new Map<string, { id: string; url: string }>();
  for (const dir of ["cluster-relation-source-verified-2026-10-14", "cluster-relation-follow-up-2026-10-14"]) {
    const root = resolve(repo, "docs/eval/reviews", dir);
    const bank = readJson(resolve(root, "sources.json")) as { sources: Record<string, { url: string }> };
    const cases = readJson(resolve(root, "cases.json")) as { cases: { caseId: string; leftSourceId: string; rightSourceId: string }[] };
    for (const c of cases.cases.filter((c) => !included.has(c.caseId))) for (const id of [c.leftSourceId, c.rightSourceId]) excluded.set(id, { id, url: bank.sources[id].url });
  }
  return { cases: inventory.cases, reserved: [...excluded.values()] };
}
export function captureSql(inventory: Inventory, nowMs: number) {
  const base = buildSnapshotSql(inventory, nowMs);
  const marker = "\nSELECT json_object('schemaVersion'"; const at = base.indexOf(marker);
  if (at < 0 || base.indexOf(marker, at + 1) !== -1) throw new Error("Base SELECT shape changed");
  const ctes = base.slice(base.indexOf("WITH RECURSIVE"), at);
  const prefix = `${CLUSTER_MERGE_BM25_CACHE_VERSION}:`;
  // Global loader order/take BEFORE per-pool invalid checks, matching loadStoredCleanMergePairs.
  const state = `${ctes}, members AS (
 SELECT i.id,i.clusterId,i.status,i.moderationStatus FROM items i WHERE i.clusterId IN (SELECT id FROM pool) AND i.status='processed' AND i.moderationStatus IN ('allowed','restored')
), pairKeys AS (
 SELECT hex(a.id||char(0)||b.id) AS k FROM pool a JOIN pool b ON a.id<b.id
), cached AS (
 SELECT id,pairKey,leftClusterId,rightClusterId,leftInputHash,rightInputHash,score,recallSource,bm25Score,vectorSimilarity,attemptCount,expiresAt,updatedAt
 FROM cluster_merge_clean_pair_candidates WHERE expiresAt>${nowMs} AND pairKey LIKE ${quote(prefix + "%")}
 ORDER BY score DESC,updatedAt DESC,id ASC LIMIT ${constants.CLUSTER_MERGE_PRECOMPUTED_CLEAN_PAIR_LIMIT * 4}
), blockedConstraints AS (
 SELECT id,kind,scope,pairKey,expiresAt,createdAt FROM cluster_constraints
 WHERE kind='cannot_link' AND ((scope='cluster_cluster' AND hex(pairKey) IN (SELECT k FROM pairKeys)) OR
 (scope='item_item' AND EXISTS(SELECT 1 FROM members a JOIN members b ON a.id<b.id AND a.clusterId<>b.clusterId WHERE hex(pairKey)=hex(a.id||char(0)||b.id))))
), history AS (
 SELECT id,kind,pairKey,inputHash,relation,attemptCount,expiresAt,appliedAt,createdAt FROM cluster_decisions d
 WHERE kind='cluster_pair' AND relation IN ('uncertain','follow_up','synthesis','unrelated') AND hex(pairKey) IN (SELECT k FROM pairKeys)
 AND NOT (relation='uncertain' AND appliedAt IS NULL AND (leftClusterId IS NULL OR rightClusterId IS NULL OR NOT EXISTS(SELECT 1 FROM content_clusters c WHERE c.id=d.leftClusterId) OR NOT EXISTS(SELECT 1 FROM content_clusters c WHERE c.id=d.rightClusterId)))
)
SELECT json_object(
 'entities',json(COALESCE((SELECT json_group_array(json_object('normalized',normalized,'name',name)) FROM entities),'[]')),
 'aliases',json(COALESCE((SELECT json_group_array(json_object('aliasNormalized',a.aliasNormalized,'name',e.name)) FROM entity_aliases a JOIN entities e ON e.id=a.entityId),'[]')),
 'cache',json(COALESCE((SELECT json_group_array(json_object('id',id,'pairKey',pairKey,'leftClusterId',leftClusterId,'rightClusterId',rightClusterId,'leftInputHash',leftInputHash,'rightInputHash',rightInputHash,'score',score,'recallSource',recallSource,'bm25Score',bm25Score,'vectorSimilarity',vectorSimilarity,'attemptCount',attemptCount,'expiresAt',expiresAt,'updatedAt',updatedAt)) FROM cached),'[]')),
 'members',json(COALESCE((SELECT json_group_array(json_object('id',id,'clusterId',clusterId,'status',status,'moderationStatus',moderationStatus)) FROM members),'[]')),
 'constraints',json(COALESCE((SELECT json_group_array(json_object('id',id,'kind',kind,'scope',scope,'pairKey',pairKey,'expiresAt',expiresAt,'createdAt',createdAt)) FROM blockedConstraints),'[]')),
 'decisions',json(COALESCE((SELECT json_group_array(json_object('id',id,'kind',kind,'pairKey',pairKey,'inputHash',inputHash,'relation',relation,'attemptCount',attemptCount,'expiresAt',expiresAt,'appliedAt',appliedAt,'createdAt',createdAt)) FROM history),'[]')));
`;
  return "PRAGMA query_only=ON;\nBEGIN;\n" + base + state + "COMMIT;\n";
}
export function captureState(inventory: Inventory, nowMs = Date.now()): Capture {
  const docker = (args: string[]) => execFileSync("docker", ["--context", "desktop-linux", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
  if (!docker(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}", "desktop-linux"]).trim().startsWith("unix://")) throw new Error("Local Docker required");
  const containerImageId = docker(["inspect", "infinitum", "--format", "{{.Image}}"]).trim();
  const rows = docker(["exec", "infinitum", "sqlite3", "-readonly", "/app/data/dev.db", captureSql(inventory, nowMs)]).trim().split("\n");
  if (rows.length !== 2) throw new Error("Capture SELECT coverage mismatch");
  const snapshot = snapshotSchema.parse(JSON.parse(rows[0])); const state = stateSchema.parse(JSON.parse(rows[1]));
  const mentions = new Set(snapshot.clusters.filter((c) => snapshot.poolIds.includes(c.id)).flatMap((c) => [c.eventSubject, c.eventObject]).map((s) => normalizeEntityName(s ?? "")?.normalized).filter(Boolean));
  // Persist only resolver rows needed by this pool; unrelated canonical names never enter the artifact.
  state.entities = state.entities.filter((r) => mentions.has(r.normalized)); state.aliases = state.aliases.filter((r) => mentions.has(r.aliasNormalized));
  return { snapshot, state, containerImageId };
}
export function dateOf(value: string | number) {
  const text = typeof value === "string" && /^\d{4}-\d\d-\d\d \d\d:/.test(value) ? value.replace(" ", "T") + "Z" : value;
  const date = new Date(text); if (!Number.isFinite(date.getTime())) throw new Error("Invalid stored date"); return date;
}
type Row = Record<string, unknown>;
// Preserve SQLite storage-class ordering (mixed default TEXT and Prisma integer dates), including BINARY ids.
export function sqliteCompare(a: unknown, b: unknown): number {
  const scalar = (v: unknown) => v instanceof Date ? v.getTime() : v;
  const left = scalar(a), right = scalar(b);
  const rank = (v: unknown) => v === null ? 0 : typeof v === "number" ? 1 : typeof v === "string" ? 2 : (() => { throw new Error("Unsupported SQLite scalar"); })();
  const d = rank(left) - rank(right); if (d) return d;
  if (typeof left === "string" && typeof right === "string") return Buffer.compare(Buffer.from(left), Buffer.from(right));
  return left === right ? 0 : (left as number) < (right as number) ? -1 : 1;
}
export function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === "OR") { if (!Array.isArray(v)) throw new Error("Invalid OR"); return v.some((w) => matches(row, w)); }
    if (!(k in row)) throw new Error("Unsupported query column");
    if (v !== null && typeof v === "object" && !(v instanceof Date)) {
      const entries = Object.entries(v); if (entries.length !== 1) throw new Error("Unsupported filter"); const [op, arg] = entries[0];
      if (op === "in" && Array.isArray(arg)) return arg.some((value) => sqliteCompare(row[k], value) === 0);
      if (op === "gt") return row[k] !== null && sqliteCompare(row[k], arg) > 0;
      if (op === "startsWith" && typeof arg === "string" && typeof row[k] === "string") {
        const fold = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase()); return fold(row[k] as string).startsWith(fold(arg));
      }
      throw new Error("Unsupported query operator");
    }
    return sqliteCompare(row[k], v) === 0;
  });
}
function project(row: Row, select?: Row): Row {
  if (!select) return row;
  return Object.fromEntries(Object.entries(select).map(([k, v]) => {
    if (!(k in row)) throw new Error("Unsupported select column");
    if (v === true) return [k, row[k]];
    if (v && typeof v === "object" && "select" in v) return [k, project(row[k] as Row, (v as { select: Row }).select)];
    throw new Error("Unsupported select");
  }));
}
export function readonlyPrisma(state: State) {
  const table = (rows: Row[]) => {
    const findMany = async (args: { where: Row; orderBy?: Row[]; take?: number; select?: Row }) => {
      if (Object.keys(args).some((k) => !["where", "orderBy", "take", "select"].includes(k))) throw new Error("Unsupported query option");
      let found = rows.filter((r) => matches(r, args.where));
      if (args.orderBy) found = found.sort((a, b) => {
        for (const o of args.orderBy!) { if (Object.keys(o).length !== 1) throw new Error("Unsupported multi-column order entry"); const [k, dir] = Object.entries(o)[0]; if (!["asc", "desc"].includes(dir as string) || !(k in a) || !(k in b)) throw new Error("Unsupported orderBy"); const d = sqliteCompare(a[k], b[k]); if (d) return dir === "desc" ? -d : d; } return 0;
      });
      if (args.take !== undefined) found = found.slice(0, args.take);
      return found.map((r) => project(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, ["createdAt", "updatedAt", "expiresAt", "appliedAt"].includes(k) && v !== null ? dateOf(v as string | number) : v])), args.select));
    };
    return { findMany, findFirst: async (args: Parameters<typeof findMany>[0]) => (await findMany({ ...args, take: 1 }))[0] ?? null };
  };
  return { clusterConstraint: table(state.constraints), clusterDecision: table(state.decisions), item: table(state.members), clusterMergeCleanPairCandidate: table(state.cache), entity: table(state.entities),
    entityAlias: table(state.aliases.map((a) => ({ aliasNormalized: a.aliasNormalized, entity: { name: a.name } }))) };
}
const PROGRAM = {
  "src/lib/clusters/service.ts": ["isClusterMergeCandidateClean", "addPrecomputedAttribution", "addClusterMergeCandidate", "loadStoredCleanMergePairs", "mergePrecomputedCleanPairs", "buildClusterMergePairInputHash", "getClusterMergePairCandidates", "filterBlockedClusterMergeEdges", "canonicalizeClusterMergeEntityMentions"],
  "src/lib/clusters/constraints.ts": ["buildClusterConstraintPairKey", "findBlockingClusterPairConstraint"],
  "src/lib/clusters/decisions.ts": ["DECLINED_RETRY_DELAYS_MS", "MAX_DECLINED_ATTEMPTS", "REJECT_RELATIONS", "getClusterPairDecisionBlock"],
  "src/lib/entities/mention-resolution.ts": ["RESOLVER_CACHE_MAX", "canonicalCache", "mentionKey", "loadMentionResolver"],
};
export function productionAdapter(repo: string, state: State) {
  const chunks: string[] = []; const symbols = new Set<string>();
  for (const [path, wanted] of Object.entries(PROGRAM)) {
    const source = ts.createSourceFile(path, readFileSync(resolve(repo, path), "utf8"), ts.ScriptTarget.Latest, true); const found = new Set<string>();
    for (const node of source.statements) {
      const names = ts.isFunctionDeclaration(node) && node.name ? [node.name.text] : ts.isVariableStatement(node) ? node.declarationList.declarations.flatMap((d) => ts.isIdentifier(d.name) ? [d.name.text] : []) : [];
      if (names.some((name) => wanted.includes(name))) { if (names.some((name) => !wanted.includes(name))) throw new Error("Mixed statement forbidden"); chunks.push(node.getText(source).replace(/^export\s+/, "")); for (const name of names) { found.add(name); symbols.add(name); } }
    }
    if (wanted.some((name) => !found.has(name))) throw new Error("Production adapter symbol drift");
  }
  // No module imports, process/require/fetch/provider or DB connection in this context. Prisma facade has read methods only.
  const prisma = readonlyPrisma(state); const queryErrors: unknown[] = [];
  const watch = <A, T>(fn: (a: A) => Promise<T>) => async (a: A) => { try { return await fn(a); } catch (e) { queryErrors.push(e); throw e; } };
  for (const table of Object.values(prisma)) { table.findMany = watch(table.findMany); table.findFirst = watch(table.findFirst); }
  const context = vm.createContext({ ...constants, CLUSTER_MERGE_BM25_CACHE_VERSION, CLUSTER_MERGE_BM25_SCORE_SCALE, buildClusterMergeCandidateInputHash,
    buildClusterMergeEdgeKey, checkClusterMergePairSafety, scoreClusterMergeCandidatePair, normalizeEntityName, prisma, Map, Set, Date });
  vm.runInContext(ts.transpileModule(chunks.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, context, { timeout: 5000 });
  return { assertHealthy: () => { if (queryErrors.length) throw new Error("Snapshot query adaptation failed; resolver fallback cannot hide it"); }, call: <T>(name: string, ...args: unknown[]): T => { if (!symbols.has(name)) throw new Error("Non-whitelisted function"); context.__args = args; return vm.runInContext(`${name}(...__args)`, context, { timeout: 5000 }) as T; } };
}
type CacheSelection = { candidates: ClusterMergeCandidate[]; allowedPairs: ClusterMergeCandidateEdge[]; usedPairIdsByEdgeKey: Map<string, string>; usedCount: number; attemptSkipped: number; invalidSkipped: number };
type Filtered = { allowedPairs: ClusterMergeCandidateEdge[]; blockedByCannotLink: number; blockedByDeclinedDecision: number; blockedByReviewDecision: number };
export async function evaluateState(repo: string, capture: Capture, inventory: Inventory) {
  const snapshot = snapshotSchema.parse(capture.snapshot), state = stateSchema.parse(capture.state);
  const rawProbe = buildBridge(snapshot, inventory); // Also enforces pool identity/eligibility and raw snapshot integrity.
  const byId = new Map(snapshot.clusters.map((r) => [r.id, r])); const recent = snapshot.poolIds.map((id) => candidateOf(byId.get(id)!)); const now = new Date(snapshot.capturedAt);
  const adapter = productionAdapter(repo, state);
  const canonical = await adapter.call<Promise<ClusterMergeCandidate[]>>("canonicalizeClusterMergeEntityMentions", recent);
  adapter.assertHealthy();
  const live = buildClusterMergeCandidateSelection(canonical);
  const stored = await adapter.call<Promise<State["cache"]>>("loadStoredCleanMergePairs", now);
  const combined = adapter.call<CacheSelection>("mergePrecomputedCleanPairs", { liveCandidates: live.candidates, liveAllowedPairs: live.allowedPairs, recentClusters: recent, canonicalRecentClusters: canonical, storedPairs: stored });
  const blocked = await adapter.call<Promise<Filtered>>("filterBlockedClusterMergeEdges", { candidatesById: new Map(combined.candidates.map((c) => [c.id, c])), allowedPairs: combined.allowedPairs, now });
  adapter.assertHealthy();
  const allHashesMatch = combined.candidates.every((c) => c.mergeInputHash === buildClusterMergeCandidateInputHash(c));
  const wouldSkip = combined.candidates.length < 2 || blocked.allowedPairs.length === 0 || (allHashesMatch && combined.usedCount === 0);
  const dto = JSON.parse(buildClusterMergeInput(combined.candidates, blocked.allowedPairs));
  const batches = splitClusterMergeInputBatches(JSON.stringify(dto), constants.CLUSTER_MERGE_AI_PAIR_BATCH_SIZE).map((b, batchIndex) => ({ batchIndex, input: compactClusterMergeInputForModel(b) }));
  const routing = splitClusterMergeInputBatches(JSON.stringify(dto), constants.CLUSTER_MERGE_AI_PAIR_BATCH_SIZE).flatMap((b, batchIndex) => (JSON.parse(b).pairs as { left: { id: string }; right: { id: string } }[]).map((p, i) => ({ batchIndex, pairId: `p${i + 1}`, leftClusterId: p.left.id, rightClusterId: p.right.id, gold: null, requiresIndependentClusterLabel: true })));
  const before = new Set(combined.allowedPairs.map((e) => buildClusterMergeEdgeKey(e.leftId, e.rightId))); const after = new Set(blocked.allowedPairs.map((e) => buildClusterMergeEdgeKey(e.leftId, e.rightId)));
  const report = { capturedAt: snapshot.capturedAt, pool: recent.length, rawPreblockPairsSameSnapshot: rawProbe.poolSummary.preblockPairs, canonicalPreblockPairs: live.allowedPairs.length,
    canonicalChangedClusters: canonical.filter((c, i) => c.eventSubject !== recent[i].eventSubject || c.eventObject !== recent[i].eventObject).length,
    rawDirty: recent.filter((c) => c.mergeInputHash !== buildClusterMergeCandidateInputHash(c)).length,
    canonicalDirty: canonical.filter((c) => c.mergeInputHash !== buildClusterMergeCandidateInputHash(c)).length,
    cachedRowsLoaded: stored.length, cachedPairsAdded: combined.usedCount, cachedAttemptSkipped: combined.attemptSkipped, cachedInvalidSkipped: combined.invalidSkipped,
    combinedPairs: combined.allowedPairs.length, blockedByCannotLink: blocked.blockedByCannotLink, blockedByDeclinedDecision: blocked.blockedByDeclinedDecision, blockedByReviewDecision: blocked.blockedByReviewDecision,
    postStatePairs: blocked.allowedPairs.length, postStateBatches: batches.length, allHashesMatch, wouldSkipWithoutLiveEmbedding: wouldSkip,
    removedEdgeCount: [...before].filter((k) => !after.has(k)).length,
    previousBridgeSha256: PREVIOUS_SHA, sourceCases: rawProbe.sourceCases.map((c) => ({ caseId: c.caseId, status: c.status, inheritedGold: null })),
    scope: { selectedExistingProductionFunctionsExecuted: true, adapter: "AST-whitelisted functions + readonly snapshot Prisma facade", sameSqliteReadTransaction: true,
      coldAliasStateApplied: true, actualProcessAliasCacheVerified: false, existingPrecomputedCacheApplied: true, existingCachedVectorSimilarityMayBeUsed: true,
      cannotLinkAndHistoryApplied: true, orphanUncertainStaleSimulatedByQueryExclusion: true, pendingAndHoldoutFamiliesExcluded: true, goldTransferred: false,
      liveEmbeddingExecuted: false, liveTriggerIdsProvided: false, fullProductionAdmissionEquivalent: false, runtimeImageCodeEqualityVerified: false,
      requestsSent: 0, credentialsRead: false, productDatabaseWrites: 0, readyForModelReplay: false, qualityPassed: false, releaseEligible: false } };
  return { report, dto, batches, routing, stages: { canonicalClusters: canonical, liveEdges: live.allowedPairs, combinedEdges: combined.allowedPairs, filteredEdges: blocked.allowedPairs } };
}
const REF = [...new Set([...REFERENCE_PATHS, "scripts/prepare-cluster-relation-admission-state.ts", "src/lib/entities/normalization.ts"])];
export async function prepareState(repo: string, out: string, capture = captureState) {
  verifyBridge(repo, resolve(repo, PREVIOUS_PACKET), PREVIOUS_SHA);
  if (existsSync(out)) throw new Error("Frozen output exists; overwrite forbidden");
  const inventory = fullInventory(repo); const captured = capture(inventory); const result = await evaluateState(repo, captured, inventory);
  const artifacts = { "snapshot.json": captured.snapshot, "state.json": captured.state, "inventory.json": inventoryProof(inventory), "dto-with-ids.json": result.dto,
    "model-batches.json": result.batches, "routing.json": result.routing, "report.json": result.report, "stages.json": result.stages };
  const manifest = { schemaVersion: 1, capturedAt: captured.snapshot.capturedAt, containerImageId: captured.containerImageId, previousBridgeSha256: PREVIOUS_SHA,
    codeHashes: Object.fromEntries(REF.map((p) => [p, digest(readFileSync(resolve(repo, p)))])), fileHashes: Object.fromEntries(Object.entries(artifacts).map(([n, v]) => [n, digest(json(v))])),
    requestsSent: 0, credentialsRead: false, productDatabaseWrites: 0, readyForModelReplay: false, qualityPassed: false, releaseEligible: false };
  mkdirSync(dirname(out), { recursive: true }); mkdirSync(out);
  for (const [n, v] of Object.entries(artifacts)) writeFileSync(resolve(out, n), json(v), { flag: "wx" });
  writeFileSync(resolve(out, "manifest.json"), json(manifest), { flag: "wx" }); const anchor = digest(json(manifest)); writeFileSync(resolve(out, "manifest.sha256"), anchor + "\n", { flag: "wx" });
  await verifyState(repo, out, anchor); return { ...result.report, manifestSha256: anchor };
}
export async function verifyState(repo: string, dir: string, expectedSha?: string) {
  verifyBridge(repo, resolve(repo, PREVIOUS_PACKET), PREVIOUS_SHA);
  const anchor = readFileSync(resolve(dir, "manifest.sha256"), "utf8").trim(); const bytes = readFileSync(resolve(dir, "manifest.json"));
  if (!/^[a-f0-9]{64}$/.test(anchor) || digest(bytes) !== anchor || (expectedSha && expectedSha !== anchor)) throw new Error("Manifest anchor mismatch");
  const m = JSON.parse(bytes.toString()); const names = ["snapshot.json", "state.json", "inventory.json", "dto-with-ids.json", "model-batches.json", "routing.json", "report.json", "stages.json"];
  if (m.previousBridgeSha256 !== PREVIOUS_SHA || m.requestsSent !== 0 || m.credentialsRead !== false || m.productDatabaseWrites !== 0 || m.readyForModelReplay !== false || m.qualityPassed !== false || m.releaseEligible !== false || JSON.stringify(Object.keys(m.codeHashes)) !== JSON.stringify(REF) || JSON.stringify(Object.keys(m.fileHashes)) !== JSON.stringify(names)) throw new Error("Manifest scope/coverage mismatch");
  for (const p of REF) if (digest(readFileSync(resolve(repo, p))) !== m.codeHashes[p]) throw new Error("Code reference drift");
  for (const n of names) if (digest(readFileSync(resolve(dir, n))) !== m.fileHashes[n]) throw new Error("Frozen file drift");
  const inventory = fullInventory(repo); if (json(readJson(resolve(dir, "inventory.json"))) !== json(inventoryProof(inventory))) throw new Error("Inventory drift");
  const result = await evaluateState(repo, { snapshot: snapshotSchema.parse(readJson(resolve(dir, "snapshot.json"))), state: stateSchema.parse(readJson(resolve(dir, "state.json"))), containerImageId: m.containerImageId }, inventory);
  if (m.capturedAt !== result.report.capturedAt) throw new Error("Capture clock mismatch");
  const rebuilt = { "dto-with-ids.json": result.dto, "model-batches.json": result.batches, "routing.json": result.routing, "report.json": result.report, "stages.json": result.stages };
  for (const [n, v] of Object.entries(rebuilt)) if (json(readJson(resolve(dir, n))) !== json(v)) throw new Error("Production-function reconstruction mismatch");
  return { ...result.report, manifestSha256: anchor };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , action, dir, sha, ...extra] = process.argv;
  if (!dir || extra.length || !["--out", "--verify"].includes(action) || (action === "--out" && sha)) throw new Error("Usage: --out NEW_DIR | --verify DIR [TRUSTED_SHA]; no send mode");
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  void (async () => {
    try { const r = action === "--out" ? await prepareState(repo, resolve(dir)) : await verifyState(repo, resolve(dir), sha);
      console.log(JSON.stringify({ ...r, sourceCases: undefined })); }
    catch { console.error("Offline admission stopped; SQL/state details suppressed. No model request or product write."); process.exitCode = 1; }
  })();
}
