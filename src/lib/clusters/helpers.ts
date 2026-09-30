import crypto from "node:crypto";

import type { Item, Source } from "@prisma/client";

import {
  CLUSTER_MERGE_CANDIDATE_LIMIT,
  CLUSTER_MERGE_DIRTY_NEIGHBOR_SCAN_LIMIT,
  CLUSTER_MERGE_RELATED_PAIR_LIMIT,
  CLUSTER_MERGE_VECTOR_GRAY_SIM,
} from "@/config/constants";
import { type AiEventSignature, type AiProvider } from "@/lib/ai/provider-types";
import { shouldRegenerateChineseSummary } from "@/lib/ai/summary-language";
import type { ClusterAssignmentCandidate } from "@/lib/clusters/repository";
import {
  buildClusterMergeBm25Index,
  CLUSTER_MERGE_BM25_CACHE_VERSION,
  CLUSTER_MERGE_BM25_SCORE_SCALE,
  scoreClusterMergeBm25Pair,
} from "@/lib/clusters/bm25";
import {
  areEventDatesCompatibleForClustering,
  areEventDatesExactlyEqual,
  getEventDatePrecision,
  normalizeEventActionForStorage,
  normalizeEventObjectForStorage,
  normalizeEventSignatureForMatch,
  normalizeEventSignatureForStorage,
  normalizeEventSubjectForStorage,
  normalizeStoredEventType,
} from "@/lib/clusters/normalization";
import { getDisplaySummary, getDisplayTitle } from "@/lib/feed/presentation";

export type ItemWithSource = Item & { source: Source };

export type ClusterAssignmentCoordinator = {
  exactMatches: Map<string, ClusterAssignmentCandidate | null>;
  recentCandidates: Map<string, { sinceMs: number; untilMs: number; candidates: ClusterAssignmentCandidate[] }>;
};

export type ClusterCandidateTimeField = "latestPublishedAt" | "createdAt";

export function createClusterAssignmentCoordinator(): ClusterAssignmentCoordinator {
  return {
    exactMatches: new Map(),
    recentCandidates: new Map(),
  };
}

export function normalizeFingerprint(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

export function buildItemSummary(item: ItemWithSource): string {
  return getDisplaySummary(item.summaryText, item.rssExcerpt, item.fullText ?? item.rssContent);
}

export function getEventIdentityAnchor(item: Pick<ItemWithSource, "publishedAt" | "publishedAtKnown" | "createdAt">) {
  return item.publishedAtKnown ? item.publishedAt : item.createdAt;
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed || null;
}

function normalizeComparableText(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export function getItemEventSignature(item: {
  eventType?: string | null;
  eventSubject?: string | null;
  eventAction?: string | null;
  eventObject?: string | null;
  eventDate?: string | null;
}): AiEventSignature | null {
  return normalizeEventSignatureForStorage({
    eventType: normalizeStoredEventType(item.eventType),
    eventSubject: item.eventSubject ?? null,
    eventAction: item.eventAction ?? null,
    eventObject: item.eventObject ?? null,
    eventDate: item.eventDate ?? null,
  });
}

function getCandidateEventSignature(candidate: {
  eventType?: string | null;
  eventSubject?: string | null;
  eventAction?: string | null;
  eventObject?: string | null;
  eventDate?: string | null;
}): AiEventSignature {
  return normalizeEventSignatureForStorage({
    eventType: normalizeStoredEventType(candidate.eventType),
    eventSubject: normalizeOptionalText(candidate.eventSubject),
    eventAction: normalizeOptionalText(candidate.eventAction),
    eventObject: normalizeOptionalText(candidate.eventObject),
    eventDate: normalizeOptionalText(candidate.eventDate),
  }) ?? {
    eventType: null,
    eventSubject: null,
    eventAction: null,
    eventObject: null,
    eventDate: null,
  };
}

export function buildClusterFingerprintSeed(options: { eventSignature?: AiEventSignature | null }) {
  const signature = normalizeEventSignatureForStorage(options.eventSignature);

  if (!signature?.eventSubject || !signature.eventObject) {
    return "";
  }

  const eventKind = signature.eventAction || signature.eventType;

  if (!eventKind) {
    return "";
  }

  // Time-free: excludes eventDate so same-event fingerprints never diverge on
  // noisy/missing dates. Time separation happens via the match time window.
  // Space-insensitive (removes all whitespace) so AI extraction inconsistency
  // in brand/product names never fragments the same event.
  return [
    signature.eventType || "",
    (signature.eventSubject || "").replace(/\s+/gu, ""),
    signature.eventAction || "",
    (signature.eventObject || "").replace(/\s+/gu, ""),
  ].join("|");
}

export function hasCompleteClusterMatchSignature(eventSignature?: AiEventSignature | null) {
  return Boolean(
    eventSignature?.eventSubject &&
      eventSignature.eventObject &&
      (eventSignature.eventAction || eventSignature.eventType),
  );
}

export function buildCandidateRange(item: ItemWithSource, lookbackMs: number) {
  const anchor = getEventIdentityAnchor(item);

  return {
    since: new Date(anchor.getTime() - lookbackMs),
    until: new Date(anchor.getTime() + lookbackMs),
    timeField: (item.publishedAtKnown ? "latestPublishedAt" : "createdAt") as ClusterCandidateTimeField,
  };
}

export function buildCandidateRangeKey(
  since: Date,
  until: Date,
  timeField: ClusterCandidateTimeField = "latestPublishedAt",
) {
  return `${timeField}:${since.getTime()}:${until.getTime()}`;
}

export function buildExactMatchKey(
  fingerprint: string,
  since: Date,
  until: Date,
  timeField: ClusterCandidateTimeField = "latestPublishedAt",
) {
  return `${fingerprint}:${buildCandidateRangeKey(since, until, timeField)}`;
}

export function toClusterAssignmentCandidate(cluster: {
  id: string;
  title: string;
  summary: string;
  fingerprint: string;
  eventFingerprint?: string | null;
  eventBucket?: string | null;
  eventType?: string | null;
  eventSubject?: string | null;
  eventAction?: string | null;
  eventObject?: string | null;
  eventDate?: string | null;
  latestPublishedAt: Date;
  itemCount?: number;
}): ClusterAssignmentCandidate {
  return {
    id: cluster.id,
    title: cluster.title,
    summary: cluster.summary,
    fingerprint: cluster.fingerprint,
    eventFingerprint: cluster.eventFingerprint ?? null,
    eventBucket: cluster.eventBucket ?? null,
    eventType: cluster.eventType ?? null,
    eventSubject: cluster.eventSubject ?? null,
    eventAction: cluster.eventAction ?? null,
    eventObject: cluster.eventObject ?? null,
    eventDate: cluster.eventDate ?? null,
    latestPublishedAt: cluster.latestPublishedAt,
    itemCount: cluster.itemCount ?? 1,
  };
}

function pickDominantSignatureValue<T extends string>(
  values: Array<{
    value: T | null;
    qualityScore: number;
    publishedAt: Date;
  }>,
) {
  const scoreMap = new Map<
    string,
    {
      value: T;
      count: number;
      bestQualityScore: number;
      latestPublishedAtMs: number;
    }
  >();

  for (const entry of values) {
    if (!entry.value) {
      continue;
    }

    const existing = scoreMap.get(entry.value);
    if (!existing) {
      scoreMap.set(entry.value, {
        value: entry.value,
        count: 1,
        bestQualityScore: entry.qualityScore,
        latestPublishedAtMs: entry.publishedAt.getTime(),
      });
      continue;
    }

    existing.count += 1;
    existing.bestQualityScore = Math.max(existing.bestQualityScore, entry.qualityScore);
    existing.latestPublishedAtMs = Math.max(existing.latestPublishedAtMs, entry.publishedAt.getTime());
  }

  return [...scoreMap.values()]
    .sort((left, right) => {
      if (right.count !== left.count) {
        return right.count - left.count;
      }
      if (right.bestQualityScore !== left.bestQualityScore) {
        return right.bestQualityScore - left.bestQualityScore;
      }
      return right.latestPublishedAtMs - left.latestPublishedAtMs;
    })[0]?.value ?? null;
}

export function buildClusterEventSignature(clusterItems: ItemWithSource[]): AiEventSignature | null {
  const eventType = pickDominantSignatureValue(
    clusterItems.map((item) => ({
      value: normalizeStoredEventType(item.eventType),
      qualityScore: item.qualityScore,
      publishedAt: item.publishedAt,
    })),
  );
  const eventSubject = pickDominantSignatureValue(
    clusterItems.map((item) => ({
      value: normalizeEventSubjectForStorage(item.eventSubject),
      qualityScore: item.qualityScore,
      publishedAt: item.publishedAt,
    })),
  );
  const eventAction = pickDominantSignatureValue(
    clusterItems.map((item) => ({
      value: normalizeEventActionForStorage(item.eventAction),
      qualityScore: item.qualityScore,
      publishedAt: item.publishedAt,
    })),
  );
  const eventObject = pickDominantSignatureValue(
    clusterItems.map((item) => ({
      value: normalizeEventObjectForStorage(item.eventObject),
      qualityScore: item.qualityScore,
      publishedAt: item.publishedAt,
    })),
  );
  const eventDate = pickDominantSignatureValue(
    clusterItems.map((item) => ({
      value: normalizeOptionalText(item.eventDate),
      qualityScore: item.qualityScore,
      publishedAt: item.publishedAt,
    })),
  );

  if (!eventType && !eventSubject && !eventAction && !eventObject && !eventDate) {
    return null;
  }

  return normalizeEventSignatureForStorage({
    eventType,
    eventSubject,
    eventAction,
    eventObject,
    eventDate,
  });
}

export function getClusterAssignmentCandidateSafety(
  item: ItemWithSource,
  eventSignature: AiEventSignature,
  candidate: ClusterAssignmentCandidate,
) {
  const candidateSignature = getCandidateEventSignature(candidate);
  const current = normalizeEventSignatureForMatch(eventSignature);
  const target = normalizeEventSignatureForMatch(candidateSignature);
  const currentDate = normalizeComparableText(current.eventDate);
  const candidateDate = normalizeComparableText(target.eventDate);
  const dateExact = areEventDatesExactlyEqual(currentDate, candidateDate);
  const dateCompatible = areEventDatesCompatibleForClustering(currentDate, candidateDate);
  const preciseDateDrift = Boolean(
    currentDate &&
      candidateDate &&
      !dateExact &&
      getEventDatePrecision(currentDate) === "day" &&
      getEventDatePrecision(candidateDate) === "day",
  );
  const pairSafety = checkClusterMergePairSafety(
    {
      id: item.id,
      title: getDisplayTitle(item.originalTitle, item.translatedTitle),
      summary: buildItemSummary(item),
      fingerprint: "item-assignment",
      eventType: current.eventType,
      eventSubject: current.eventSubject,
      eventAction: current.eventAction,
      eventObject: current.eventObject,
      eventDate: current.eventDate,
      itemCount: 1,
      latestPublishedAt: item.publishedAt,
    },
    {
      id: candidate.id,
      title: candidate.title,
      summary: candidate.summary,
      fingerprint: candidate.fingerprint,
      eventType: target.eventType,
      eventSubject: target.eventSubject,
      eventAction: target.eventAction,
      eventObject: target.eventObject,
      eventDate: target.eventDate,
      itemCount: candidate.itemCount,
      latestPublishedAt: candidate.latestPublishedAt,
    },
  );
  const hardConflict = pairSafety.rejectedReason === "object_conflict" || pairSafety.rejectedReason === "date_conflict";
  return {
    dateCompatible,
    preciseDateDrift,
    hardConflict,
  };
}

export function rankItemAssignmentCandidatesWithBm25(
  item: ItemWithSource,
  eventSignature: AiEventSignature,
  candidates: ClusterAssignmentCandidate[],
) {
  const eligibleCandidates = candidates
    .map((candidate) => ({ candidate, ...getClusterAssignmentCandidateSafety(item, eventSignature, candidate) }))
    .filter((entry) => entry.dateCompatible && !entry.hardConflict);

  if (eligibleCandidates.length === 0) {
    return { eligibleCandidates: [], sparseCandidates: [] };
  }

  const itemDocument = {
    id: `assignment-item:${item.id}`,
    title: getDisplayTitle(item.originalTitle, item.translatedTitle),
    summary: buildItemSummary(item),
    eventSubject: eventSignature.eventSubject ?? null,
    eventObject: eventSignature.eventObject ?? null,
  };
  const clusterDocuments = eligibleCandidates.map(({ candidate }) => ({
    id: candidate.id,
    title: candidate.title,
    summary: candidate.summary,
    eventSubject: candidate.eventSubject,
    eventObject: candidate.eventObject,
  }));
  const index = buildClusterMergeBm25Index([itemDocument, ...clusterDocuments]);
  const rankedCandidates = eligibleCandidates
    .map((entry) => ({
      ...entry,
      score: scoreClusterMergeBm25Pair(index, itemDocument.id, entry.candidate.id),
    }))
    .sort((left, right) =>
      right.score - left.score ||
      right.candidate.latestPublishedAt.getTime() - left.candidate.latestPublishedAt.getTime() ||
      left.candidate.id.localeCompare(right.candidate.id),
    );

  return {
    eligibleCandidates: rankedCandidates,
    sparseCandidates: rankedCandidates.filter((entry) => entry.score > 0),
  };
}

export function rememberRecentCandidate(
  coordinator: ClusterAssignmentCoordinator,
  candidate: ClusterAssignmentCandidate,
  publishedAt: Date,
) {
  for (const cached of coordinator.recentCandidates.values()) {
    if (publishedAt.getTime() < cached.sinceMs || publishedAt.getTime() > cached.untilMs) {
      continue;
    }

    cached.candidates = [candidate, ...cached.candidates.filter((entry) => entry.id !== candidate.id)]
      .sort((left, right) => right.latestPublishedAt.getTime() - left.latestPublishedAt.getTime());
  }
}

function buildEventSignatureLines(eventSignature?: AiEventSignature | null) {
  if (!eventSignature) {
    return [];
  }

  return [
    eventSignature.eventType ? `事件类型：${eventSignature.eventType}` : null,
    eventSignature.eventSubject ? `事件主体：${eventSignature.eventSubject}` : null,
    eventSignature.eventAction ? `事件动作：${eventSignature.eventAction}` : null,
    eventSignature.eventObject ? `关键对象：${eventSignature.eventObject}` : null,
    eventSignature.eventDate ? `事件日期：${eventSignature.eventDate}` : null,
  ].filter(Boolean);
}

export function buildEventDisplayTitle(eventSignature?: AiEventSignature | null) {
  if (!eventSignature?.eventSubject || !eventSignature.eventObject) {
    return "";
  }

  const middle = eventSignature.eventAction || eventSignature.eventType || "";
  return [eventSignature.eventSubject, middle, eventSignature.eventObject].filter(Boolean).join(" ");
}

export function buildClusterMatchInput(
  item: ItemWithSource,
  options: { eventSignature?: AiEventSignature | null },
): string {
  return [
    ...buildEventSignatureLines(options.eventSignature),
    buildItemSummary(item) ? `摘要：${buildItemSummary(item)}` : null,
    `来源：${item.source.name}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildClusterFallback(
  clusterItems: ItemWithSource[],
  existingTitle?: string,
  options?: { preferEventTitleFallback?: boolean },
) {
  const primary = clusterItems[0]!;
  const eventTitle = options?.preferEventTitleFallback
    ? buildEventDisplayTitle(buildClusterEventSignature(clusterItems))
    : "";
  const title = eventTitle || existingTitle || getDisplayTitle(primary.originalTitle, primary.translatedTitle);

  if (clusterItems.length === 1) {
    return {
      title,
      summary: buildItemSummary(primary),
    };
  }

  return {
    title,
    summary: clusterItems
      .slice(0, 2)
      .map((item) => buildItemSummary(item))
      .filter(Boolean)
      .join(" "),
  };
}

function normalizePresentationTitle(value: string | null | undefined, fallback: string) {
  const title = value
    ?.replace(/[\r\n]+/g, " ")
    .replace(/^#+\s*/, "")
    .trim();

  return title || fallback;
}

const CLUSTER_PRESENTATION_REASONING_MARKERS = [
  "分析请求",
  "分析候选内容",
  "提炼共同事件",
  "撰写 title",
  "撰写 summary",
  "输出格式",
  "最终输出",
];

const CLUSTER_TITLE_MAX_LENGTH = 80;
const CLUSTER_SUMMARY_MAX_LENGTH = 400;

// 超长按句子边界截断（保留至少约 60 字符的合理句读），无合适句读时硬切。
function truncateAtSentenceBoundary(text: string, maxLength: number) {
  if (text.length <= maxLength) {
    return text;
  }

  const window = text.slice(0, maxLength);
  const sentenceEnd = Math.max(
    window.lastIndexOf("。"),
    window.lastIndexOf("！"),
    window.lastIndexOf("？"),
    window.lastIndexOf("；"),
    window.lastIndexOf("…"),
  );

  return sentenceEnd >= 60 ? window.slice(0, sentenceEnd + 1) : window;
}

// 截断可能落在 ** 或 * 强调标记内部，移除未闭合的标记避免渲染出持续加粗/斜体。
function balanceEmphasisMarkers(text: string) {
  let result = text;
  const doubleCount = (result.match(/\*\*/g) || []).length;

  if (doubleCount % 2 === 1) {
    const lastOpen = result.lastIndexOf("**");
    result = result.slice(0, lastOpen) + result.slice(lastOpen + 2);
  }

  const singlePattern = /(?<!\*)\*(?!\*)/g;
  const singleCount = (result.match(singlePattern) || []).length;

  if (singleCount % 2 === 1) {
    let match: RegExpExecArray | null;
    let lastSingle = -1;
    singlePattern.lastIndex = 0;

    while ((match = singlePattern.exec(result)) !== null) {
      lastSingle = match.index;
    }

    if (lastSingle >= 0) {
      result = result.slice(0, lastSingle) + result.slice(lastSingle + 1);
    }
  }

  return result;
}

function isAcceptableClusterPresentation(value: { title: string; summary: string }) {
  const title = value.title.trim();
  const summary = value.summary.trim();
  const normalizedSummary = summary.toLowerCase();

  if (!title || !summary) {
    return false;
  }

  return !CLUSTER_PRESENTATION_REASONING_MARKERS.some((marker) => normalizedSummary.includes(marker));
}

function parseClusterPresentationOutput(
  rawContent: string | null | undefined,
  fallback: { title: string; summary: string },
) {
  const normalized = rawContent?.trim() ?? "";

  if (!normalized) {
    return null;
  }

  try {
    const parsed = JSON.parse(normalized) as {
      title?: string | null;
      summary?: string | null;
    };

    const presentation = {
      title: normalizePresentationTitle(parsed.title, fallback.title),
      summary: parsed.summary?.trim() || fallback.summary,
    };

    if (!isAcceptableClusterPresentation(presentation)) {
      return null;
    }

    // 长度超标不再整条拒绝：句子边界截断后采用，避免模型输出偏长时丢弃可用摘要。
    return {
      title: presentation.title.slice(0, CLUSTER_TITLE_MAX_LENGTH),
      summary: balanceEmphasisMarkers(truncateAtSentenceBoundary(presentation.summary, CLUSTER_SUMMARY_MAX_LENGTH)),
    };
  } catch {
    return null;
  }
}

type ClusterSummaryProvider = Pick<AiProvider, "summarizeCluster">;

function shouldGenerateAiClusterSummary(clusterItems: ItemWithSource[], aiProvider?: ClusterSummaryProvider) {
  return Boolean(aiProvider) && clusterItems.length >= 2;
}

function buildClusterSummarySeed(clusterItems: ItemWithSource[]) {
  return clusterItems
    .map((item, index) =>
      [
        `候选 ${index + 1}`,
        `标题：${getDisplayTitle(item.originalTitle, item.translatedTitle)}`,
        buildItemSummary(item) ? `摘要：${buildItemSummary(item)}` : null,
        ...buildEventSignatureLines(getItemEventSignature(item)),
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n");
}

export function buildClusterSummaryInputHash(clusterItems: ItemWithSource[]) {
  const seed = buildClusterSummarySeed(clusterItems);

  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ seed }))
    .digest("hex");
}

export async function generateClusterPresentation(
  clusterItems: ItemWithSource[],
  existingTitle?: string,
  aiProvider?: ClusterSummaryProvider,
  options?: { preferEventTitleFallback?: boolean },
) {
  const fallback = buildClusterFallback(clusterItems, existingTitle, options);

  if (!shouldGenerateAiClusterSummary(clusterItems, aiProvider)) {
    return {
      ...fallback,
      summaryAttempted: false,
      summarySucceeded: false,
    };
  }

  const summaryProvider = aiProvider!;

  try {
    const summarySeed = buildClusterSummarySeed(clusterItems);

    let aiPresentation = parseClusterPresentationOutput(
      await summaryProvider.summarizeCluster(summarySeed, { title: fallback.title }),
      fallback,
    );
    if (!aiPresentation) {
      return {
        ...fallback,
        summaryAttempted: true,
        summarySucceeded: false,
      };
    }
    if (shouldRegenerateChineseSummary(aiPresentation.summary)) {
      aiPresentation = parseClusterPresentationOutput(
        await summaryProvider.summarizeCluster(summarySeed, { title: fallback.title }),
        fallback,
      );
    }
    if (!aiPresentation || shouldRegenerateChineseSummary(aiPresentation.summary)) {
      return {
        ...fallback,
        summaryAttempted: true,
        summarySucceeded: false,
      };
    }
    const useAiPresentation =
      Boolean(aiPresentation.summary.trim()) &&
      (aiPresentation.title !== fallback.title || aiPresentation.summary !== fallback.summary);

    return {
      title: useAiPresentation ? aiPresentation.title : fallback.title,
      summary: useAiPresentation ? aiPresentation.summary : fallback.summary,
      summaryAttempted: true,
      summarySucceeded: useAiPresentation,
    };
  } catch {
    return {
      ...fallback,
      summaryAttempted: true,
      summarySucceeded: false,
    };
  }
}

type ClusterMergeInputHashSeed = {
  id: string;
  fingerprint: string;
  title?: string | null;
  summary?: string | null;
  eventType?: string | null;
  eventSubject?: string | null;
  eventAction?: string | null;
  eventObject?: string | null;
  eventDate?: string | null;
  itemCount: number;
  latestPublishedAt: Date;
};

function buildClusterMergeInputHashPayload(c: ClusterMergeInputHashSeed) {
  const signature = getCandidateEventSignature(c);

  return {
    id: c.id,
    fingerprint: c.fingerprint,
    title: c.title ?? null,
    summary: c.summary ?? null,
    eventType: signature.eventType,
    eventSubject: signature.eventSubject,
    eventAction: signature.eventAction,
    eventObject: signature.eventObject,
    eventDate: signature.eventDate,
    itemCount: c.itemCount,
    latestPublishedAt: c.latestPublishedAt.getTime(),
  };
}

export function buildClusterMergeCandidateInputHash(cluster: ClusterMergeInputHashSeed): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(buildClusterMergeInputHashPayload(cluster)))
    .digest("hex");
}

export type ClusterMergeCandidate = {
  id: string;
  title: string;
  summary: string;
  fingerprint: string;
  mergeInputHash?: string | null;
  eventFingerprint?: string | null;
  eventType: string | null;
  eventSubject: string | null;
  eventAction: string | null;
  eventObject: string | null;
  eventDate: string | null;
  itemCount: number;
  latestPublishedAt: Date;
};

export type ClusterMergeSelectionPath = "live" | "precomputed_cache";
export type ClusterMergeRecallChannel = "bm25" | "vector" | "event_fingerprint" | "unknown";

export type ClusterMergeCandidateEdge = {
  leftId: string;
  rightId: string;
  score: number;
  selectionPaths?: ClusterMergeSelectionPath[];
  recallChannels?: ClusterMergeRecallChannel[];
  bm25Score?: number | null;
  vectorSimilarity?: number | null;
  cachePriorityScore?: number | null;
};

function tokenizeMergeText(value: string | null | undefined) {
  const normalized = normalizeComparableText(value);
  const words = normalized.match(/[a-z0-9]+|[\u4e00-\u9fff]+/g) ?? [];
  const tokens = new Set<string>();

  for (const word of words) {
    if (/^[\u4e00-\u9fff]+$/u.test(word)) {
      if (word.length <= 2) {
        tokens.add(word);
        continue;
      }

      for (let index = 0; index < word.length - 1; index += 1) {
        tokens.add(word.slice(index, index + 2));
      }
      continue;
    }

    if (word.length >= 2) {
      tokens.add(word);
    }
  }

  return tokens;
}

function countTokenOverlap(left: Set<string>, right: Set<string>) {
  let overlap = 0;

  for (const token of left) {
    if (right.has(token)) {
      overlap += 1;
    }
  }

  return overlap;
}

function textSimilarity(left: string | null | undefined, right: string | null | undefined) {
  const leftText = normalizeComparableText(left);
  const rightText = normalizeComparableText(right);

  if (!leftText || !rightText) {
    return {
      exact: false,
      similar: false,
      strong: false,
      overlap: 0,
    };
  }

  if (leftText === rightText) {
    return {
      exact: true,
      similar: true,
      strong: true,
      overlap: Math.max(1, tokenizeMergeText(leftText).size),
    };
  }

  const includes = leftText.includes(rightText) || rightText.includes(leftText);
  const leftTokens = tokenizeMergeText(leftText);
  const rightTokens = tokenizeMergeText(rightText);
  const overlap = countTokenOverlap(leftTokens, rightTokens);
  const strongOverlap = overlap >= 2;
  const weakOverlap = overlap >= 1 && (leftTokens.size <= 2 || rightTokens.size <= 2);

  return {
    exact: false,
    similar: includes || strongOverlap || weakOverlap,
    strong: includes || strongOverlap,
    overlap,
  };
}

function buildMergeTextBlob(candidate: ClusterMergeCandidate) {
  return [
    candidate.title,
    candidate.summary,
    candidate.eventSubject,
    candidate.eventObject,
  ]
    .filter(Boolean)
    .join(" ");
}

const RELATIONAL_OBJECT_TOKENS = new Set(["合同", "协议", "合作", "交易", "收购", "融资", "投资", "诉讼", "政策"]);
const MULTI_SUBJECT_BRIDGE_MAX_PUBLISHED_DIFF_MS = 24 * 60 * 60 * 1000;
const MULTI_SUBJECT_BRIDGE_MIN_DISTINCTIVE_OVERLAP = 3;
const MULTI_SUBJECT_BRIDGE_SCORE_BONUS = 15;
const COMMON_MERGE_TOKENS = new Set([
  "发布",
  "推出",
  "上线",
  "更新",
  "变更",
  "调整",
  "宣布",
  "报道",
  "消息",
  "产品",
  "功能",
  "服务",
  "平台",
  "公司",
  "新闻",
  "内容",
  "new",
  "launch",
  "launched",
  "release",
  "released",
  "update",
  "updates",
  "announces",
  "announced",
]);

function hasRelationalObjectOverlap(left: string | null, right: string | null) {
  if (!left || !right) {
    return false;
  }

  const leftTokens = tokenizeMergeText(left);
  const rightTokens = tokenizeMergeText(right);

  for (const token of leftTokens) {
    if (rightTokens.has(token) && RELATIONAL_OBJECT_TOKENS.has(token)) {
      return true;
    }
  }

  return false;
}

function buildExcludedMergeTokens(values: Array<string | null | undefined>) {
  const tokens = new Set<string>(COMMON_MERGE_TOKENS);

  for (const value of values) {
    for (const token of tokenizeMergeText(value)) {
      tokens.add(token);
    }
  }

  return tokens;
}

function countDistinctiveTextOverlap(
  left: ClusterMergeCandidate,
  right: ClusterMergeCandidate,
  excludedTokens: Set<string>,
) {
  const leftTokens = tokenizeMergeText(buildMergeTextBlob(left));
  const rightTokens = tokenizeMergeText(buildMergeTextBlob(right));
  let overlap = 0;

  for (const token of leftTokens) {
    if (!excludedTokens.has(token) && rightTokens.has(token)) {
      overlap += 1;
    }
  }

  return overlap;
}

function hasSubjectObjectRoleOverlap(
  leftSubject: string | null,
  rightSubject: string | null,
  leftObject: string | null,
  rightObject: string | null,
) {
  return textSimilarity(leftSubject, rightObject).similar || textSimilarity(rightSubject, leftObject).similar;
}

function hasUnrelatedNamedSubjects(
  leftSubject: string | null,
  rightSubject: string | null,
  leftObject: string | null,
  rightObject: string | null,
  subjectSimilarity: ReturnType<typeof textSimilarity>,
  objectSimilarity: ReturnType<typeof textSimilarity>,
) {
  return Boolean(leftSubject && rightSubject) &&
    !subjectSimilarity.similar &&
    !objectSimilarity.similar &&
    !hasSubjectObjectRoleOverlap(leftSubject, rightSubject, leftObject, rightObject);
}

function hasCompatibleMergeAction(
  leftAction: string | null,
  rightAction: string | null,
  leftEventType: string | null,
  rightEventType: string | null,
) {
  if (!leftAction || !rightAction) {
    return true;
  }

  if (leftAction === rightAction || (leftEventType && rightEventType && leftEventType === rightEventType)) {
    return true;
  }

  const leftTokens = tokenizeMergeText(leftAction);
  const rightTokens = tokenizeMergeText(rightAction);
  if (countTokenOverlap(leftTokens, rightTokens) > 0) {
    return true;
  }

  const negativeActionTokens = ["否认", "辟谣", "取消", "终止", "撤回", "暂停", "下架", "deny", "cancel", "terminate"];
  const leftNegative = negativeActionTokens.some((token) => leftAction.includes(token));
  const rightNegative = negativeActionTokens.some((token) => rightAction.includes(token));

  return leftNegative === rightNegative;
}

function isMultiSubjectBridgePair(input: {
  left: ClusterMergeCandidate;
  right: ClusterMergeCandidate;
  leftSubject: string | null;
  rightSubject: string | null;
  leftAction: string | null;
  rightAction: string | null;
  leftObject: string | null;
  rightObject: string | null;
  subjectSimilarity: ReturnType<typeof textSimilarity>;
  textOverlap: ReturnType<typeof textSimilarity>;
  distinctiveTextOverlapCount: number;
}) {
  const {
    left,
    right,
    leftSubject,
    rightSubject,
    leftAction,
    rightAction,
    leftObject,
    rightObject,
    subjectSimilarity,
    textOverlap,
    distinctiveTextOverlapCount,
  } = input;
  const bothSubjectsPresent = Boolean(leftSubject && rightSubject);
  const hasDifferentSubject =
    bothSubjectsPresent ? !subjectSimilarity.similar : Boolean(leftSubject || rightSubject);

  if (!hasDifferentSubject) {
    return false;
  }

  const publishedAtDiffMs = Math.abs(left.latestPublishedAt.getTime() - right.latestPublishedAt.getTime());
  if (publishedAtDiffMs > MULTI_SUBJECT_BRIDGE_MAX_PUBLISHED_DIFF_MS) {
    return false;
  }

  if (!textOverlap.strong || distinctiveTextOverlapCount < MULTI_SUBJECT_BRIDGE_MIN_DISTINCTIVE_OVERLAP) {
    return false;
  }

  if (!hasCompatibleMergeAction(leftAction, rightAction, left.eventType, right.eventType)) {
    return false;
  }

  return textSimilarity(leftObject, rightObject).similar ||
    hasSubjectObjectRoleOverlap(leftSubject, rightSubject, leftObject, rightObject);
}

type ClusterMergePairRejectionReason = "object_conflict" | "date_conflict" | "no_event_anchor" | "unrelated_subjects";

type ClusterMergePairScore = {
  rejected: boolean;
  rejectedReason: ClusterMergePairRejectionReason | null;
  score: number;
};

export type ClusterMergeCandidateDiagnostics = {
  totalPairs: number;
  rejectedObjectConflict: number;
  rejectedDateConflict: number;
  rejectedNoEventAnchor: number;
  belowGrayScore: number;
  relatedPairs: number;
  aiEligiblePairs: number;
  cleanPairsSkipped: number;
  dirtyPairs: number;
  preLimitCandidates: number;
  postLimitCandidates: number;
  dirtyCandidateCount: number;
};

function createClusterMergeCandidateDiagnostics(): ClusterMergeCandidateDiagnostics {
  return {
    totalPairs: 0,
    rejectedObjectConflict: 0,
    rejectedDateConflict: 0,
    rejectedNoEventAnchor: 0,
    belowGrayScore: 0,
    relatedPairs: 0,
    aiEligiblePairs: 0,
    cleanPairsSkipped: 0,
    dirtyPairs: 0,
    preLimitCandidates: 0,
    postLimitCandidates: 0,
    dirtyCandidateCount: 0,
  };
}

function scoreClusterMergePair(left: ClusterMergeCandidate, right: ClusterMergeCandidate): ClusterMergePairScore {
  const leftSignature = getCandidateEventSignature(left);
  const rightSignature = getCandidateEventSignature(right);
  const leftSubject = leftSignature.eventSubject;
  const rightSubject = rightSignature.eventSubject;
  const leftAction = leftSignature.eventAction ?? leftSignature.eventType;
  const rightAction = rightSignature.eventAction ?? rightSignature.eventType;
  const leftObject = leftSignature.eventObject;
  const rightObject = rightSignature.eventObject;
  const leftDate = leftSignature.eventDate;
  const rightDate = rightSignature.eventDate;
  const subjectSimilarity = textSimilarity(leftSubject, rightSubject);
  const objectSimilarity = textSimilarity(leftObject, rightObject);
  const textOverlap = textSimilarity(buildMergeTextBlob(left), buildMergeTextBlob(right));
  const relationalObjectOverlap = hasRelationalObjectOverlap(leftObject, rightObject);
  const distinctiveTextOverlapCount = countDistinctiveTextOverlap(
    left,
    right,
    buildExcludedMergeTokens([leftSubject, rightSubject, leftAction, rightAction]),
  );
  const distinctiveTextOverlap = distinctiveTextOverlapCount > 0;
  const multiSubjectBridge = isMultiSubjectBridgePair({
    left,
    right,
    leftSubject,
    rightSubject,
    leftAction,
    rightAction,
    leftObject,
    rightObject,
    subjectSimilarity,
    textOverlap,
    distinctiveTextOverlapCount,
  });

  if (hasUnrelatedNamedSubjects(leftSubject, rightSubject, leftObject, rightObject, subjectSimilarity, objectSimilarity)) {
    return {
      rejected: true,
      rejectedReason: "unrelated_subjects",
      score: 0,
    };
  }

  // Date conflict used to hard-reject the pair. With a time-free event
  // fingerprint as the identity anchor, noisy event dates (AI mis-extraction,
  // e.g. 2025 vs 2026) must not block merging genuinely same-signature events.
  // Instead we keep the pair alive and let the AI verdict decide; the score
  // simply loses the date bonus below.
  const dateConflict =
    Boolean(leftDate && rightDate && !areEventDatesCompatibleForClustering(leftDate, rightDate));

  if (leftObject && rightObject && !objectSimilarity.strong && !relationalObjectOverlap && !multiSubjectBridge) {
    return {
      rejected: true,
      rejectedReason: "object_conflict",
      score: 0,
    };
  }

  let score = 0;

  if (subjectSimilarity.similar) {
    score += 35;
  }

  if (objectSimilarity.similar) {
    score += 40;
  }

  if (leftAction && rightAction && leftAction === rightAction) {
    score += 20;
  } else if (leftSignature.eventType && rightSignature.eventType && leftSignature.eventType === rightSignature.eventType) {
    score += 12;
  }

  if (leftDate && rightDate && areEventDatesExactlyEqual(leftDate, rightDate)) {
    score += 15;
  } else if (leftDate && rightDate && areEventDatesCompatibleForClustering(leftDate, rightDate)) {
    score += 6;
  } else if (dateConflict) {
    // Soft negative signal: noisy/conflicting dates alone must not veto the
    // pair, but a real date disagreement lowers the candidate's priority.
    score -= 12;
  }

  if (textOverlap.strong) {
    score += 20;
  } else if (textOverlap.similar) {
    score += 8;
  }

  const publishedAtDiffMs = Math.abs(left.latestPublishedAt.getTime() - right.latestPublishedAt.getTime());
  if (publishedAtDiffMs <= 24 * 60 * 60 * 1000) {
    score += 8;
  } else if (publishedAtDiffMs <= 72 * 60 * 60 * 1000) {
    score += 4;
  }

  if (multiSubjectBridge) {
    score += MULTI_SUBJECT_BRIDGE_SCORE_BONUS;
  }

  const hasEventAnchor = objectSimilarity.similar || distinctiveTextOverlap || multiSubjectBridge;
  if (!hasEventAnchor) {
    return {
      rejected: true,
      rejectedReason: "no_event_anchor",
      score,
    };
  }

  return {
    rejected: false,
    rejectedReason: null,
    score,
  };
}

export function scoreClusterMergeCandidatePair(left: ClusterMergeCandidate, right: ClusterMergeCandidate) {
  // Kept as the legacy scorer for offline comparisons.
  return scoreClusterMergePair(left, right);
}

export function checkClusterMergePairSafety(
  left: ClusterMergeCandidate,
  right: ClusterMergeCandidate,
): Pick<ClusterMergePairScore, "rejected" | "rejectedReason"> {
  const leftSignature = getCandidateEventSignature(left);
  const rightSignature = getCandidateEventSignature(right);
  const leftSubject = leftSignature.eventSubject;
  const rightSubject = rightSignature.eventSubject;
  const leftAction = leftSignature.eventAction ?? leftSignature.eventType;
  const rightAction = rightSignature.eventAction ?? rightSignature.eventType;
  const leftObject = leftSignature.eventObject;
  const rightObject = rightSignature.eventObject;
  const subjectSimilarity = textSimilarity(leftSubject, rightSubject);
  const objectSimilarity = textSimilarity(leftObject, rightObject);
  const textOverlap = textSimilarity(buildMergeTextBlob(left), buildMergeTextBlob(right));
  const relationalObjectOverlap = hasRelationalObjectOverlap(leftObject, rightObject);
  const distinctiveTextOverlapCount = countDistinctiveTextOverlap(
    left,
    right,
    buildExcludedMergeTokens([leftSubject, rightSubject, leftAction, rightAction]),
  );
  const multiSubjectBridge = isMultiSubjectBridgePair({
    left,
    right,
    leftSubject,
    rightSubject,
    leftAction,
    rightAction,
    leftObject,
    rightObject,
    subjectSimilarity,
    textOverlap,
    distinctiveTextOverlapCount,
  });

  if (hasUnrelatedNamedSubjects(leftSubject, rightSubject, leftObject, rightObject, subjectSimilarity, objectSimilarity)) {
    return { rejected: true, rejectedReason: "unrelated_subjects" as const };
  }

  if (leftObject && rightObject && !objectSimilarity.strong && !relationalObjectOverlap && !multiSubjectBridge) {
    return { rejected: true, rejectedReason: "object_conflict" as const };
  }

  const hasEventAnchor = objectSimilarity.similar || distinctiveTextOverlapCount > 0 || multiSubjectBridge;
  return hasEventAnchor
    ? { rejected: false, rejectedReason: null }
    : { rejected: true, rejectedReason: "no_event_anchor" as const };
}

export function getClusterMergePairAuditSignals(left: ClusterMergeCandidate, right: ClusterMergeCandidate) {
  const leftSignature = getCandidateEventSignature(left);
  const rightSignature = getCandidateEventSignature(right);
  const leftSubject = leftSignature.eventSubject;
  const rightSubject = rightSignature.eventSubject;
  const leftAction = leftSignature.eventAction ?? leftSignature.eventType;
  const rightAction = rightSignature.eventAction ?? rightSignature.eventType;
  const leftObject = leftSignature.eventObject;
  const rightObject = rightSignature.eventObject;
  const leftDate = leftSignature.eventDate;
  const rightDate = rightSignature.eventDate;
  const subject = textSimilarity(leftSubject, rightSubject);
  const object = textSimilarity(leftObject, rightObject);
  const textOverlap = textSimilarity(buildMergeTextBlob(left), buildMergeTextBlob(right));
  const distinctiveTextOverlapCount = countDistinctiveTextOverlap(
    left,
    right,
    buildExcludedMergeTokens([leftSubject, rightSubject, leftAction, rightAction]),
  );
  const multiSubjectBridge = isMultiSubjectBridgePair({
    left,
    right,
    leftSubject,
    rightSubject,
    leftAction,
    rightAction,
    leftObject,
    rightObject,
    subjectSimilarity: subject,
    textOverlap,
    distinctiveTextOverlapCount,
  });

  return {
    subject,
    object,
    textOverlap,
    actionMatch: Boolean(leftAction && rightAction && leftAction === rightAction),
    eventTypeMatch: Boolean(leftSignature.eventType && rightSignature.eventType && leftSignature.eventType === rightSignature.eventType),
    dateConflict: Boolean(leftDate && rightDate && !areEventDatesCompatibleForClustering(leftDate, rightDate)),
    dateCompatible: leftDate && rightDate ? areEventDatesCompatibleForClustering(leftDate, rightDate) : null,
    distinctiveTextOverlapCount,
    multiSubjectBridge,
    safety: checkClusterMergePairSafety(left, right),
  };
}

type ClusterMergeNeighborMeta = {
  cluster: ClusterMergeCandidate;
  dirty: boolean;
};

function toClusterMergeNeighborMeta(
  cluster: ClusterMergeCandidate,
  dirtyIds: Set<string>,
): ClusterMergeNeighborMeta {
  return { cluster, dirty: dirtyIds.has(cluster.id) };
}

function sortClusterMergeLiveNeighbors(
  left: ClusterMergeNeighborMeta,
  neighbors: ClusterMergeNeighborMeta[],
  bm25Index: ReturnType<typeof buildClusterMergeBm25Index>,
) {
  return neighbors
    .map((neighbor) => ({
      neighbor,
      score: scoreClusterMergeBm25Pair(bm25Index, left.cluster.id, neighbor.cluster.id),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }

      const leftPublishedAt = a.neighbor.cluster.latestPublishedAt.getTime();
      const rightPublishedAt = b.neighbor.cluster.latestPublishedAt.getTime();
      if (rightPublishedAt !== leftPublishedAt) {
        return rightPublishedAt - leftPublishedAt;
      }

      return a.neighbor.cluster.id.localeCompare(b.neighbor.cluster.id);
    })
    .map(({ neighbor }) => neighbor);
}

function selectClusterMergeLiveNeighbors(
  left: ClusterMergeNeighborMeta,
  metas: ClusterMergeNeighborMeta[],
  bm25Index: ReturnType<typeof buildClusterMergeBm25Index>,
) {
  const neighbors = metas.filter((meta) => meta.cluster.id !== left.cluster.id);
  if (neighbors.length <= CLUSTER_MERGE_DIRTY_NEIGHBOR_SCAN_LIMIT) {
    return neighbors;
  }

  const dirtyNeighbors = sortClusterMergeLiveNeighbors(left, neighbors.filter((meta) => meta.dirty), bm25Index);
  const cleanNeighbors = sortClusterMergeLiveNeighbors(left, neighbors.filter((meta) => !meta.dirty), bm25Index);
  const dirtyBudget = Math.min(dirtyNeighbors.length, Math.ceil(CLUSTER_MERGE_DIRTY_NEIGHBOR_SCAN_LIMIT / 2));
  const cleanBudget = Math.min(cleanNeighbors.length, CLUSTER_MERGE_DIRTY_NEIGHBOR_SCAN_LIMIT - dirtyBudget);
  const selected = [
    ...dirtyNeighbors.slice(0, dirtyBudget),
    ...cleanNeighbors.slice(0, cleanBudget),
  ];

  if (selected.length >= CLUSTER_MERGE_DIRTY_NEIGHBOR_SCAN_LIMIT) {
    return selected;
  }

  const selectedIds = new Set(selected.map((meta) => meta.cluster.id));
  const remaining = sortClusterMergeLiveNeighbors(
    left,
    [...dirtyNeighbors, ...cleanNeighbors].filter((meta) => !selectedIds.has(meta.cluster.id)),
    bm25Index,
  );

  return [
    ...selected,
    ...remaining.slice(0, CLUSTER_MERGE_DIRTY_NEIGHBOR_SCAN_LIMIT - selected.length),
  ];
}

function incrementClusterMergeRejection(
  diagnostics: ClusterMergeCandidateDiagnostics,
  reason: ClusterMergePairRejectionReason | null,
) {
  switch (reason) {
    case "object_conflict":
      diagnostics.rejectedObjectConflict += 1;
      break;
    case "date_conflict":
      diagnostics.rejectedDateConflict += 1;
      break;
    case "no_event_anchor":
    case "unrelated_subjects":
      diagnostics.rejectedNoEventAnchor += 1;
      break;
    default:
      break;
  }
}

export function buildClusterMergeEdgeKey(leftId: string, rightId: string) {
  return [leftId, rightId].sort().join("\u0000");
}

export function buildClusterMergeCleanPairKey(
  left: ClusterMergeCandidate,
  right: ClusterMergeCandidate,
) {
  const pair = [
    {
      id: left.id,
      inputHash: buildClusterMergeCandidateInputHash(left),
    },
    {
      id: right.id,
      inputHash: buildClusterMergeCandidateInputHash(right),
    },
  ].sort((a, b) => a.id.localeCompare(b.id));

  const contentHash = crypto.createHash("sha256").update(JSON.stringify(pair)).digest("hex");
  return `${CLUSTER_MERGE_BM25_CACHE_VERSION}:${contentHash}`;
}

function mergeClusterMergeCandidateEdgeAttribution(
  existing: ClusterMergeCandidateEdge,
  incoming: ClusterMergeCandidateEdge,
): ClusterMergeCandidateEdge {
  return {
    ...existing,
    score: Math.max(existing.score, incoming.score),
    selectionPaths: [...new Set([...(existing.selectionPaths ?? []), ...(incoming.selectionPaths ?? [])])],
    recallChannels: [...new Set([...(existing.recallChannels ?? []), ...(incoming.recallChannels ?? [])])],
    bm25Score: existing.bm25Score ?? incoming.bm25Score ?? null,
    vectorSimilarity: existing.vectorSimilarity ?? incoming.vectorSimilarity ?? null,
    cachePriorityScore: existing.cachePriorityScore ?? incoming.cachePriorityScore ?? null,
  };
}

export function hasClusterMergeCandidateEdge(
  edges: ClusterMergeCandidateEdge[],
  leftId: string,
  rightId: string,
) {
  const key = buildClusterMergeEdgeKey(leftId, rightId);
  return edges.some((edge) => buildClusterMergeEdgeKey(edge.leftId, edge.rightId) === key);
}

export function filterClusterMergeSourcesByAllowedEdges(
  targetId: string,
  sourceIds: string[],
  edges: ClusterMergeCandidateEdge[],
) {
  return sourceIds.filter((sourceId) => hasClusterMergeCandidateEdge(edges, targetId, sourceId));
}

export function buildClusterMergeCandidateSelection(
  clusters: ClusterMergeCandidate[],
  options?: {
    liveClusterIds?: Iterable<string>;
    /** 向量近邻（调用方按 sim 准入线过滤后注入）：强制并入 dirty 聚类的邻居扫描，绕过词汇排名截断 */
    vectorNeighbors?: ReadonlyMap<string, ReadonlyArray<{ id: string; sim: number }>>;
  },
) {
  const selectedIds = new Set<string>();
  const bestScores = new Map<string, number>();
  const selectedEdges = new Map<string, ClusterMergeCandidateEdge>();
  const currentInputHashes = new Map(
    clusters.map((cluster) => [cluster.id, buildClusterMergeCandidateInputHash(cluster)]),
  );
  const liveClusterIds = options?.liveClusterIds ? new Set(options.liveClusterIds) : null;
  const liveIds = liveClusterIds ?? new Set(
    clusters
      .filter((cluster) => cluster.mergeInputHash !== currentInputHashes.get(cluster.id))
      .map((cluster) => cluster.id),
  );
  const metas = clusters.map((cluster) => toClusterMergeNeighborMeta(cluster, liveIds));
  const bm25Index = buildClusterMergeBm25Index(clusters);
  const diagnostics = createClusterMergeCandidateDiagnostics();
  const liveClusterCount = metas.filter((meta) => meta.dirty).length;
  const cleanClusterCount = clusters.length - liveClusterCount;
  diagnostics.cleanPairsSkipped = cleanClusterCount * Math.max(0, cleanClusterCount - 1);

  // Group clusters by event fingerprint once; same-signature clusters are the
  // same event and MUST be paired regardless of the neighbor-scan truncation.
  const byEventFp = new Map<string, ClusterMergeCandidate[]>();
  for (const cluster of clusters) {
    if (!cluster.eventFingerprint) continue;
    const list = byEventFp.get(cluster.eventFingerprint);
    if (list) list.push(cluster);
    else byEventFp.set(cluster.eventFingerprint, [cluster]);
  }

  // Same-event-signature clusters are the same event and MUST meet even when
  // they are clean (already-marked) or truncated by the neighbor scan. This
  // prevents fragmentation where single-*/pending-* clusters never pair.
  for (const list of byEventFp.values()) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const left = list[i]!;
        const right = list[j]!;
        const safety = checkClusterMergePairSafety(left, right);
        diagnostics.totalPairs += 1;
        if (safety.rejected) {
          incrementClusterMergeRejection(diagnostics, safety.rejectedReason);
          continue;
        }
        const bm25Score = scoreClusterMergeBm25Pair(bm25Index, left.id, right.id);
        const edge: ClusterMergeCandidateEdge = {
          leftId: left.id,
          rightId: right.id,
          score: bm25Score,
          selectionPaths: ["live"],
          recallChannels: ["event_fingerprint"],
          bm25Score,
          vectorSimilarity: null,
        };
        const edgeKey = buildClusterMergeEdgeKey(left.id, right.id);
        const existingEdge = selectedEdges.get(edgeKey);
        selectedIds.add(left.id);
        selectedIds.add(right.id);
        bestScores.set(left.id, Math.max(bestScores.get(left.id) ?? 0, edge.score));
        bestScores.set(right.id, Math.max(bestScores.get(right.id) ?? 0, edge.score));
        selectedEdges.set(edgeKey, existingEdge ? mergeClusterMergeCandidateEdgeAttribution(existingEdge, edge) : edge);
      }
    }
  }

  for (const leftMeta of metas.filter((meta) => meta.dirty)) {
    const left = leftMeta.cluster;
    const relatedPairs: Array<{
      right: ClusterMergeCandidate;
      score: number;
      bm25Score: number;
      vectorSimilarity: number | null;
      recallChannels: ClusterMergeRecallChannel[];
    }> = [];

    const scannedNeighbors = selectClusterMergeLiveNeighbors(leftMeta, metas, bm25Index);
    const forcedVector = options?.vectorNeighbors?.get(left.id);
    const vectorSimById = new Map((forcedVector ?? []).map(({ id, sim }) => [id, sim]));
    let neighbors = scannedNeighbors;
    if (forcedVector && forcedVector.length > 0) {
      const scannedIds = new Set(scannedNeighbors.map((meta) => meta.cluster.id));
      const forced = forcedVector
        .map(({ id, sim }) => ({ meta: metas.find((meta) => meta.cluster.id === id), sim }))
        .filter((entry): entry is { meta: ClusterMergeNeighborMeta; sim: number } =>
          Boolean(entry.meta) && !scannedIds.has(entry.meta!.cluster.id))
        .map(({ meta }) => meta);
      if (forced.length > 0) {
        neighbors = [...scannedNeighbors, ...forced];
      }
    }

    for (const rightMeta of neighbors) {
      const right = rightMeta.cluster;

      const safety = checkClusterMergePairSafety(left, right);
      const bm25Score = scoreClusterMergeBm25Pair(bm25Index, left.id, right.id);
      const vectorSim = vectorSimById.get(right.id) ?? null;
      diagnostics.totalPairs += 1;

      const vectorAdmitted = vectorSim !== null && vectorSim >= CLUSTER_MERGE_VECTOR_GRAY_SIM;
      if (safety.rejected && !vectorAdmitted) {
        incrementClusterMergeRejection(diagnostics, safety.rejectedReason);
        continue;
      }

      if (!safety.rejected && bm25Score <= 0 && !vectorAdmitted) {
        diagnostics.belowGrayScore += 1;
        continue;
      }

      diagnostics.relatedPairs += 1;
      relatedPairs.push({
        right,
        score: Math.max(bm25Score, vectorSim === null ? 0 : Math.round(vectorSim * 100) * CLUSTER_MERGE_BM25_SCORE_SCALE),
        bm25Score,
        vectorSimilarity: vectorSim,
        recallChannels: [
          ...(!safety.rejected && bm25Score > 0 ? ["bm25" as const] : []),
          ...(vectorAdmitted ? ["vector" as const] : []),
        ],
      });
    }

    for (const pair of relatedPairs
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }

        return right.right.latestPublishedAt.getTime() - left.right.latestPublishedAt.getTime();
      })
      .slice(0, CLUSTER_MERGE_RELATED_PAIR_LIMIT)) {
      const edgeKey = buildClusterMergeEdgeKey(left.id, pair.right.id);
      const existingEdge = selectedEdges.get(edgeKey);
      diagnostics.aiEligiblePairs += 1;
      diagnostics.dirtyPairs += 1;

      selectedIds.add(left.id);
      selectedIds.add(pair.right.id);
      bestScores.set(left.id, Math.max(bestScores.get(left.id) ?? 0, pair.score));
      bestScores.set(pair.right.id, Math.max(bestScores.get(pair.right.id) ?? 0, pair.score));
      const edge: ClusterMergeCandidateEdge = {
        leftId: left.id,
        rightId: pair.right.id,
        score: pair.score,
        selectionPaths: ["live"],
        recallChannels: pair.recallChannels,
        bm25Score: pair.bm25Score,
        vectorSimilarity: pair.vectorSimilarity,
      };
      selectedEdges.set(edgeKey, existingEdge ? mergeClusterMergeCandidateEdgeAttribution(existingEdge, edge) : edge);
    }
  }

  const candidates = clusters
    .filter((cluster) => selectedIds.has(cluster.id))
    .sort((left, right) => {
      const leftDirty = liveIds.has(left.id) ? 1 : 0;
      const rightDirty = liveIds.has(right.id) ? 1 : 0;
      const leftBestScore = bestScores.get(left.id) ?? 0;
      const rightBestScore = bestScores.get(right.id) ?? 0;

      if (rightDirty !== leftDirty) {
        return rightDirty - leftDirty;
      }

      if (rightBestScore !== leftBestScore) {
        return rightBestScore - leftBestScore;
      }

      if (right.itemCount !== left.itemCount) {
        return right.itemCount - left.itemCount;
      }

      return right.latestPublishedAt.getTime() - left.latestPublishedAt.getTime();
    });
  diagnostics.preLimitCandidates = candidates.length;
  diagnostics.dirtyCandidateCount = candidates.filter((candidate) => liveIds.has(candidate.id)).length;

  const limitedCandidates = candidates.slice(0, CLUSTER_MERGE_CANDIDATE_LIMIT);
  const limitedCandidateIds = new Set(limitedCandidates.map((candidate) => candidate.id));
  const allowedPairs = [...selectedEdges.values()]
    .filter((edge) => limitedCandidateIds.has(edge.leftId) && limitedCandidateIds.has(edge.rightId))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return buildClusterMergeEdgeKey(left.leftId, left.rightId).localeCompare(
        buildClusterMergeEdgeKey(right.leftId, right.rightId),
      );
    });
  diagnostics.postLimitCandidates = limitedCandidates.length;

  return {
    candidates: limitedCandidates,
    allowedPairs,
    diagnostics,
  };
}

export function buildClusterMergeCandidates(clusters: ClusterMergeCandidate[]) {
  return buildClusterMergeCandidateSelection(clusters).candidates;
}

export function buildClusterMergeInput(
  clusters: ClusterMergeCandidate[],
  allowedPairs: ClusterMergeCandidateEdge[] = [],
): string {
  const clustersById = new Map(clusters.map((cluster) => [cluster.id, cluster]));
  const serializeCluster = (cluster: ClusterMergeCandidate) => {
    const signature = getCandidateEventSignature(cluster);
    return {
      id: cluster.id,
      title: cluster.title,
      summary: cluster.summary,
      eventType: signature.eventType,
      eventSubject: signature.eventSubject,
      eventAction: signature.eventAction,
      eventObject: signature.eventObject,
      eventDate: signature.eventDate,
      itemCount: cluster.itemCount,
    };
  };

  return JSON.stringify({
    pairs: allowedPairs.flatMap((edge) => {
      const left = clustersById.get(edge.leftId);
      const right = clustersById.get(edge.rightId);

      if (!left || !right) {
        return [];
      }

      return [
        {
          left: serializeCluster(left),
          right: serializeCluster(right),
          score: edge.score,
        },
      ];
    }),
  });
}

export function getClusterAssignmentWindowKeys(publishedAt: Date, lookbackMs: number) {
  const currentBucket = Math.floor(publishedAt.getTime() / lookbackMs);

  return [currentBucket - 1, currentBucket, currentBucket + 1].map((bucket) => `window:${bucket}`);
}
