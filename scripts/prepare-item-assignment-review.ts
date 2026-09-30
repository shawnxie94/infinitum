import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
// node:sqlite is available in the runtime but is not declared by @types/node@20.
// @ts-expect-error node:sqlite has no type declarations in @types/node@20
import { DatabaseSync } from "node:sqlite";

import { CLUSTER_LOOKBACK_MS } from "../src/config/constants";
import {
  buildItemSummary,
  type ItemWithSource,
} from "../src/lib/clusters/helpers";
import {
  buildClusterMergeBm25Index,
  scoreClusterMergeBm25Documents,
  type Bm25ClusterDocument,
} from "../src/lib/clusters/bm25";
import type { ClusterAssignmentCandidate } from "../src/lib/clusters/repository";

const DEFAULT_MAP = ".agent/tmp/item-assignment-bm25/review-map.json";
const CSV_HEADERS = [
  "reviewId",
  "itemGroupId",
  "itemTitle",
  "itemSummary",
  "itemPublishedAt",
  "itemEventType",
  "itemEventSubject",
  "itemEventAction",
  "itemEventObject",
  "itemEventDate",
  "candidateEvidence",
  "humanLabel",
  "reviewNotes",
];

type Args = {
  db: string;
  out: string;
  manifest: string;
  map: string;
  seed: number;
  items: number;
  verify: boolean;
};

type ItemRow = {
  id: string;
  clusterId: string | null;
  originalTitle: string;
  translatedTitle: string | null;
  summaryText: string | null;
  rssExcerpt: string | null;
  rssContent: string | null;
  fullText: string | null;
  publishedAt: number;
  publishedAtKnown: number;
  createdAt: number;
  qualityScore: number;
  eventType: string | null;
  eventSubject: string | null;
  eventAction: string | null;
  eventObject: string | null;
  eventDate: string | null;
  sourceName: string;
  itemCount: number;
};

type ClusterRow = {
  id: string;
  title: string;
  summary: string;
  fingerprint: string;
  eventFingerprint: string | null;
  eventBucket: string | null;
  eventType: string | null;
  eventSubject: string | null;
  eventAction: string | null;
  eventObject: string | null;
  eventDate: string | null;
  latestPublishedAt: number;
  createdAt: number;
  itemCount: number;
};

type ReviewRow = Record<(typeof CSV_HEADERS)[number], string>;

type InternalMapEntry = {
  reviewId: string;
  itemId: string;
  candidateClusterId: string;
  selectedBy: string[];
  itemGroupId: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    db: "",
    out: "docs/eval/item-assignment-bm25-review-2026-09-26.csv",
    manifest: "docs/eval/item-assignment-bm25-review-2026-09-26.manifest.json",
    map: DEFAULT_MAP,
    seed: 260926,
    items: 40,
    verify: false,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--db") args.db = argv[++index] ?? "";
    else if (arg === "--out") args.out = argv[++index] ?? "";
    else if (arg === "--manifest") args.manifest = argv[++index] ?? "";
    else if (arg === "--map") args.map = argv[++index] ?? "";
    else if (arg === "--seed") args.seed = Number(argv[++index] ?? "260926");
    else if (arg === "--items") args.items = Number(argv[++index] ?? "40");
    else if (arg === "--verify") args.verify = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.db) throw new Error("missing read-only DB snapshot: pass --db <path>");
  if (!Number.isSafeInteger(args.seed) || args.seed < 0) throw new Error("--seed must be a non-negative safe integer");
  if (!Number.isSafeInteger(args.items) || args.items < 1) throw new Error("--items must be a positive safe integer");
  return args;
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function csvCell(value: string | number | null | undefined): string {
  const normalized = String(value ?? "").replace(/\s+/gu, " ").trim();
  return `"${normalized.replaceAll('"', '""')}"`;
}

function csvText(rows: ReviewRow[]): string {
  return [
    CSV_HEADERS.join(","),
    ...rows.map((row) => CSV_HEADERS.map((key) => csvCell(row[key])).join(",")),
    "",
  ].join("\n");
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === '"' && quoted && line[index + 1] === '"') {
      value += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      values.push(value);
      value = "";
    } else {
      value += char;
    }
  }
  values.push(value);
  return values;
}

function verifyPacket(args: Args) {
  const manifest = JSON.parse(readFileSync(args.manifest, "utf8")) as {
    schemaVersion: number;
    sourceSnapshotSha256: string;
    reviewRows: number;
    itemGroups: number;
    csvSha256: string;
  };
  const csv = readFileSync(args.out, "utf8");
  const lines = csv.trimEnd().split(/\r?\n/u);
  const headers = parseCsvLine(lines[0] ?? "");
  if (headers.join("|") !== CSV_HEADERS.join("|")) throw new Error("review CSV headers do not match contract");
  if (lines.length - 1 !== manifest.reviewRows) throw new Error("review row count does not match manifest");
  const labelIndex = headers.indexOf("humanLabel");
  const noteIndex = headers.indexOf("reviewNotes");
  const groupIndex = headers.indexOf("itemGroupId");
  const groups = new Set<string>();
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    if (cells[labelIndex] !== "" || cells[noteIndex] !== "") throw new Error("new review packet must have blank humanLabel and reviewNotes");
    if (!cells[groupIndex]) throw new Error("review row is missing itemGroupId");
    groups.add(cells[groupIndex]!);
  }
  if (groups.size !== manifest.itemGroups) throw new Error("item group count does not match manifest");
  if (manifest.schemaVersion !== 1) throw new Error("unsupported manifest schema version");
  if (sha256(args.db) !== manifest.sourceSnapshotSha256) throw new Error("source snapshot SHA-256 does not match manifest");
  if (sha256(args.out) !== manifest.csvSha256) throw new Error("review CSV SHA-256 does not match manifest");
  const map = JSON.parse(readFileSync(args.map, "utf8")) as InternalMapEntry[];
  const reviewIds = new Set(lines.slice(1).map((line) => parseCsvLine(line)[0]));
  if (map.length !== manifest.reviewRows || map.some((entry) => !reviewIds.has(entry.reviewId))) {
    throw new Error("private review map does not align with CSV");
  }
  process.stdout.write(`review packet verified rows=${manifest.reviewRows} itemGroups=${manifest.itemGroups} labels=blank\n`);
}

function mulberry32(seed: number) {
  let state = seed;
  return () => {
    state |= 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(values: T[], seed: number): T[] {
  const result = [...values];
  const random = mulberry32(seed);
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex]!, result[index]!];
  }
  return result;
}

function asDate(value: number): Date {
  return new Date(value);
}

function asItem(row: ItemRow): ItemWithSource {
  return {
    ...row,
    publishedAt: asDate(row.publishedAt),
    createdAt: asDate(row.createdAt),
    publishedAtKnown: Boolean(row.publishedAtKnown),
    source: { name: row.sourceName },
  } as unknown as ItemWithSource;
}

function toCandidate(row: ClusterRow): ClusterAssignmentCandidate {
  return {
    ...row,
    latestPublishedAt: asDate(row.latestPublishedAt),
  };
}

function toBm25Document(document: {
  id: string;
  title: string;
  summary: string;
  eventSubject: string | null;
  eventObject: string | null;
}): Bm25ClusterDocument {
  return {
    id: document.id,
    title: document.title,
    summary: document.summary,
    eventSubject: document.eventSubject,
    eventObject: document.eventObject,
  };
}

function compact(value: string | null | undefined, limit = 600): string {
  return (value ?? "").replace(/\s+/gu, " ").trim().slice(0, limit);
}

function eventText(row: Pick<ItemRow, "eventType" | "eventSubject" | "eventAction" | "eventObject" | "eventDate">): string {
  return [
    row.eventType ? `类型：${row.eventType}` : "",
    row.eventSubject ? `主体：${row.eventSubject}` : "",
    row.eventAction ? `动作：${row.eventAction}` : "",
    row.eventObject ? `对象：${row.eventObject}` : "",
    row.eventDate ? `日期：${row.eventDate}` : "",
  ].filter(Boolean).join("；");
}

function main() {
  const args = parseArgs(process.argv);
  if (!existsSync(args.db)) throw new Error(`DB snapshot not found: ${args.db}`);
  if (args.verify) {
    verifyPacket(args);
    return;
  }
  const snapshotHash = sha256(args.db);
  const db = new DatabaseSync(args.db, { readOnly: true });
  let rows: ReviewRow[];
  let internalMap: InternalMapEntry[];
  let eligibleAnchorCount = 0;
  try {
    const itemRows = db.prepare(
      `SELECT i.id, i.clusterId, i.originalTitle, i.translatedTitle, i.summaryText, i.rssExcerpt,
              i.rssContent, i.fullText, i.publishedAt, i.publishedAtKnown, i.createdAt, i.qualityScore,
              i.eventType, i.eventSubject, i.eventAction, i.eventObject, i.eventDate,
              s.name AS sourceName, c.itemCount
       FROM items i
       JOIN sources s ON s.id = i.sourceId
       JOIN content_clusters c ON c.id = i.clusterId
       WHERE i.status = 'processed'
         AND i.moderationStatus IN ('allowed', 'restored')
         AND (s.aggregationEnabled = 1 OR i.parentItemId IS NOT NULL)
         AND c.status = 'active' AND c.itemCount > 1
       ORDER BY i.id`,
    ).all() as unknown as ItemRow[];
    const clusters = db.prepare(
      `SELECT c.id, c.title, c.summary, c.fingerprint, c.eventFingerprint, c.eventBucket,
              c.eventType, c.eventSubject, c.eventAction, c.eventObject, c.eventDate,
              c.latestPublishedAt, c.createdAt, c.itemCount
       FROM content_clusters c
       WHERE c.status = 'active' AND c.itemCount > 0
         AND EXISTS (
           SELECT 1 FROM items member
           LEFT JOIN sources member_source ON member_source.id = member.sourceId
           WHERE member.clusterId = c.id
             AND member.status = 'processed'
             AND member.moderationStatus IN ('allowed', 'restored')
             AND (member_source.aggregationEnabled = 1 OR member.parentItemId IS NOT NULL)
         )`,
    ).all() as unknown as ClusterRow[];
    const memberStmt = db.prepare(
      `SELECT i.id, i.originalTitle, i.translatedTitle, i.summaryText, i.rssExcerpt, i.fullText,
              i.eventType, i.eventSubject, i.eventAction, i.eventObject, i.eventDate, i.publishedAt,
              s.name AS sourceName
       FROM items i JOIN sources s ON s.id = i.sourceId
       WHERE i.clusterId = ? AND i.id <> ?
         AND i.status = 'processed' AND i.moderationStatus IN ('allowed', 'restored')
         AND (s.aggregationEnabled = 1 OR i.parentItemId IS NOT NULL)
       ORDER BY i.qualityScore DESC, i.publishedAt DESC, i.id
       LIMIT 3`,
    );

    const allCandidates = clusters.map(toCandidate);
    const clustersById = new Map(clusters.map((cluster) => [cluster.id, cluster]));
    const bm25Index = buildClusterMergeBm25Index(clusters.map((cluster) => toBm25Document(cluster)));
    const prepared: Array<{ itemId: string; groupId: string; visibleRows: ReviewRow[]; mappings: InternalMapEntry[] }> = [];
    let reviewSequence = 0;
    for (const row of itemRows) {
      const item = asItem(row);
      const anchor = row.publishedAtKnown ? row.publishedAt : row.createdAt;
      const since = anchor - CLUSTER_LOOKBACK_MS;
      const until = anchor + CLUSTER_LOOKBACK_MS;
      const candidateTime = (candidate: ClusterRow) => row.publishedAtKnown
        ? candidate.latestPublishedAt
        : candidate.createdAt;
      if (!row.clusterId) continue;
      const assignedRow = clustersById.get(row.clusterId);
      const assigned = allCandidates.find((candidate) => candidate.id === row.clusterId);
      if (!assigned || !assignedRow || candidateTime(assignedRow) < since || candidateTime(assignedRow) > until) continue;
      const candidates = allCandidates.filter((candidate) => {
        const time = candidateTime(clustersById.get(candidate.id)!);
        return time >= since && time <= until;
      });
      if (candidates.length < 2) continue;
      const itemDocument = toBm25Document({
        id: item.id,
        title: item.translatedTitle?.trim() || item.originalTitle,
        summary: buildItemSummary(item),
        eventSubject: row.eventSubject,
        eventObject: row.eventObject,
      });
      const bm25Top = candidates
        .filter((candidate) => candidate.id !== assigned.id)
        .map((candidate) => ({
          candidate,
          score: scoreClusterMergeBm25Documents(
            bm25Index,
            itemDocument,
            toBm25Document(candidate),
          ),
        }))
        .sort((left, right) => right.score - left.score ||
          right.candidate.latestPublishedAt.getTime() - left.candidate.latestPublishedAt.getTime() ||
          left.candidate.id.localeCompare(right.candidate.id))[0]?.candidate;
      if (!bm25Top) continue;
      const groupId = `I${String(prepared.length + 1).padStart(3, "0")}`;
      const candidateSpecs = new Map<string, { candidate: ClusterAssignmentCandidate; selectedBy: string[] }>();
      const addCandidate = (candidate: ClusterAssignmentCandidate, selectedBy: string) => {
        const existing = candidateSpecs.get(candidate.id);
        if (existing) existing.selectedBy.push(selectedBy);
        else candidateSpecs.set(candidate.id, { candidate, selectedBy: [selectedBy] });
      };
      addCandidate(assigned, "assigned-cluster");
      addCandidate(bm25Top, "bm25-top");
      const pairSpecs = [...candidateSpecs.values()];
      const visibleRows: ReviewRow[] = [];
      const mappings: InternalMapEntry[] = [];
      for (const spec of pairSpecs) {
        const memberRows = memberStmt.all(spec.candidate.id, row.id) as unknown as Array<{
          id: string; originalTitle: string; translatedTitle: string | null; summaryText: string | null;
          rssExcerpt: string | null; fullText: string | null; eventType: string | null; eventSubject: string | null;
          eventAction: string | null; eventObject: string | null; eventDate: string | null; publishedAt: number;
          sourceName: string;
        }>;
        if (memberRows.length === 0) continue;
        reviewSequence += 1;
        const reviewId = `R${String(reviewSequence).padStart(4, "0")}`;
        const evidence = memberRows.map((member) => {
          const title = member.translatedTitle?.trim() || member.originalTitle;
          const summary = compact(member.summaryText || member.rssExcerpt || member.fullText, 350);
          const event = eventText(member);
          return [title, summary ? `摘要：${summary}` : "", event ? `事件：${event}` : "", `来源：${member.sourceName}`]
            .filter(Boolean).join("\n");
        }).join("\n---\n");
        visibleRows.push({
          reviewId,
          itemGroupId: groupId,
          itemTitle: compact(row.translatedTitle?.trim() || row.originalTitle, 300),
          itemSummary: compact(row.summaryText || row.rssExcerpt || row.fullText, 600),
          itemPublishedAt: new Date(row.publishedAtKnown ? row.publishedAt : row.createdAt).toISOString().slice(0, 10),
          itemEventType: row.eventType ?? "",
          itemEventSubject: row.eventSubject ?? "",
          itemEventAction: row.eventAction ?? "",
          itemEventObject: row.eventObject ?? "",
          itemEventDate: row.eventDate ?? "",
          candidateEvidence: evidence,
          humanLabel: "",
          reviewNotes: "",
        });
        mappings.push({ reviewId, itemId: row.id, candidateClusterId: spec.candidate.id, selectedBy: spec.selectedBy, itemGroupId: groupId });
      }
      if (visibleRows.length === pairSpecs.length) prepared.push({ itemId: row.id, groupId, visibleRows, mappings });
    }
    eligibleAnchorCount = itemRows.length;
    if (prepared.length < args.items) {
      throw new Error(`requested ${args.items} anchors but only ${prepared.length} have a qualified alternative and sibling evidence`);
    }
    const selected = shuffle(prepared, args.seed).slice(0, args.items);
    rows = shuffle(selected.flatMap((entry) => entry.visibleRows), args.seed ^ 0x9e3779b9);
    internalMap = selected.flatMap((entry) => entry.mappings);
  } finally {
    db.close();
  }

  const csv = csvText(rows!);
  const manifest = {
    schemaVersion: 1,
    dataset: "item-assignment-bm25-human-review",
    sourceSnapshotSha256: snapshotHash,
    sourceSnapshot: path.basename(args.db),
    seed: args.seed,
    lookbackDays: CLUSTER_LOOKBACK_MS / (24 * 60 * 60 * 1000),
    requestedItemGroups: args.items,
    itemGroups: new Set(rows!.map((row) => row.itemGroupId)).size,
    reviewRows: rows!.length,
    eligibleAssignedClusterItemsBeforeSignatureAndAlternativeFilters: eligibleAnchorCount,
    candidateConstruction: "For each sampled processed item, take the deduplicated union of its assigned active cluster and the BM25 top alternative from the active 7-day candidate pool. This is a challenge set, not an estimate of production admission or prevalence; reviewer evidence lists sibling items only, excluding the anchor item.",
    labelInstructions: "Set humanLabel to same or diff for whether the item belongs to the candidate cluster as the same event. Use event identity, not broad topic similarity. Leave machine verdicts and ranking assumptions out of the judgment; explain edge cases in reviewNotes.",
    humanLabelValues: ["same", "diff"],
    labelsInitiallyBlank: rows!.every((row) => row.humanLabel === ""),
    csvSha256: createHash("sha256").update(csv).digest("hex"),
  };
  const outputs = [
    [args.out, csv],
    [args.manifest, `${JSON.stringify(manifest, null, 2)}\n`],
    [args.map, `${JSON.stringify(internalMap, null, 2)}\n`],
  ] as const;
  for (const [file, content] of outputs) {
    if (existsSync(file)) {
      const current = readFileSync(file, "utf8");
      if (current !== content) throw new Error(`existing output differs; refusing overwrite: ${file}`);
    } else {
      writeFileSync(file, content, { flag: "wx" });
    }
  }
  process.stdout.write(`review packet generated itemGroups=${manifest.itemGroups} rows=${manifest.reviewRows} labels=blank sha256=${manifest.csvSha256}\n`);
}

main();
