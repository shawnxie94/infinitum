import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureSql, evaluateState, fullInventory, matches, prepareState, productionAdapter, readonlyPrisma, sqliteCompare, stateSchema, verifyState, type Capture, type State } from "../../scripts/prepare-cluster-relation-admission-state";
import { candidateOf, verifyBridge, type Inventory, type Snapshot } from "../../scripts/prepare-cluster-relation-production-bridge";
import { createHistoricalEvaluationRepo } from "../helpers/historical-evaluation-repo";
import { buildClusterMergeCandidateInputHash, buildClusterMergeEdgeKey } from "../../src/lib/clusters/helpers";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../.."); const now = Date.parse("2026-10-14T14:00:00Z");
const dirs: string[] = [];
const inventory: Inventory = { cases: [{ caseId: "DEV-TEST", left: { id: "iL", url: "https://news.test/L" }, right: { id: "iR", url: "https://news.test/R" } }], reserved: [{ id: "held-root", url: "https://news.test/held" }] };
function fixture(): Capture {
  const clusters: Snapshot["clusters"] = ["L", "R"].map((id) => ({ id, title: "Acme发布Alpha模型新版本", summary: "Acme宣布Alpha模型长上下文与新推理能力正式上线", fingerprint: `fp-${id}`, mergeInputHash: null, eventFingerprint: "same-alpha", eventType: "launch", eventSubject: "Acme", eventAction: "发布", eventObject: "Alpha模型", eventDate: null,
    itemCount: 1, projectedItemCount: 1, latestPublishedAt: now, updatedAt: now, status: "active", sourceGate: 1, hasAggregationMember: 0 }));
  const snapshot: Snapshot = { schemaVersion: 1, capturedAt: new Date(now).toISOString(), clusters, poolIds: ["L", "R"], reservedBlockedClusterIds: [], items: ["L", "R"].map((id) => ({ id: `i${id}`, originalUrl: `https://news.test/${id}`, canonicalUrl: `https://news.test/${id}`, clusterId: id, parentItemId: null, isAggregation: 0, status: "processed", moderationStatus: "allowed", sourceAggregationEnabled: 1 })) };
  return { snapshot, state: { entities: [], aliases: [], cache: [], members: snapshot.items.map((i) => ({ id: i.id, clusterId: i.clusterId!, status: i.status, moderationStatus: i.moderationStatus })), constraints: [], decisions: [] }, containerImageId: `sha256:${"0".repeat(64)}` };
}
function pairHash(c: Capture) { return c.snapshot.clusters.map((r) => buildClusterMergeCandidateInputHash(candidateOf(r))).sort().join(":"); }
function decision(c: Capture, relation: State["decisions"][number]["relation"] = "uncertain") {
  return { id: "d", kind: "cluster_pair", pairKey: buildClusterMergeEdgeKey("L", "R"), inputHash: pairHash(c), relation, attemptCount: 1, expiresAt: now + 1000, appliedAt: null, createdAt: now - 1000 };
}
function constraint(scope = "cluster_cluster", left = "L", right = "R") { return { id: "x", kind: "cannot_link", scope, pairKey: buildClusterMergeEdgeKey(left, right), expiresAt: null, createdAt: now - 1000 }; }
function cached(c: Capture, extras: Partial<State["cache"][number]> = {}) {
  return { id: "cache1", pairKey: "bm25-v1:fixture", leftClusterId: "L", rightClusterId: "R", leftInputHash: buildClusterMergeCandidateInputHash(candidateOf(c.snapshot.clusters[0])), rightInputHash: buildClusterMergeCandidateInputHash(candidateOf(c.snapshot.clusters[1])), score: 2000, recallSource: "bm25", bm25Score: 2000, vectorSimilarity: null, attemptCount: 0, expiresAt: now + 1000, updatedAt: now, ...extras };
}
afterEach(() => { vi.unstubAllGlobals(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("existing production functions with read-only snapshot state", () => {
  it("runs cold alias canonicalization with alias precedence, without changing raw hashes/data", async () => {
    const c = fixture(); c.state.entities = [{ normalized: "acme", name: "Acme实体" }]; c.state.aliases = [{ aliasNormalized: "acme", name: "Acme规范名" }];
    const r = await evaluateState(repo, c, inventory); expect(r.report.canonicalChangedClusters).toBe(2); expect(r.stages.canonicalClusters[0].eventSubject).toBe("Acme规范名");
    expect(c.snapshot.clusters[0].eventSubject).toBe("Acme"); expect(r.report.scope.actualProcessAliasCacheVerified).toBe(false);
  });
  it("blocks a direct cluster cannot_link before historical decisions", async () => {
    const c = fixture(); c.state.constraints = [constraint()]; c.state.decisions = [decision(c)];
    const r = await evaluateState(repo, c, inventory); expect(r.report.blockedByCannotLink).toBe(1); expect(r.report.blockedByReviewDecision).toBe(0); expect(r.routing).toEqual([]);
  });
  it("projects processed allowed/restored members for cross-item cannot_link", async () => {
    const c = fixture(); c.state.constraints = [constraint("item_item", "iL", "iR")]; c.state.members[1].moderationStatus = "restored";
    expect((await evaluateState(repo, c, inventory)).report.blockedByCannotLink).toBe(1);
    c.state.members[1].moderationStatus = "blocked"; expect((await evaluateState(repo, c, inventory)).report.blockedByCannotLink).toBe(0);
  });
  it("ignores must_link and expired constraints, including exact expiry boundary", async () => {
    const c = fixture(); c.state.constraints = [{ ...constraint(), kind: "must_link" }, { ...constraint(), id: "expired", expiresAt: now }];
    expect((await evaluateState(repo, c, inventory)).report.postStatePairs).toBe(1);
  });
  it("blocks uncertain until applied, independently of expiry", async () => {
    const c = fixture(); c.state.decisions = [{ ...decision(c), expiresAt: now - 1000 }]; expect((await evaluateState(repo, c, inventory)).report.blockedByReviewDecision).toBe(1);
    c.state.decisions[0].appliedAt = now; expect((await evaluateState(repo, c, inventory)).report.postStatePairs).toBe(1);
  });
  it.each(["follow_up", "synthesis", "unrelated"] as const)("suppresses %s cooldown; expiry equality allows retry", async (relation) => {
    const c = fixture(); c.state.decisions = [decision(c, relation)]; expect((await evaluateState(repo, c, inventory)).report.blockedByDeclinedDecision).toBe(1);
    c.state.decisions[0].expiresAt = now; expect((await evaluateState(repo, c, inventory)).report.postStatePairs).toBe(1);
    c.state.decisions[0].attemptCount = 3; expect((await evaluateState(repo, c, inventory)).report.blockedByDeclinedDecision).toBe(1);
  });
  it("does not use historical decisions for another input hash or kind", async () => {
    const c = fixture(); c.state.decisions = [{ ...decision(c), inputHash: "old-input" }, { ...decision(c), id: "item-decision", kind: "item_cluster" }];
    expect((await evaluateState(repo, c, inventory)).report.postStatePairs).toBe(1);
  });
  it("selects latest by raw SQLite date storage class then BINARY id", async () => {
    const c = fixture(); c.state.decisions = [{ ...decision(c), id: "a", createdAt: "2026-01-01 00:00:00", expiresAt: now }, { ...decision(c), id: "z", createdAt: now }];
    expect((await evaluateState(repo, c, inventory)).report.blockedByReviewDecision).toBe(1); // Both uncertain; inspect actual winner below.
    const a = productionAdapter(repo, c.state);
    const block = await a.call<Promise<{ decision: { id: string } }>>("getClusterPairDecisionBlock", { pairKey: buildClusterMergeEdgeKey("L", "R"), inputHash: pairHash(c), now: new Date(now) }); expect(block.decision.id).toBe("a");
    expect(sqliteCompare("a", "Z")).toBeGreaterThan(0); expect(sqliteCompare("2026-01-01", now)).toBeGreaterThan(0);
  });
  it("applies canonical rather than raw input hash to the historical gate", async () => {
    const c = fixture(); c.state.entities = [{ normalized: "acme", name: "规范Acme" }]; c.state.decisions = [decision(c)];
    expect((await evaluateState(repo, c, inventory)).report.blockedByReviewDecision).toBe(0);
    const changed = { ...c, snapshot: { ...c.snapshot, clusters: c.snapshot.clusters.map((r) => ({ ...r, eventSubject: "规范Acme" })) } };
    c.state.decisions[0].inputHash = pairHash(changed); expect((await evaluateState(repo, c, inventory)).report.blockedByReviewDecision).toBe(1);
  });
  it("retains raw input hashes for clean-cache validation, with canonical DTO fields", async () => {
    const c = fixture(); for (const r of c.snapshot.clusters) { r.eventFingerprint = null; r.mergeInputHash = buildClusterMergeCandidateInputHash(candidateOf(r)); }
    c.state.cache = [cached(c)]; const r = await evaluateState(repo, c, inventory);
    expect(r.report.cachedPairsAdded).toBe(1); expect(r.report.postStatePairs).toBe(1); expect(r.report.wouldSkipWithoutLiveEmbedding).toBe(false);
    expect(r.routing[0].gold).toBeNull(); expect(r.report.scope.readyForModelReplay).toBe(false);
  });
  it("rejects stale hashes, too many cache attempts, wrong version and expired cache", async () => {
    const c = fixture(); for (const r of c.snapshot.clusters) { r.eventFingerprint = null; r.mergeInputHash = buildClusterMergeCandidateInputHash(candidateOf(r)); }
    c.state.cache = [cached(c, { id: "stale", leftInputHash: "stale" }), cached(c, { id: "attempted", attemptCount: 100 }), cached(c, { id: "expired", expiresAt: now }), cached(c, { id: "old", pairKey: "legacy:pair" })];
    const r = await evaluateState(repo, c, inventory); expect(r.report.cachedRowsLoaded).toBe(2); expect(r.report.cachedPairsAdded).toBe(0); expect(r.report.cachedAttemptSkipped).toBe(1); expect(r.report.cachedInvalidSkipped).toBe(1); expect(r.report.wouldSkipWithoutLiveEmbedding).toBe(true);
  });
  it("uses already stored cached vector recall without generating an embedding", async () => {
    const c = fixture(); for (const r of c.snapshot.clusters) { r.eventFingerprint = null; r.mergeInputHash = buildClusterMergeCandidateInputHash(candidateOf(r)); }
    c.state.cache = [cached(c, { recallSource: "vector", bm25Score: null, vectorSimilarity: 0.99 })];
    const r = await evaluateState(repo, c, inventory); expect(r.report.cachedPairsAdded).toBe(1); expect(r.stages.combinedEdges[0].recallChannels).toContain("vector"); expect(r.report.scope.liveEmbeddingExecuted).toBe(false);
  });
  it("attributes cache to a live edge without counting it as a new cache pair", async () => {
    const c = fixture(); for (const r of c.snapshot.clusters) r.mergeInputHash = buildClusterMergeCandidateInputHash(candidateOf(r));
    c.state.cache = [cached(c)]; const r = await evaluateState(repo, c, inventory);
    expect(r.report.cachedPairsAdded).toBe(0); expect(r.stages.combinedEdges[0].selectionPaths).toContain("precomputed_cache"); expect(r.report.wouldSkipWithoutLiveEmbedding).toBe(true);
  });
  it("never exposes the mutating entrypoint or writable Prisma methods", () => {
    const c = fixture(); const a = productionAdapter(repo, c.state);
    expect(() => a.call("executeClusterMerge", undefined, new Date(now))).toThrow("Non-whitelisted"); expect(readonlyPrisma(c.state)).not.toHaveProperty("$executeRaw"); expect(readonlyPrisma(c.state).clusterDecision).not.toHaveProperty("update");
    expect(() => matches({ id: "x" }, { id: { contains: "x" } })).toThrow("Unsupported");
  });
  it("preserves the global cache loader's 80-row limit before out-of-pool invalidation", async () => {
    const c = fixture(); c.state.cache = Array.from({ length: 81 }, (_, i) => cached(c, { id: `cache-${String(i).padStart(3, "0")}`, score: 9999 - i, leftClusterId: "outside" }));
    const a = productionAdapter(repo, c.state); const rows = await a.call<Promise<State["cache"]>>("loadStoredCleanMergePairs", new Date(now)); expect(rows.length).toBe(80); expect(rows[79].id).toBe("cache-079");
  });
  it("excludes all non-fixed-dev identities, including SR01, without hydrating labels", () => {
    const i = fullInventory(repo); expect(i.cases.length).toBe(6); expect(i.reserved.length).toBe(8);
    const dev = new Set(i.cases.flatMap((c) => [c.left.id, c.right.id])); expect(i.reserved.some((r) => dev.has(r.id))).toBe(false);
    expect(stateSchema.safeParse({ ...fixture().state, apiKey: "not-a-real-key" }).success).toBe(false);
  });
  it("rejects historical bridge fingerprints against changed current source", () => {
    expect(() => verifyBridge(repo, join(repo, "docs/eval/reviews/cluster-relation-production-bridge-2026-10-14/packet")))
      .toThrow("Code reference drift");
  });
  it("freezes and reconstructs with no network, forbids overwrite and rejects drift", async () => {
    const fetch = vi.fn(() => { throw new Error("forbidden network"); }); vi.stubGlobal("fetch", fetch);
    const dir = mkdtempSync(join(tmpdir(), "infinitum-admission-")); dirs.push(dir); const out = join(dir, "packet");
    const historicalRepo = createHistoricalEvaluationRepo(repo, dir);
    const r = await prepareState(historicalRepo, out, () => fixture());
    expect(fetch).not.toHaveBeenCalled(); expect((await verifyState(historicalRepo, out, r.manifestSha256)).manifestSha256).toBe(r.manifestSha256);
    await expect(prepareState(historicalRepo, out, () => fixture())).rejects.toThrow("overwrite");
    writeFileSync(join(out, "routing.json"), "[]\n"); await expect(verifyState(historicalRepo, out)).rejects.toThrow("Frozen file drift");
  });
});

describe("SQLite capture query", () => {
  it("executes two SELECTs in one readonly transaction, excludes reserved descendants, and simulates orphan uncertain staleness", () => {
    let setup = `CREATE TABLE sources(id TEXT,aggregationEnabled INTEGER); INSERT INTO sources VALUES('s',1);
CREATE TABLE content_clusters(id TEXT,title TEXT,summary TEXT,fingerprint TEXT,mergeInputHash TEXT,eventFingerprint TEXT,eventType TEXT,eventSubject TEXT,eventAction TEXT,eventObject TEXT,eventDate TEXT,itemCount INTEGER,latestPublishedAt INTEGER,status TEXT,updatedAt INTEGER);
CREATE TABLE items(id TEXT,originalUrl TEXT,canonicalUrl TEXT,clusterId TEXT,parentItemId TEXT,isAggregation INTEGER,status TEXT,moderationStatus TEXT,sourceId TEXT);
CREATE TABLE entities(id TEXT,name TEXT,normalized TEXT); CREATE TABLE entity_aliases(entityId TEXT,aliasNormalized TEXT);
CREATE TABLE cluster_merge_clean_pair_candidates(id TEXT,pairKey TEXT,leftClusterId TEXT,rightClusterId TEXT,leftInputHash TEXT,rightInputHash TEXT,score INTEGER,recallSource TEXT,bm25Score INTEGER,vectorSimilarity REAL,attemptCount INTEGER,expiresAt INTEGER,updatedAt INTEGER);
CREATE TABLE cluster_constraints(id TEXT,kind TEXT,scope TEXT,pairKey TEXT,expiresAt INTEGER,createdAt INTEGER);
CREATE TABLE cluster_decisions(id TEXT,kind TEXT,pairKey TEXT,inputHash TEXT,relation TEXT,attemptCount INTEGER,expiresAt INTEGER,appliedAt INTEGER,createdAt INTEGER,leftClusterId TEXT,rightClusterId TEXT);`;
    // Existing system sqlite3; in-memory fixtures only. Hex text preserves embedded NUL pair keys.
    const insert = (table: string, ...values: (string | number | null)[]) => { setup += `INSERT INTO ${table} VALUES(${values.map((v) => v === null ? "NULL" : typeof v === "number" ? v : `CAST(X'${Buffer.from(v).toString("hex")}' AS TEXT)`).join(",")});\n`; };
    const c = fixture();
    for (const r of [...c.snapshot.clusters, { ...c.snapshot.clusters[0], id: "HELD" }]) insert("content_clusters",r.id,r.title,r.summary,r.fingerprint,r.mergeInputHash,r.eventFingerprint,r.eventType,r.eventSubject,r.eventAction,r.eventObject,r.eventDate,r.itemCount,now,r.status,now);
    for (const r of c.snapshot.items) insert("items",r.id,r.originalUrl,r.canonicalUrl,r.clusterId,null,0,"processed","allowed","s");
    insert("items","held-root",inventory.reserved[0].url,inventory.reserved[0].url,null,null,1,"processed","allowed","s"); insert("items","child","u","u",null,"held-root",1,"processed","allowed","s"); insert("items","grandchild","v","v","HELD","child",0,"processed","allowed","s");
    insert("cluster_decisions","orphan","cluster_pair",buildClusterMergeEdgeKey("L","R"),"hash","uncertain",1,null,null,now,null,"R"); insert("cluster_decisions","reject","cluster_pair",buildClusterMergeEdgeKey("L","R"),"hash","unrelated",1,null,null,now,null,"R");
    const sql = captureSql(inventory, now);
    const run = (input: string) => execFileSync("sqlite3", [":memory:"], { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    const results = run(setup + sql).trim().split("\n");
    expect(results).toHaveLength(2); const snap = JSON.parse(results[0]); const state = stateSchema.parse(JSON.parse(results[1]));
    expect(snap.poolIds).toEqual(["L","R"]); expect(snap.clusters.some((r: { id: string }) => r.id === "HELD")).toBe(false); expect(state.decisions.map((r) => r.id)).toEqual(["reject"]);
    expect(() => run(setup + sql + "DELETE FROM entities;")).toThrow("readonly"); for (const text of ["reasonText","apiKey","model_api_configs","prompt_configs","rssContent","fullText"]) expect(sql).not.toContain(text);
  });
});
