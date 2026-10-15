import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBridge, buildSnapshotSql, candidateOf, inventoryProof, prepareBridge, snapshotSchema, verifyBridge, type Inventory, type Snapshot } from "../../scripts/prepare-cluster-relation-production-bridge";
import { buildClusterMergeCandidateInputHash } from "../../src/lib/clusters/helpers";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dirs: string[] = [];
const now = Date.parse("2026-10-14T14:00:00.000Z");
const inventory: Inventory = { cases: [{ caseId: "DEV-TEST", left: { id: "source-a", url: "https://news.test/a" }, right: { id: "source-b", url: "https://news.test/b" } }], reserved: [{ id: "reserved-id", url: "https://news.test/reserved" }] };
function cluster(id: string): Snapshot["clusters"][number] {
  return { id, title: "Acme 正式发布 Alpha 模型", summary: "Acme 宣布 Alpha 模型更新，支持更长上下文和新推理能力。", fingerprint: `fp-${id}`, mergeInputHash: null,
    eventFingerprint: "event-alpha", eventType: "launch", eventSubject: "Acme", eventAction: "发布", eventObject: "Alpha 模型", eventDate: null,
    itemCount: 1, latestPublishedAt: now, status: "active", updatedAt: now, projectedItemCount: 2, sourceGate: 1, hasAggregationMember: 0 };
}
function fixture(): Snapshot {
  return { schemaVersion: 1, capturedAt: new Date(now).toISOString(), clusters: [cluster("L"), cluster("R")], poolIds: ["L", "R"], reservedBlockedClusterIds: [], items: [
    { id: "source-a", originalUrl: "https://news.test/a", canonicalUrl: "https://news.test/a", clusterId: "L", parentItemId: null, isAggregation: 0, status: "processed", moderationStatus: "allowed", sourceAggregationEnabled: 1 },
    { id: "source-b", originalUrl: "https://news.test/b", canonicalUrl: "https://news.test/b", clusterId: "R", parentItemId: null, isAggregation: 0, status: "processed", moderationStatus: "allowed", sourceAggregationEnabled: 1 },
  ] };
}
afterEach(() => { vi.unstubAllGlobals(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("read-only production-shape DTO bridge", () => {
  it("uses persisted summaries/signatures/count projection and the real DTO/compact builders", () => {
    const s = fixture(); const result = buildBridge(s, inventory);
    expect(result.poolSummary.preblockPairs).toBeGreaterThan(0);
    const p = result.modelBatches[0].input as { pairs: { left: Record<string, unknown>; right: Record<string, unknown>; pair_id: string; score: number }[] };
    expect(p.pairs[0].left.summary).toBe(s.clusters[0].summary); expect(p.pairs[0].left.itemCount).toBe(2); expect(p.pairs[0].left.eventDate).toBeNull();
    expect(p.pairs[0].left).not.toHaveProperty("id"); expect(p.pairs[0].left).not.toHaveProperty("sourceEvidence"); expect(p.pairs[0].left).not.toHaveProperty("publishedAt");
    expect(p.pairs[0].pair_id).toBe("p1"); expect(typeof p.pairs[0].score).toBe("number");
    expect(result.sourceCases[0].inheritedGold).toBeNull(); expect(result.sourceCases[0].requiresNewClusterLevelLabel).toBe(true);
    expect(result.scope.finalCandidateAdmissionMeasured).toBe(false); expect(result.scope.requestsSent).toBe(0);
    expect(s.clusters[0].itemCount).toBe(1); // In-memory refresh never mutates the snapshot or DB.
  });
  it("does not manufacture a self-pair when source articles already share a cluster", () => {
    const s = fixture(); s.items[1].clusterId = "L";
    const result = buildBridge(s, inventory); expect(result.sourceCases[0].status).toBe("already_same_cluster"); expect(result.sourceCases[0].candidateEdge).toBeNull();
  });
  it("keeps missing source records missing instead of inventing release rows", () => {
    const s = fixture(); s.items = [];
    expect(buildBridge(s, inventory).sourceCases[0].left.status).toBe("source_not_in_local_db");
  });
  it("does not substitute a child for an unclustered roundup parent", () => {
    const s = fixture(); s.items[0].isAggregation = 1; s.items[0].clusterId = null;
    const r = buildBridge(s, inventory).sourceCases[0]; expect(r.parentSourceNotReplacedByChild).toBe(true); expect(r.left.status).toBe("source_has_no_cluster");
  });
  it("records an existing id with a changed URL as identity drift", () => {
    const s = fixture(); s.items[0].originalUrl = "https://news.test/other"; s.items[0].canonicalUrl = "https://news.test/other";
    expect(buildBridge(s, inventory).sourceCases[0].left.status).toBe("id_url_mismatch");
  });
  it("requires exact unambiguous URL identity when source IDs are external", () => {
    const s = fixture(); const i = structuredClone(inventory); i.cases[0].left.id = "external-release-key";
    expect(buildBridge(s, i).sourceCases[0].left.status).toBe("mapped"); s.items.push({ ...s.items[0], id: "duplicate-url-row" });
    expect(buildBridge(s, i).sourceCases[0].left.status).toBe("ambiguous_identity");
  });
  it("keeps mapped old clusters outside the 7-day scan without shifting eventDate", () => {
    const s = fixture(); s.clusters[0].latestPublishedAt = now - 8 * 86400000; s.poolIds = ["R"];
    expect(buildBridge(s, inventory).sourceCases[0].status).toBe("outside_snapshot_scan_pool");
    expect(candidateOf(s.clusters[0]).eventDate).toBeNull();
  });
  it.each(["status", "date", "source", "count", "duplicate"])("rejects invalid pool %s", (kind) => {
    const s = fixture();
    if (kind === "status") s.clusters[0].status = "merged";
    if (kind === "date") s.clusters[0].latestPublishedAt = now - 8 * 86400000;
    if (kind === "source") s.clusters[0].sourceGate = 0;
    if (kind === "count") s.clusters[0].projectedItemCount = 0;
    if (kind === "duplicate") s.poolIds.push("L");
    expect(() => buildBridge(s, inventory)).toThrow();
  });
  it("does not force clean clusters dirty to manufacture model work", () => {
    const s = fixture(); s.clusters = s.clusters.map((c, i) => ({ ...c, eventFingerprint: null, title: `独立文章${i}`, summary: `互不相关条目${i}`, eventSubject: null, eventObject: null, eventAction: null, eventType: null }));
    for (const c of s.clusters) c.mergeInputHash = buildClusterMergeCandidateInputHash(candidateOf(c));
    const r = buildBridge(s, inventory); expect(r.poolSummary.dirty).toBe(0); expect(r.poolSummary.preblockPairs).toBe(0); expect(r.modelBatches).toEqual([]); expect(r.poolSummary.wouldSkipWithoutPrecomputedCache).toBe(true);
  });
  it("honors reserved-family exclusion without serializing its metadata into model inputs", () => {
    const s = fixture(); s.clusters = s.clusters.filter((c) => c.id !== "L"); s.poolIds = ["R"]; s.reservedBlockedClusterIds = ["L"];
    expect(buildBridge(s, inventory).sourceCases[0].left.status).toBe("reserved_family_in_cluster");
    expect(JSON.stringify(inventoryProof(inventory))).not.toContain("https://news.test/reserved");
    expect(JSON.stringify(inventoryProof(inventory))).not.toContain('"reserved-id"');
  });
  it("uses actual 3-pair sharding and resets refs per batch", () => {
    const s = fixture(); s.clusters = Array.from({ length: 4 }, (_, i) => cluster(`C${i}`)); s.poolIds = s.clusters.map((c) => c.id);
    const r = buildBridge(s, inventory); expect(r.routing.length).toBe(6); expect(r.modelBatches.length).toBe(2);
    expect(r.routing.map((x) => [x.batchIndex, x.pairId])).toEqual([[0,"p1"],[0,"p2"],[0,"p3"],[1,"p1"],[1,"p2"],[1,"p3"]]);
    expect(r.routing.every((x) => x.gold === null && x.requiresClusterLevelReview)).toBe(true);
  });
  it("captures a single read snapshot, recursively excludes reserved descendants and never reads credentials/body columns", () => {
    const sql = buildSnapshotSql(inventory, now);
    expect(sql).toContain("PRAGMA query_only=ON"); expect(sql).toContain("WITH RECURSIVE reservedItems"); expect(sql).toContain("child.parentItemId=parent.id");
    for (const forbidden of ["apiKey", "model_api_configs", "prompt_configs", "fullText", "rssContent", "INSERT", "UPDATE", "DELETE"]) expect(sql).not.toContain(forbidden);
    expect(sql).toContain("latestPublishedAt>="); expect(sql).toContain("LIMIT 2500");
    const malicious = structuredClone(inventory); malicious.cases[0].left.id = "x'; SELECT apiKey;--";
    expect(buildSnapshotSql(malicious, now)).toContain("x''; SELECT apiKey;--");
  });
  it("rejects snapshots that contain forbidden extra gold/credential fields", () => {
    const s = fixture(); expect(() => snapshotSchema.parse({ ...s, apiKey: "not-a-real-key" })).toThrow();
    expect(() => snapshotSchema.parse({ ...s, clusters: [{ ...s.clusters[0], gold: "same_event" }] })).toThrow();
  });
  it("freezes/rebuilds without network or overwrites; rejects drift and forged scope", () => {
    const network = vi.fn(() => { throw new Error("network forbidden"); }); vi.stubGlobal("fetch", network);
    const dir = mkdtempSync(join(tmpdir(), "infinitum-bridge-")); dirs.push(dir); const out = join(dir, "packet");
    const result = prepareBridge(repo, out, () => fixture()); expect(result.requestsSent).toBe(0); expect(network).not.toHaveBeenCalled();
    expect(verifyBridge(repo, out, result.manifestSha256).manifestSha256).toBe(result.manifestSha256);
    expect(() => prepareBridge(repo, out, () => fixture())).toThrow("never overwrite"); expect(() => verifyBridge(repo, out, "0".repeat(64))).toThrow("trust anchor");
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")); manifest.readyForModelReplay = true;
    writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest)); expect(() => verifyBridge(repo, out)).toThrow("trust anchor");
  });
});
