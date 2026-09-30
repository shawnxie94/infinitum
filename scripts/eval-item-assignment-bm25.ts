import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
// node:sqlite is available in the runtime but is not declared by @types/node@20.
// @ts-expect-error node:sqlite has no type declarations in @types/node@20
import { DatabaseSync } from "node:sqlite";

import { CLUSTER_LOOKBACK_MS } from "../src/config/constants";
import {
  buildItemSummary,
  getClusterAssignmentCandidateSafety,
  getItemEventSignature,
  rankItemAssignmentCandidatesWithBm25,
  type ItemWithSource,
} from "../src/lib/clusters/helpers";
import type { ClusterAssignmentCandidate } from "../src/lib/clusters/repository";
import { getDisplayTitle } from "../src/lib/feed/presentation";

const LABEL_COLUMNS = ["reviewId", "itemGroupId", "humanLabel"] as const;

type Args = { db: string; labels: string; manifest: string; map: string; out: string; verify: boolean };
type Label = "same" | "diff";
type ReviewLabel = { reviewId: string; itemGroupId: string; humanLabel: string };
type MapEntry = {
  reviewId: string;
  itemId: string;
  candidateClusterId: string;
  selectedBy: string[];
  itemGroupId: string;
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
type ScoredRow = {
  reviewId: string;
  itemGroupId: string;
  itemId: string;
  candidateClusterId: string;
  selectedBy: string[];
  label: Label;
  bm25Score: number;
  dateCompatible: boolean;
  hardConflict: boolean;
  candidateLatestPublishedAt: number;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    db: "",
    labels: "",
    manifest: "",
    map: "",
    out: ".agent/tmp/item-assignment-bm25/item-assignment-bm25-only-evaluation.json",
    verify: false,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--db") args.db = argv[++index] ?? "";
    else if (arg === "--labels") args.labels = argv[++index] ?? "";
    else if (arg === "--manifest") args.manifest = argv[++index] ?? "";
    else if (arg === "--map") args.map = argv[++index] ?? "";
    else if (arg === "--out") args.out = argv[++index] ?? "";
    else if (arg === "--verify") args.verify = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  for (const input of [args.db, args.labels, args.manifest, args.map]) {
    if (!input) throw new Error("required: --db, --labels, --manifest and --map");
    if (!existsSync(input)) throw new Error(`input not found: ${input}`);
  }
  return args;
}

function hashFile(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const input = text.replace(/^\uFEFF/u, "");
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (char === '"' && quoted && input[index + 1] === '"') {
      field += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && input[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const headers = rows.shift()?.map((value) => value.trim()) ?? [];
  if (LABEL_COLUMNS.some((column) => !headers.includes(column))) {
    throw new Error(`labels CSV must contain columns: ${LABEL_COLUMNS.join(", ")}`);
  }
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function asItem(row: ItemRow): ItemWithSource {
  return {
    ...row,
    publishedAt: new Date(row.publishedAt),
    createdAt: new Date(row.createdAt),
    publishedAtKnown: Boolean(row.publishedAtKnown),
    source: { name: row.sourceName },
  } as unknown as ItemWithSource;
}

function toCandidate(row: ClusterRow): ClusterAssignmentCandidate {
  return { ...row, latestPublishedAt: new Date(row.latestPublishedAt) };
}

function mostCommon(rows: ItemRow[], key: "eventType" | "eventSubject" | "eventAction" | "eventObject" | "eventDate") {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = row[key]?.trim();
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] ?? null;
}

function leaveOneOutCandidate(base: ClusterAssignmentCandidate, siblings: ItemRow[]): ClusterAssignmentCandidate {
  if (siblings.length === 0) throw new Error(`assigned cluster ${base.id} has no sibling evidence after excluding anchor item`);
  const first = siblings[0]!;
  const title = getDisplayTitle(first.originalTitle, first.translatedTitle);
  const summary = siblings
    .slice(0, 2)
    .map((row) => buildItemSummary(asItem(row)))
    .filter(Boolean)
    .join(" ");
  return {
    ...base,
    title,
    summary,
    eventType: mostCommon(siblings, "eventType"),
    eventSubject: mostCommon(siblings, "eventSubject"),
    eventAction: mostCommon(siblings, "eventAction"),
    eventObject: mostCommon(siblings, "eventObject"),
    eventDate: mostCommon(siblings, "eventDate"),
    latestPublishedAt: new Date(Math.max(...siblings.map((row) => row.publishedAt))),
  };
}

function confusion(rows: ScoredRow[], admitted: (row: ScoredRow) => boolean) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const row of rows) {
    const yes = admitted(row);
    if (row.label === "same" && yes) tp += 1;
    else if (row.label === "diff" && yes) fp += 1;
    else if (row.label === "same") fn += 1;
    else tn += 1;
  }
  const precision = tp + fp === 0 ? null : tp / (tp + fp);
  const recall = tp + fn === 0 ? null : tp / (tp + fn);
  return { tp, fp, fn, tn, precision, recall };
}

function groupedRanking(rows: ScoredRow[], scoreOf: (row: ScoredRow) => number, eligible: (row: ScoredRow) => boolean) {
  const groups = new Map<string, ScoredRow[]>();
  for (const row of rows) {
    const list = groups.get(row.itemGroupId) ?? [];
    list.push(row);
    groups.set(row.itemGroupId, list);
  }
  let wins = 0;
  let ties = 0;
  let comparisons = 0;
  let groupsWithBothLabels = 0;
  let groupsWithPositive = 0;
  let top1Hits = 0;
  let top1Eligible = 0;
  let positiveAtK = 0;
  let totalPositives = 0;
  let top1SameGroups = 0;
  let safetyAbstentions = 0;

  for (const groupRows of groups.values()) {
    const allPositives = groupRows.filter((row) => row.label === "same");
    const allNegatives = groupRows.filter((row) => row.label === "diff");
    const positives = allPositives.filter(eligible);
    const negatives = allNegatives.filter(eligible);
    totalPositives += allPositives.length;
    if (allPositives.length > 0) groupsWithPositive += 1;
    if (positives.length > 0 && negatives.length > 0) {
      groupsWithBothLabels += 1;
      for (const positive of positives) {
        for (const negative of negatives) {
          comparisons += 1;
          const difference = scoreOf(positive) - scoreOf(negative);
          if (difference > 0) wins += 1;
          else if (difference === 0) ties += 1;
        }
      }
    }
    const ranked = groupRows.filter(eligible).sort((left, right) =>
      scoreOf(right) - scoreOf(left) ||
      right.candidateLatestPublishedAt - left.candidateLatestPublishedAt ||
      left.candidateClusterId.localeCompare(right.candidateClusterId),
    );
    if (ranked.length === 0) safetyAbstentions += 1;
    if (positives.length > 0) {
      if (ranked.length > 0) {
        top1Eligible += 1;
        if (ranked[0]!.label === "same") top1Hits += 1;
      }
      const k = Math.min(2, ranked.length);
      positiveAtK += ranked.slice(0, k).filter((row) => row.label === "same").length;
    }
    if (ranked[0]?.label === "same") top1SameGroups += 1;
  }
  return {
    groupCount: groups.size,
    groupsWithPositive,
    groupsWithBothLabels,
    withinGroupPositiveNegativeComparisons: comparisons,
    pairwiseAuc: comparisons === 0 ? null : (wins + ties / 2) / comparisons,
    top1RecallAmongGroupsWithPositive: groupsWithPositive === 0 ? null : top1Hits / groupsWithPositive,
    top1HitRateAmongEligiblePositiveGroups: top1Eligible === 0 ? null : top1Hits / top1Eligible,
    recallAt2: totalPositives === 0 ? null : positiveAtK / totalPositives,
    positivePairsInDataset: totalPositives,
    groupsWithTop1Same: top1SameGroups,
    top1SameRateAcrossGroups: groups.size === 0 ? null : top1SameGroups / groups.size,
    groupsWithNoEligibleCandidate: safetyAbstentions,
  };
}

function verifyOutput(args: Args) {
  const result = JSON.parse(readFileSync(args.out, "utf8")) as {
    schemaVersion: number;
    inputHashes: { database: string; labelsCsv: string; manifest: string; map: string };
    includedLabelRows: number;
    excludedBlankRows: number;
    pairRows: ScoredRow[];
  };
  if (result.schemaVersion !== 2) throw new Error("unsupported evaluation result schema");
  const expectedHashes = {
    database: hashFile(args.db),
    labelsCsv: hashFile(args.labels),
    manifest: hashFile(args.manifest),
    map: hashFile(args.map),
  };
  if (JSON.stringify(result.inputHashes) !== JSON.stringify(expectedHashes)) {
    throw new Error("evaluation input hashes changed since replay");
  }
  const currentLabels = parseCsv(readFileSync(args.labels, "utf8"));
  const labeledCount = currentLabels.filter((row) => row.humanLabel === "same" || row.humanLabel === "diff").length;
  const blankCount = currentLabels.filter((row) => !row.humanLabel.trim()).length;
  if (result.includedLabelRows !== labeledCount || result.excludedBlankRows !== blankCount) {
    throw new Error("evaluation label counts do not match current CSV");
  }
  if (result.pairRows.length !== labeledCount) throw new Error("pair score count does not match labeled rows");
  process.stdout.write(`evaluation verified labeled=${labeledCount} excludedBlank=${blankCount}\n`);
}

function main() {
  const args = parseArgs(process.argv);
  if (args.verify) {
    verifyOutput(args);
    return;
  }
  const reviewRows = parseCsv(readFileSync(args.labels, "utf8"));
  const packetManifest = JSON.parse(readFileSync(args.manifest, "utf8")) as { sourceSnapshotSha256: string; csvSha256: string };
  const mapRows = JSON.parse(readFileSync(args.map, "utf8")) as MapEntry[];
  if (hashFile(args.db) !== packetManifest.sourceSnapshotSha256) throw new Error("snapshot SHA-256 differs from review manifest");
  const mapById = new Map(mapRows.map((entry) => [entry.reviewId, entry]));
  if (mapById.size !== mapRows.length) throw new Error("private map contains duplicate reviewId");
  const labelsById = new Map<string, ReviewLabel>();
  let blankLabels = 0;
  for (const row of reviewRows) {
    const reviewId = row.reviewId?.trim() ?? "";
    const itemGroupId = row.itemGroupId?.trim() ?? "";
    const humanLabel = row.humanLabel?.trim() ?? "";
    if (!reviewId || !itemGroupId || labelsById.has(reviewId)) throw new Error("review CSV has missing or duplicate reviewId/itemGroupId");
    if (humanLabel && humanLabel !== "same" && humanLabel !== "diff") throw new Error(`invalid humanLabel for ${reviewId}`);
    if (!humanLabel) blankLabels += 1;
    const mapping = mapById.get(reviewId);
    if (!mapping || mapping.itemGroupId !== itemGroupId) throw new Error(`CSV/map mismatch for ${reviewId}`);
    labelsById.set(reviewId, { reviewId, itemGroupId, humanLabel });
  }
  if (labelsById.size !== mapById.size) throw new Error("CSV and private map reviewId sets differ");
  const groupedMaps = new Map<string, MapEntry[]>();
  for (const entry of mapRows) {
    const list = groupedMaps.get(entry.itemGroupId) ?? [];
    list.push(entry);
    groupedMaps.set(entry.itemGroupId, list);
  }

  const db = new DatabaseSync(args.db, { readOnly: true });
  let scoredRows: ScoredRow[];
  const databaseCounts = {
    items: Number((db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n),
    clusters: Number((db.prepare("SELECT COUNT(*) AS n FROM content_clusters").get() as { n: number }).n),
  };
  try {
    const itemIds = [...new Set(mapRows.map((entry) => entry.itemId))];
    const placeholders = (values: string[]) => values.map(() => "?").join(",");
    const items = db.prepare(
      `SELECT i.*, s.name AS sourceName FROM items i JOIN sources s ON s.id = i.sourceId
       WHERE i.id IN (${placeholders(itemIds)})`,
    ).all(...itemIds) as unknown as ItemRow[];
    const clusters = db.prepare(
      `SELECT id, title, summary, fingerprint, eventFingerprint, eventBucket, eventType, eventSubject,
              eventAction, eventObject, eventDate, latestPublishedAt, createdAt, itemCount
       FROM content_clusters WHERE status='active' AND itemCount > 0`,
    ).all() as unknown as ClusterRow[];
    const itemById = new Map(items.map((row) => [row.id, row]));
    const clusterById = new Map(clusters.map((row) => [row.id, row]));
    const memberStmt = db.prepare(
      `SELECT i.*, s.name AS sourceName FROM items i JOIN sources s ON s.id = i.sourceId
       WHERE i.clusterId = ? AND i.id <> ?
         AND i.status = 'processed' AND i.moderationStatus IN ('allowed', 'restored')
         AND (s.aggregationEnabled = 1 OR i.parentItemId IS NOT NULL)
       ORDER BY i.qualityScore DESC, i.publishedAt DESC, i.id LIMIT 3`,
    );
    scoredRows = [];
    for (const [itemGroupId, entries] of groupedMaps) {
      const itemId = entries[0]!.itemId;
      if (entries.some((entry) => entry.itemId !== itemId)) throw new Error(`itemGroupId ${itemGroupId} maps to multiple items`);
      const itemRow = itemById.get(itemId);
      if (!itemRow) throw new Error(`item missing from snapshot: ${itemId}`);
      const item = asItem(itemRow);
      const signature = getItemEventSignature(item) ?? {
        eventType: null, eventSubject: null, eventAction: null, eventObject: null, eventDate: null,
      };
      const assignedClusterId = itemRow.clusterId;
      const leaveOut = new Map<string, ClusterAssignmentCandidate>();
      if (assignedClusterId && entries.some((entry) => entry.candidateClusterId === assignedClusterId)) {
        const baseRow = clusterById.get(assignedClusterId);
        if (!baseRow) throw new Error(`assigned cluster missing from snapshot: ${assignedClusterId}`);
        const base = toCandidate(baseRow);
        const siblings = memberStmt.all(assignedClusterId, itemId) as unknown as ItemRow[];
        leaveOut.set(assignedClusterId, leaveOneOutCandidate(base, siblings));
      }
      const candidateById = new Map<string, ClusterAssignmentCandidate>();
      const candidateRowsById = new Map<string, ClusterRow>();
      for (const entry of entries) {
        const candidateRow = clusterById.get(entry.candidateClusterId);
        if (!candidateRow) throw new Error(`candidate cluster missing from snapshot: ${entry.candidateClusterId}`);
        candidateRowsById.set(entry.candidateClusterId, candidateRow);
        const candidate = leaveOut.get(entry.candidateClusterId) ?? toCandidate(candidateRow);
        candidateById.set(candidate.id, candidate);
      }
      const candidates = [...candidateById.values()];
      const ranked = rankItemAssignmentCandidatesWithBm25(item, signature, candidates);
      const bm25ByCandidateId = new Map(ranked.eligibleCandidates.map((entry) => [entry.candidate.id, entry.score]));
      const safetyByCandidateId = new Map(
        candidates.map((candidate) => [candidate.id, getClusterAssignmentCandidateSafety(item, signature, candidate)]),
      );
      const anchor = itemRow.publishedAtKnown ? itemRow.publishedAt : itemRow.createdAt;
      const lowerBound = anchor - CLUSTER_LOOKBACK_MS;
      const upperBound = anchor + CLUSTER_LOOKBACK_MS;
      for (const entry of entries) {
        const labelRow = labelsById.get(entry.reviewId)!;
        if (!labelRow.humanLabel) continue;
        const candidate = candidateById.get(entry.candidateClusterId)!;
        const candidateRow = candidateRowsById.get(entry.candidateClusterId)!;
        const safety = safetyByCandidateId.get(entry.candidateClusterId)!;
        const timeFieldValue = itemRow.publishedAtKnown ? candidate.latestPublishedAt.getTime() : candidateRow.createdAt;
        const dateWindowValid = timeFieldValue >= lowerBound && timeFieldValue <= upperBound;
        scoredRows.push({
          reviewId: entry.reviewId,
          itemGroupId,
          itemId,
          candidateClusterId: entry.candidateClusterId,
          selectedBy: entry.selectedBy,
          label: labelRow.humanLabel as Label,
          bm25Score: bm25ByCandidateId.get(entry.candidateClusterId) ?? 0,
          dateCompatible: safety.dateCompatible && dateWindowValid,
          hardConflict: safety.hardConflict,
          candidateLatestPublishedAt: candidate.latestPublishedAt.getTime(),
        });
      }
    }
  } finally {
    db.close();
  }

  const safetyEligible = (row: ScoredRow) => row.dateCompatible && !row.hardConflict;
  const bm25PositiveAdmission = (row: ScoredRow) => row.bm25Score > 0 && safetyEligible(row);
  const metrics = {
    bm25SafetyEligibleRanking: groupedRanking(scoredRows, (row) => row.bm25Score, safetyEligible),
    exploratoryAdmission: {
      bm25PositiveWithSharedGuard: confusion(scoredRows, bm25PositiveAdmission),
    },
  };
  const inputHashes = {
    database: hashFile(args.db),
    labelsCsv: hashFile(args.labels),
    manifest: hashFile(args.manifest),
    map: hashFile(args.map),
  };
  const result = {
    schemaVersion: 2,
    task: "item-assignment-bm25-offline-challenge-evaluation",
    generatedAt: new Date().toISOString(),
    inputHashes,
    originalUnlabeledPacketCsvSha256: packetManifest.csvSha256,
    includedLabelRows: scoredRows.length,
    excludedBlankRows: blankLabels,
    excludedRowsByLabel: blankLabels,
    itemGroups: groupedMaps.size,
    evaluatedItemGroups: metrics.bm25SafetyEligibleRanking.groupCount,
    snapshotCounts: databaseCounts,
    scoreDefinitions: {
      bm25: "Production item-assignment BM25 scores over the eligible per-item candidate pool plus the incoming item document; score order is ranking-only and is not a calibrated admission probability.",
      bm25AdmissionProxy: "BM25 score > 0 plus the production date-window and hard-conflict guards; exploratory only, not an automatic assignment threshold.",
    },
    datasetLimitations: [
      "The challenge set is selection-conditioned and is not an unbiased production estimate or independent holdout.",
      "Only the reviewed candidate set is evaluated; this does not measure recall over every possible cluster candidate or complete ingestion-to-assignment behavior.",
      "No BM25 admission threshold or score-gap bypass has been calibrated.",
      "One blank humanLabel row was excluded. Spreadsheet-reformatted display-date fields were ignored; item/cluster text and dates came from the read-only SQLite snapshot.",
    ],
    metrics,
    pairRows: scoredRows,
  };
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (existsSync(args.out)) {
    const current = readFileSync(args.out, "utf8");
    const previous = JSON.parse(current) as { inputHashes?: typeof inputHashes };
    if (JSON.stringify(previous.inputHashes) !== JSON.stringify(inputHashes)) {
      throw new Error(`existing evaluation output uses different inputs: ${args.out}`);
    }
  }
  writeFileSync(args.out, serialized);
  const ranking = result.metrics.bm25SafetyEligibleRanking as {
    pairwiseAuc: number | null;
    top1RecallAmongGroupsWithPositive: number | null;
  };
  process.stdout.write(
    `item-assignment BM25 replay groups=${result.evaluatedItemGroups} labeled=${result.includedLabelRows} excludedBlank=${result.excludedBlankRows} ` +
    `withinGroupAUC=${ranking.pairwiseAuc ?? "n/a"} top1Recall=${ranking.top1RecallAmongGroupsWithPositive ?? "n/a"}\n` +
    `output=${args.out}\n`,
  );
}

main();
