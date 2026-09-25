import type { BackgroundTaskRun, FetchRunStatus } from "@prisma/client";
import type { DomainTaskContext } from "@infinitum/ai/orchestration/task-definition";
import { createClusterAssignmentCoordinator } from "@/lib/clusters/helpers";
import { executeClusterMerge, recomputeCluster } from "@/lib/clusters/service";
import { refreshClusterFeedStatsSafely } from "@/lib/clusters/feed-stats";
import { prisma } from "@/lib/db";
import { invalidateFeedCache } from "@/lib/feed/cache";
import { scheduleDefaultFeedCacheWarm } from "@/lib/feed/warmup";
import {
  completeFetchRun,
  createFetchRun,
  findDedupeHistoriesForUrlHashes,
  findExistingItemsForUrlHashes,
  syncSources,
  updateFetchRunProgress,
  updateSourceFetchMetadata,
  updateSourceHealthStatus,
} from "@/lib/feed/repository";
import {
  buildPreparedFeedItemLookup,
  parsePublishedAt,
  processFeedItem,
  type PreparedFeedItem,
  type PreparedFeedItemLookup,
} from "@/lib/ingestion/item-processor";
import {
  buildFeedContentHash,
  buildFeedRequestHeaders,
  dedupePreparedLookupsByDedupeKey,
  getExistingItemForLookup,
  hasItemProcessingFailure,
  buildItemProcessingFailureMessage,
  resolveRunOptions,
  runWithConcurrency,
  shouldEnqueueProcessingRecoveryFromIngestion,
  type ResolvedRunOptions,
} from "@/lib/ingestion/service";
import { enqueueItemProcessingRecoveryTask } from "@/lib/items/processing-recovery";
import { enqueuePrecomputeTask } from "@/lib/precompute/service";
import {
  TASK_RUN_CANCELLED_LABEL,
  TASK_RUN_CANCELLED_MESSAGE,
  updateTaskRun,
} from "@/lib/tasks/service";
import { DEFAULT_FULL_TEXT_FETCH_THRESHOLD } from "@/lib/tasks/scheduler";
import type { TaskAiCallBreakdownSnapshot, TaskStageTimingSnapshot, TaskTimelineNodeSnapshot } from "@/lib/tasks/types";
import type { ProcessedItemRecord, RunIngestionOptions } from "@/lib/ingestion/types";
import {
  buildIngestionTaskTimeline,
  createIngestionTimelineCounters,
  createIngestionTimelineModelNames,
  type IngestionStageTiming,
  type IngestionTaskStageState,
  type IngestionTimelineCounters,
  type IngestionTimelineModelNames,
} from "@/lib/ingestion/task-timeline";

export type IngestionWorkflowStage = "source_sync" | "item_processing" | "cluster_merge" | "cluster_finalize";

export type IngestionWorkflowPayload = {
  fetchRunId: string;
  trigger: "scheduled" | "manual";
  now: string;
  preparedItems: PreparedFeedItem[];
  sourceCount: number;
  sourceFailureCount: number;
  processableItemCount: number;
  successCount: number;
  failureCount: number;
  itemsAdded: number;
  fullTextFetchedCount: number;
  errors: string[];
  affectedClusterIds: string[];
  aiCallCountActual: number;
  aiCallCountEstimated: number;
  aiCallBreakdown: TaskAiCallBreakdownSnapshot[];
  timelineCounters: IngestionTimelineCounters;
  timelineStages: Record<keyof IngestionTaskStageState, TaskStageTimingSnapshot | null>;
  timelineModelNames: IngestionTimelineModelNames;
};

type IngestionStageKey = keyof IngestionTaskStageState;

function toIngestionStageTiming(timing: TaskStageTimingSnapshot | null): IngestionStageTiming | null {
  if (!timing) return null;
  return {
    key: timing.key,
    label: timing.label,
    startedAt: timing.startedAt ? new Date(timing.startedAt) : null,
    finishedAt: timing.finishedAt ? new Date(timing.finishedAt) : null,
    durationMs: timing.durationMs,
  };
}

function createEmptyTimelineStages(): Record<keyof IngestionTaskStageState, TaskStageTimingSnapshot | null> {
  return { sourceSync: null, itemProcessing: null, clusterMerge: null, clusterFinalize: null };
}

function buildIngestionTimeline(payload: IngestionWorkflowPayload): TaskTimelineNodeSnapshot[] {
  const timingSnapshots = { ...createEmptyTimelineStages(), ...payload.timelineStages };
  const stages: IngestionTaskStageState = {
    sourceSync: toIngestionStageTiming(timingSnapshots.sourceSync),
    itemProcessing: toIngestionStageTiming(timingSnapshots.itemProcessing),
    clusterMerge: toIngestionStageTiming(timingSnapshots.clusterMerge),
    clusterFinalize: toIngestionStageTiming(timingSnapshots.clusterFinalize),
  };
  return buildIngestionTaskTimeline({
    counters: payload.timelineCounters ?? createIngestionTimelineCounters(),
    stages,
    modelNames: payload.timelineModelNames ?? createIngestionTimelineModelNames(),
  });
}

function accumulateItemTimelineMetrics(counters: IngestionTimelineCounters, result: ProcessedItemRecord) {
  const metrics = result.metrics;
  if (!metrics) return;
  if (metrics.blacklistFiltered) counters.ruleFilter.ruleFiltered += 1;
  if (metrics.reusedExisting) counters.ruleFilter.reusedExisting += 1;
  if (metrics.summaryCompleted) counters.itemSummary.completed += 1;
  if (metrics.summaryFailed) counters.itemSummary.failed += 1;
  if (metrics.aggregationParsed) counters.aggregationParsing.parsed += 1;
  if (metrics.aggregationParseFailed) counters.aggregationParsing.failed += 1;
  counters.aggregationParsing.events += metrics.aggregationEventCount ?? 0;
  if (metrics.analysisCompleted) counters.itemAnalysis.completed += 1;
  if (metrics.analysisFailed) counters.itemAnalysis.failed += 1;
  if (metrics.analysisFiltered) counters.itemAnalysis.filtered += 1;
  if (metrics.updatedExisting) counters.itemAnalysis.updatedExisting += 1;
  if (metrics.fullTextFetchAttempted) counters.sourceFetch.fullTextFetchAttempted += 1;
  if (metrics.fullTextFetchReason === "rss_html") counters.sourceFetch.fullTextFetchRssHtml += 1;
  if (metrics.fullTextFetchReason === "short_content") counters.sourceFetch.fullTextFetchShortContent += 1;
  if (metrics.fullTextFetchLocalAttempted) counters.sourceFetch.fullTextFetchLocalAttempted += 1;
  if (metrics.fullTextFetchJinaAttempted) counters.sourceFetch.fullTextFetchJinaAttempted += 1;
  if (metrics.fullTextFetchSource === "local") counters.sourceFetch.fullTextFetchLocalUsed += 1;
  if (metrics.fullTextFetchSource === "jina") counters.sourceFetch.fullTextFetchJinaUsed += 1;
  counters.sourceFetch.fullTextFetchDurationMs += Math.round(metrics.timings?.fullTextFetchMs ?? 0);
  counters.ruleFilter.durationMs += Math.round(metrics.timings?.ruleFilterMs ?? 0);
  counters.ruleFilter.itemTotalDurationMs += Math.round(metrics.timings?.totalMs ?? 0);
  counters.ruleFilter.dbWriteDurationMs += Math.round(metrics.timings?.dbWriteMs ?? 0);
  counters.itemAnalysis.durationMs += Math.round(metrics.timings?.analysisMs ?? 0);
  counters.clusterAssignment.durationMs += Math.round(metrics.timings?.clusterAssignmentMs ?? 0);
  counters.clusterAssignment.exactMatch += metrics.clusterAssignment?.exactMatch ?? 0;
  counters.clusterAssignment.cheapRankDirect += metrics.clusterAssignment?.cheapRankDirect ?? 0;
  counters.clusterAssignment.aiMatch += metrics.clusterAssignment?.aiMatch ?? 0;
  counters.clusterAssignment.skippedIncompleteSignature += metrics.clusterAssignment?.skippedIncompleteSignature ?? 0;
  counters.clusterAssignment.newCluster += metrics.clusterAssignment?.newCluster ?? 0;
}

export function mergeIngestionStageAiBreakdown(
  previousEntries: TaskAiCallBreakdownSnapshot[],
  incomingEntries: TaskAiCallBreakdownSnapshot[],
): TaskAiCallBreakdownSnapshot[] {
  const breakdown = new Map(previousEntries.map((entry) => [entry.key, { ...entry }]));
  for (const entry of incomingEntries) {
    const previous = breakdown.get(entry.key);
    const previousSource = previous?.tokenUsageSource;
    const nextSource = entry.tokenUsageSource;
    const previousCachedStatus = previous?.cachedTokensStatus;
    const nextCachedStatus = entry.cachedTokensStatus;
    const cachedTokensStatus = previousCachedStatus === undefined
      ? nextCachedStatus
      : nextCachedStatus === undefined || previousCachedStatus === nextCachedStatus
        ? previousCachedStatus
        : "partial";
    breakdown.set(entry.key, {
      ...previous,
      ...entry,
      ...((previous?.modelNames?.length ?? 0) > 0 || (entry.modelNames?.length ?? 0) > 0
        ? { modelNames: [...new Set([...(previous?.modelNames ?? []), ...(entry.modelNames ?? [])])] }
        : {}),
      actual: (previous?.actual ?? 0) + entry.actual,
      estimated: (previous?.estimated ?? 0) + entry.estimated,
      ...(entry.promptTokens !== undefined || previous?.promptTokens !== undefined
        ? { promptTokens: (previous?.promptTokens ?? 0) + (entry.promptTokens ?? 0) }
        : {}),
      ...(entry.completionTokens !== undefined || previous?.completionTokens !== undefined
        ? { completionTokens: (previous?.completionTokens ?? 0) + (entry.completionTokens ?? 0) }
        : {}),
      ...(entry.totalTokens !== undefined || previous?.totalTokens !== undefined
        ? { totalTokens: (previous?.totalTokens ?? 0) + (entry.totalTokens ?? 0) }
        : {}),
      ...(entry.cachedTokens !== undefined || previous?.cachedTokens !== undefined
        ? { cachedTokens: (previous?.cachedTokens ?? 0) + (entry.cachedTokens ?? 0) }
        : {}),
      ...(cachedTokensStatus !== undefined ? { cachedTokensStatus } : {}),
      ...(previousSource && nextSource && previousSource !== nextSource
        ? { tokenUsageSource: "mixed" as const }
        : { tokenUsageSource: nextSource ?? previousSource }),
    });
  }
  return [...breakdown.values()];
}

function mergeStageAiUsage(
  payload: IngestionWorkflowPayload,
  usage: ReturnType<ResolvedRunOptions["aiUsage"]["snapshot"]>,
): Pick<IngestionWorkflowPayload, "aiCallCountActual" | "aiCallCountEstimated" | "aiCallBreakdown"> {
  return {
    aiCallCountActual: payload.aiCallCountActual + usage.actual,
    aiCallCountEstimated: payload.aiCallCountEstimated + usage.estimated,
    aiCallBreakdown: mergeIngestionStageAiBreakdown(payload.aiCallBreakdown, usage.breakdown),
  };
}

function finishTimelineStage(
  payload: IngestionWorkflowPayload,
  stage: IngestionStageKey,
  startedAt: Date,
  finishedAt: Date,
): IngestionWorkflowPayload {
  const keyByStage: Record<IngestionStageKey, string> = {
    sourceSync: "source_sync",
    itemProcessing: "item_processing",
    clusterMerge: "cluster_merge",
    clusterFinalize: "cluster_finalize",
  };
  const labelByStage: Record<IngestionStageKey, string> = {
    sourceSync: "信息源同步",
    itemProcessing: "内容处理",
    clusterMerge: "聚合合并",
    clusterFinalize: "聚合收尾",
  };
  const timelineStages = {
    ...createEmptyTimelineStages(),
    ...payload.timelineStages,
    [stage]: {
      key: keyByStage[stage],
      label: labelByStage[stage],
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    },
  };
  return { ...payload, timelineStages };
}

function asTaskRun(input: unknown): Pick<BackgroundTaskRun, "id" | "triggerType"> {
  if (!input || typeof input !== "object" || !("id" in input) || typeof input.id !== "string") {
    throw new Error("Ingestion task id is required.");
  }
  return input as Pick<BackgroundTaskRun, "id" | "triggerType">;
}

function taskRunIdFromInput(input: unknown): string {
  return asTaskRun(input).id;
}

async function resolveStageOptions(
  payload?: IngestionWorkflowPayload,
  overrides?: Partial<RunIngestionOptions>,
): Promise<ResolvedRunOptions> {
  return resolveRunOptions({
    ...overrides,
    trigger: payload?.trigger ?? overrides?.trigger ?? "manual",
    now: payload ? new Date(payload.now) : overrides?.now ?? new Date(),
  });
}

export async function findOrCreateIngestionFetchRun(
  taskRunId: string,
  trigger: "scheduled" | "manual",
  startedAt: Date,
) {
  const resumedRun = await prisma.fetchRun.findFirst({
    where: { taskRunId, status: "running" },
    orderBy: { startedAt: "desc" },
  });
  return resumedRun ?? createFetchRun(trigger, startedAt, taskRunId);
}

async function runSourceSyncStage(
  taskRun: Pick<BackgroundTaskRun, "id" | "triggerType">,
  context: DomainTaskContext,
  overrides?: Partial<RunIngestionOptions>,
): Promise<IngestionWorkflowPayload> {
  const trigger = taskRun.triggerType === "scheduled" ? "scheduled" : "manual";
  const now = overrides?.now ?? new Date();
  const startedAt = now;
  const options = await resolveRunOptions({ ...overrides, trigger, now });
  const run = await findOrCreateIngestionFetchRun(taskRun.id, trigger, now);
  const sources = await syncSources(options.sourceConfigs);
  const preparedItems: PreparedFeedItem[] = [];
  const errors: string[] = [];
  let sourceFailureCount = 0;

  await runWithConcurrency(
    sources.map((source) => async () => {
      await context.checkCancellation();
      try {
        const feed = await options.parser.parseURL(source.rssUrl, {
          headers: buildFeedRequestHeaders(source),
        });
        if (feed.notModified) {
          await updateSourceFetchMetadata(source.id, {
            feedEtag: feed.etag ?? source.feedEtag,
            feedLastModified: feed.lastModified ?? source.feedLastModified,
            lastFetchedAt: now,
            healthStatus: "healthy",
            healthMessage: null,
            healthCheckedAt: now,
          });
          return;
        }
        const allItems = feed.items ?? [];
        const feedContentHash = buildFeedContentHash(allItems);
        if (source.feedContentHash && source.feedContentHash === feedContentHash) {
          await updateSourceFetchMetadata(source.id, {
            feedEtag: feed.etag ?? source.feedEtag,
            feedLastModified: feed.lastModified ?? source.feedLastModified,
            feedContentHash,
            lastFetchedAt: now,
            healthStatus: "healthy",
            healthMessage: null,
            healthCheckedAt: now,
          });
          return;
        }
        await updateSourceFetchMetadata(source.id, {
          feedEtag: feed.etag ?? source.feedEtag,
          feedLastModified: feed.lastModified ?? source.feedLastModified,
          feedContentHash,
          lastFetchedAt: now,
          healthStatus: "healthy",
          healthMessage: null,
          healthCheckedAt: now,
        });
        const items = allItems
          .map((item) => ({ item, publishedAt: parsePublishedAt(item, now) }))
          .sort((left, right) => {
            if (left.publishedAt.known !== right.publishedAt.known) return left.publishedAt.known ? -1 : 1;
            return right.publishedAt.value.getTime() - left.publishedAt.value.getTime();
          })
          .filter(({ publishedAt }) => !options.processingStartAt || !publishedAt.known || publishedAt.value >= options.processingStartAt)
          .slice(0, options.maxFeedItemsToScan ?? 500)
          .slice(0, options.perSourceItemLimit)
          .map(({ item }) => item);
        for (const item of items) {
          preparedItems.push({
            item,
            sourceId: source.id,
            sourceName: source.name,
            aiParsingEnabled: source.aiParsingEnabled,
            aggregationEnabled: source.aggregationEnabled,
            aggregationDetectionEnabled: source.aggregationDetectionEnabled,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown feed error";
        sourceFailureCount += 1;
        errors.push(`${source.name}: ${message}`);
        await updateSourceHealthStatus(source.id, {
          healthStatus: "failed",
          healthMessage: message,
          healthCheckedAt: now,
        });
      }
    }),
    options.sourceConcurrency,
    { shouldStop: async () => context.signal.aborted },
  );

  const timelineCounters = createIngestionTimelineCounters();
  timelineCounters.sourceFetch.sourcesFetched = sources.length;
  timelineCounters.sourceFetch.sourcesFailed = sourceFailureCount;
  timelineCounters.sourceFetch.itemsFetched = preparedItems.length;
  const initialPayload: IngestionWorkflowPayload = {
    fetchRunId: run.id,
    trigger,
    now: now.toISOString(),
    preparedItems,
    sourceCount: sources.length,
    sourceFailureCount,
    processableItemCount: 0,
    successCount: 0,
    failureCount: sourceFailureCount,
    itemsAdded: 0,
    fullTextFetchedCount: 0,
    errors,
    affectedClusterIds: [],
    aiCallCountActual: 0,
    aiCallCountEstimated: 0,
    aiCallBreakdown: [],
    timelineCounters,
    timelineStages: { sourceSync: null, itemProcessing: null, clusterMerge: null, clusterFinalize: null },
    timelineModelNames: options.taskTimelineModelNames ?? createIngestionTimelineModelNames(),
  };
  const payload = finishTimelineStage(initialPayload, "sourceSync", startedAt, new Date());
  await updateFetchRunProgress(run.id, {
    sourceCount: payload.sourceCount,
    itemCount: 0,
    successCount: 0,
    failureCount: payload.failureCount,
    itemsAdded: 0,
    errorSummary: errors.length > 0 ? errors.join(" | ") : null,
  });
  await updateTaskRun(taskRun.id, {
    status: "running",
    progressCurrent: 0,
    progressTotal: preparedItems.length,
    progressLabel: `已同步 ${sources.length} 个源，准备处理 ${preparedItems.length} 条内容`,
    taskTimeline: buildIngestionTimeline(payload),
  });
  return payload;
}

async function runItemProcessingStage(
  payload: IngestionWorkflowPayload,
  context: DomainTaskContext,
  overrides?: Partial<RunIngestionOptions>,
): Promise<IngestionWorkflowPayload> {
  const startedAt = new Date();
  const options = await resolveStageOptions(payload, overrides);
  const preparedLookupEntries = dedupePreparedLookupsByDedupeKey(
    payload.preparedItems
      .map((preparedItem) => ({ preparedItem, lookup: buildPreparedFeedItemLookup(preparedItem, new Date(payload.now)) }))
      .filter((entry) => !entry.lookup || !options.processingStartAt || !entry.lookup.publishedAtKnown || entry.lookup.publishedAt >= options.processingStartAt),
  );
  const dedupeKeyInputs = preparedLookupEntries
    .map((entry) => entry.lookup)
    .filter((lookup): lookup is PreparedFeedItemLookup => Boolean(lookup))
    .map((lookup) => lookup.dedupeKeys.urlHash);
  const existingItems = await findExistingItemsForUrlHashes(dedupeKeyInputs);
  const existingByUrlHash = new Map(existingItems.map((item) => [item.urlHash, item]));
  const histories = await findDedupeHistoriesForUrlHashes(dedupeKeyInputs);
  const historyByUrlHash = new Map(histories.map((history) => [history.urlHash, history]));
  const preparedLookups = preparedLookupEntries.filter((entry) => {
    const existing = getExistingItemForLookup(entry.lookup, existingByUrlHash);
    return Boolean(existing) || !entry.lookup || !historyByUrlHash.has(entry.lookup.dedupeKeys.urlHash);
  });
  const aiUsage = options.aiUsage;
  const trackedAiProvider = aiUsage.wrapProvider(options.aiProvider, { understandItemEstimated: false });
  const coordinator = createClusterAssignmentCoordinator();
  const affectedClusterIds = new Set(payload.affectedClusterIds);
  const errors = [...payload.errors];
  let successCount = payload.successCount;
  let failureCount = payload.failureCount;
  let itemsAdded = payload.itemsAdded;
  let fullTextFetchedCount = payload.fullTextFetchedCount;
  const timelineCounters = structuredClone(payload.timelineCounters ?? createIngestionTimelineCounters());
  timelineCounters.sourceFetch.itemsFetched = preparedLookups.length;

  await updateTaskRun(taskRunIdFromInput({ id: context.taskRunId }), {
    progressCurrent: 0,
    progressTotal: preparedLookups.length,
    progressLabel: `开始处理 ${preparedLookups.length} 条内容`,
  });
  await runWithConcurrency(
    preparedLookups.map(({ preparedItem, lookup }) => async () => {
      try {
        await context.checkCancellation();
      } catch (error) {
        if (context.signal.aborted) return;
        throw error;
      }
      try {
        const existingItem = getExistingItemForLookup(lookup, existingByUrlHash);
        const result = await processFeedItem({
          ...preparedItem,
          lookup,
          existingItem,
          blacklist: options.blacklist,
          articleFetcher: options.articleFetcher,
          aiProvider: trackedAiProvider,
          clusterAssignmentCoordinator: coordinator,
          fullTextFetchThreshold: options.fullTextFetchThreshold ?? DEFAULT_FULL_TEXT_FETCH_THRESHOLD,
          contentExtraction: options.contentExtraction,
          now: new Date(payload.now),
        });
        if (!result) return;
        accumulateItemTimelineMetrics(timelineCounters, result);
        if (result.status === "failed" || hasItemProcessingFailure(result)) {
          failureCount += 1;
          if (hasItemProcessingFailure(result)) errors.push(buildItemProcessingFailureMessage(result));
        } else if (result.status !== "filtered") {
          successCount += 1;
          if (result.isNew) itemsAdded += 1;
        }
        if (result.fullTextFetched) {
          fullTextFetchedCount += 1;
          timelineCounters.sourceFetch.fullTextFetched += 1;
        }
        if (result.affectedClusterId) affectedClusterIds.add(result.affectedClusterId);
        for (const clusterId of result.affectedClusterIds ?? []) affectedClusterIds.add(clusterId);
      } catch (error) {
        failureCount += 1;
        errors.push(error instanceof Error ? error.message : "Unknown item processing error");
      }
    }),
    options.itemConcurrency,
    { shouldStop: async () => context.signal.aborted },
  );
  const snapshot = aiUsage.snapshot();
  const next = finishTimelineStage({
    ...payload,
    processableItemCount: preparedLookups.length,
    successCount,
    failureCount,
    itemsAdded,
    fullTextFetchedCount,
    errors,
    affectedClusterIds: [...affectedClusterIds],
    ...mergeStageAiUsage(payload, snapshot),
    timelineCounters,
  }, "itemProcessing", startedAt, new Date());
  await updateFetchRunProgress(payload.fetchRunId, {
    sourceCount: next.sourceCount,
    itemCount: next.processableItemCount,
    successCount,
    failureCount,
    itemsAdded,
    errorSummary: errors.length > 0 ? errors.join(" | ") : null,
  });
  await updateTaskRun(context.taskRunId, {
    progressCurrent: Math.min(next.processableItemCount, successCount + Math.max(0, failureCount - next.sourceFailureCount)),
    progressTotal: next.processableItemCount,
    progressLabel: `已处理 ${successCount + Math.max(0, failureCount - next.sourceFailureCount)}/${next.processableItemCount} 条内容`,
    itemsAdded,
    fullTextFetchedCount,
    aiCallCountActual: next.aiCallCountActual,
    aiCallCountEstimated: next.aiCallCountEstimated,
    aiCallBreakdown: next.aiCallBreakdown,
    taskTimeline: buildIngestionTimeline(next),
  });
  return next;
}

async function runClusterMergeStage(
  payload: IngestionWorkflowPayload,
  context: DomainTaskContext,
  overrides?: Partial<RunIngestionOptions>,
): Promise<IngestionWorkflowPayload> {
  const startedAt = new Date();
  await context.checkCancellation();
  const options = await resolveStageOptions(payload, overrides);
  const trackedAiProvider = options.aiUsage.wrapProvider(options.aiProvider);
  const result = await executeClusterMerge(trackedAiProvider, new Date(payload.now), {
    liveClusterIds: payload.affectedClusterIds,
  });
  const affectedClusterIds = new Set(payload.affectedClusterIds);
  for (const clusterId of result.affectedClusterIds) affectedClusterIds.add(clusterId);
  const timelineCounters = structuredClone(payload.timelineCounters ?? createIngestionTimelineCounters());
  Object.assign(timelineCounters.clusterMerge, {
    baseClusters: result.baseClusters,
    candidates: result.candidates,
    totalPairs: result.totalPairs,
    rejectedObjectConflict: result.rejectedObjectConflict,
    rejectedDateConflict: result.rejectedDateConflict,
    rejectedNoEventAnchor: result.rejectedNoEventAnchor,
    belowGrayScore: result.belowGrayScore,
    relatedPairs: result.relatedPairs,
    aiEligiblePairs: result.aiEligiblePairs,
    cleanPairsSkipped: result.cleanPairsSkipped,
    precomputedCleanPairsUsed: result.precomputedCleanPairsUsed,
    precomputedCleanPairsAttemptSkipped: result.precomputedCleanPairsAttemptSkipped,
    precomputedCleanPairsInvalidSkipped: result.precomputedCleanPairsInvalidSkipped,
    blockedByCannotLink: result.blockedByCannotLink,
    blockedByDeclinedDecision: result.blockedByDeclinedDecision,
    blockedByReviewDecision: result.blockedByReviewDecision,
    decisionsApproved: result.decisionsApproved,
    decisionsDeclined: result.decisionsDeclined,
    decisionsAmbiguous: result.decisionsAmbiguous,
    decisionsFailed: result.decisionsFailed,
    dirtyPairs: result.dirtyPairs,
    preLimitCandidates: result.preLimitCandidates,
    postLimitCandidates: result.candidates,
    dirtyCandidates: result.dirtyCandidates,
    aiMergeGroups: result.aiMergeGroups,
    skipped: result.skipped,
    merged: result.mergedCount,
    itemsMoved: result.itemsMoved,
    failedGroups: result.failedGroups,
    refreshItemCountsMs: result.refreshItemCountsMs,
    loadClustersMs: result.loadClustersMs,
    candidateSelectionMs: result.candidateSelectionMs,
    promptBuildMs: result.promptBuildMs,
    promptChars: result.promptChars,
    promptPairs: result.promptPairs,
    aiMergeMs: result.aiMergeMs,
    applyMergeMs: result.applyMergeMs,
    markEvaluatedMs: result.markEvaluatedMs,
  });
  const next = finishTimelineStage({
    ...payload,
    affectedClusterIds: [...affectedClusterIds],
    ...mergeStageAiUsage(payload, options.aiUsage.snapshot()),
    timelineCounters,
  }, "clusterMerge", startedAt, new Date());
  await updateTaskRun(context.taskRunId, { taskTimeline: buildIngestionTimeline(next) });
  return next;
}

async function runClusterFinalizeStage(
  payload: IngestionWorkflowPayload,
  context: DomainTaskContext,
  overrides?: Partial<RunIngestionOptions>,
): Promise<IngestionWorkflowPayload> {
  const startedAt = new Date();
  const options = await resolveStageOptions(payload, overrides);
  const trackedAiProvider = options.aiUsage.wrapProvider(options.aiProvider);
  const timelineCounters = structuredClone(payload.timelineCounters ?? createIngestionTimelineCounters());
  for (const clusterId of payload.affectedClusterIds) {
    await context.checkCancellation();
    const result = await recomputeCluster(clusterId, trackedAiProvider);
    timelineCounters.clusterFinalize.recomputed += 1;
    if (result.updated) timelineCounters.clusterFinalize.updated += 1;
    if (result.deleted) timelineCounters.clusterFinalize.deleted += 1;
    if (result.summaryAttempted) {
      timelineCounters.clusterFinalize.summaryAttempted =
        (timelineCounters.clusterFinalize.summaryAttempted ?? 0) + 1;
      if (result.summarySucceeded) {
        timelineCounters.clusterFinalize.summarySucceeded += 1;
      } else {
        timelineCounters.clusterFinalize.summaryFailed += 1;
      }
    }
  }
  const completedPayload = finishTimelineStage({
    ...payload,
    timelineCounters,
    ...mergeStageAiUsage(payload, options.aiUsage.snapshot()),
  }, "clusterFinalize", startedAt, new Date());
  await refreshClusterFeedStatsSafely(payload.affectedClusterIds, "ingestion cluster finalize");
  const status: FetchRunStatus = payload.errors.length > 0 || payload.failureCount > 0
    ? payload.successCount > 0 ? "partial" : "failed"
    : "succeeded";
  const completedRun = await completeFetchRun(payload.fetchRunId, {
    status,
    finishedAt: new Date(),
    sourceCount: payload.sourceCount,
    itemCount: payload.processableItemCount,
    successCount: payload.successCount,
    failureCount: payload.failureCount,
    itemsAdded: payload.itemsAdded,
    errorSummary: payload.errors.length > 0 ? payload.errors.join(" | ") : null,
  });
  const taskStatus = completedRun.errorSummary === TASK_RUN_CANCELLED_MESSAGE ? "cancelled" : completedRun.status;
  await updateTaskRun(context.taskRunId, {
    status: taskStatus,
    progressCurrent: Math.min(payload.processableItemCount, payload.successCount + Math.max(0, payload.failureCount - payload.sourceFailureCount)),
    progressTotal: payload.processableItemCount,
    progressLabel: completedRun.errorSummary === TASK_RUN_CANCELLED_MESSAGE ? TASK_RUN_CANCELLED_LABEL : `抓取完成：${payload.successCount} 成功，${payload.failureCount} 失败`,
    itemsAdded: payload.itemsAdded,
    fullTextFetchedCount: payload.fullTextFetchedCount,
    aiCallCountActual: completedPayload.aiCallCountActual,
    aiCallCountEstimated: completedPayload.aiCallCountEstimated,
    aiCallBreakdown: completedPayload.aiCallBreakdown,
    taskTimeline: buildIngestionTimeline(completedPayload),
    errorSummary: completedRun.errorSummary,
    finishedAt: completedRun.finishedAt,
  });
  invalidateFeedCache();
  scheduleDefaultFeedCacheWarm({ reason: `ingestion:${taskStatus}` });
  if (status !== "failed") {
    await enqueuePrecomputeTask({ triggerType: payload.trigger });
  }
  if (shouldEnqueueProcessingRecoveryFromIngestion({
    summaryFailed: payload.timelineCounters.itemSummary.failed,
    analysisFailed: payload.timelineCounters.itemAnalysis.failed,
    aggregationParseFailed: payload.timelineCounters.aggregationParsing.failed,
    skippedIncompleteSignature: payload.timelineCounters.clusterAssignment.skippedIncompleteSignature,
  })) {
    await enqueueItemProcessingRecoveryTask({ triggerType: payload.trigger, force: true }).catch(() => null);
  }
  return completedPayload;
}

export async function executeIngestionWorkflowStage(
  stage: IngestionWorkflowStage,
  input: unknown,
  context: DomainTaskContext,
  overrides?: Partial<RunIngestionOptions>,
): Promise<IngestionWorkflowPayload> {
  try {
    if (stage === "source_sync") return runSourceSyncStage(asTaskRun(input), context, overrides);
    if (!input || typeof input !== "object" || !("fetchRunId" in input)) throw new Error(`Ingestion stage ${stage} requires previous stage output.`);
    const payload = input as IngestionWorkflowPayload;
    if (stage === "item_processing") return runItemProcessingStage(payload, context, overrides);
    if (stage === "cluster_merge") return runClusterMergeStage(payload, context, overrides);
    return runClusterFinalizeStage(payload, context, overrides);
  } catch (error) {
    const taskRunId = context.taskRunId;
    const payload = input && typeof input === "object" && "fetchRunId" in input && typeof input.fetchRunId === "string"
      ? input as Partial<IngestionWorkflowPayload>
      : null;
    const fetchRun = payload?.fetchRunId
      ? await prisma.fetchRun.findUnique({ where: { id: payload.fetchRunId } })
      : await prisma.fetchRun.findFirst({ where: { taskRunId }, orderBy: { startedAt: "desc" } });
    if (fetchRun?.status === "running") {
      await completeFetchRun(fetchRun.id, {
        status: "failed",
        finishedAt: new Date(),
        sourceCount: payload?.sourceCount ?? 0,
        itemCount: payload?.processableItemCount ?? 0,
        successCount: payload?.successCount ?? 0,
        failureCount: Math.max(1, payload?.failureCount ?? 0),
        itemsAdded: payload?.itemsAdded ?? 0,
        errorSummary: context.signal.aborted ? TASK_RUN_CANCELLED_MESSAGE : error instanceof Error ? error.message : "Unknown ingestion workflow error",
      });
    }
    throw error;
  }
}
