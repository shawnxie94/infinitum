import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { articleSchema, captureSql, chooseBlind, exclusionInventory, familyKeys, loadFrame, plainArticle, prepareBlind, renderBlind, sourceText, urlFamily, verifyBlind, type Article, type Capture, type Frame } from "../../scripts/prepare-cluster-relation-production-blind-pack";
import { digest } from "../../scripts/prepare-cluster-relation-source-replay";
import { buildClusterMergeEdgeKey } from "../../src/lib/clusters/helpers";
import type { Inventory, Snapshot } from "../../scripts/prepare-cluster-relation-production-bridge";
import { createHistoricalEvaluationRepo } from "../helpers/historical-evaluation-repo";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../.."); const now = Date.parse("2026-10-14T14:00:00Z"); const dirs: string[] = [];
const inventory: Inventory = { cases: [], reserved: [{ id: "old-id", url: "https://news.test/old" }] };
function fixtures() {
  const clusters: Snapshot["clusters"] = Array.from({ length: 12 }, (_, i) => ({ id: `C${i}`, title: "隐藏AI标题", summary: "隐藏AI摘要", fingerprint: `fp${i}`, mergeInputHash: null, eventFingerprint: null, eventType: null, eventSubject: null, eventAction: null, eventObject: null, eventDate: null, itemCount: 1, latestPublishedAt: now, updatedAt: now, status: "active", projectedItemCount: 1, sourceGate: 1, hasAggregationMember: 0 }));
  const snapshot: Snapshot = { schemaVersion: 1, capturedAt: new Date(now).toISOString(), clusters, poolIds: clusters.map((c) => c.id), items: [], reservedBlockedClusterIds: [] };
  const articles: Article[] = clusters.map((c, i) => ({ id: `I${i}`, clusterId: c.id, originalUrl: `https://news.test/${i}`, canonicalUrl: `https://news.test/${i}`, originalTitle: `原始文章${i}`, publishedAt: now - ((i % 2 === 1 && i < 6) ? 86400000 : 0), publishedAtKnown: 1, parentItemId: null, isAggregation: 0, status: "processed", moderationStatus: "allowed", fullText: "原始保留事实段落，不使用模型摘要。".repeat(30), rssContent: null }));
  const frame: Frame = { snapshot: structuredClone(snapshot), edges: Array.from({ length: 6 }, (_, i) => ({ leftId: `C${i * 2}`, rightId: `C${i * 2 + 1}`, score: 9999 })), members: articles.map((a) => ({ id: a.id, clusterId: a.clusterId })) };
  return { capture: { snapshot, articles } as Capture, frame };
}
afterEach(() => { vi.unstubAllGlobals(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("original-article blind packet", () => {
  it("selects six pairs/12 unique clusters, balances dates and leaves all gold blank", () => {
    const { capture, frame } = fixtures(); const r = chooseBlind(capture, frame, inventory);
    expect(r.report.pairs).toBe(6); expect(r.report.uniqueClusters).toBe(12); expect(r.report.strata).toEqual({ timeSeparated: 3, nearOrUnknown: 3 });
    expect(r.audit.every((a) => a.gold === null)).toBe(true); expect(r.report.independentLabelsReceived).toBe(0); expect(r.report.independentlyConfirmedFollowUp).toBe(0);
    expect(r.blind.flatMap((p) => [...p.left, ...p.right]).every((a) => a.title.startsWith("原始文章"))).toBe(true);
  });
  it("ignores score/order and does not infer or import predicted relations", () => {
    const { capture, frame } = fixtures(); const first = chooseBlind(capture, frame, inventory);
    frame.edges.reverse(); frame.edges.forEach((e) => e.score = -999999);
    expect(chooseBlind(capture, frame, inventory).blind).toEqual(first.blind);
    const html = renderBlind(first.blind); expect(html).not.toContain("隐藏AI"); expect(html).not.toContain("time_separated"); expect(html).not.toContain("fingerprint");
    expect(first.blind[0]).not.toHaveProperty("gold"); expect(first.blind[0]).not.toHaveProperty("stratum");
  });
  it.each(["summary", "membership", "parent", "aggregation", "short", "excluded"])("does not force a pair through %s eligibility failure", (kind) => {
    const { capture, frame } = fixtures();
    if (kind === "summary") capture.snapshot.clusters[0].summary = "changed";
    if (kind === "membership") frame.members[0].id = "other-id";
    if (kind === "parent") capture.articles[0].parentItemId = "root";
    if (kind === "aggregation") capture.articles[0].isAggregation = 1;
    if (kind === "short") capture.articles[0].fullText = "只有摘要";
    if (kind === "excluded") capture.articles[0].canonicalUrl = inventory.reserved[0].url;
    expect(() => chooseBlind(capture, frame, inventory)).toThrow("Insufficient disjoint");
  });
  it("backtracks instead of relaxing family isolation when greedy selection exhausts a hub", () => {
    const { capture, frame } = fixtures(); capture.articles.forEach((a) => a.publishedAt = now);
    const rank = (a: string, b: string) => digest(`production-blind-v1-2026-10-14\\0${buildClusterMergeEdgeKey(a, b)}`);
    const cross = frame.edges.flatMap((a, i) => frame.edges.slice(i + 1).flatMap((b) => [a.leftId, a.rightId].flatMap((x) => [b.leftId, b.rightId].map((y) => ({ leftId: x, rightId: y, score: 0 }))))).sort((a, b) => rank(a.leftId, a.rightId).localeCompare(rank(b.leftId, b.rightId)));
    const trap = cross.find((c) => frame.edges.every((e) => rank(c.leftId, c.rightId) < rank(e.leftId, e.rightId)));
    expect(trap).toBeDefined(); frame.edges.push(trap!);
    const r = chooseBlind(capture, frame, inventory); expect(r.report.pairs).toBe(6); expect(r.report.uniqueClusters).toBe(12); expect(r.report.strata.timeSeparated).toBe(0);
  });
  it("rejects cross-side and cross-pair shared source families even with different item IDs", () => {
    const { capture, frame } = fixtures(); capture.articles[1].canonicalUrl = capture.articles[0].canonicalUrl;
    expect(() => chooseBlind(capture, frame, inventory)).toThrow("Insufficient disjoint");
    const f = fixtures(); f.capture.articles[2].canonicalUrl = f.capture.articles[0].canonicalUrl; expect(() => chooseBlind(f.capture, f.frame, inventory)).toThrow("Insufficient disjoint");
  });
  it("retains all cluster members and does not present selected singletons as the whole cluster", () => {
    const { capture, frame } = fixtures(); const a = { ...capture.articles[0], id: "I-extra", originalUrl: "https://news.test/extra", canonicalUrl: "https://news.test/extra" };
    capture.articles.push(a); frame.members.push({ id: a.id, clusterId: a.clusterId }); capture.snapshot.clusters[0].itemCount = capture.snapshot.clusters[0].projectedItemCount = 2; frame.snapshot.clusters[0].itemCount = frame.snapshot.clusters[0].projectedItemCount = 2;
    expect(chooseBlind(capture, frame, inventory).report.articleCount).toBe(13);
  });
  it("does not turn unknown publication times into fact or fabricate source bodies", () => {
    const { capture, frame } = fixtures(); capture.articles[0].publishedAtKnown = 0;
    const r = chooseBlind(capture, frame, inventory); expect(r.blind.flatMap((p) => [...p.left, ...p.right]).find((a) => a.title === "原始文章0")!.publishedAt).toBeNull();
    expect(sourceText({ ...capture.articles[0], fullText: null, rssContent: null })).toBeNull();
  });
  it("uses untruncated retained fullText or RSS, never an AI summary/excerpt", () => {
    const a = fixtures().capture.articles[0]; const long = "原文".repeat(20000); expect(sourceText({ ...a, fullText: long })!.text.length).toBe(40000);
    expect(sourceText({ ...a, fullText: "短", rssContent: `<p>${long}</p>` })!.field).toBe("rssContent");
    expect(articleSchema.safeParse({ ...a, summaryText: "leak" }).success).toBe(false);
  });
  it("strips script/noise markup, handles numeric entities safely and escapes every rendered field", () => {
    expect(plainArticle("<script>alert('x')</script><p>A &amp; B</p><p>C&#x4e2d;&#999999999;</p>")).toBe("A & B\n\nC中&#999999999;");
    const { capture, frame } = fixtures(); capture.articles[0].originalTitle = '<img src="https://remote.test/a" onerror="fetch(1)">'; capture.articles[0].fullText = "<p>" + "&lt;script&gt;alert(1)&lt;/script&gt;".repeat(30) + "</p>";
    const html = renderBlind(chooseBlind(capture, frame, inventory).blind); expect(html).not.toContain("<img"); expect(html).not.toContain("<script>"); expect(html).toContain("default-src 'none'"); expect(html).not.toContain("<a ");
  });
  it("normalizes tracking URLs conservatively for family identity and rejects non-HTTP links", () => {
    expect(urlFamily("http://news.test/a?utm_source=feed&v=2#x")).toBe("https://news.test/a?v=2");
    expect(() => urlFamily("javascript:alert(1)")).toThrow("Non-HTTP"); expect(familyKeys(fixtures().capture.articles[0])).toHaveLength(3);
  });
  it("excludes all twenty old identities, not just holdout/pending", () => {
    expect(exclusionInventory(repo).reserved).toHaveLength(20);
    const { frame } = fixtures(); const sql = captureSql(inventory, frame, now);
    for (const forbidden of ["summaryText", "translatedTitle", "rssExcerpt", "reasonText", "apiKey", "model_api_configs", "cluster_decisions"]) expect(sql).not.toContain(forbidden);
    expect(sql).toContain("x.parentItemId IS NOT NULL"); expect(sql).toContain("PRAGMA query_only=ON"); expect(sql).toContain("BEGIN;"); expect(sql).toContain("COMMIT;");
  });
  it("freezes empty label template and handoff; rejects overwrite, label-template mutation and SHA drift", async () => {
    const fetch = vi.fn(() => { throw new Error("no network"); }); vi.stubGlobal("fetch", fetch);
    // Metadata identities only; bodies are explicitly synthetic unit fixtures, not source evidence.
    const frame = loadFrame(repo);
    const capture: Capture = { snapshot: frame.snapshot, articles: frame.members.map((m) => ({ id: m.id, clusterId: m.clusterId, originalUrl: `https://fixture.test/${m.id}`, canonicalUrl: `https://fixture.test/${m.id}`, originalTitle: "测试原文", publishedAt: now, publishedAtKnown: 1, parentItemId: null, isAggregation: 0, status: "processed", moderationStatus: "allowed", fullText: "单测合成事实，不是实际原文。".repeat(40), rssContent: null })) };
    const dir = mkdtempSync(join(tmpdir(), "infinitum-blind-")); dirs.push(dir); const out = join(dir, "packet");
    const historicalRepo = createHistoricalEvaluationRepo(repo, dir);
    const result = await prepareBlind(historicalRepo, out, () => capture); expect(fetch).not.toHaveBeenCalled();
    expect((await verifyBlind(historicalRepo, out, result.manifestSha256)).manifestSha256).toBe(result.manifestSha256);
    expect(readFileSync(join(out, "labels.blank.csv"), "utf8")).toMatch(/PB-01,,,/);
    await expect(prepareBlind(historicalRepo, out, () => capture)).rejects.toThrow("never overwrite");
    await expect(verifyBlind(historicalRepo, out, "0".repeat(64))).rejects.toThrow("trust anchor");
    writeFileSync(join(out, "labels.blank.csv"), "case_id,relation,evidence,labeler\\nPB-01,same_event,not-independent,fixture\\n");
    await expect(verifyBlind(historicalRepo, out)).rejects.toThrow("Frozen file drift");
  }, 20000);
});
