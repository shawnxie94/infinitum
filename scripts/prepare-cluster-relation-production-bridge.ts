/** Read-only local DTO bridge. No provider, key/config reads, mutations, or send mode. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CLUSTER_LOOKBACK_MS, CLUSTER_MERGE_SCAN_CLUSTER_LIMIT, CLUSTER_MERGE_AI_PAIR_BATCH_SIZE } from "../src/config/constants";
import { buildClusterMergeCandidateSelection, buildClusterMergeCandidateInputHash, buildClusterMergeInput, buildClusterMergeEdgeKey,
  checkClusterMergePairSafety, type ClusterMergeCandidate } from "../src/lib/clusters/helpers";
import { compactClusterMergeInputForModel, splitClusterMergeInputBatches } from "../src/lib/ai/protocols/cluster";
import { digest, verifySourcePacket } from "./prepare-cluster-relation-source-replay";
import { FROZEN_PACKET, FROZEN_SHA } from "./score-cluster-relation-source-replay";

const REVIEW = "docs/eval/reviews";
const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
const readJson = (p: string): unknown => JSON.parse(readFileSync(p, "utf8"));
export type SourceRef = { id: string; url: string };
export type DevCase = { caseId: string; left: SourceRef; right: SourceRef };
export type Inventory = { cases: DevCase[]; reserved: SourceRef[] };
export const inventoryProof = (i: Inventory) => ({ cases: i.cases, reservedIdentityHashes: i.reserved.map((r) => ({ idSha256: digest(r.id), urlSha256: digest(r.url) })) });
export function loadInventory(repo: string): Inventory {
  verifySourcePacket(repo, resolve(repo, FROZEN_PACKET), FROZEN_SHA);
  const input = z.object({ pairs: z.array(z.object({ left: z.object({ id: z.string(), sourceEvidence: z.object({ url: z.string().url() }) }), right: z.object({ id: z.string(), sourceEvidence: z.object({ url: z.string().url() }) }) })) }).parse(readJson(resolve(repo, FROZEN_PACKET, "input.json")));
  const mapping = z.array(z.object({ caseId: z.string() })).parse(readJson(resolve(repo, FROZEN_PACKET, "mapping.json")));
  const cases = input.pairs.map((p, i) => ({ caseId: mapping[i].caseId, left: { id: p.left.id, url: p.left.sourceEvidence.url }, right: { id: p.right.id, url: p.right.sourceEvidence.url } }));
  // Reserved-case metadata only: do not hydrate its articles or labels into the snapshot.
  const reserved: SourceRef[] = [];
  for (const dir of ["cluster-relation-source-verified-2026-10-14", "cluster-relation-follow-up-2026-10-14"]) {
    const bank = readJson(resolve(repo, REVIEW, dir, "sources.json")) as { sources: Record<string, { url: string }> };
    const list = readJson(resolve(repo, REVIEW, dir, "cases.json")) as { cases: { split: string; leftSourceId: string; rightSourceId: string }[] };
    for (const c of list.cases.filter((c) => c.split === "holdout")) for (const id of [c.leftSourceId, c.rightSourceId]) reserved.push({ id, url: bank.sources[id].url });
  }
  return { cases, reserved };
}
const quote = (s: string) => "'" + s.replace(/'/g, "''") + "'";
const inList = (a: string[]) => a.length ? a.map(quote).join(",") : "NULL";
export function buildSnapshotSql(inventory: Inventory, nowMs: number) {
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) throw new Error("Invalid snapshot clock");
  const dev = inventory.cases.flatMap((c) => [c.left, c.right]); const reserved = inventory.reserved;
  const devMatch = `(i.id IN (${inList(dev.map((r) => r.id))}) OR i.originalUrl IN (${inList(dev.map((r) => r.url))}) OR i.canonicalUrl IN (${inList(dev.map((r) => r.url))}))`;
  const heldRootMatch = `(h.id IN (${inList(reserved.map((r) => r.id))}) OR h.originalUrl IN (${inList(reserved.map((r) => r.url))}) OR h.canonicalUrl IN (${inList(reserved.map((r) => r.url))}))`;
  const cols = "c.id,c.title,c.summary,c.fingerprint,c.mergeInputHash,c.eventFingerprint,c.eventType,c.eventSubject,c.eventAction,c.eventObject,c.eventDate,c.itemCount,c.latestPublishedAt,c.status,c.updatedAt";
  return `PRAGMA query_only=ON;
WITH RECURSIVE reservedItems(id) AS (
 SELECT h.id FROM items h WHERE ${heldRootMatch}
 UNION SELECT child.id FROM items child JOIN reservedItems parent ON child.parentItemId=parent.id
), counts AS (
 SELECT ${cols},
 (SELECT count(*) FROM items x WHERE x.clusterId=c.id AND x.status='processed' AND x.moderationStatus IN ('allowed','restored')) AS projectedItemCount,
 EXISTS(SELECT 1 FROM items x JOIN sources s ON s.id=x.sourceId WHERE x.clusterId=c.id AND x.status='processed' AND x.moderationStatus IN ('allowed','restored') AND (s.aggregationEnabled=1 OR x.parentItemId IS NOT NULL)) AS sourceGate,
 EXISTS(SELECT 1 FROM items h WHERE h.clusterId=c.id AND h.id IN (SELECT id FROM reservedItems)) AS reservedFamily,
 EXISTS(SELECT 1 FROM items x WHERE x.clusterId=c.id AND x.isAggregation=1) AS hasAggregationMember
 FROM content_clusters c
), pool AS (
 SELECT * FROM counts WHERE status='active' AND latestPublishedAt>=${nowMs - CLUSTER_LOOKBACK_MS} AND sourceGate=1 AND reservedFamily=0
 ORDER BY latestPublishedAt DESC, updatedAt DESC, projectedItemCount DESC, id ASC LIMIT ${CLUSTER_MERGE_SCAN_CLUSTER_LIMIT}
), mapped AS (
 SELECT i.id,i.originalUrl,i.canonicalUrl,i.clusterId,i.parentItemId,i.isAggregation,i.status,i.moderationStatus,s.aggregationEnabled AS sourceAggregationEnabled
 FROM items i JOIN sources s ON s.id=i.sourceId WHERE ${devMatch}
), relevant AS (
 SELECT * FROM counts WHERE reservedFamily=0 AND (id IN (SELECT id FROM pool) OR id IN (SELECT clusterId FROM mapped))
)
SELECT json_object('schemaVersion',1,'capturedAt',${quote(new Date(nowMs).toISOString())},
 'items',json(COALESCE((SELECT json_group_array(json_object('id',id,'originalUrl',originalUrl,'canonicalUrl',canonicalUrl,'clusterId',clusterId,'parentItemId',parentItemId,'isAggregation',isAggregation,'status',status,'moderationStatus',moderationStatus,'sourceAggregationEnabled',sourceAggregationEnabled)) FROM mapped),'[]')),
 'clusters',json(COALESCE((SELECT json_group_array(json_object('id',id,'title',title,'summary',summary,'fingerprint',fingerprint,'mergeInputHash',mergeInputHash,'eventFingerprint',eventFingerprint,'eventType',eventType,'eventSubject',eventSubject,'eventAction',eventAction,'eventObject',eventObject,'eventDate',eventDate,'itemCount',itemCount,'latestPublishedAt',latestPublishedAt,'status',status,'updatedAt',updatedAt,'projectedItemCount',projectedItemCount,'sourceGate',sourceGate,'hasAggregationMember',hasAggregationMember)) FROM relevant),'[]')),
 'poolIds',json(COALESCE((SELECT json_group_array(id) FROM (SELECT id FROM pool ORDER BY latestPublishedAt DESC, updatedAt DESC, projectedItemCount DESC, id ASC)),'[]')),
 'reservedBlockedClusterIds',json(COALESCE((SELECT json_group_array(id) FROM counts WHERE reservedFamily=1 AND id IN (SELECT clusterId FROM mapped)),'[]')));
`;
}
const nullable = z.string().nullable();
const bit = z.union([z.literal(0), z.literal(1)]);
const clusterSchema = z.object({ id: z.string(), title: z.string(), summary: z.string(), fingerprint: z.string(), mergeInputHash: nullable,
  eventFingerprint: nullable, eventType: nullable, eventSubject: nullable, eventAction: nullable, eventObject: nullable, eventDate: nullable,
  itemCount: z.number().int().nonnegative(), latestPublishedAt: z.union([z.string(), z.number()]), status: z.string(), updatedAt: z.union([z.string(), z.number()]),
  projectedItemCount: z.number().int().nonnegative(), sourceGate: bit, hasAggregationMember: bit }).strict();
const itemSchema = z.object({ id: z.string(), originalUrl: z.string(), canonicalUrl: z.string(), clusterId: nullable, parentItemId: nullable,
  isAggregation: bit, status: z.string(), moderationStatus: z.string(), sourceAggregationEnabled: bit }).strict();
export const snapshotSchema = z.object({ schemaVersion: z.literal(1), capturedAt: z.string().datetime(), items: z.array(itemSchema), clusters: z.array(clusterSchema),
  poolIds: z.array(z.string()), reservedBlockedClusterIds: z.array(z.string()) }).strict();
export type Snapshot = z.infer<typeof snapshotSchema>;
export function captureSnapshot(inventory: Inventory, nowMs = Date.now()): Snapshot {
  const run = (args: string[]) => execFileSync("docker", ["--context", "desktop-linux", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
  if (!run(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}", "desktop-linux"]).trim().startsWith("unix://")) throw new Error("Nonlocal Docker forbidden");
  // One SELECT statement: all subqueries observe a single SQLite read snapshot. No backup/DB writes.
  const result = run(["exec", "infinitum", "sqlite3", "-readonly", "/app/data/dev.db", buildSnapshotSql(inventory, nowMs)]);
  return snapshotSchema.parse(JSON.parse(result));
}
function toDate(v: string | number) {
  const d = new Date(typeof v === "string" && /^\d{4}-\d\d-\d\d \d\d:/.test(v) ? v.replace(" ", "T") + "Z" : v);
  if (!Number.isFinite(d.getTime())) throw new Error("Invalid stored timestamp"); return d;
}
export function candidateOf(row: Snapshot["clusters"][number]): ClusterMergeCandidate {
  return { id: row.id, title: row.title, summary: row.summary, fingerprint: row.fingerprint, mergeInputHash: row.mergeInputHash,
    eventFingerprint: row.eventFingerprint, eventType: row.eventType, eventSubject: row.eventSubject, eventAction: row.eventAction,
    eventObject: row.eventObject, eventDate: row.eventDate, itemCount: row.projectedItemCount, latestPublishedAt: toDate(row.latestPublishedAt) };
}
export function buildBridge(snapshotInput: unknown, inventory: Inventory) {
  const snapshot = snapshotSchema.parse(snapshotInput);
  const rowById = new Map(snapshot.clusters.map((c) => [c.id, c]));
  if (rowById.size !== snapshot.clusters.length || new Set(snapshot.items.map((i) => i.id)).size !== snapshot.items.length || new Set(snapshot.poolIds).size !== snapshot.poolIds.length || snapshot.poolIds.some((id) => !rowById.has(id) || snapshot.reservedBlockedClusterIds.includes(id)) || snapshot.reservedBlockedClusterIds.some((id) => rowById.has(id))) throw new Error("Snapshot pool identity mismatch");
  const cutoff = Date.parse(snapshot.capturedAt) - CLUSTER_LOOKBACK_MS;
  if (snapshot.poolIds.length > CLUSTER_MERGE_SCAN_CLUSTER_LIMIT || snapshot.poolIds.some((id) => {
    const r = rowById.get(id)!; return r.status !== "active" || r.sourceGate !== 1 || r.projectedItemCount <= 0 || toDate(r.latestPublishedAt).getTime() < cutoff;
  })) throw new Error("Snapshot pool eligibility mismatch");
  const candidates = snapshot.poolIds.map((id) => candidateOf(rowById.get(id)!));
  const selection = buildClusterMergeCandidateSelection(candidates); // No liveIds override, embeddings, or clean-cache injection.
  const rawInput = JSON.parse(buildClusterMergeInput(selection.candidates, selection.allowedPairs));
  const rawBatches = splitClusterMergeInputBatches(JSON.stringify(rawInput), CLUSTER_MERGE_AI_PAIR_BATCH_SIZE);
  const modelBatches = rawBatches.map((b, batchIndex) => ({ batchIndex, input: compactClusterMergeInputForModel(b) }));
  const routing = rawBatches.flatMap((b, batchIndex) => (JSON.parse(b).pairs as { left: { id: string }; right: { id: string } }[]).map((p, i) => ({ batchIndex, pairId: `p${i + 1}`, leftClusterId: p.left.id, rightClusterId: p.right.id, gold: null, requiresClusterLevelReview: true })));
  const side = (ref: SourceRef) => {
    const idMatch = snapshot.items.filter((i) => i.id === ref.id);
    const urlMatch = snapshot.items.filter((i) => i.originalUrl === ref.url || i.canonicalUrl === ref.url);
    const matches = idMatch.length ? idMatch : urlMatch;
    if (matches.length !== 1) return { sourceId: ref.id, status: matches.length ? "ambiguous_identity" : "source_not_in_local_db", item: null, cluster: null };
    const item = matches[0];
    if (item.originalUrl !== ref.url && item.canonicalUrl !== ref.url) return { sourceId: ref.id, status: "id_url_mismatch", item, cluster: null };
    if (!item.clusterId) return { sourceId: ref.id, status: "source_has_no_cluster", item, cluster: null };
    if (snapshot.reservedBlockedClusterIds.includes(item.clusterId)) return { sourceId: ref.id, status: "reserved_family_in_cluster", item, cluster: null };
    const cluster = rowById.get(item.clusterId);
    return { sourceId: ref.id, status: cluster ? "mapped" : "cluster_missing", item, cluster: cluster ?? null };
  };
  const sourceCases = inventory.cases.map((c) => {
    const left = side(c.left), right = side(c.right); const l = left.cluster, r = right.cluster;
    const distinct = Boolean(l && r && l.id !== r.id);
    const edge = distinct ? selection.allowedPairs.find((e) => buildClusterMergeEdgeKey(e.leftId, e.rightId) === buildClusterMergeEdgeKey(l!.id, r!.id)) : undefined;
    const inPool = Boolean(distinct && snapshot.poolIds.includes(l!.id) && snapshot.poolIds.includes(r!.id));
    return { caseId: c.caseId, left, right, status: !l || !r ? "unresolved_source_mapping" : !distinct ? "already_same_cluster" : !inPool ? "outside_snapshot_scan_pool" : edge ? "selected_preblock_probe" : "not_selected_preblock_lane",
      directSafetyDiagnostic: distinct ? checkClusterMergePairSafety(candidateOf(l!), candidateOf(r!)) : null,
      candidateEdge: edge ?? null, inheritedGold: null, requiresNewClusterLevelLabel: true,
      fullRuntimeAdmission: "unmeasured", parentSourceNotReplacedByChild: Boolean(left.item?.isAggregation || right.item?.isAggregation) };
  });
  return { rawInput, modelBatches, routing, sourceCases, diagnostics: selection.diagnostics,
    poolSummary: { clusters: candidates.length, dirty: candidates.filter((c) => c.mergeInputHash !== buildClusterMergeCandidateInputHash(c)).length,
      selectedClusters: selection.candidates.length, preblockPairs: selection.allowedPairs.length, modelBatchCount: modelBatches.length,
      wouldSkipWithoutPrecomputedCache: selection.allowedPairs.length === 0 || selection.candidates.every((c) => c.mergeInputHash === buildClusterMergeCandidateInputHash(c)),
      storedCountsChangedInMemory: snapshot.clusters.filter((c) => c.itemCount !== c.projectedItemCount).length },
    scope: { track: "local_docker_production_shape_preblock_probe", sourceManifestSha256: FROZEN_SHA,
      matchedCurrentDtoBuilders: true, productionRuntimeCodeEqualityVerified: false, finalCandidateAdmissionMeasured: false,
      sourceGoldTransferred: false, noSourceEvidenceOrFullTextInModelInputs: true, entityAliasCanonicalizationApplied: false,
      embeddingRecallExecuted: false, precomputedCacheCombined: false, historicalDecisionAndConstraintBlocksApplied: false,
      postModelAggregationAndTransitiveGuardsExecuted: false, holdoutFamiliesExcluded: true, lookbackMs: CLUSTER_LOOKBACK_MS,
      scanLimit: CLUSTER_MERGE_SCAN_CLUSTER_LIMIT, batchSize: CLUSTER_MERGE_AI_PAIR_BATCH_SIZE, snapshotOnlyNoLiveTriggerIdsOverride: true,
      requestsSent: 0, credentialsRead: false, productDatabaseWrites: 0, sendAllowed: false, modelEffectMeasured: false, releaseEligible: false } };
}
export const REFERENCE_PATHS = ["scripts/prepare-cluster-relation-production-bridge.ts", "scripts/prepare-cluster-relation-source-replay.ts", "scripts/score-cluster-relation-source-replay.ts",
  "src/config/constants.ts", "src/lib/clusters/helpers.ts", "src/lib/clusters/bm25.ts", "src/lib/clusters/normalization.ts", "src/lib/clusters/service.ts",
  "src/lib/ai/protocols/cluster.ts", "src/lib/ai/contracts.ts", "src/lib/ai/provider-next.ts", "src/lib/entities/mention-resolution.ts",
  "src/lib/clusters/constraints.ts", "src/lib/clusters/decisions.ts"];
export function prepareBridge(repo: string, out: string, capture = captureSnapshot) {
  if (existsSync(out)) throw new Error("Output exists; never overwrite frozen artifacts");
  const inventory = loadInventory(repo); const snapshot = capture(inventory); const bridge = buildBridge(snapshot, inventory);
  const artifacts = { "snapshot.json": json(snapshot), "inventory.json": json(inventoryProof(inventory)), "dto-with-ids.json": json(bridge.rawInput),
    "model-batches.json": json(bridge.modelBatches), "routing.json": json(bridge.routing), "bridge-report.json": json({ sourceCases: bridge.sourceCases, diagnostics: bridge.diagnostics, poolSummary: bridge.poolSummary, scope: bridge.scope }) };
  const manifest = { schemaVersion: 1, generatedAt: new Date().toISOString(), sourceManifestSha256: FROZEN_SHA,
    references: Object.fromEntries(REFERENCE_PATHS.map((p) => [p, digest(readFileSync(resolve(repo, p)))])),
    fileHashes: Object.fromEntries(Object.entries(artifacts).map(([n, text]) => [n, digest(text)])), requestsSent: 0, credentialsRead: false,
    readyForModelReplay: false, labelTransferAllowed: false, sourceDatabase: { context: "desktop-linux", container: "infinitum", database: "/app/data/dev.db", access: "readonly, query_only; one SELECT snapshot" } };
  mkdirSync(dirname(out), { recursive: true }); mkdirSync(out);
  for (const [n, text] of Object.entries(artifacts)) writeFileSync(resolve(out, n), text, { flag: "wx" });
  writeFileSync(resolve(out, "manifest.json"), json(manifest), { flag: "wx" });
  const anchor = digest(readFileSync(resolve(out, "manifest.json"))); writeFileSync(resolve(out, "manifest.sha256"), anchor + "\n", { flag: "wx" });
  verifyBridge(repo, out, anchor); return { ...bridge.poolSummary, manifestSha256: anchor, requestsSent: 0, finalCandidateAdmissionMeasured: false };
}
export function verifyBridge(repo: string, dir: string, expectedSha?: string) {
  const anchor = readFileSync(resolve(dir, "manifest.sha256"), "utf8").trim(); const bytes = readFileSync(resolve(dir, "manifest.json"));
  if (!/^[a-f0-9]{64}$/.test(anchor) || digest(bytes) !== anchor || (expectedSha && expectedSha !== anchor)) throw new Error("Manifest trust anchor mismatch");
  const m = JSON.parse(bytes.toString());
  if (m.sourceManifestSha256 !== FROZEN_SHA || m.requestsSent !== 0 || m.credentialsRead !== false || m.readyForModelReplay !== false || m.labelTransferAllowed !== false) throw new Error("Invalid offline bridge scope");
  if (JSON.stringify(Object.keys(m.references)) !== JSON.stringify(REFERENCE_PATHS)) throw new Error("Reference coverage mismatch");
  for (const p of REFERENCE_PATHS) if (digest(readFileSync(resolve(repo, p))) !== m.references[p]) throw new Error("Code reference drift");
  const expectedFiles = ["snapshot.json", "inventory.json", "dto-with-ids.json", "model-batches.json", "routing.json", "bridge-report.json"];
  if (JSON.stringify(Object.keys(m.fileHashes)) !== JSON.stringify(expectedFiles)) throw new Error("Frozen file coverage mismatch");
  for (const n of expectedFiles) if (digest(readFileSync(resolve(dir, n))) !== m.fileHashes[n]) throw new Error("Frozen file drift");
  const inventory = loadInventory(repo);
  if (JSON.stringify(readJson(resolve(dir, "inventory.json"))) !== JSON.stringify(inventoryProof(inventory))) throw new Error("Dev/reserved inventory drift");
  const b = buildBridge(readJson(resolve(dir, "snapshot.json")), inventory);
  const rebuilt = { "dto-with-ids.json": b.rawInput, "model-batches.json": b.modelBatches, "routing.json": b.routing,
    "bridge-report.json": { sourceCases: b.sourceCases, diagnostics: b.diagnostics, poolSummary: b.poolSummary, scope: b.scope } };
  for (const [n, v] of Object.entries(rebuilt)) if (JSON.stringify(readJson(resolve(dir, n))) !== JSON.stringify(v)) throw new Error("DTO/report reconstruction mismatch");
  return { ...b.poolSummary, manifestSha256: anchor, requestsSent: 0, finalCandidateAdmissionMeasured: false };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , action, dir, sha, ...extra] = process.argv;
  if (!dir || extra.length || !["--out", "--verify"].includes(action) || (action === "--out" && sha)) throw new Error("Usage: --out NEW_DIR | --verify DIR [TRUSTED_MANIFEST_SHA]; no send mode");
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  try { console.log(JSON.stringify(action === "--out" ? prepareBridge(repo, resolve(dir)) : verifyBridge(repo, resolve(dir), sha))); }
  catch { console.error("Offline bridge stopped; no model request or product write was made. Query details suppressed."); process.exitCode = 1; }
}
