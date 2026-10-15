/** Original-article blind handoff only. No labels, model calls, remote fetches, or business writes. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { buildClusterMergeCandidateInputHash, buildClusterMergeEdgeKey, type ClusterMergeCandidateEdge } from "../src/lib/clusters/helpers";
import { buildSnapshotSql, candidateOf, inventoryProof, snapshotSchema, type Inventory, type Snapshot } from "./prepare-cluster-relation-production-bridge";
import { dateOf, fullInventory, verifyState } from "./prepare-cluster-relation-admission-state";
import { digest } from "./prepare-cluster-relation-source-replay";

export const ADMISSION_PACKET = "docs/eval/reviews/cluster-relation-admission-state-2026-10-14/packet";
export const ADMISSION_SHA = "04215bfd953cd798ca8e968a199091c91638077a353c10b29d9921e869915f71";
const SEED = "production-blind-v1-2026-10-14";
const TARGET = 6;
const MIN_TEXT = 350;
const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
const readJson = (p: string): unknown => JSON.parse(readFileSync(p, "utf8"));
const nullable = z.string().nullable(); const bit = z.union([z.literal(0), z.literal(1)]);
export const articleSchema = z.object({ id: z.string(), clusterId: z.string(), originalUrl: z.string(), canonicalUrl: z.string(), originalTitle: z.string(), publishedAt: z.union([z.string(), z.number()]), publishedAtKnown: bit,
  parentItemId: nullable, isAggregation: bit, status: z.string(), moderationStatus: z.string(), fullText: nullable, rssContent: nullable }).strict();
export type Article = z.infer<typeof articleSchema>;
export type Capture = { snapshot: Snapshot; articles: Article[] };
export type Frame = { snapshot: Snapshot; edges: ClusterMergeCandidateEdge[]; members: { id: string; clusterId: string }[] };
export function exclusionInventory(repo: string): Inventory {
  const i = fullInventory(repo); const all = [...i.reserved, ...i.cases.flatMap((c) => [c.left, c.right])];
  return { cases: i.cases, reserved: [...new Map(all.map((r) => [r.id, r])).values()] };
}
export function loadFrame(repo: string): Frame {
  const root = resolve(repo, ADMISSION_PACKET);
  const stages = readJson(resolve(root, "stages.json")) as { filteredEdges: ClusterMergeCandidateEdge[] };
  const state = readJson(resolve(root, "state.json")) as { members: Frame["members"] };
  return { snapshot: snapshotSchema.parse(readJson(resolve(root, "snapshot.json"))), edges: stages.filteredEdges.map((e) => ({ leftId: e.leftId, rightId: e.rightId, score: 0 })), members: state.members.map((r) => ({ id: r.id, clusterId: r.clusterId })) };
}
export function captureSql(inventory: Inventory, frame: Frame, nowMs: number) {
  const base = buildSnapshotSql(inventory, nowMs); const at = base.indexOf("\nSELECT json_object('schemaVersion'");
  if (at < 0) throw new Error("Base SQL drift");
  const ctes = base.slice(base.indexOf("WITH RECURSIVE"), at);
  const ids = [...new Set(frame.edges.flatMap((e) => [e.leftId, e.rightId]))];
  const quoted = ids.map((id) => "'" + id.replace(/'/g, "''") + "'").join(",") || "NULL";
  // No source content is hydrated for excluded families or clusters containing aggregation/AI split children.
  return "PRAGMA query_only=ON;\nBEGIN;\n" + base + `${ctes}
SELECT COALESCE(json_group_array(json_object('id',i.id,'clusterId',i.clusterId,'originalUrl',i.originalUrl,'canonicalUrl',i.canonicalUrl,'originalTitle',i.originalTitle,'publishedAt',i.publishedAt,'publishedAtKnown',i.publishedAtKnown,'parentItemId',i.parentItemId,'isAggregation',i.isAggregation,'status',i.status,'moderationStatus',i.moderationStatus,'fullText',i.fullText,'rssContent',i.rssContent)), '[]')
FROM items i WHERE i.clusterId IN (${quoted}) AND i.clusterId IN (SELECT id FROM pool) AND i.status='processed' AND i.moderationStatus IN ('allowed','restored')
AND NOT EXISTS(SELECT 1 FROM items x WHERE x.clusterId=i.clusterId AND x.status='processed' AND x.moderationStatus IN ('allowed','restored') AND (x.isAggregation=1 OR x.parentItemId IS NOT NULL));
COMMIT;\n`;
}
export function captureOriginals(inventory: Inventory, frame: Frame, nowMs = Date.now()): Capture {
  const run = (args: string[]) => execFileSync("docker", ["--context", "desktop-linux", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
  if (!run(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}", "desktop-linux"]).trim().startsWith("unix://")) throw new Error("Nonlocal Docker forbidden");
  const rows = run(["exec", "infinitum", "sqlite3", "-readonly", "/app/data/dev.db", captureSql(inventory, frame, nowMs)]).trim().split("\n");
  if (rows.length !== 2) throw new Error("Capture coverage mismatch");
  return { snapshot: snapshotSchema.parse(JSON.parse(rows[0])), articles: z.array(articleSchema).parse(JSON.parse(rows[1])) };
}
export function plainArticle(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|noscript|svg|canvas|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?\s*>/gi, "\n").replace(/<\/(?:p|div|section|article|h[1-6]|li|pre|blockquote)\s*>/gi, "\n\n").replace(/<[^>]*>/g, "")
    .replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (original, entity: string) => {
      const e = entity.toLowerCase(); const named: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
      if (e in named) return named[e]; const n = e.startsWith("#x") ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n >= 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : original;
    }).replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
export function sourceText(a: Article) {
  for (const [field, raw] of [["fullText", a.fullText], ["rssContent", a.rssContent]] as const) {
    if (!raw) continue; const text = plainArticle(raw);
    if (text.length >= MIN_TEXT) return { field, text, rawSha256: digest(raw), characterCount: text.length, completeness: "retained_only_not_verified_against_live_source" as const };
  }
  return null;
}
export function urlFamily(raw: string): string {
  const u = new URL(raw); if (!["http:", "https:"].includes(u.protocol)) throw new Error("Non-HTTP original URL");
  u.hash = ""; u.protocol = "https:";
  for (const k of [...u.searchParams.keys()]) if (/^utm_/i.test(k) || ["fbclid", "gclid"].includes(k)) u.searchParams.delete(k);
  u.searchParams.sort(); return u.toString();
}
export function familyKeys(a: Article): string[] { return [`item:${a.id}`, `url:${urlFamily(a.originalUrl)}`, `url:${urlFamily(a.canonicalUrl)}`]; }
export function chooseBlind(capture: Capture, frame: Frame, inventory: Inventory) {
  const snapshot = snapshotSchema.parse(capture.snapshot); const articles = z.array(articleSchema).parse(capture.articles);
  const oldRows = new Map(frame.snapshot.clusters.map((r) => [r.id, r])); const rows = new Map(snapshot.clusters.map((r) => [r.id, r])); const pool = new Set(snapshot.poolIds);
  if (rows.size !== snapshot.clusters.length || new Set(articles.map((a) => a.id)).size !== articles.length || articles.some((a) => !pool.has(a.clusterId))) throw new Error("Capture identity mismatch");
  const banned = new Set(inventory.reserved.flatMap((r) => [`item:${r.id}`, `url:${urlFamily(r.url)}`]));
  const allByCluster = new Map<string, Article[]>(); for (const a of articles) { const list = allByCluster.get(a.clusterId) ?? []; list.push(a); allByCluster.set(a.clusterId, list); }
  const reasons: Record<string, number> = {}; const reject = (why: string) => { reasons[why] = (reasons[why] ?? 0) + 1; return null; };
  const side = (id: string) => {
    const current = rows.get(id), previous = oldRows.get(id); if (!current || !previous || !pool.has(id)) return reject("out_of_pool_or_excluded");
    if (buildClusterMergeCandidateInputHash(candidateOf(current)) !== buildClusterMergeCandidateInputHash(candidateOf(previous))) return reject("cluster_input_changed");
    const source = [...(allByCluster.get(id) ?? [])].sort((a, b) => a.id.localeCompare(b.id));
    const oldIds = frame.members.filter((m) => m.clusterId === id).map((m) => m.id).sort();
    if (!source.length || source.length !== current.projectedItemCount || JSON.stringify(source.map((a) => a.id).sort()) !== JSON.stringify(oldIds)) return reject("membership_changed_or_aggregation_child");
    if (source.some((a) => a.parentItemId !== null || a.isAggregation || a.status !== "processed" || !["allowed", "restored"].includes(a.moderationStatus))) return reject("non_original_or_unapproved_member");
    if (source.some((a) => familyKeys(a).some((f) => banned.has(f)))) return reject("old_source_family");
    if (source.some((a) => !sourceText(a))) return reject("insufficient_retained_text");
    return source;
  };
  const options = frame.edges.flatMap((edge) => {
    if (edge.leftId === edge.rightId) return [];
    const left = side(edge.leftId), right = side(edge.rightId); if (!left || !right) return [];
    const lf = new Set(left.flatMap(familyKeys)); const rf = new Set(right.flatMap(familyKeys));
    if ([...lf].some((f) => rf.has(f))) { reject("same_family_across_sides"); return []; }
    const dates = (a: Article[]) => a.every((x) => x.publishedAtKnown) ? Math.min(...a.map((x) => dateOf(x.publishedAt).getTime())) : null;
    const l = dates(left), r = dates(right); const gapHours = l === null || r === null ? null : Math.abs(l - r) / 3600000;
    const stratum = gapHours !== null && gapHours >= 12 ? "time_separated" : "near_or_unknown_time";
    const pairKey = buildClusterMergeEdgeKey(edge.leftId, edge.rightId); return [{ edge, left, right, families: [...new Set([...lf, ...rf])], gapHours, stratum, rank: digest(`${SEED}\0${pairKey}`) }];
  }).sort((a, b) => a.rank.localeCompare(b.rank));
  const picked: typeof options = []; const usedClusters = new Set<string>(), usedFamilies = new Set<string>();
  const take = (option: typeof options[number]) => {
    if (usedClusters.has(option.edge.leftId) || usedClusters.has(option.edge.rightId) || option.families.some((f) => usedFamilies.has(f))) return false;
    picked.push(option); usedClusters.add(option.edge.leftId); usedClusters.add(option.edge.rightId); for (const f of option.families) usedFamilies.add(f); return true;
  };
  for (let round = 0; round < 3; round++) for (const stratum of ["time_separated", "near_or_unknown_time"]) { const next = options.find((o) => o.stratum === stratum && !picked.includes(o) && !usedClusters.has(o.edge.leftId) && !usedClusters.has(o.edge.rightId) && !o.families.some((f) => usedFamilies.has(f))); if (next) take(next); }
  for (const option of options) if (picked.length < TARGET && !picked.includes(option)) take(option);
  // Greedy choice can exhaust a hub despite a larger disjoint matching. Search fixed-size subsets;
  // prefer a 3/3 temporal balance, never relax source-family constraints to fill the batch.
  if (picked.length < TARGET) {
    const allKeys = [...new Set(options.flatMap((o) => [`cluster:${o.edge.leftId}`, `cluster:${o.edge.rightId}`, ...o.families]))];
    const bits = new Map(allKeys.map((k, i) => [k, BigInt(1) << BigInt(i)]));
    const masks = options.map((o) => [`cluster:${o.edge.leftId}`, `cluster:${o.edge.rightId}`, ...o.families].reduce((m, k) => m | bits.get(k)!, BigInt(0)));
    const search = (start: number, mask: bigint, chosen: typeof options, separated: number, targetSeparated: number): typeof options | null => {
      const remaining = TARGET - chosen.length;
      if (remaining === 0) return separated === targetSeparated ? chosen : null;
      if (separated > targetSeparated || separated + remaining < targetSeparated) return null;
      const available = options.map((o, i) => ({ o, i })).filter(({ i }) => i >= start && !(mask & masks[i]));
      if (available.length < remaining || new Set(available.flatMap(({ o }) => [o.edge.leftId, o.edge.rightId])).size < remaining * 2) return null;
      const possibleSeparated = available.filter(({ o }) => o.stratum === "time_separated").length;
      if (separated + possibleSeparated < targetSeparated || available.length - possibleSeparated < remaining - (targetSeparated - separated)) return null;
      for (const { o, i } of available) { const result = search(i + 1, mask | masks[i], [...chosen, o], separated + Number(o.stratum === "time_separated"), targetSeparated); if (result) return result; }
      return null;
    };
    for (const balance of [3, 2, 4, 1, 5, 0, 6]) {
      const solution = search(0, BigInt(0), [], 0, balance); if (!solution) continue;
      picked.length = 0; usedClusters.clear(); usedFamilies.clear(); for (const option of solution) take(option); break;
    }
  }
  if (picked.length !== TARGET) throw new Error(`Insufficient disjoint original pairs: ${picked.length}/${TARGET}; eligibleOptions=${options.length}, clusters=${new Set(options.flatMap((o) => [o.edge.leftId, o.edge.rightId])).size}, rejectedSides=${JSON.stringify(reasons)}`);
  const blindArticle = (a: Article) => ({ title: a.originalTitle, url: a.originalUrl, publishedAt: a.publishedAtKnown ? dateOf(a.publishedAt).toISOString() : null, evidence: sourceText(a)! });
  const blind = picked.map((o, i) => { const flip = parseInt(o.rank.slice(0, 2), 16) % 2 === 1; return { caseId: `PB-${String(i + 1).padStart(2, "0")}`, left: (flip ? o.right : o.left).map(blindArticle), right: (flip ? o.left : o.right).map(blindArticle) }; });
  const audit = picked.map((o, i) => ({ caseId: blind[i].caseId, leftClusterId: parseInt(o.rank.slice(0, 2), 16) % 2 ? o.edge.rightId : o.edge.leftId,
    rightClusterId: parseInt(o.rank.slice(0, 2), 16) % 2 ? o.edge.leftId : o.edge.rightId, familyHashes: o.families.map(digest), rank: o.rank, stratum: o.stratum, gapHours: o.gapHours, gold: null }));
  return { blind, audit, report: { capturedAt: snapshot.capturedAt, candidateFrameSha256: ADMISSION_SHA, candidateFramePairs: frame.edges.length, sourceEligibleOptions: options.length, pairs: blind.length, uniqueClusters: usedClusters.size, articleCount: picked.reduce((n, o) => n + o.left.length + o.right.length, 0), excludedOldSourceIdentities: inventory.reserved.length,
    rejectedSideReasons: reasons, strata: { timeSeparated: picked.filter((o) => o.stratum === "time_separated").length, nearOrUnknown: picked.filter((o) => o.stratum !== "time_separated").length },
    independentLabelsReceived: 0, independentlyConfirmedFollowUp: 0, labelState: "awaiting_human_blind_labels", requestsSent: 0, credentialsRead: false, businessWrites: 0,
    sourceFamilyDisjointByKnownIdentityAndUrl: true, semanticTopicDisjointnessVerified: false, fullTextCompletenessVerified: false, liveFinalAdmissionRevalidated: false, qualityPassed: false, releaseEligible: false } };
}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export function renderBlind(cases: ReturnType<typeof chooseBlind>["blind"]) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>关系盲标</title><style>body{font:16px/1.65 system-ui;max-width:1100px;margin:32px auto;padding:0 20px}section{border-top:1px solid #ddd;margin-top:36px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:28px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}small{color:#666}@media(max-width:700px){.pair{grid-template-columns:1fr}}</style><h1>关系盲标</h1><p>每对只选一个：same_event（同一事件）；follow_up（同事件链中的新进展）；synthesis（综合多个事件）；unrelated（不同事件）；uncertain（证据不足）。判整个簇的全部文章，不因共享品牌就判同一事件。保留正文不等于已验证源站全文；不足时选 uncertain。请在空白 CSV 写 relation、evidence 与 labeler。</p>` + cases.map((c) => `<section><h2>${esc(c.caseId)}</h2><div class="pair">` + [c.left, c.right].map((side, i) => `<div><h3>${i === 0 ? "A" : "B"}（${side.length}篇）</h3>` + side.map((a) => `<article><h4>${esc(a.title)}</h4><small>${esc(a.publishedAt ?? "时间未知")} · ${esc(a.url)} · ${esc(a.evidence.field)}保留正文</small><pre>${esc(a.evidence.text)}</pre></article>`).join("") + "</div>").join("") + "</div></section>").join("") + "</html>\n";
}
const REF = ["scripts/prepare-cluster-relation-production-blind-pack.ts", "scripts/prepare-cluster-relation-admission-state.ts", "scripts/prepare-cluster-relation-production-bridge.ts", "src/lib/clusters/helpers.ts", "src/lib/clusters/normalization.ts"];
export async function prepareBlind(repo: string, out: string, capture = captureOriginals) {
  if (existsSync(out)) throw new Error("Frozen output exists; never overwrite");
  await verifyState(repo, resolve(repo, ADMISSION_PACKET), ADMISSION_SHA);
  const inventory = exclusionInventory(repo), frame = loadFrame(repo); const captured = capture(inventory, frame); const result = chooseBlind(captured, frame, inventory);
  const labels = "case_id,relation,evidence,labeler\n" + result.blind.map((c) => `${c.caseId},,,\n`).join("");
  const artifacts = { "capture.json": json(captured), "inventory.json": json(inventoryProof(inventory)), "blind-cases.json": json(result.blind), "blind.html": renderBlind(result.blind), "labels.blank.csv": labels,
    "audit.json": json(result.audit), "report.json": json(result.report) };
  const manifest = { schemaVersion: 1, frameSha256: ADMISSION_SHA, fileHashes: Object.fromEntries(Object.entries(artifacts).map(([n, b]) => [n, digest(b)])), codeHashes: Object.fromEntries(REF.map((p) => [p, digest(readFileSync(resolve(repo, p)))])),
    labelState: "awaiting_human_blind_labels", requestsSent: 0, credentialsRead: false, businessWrites: 0, sendAllowed: false, qualityPassed: false, releaseEligible: false };
  mkdirSync(dirname(out), { recursive: true }); mkdirSync(out);
  for (const [n, b] of Object.entries(artifacts)) writeFileSync(resolve(out, n), b, { flag: "wx" });
  writeFileSync(resolve(out, "manifest.json"), json(manifest), { flag: "wx" }); const anchor = digest(json(manifest)); writeFileSync(resolve(out, "manifest.sha256"), anchor + "\n", { flag: "wx" });
  await verifyBlind(repo, out, anchor); return { ...result.report, manifestSha256: anchor };
}
export async function verifyBlind(repo: string, dir: string, expectedSha?: string) {
  const anchor = readFileSync(resolve(dir, "manifest.sha256"), "utf8").trim(); const bytes = readFileSync(resolve(dir, "manifest.json"));
  if (!/^[a-f0-9]{64}$/.test(anchor) || digest(bytes) !== anchor || (expectedSha && expectedSha !== anchor)) throw new Error("Manifest trust anchor mismatch");
  const m = JSON.parse(bytes.toString()); const names = ["capture.json", "inventory.json", "blind-cases.json", "blind.html", "labels.blank.csv", "audit.json", "report.json"];
  if (m.frameSha256 !== ADMISSION_SHA || m.labelState !== "awaiting_human_blind_labels" || m.requestsSent !== 0 || m.credentialsRead !== false || m.businessWrites !== 0 || m.sendAllowed !== false || m.qualityPassed !== false || m.releaseEligible !== false || json(Object.keys(m.fileHashes)) !== json(names) || json(Object.keys(m.codeHashes)) !== json(REF)) throw new Error("Scope or coverage mismatch");
  for (const n of names) if (digest(readFileSync(resolve(dir, n))) !== m.fileHashes[n]) throw new Error("Frozen file drift");
  for (const p of REF) if (digest(readFileSync(resolve(repo, p))) !== m.codeHashes[p]) throw new Error("Code reference drift");
  await verifyState(repo, resolve(repo, ADMISSION_PACKET), ADMISSION_SHA);
  const inventory = exclusionInventory(repo); if (json(readJson(resolve(dir, "inventory.json"))) !== json(inventoryProof(inventory))) throw new Error("Inventory drift");
  const result = chooseBlind(readJson(resolve(dir, "capture.json")) as Capture, loadFrame(repo), inventory);
  const labels = "case_id,relation,evidence,labeler\n" + result.blind.map((c) => `${c.caseId},,,\n`).join("");
  for (const [n, value] of Object.entries({ "blind-cases.json": json(result.blind), "blind.html": renderBlind(result.blind), "labels.blank.csv": labels, "audit.json": json(result.audit), "report.json": json(result.report) })) if (readFileSync(resolve(dir, n), "utf8") !== value) throw new Error("Blind handoff reconstruction mismatch");
  return { ...result.report, manifestSha256: anchor };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , action, dir, sha, ...extra] = process.argv;
  if (!dir || extra.length || !["--out", "--verify"].includes(action) || (action === "--out" && sha)) throw new Error("Usage: --out NEW_DIR | --verify DIR [TRUSTED_SHA]; no send/label mode");
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  void (async () => { try { console.log(JSON.stringify(action === "--out" ? await prepareBlind(repo, resolve(dir)) : await verifyBlind(repo, resolve(dir), sha))); }
    catch (e) { console.error(e instanceof Error && /^Insufficient disjoint/.test(e.message) ? e.message : "Blind preparation stopped; data/SQL details suppressed; no model request or business write."); process.exitCode = 1; } })();
}
