import { Prisma } from "@prisma/client";
import {
  buildClusterMergeBm25Index,
  CLUSTER_MERGE_BM25_CACHE_VERSION,
  CLUSTER_MERGE_BM25_SCORE_SCALE,
  scoreClusterMergeBm25Pair,
} from "@/lib/clusters/bm25";
import {
  CLUSTER_AI_CANDIDATE_LIMIT,
  CLUSTER_EMBEDDING_RRF_K,
  CLUSTER_LOOKBACK_MS,
  CLUSTER_MERGE_VECTOR_GRAY_SIM,
  CLUSTER_MERGE_CANDIDATE_LIMIT,
  CLUSTER_MERGE_CLEAN_PAIR_TTL_MS,
  CLUSTER_MERGE_CLEAN_PAIR_MAX_ATTEMPTS,
  CLUSTER_MERGE_AI_PAIR_BATCH_SIZE,
  CLUSTER_MERGE_PRECOMPUTE_BATCH_DELAY_MS,
  CLUSTER_MERGE_PRECOMPUTE_BATCH_SIZE,
  CLUSTER_MERGE_PRECOMPUTE_PAIR_SLICE_DELAY_MS,
  CLUSTER_MERGE_PRECOMPUTE_PAIR_SLICE_SIZE,
  CLUSTER_MERGE_PRECOMPUTE_PAIR_LIMIT,
  CLUSTER_MERGE_PRECOMPUTED_CLEAN_PAIR_LIMIT,
  CLUSTER_MERGE_SCAN_CLUSTER_LIMIT,
} from "@/config/constants";

import {
  makeClusterMergePairId,
  resolveClusterMergeGroupsFromDecisions,
  splitClusterMergeInputBatches,
  type ClusterMergeGroupConflict,
} from "@/lib/ai/protocols/cluster";
import { createAiProvider } from "@/lib/ai/provider-next";
import { type AiCallUsage, type AiEventSignature, type AiProvider, type ClusterMergeDecision } from "@/lib/ai/provider-types";
import {
  buildCandidateRange,
  buildCandidateRangeKey,
  buildClusterEventSignature,
  buildClusterMergeCleanPairKey,
  buildClusterMergeEdgeKey,
  buildClusterFingerprintSeed,
  buildClusterMatchInput,
  buildClusterMergeCandidateInputHash,
  buildClusterMergeCandidateSelection,
  getClusterMergePairAuditSignals,
  checkClusterMergePairSafety,
  scoreClusterMergeCandidatePair,
  buildClusterMergeInput,
  buildClusterSummaryInputHash,
  buildEventDisplayTitle,
  buildItemSummary,
  buildExactMatchKey,
  filterClusterMergeSourcesByAllowedEdges,
  generateClusterPresentation,
  getEventIdentityAnchor,
  getClusterAssignmentWindowKeys,
  getItemEventSignature,
  getClusterAssignmentCandidateSafety,
  hasCompleteClusterMatchSignature,
  type ClusterAssignmentCoordinator,
  type ItemWithSource,
  normalizeFingerprint,
  rankItemAssignmentCandidatesWithBm25,
  rememberRecentCandidate,
  toClusterAssignmentCandidate,
  type ClusterMergeCandidate,
  type ClusterMergeCandidateEdge,
  type ClusterMergeRecallChannel,
  type ClusterMergeSelectionPath,
  type ClusterSummaryFailureReason,
  type ClusterSummaryPresentation,
} from "@/lib/clusters/helpers";
import {
  getDefaultClusterSummaryRetryGuard,
  type ClusterSummaryRetryGuard,
  type ClusterSummaryRetryVerdict,
} from "@/lib/clusters/summary-retry-guard";
import {
  createCannotLinkForClusters,
  createCannotLinksBetweenItemSets,
  createMustLinkForClusters,
  findBlockingClusterPairConstraint,
} from "@/lib/clusters/constraints";
import { selectAiCandidatesWithEmbeddingRecall, resolveMergePairAdmission } from "@/lib/clusters/embedding-recall";
import {
  getClusterPairDecisionBlock,
  markOrphanedClusterPairDecisionsStale,
  recordClusterDecision,
} from "@/lib/clusters/decisions";
import { buildEventIdentity } from "@/lib/clusters/identity";
import { loadMentionResolver } from "@/lib/entities/mention-resolution";
import {
  reconcileApprovedClusterMergeDecision,
  type ClusterMergeDecisionConsistencyAudit,
} from "@/lib/clusters/merge-decision-safety";
import { buildEmbeddingText, type EmbedTextsFn } from "@/lib/ai/embeddings";
import {
  type ClusterAssignmentCandidate,
  createContentCluster,
  deleteCluster,
  findActiveClusterByFingerprint,
  findActiveClusterByTitle,
  findActiveClusterByEventFingerprint,
  findRecentActiveClusterCandidates,
  getClusterWithItems,
  setItemCluster,
  updateClusterStatus,
  updateClusterSummary,
} from "@/lib/clusters/repository";
import { refreshClusterFeedStatsSafely } from "@/lib/clusters/feed-stats";
import {
  normalizeEventSignatureForStorage,
} from "@/lib/clusters/normalization";
import { prisma } from "@/lib/db";
import { invalidateFeedCache } from "@/lib/feed/cache";
import { getDisplayTitle } from "@/lib/feed/presentation";
import { getIngestionRuntimeConfig } from "@/lib/settings/service";
import { enqueueTaskRun } from "@/lib/tasks/service";
const clusterAssignmentQueues = new Map<string, Promise<void>>();

type ClusterAssignmentSource = "exact_match" | "ai_match";

type ClusterAssignmentResult = {
  clusterId: string | null;
  matchSource: ClusterAssignmentSource | null;
  skippedIncompleteSignature: boolean;
  createdNewCluster: boolean;
};

export type ClusterRecomputeResult = {
  clusterId: string;
  deleted: boolean;
  updated: boolean;
  summaryAttempted: boolean;
  summarySucceeded: boolean;
  summaryFailureReason?: ClusterSummaryFailureReason;
  retryDeferred?: boolean;
  retryAfterMs?: number | null;
  attemptCount?: number;
};

async function findClusterForItem(
  item: ItemWithSource,
  options: {
    eventSignature?: AiEventSignature | null;
    aiProvider?: AiProvider;
    coordinator?: ClusterAssignmentCoordinator;
    titleFallback?: string;
  },
): Promise<{
  cluster: ClusterAssignmentCandidate | null;
  fingerprint: string;
  matchSource: ClusterAssignmentSource | null;
  skippedIncompleteSignature: boolean;
}> {
  const fingerprintSeed = buildClusterFingerprintSeed(options);
  const identity = buildEventIdentity({
    eventSignature: options.eventSignature,
    publishedAt: getEventIdentityAnchor(item),
  });
  const fingerprint = identity?.eventIdentityKey
    ? normalizeFingerprint(identity.eventIdentityKey)
    : fingerprintSeed
      ? normalizeFingerprint(fingerprintSeed)
      : "";
  const { since, until, timeField } = buildCandidateRange(item, CLUSTER_LOOKBACK_MS);
  const rangeKey = buildCandidateRangeKey(since, until, timeField);

  // Time-free event identity match first: same signature inside the time
  // window is the same event. The window (based on publishedAt/createdAt) is
  // the only time separation — event dates that are noisy/missing never block
  // the merge.
  const eventFp = identity?.eventFingerprint ?? null;
  let eventFpMatch = eventFp ? options.coordinator?.exactMatches.get(`efp:${eventFp}:${rangeKey}`) : undefined;

  if (eventFp && typeof eventFpMatch === "undefined") {
    eventFpMatch = await findActiveClusterByEventFingerprint(eventFp, since, until, timeField);
    options.coordinator?.exactMatches.set(
      `efp:${eventFp}:${rangeKey}`,
      eventFpMatch ? toClusterAssignmentCandidate(eventFpMatch) : null,
    );
  }

  if (eventFpMatch && eventFpMatch.id !== item.id) {
    // Same event signature inside the match window is the same event. Event
    // dates are noisy (AI mis-extraction, missing values) and the data
    // lifecycle is short (~3 months), so no additional date equality guard:
    // the time window + downstream AI verdict handle separation.
    return {
      cluster: eventFpMatch,
      fingerprint: eventFp as string,
      matchSource: "exact_match" as const,
      skippedIncompleteSignature: false,
    };
  }

  const exactMatchKey = fingerprint ? buildExactMatchKey(fingerprint, since, until, timeField) : "";
  let exactMatch = fingerprint ? options.coordinator?.exactMatches.get(exactMatchKey) : undefined;

  if (fingerprint && typeof exactMatch === "undefined") {
    exactMatch = await findActiveClusterByFingerprint(fingerprint, since, until, timeField);
    options.coordinator?.exactMatches.set(exactMatchKey, exactMatch ? toClusterAssignmentCandidate(exactMatch) : null);
  }

  if (exactMatch) {
    return {
      cluster: exactMatch,
      fingerprint,
      matchSource: "exact_match" as const,
      skippedIncompleteSignature: false,
    };
  }

  const titleFallback = options.titleFallback?.trim() ?? "";
  if (titleFallback) {
    const titleMatch = await findActiveClusterByTitle(titleFallback, since, until, timeField);
    const titleMatchCandidate = titleMatch ? toClusterAssignmentCandidate(titleMatch) : null;
    const titleMatchSafety = titleMatchCandidate && options.eventSignature
      ? getClusterAssignmentCandidateSafety(item, options.eventSignature, titleMatchCandidate)
      : null;

    if (
      titleMatchCandidate &&
      (!titleMatchSafety ||
        (titleMatchSafety.dateCompatible && !titleMatchSafety.preciseDateDrift && !titleMatchSafety.hardConflict))
    ) {
      return {
        cluster: titleMatchCandidate,
        fingerprint,
        matchSource: "exact_match" as const,
        skippedIncompleteSignature: false,
      };
    }
  }

  if (!options.aiProvider) {
    return {
      cluster: null,
      fingerprint,
      matchSource: null,
      skippedIncompleteSignature: false,
    };
  }

  if (!hasCompleteClusterMatchSignature(options.eventSignature)) {
    return {
      cluster: null,
      fingerprint,
      matchSource: null,
      skippedIncompleteSignature: true,
    };
  }

  let recentCandidateEntry = options.coordinator?.recentCandidates.get(rangeKey);

  if (!recentCandidateEntry) {
    recentCandidateEntry = {
      sinceMs: since.getTime(),
      untilMs: until.getTime(),
      candidates: await findRecentActiveClusterCandidates({
        since,
        until,
        timeField,
      }),
    };
    options.coordinator?.recentCandidates.set(rangeKey, recentCandidateEntry);
  }

  const candidates = recentCandidateEntry.candidates.filter((candidate) => candidate.id !== item.clusterId);

  if (candidates.length === 0) {
    return {
      cluster: null,
      fingerprint,
      matchSource: null,
      skippedIncompleteSignature: false,
    };
  }

  const { eligibleCandidates, sparseCandidates } = rankItemAssignmentCandidatesWithBm25(
    item,
    options.eventSignature!,
    candidates,
  );
  const embedTexts = options.aiProvider?.embedTexts;
  if (!embedTexts && sparseCandidates.length === 0) {
    return {
      cluster: null,
      fingerprint,
      matchSource: null,
      skippedIncompleteSignature: false,
    };
  }

  const aiEntries = embedTexts
    ? await selectAiCandidatesWithEmbeddingRecall({
        embedTexts,
        itemTitle: getDisplayTitle(item.originalTitle, item.translatedTitle),
        itemSummary: buildItemSummary(item),
        itemEvent: options.eventSignature ?? undefined,
        eligibleCandidates,
        sparseCandidates,
        rrfK: CLUSTER_EMBEDDING_RRF_K,
        limit: CLUSTER_AI_CANDIDATE_LIMIT,
      })
    : sparseCandidates.slice(0, CLUSTER_AI_CANDIDATE_LIMIT);
  const aiCandidates = aiEntries.slice(0, CLUSTER_AI_CANDIDATE_LIMIT).map((entry) => entry.candidate);
  if (aiCandidates.length === 0) {
    return {
      cluster: null,
      fingerprint,
      matchSource: null,
      skippedIncompleteSignature: false,
    };
  }

  try {
    const matchedClusterId = await options.aiProvider.matchClusterCandidate(buildClusterMatchInput(item, options), {
      title: getDisplayTitle(item.originalTitle, item.translatedTitle),
      candidates: aiCandidates.map((candidate) => ({
        id: candidate.id,
        title: candidate.title,
        summary: candidate.summary,
      })),
    });
    const matchedCluster = aiCandidates.find((candidate) => candidate.id === matchedClusterId) ?? null;

    return {
      cluster: matchedCluster,
      fingerprint,
      matchSource: matchedCluster ? "ai_match" : null,
      skippedIncompleteSignature: false,
    };
  } catch {
    return {
      cluster: null,
      fingerprint,
      matchSource: null,
      skippedIncompleteSignature: false,
    };
  }
}

async function runWithClusterAssignmentKeyLock<T>(key: string, task: () => Promise<T>) {
  const previous = clusterAssignmentQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => next);

  clusterAssignmentQueues.set(key, queued);
  await previous;

  try {
    return await task();
  } finally {
    release();

    if (clusterAssignmentQueues.get(key) === queued) {
      clusterAssignmentQueues.delete(key);
    }
  }
}

async function runWithClusterAssignmentWindowLocks<T>(keys: string[], task: () => Promise<T>) {
  const uniqueKeys = [...new Set(keys)].sort();
  let execute = task;

  for (let index = uniqueKeys.length - 1; index >= 0; index -= 1) {
    const key = uniqueKeys[index]!;
    const next = execute;
    execute = () => runWithClusterAssignmentKeyLock(key, next);
  }

  return execute();
}

export async function assignItemToCluster(
  itemId: string,
  options: {
    eventSignature?: AiEventSignature | null;
    aiProvider?: AiProvider;
    coordinator?: ClusterAssignmentCoordinator;
    aggregationEnabled?: boolean;
    allowIncompleteSignaturePending?: boolean;
  },
) {
  const item = await prisma.item.findUnique({
    where: { id: itemId },
    include: { source: true },
  });

  if (!item || (item.moderationStatus !== "allowed" && item.moderationStatus !== "restored")) {
    return {
      clusterId: null,
      matchSource: null,
      skippedIncompleteSignature: false,
      createdNewCluster: false,
    } satisfies ClusterAssignmentResult;
  }

  return runWithClusterAssignmentWindowLocks(getClusterAssignmentWindowKeys(item.publishedAt, CLUSTER_LOOKBACK_MS), async () => {
    const item = await prisma.item.findUnique({
      where: { id: itemId },
      include: { source: true },
    });

    if (!item || (item.moderationStatus !== "allowed" && item.moderationStatus !== "restored")) {
      return {
        clusterId: null,
        matchSource: null,
        skippedIncompleteSignature: false,
        createdNewCluster: false,
      } satisfies ClusterAssignmentResult;
    }

    const resolvedEventSignature = normalizeEventSignatureForStorage(options.eventSignature ?? getItemEventSignature(item));
    const eventIdentity = buildEventIdentity({
      eventSignature: resolvedEventSignature,
      publishedAt: getEventIdentityAnchor(item),
    });
    const canAggregate = options.aggregationEnabled ?? item.source.aggregationEnabled;
    if (!canAggregate) {
      const eventDisplayTitle = buildEventDisplayTitle(resolvedEventSignature);
      const cluster = await createContentCluster({
        fingerprint: `single-${item.id}`,
        eventFingerprint: eventIdentity?.eventFingerprint ?? null,
        eventBucket: eventIdentity?.eventBucket ?? null,
        title: eventDisplayTitle || getDisplayTitle(item.originalTitle, item.translatedTitle),
        summary: buildItemSummary(item),
        score: item.qualityScore,
        latestPublishedAt: item.publishedAt,
        eventType: resolvedEventSignature?.eventType ?? null,
        eventSubject: resolvedEventSignature?.eventSubject ?? null,
        eventAction: resolvedEventSignature?.eventAction ?? null,
        eventObject: resolvedEventSignature?.eventObject ?? null,
        eventDate: resolvedEventSignature?.eventDate ?? null,
      });

      await setItemCluster(item.id, cluster.id);
      await recordClusterDecision({
        kind: "item_cluster",
        source: "system",
        verdict: "approved",
        leftItemId: item.id,
        leftClusterId: cluster.id,
        pairKey: buildClusterMergeEdgeKey(item.id, cluster.id),
        inputHash: `${item.updatedAt.getTime()}:${cluster.id}`,
        confidence: eventIdentity?.identityConfidence ?? null,
        reasonCode: "singleton_cluster",
      });

      return {
        clusterId: cluster.id,
        matchSource: null,
        skippedIncompleteSignature: false,
        createdNewCluster: true,
      } satisfies ClusterAssignmentResult;
    }

    const eventDisplayTitle = buildEventDisplayTitle(resolvedEventSignature);
    const clusterTitle = eventDisplayTitle || getDisplayTitle(item.originalTitle, item.translatedTitle);
    const { cluster: matchedCluster, fingerprint, matchSource, skippedIncompleteSignature } =
      await findClusterForItem(item, {
        ...options,
        eventSignature: resolvedEventSignature,
        titleFallback: clusterTitle,
      });
    const shouldKeepPendingSingleton =
      Boolean(options.allowIncompleteSignaturePending) || skippedIncompleteSignature;
    // Incomplete signatures must not create "confident new events" that later collide in merge.
    // Prefer a pending singleton cluster for display, and let recovery re-enrich later.
    const createdNewCluster = !matchedCluster;
    const cluster =
      matchedCluster ??
      (await createContentCluster({
        fingerprint: shouldKeepPendingSingleton
          ? `pending-${item.id}`
          : fingerprint || `single-${item.id}`,
        // Pending incomplete-signature clusters stay out of identity/merge anchors.
        eventFingerprint: shouldKeepPendingSingleton ? null : (eventIdentity?.eventFingerprint ?? null),
        eventBucket: shouldKeepPendingSingleton ? null : (eventIdentity?.eventBucket ?? null),
        title: clusterTitle,
        summary: buildItemSummary(item),
        score: item.qualityScore,
        latestPublishedAt: item.publishedAt,
        eventType: resolvedEventSignature?.eventType ?? null,
        eventSubject: resolvedEventSignature?.eventSubject ?? null,
        eventAction: resolvedEventSignature?.eventAction ?? null,
        eventObject: resolvedEventSignature?.eventObject ?? null,
        eventDate: resolvedEventSignature?.eventDate ?? null,
      }));

    if (options.coordinator) {
      const candidate = toClusterAssignmentCandidate(cluster);

      if (fingerprint) {
        const { since, until, timeField } = buildCandidateRange(item, CLUSTER_LOOKBACK_MS);
        options.coordinator.exactMatches.set(buildExactMatchKey(fingerprint, since, until, timeField), candidate);
      }

      rememberRecentCandidate(
        options.coordinator,
        candidate,
        item.publishedAtKnown ? item.publishedAt : item.createdAt,
      );
    }

    await setItemCluster(item.id, cluster.id);
    await recordClusterDecision({
      kind: "item_cluster",
      source: matchSource === "ai_match" ? "llm" : "system",
      verdict: "approved",
      leftItemId: item.id,
      leftClusterId: cluster.id,
      pairKey: buildClusterMergeEdgeKey(item.id, cluster.id),
      inputHash: `${item.updatedAt.getTime()}:${cluster.id}`,
      confidence: eventIdentity?.identityConfidence ?? null,
      reasonCode: matchSource
        ?? (createdNewCluster
          ? (shouldKeepPendingSingleton ? "pending_incomplete_signature" : "new_cluster")
          : "cluster_assignment"),
    });
    // Note: Cluster summary recomputation is now handled at batch level in executeIngestion

    return {
      clusterId: cluster.id,
      matchSource,
      skippedIncompleteSignature,
      createdNewCluster,
    } satisfies ClusterAssignmentResult;
  });
}

export async function recomputeCluster(
  clusterId: string,
  aiProvider?: AiProvider,
  options?: {
    forceSummary?: boolean;
    retryGuard?: ClusterSummaryRetryGuard;
  },
): Promise<ClusterRecomputeResult> {
  const cluster = await getClusterWithItems(clusterId);

  if (!cluster) {
    return {
      clusterId,
      deleted: false,
      updated: false,
      summaryAttempted: false,
      summarySucceeded: false,
    } satisfies ClusterRecomputeResult;
  }

  if (cluster.items.length === 0) {
    await deleteCluster(clusterId);
    return {
      clusterId,
      deleted: true,
      updated: false,
      summaryAttempted: false,
      summarySucceeded: false,
    } satisfies ClusterRecomputeResult;
  }

  const summaryInputHash = buildClusterSummaryInputHash(cluster.items);
  const forceSummary = Boolean(options?.forceSummary);
  const retryGuard = options?.retryGuard ?? getDefaultClusterSummaryRetryGuard();
  const canAttemptAiSummary = Boolean(aiProvider) && cluster.items.length >= 2;
  const isSingletonFallback = cluster.items.length < 2;
  let retryVerdict: ClusterSummaryRetryVerdict | null = null;
  let generationAttempted = false;
  let guardOutcome: "success" | "failure" = "failure";

  const buildResult = (
    presentation: Awaited<ReturnType<typeof generateClusterPresentation>>,
    updated: boolean,
  ): ClusterRecomputeResult => ({
    clusterId,
    deleted: false,
    updated,
    summaryAttempted: presentation.summaryAttempted,
    summarySucceeded: presentation.summarySucceeded,
    ...(presentation.summaryAttempted && !presentation.summarySucceeded
      ? { summaryFailureReason: presentation.failureReason ?? "provider_error" }
      : {}),
    ...(retryVerdict ? { attemptCount: retryVerdict.attemptsInWindow } : {}),
  });

  // presentation 之后的派生计算 + DB 持久化收尾；guard owner 的调用方
  // 负责在 finally 里统一 finish，任何一步抛异常都不会泄漏 inflight。
  const finalizeCluster = async (
    presentation: Awaited<ReturnType<typeof generateClusterPresentation>>,
  ): Promise<ClusterRecomputeResult> => {
    // 失败 / 延后 / 多条无 provider 一律保留原成功 hash；唯一例外是 force 失败
    // 且旧 hash 恰好等于当前 input（历史上被固化成「成功」）：清除为 null，
    // 否则缓存命中会阻止后续自动重试。只作用于这次明确 force 失败的 cluster。
    const forceFailedStaleCurrentHash = !presentation.summarySucceeded
      && !(isSingletonFallback && !generationAttempted)
      && forceSummary
      && cluster.summaryInputHash === summaryInputHash;
    const cacheableHash =
      presentation.summarySucceeded || (isSingletonFallback && !generationAttempted)
        ? summaryInputHash
        : forceFailedStaleCurrentHash
          ? null
          : cluster.summaryInputHash;
    const eventSignature = buildClusterEventSignature(cluster.items);
    const score = Math.max(...cluster.items.map((item) => item.qualityScore));
    const latestPublishedAt = cluster.items[0]!.publishedAt;
    const eventIdentity = buildEventIdentity({
      eventSignature,
      publishedAt: getEventIdentityAnchor(
        cluster.items.find((item) => item.publishedAtKnown) ?? cluster.items[0]!,
      ),
    });
    const nextItemCount = cluster.items.length;
    const shouldSkipUpdate =
      cluster.title === presentation.title &&
      cluster.summary === presentation.summary &&
      cluster.score === score &&
      cluster.itemCount === nextItemCount &&
      cluster.latestPublishedAt.getTime() === latestPublishedAt.getTime() &&
      cluster.eventType === (eventSignature?.eventType ?? null) &&
      cluster.eventSubject === (eventSignature?.eventSubject ?? null) &&
      cluster.eventAction === (eventSignature?.eventAction ?? null) &&
      cluster.eventObject === (eventSignature?.eventObject ?? null) &&
      cluster.eventDate === (eventSignature?.eventDate ?? null) &&
      cluster.eventFingerprint === (eventIdentity?.eventFingerprint ?? null) &&
      cluster.eventBucket === (eventIdentity?.eventBucket ?? null) &&
      cluster.summaryInputHash === cacheableHash;

    if (shouldSkipUpdate) {
      await refreshClusterFeedStatsSafely([clusterId], "recompute unchanged cluster");
      return buildResult(presentation, false);
    }

    await updateClusterSummary(clusterId, {
      title: presentation.title,
      summary: presentation.summary,
      summaryInputHash: cacheableHash,
      score,
      itemCount: nextItemCount,
      latestPublishedAt,
      eventType: eventSignature?.eventType ?? null,
      eventSubject: eventSignature?.eventSubject ?? null,
      eventAction: eventSignature?.eventAction ?? null,
      eventObject: eventSignature?.eventObject ?? null,
      eventDate: eventSignature?.eventDate ?? null,
      eventFingerprint: eventIdentity?.eventFingerprint ?? null,
      eventBucket: eventIdentity?.eventBucket ?? null,
    });
    await refreshClusterFeedStatsSafely([clusterId], "recompute cluster");
    return buildResult(presentation, true);
  };

  if (!forceSummary && cluster.summaryInputHash && cluster.summaryInputHash === summaryInputHash) {
    // 缓存命中：保留已有 hash 与内容，不做任何 generation 尝试。
    return finalizeCluster({
      title: cluster.title,
      summary: cluster.summary,
      summaryAttempted: false,
      summarySucceeded: false,
    });
  }

  if (!canAttemptAiSummary || isSingletonFallback) {
    // 单项 fallback 可缓存新 hash；多条但无 provider 时不缓存（见 cacheableHash）。
    return finalizeCluster(await generateClusterPresentation(cluster.items, cluster.title, undefined, {
      preferEventTitleFallback: forceSummary,
    }));
  }

  if (forceSummary) {
    // 显式绕过 cache 与 guard，但仍不写失败 hash。
    generationAttempted = true;
    return finalizeCluster(await generateClusterPresentation(cluster.items, cluster.title, aiProvider, {
      preferEventTitleFallback: true,
    }));
  }

  const verdict = retryGuard.tryBegin(clusterId, summaryInputHash);
  retryVerdict = verdict;
  if (!verdict.allowed) {
    // 延后请求：绝不写 presentation/hash（避免与 inflight 成功互相覆盖标题与摘要），
    // 只刷新与展示无关的统计；当前有效展示原样保留。非 owner 不触碰 guard 状态。
    await refreshClusterStats(clusterId);
    return {
      clusterId,
      deleted: false,
      updated: false,
      summaryAttempted: false,
      summarySucceeded: false,
      retryDeferred: true,
      retryAfterMs: verdict.retryAfterMs,
      attemptCount: verdict.attemptsInWindow,
    } satisfies ClusterRecomputeResult;
  }

  // Guard owner：从取得所有权到最终结果整段由一个 outer try/finally 兜底，
  // presentation 生成、派生计算、DB 写任意一步抛异常都释放 inflight 并按
  // failure 记账；只有成功 summary 且完成 DB 写（或已持久化 skip）才 success。
  try {
    const presentation = await generateClusterPresentation(cluster.items, cluster.title, aiProvider, {
      preferEventTitleFallback: false,
    });
    const result = await finalizeCluster(presentation);
    if (presentation.summarySucceeded) {
      guardOutcome = "success";
    }
    return result;
  } finally {
    retryGuard.finish(clusterId, summaryInputHash, guardOutcome);
  }
}

async function refreshClusterStats(clusterId: string) {
  const cluster = await getClusterWithItems(clusterId);

  if (!cluster) {
    return null;
  }

  if (cluster.items.length === 0) {
    await deleteCluster(clusterId);
    return null;
  }

  const eventSignature = buildClusterEventSignature(cluster.items);
  const score = Math.max(...cluster.items.map((item) => item.qualityScore));
  const latestPublishedAt = cluster.items[0]!.publishedAt;
  const eventIdentity = buildEventIdentity({
    eventSignature,
    publishedAt: getEventIdentityAnchor(
      cluster.items.find((item) => item.publishedAtKnown) ?? cluster.items[0]!,
    ),
  });

  const updated = await prisma.contentCluster.update({
    where: { id: clusterId },
    data: {
      score,
      itemCount: cluster.items.length,
      latestPublishedAt,
      eventType: eventSignature?.eventType ?? null,
      eventSubject: eventSignature?.eventSubject ?? null,
      eventAction: eventSignature?.eventAction ?? null,
      eventObject: eventSignature?.eventObject ?? null,
      eventDate: eventSignature?.eventDate ?? null,
      eventFingerprint: eventIdentity?.eventFingerprint ?? null,
      eventBucket: eventIdentity?.eventBucket ?? null,
    },
  });
  await refreshClusterFeedStatsSafely([clusterId], "refresh cluster stats");
  return updated;
}

export async function detachItemFromCluster(itemId: string, aiProvider?: AiProvider) {
  const item = await prisma.item.findUnique({
    where: { id: itemId },
    select: { clusterId: true },
  });

  if (!item?.clusterId) {
    return null;
  }

  const previousClusterId = item.clusterId;
  const previousSiblingIds = (
    await prisma.item.findMany({
      where: {
        clusterId: previousClusterId,
        id: { not: itemId },
        status: "processed",
        moderationStatus: { in: ["allowed", "restored"] },
      },
      select: { id: true },
    })
  ).map((sibling) => sibling.id);
  await prisma.item.update({
    where: { id: itemId },
    data: {
      clusterId: null,
      manualClusterAssignedAt: null,
    },
  });

  const detachedAssignment = await assignItemToCluster(itemId, {
    aiProvider,
    aggregationEnabled: false,
  });

  await recomputeCluster(previousClusterId, aiProvider);

  if (detachedAssignment.clusterId) {
    await createCannotLinkForClusters(previousClusterId, detachedAssignment.clusterId, "manual detach");
    await recomputeCluster(detachedAssignment.clusterId, aiProvider);
  }
  await createCannotLinksBetweenItemSets({
    leftItemIds: [itemId],
    rightItemIds: previousSiblingIds,
    reason: "manual detach",
  });
  await refreshClusterFeedStatsSafely(
    [previousClusterId, detachedAssignment.clusterId].filter((id): id is string => Boolean(id)),
    "detach item from cluster",
  );

  invalidateFeedCache();

  return previousClusterId;
}

export type ClusterSplitResult = {
  clusterId: string;
  itemCount: number;
  singletonClusterIds: string[];
};

export async function splitClusterIntoSingletons(
  clusterId: string,
  aiProvider?: AiProvider,
): Promise<ClusterSplitResult> {
  const cluster = await prisma.contentCluster.findUnique({
    where: { id: clusterId },
    include: {
      items: {
        where: {
          status: "processed",
          moderationStatus: { in: ["allowed", "restored"] },
        },
        select: { id: true },
        orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
      },
    },
  });

  if (!cluster) {
    throw new Error("聚合组不存在");
  }

  if (cluster.items.length < 2) {
    throw new Error("聚合组条目不足，无需拆分");
  }

  const itemIds = cluster.items.map((item) => item.id);
  for (let leftIndex = 0; leftIndex < itemIds.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < itemIds.length; rightIndex += 1) {
      await createCannotLinksBetweenItemSets({
        leftItemIds: [itemIds[leftIndex]!],
        rightItemIds: [itemIds[rightIndex]!],
        reason: "manual split",
      });
    }
  }
  await prisma.item.updateMany({
    where: { id: { in: itemIds } },
    data: {
      clusterId: null,
      manualClusterAssignedAt: null,
    },
  });

  const singletonClusterIds: string[] = [];
  for (const itemId of itemIds) {
    const assignment = await assignItemToCluster(itemId, {
      aiProvider,
      aggregationEnabled: false,
    });
    if (assignment.clusterId) {
      singletonClusterIds.push(assignment.clusterId);
      await createCannotLinkForClusters(clusterId, assignment.clusterId, "manual split");
      await recomputeCluster(assignment.clusterId, aiProvider);
    }
  }

  await recomputeCluster(clusterId, aiProvider);
  await refreshClusterFeedStatsSafely([clusterId, ...singletonClusterIds], "split cluster into singletons");
  invalidateFeedCache();

  return {
    clusterId,
    itemCount: itemIds.length,
    singletonClusterIds,
  };
}

export async function moveItemToCluster(itemId: string, clusterId: string, aiProvider?: AiProvider) {
  const [item, targetCluster] = await Promise.all([
    prisma.item.findUnique({
      where: { id: itemId },
      select: {
        id: true,
        clusterId: true,
        manualClusterAssignedAt: true,
        moderationStatus: true,
        status: true,
      },
    }),
    prisma.contentCluster.findUnique({
      where: { id: clusterId },
      select: {
        id: true,
        status: true,
      },
    }),
  ]);

  if (!item || item.status !== "processed" || (item.moderationStatus !== "allowed" && item.moderationStatus !== "restored")) {
    throw new Error("Item not found");
  }

  if (!targetCluster || targetCluster.status !== "active") {
    throw new Error("Cluster not found");
  }

  if (item.clusterId === clusterId) {
    if (!item.manualClusterAssignedAt) {
      await prisma.item.update({
        where: { id: itemId },
        data: { manualClusterAssignedAt: new Date() },
      });
      invalidateFeedCache();
    }

    return clusterId;
  }

  const previousClusterId = item.clusterId;
  await prisma.item.update({
    where: { id: itemId },
    data: {
      clusterId,
      manualClusterAssignedAt: new Date(),
    },
  });
  if (previousClusterId) {
    await createMustLinkForClusters(clusterId, previousClusterId, "manual item move");
  }
  await recomputeCluster(clusterId, aiProvider);

  if (previousClusterId) {
    await recomputeCluster(previousClusterId, aiProvider);
  }
  await refreshClusterFeedStatsSafely(
    [clusterId, previousClusterId].filter((id): id is string => Boolean(id)),
    "move item to cluster",
  );

  invalidateFeedCache();

  return clusterId;
}

export type MergeSelectedItemsResult = {
  targetClusterId: string;
  targetClusterTitle: string;
  movedItemIds: string[];
  affectedClusterIds: string[];
  itemsMoved: number;
};

export async function mergeSelectedItemsToLargestCluster(
  itemIds: string[],
  aiProvider?: AiProvider,
): Promise<MergeSelectedItemsResult> {
  const uniqueItemIds = [...new Set(itemIds.map((id) => id.trim()).filter(Boolean))];
  if (uniqueItemIds.length < 2) {
    throw new Error("至少需要选择两个条目进行合并");
  }

  const items = await prisma.item.findMany({
    where: { id: { in: uniqueItemIds } },
    select: {
      id: true,
      clusterId: true,
      moderationStatus: true,
      status: true,
      cluster: {
        select: {
          id: true,
          title: true,
          itemCount: true,
          latestPublishedAt: true,
          status: true,
        },
      },
    },
  });
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const missingIds = uniqueItemIds.filter((id) => !itemsById.has(id));
  if (missingIds.length > 0) {
    throw new Error(`部分条目不存在: ${missingIds.join(", ")}`);
  }

  const invalidItem = items.find(
    (item) => item.status !== "processed" || (item.moderationStatus !== "allowed" && item.moderationStatus !== "restored"),
  );
  if (invalidItem) {
    throw new Error("只能合并已处理且可展示的条目");
  }

  const clusterCandidates = new Map<string, NonNullable<(typeof items)[number]["cluster"]>>();
  for (const item of items) {
    if (!item.cluster) {
      continue;
    }
    if (item.cluster.status !== "active") {
      throw new Error("只能合并 active 状态聚合组中的条目");
    }
    clusterCandidates.set(item.cluster.id, item.cluster);
  }

  if (clusterCandidates.size === 0) {
    throw new Error("所选条目没有可作为合并基准的聚合组");
  }

  const targetCluster = [...clusterCandidates.values()].sort((left, right) => {
    if (right.itemCount !== left.itemCount) {
      return right.itemCount - left.itemCount;
    }
    return right.latestPublishedAt.getTime() - left.latestPublishedAt.getTime();
  })[0]!;

  const movedItemIds = items
    .filter((item) => item.clusterId !== targetCluster.id)
    .map((item) => item.id);

  if (movedItemIds.length === 0) {
    throw new Error("所选条目已在同一个聚合组中");
  }

  const previousClusterIds = [
    ...new Set(
      items
        .filter((item) => item.clusterId && item.clusterId !== targetCluster.id)
        .map((item) => item.clusterId!),
    ),
  ];

  await prisma.item.updateMany({
    where: { id: { in: movedItemIds } },
    data: {
      clusterId: targetCluster.id,
      manualClusterAssignedAt: new Date(),
    },
  });

  const affectedClusterIds = [targetCluster.id, ...previousClusterIds];
  for (const previousClusterId of previousClusterIds) {
    await createMustLinkForClusters(targetCluster.id, previousClusterId, "manual selected item merge");
  }
  for (const clusterId of affectedClusterIds) {
    await recomputeCluster(clusterId, aiProvider);
  }
  await refreshClusterFeedStatsSafely(affectedClusterIds, "merge selected items to largest cluster");

  invalidateFeedCache();

  return {
    targetClusterId: targetCluster.id,
    targetClusterTitle: targetCluster.title,
    movedItemIds,
    affectedClusterIds,
    itemsMoved: movedItemIds.length,
  };
}

export async function setClusterVisibility(clusterId: string, visible: boolean) {
  const cluster = await updateClusterStatus(clusterId, visible ? "active" : "hidden");
  await refreshClusterFeedStatsSafely([clusterId], "set cluster visibility");
  invalidateFeedCache();
  return cluster;
}

export async function enqueueClusterSummaryTask(clusterId: string, label?: string) {
  return enqueueTaskRun({
    kind: "cluster_regenerate_summary",
    triggerType: "admin_action",
    label: label ?? "重新生成聚合摘要",
    entityId: clusterId,
  });
}

export type ClusterSummaryWorkflowPayload = {
  clusterId: string;
  summaryInputHash: string;
  presentation?: ClusterSummaryPresentation;
};

export async function readClusterSummaryWorkflow(clusterId: string): Promise<ClusterSummaryWorkflowPayload> {
  const cluster = await getClusterWithItems(clusterId);
  if (!cluster) throw new Error("Cluster not found");
  if (cluster.items.length === 0) {
    await deleteCluster(clusterId);
    return { clusterId, summaryInputHash: "", presentation: { title: cluster.title, summary: cluster.summary, summaryAttempted: false, summarySucceeded: false } };
  }
  return { clusterId, summaryInputHash: buildClusterSummaryInputHash(cluster.items) };
}

export async function resolveClusterSummaryProvider(options?: {
  onUsage?: (usage: AiCallUsage, usageKey?: string) => void;
}): Promise<AiProvider | undefined> {
  const runtimeConfig = await getIngestionRuntimeConfig().catch(() => null);
  if (!runtimeConfig) return undefined;
  return createAiProvider(runtimeConfig.modelApi, {
    itemUnderstanding: runtimeConfig.selectedPromptConfigs?.itemUnderstanding,
    clusterSummary: runtimeConfig.selectedPromptConfigs?.clusterSummary,
    clusterMatch: runtimeConfig.selectedPromptConfigs?.clusterMatch,
  }, undefined, {
    aggregationSplitMaxEvents: runtimeConfig.ingestion.aggregationSplitMaxEvents,
    embedding: runtimeConfig.embedding,
    ...(options?.onUsage ? { onUsage: options.onUsage } : {}),
  });
}

export async function generateClusterSummaryWorkflow(
  payload: ClusterSummaryWorkflowPayload,
  aiProvider?: AiProvider,
): Promise<ClusterSummaryWorkflowPayload> {
  const cluster = await getClusterWithItems(payload.clusterId);
  if (!cluster || cluster.items.length === 0) return payload;
  const resolvedProvider = aiProvider ?? await resolveClusterSummaryProvider();
  const presentation = await generateClusterPresentation(cluster.items, cluster.title, resolvedProvider, { preferEventTitleFallback: true });
  return { ...payload, presentation };
}

export async function persistClusterSummaryWorkflow(payload: ClusterSummaryWorkflowPayload): Promise<{
  clusterId: string;
  deleted: boolean;
  updated: boolean;
  summaryAttempted?: boolean;
  summarySucceeded?: boolean;
  summaryFailureReason?: ClusterSummaryFailureReason;
}> {
  const cluster = await getClusterWithItems(payload.clusterId);
  if (!cluster || cluster.items.length === 0) return { clusterId: payload.clusterId, deleted: true, updated: false };
  if (!payload.presentation) throw new Error("Cluster summary presentation is missing");
  const presentation = payload.presentation;
  // 手动 route 走 read → generate → persist 独立双路径，语义等同 forceSummary：
  // 成功（或单项 fallback 未尝试）才允许推进缓存 hash；read 与 persist 之间
  // items 可能变化，payload hash 与当前 input 不一致时不得把它伪装成当前成功。
  const currentInputHash = buildClusterSummaryInputHash(cluster.items);
  const isSingletonFallback = cluster.items.length < 2;
  const cacheableHash =
    presentation.summarySucceeded || (isSingletonFallback && !presentation.summaryAttempted)
      ? payload.summaryInputHash === currentInputHash
        ? payload.summaryInputHash
        : cluster.summaryInputHash
      : cluster.summaryInputHash === currentInputHash
        ? null
        : cluster.summaryInputHash;
  const eventSignature = buildClusterEventSignature(cluster.items);
  const score = Math.max(...cluster.items.map((item) => item.qualityScore));
  const latestPublishedAt = cluster.items[0]!.publishedAt;
  const eventIdentity = buildEventIdentity({
    eventSignature,
    publishedAt: getEventIdentityAnchor(cluster.items.find((item) => item.publishedAtKnown) ?? cluster.items[0]!),
  });
  const nextItemCount = cluster.items.length;
  await updateClusterSummary(payload.clusterId, {
    title: presentation.title,
    summary: presentation.summary,
    summaryInputHash: cacheableHash,
    score,
    itemCount: nextItemCount,
    latestPublishedAt,
    eventType: eventSignature?.eventType ?? null,
    eventSubject: eventSignature?.eventSubject ?? null,
    eventAction: eventSignature?.eventAction ?? null,
    eventObject: eventSignature?.eventObject ?? null,
    eventDate: eventSignature?.eventDate ?? null,
    eventFingerprint: eventIdentity?.eventFingerprint ?? null,
    eventBucket: eventIdentity?.eventBucket ?? null,
  });
  // manual Mastra 路径不持久化 presentation.failureReason，DB 之外补一条
  // 结构化安全日志（仅类别枚举，不含 title/summary/prompt/原始错误）。
  if (presentation.summaryAttempted && !presentation.summarySucceeded) {
    console.warn(
      `[ClusterSummary] presentation_not_adopted clusterId=${payload.clusterId} reason=${presentation.failureReason ?? "provider_error"} cacheInvalidated=${cacheableHash === null}`,
    );
  }
  await refreshClusterFeedStatsSafely([payload.clusterId], "workflow cluster summary");
  return {
    clusterId: payload.clusterId,
    deleted: false,
    updated: true,
    summaryAttempted: presentation.summaryAttempted,
    summarySucceeded: presentation.summarySucceeded,
    ...(presentation.summaryAttempted && !presentation.summarySucceeded
      ? { summaryFailureReason: presentation.failureReason ?? "provider_error" }
      : {}),
  };
}

// Internal lightweight merge that moves items and deletes emptied clusters
// without creating separate background tasks (used during ingestion merge pass).
async function mergeClustersInternal(
  targetClusterId: string,
  sourceClusterIds: string[],
): Promise<{ itemsMoved: number }> {
  // Move all items from source clusters to target cluster
  const moveResult = await prisma.item.updateMany({
    where: {
      clusterId: { in: sourceClusterIds },
      status: "processed",
      moderationStatus: { in: ["allowed", "restored"] },
    },
    data: { clusterId: targetClusterId },
  });

  // Delete emptied source clusters
  await prisma.contentCluster.deleteMany({
    where: {
      id: { in: sourceClusterIds },
      items: { none: {} },
    },
  });

  // Refresh target cluster stats
  await refreshClusterStats(targetClusterId);
  await refreshClusterFeedStatsSafely([targetClusterId, ...sourceClusterIds], "merge clusters internal");

  return { itemsMoved: moveResult.count };
}

export type ClusterMergePassResult = {
  baseClusters: number;
  candidates: number;
  totalPairs: number;
  rejectedObjectConflict: number;
  rejectedDateConflict: number;
  rejectedNoEventAnchor: number;
  belowGrayScore: number;
  relatedPairs: number;
  aiEligiblePairs: number;
  cleanPairsSkipped: number;
  precomputedCleanPairsUsed: number;
  precomputedCleanPairsAttemptSkipped: number;
  precomputedCleanPairsInvalidSkipped: number;
  blockedByCannotLink: number;
  blockedByDeclinedDecision: number;
  blockedByReviewDecision: number;
  decisionsApproved: number;
  decisionsDeclined: number;
  decisionsAmbiguous: number;
  decisionsFailed: number;
  dirtyPairs: number;
  preLimitCandidates: number;
  postLimitCandidates: number;
  dirtyCandidates: number;
  aiMergeGroups: number;
  skipped: boolean;
  mergedCount: number;
  itemsMoved: number;
  failedGroups: number;
  affectedClusterIds: string[];
  pairDiagnostics: ClusterMergePairDiagnostic[];
  refreshItemCountsMs: number;
  loadClustersMs: number;
  candidateSelectionMs: number;
  promptBuildMs: number;
  promptChars: number;
  promptPairs: number;
  aiMergeMs: number;
  applyMergeMs: number;
  markEvaluatedMs: number;
};

export type ClusterMergePairDiagnostic = {
  pairId: string;
  pairKey: string;
  leftClusterId: string;
  rightClusterId: string;
  selectionPaths: ClusterMergeSelectionPath[];
  recallChannels: ClusterMergeRecallChannel[];
  selectionScore: number;
  cachePriorityScore: number | null;
  bm25Score: number | null;
  vectorSimilarity: number | null;
  signals: ReturnType<typeof getClusterMergePairAuditSignals>;
  groupConflict?: ClusterMergeGroupConflict;
  decision: {
    verdict: ClusterMergeDecision["verdict"] | "failed";
    confidence: number | null;
    reasonCode: string | null;
    reasonText: string | null;
    consistency?: ClusterMergeDecisionConsistencyAudit;
  };
};

type EvaluatedClusterMergeCandidate = Parameters<typeof buildClusterMergeCandidateInputHash>[0] & {
  id: string;
  mergeInputHash?: string | null;
};

function isClusterMergeCandidateClean(candidate: ClusterMergeCandidate) {
  return candidate.mergeInputHash === buildClusterMergeCandidateInputHash(candidate);
}

type StoredCleanMergePair = {
  id: string;
  leftClusterId: string;
  rightClusterId: string;
  leftInputHash: string;
  rightInputHash: string;
  score: number;
  recallSource: string | null;
  bm25Score: number | null;
  vectorSimilarity: number | null;
  attemptCount: number;
};

type PrecomputedCleanPairSelection = {
  candidates: ClusterMergeCandidate[];
  allowedPairs: ClusterMergeCandidateEdge[];
  usedPairIdsByEdgeKey: Map<string, string>;
  usedCount: number;
  attemptSkipped: number;
  invalidSkipped: number;
};

function parseStoredRecallChannels(source: string | null): ClusterMergeRecallChannel[] {
  switch (source) {
    case "bm25":
      return ["bm25"];
    case "vector":
      return ["vector"];
    case "bm25+vector":
      return ["bm25", "vector"];
    default:
      return ["unknown"];
  }
}

function addPrecomputedAttribution(
  edge: ClusterMergeCandidateEdge,
  pair: StoredCleanMergePair,
  recallChannels: ClusterMergeRecallChannel[],
): ClusterMergeCandidateEdge {
  return {
    ...edge,
    selectionPaths: [...new Set([...(edge.selectionPaths ?? []), "precomputed_cache" as const])],
    recallChannels: [...new Set([...(edge.recallChannels ?? []), ...recallChannels])],
    bm25Score: edge.bm25Score ?? pair.bm25Score,
    vectorSimilarity: edge.vectorSimilarity ?? pair.vectorSimilarity,
    cachePriorityScore: pair.score,
  };
}

function addClusterMergeCandidate(candidateMap: Map<string, ClusterMergeCandidate>, candidate: ClusterMergeCandidate) {
  if (candidateMap.size >= CLUSTER_MERGE_CANDIDATE_LIMIT && !candidateMap.has(candidate.id)) {
    return false;
  }

  candidateMap.set(candidate.id, candidate);
  return true;
}

function groupContainsClusterMergePair(group: string[], leftId: string, rightId: string) {
  if (group.length < 2) {
    return false;
  }

  const ids = new Set(group);
  return ids.has(leftId) && ids.has(rightId);
}

async function loadStoredCleanMergePairs(now: Date) {
  return prisma.clusterMergeCleanPairCandidate.findMany({
    where: {
      expiresAt: { gt: now },
      pairKey: { startsWith: `${CLUSTER_MERGE_BM25_CACHE_VERSION}:` },
    },
    orderBy: [
      { score: "desc" },
      { updatedAt: "desc" },
      { id: "asc" },
    ],
    take: CLUSTER_MERGE_PRECOMPUTED_CLEAN_PAIR_LIMIT * 4,
  });
}

function mergePrecomputedCleanPairs(input: {
  liveCandidates: ClusterMergeCandidate[];
  liveAllowedPairs: ClusterMergeCandidateEdge[];
  recentClusters: ClusterMergeCandidate[];
  canonicalRecentClusters: ClusterMergeCandidate[];
  storedPairs: StoredCleanMergePair[];
}): PrecomputedCleanPairSelection {
  const candidateMap = new Map(input.liveCandidates.map((candidate) => [candidate.id, candidate]));
  const clustersById = new Map(input.recentClusters.map((cluster) => [cluster.id, cluster]));
  const canonicalClustersById = new Map(input.canonicalRecentClusters.map((cluster) => [cluster.id, cluster]));
  const edgeMap = new Map(
    input.liveAllowedPairs.map((edge) => [buildClusterMergeEdgeKey(edge.leftId, edge.rightId), edge]),
  );
  const usedPairIdsByEdgeKey = new Map<string, string>();
  let usedCount = 0;
  let attemptSkipped = 0;
  let invalidSkipped = 0;

  for (const pair of input.storedPairs) {
    if (usedCount >= CLUSTER_MERGE_PRECOMPUTED_CLEAN_PAIR_LIMIT) {
      break;
    }

    const left = clustersById.get(pair.leftClusterId);
    const right = clustersById.get(pair.rightClusterId);

    if (!left || !right) {
      invalidSkipped += 1;
      continue;
    }

    if (
      pair.attemptCount >= CLUSTER_MERGE_CLEAN_PAIR_MAX_ATTEMPTS ||
      buildClusterMergeCandidateInputHash(left) !== pair.leftInputHash ||
      buildClusterMergeCandidateInputHash(right) !== pair.rightInputHash ||
      !isClusterMergeCandidateClean(left) ||
      !isClusterMergeCandidateClean(right)
    ) {
      attemptSkipped += pair.attemptCount >= CLUSTER_MERGE_CLEAN_PAIR_MAX_ATTEMPTS ? 1 : 0;
      invalidSkipped += pair.attemptCount >= CLUSTER_MERGE_CLEAN_PAIR_MAX_ATTEMPTS ? 0 : 1;
      continue;
    }

    const canonicalLeft = canonicalClustersById.get(left.id) ?? left;
    const canonicalRight = canonicalClustersById.get(right.id) ?? right;
    const currentScore = scoreClusterMergeCandidatePair(canonicalLeft, canonicalRight);
    const currentSafety = checkClusterMergePairSafety(canonicalLeft, canonicalRight);
    const vectorAdmitted = pair.vectorSimilarity !== null &&
      pair.vectorSimilarity >= CLUSTER_MERGE_VECTOR_GRAY_SIM;
    const sparseSafetyPassed = !currentScore.rejected && !currentSafety.rejected;
    const bm25Admitted = sparseSafetyPassed && pair.bm25Score !== null && pair.bm25Score > 0;
    // 兼容早期无归因字段的缓存：只在稀疏安全门通过时按 legacy candidate 处理。
    const legacyAdmitted = pair.recallSource === null && pair.bm25Score === null &&
      pair.vectorSimilarity === null && sparseSafetyPassed;
    const recallChannels: ClusterMergeRecallChannel[] = [
      ...(bm25Admitted ? ["bm25" as const] : []),
      ...(vectorAdmitted ? ["vector" as const] : []),
      ...(legacyAdmitted ? ["unknown" as const] : []),
    ];
    if (recallChannels.length === 0) {
      invalidSkipped += 1;
      continue;
    }

    const edgeKey = buildClusterMergeEdgeKey(left.id, right.id);
    const existingEdge = edgeMap.get(edgeKey);
    if (existingEdge) {
      edgeMap.set(edgeKey, addPrecomputedAttribution(existingEdge, pair, recallChannels));
      continue;
    }

    if (!addClusterMergeCandidate(candidateMap, canonicalLeft) || !addClusterMergeCandidate(candidateMap, canonicalRight)) {
      break;
    }

    const densePriority = vectorAdmitted && pair.vectorSimilarity !== null
      ? Math.round(pair.vectorSimilarity * 100) * CLUSTER_MERGE_BM25_SCORE_SCALE
      : 0;
    edgeMap.set(edgeKey, {
      leftId: left.id,
      rightId: right.id,
      score: Math.max(
        bm25Admitted ? pair.bm25Score! : 0,
        densePriority,
        legacyAdmitted ? currentScore.score : 0,
      ),
      selectionPaths: ["precomputed_cache"],
      recallChannels,
      bm25Score: pair.bm25Score,
      vectorSimilarity: pair.vectorSimilarity,
      cachePriorityScore: pair.score,
    });
    usedPairIdsByEdgeKey.set(edgeKey, pair.id);
    usedCount += 1;
  }

  return {
    candidates: [...candidateMap.values()],
    allowedPairs: [...edgeMap.values()].sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return buildClusterMergeEdgeKey(left.leftId, left.rightId).localeCompare(
        buildClusterMergeEdgeKey(right.leftId, right.rightId),
      );
    }),
    usedPairIdsByEdgeKey,
    usedCount,
    attemptSkipped,
    invalidSkipped,
  };
}

async function markDeclinedPrecomputedCleanMergePairs(
  usedPairIdsByEdgeKey: Map<string, string>,
  allowedPairs: ClusterMergeCandidateEdge[],
  mergeGroups: string[][],
) {
  if (usedPairIdsByEdgeKey.size === 0) {
    return;
  }

  const declinedPairIds: string[] = [];

  for (const edge of allowedPairs) {
    const edgeKey = buildClusterMergeEdgeKey(edge.leftId, edge.rightId);
    const pairId = usedPairIdsByEdgeKey.get(edgeKey);

    if (!pairId || mergeGroups.some((group) => groupContainsClusterMergePair(group, edge.leftId, edge.rightId))) {
      continue;
    }

    declinedPairIds.push(pairId);
  }

  if (declinedPairIds.length === 0) {
    return;
  }

  await prisma.clusterMergeCleanPairCandidate.updateMany({
    where: { id: { in: declinedPairIds } },
    data: {
      attemptCount: { increment: 1 },
      lastEvaluatedAt: new Date(),
    },
  });
}

async function markClusterMergeCandidatesEvaluated(candidates: EvaluatedClusterMergeCandidate[]) {
  const changedCandidates = candidates.filter(
    (candidate) => candidate.mergeInputHash !== buildClusterMergeCandidateInputHash(candidate),
  );

  if (changedCandidates.length === 0) {
    return;
  }

  await prisma.$transaction(
    changedCandidates.map((candidate) =>
      prisma.contentCluster.updateMany({
        where: { id: candidate.id },
        data: { mergeInputHash: buildClusterMergeCandidateInputHash(candidate) },
      }),
    ),
  );
}

function buildClusterMergePairInputHash(left: ClusterMergeCandidate, right: ClusterMergeCandidate) {
  return [buildClusterMergeCandidateInputHash(left), buildClusterMergeCandidateInputHash(right)].sort().join(":");
}

function getClusterMergePairCandidates(
  candidatesById: Map<string, ClusterMergeCandidate>,
  edge: ClusterMergeCandidateEdge,
) {
  const left = candidatesById.get(edge.leftId);
  const right = candidatesById.get(edge.rightId);

  return left && right ? { left, right } : null;
}

async function filterBlockedClusterMergeEdges(input: {
  candidatesById: Map<string, ClusterMergeCandidate>;
  allowedPairs: ClusterMergeCandidateEdge[];
  now: Date;
}) {
  const filteredPairs: ClusterMergeCandidateEdge[] = [];
  let blockedByCannotLink = 0;
  let blockedByDeclinedDecision = 0;
  let blockedByReviewDecision = 0;

  for (const edge of input.allowedPairs) {
    const pair = getClusterMergePairCandidates(input.candidatesById, edge);
    if (!pair) {
      continue;
    }

    const constraint = await findBlockingClusterPairConstraint({
      leftClusterId: edge.leftId,
      rightClusterId: edge.rightId,
      now: input.now,
    });
    if (constraint) {
      blockedByCannotLink += 1;
      continue;
    }

    const decisionBlock = await getClusterPairDecisionBlock({
      pairKey: buildClusterMergeEdgeKey(edge.leftId, edge.rightId),
      inputHash: buildClusterMergePairInputHash(pair.left, pair.right),
      now: input.now,
    });
    if (decisionBlock) {
      if (decisionBlock.reason === "ambiguous_pending_review") {
        blockedByReviewDecision += 1;
      } else {
        blockedByDeclinedDecision += 1;
      }
      continue;
    }

    filteredPairs.push(edge);
  }

  return {
    allowedPairs: filteredPairs,
    blockedByCannotLink,
    blockedByDeclinedDecision,
    blockedByReviewDecision,
  };
}

async function recordClusterMergeDecisions(input: {
  candidatesById: Map<string, ClusterMergeCandidate>;
  allowedPairs: ClusterMergeCandidateEdge[];
  decisions: ClusterMergeDecision[];
  verdictOnMissing: "declined" | "failed";
  failureReason?: string | null;
  now: Date;
}) {
  const recordedDecisions: Array<Awaited<ReturnType<typeof recordClusterDecision>>> = [];
  const decisionByPairKey = new Map(
    input.decisions.map((decision) => [
      buildClusterMergeEdgeKey(decision.leftClusterId, decision.rightClusterId),
      decision,
    ]),
  );

  for (const edge of input.allowedPairs) {
    const pair = getClusterMergePairCandidates(input.candidatesById, edge);
    if (!pair) {
      continue;
    }

    const aiDecision = decisionByPairKey.get(buildClusterMergeEdgeKey(edge.leftId, edge.rightId));
    const verdict = aiDecision?.verdict ?? input.verdictOnMissing;
    recordedDecisions.push(
      await recordClusterDecision({
        kind: "cluster_pair",
        source: "llm",
        verdict,
        leftClusterId: edge.leftId,
        rightClusterId: edge.rightId,
        pairKey: buildClusterMergeEdgeKey(edge.leftId, edge.rightId),
        inputHash: buildClusterMergePairInputHash(pair.left, pair.right),
        localScore: edge.score,
        confidence: aiDecision?.confidence,
        reasonCode: aiDecision?.reasonCode ?? null,
        // 失败必须可归因：历史上大量 failed 决策 reasonText 为 NULL，事后无法判断
        // 是超时、限流还是协议缺陷，故对空原因补一个显式占位而不是留空。
        reasonText: aiDecision?.reasonText ?? (verdict === "failed"
          ? (input.failureReason?.trim() || "未记录失败原因（AI 未返回可用判定）")
          : null),
        now: input.now,
      }),
    );
  }

  return recordedDecisions;
}

function countClusterMergeDecisionVerdicts(
  decisions: Array<Awaited<ReturnType<typeof recordClusterDecision>>>,
) {
  return {
    decisionsApproved: decisions.filter((decision) => decision.verdict === "approved").length,
    decisionsDeclined: decisions.filter((decision) => decision.verdict === "declined").length,
    decisionsAmbiguous: decisions.filter((decision) => decision.verdict === "ambiguous").length,
    decisionsFailed: decisions.filter((decision) => decision.verdict === "failed").length,
  };
}

function buildClusterMergePairDiagnostics(
  candidatesById: Map<string, ClusterMergeCandidate>,
  allowedPairs: ClusterMergeCandidateEdge[],
  decisions: Array<Awaited<ReturnType<typeof recordClusterDecision>>>,
  consistencyAudits: ReadonlyMap<string, ClusterMergeDecisionConsistencyAudit> = new Map(),
  groupConflicts: ClusterMergeGroupConflict[] = [],
): ClusterMergePairDiagnostic[] {
  const decisionsByPairKey = new Map(decisions.map((decision) => [decision.pairKey, decision]));

  return allowedPairs.flatMap((edge) => {
    const left = candidatesById.get(edge.leftId);
    const right = candidatesById.get(edge.rightId);
    const pairKey = buildClusterMergeEdgeKey(edge.leftId, edge.rightId);
    const decision = decisionsByPairKey.get(pairKey);
    if (!left || !right || !decision) return [];
    const groupConflict = groupConflicts.find((conflict) =>
      conflict.clusterIds.includes(edge.leftId) && conflict.clusterIds.includes(edge.rightId)
    );

    return [{
      pairId: makeClusterMergePairId(edge.leftId, edge.rightId),
      pairKey,
      leftClusterId: edge.leftId,
      rightClusterId: edge.rightId,
      selectionPaths: edge.selectionPaths ?? [],
      recallChannels: edge.recallChannels ?? ["unknown"],
      selectionScore: edge.score,
      cachePriorityScore: edge.cachePriorityScore ?? null,
      bm25Score: edge.bm25Score ?? null,
      vectorSimilarity: edge.vectorSimilarity ?? null,
      signals: getClusterMergePairAuditSignals(left, right),
      ...(groupConflict ? { groupConflict } : {}),
      decision: {
        verdict: decision.verdict,
        confidence: decision.confidence,
        reasonCode: decision.reasonCode,
        reasonText: decision.reasonText,
        ...(consistencyAudits.has(pairKey) ? { consistency: consistencyAudits.get(pairKey)! } : {}),
      },
    }];
  });
}

async function refreshRecentClusterItemCounts(lookbackSince: Date) {
  // Refresh itemCount for clusters in the lookback window.
  // Newly created clusters only get fully refreshed during cluster_finalize,
  // which runs AFTER merge.
  await prisma.$executeRaw`
    UPDATE content_clusters
    SET itemCount = (
      SELECT COUNT(*) FROM items
      WHERE items.clusterId = content_clusters.id
      AND items.status = 'processed'
      AND items.moderationStatus IN ('allowed', 'restored')
    )
    WHERE status = 'active'
    AND latestPublishedAt >= ${lookbackSince.getTime()}
  `;
}

async function canonicalizeClusterMergeEntityMentions(clusters: ClusterMergeCandidate[]) {
  try {
    const resolveMention = await loadMentionResolver(
      clusters.flatMap((cluster) => [cluster.eventSubject, cluster.eventObject]),
    );
    return clusters.map((cluster) => {
      const subject = resolveMention(cluster.eventSubject);
      const object = resolveMention(cluster.eventObject);
      if (subject === null && object === null) {
        return cluster;
      }
      return {
        ...cluster,
        eventSubject: subject ?? cluster.eventSubject,
        eventObject: object ?? cluster.eventObject,
      };
    });
  } catch {
    return clusters;
  }
}

async function loadRecentMergeClusters(lookbackSince: Date, affectedClusterIds?: Iterable<string>) {
  const baseWhere: Prisma.ContentClusterWhereInput = {
    status: "active" as const,
    latestPublishedAt: { gte: lookbackSince },
    items: {
      some: {
        status: "processed" as const,
        moderationStatus: { in: ["allowed", "restored"] },
        OR: [{ source: { aggregationEnabled: true } }, { parentItemId: { not: null } }],
      },
    },
  };
  const orderBy = [
    { latestPublishedAt: "desc" as const },
    { updatedAt: "desc" as const },
    { itemCount: "desc" as const },
    { id: "asc" as const },
  ];
  const recentClusters = await prisma.contentCluster.findMany({
    where: baseWhere,
    orderBy,
    take: CLUSTER_MERGE_SCAN_CLUSTER_LIMIT,
  });
  const affectedIds = [...new Set(affectedClusterIds ?? [])];

  if (affectedIds.length === 0) {
    return recentClusters;
  }

  const affectedClusters = await prisma.contentCluster.findMany({
    where: {
      ...baseWhere,
      id: { in: affectedIds },
    },
    orderBy,
  });
  const existingIds = new Set(affectedClusters.map((cluster) => cluster.id));

  return [
    ...affectedClusters,
    ...recentClusters.filter((cluster) => !existingIds.has(cluster.id)),
  ];
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function executeClusterMerge(
  aiProvider: AiProvider | undefined,
  now: Date,
  options?: { liveClusterIds?: Iterable<string> },
): Promise<ClusterMergePassResult> {
  const lookbackSince = new Date(now.getTime() - CLUSTER_LOOKBACK_MS);
  const liveClusterIds = options?.liveClusterIds ? new Set(options.liveClusterIds) : null;
  const timings = {
    refreshItemCountsMs: 0,
    loadClustersMs: 0,
    candidateSelectionMs: 0,
    promptBuildMs: 0,
    promptChars: 0,
    promptPairs: 0,
    aiMergeMs: 0,
    applyMergeMs: 0,
    markEvaluatedMs: 0,
  };

  await markOrphanedClusterPairDecisionsStale(now);

  const refreshStartedAt = Date.now();
  await refreshRecentClusterItemCounts(lookbackSince);
  timings.refreshItemCountsMs = Date.now() - refreshStartedAt;
  const loadStartedAt = Date.now();
  const recentClusters = await loadRecentMergeClusters(lookbackSince, liveClusterIds ?? undefined);
  timings.loadClustersMs = Date.now() - loadStartedAt;
  const canonicalRecentClusters = await canonicalizeClusterMergeEntityMentions(recentClusters);
  const liveClusters = liveClusterIds
    ? recentClusters.filter((cluster) => liveClusterIds.has(cluster.id))
    : recentClusters;
  const selectionStartedAt = Date.now();

  // live 扫描的向量通道：给 dirty 聚类注入向量近邻，绕过词汇排名截断；
  // embedding 不可用时保持纯词汇扫描行为
  let vectorNeighbors: Map<string, Array<{ id: string; sim: number }>> | undefined;
  let vectorMatrix: { flat: Float32Array; dim: number } | null = null;
  if (aiProvider?.embedTexts && recentClusters.length > 1) {
    try {
      const vectors = await aiProvider.embedTexts(
        recentClusters.map((cluster) => buildEmbeddingText(cluster.title, cluster.summary)),
      );
      vectorMatrix = vectors ? buildNormalizedVectorMatrix(recentClusters, vectors) : null;
      if (vectorMatrix) {
        const matrix = vectorMatrix;
        vectorNeighbors = new Map();
        for (let i = 0; i < recentClusters.length; i += 1) {
          for (let j = i + 1; j < recentClusters.length; j += 1) {
            const sim = dotAt(matrix.flat, matrix.dim, i, j);
            if (sim < CLUSTER_MERGE_VECTOR_GRAY_SIM) continue;
            const left = recentClusters[i]!;
            const right = recentClusters[j]!;
            const leftList = vectorNeighbors.get(left.id) ?? [];
            const rightList = vectorNeighbors.get(right.id) ?? [];
            leftList.push({ id: right.id, sim });
            rightList.push({ id: left.id, sim });
            vectorNeighbors.set(left.id, leftList);
            vectorNeighbors.set(right.id, rightList);
          }
        }
        for (const [id, list] of vectorNeighbors) {
          list.sort((a, b) => b.sim - a.sim);
          vectorNeighbors.set(id, list.slice(0, 8));
        }
      }
    } catch {
      vectorNeighbors = undefined;
    }
  }

  const liveSelection = buildClusterMergeCandidateSelection(canonicalRecentClusters, {
    liveClusterIds: liveClusterIds ?? undefined,
    vectorNeighbors,
  });
  if (vectorMatrix) {
    const indexByClusterId = new Map(recentClusters.map((cluster, index) => [cluster.id, index]));
    for (const edge of liveSelection.allowedPairs) {
      const leftIndex = indexByClusterId.get(edge.leftId);
      const rightIndex = indexByClusterId.get(edge.rightId);
      if (leftIndex !== undefined && rightIndex !== undefined) {
        edge.vectorSimilarity = dotAt(vectorMatrix.flat, vectorMatrix.dim, leftIndex, rightIndex);
      }
    }
  }
  const precomputedSelection = mergePrecomputedCleanPairs({
    liveCandidates: liveSelection.candidates,
    liveAllowedPairs: liveSelection.allowedPairs,
    recentClusters,
    canonicalRecentClusters,
    storedPairs: await loadStoredCleanMergePairs(now),
  });
  timings.candidateSelectionMs = Date.now() - selectionStartedAt;
  const allCandidates = precomputedSelection.candidates;
  const candidatesById = new Map(allCandidates.map((candidate) => [candidate.id, candidate]));
  const blockedSelection = await filterBlockedClusterMergeEdges({
    candidatesById,
    allowedPairs: precomputedSelection.allowedPairs,
    now,
  });
  const allowedPairs = blockedSelection.allowedPairs;
  const evaluatedCandidates = liveClusterIds
    ? [...new Map([...liveClusters, ...allCandidates].map((cluster) => [cluster.id, cluster])).values()]
    : recentClusters;
  const diagnostics = liveSelection.diagnostics;
  timings.promptPairs = allowedPairs.length;

  const baseResult = {
    baseClusters: recentClusters.length,
    candidates: allCandidates.length,
    totalPairs: diagnostics.totalPairs,
    rejectedObjectConflict: diagnostics.rejectedObjectConflict,
    rejectedDateConflict: diagnostics.rejectedDateConflict,
    rejectedNoEventAnchor: diagnostics.rejectedNoEventAnchor,
    belowGrayScore: diagnostics.belowGrayScore,
    relatedPairs: diagnostics.relatedPairs,
    aiEligiblePairs: diagnostics.aiEligiblePairs,
    cleanPairsSkipped: diagnostics.cleanPairsSkipped,
    precomputedCleanPairsUsed: precomputedSelection.usedCount,
    precomputedCleanPairsAttemptSkipped: precomputedSelection.attemptSkipped,
    precomputedCleanPairsInvalidSkipped: precomputedSelection.invalidSkipped,
    blockedByCannotLink: blockedSelection.blockedByCannotLink,
    blockedByDeclinedDecision: blockedSelection.blockedByDeclinedDecision,
    blockedByReviewDecision: blockedSelection.blockedByReviewDecision,
    decisionsApproved: 0,
    decisionsDeclined: 0,
    decisionsAmbiguous: 0,
    decisionsFailed: 0,
    pairDiagnostics: [],
    dirtyPairs: diagnostics.dirtyPairs,
    preLimitCandidates: diagnostics.preLimitCandidates,
    postLimitCandidates: allCandidates.length,
    dirtyCandidates: diagnostics.dirtyCandidateCount,
    ...timings,
  };

  if (allCandidates.length < 2 || allowedPairs.length === 0) {
    const markStartedAt = Date.now();
    await markClusterMergeCandidatesEvaluated(evaluatedCandidates);
    timings.markEvaluatedMs = Date.now() - markStartedAt;

    return {
      ...baseResult,
      ...timings,
      aiMergeGroups: 0,
      skipped: true,
      mergedCount: 0,
      itemsMoved: 0,
      failedGroups: 0,
      affectedClusterIds: [],
    };
  }

  // `mergeInputHash` is per-cluster input state. This lets a new or changed
  // cluster pull in stable neighbors without repeatedly sending old clean pairs.
  const allHashesMatch = allCandidates.every(
    (candidate) => candidate.mergeInputHash === buildClusterMergeCandidateInputHash(candidate),
  );

  if (allHashesMatch && precomputedSelection.usedCount === 0) {
    const markStartedAt = Date.now();
    await markClusterMergeCandidatesEvaluated(evaluatedCandidates);
    timings.markEvaluatedMs = Date.now() - markStartedAt;

    return {
      ...baseResult,
      ...timings,
      aiMergeGroups: 0,
      skipped: true,
      mergedCount: 0,
      itemsMoved: 0,
      failedGroups: 0,
      affectedClusterIds: [],
    };
  }

  // If no AI provider, just update hashes and skip
  if (!aiProvider) {
    const markStartedAt = Date.now();
    await markClusterMergeCandidatesEvaluated(evaluatedCandidates);
    timings.markEvaluatedMs = Date.now() - markStartedAt;

    return {
      ...baseResult,
      ...timings,
      aiMergeGroups: 0,
      skipped: true,
      mergedCount: 0,
      itemsMoved: 0,
      failedGroups: 0,
      affectedClusterIds: [],
    };
  }

  // Build merge candidates and call AI
  const promptBuildStartedAt = Date.now();
  const clustersJson = buildClusterMergeInput(allCandidates, allowedPairs);
  timings.promptBuildMs = Date.now() - promptBuildStartedAt;
  timings.promptChars = clustersJson.length;
  let mergeGroups: string[][];
  let mergeDecisions: ClusterMergeDecision[] | undefined;
  let groupConflicts: ClusterMergeGroupConflict[] = [];
  const consistencyAudits = new Map<string, ClusterMergeDecisionConsistencyAudit>();

  const aiMergeStartedAt = Date.now();
  try {
    const batchDecisions: ClusterMergeDecision[] = [];
    const batchFailures: string[] = [];
    let firstBatchError: unknown = null;
    for (const batchInput of splitClusterMergeInputBatches(clustersJson, CLUSTER_MERGE_AI_PAIR_BATCH_SIZE)) {
      // 分片隔离：单批失败只影响该批的 pair，不再让 try 包住整个循环导致全量连坐。
      try {
        batchDecisions.push(...await aiProvider.assessClusterMergePairs(batchInput));
      } catch (error) {
        firstBatchError ??= error;
        const reason = error instanceof Error ? error.message : "Unknown cluster merge AI error";
        batchFailures.push(reason);
        console.error(`[Cluster Merge] AI 批次失败（其余批次继续）: ${reason}`);
      }
    }
    if (batchFailures.length > 0) {
      if (batchDecisions.length === 0) {
        // 整轮无一成功：按全量失败记账，并保留原始错误原因（不包装，便于归因）。
        throw firstBatchError ?? new Error(batchFailures[0]!);
      }
      console.warn(
        `[Cluster Merge] ${batchFailures.length} 个批次失败，已保留其余 ${batchDecisions.length} 条判定；失败批次的 pair 下一轮重新评估`,
      );
    }
    mergeDecisions = batchDecisions.map((decision) => {
      const left = candidatesById.get(decision.leftClusterId);
      const right = candidatesById.get(decision.rightClusterId);
      const result = reconcileApprovedClusterMergeDecision(
        decision,
        left && right ? checkClusterMergePairSafety(left, right).rejectedReason : null,
      );
      if (result.audit) {
        consistencyAudits.set(
          buildClusterMergeEdgeKey(decision.leftClusterId, decision.rightClusterId),
          result.audit,
        );
      }
      return result.decision;
    });
    const itemCounts = new Map(allCandidates.map((candidate) => [candidate.id, candidate.itemCount]));
    const groupResolution = resolveClusterMergeGroupsFromDecisions(mergeDecisions, itemCounts);
    mergeGroups = groupResolution.groups;
    groupConflicts = groupResolution.conflicts;
  } catch (error) {
    timings.aiMergeMs = Date.now() - aiMergeStartedAt;
    const failureReason = error instanceof Error ? error.message : "Unknown cluster merge AI error";
    console.error(`[Cluster Merge] AI decision failed: ${failureReason}`);
    const failedDecisions = await recordClusterMergeDecisions({
      candidatesById,
      allowedPairs,
      decisions: [],
      verdictOnMissing: "failed",
      failureReason,
      now,
    });

    return {
      ...baseResult,
      ...countClusterMergeDecisionVerdicts(failedDecisions),
      pairDiagnostics: buildClusterMergePairDiagnostics(candidatesById, allowedPairs, failedDecisions),
      ...timings,
      aiMergeGroups: 0,
      skipped: true,
      mergedCount: 0,
      itemsMoved: 0,
      failedGroups: 0,
      affectedClusterIds: [],
    };
  }
  timings.aiMergeMs = Date.now() - aiMergeStartedAt;
  const recordedMergeDecisions = await recordClusterMergeDecisions({
    candidatesById,
    allowedPairs,
    decisions: mergeDecisions,
    verdictOnMissing: "declined",
    now,
  });
  await markDeclinedPrecomputedCleanMergePairs(
    precomputedSelection.usedPairIdsByEdgeKey,
    allowedPairs,
    mergeGroups,
  );

  // Execute merges
  const affectedClusterIds = new Set<string>();
  const nonApprovedPairKeys = new Set(
    recordedMergeDecisions
      .filter((decision) => decision.verdict !== "approved")
      .map((decision) => decision.pairKey),
  );
  let mergedCount = 0;
  let itemsMoved = 0;
  let failedGroups = 0;

  const applyMergeStartedAt = Date.now();
  for (const group of mergeGroups) {
    if (group.length < 2) continue;

    // Sort by itemCount descending; the first becomes the target
    const groupWithCounts = group
      .map((id) => allCandidates.find((c) => c.id === id))
      .filter((c): c is NonNullable<typeof c> => c != null)
      .sort((a, b) => b.itemCount - a.itemCount);

    if (groupWithCounts.length < 2) continue;

    const target = groupWithCounts[0]!;
    const sources = filterClusterMergeSourcesByAllowedEdges(
      target.id,
      groupWithCounts.slice(1).map((c) => c.id),
      allowedPairs,
    );
    const selectedMemberIds = [target.id];
    const pairwiseSafeSources = sources.filter((sourceId) => {
      const conflictsWithSelectedMember = selectedMemberIds.some((selectedId) =>
        nonApprovedPairKeys.has(buildClusterMergeEdgeKey(selectedId, sourceId)),
      );
      if (!conflictsWithSelectedMember) selectedMemberIds.push(sourceId);
      return !conflictsWithSelectedMember;
    });

    if (pairwiseSafeSources.length === 0) continue;

    try {
      const stillAllowedSources: string[] = [];
      for (const sourceId of pairwiseSafeSources) {
        const blockingConstraint = await findBlockingClusterPairConstraint({
          leftClusterId: target.id,
          rightClusterId: sourceId,
          now,
        });
        if (!blockingConstraint) {
          stillAllowedSources.push(sourceId);
        }
      }
      if (stillAllowedSources.length === 0) {
        continue;
      }
      const mergeResult = await mergeClustersInternal(target.id, stillAllowedSources);
      affectedClusterIds.add(target.id);
      mergedCount += stillAllowedSources.length;
      itemsMoved += mergeResult.itemsMoved;
      await Promise.all(
        recordedMergeDecisions
          .filter((decision) => decision.verdict === "approved" && stillAllowedSources.some((sourceId) =>
            buildClusterMergeEdgeKey(target.id, sourceId) === decision.pairKey
          ))
          .map((decision) => prisma.clusterDecision.update({
            where: { id: decision.id },
            data: {
              appliedAt: new Date(),
              appliedAction: "merge_clusters_internal",
            },
          })),
      );
    } catch {
      // Continue with other groups on individual merge failure
      failedGroups += 1;
    }
  }
  timings.applyMergeMs = Date.now() - applyMergeStartedAt;

  // Update mergeInputHash on evaluated candidates after merge. Deleted source
  // clusters are ignored by updateMany.
  const markStartedAt = Date.now();
  await markClusterMergeCandidatesEvaluated(evaluatedCandidates);
  timings.markEvaluatedMs = Date.now() - markStartedAt;

  return {
    ...baseResult,
    ...countClusterMergeDecisionVerdicts(recordedMergeDecisions),
    pairDiagnostics: buildClusterMergePairDiagnostics(
      candidatesById,
      allowedPairs,
      recordedMergeDecisions,
      consistencyAudits,
      groupConflicts,
    ),
    ...timings,
    aiMergeGroups: mergeGroups.filter((group) => group.length >= 2).length,
    skipped: false,
    mergedCount,
    itemsMoved,
    failedGroups,
    affectedClusterIds: [...affectedClusterIds],
  };
}

export type ClusterMergeCleanPairPrecomputeResult = {
  baseClusters: number;
  cleanClusters: number;
  scoredPairs: number;
  candidatePairs: number;
  storedPairs: number;
  /** 仅凭向量相似（规则分不达灰区）获得提名的对数 */
  vectorAdmittedPairs: number;
  vectorEnabled: boolean;
  durationMs: number;
};

function toCleanPairCandidateRecord(
  left: ClusterMergeCandidate,
  right: ClusterMergeCandidate,
  score: number,
  provenance: { recallSource: "bm25" | "vector" | "bm25+vector"; bm25Score: number; vectorSimilarity: number | null },
) {
  const [first, second] = [left, right].sort((a, b) => a.id.localeCompare(b.id));

  return {
    pairKey: buildClusterMergeCleanPairKey(first, second),
    leftClusterId: first.id,
    rightClusterId: second.id,
    leftInputHash: buildClusterMergeCandidateInputHash(first),
    rightInputHash: buildClusterMergeCandidateInputHash(second),
    score,
    ...provenance,
  };
}

async function upsertCleanPairCandidates(input: {
  pairs: Array<ReturnType<typeof toCleanPairCandidateRecord>>;
  expiresAt: Date;
}) {
  if (input.pairs.length === 0) {
    return;
  }

  await prisma.$transaction(
    input.pairs.map((pair) =>
      prisma.clusterMergeCleanPairCandidate.upsert({
        where: { pairKey: pair.pairKey },
        create: {
          ...pair,
          expiresAt: input.expiresAt,
        },
        update: {
          leftClusterId: pair.leftClusterId,
          rightClusterId: pair.rightClusterId,
          leftInputHash: pair.leftInputHash,
          rightInputHash: pair.rightInputHash,
          score: pair.score,
          recallSource: pair.recallSource,
          bm25Score: pair.bm25Score,
          vectorSimilarity: pair.vectorSimilarity,
          expiresAt: input.expiresAt,
        },
      }),
    ),
  );
}

function buildNormalizedVectorMatrix(
  clusters: ClusterMergeCandidate[],
  vectors: Array<number[] | null>,
): { flat: Float32Array; dim: number } | null {
  if (vectors.length !== clusters.length || vectors.length === 0) {
    return null;
  }

  // 缺失向量（嵌入失败的文本）按零向量处理：点积恒 0，相似度恒 0，
  // 效果等价于「无向量邻居」，不影响其余聚类的向量预筛。
  const dim = vectors.find((vector): vector is number[] => vector !== null && vector.length > 0)?.length ?? 0;
  if (dim === 0) {
    return null;
  }

  const flat = new Float32Array(clusters.length * dim);
  for (let i = 0; i < clusters.length; i += 1) {
    const vector = vectors[i]!;
    if (vector === null || vector.length !== dim) {
      continue;
    }

    let norm = 0;
    for (let d = 0; d < dim; d += 1) norm += vector[d]! * vector[d]!;
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < dim; d += 1) flat[i * dim + d] = vector[d]! / norm;
  }

  return { flat, dim };
}

function dotAt(flat: Float32Array, dim: number, i: number, j: number): number {
  let dot = 0;
  const baseI = i * dim;
  const baseJ = j * dim;
  for (let d = 0; d < dim; d += 1) dot += flat[baseI + d]! * flat[baseJ + d]!;
  return dot;
}

export async function precomputeClusterMergeCleanPairs(
  now = new Date(),
  options?: { embedTexts?: EmbedTextsFn | null },
): Promise<ClusterMergeCleanPairPrecomputeResult> {
  const startedAt = Date.now();
  const lookbackSince = new Date(now.getTime() - CLUSTER_LOOKBACK_MS);
  const expiresAt = new Date(now.getTime() + CLUSTER_MERGE_CLEAN_PAIR_TTL_MS);

  await refreshRecentClusterItemCounts(lookbackSince);
  await prisma.clusterMergeCleanPairCandidate.deleteMany({
    where: { expiresAt: { lte: now } },
  });

  const recentClusters = await loadRecentMergeClusters(lookbackSince);
  const cleanClusters = recentClusters.filter(isClusterMergeCandidateClean);
  const candidates: Array<ReturnType<typeof toCleanPairCandidateRecord>> = [];
  let scoredPairs = 0;
  let scoredPairsInSlice = 0;
  let vectorAdmittedPairs = 0;

  // 评分使用 canonical 实体名；缓存 inputHash 仍使用原始聚类字段。
  const canonicalCorpusClusters = await canonicalizeClusterMergeEntityMentions(recentClusters);
  const canonicalById = new Map(canonicalCorpusClusters.map((cluster) => [cluster.id, cluster]));
  const canonicalClusters = cleanClusters.map((cluster) => canonicalById.get(cluster.id) ?? cluster);

  const bm25Index = buildClusterMergeBm25Index(canonicalCorpusClusters);

  // 向量预筛通道：与 BM25 lexical recall 并集提名；embedding 不可用时保持纯 BM25 行为
  let vecMatrix: { flat: Float32Array; dim: number } | null = null;
  if (options?.embedTexts && cleanClusters.length > 1) {
    try {
      const vectors = await options.embedTexts(
        cleanClusters.map((cluster) => buildEmbeddingText(cluster.title, cluster.summary)),
      );
      if (vectors) {
        vecMatrix = buildNormalizedVectorMatrix(cleanClusters, vectors);
      }
    } catch {
      vecMatrix = null;
    }
  }

  for (let leftStart = 0; leftStart < cleanClusters.length; leftStart += CLUSTER_MERGE_PRECOMPUTE_BATCH_SIZE) {
    const leftEnd = Math.min(cleanClusters.length, leftStart + CLUSTER_MERGE_PRECOMPUTE_BATCH_SIZE);

    for (let leftIndex = leftStart; leftIndex < leftEnd; leftIndex += 1) {
      const left = cleanClusters[leftIndex]!;

      for (let rightIndex = leftIndex + 1; rightIndex < cleanClusters.length; rightIndex += 1) {
        const right = cleanClusters[rightIndex]!;
        const leftCanonical = canonicalClusters[leftIndex]!;
        const rightCanonical = canonicalClusters[rightIndex]!;
        const safety = checkClusterMergePairSafety(leftCanonical, rightCanonical);
        const bm25Score = scoreClusterMergeBm25Pair(bm25Index, leftCanonical.id, rightCanonical.id);
        scoredPairs += 1;
        scoredPairsInSlice += 1;

        const vectorSim = vecMatrix ? dotAt(vecMatrix.flat, vecMatrix.dim, leftIndex, rightIndex) : null;
        const admission = resolveMergePairAdmission(
          { ...safety, score: bm25Score },
          vectorSim,
          Number.MIN_VALUE,
          CLUSTER_MERGE_VECTOR_GRAY_SIM,
        );

        if (!admission.admitted) {
          if (
            scoredPairsInSlice >= CLUSTER_MERGE_PRECOMPUTE_PAIR_SLICE_SIZE &&
            CLUSTER_MERGE_PRECOMPUTE_PAIR_SLICE_DELAY_MS > 0
          ) {
            scoredPairsInSlice = 0;
            await sleep(CLUSTER_MERGE_PRECOMPUTE_PAIR_SLICE_DELAY_MS);
          }
          continue;
        }

        if (admission.source === "vector") {
          vectorAdmittedPairs += 1;
        }
        const vectorAdmitted = vectorSim !== null && vectorSim >= CLUSTER_MERGE_VECTOR_GRAY_SIM;
        const bm25Admitted = !safety.rejected && bm25Score > 0;
        const recallSource = bm25Admitted && vectorAdmitted
          ? "bm25+vector"
          : vectorAdmitted
            ? "vector"
            : "bm25";
        const priorityScore = admission.source === "vector"
          ? admission.priorityScore * CLUSTER_MERGE_BM25_SCORE_SCALE
          : admission.priorityScore;
        candidates.push(toCleanPairCandidateRecord(left, right, priorityScore, {
          recallSource,
          bm25Score,
          vectorSimilarity: vectorSim,
        }));
        if (
          scoredPairsInSlice >= CLUSTER_MERGE_PRECOMPUTE_PAIR_SLICE_SIZE &&
          CLUSTER_MERGE_PRECOMPUTE_PAIR_SLICE_DELAY_MS > 0
        ) {
          scoredPairsInSlice = 0;
          await sleep(CLUSTER_MERGE_PRECOMPUTE_PAIR_SLICE_DELAY_MS);
        }
      }
    }

    if (candidates.length > CLUSTER_MERGE_PRECOMPUTE_PAIR_LIMIT * 4) {
      candidates.sort((left, right) => right.score - left.score || left.pairKey.localeCompare(right.pairKey));
      candidates.splice(CLUSTER_MERGE_PRECOMPUTE_PAIR_LIMIT * 2);
    }

    if (leftEnd < cleanClusters.length && CLUSTER_MERGE_PRECOMPUTE_BATCH_DELAY_MS > 0) {
      await sleep(CLUSTER_MERGE_PRECOMPUTE_BATCH_DELAY_MS);
    }
  }

  candidates.sort((left, right) => right.score - left.score || left.pairKey.localeCompare(right.pairKey));
  const topCandidates = candidates.slice(0, CLUSTER_MERGE_PRECOMPUTE_PAIR_LIMIT);
  await upsertCleanPairCandidates({ pairs: topCandidates, expiresAt });

  return {
    baseClusters: recentClusters.length,
    cleanClusters: cleanClusters.length,
    scoredPairs,
    candidatePairs: candidates.length,
    storedPairs: topCandidates.length,
    vectorAdmittedPairs,
    vectorEnabled: vecMatrix !== null,
    durationMs: Date.now() - startedAt,
  };
}

type ClusterMergeResult = {
  targetClusterId: string;
  mergedClusterIds: string[];
  itemsMoved: number;
  taskId: string;
};

export async function mergeClusters(
  targetClusterId: string,
  sourceClusterIds: string[],
): Promise<ClusterMergeResult> {
  if (sourceClusterIds.length === 0) {
    throw new Error("至少需要选择一个要合并的聚合组");
  }

  if (sourceClusterIds.includes(targetClusterId)) {
    throw new Error("目标聚合组不能在待合并列表中");
  }

  // 验证目标聚合组存在且为active状态
  const targetCluster = await prisma.contentCluster.findUnique({
    where: { id: targetClusterId },
    include: {
      items: {
        where: {
          status: "processed",
          moderationStatus: { in: ["allowed", "restored"] },
        },
      },
    },
  });

  if (!targetCluster) {
    throw new Error("目标聚合组不存在");
  }

  if (targetCluster.status !== "active") {
    throw new Error("只能合并到active状态的聚合组");
  }

  // 验证所有源聚合组存在且为active状态
  const sourceClusters = await prisma.contentCluster.findMany({
    where: {
      id: { in: sourceClusterIds },
      status: "active",
    },
    include: {
      items: {
        where: {
          status: "processed",
          moderationStatus: { in: ["allowed", "restored"] },
        },
      },
    },
  });

  if (sourceClusters.length !== sourceClusterIds.length) {
    const foundIds = new Set(sourceClusters.map((c) => c.id));
    const missingIds = sourceClusterIds.filter((id) => !foundIds.has(id));
    throw new Error(`部分聚合组不存在或已隐藏: ${missingIds.join(", ")}`);
  }

  // 收集所有要移动的条目
  const itemsToMove: string[] = [];
  for (const cluster of sourceClusters) {
    for (const item of cluster.items) {
      itemsToMove.push(item.id);
    }
  }

  if (itemsToMove.length === 0) {
    throw new Error("选中的聚合组中没有可移动的条目");
  }

  for (const sourceClusterId of sourceClusterIds) {
    await createMustLinkForClusters(targetClusterId, sourceClusterId, "manual cluster merge");
  }

  // 移动所有条目到目标聚合组
  await prisma.item.updateMany({
    where: { id: { in: itemsToMove } },
    data: { clusterId: targetClusterId },
  });

  await prisma.contentCluster.deleteMany({
    where: {
      id: { in: sourceClusterIds },
      items: { none: {} },
    },
  });
  await refreshClusterStats(targetClusterId);

  // 清除缓存
  invalidateFeedCache();

  // 创建异步任务重新生成目标聚合组摘要
  const task = await enqueueClusterSummaryTask(
    targetClusterId,
    `合并 ${sourceClusterIds.length} 个聚合组后重新生成摘要`
  );

  return {
    targetClusterId,
    mergedClusterIds: sourceClusterIds,
    itemsMoved: itemsToMove.length,
    taskId: task.id,
  };
}
