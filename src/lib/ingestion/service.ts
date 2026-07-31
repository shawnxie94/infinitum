import crypto from "node:crypto";

import type { BackgroundTaskRun, FetchRun, FetchRunStatus, Item, Source } from "@prisma/client";

import { INGESTION_PROGRESS_FLUSH_INTERVAL_MS } from "@/config/constants";
import type { RuntimeConfig } from "@/config/runtime";
import { createAiProvider } from "@/lib/ai/provider";
import {
  executeClusterMerge,
  recomputeCluster,
  type ClusterRecomputeResult,
} from "@/lib/clusters/service";
import { refreshClusterFeedStatsSafely } from "@/lib/clusters/feed-stats";
import { createClusterAssignmentCoordinator } from "@/lib/clusters/helpers";
import { prisma } from "@/lib/db";
import {
  completeFetchRun,
  createFetchRun,
  findDedupeHistoriesForUrlHashes,
  findExistingItemsForUrlHashes,
  syncSources,
  updateSourceFetchMetadata,
  updateSourceHealthStatus,
  updateFetchRunProgress,
} from "@/lib/feed/repository";
import { invalidateFeedCache } from "@/lib/feed/cache";
import { enqueueItemProcessingRecoveryTask } from "@/lib/items/processing-recovery";
import { scheduleDefaultFeedCacheWarm } from "@/lib/feed/warmup";
import { enqueuePrecomputeTask } from "@/lib/precompute/service";
import { createConfiguredArticleFetcher, fetchArticleContent } from "@/lib/ingestion/article";
import {
  deriveSourceConcurrency,
  buildPreparedFeedItemLookup,
  estimatePreparedItemAiWork,
  parsePublishedAt,
  type PreparedFeedItem,
  type PreparedFeedItemLookup,
  processFeedItem,
} from "@/lib/ingestion/item-processor";
import { createRssParser } from "@/lib/ingestion/parser";
import {
  buildIngestionTaskTimeline,
  createIngestionStageTracker,
  createIngestionTimelineCounters,
  createIngestionTimelineModelNames,
  createInitialIngestionTaskTimeline,
  type IngestionTimelineModelNames,
  type IngestionTaskStageState,
} from "@/lib/ingestion/task-timeline";
import type {
  ProcessedItemRecord,
  RunIngestionOptions,
} from "@/lib/ingestion/types";
import { getIngestionRuntimeConfig } from "@/lib/settings/service";
import { DEFAULT_FULL_TEXT_FETCH_THRESHOLD } from "@/lib/tasks/scheduler";
import {
  DEFAULT_INGESTION_TASK_LABEL,
  type TaskAiCallBreakdownSnapshot,
  type TaskStageTimingSnapshot,
  type TaskTimelineNodeSnapshot,
} from "@/lib/tasks/types";
import {
  enqueueTaskRun,
  isTaskRunCancellationRequested,
  TASK_RUN_CANCELLED_LABEL,
  TASK_RUN_CANCELLED_MESSAGE,
  updateTaskRun,
} from "@/lib/tasks/service";
import { createTaskAiUsageTracker } from "@/lib/tasks/ai-usage";

export const DEFAULT_MAX_FEED_ITEMS_TO_SCAN = 500;

type ResolvedRunOptions = RunIngestionOptions & {
  now: Date;
  taskTimelineModelNames: IngestionTimelineModelNames;
};

// 摄入进度刷新间隔常量已移至 @/config/constants

function invalidateAndWarmFeedCache(reason: string) {
  invalidateFeedCache();
  scheduleDefaultFeedCacheWarm({ reason });
}

type RuntimePromptConfigs = NonNullable<RuntimeConfig["selectedPromptConfigs"]>;
type RuntimePromptConfig =
  | RuntimePromptConfigs["itemUnderstanding"]
  | RuntimePromptConfigs["clusterSummary"]
  | RuntimePromptConfigs["clusterMatch"]
  | RuntimePromptConfigs["clusterMerge"];

type SourceFetchMetadataUpdate = {
  feedEtag?: string | null;
  feedLastModified?: string | null;
  feedContentHash?: string | null;
  lastFetchedAt: Date;
  healthStatus?: "unknown" | "healthy" | "failed";
  healthMessage?: string | null;
  healthCheckedAt?: Date | null;
};

class TaskRunCancellationError extends Error {
  snapshot: {
    sourceCount: number;
    sourceFailureCount: number;
    itemCount: number;
    successCount: number;
    failureCount: number;
    itemsAdded: number;
    fullTextFetchedCount: number;
    errorSummary: string | null;
    stageTimings: TaskStageTimingSnapshot[];
    taskTimeline: TaskTimelineNodeSnapshot[];
  };

  constructor(snapshot: {
    sourceCount: number;
    sourceFailureCount: number;
    itemCount: number;
    successCount: number;
    failureCount: number;
    itemsAdded: number;
    fullTextFetchedCount: number;
    errorSummary: string | null;
    stageTimings: TaskStageTimingSnapshot[];
    taskTimeline: TaskTimelineNodeSnapshot[];
  }) {
    super(TASK_RUN_CANCELLED_MESSAGE);
    this.name = "TaskRunCancellationError";
    this.snapshot = snapshot;
  }
}

function resolvePromptModelName(
  promptConfig: RuntimePromptConfig | undefined,
  defaultModelName: string | null,
): string | null {
  return promptConfig?.modelApi?.model ?? defaultModelName;
}


async function resolveRunOptions(options?: Partial<RunIngestionOptions>): Promise<ResolvedRunOptions> {
  const now = options?.now ?? new Date();
  const runtimeConfig =
    !options?.aiProvider || !options?.sourceConfigs || !options?.blacklist ? await getIngestionRuntimeConfig() : null;
  const defaultModelName = runtimeConfig?.modelApi.model ?? null;

  return {
    trigger: options?.trigger ?? "manual",
    parser: options?.parser ?? createRssParser(),
    articleFetcher:
      options?.articleFetcher ??
      createConfiguredArticleFetcher(runtimeConfig?.contentExtraction ?? {
        jinaEnabled: false,
        jinaBaseUrl: "https://r.jina.ai/",
        jinaApiKey: null,
        timeoutMs: 15_000,
        concurrency: 1,
        rpmLimit: 10,
        maxPerRun: 20,
        minChars: 500,
        maxChars: 32_000,
      }, fetchArticleContent),
    aiProvider:
      options?.aiProvider ??
      createAiProvider(
        runtimeConfig?.modelApi ?? { apiKey: "", baseURL: "", model: "gpt-4.1-mini", customHeaders: {} },
        runtimeConfig?.selectedPromptConfigs
          ? {
              itemUnderstanding: runtimeConfig.selectedPromptConfigs.itemUnderstanding,
              clusterSummary: runtimeConfig.selectedPromptConfigs.clusterSummary,
              clusterMatch: runtimeConfig.selectedPromptConfigs.clusterMatch,
              clusterMerge: runtimeConfig.selectedPromptConfigs.clusterMerge,
          }
          : undefined,
        undefined,
        {
          aggregationSplitMaxEvents: runtimeConfig?.ingestion.aggregationSplitMaxEvents,
        },
      ),
    sourceConfigs: options?.sourceConfigs ?? runtimeConfig?.rssSources ?? [],
    blacklist: options?.blacklist ?? runtimeConfig?.blacklistKeywords ?? [],
    itemConcurrency: options?.itemConcurrency ?? runtimeConfig?.ingestion.itemConcurrency ?? 3,
    sourceConcurrency:
      options?.sourceConcurrency ??
      runtimeConfig?.ingestion.sourceConcurrency ??
      deriveSourceConcurrency(options?.itemConcurrency ?? runtimeConfig?.ingestion.itemConcurrency ?? 3),
    fullTextFetchThreshold:
      options?.fullTextFetchThreshold ??
      runtimeConfig?.ingestion.fullTextFetchThreshold ??
      DEFAULT_FULL_TEXT_FETCH_THRESHOLD,
    contentExtraction:
      options?.contentExtraction ??
      runtimeConfig?.contentExtraction ?? {
        jinaEnabled: false,
        jinaBaseUrl: "https://r.jina.ai/",
        jinaApiKey: null,
        timeoutMs: 15_000,
        concurrency: 1,
        rpmLimit: 10,
        maxPerRun: 20,
        minChars: 500,
        maxChars: 32_000,
      },
    perSourceItemLimit:
      options?.perSourceItemLimit ?? runtimeConfig?.ingestion.perSourceItemLimit ?? 20,
    maxFeedItemsToScan: options?.maxFeedItemsToScan ?? DEFAULT_MAX_FEED_ITEMS_TO_SCAN,
    processingStartAt:
      options?.processingStartAt ?? runtimeConfig?.ingestion.processingStartAt ?? null,
    now,
    taskTimelineModelNames: runtimeConfig?.selectedPromptConfigs
      ? {
          itemUnderstanding: resolvePromptModelName(runtimeConfig.selectedPromptConfigs.itemUnderstanding, defaultModelName),
          clusterSummary: resolvePromptModelName(runtimeConfig.selectedPromptConfigs.clusterSummary, defaultModelName),
          clusterMatch: resolvePromptModelName(runtimeConfig.selectedPromptConfigs.clusterMatch, defaultModelName),
          clusterMerge: resolvePromptModelName(runtimeConfig.selectedPromptConfigs.clusterMerge, defaultModelName),
        }
      : createIngestionTimelineModelNames(),
  };
}

async function runWithConcurrency(
  tasks: Array<() => Promise<void>>,
  concurrency: number,
  options?: {
    shouldStop?: () => Promise<boolean>;
  },
) {
  let nextTaskIndex = 0;

  async function worker() {
    while (true) {
      if (await options?.shouldStop?.()) {
        return;
      }

      const currentIndex = nextTaskIndex;
      nextTaskIndex += 1;

      if (currentIndex >= tasks.length) {
        return;
      }

      await tasks[currentIndex]?.();
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, tasks.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

function buildFeedRequestHeaders(source: Source): Record<string, string> {
  return {
    ...(source.feedEtag ? { "If-None-Match": source.feedEtag } : {}),
    ...(source.feedLastModified ? { "If-Modified-Since": source.feedLastModified } : {}),
  };
}

function buildFeedContentHash(items: Array<{ title?: string | null; link?: string | null; isoDate?: string | null; pubDate?: string | null; content?: string | null; "content:encoded"?: string | null; contentSnippet?: string | null }>) {
  const payload = items.map((item) => ({
    title: item.title?.trim() ?? null,
    link: item.link?.trim() ?? null,
    isoDate: item.isoDate ?? null,
    pubDate: item.pubDate ?? null,
    content: item.content ?? null,
    contentEncoded: item["content:encoded"] ?? null,
    contentSnippet: item.contentSnippet ?? null,
  }));

  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

async function updateSourceMetadataIfChanged(sourceId: string, data: SourceFetchMetadataUpdate) {
  await updateSourceFetchMetadata(sourceId, data);
}

async function markSourceHealth(
  sourceId: string,
  data: {
    healthStatus: "unknown" | "healthy" | "failed";
    healthMessage: string | null;
    healthCheckedAt: Date;
  },
) {
  await updateSourceHealthStatus(sourceId, data);
}

function getExistingItemForLookup(
  lookup: PreparedFeedItemLookup | null,
  existingByUrlHash: Map<string, Item>,
) {
  if (!lookup) {
    return null;
  }

  return existingByUrlHash.get(lookup.dedupeKeys.urlHash) ?? null;
}

function hasItemProcessingFailure(result: ProcessedItemRecord | null) {
  return Boolean(
    result?.metrics?.summaryFailed ||
    result?.metrics?.aggregationParseFailed ||
    result?.metrics?.analysisFailed,
  );
}

function buildItemProcessingFailureMessage(result: ProcessedItemRecord) {
  return result.errorMessage
    ? `Item ${result.id}: ${result.errorMessage}`
    : `Item ${result.id}: AI processing failed`;
}

function dedupePreparedLookupsByDedupeKey<T extends { lookup: PreparedFeedItemLookup | null }>(entries: T[]) {
  const seen = new Set<string>();
  const deduped: T[] = [];

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (!entry.lookup) {
      deduped.unshift(entry);
      continue;
    }

    const dedupeKey = entry.lookup.dedupeKeys.urlHash;
    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    deduped.unshift(entry);
  }

  return deduped;
}

function shouldEnqueueProcessingRecoveryFromIngestion(input: {
  summaryFailed: number;
  analysisFailed: number;
  aggregationParseFailed: number;
  skippedIncompleteSignature: number;
}) {
  return (
    input.summaryFailed > 0 ||
    input.analysisFailed > 0 ||
    input.aggregationParseFailed > 0 ||
    input.skippedIncompleteSignature > 0
  );
}

async function executeIngestion(run: FetchRun, options: ResolvedRunOptions) {
  const {
    parser,
    articleFetcher,
    aiProvider,
    sourceConfigs,
    blacklist,
    itemConcurrency,
    sourceConcurrency,
    fullTextFetchThreshold,
    contentExtraction,
    perSourceItemLimit,
    maxFeedItemsToScan = DEFAULT_MAX_FEED_ITEMS_TO_SCAN,
    processingStartAt,
    now,
    taskTimelineModelNames,
  } = options;
  const stageTracker = createIngestionStageTracker();
  const timelineCounters = createIngestionTimelineCounters();
  const taskStages: IngestionTaskStageState = {
    sourceSync: null,
    itemProcessing: null,
    clusterMerge: null,
    clusterFinalize: null,
  };
  let sources: Awaited<ReturnType<typeof syncSources>> = [];
  const aiUsage = createTaskAiUsageTracker();
  const trackedAiProvider = aiUsage.wrapProvider(aiProvider, {
    understandItemEstimated: false,
  });
  const preparedItems: PreparedFeedItem[] = [];
  const sourceMetadataCommitCandidates = new Map<string, SourceFetchMetadataUpdate>();
  const errors: string[] = [];
  let processableItemCount = 0;
  let successCount = 0;
  let failureCount = 0;
  let itemsAdded = 0;
  let fullTextFetchedCount = 0;
  let cancellationRequested = false;
  const affectedClusterIds = new Set<string>();
  const clusterAssignmentCoordinator = createClusterAssignmentCoordinator();
  const getProgressSnapshot = () => ({
    sourceCount: sources.length,
    sourceFailureCount: timelineCounters.sourceFetch.sourcesFailed,
    itemCount: processableItemCount,
    successCount,
    failureCount,
    itemsAdded,
    fullTextFetchedCount,
    errorSummary: errors.length > 0 ? errors.join(" | ") : null,
    stageTimings: stageTracker.snapshot(),
    taskTimeline: buildIngestionTaskTimeline({
      counters: timelineCounters,
      stages: taskStages,
      modelNames: taskTimelineModelNames,
    }),
  });
  const emitTaskProgress = async (status: FetchRunStatus | "running") => {
    const aiUsageSnapshot = aiUsage.snapshot();
    await options.onProgress?.({
      status,
      ...getProgressSnapshot(),
      aiCallCountActual: aiUsageSnapshot.actual,
      aiCallCountEstimated: aiUsageSnapshot.estimated,
      aiCallBreakdown: aiUsageSnapshot.breakdown,
    });
  };
  const checkCancellation = async () => {
    if (!run.taskRunId || cancellationRequested) {
      return cancellationRequested;
    }

    cancellationRequested = await isTaskRunCancellationRequested(run.taskRunId);
    return cancellationRequested;
  };
  const throwIfCancellationRequested = async () => {
    if (await checkCancellation()) {
      throw new TaskRunCancellationError(getProgressSnapshot());
    }
  };

  const sourceSyncStage = stageTracker.startStage("source_sync", "信息源同步");
  taskStages.sourceSync = sourceSyncStage;

  try {
    sources = await syncSources(sourceConfigs);
    await runWithConcurrency(
      sources.map((source) => async () => {
        await throwIfCancellationRequested();

        try {
          const feed = await parser.parseURL(source.rssUrl, {
            headers: buildFeedRequestHeaders(source),
          });

          if (feed.notModified) {
            await updateSourceMetadataIfChanged(source.id, {
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
            await updateSourceMetadataIfChanged(source.id, {
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

          sourceMetadataCommitCandidates.set(source.id, {
            feedEtag: feed.etag ?? source.feedEtag,
            feedLastModified: feed.lastModified ?? source.feedLastModified,
            feedContentHash,
            lastFetchedAt: now,
            healthStatus: "healthy",
            healthMessage: null,
            healthCheckedAt: now,
          });
          await markSourceHealth(source.id, {
            healthStatus: "healthy",
            healthMessage: null,
            healthCheckedAt: now,
          });

          const items = allItems
            .map((item) => ({ item, publishedAt: parsePublishedAt(item, now) }))
            .sort((left, right) => {
              if (left.publishedAt.known !== right.publishedAt.known) {
                return left.publishedAt.known ? -1 : 1;
              }
              return right.publishedAt.value.getTime() - left.publishedAt.value.getTime();
            })
            .filter(({ publishedAt }) => (
              !processingStartAt ||
              !publishedAt.known ||
              publishedAt.value >= processingStartAt
            ))
            .slice(0, maxFeedItemsToScan)
            .slice(0, perSourceItemLimit)
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
          timelineCounters.sourceFetch.sourcesFailed += 1;
          await markSourceHealth(source.id, {
            healthStatus: "failed",
            healthMessage: message,
            healthCheckedAt: now,
          });
          errors.push(`${source.name}: ${message}`);
          failureCount += 1;
        }
      }),
      sourceConcurrency,
      {
        shouldStop: checkCancellation,
      },
    );
  } finally {
    stageTracker.finishStage(sourceSyncStage);
    timelineCounters.sourceFetch.sourcesFetched = sources.length;
  }

  const preparedLookupEntries = dedupePreparedLookupsByDedupeKey(preparedItems
    .map((preparedItem) => ({
      preparedItem,
      lookup: buildPreparedFeedItemLookup(preparedItem, now),
    }))
    .filter((entry) => (
      !entry.lookup ||
      !processingStartAt ||
      !entry.lookup.publishedAtKnown ||
      entry.lookup.publishedAt >= processingStartAt
    )));
  const dedupeKeyInputs = preparedLookupEntries
    .map((entry) => entry.lookup)
    .filter((lookup): lookup is PreparedFeedItemLookup => Boolean(lookup))
    .map((lookup) => lookup.dedupeKeys.urlHash);
  const existingItems = await findExistingItemsForUrlHashes(
    dedupeKeyInputs,
  );
  const existingByUrlHash = new Map(existingItems.map((item) => [item.urlHash, item]));
  const dedupeHistories = await findDedupeHistoriesForUrlHashes(dedupeKeyInputs);
  const historyByUrlHash = new Map(dedupeHistories.map((history) => [history.urlHash, history]));
  const preparedLookups = preparedLookupEntries.filter((entry) => {
    const existing = getExistingItemForLookup(entry.lookup, existingByUrlHash);

    if (existing) {
      return true;
    }

    return !entry.lookup || !historyByUrlHash.has(entry.lookup.dedupeKeys.urlHash);
  });
  processableItemCount = preparedLookups.length;
  timelineCounters.sourceFetch.itemsFetched = processableItemCount;
  const estimatedUnderstandingCalls = preparedLookups.reduce(
    (total, entry) => {
      const existing = getExistingItemForLookup(entry.lookup, existingByUrlHash);
      return total + (estimatePreparedItemAiWork(entry.preparedItem, entry.lookup, existing, blacklist) ? 1 : 0);
    },
    0,
  );
  aiUsage.setEstimated(
    estimatedUnderstandingCalls,
    "item_understanding",
  );

  await updateFetchRunProgress(run.id, {
    sourceCount: sources.length,
    itemCount: processableItemCount,
    successCount,
    failureCount,
    itemsAdded,
    errorSummary: errors.length > 0 ? errors.join(" | ") : null,
  });
  await emitTaskProgress("running");

  await throwIfCancellationRequested();

  let lastProgressFlushAt = 0;
  const flushProgress = async (status: FetchRunStatus | "running") => {
    lastProgressFlushAt = Date.now();

    await updateFetchRunProgress(run.id, {
      sourceCount: sources.length,
      itemCount: processableItemCount,
      successCount,
      failureCount,
      itemsAdded,
      errorSummary: errors.length > 0 ? errors.join(" | ") : null,
    });
    await emitTaskProgress(status);
  };
  let progressChain = Promise.resolve();
  const enqueueProgressUpdate = (
    result: ProcessedItemRecord | null,
    issue?: string,
    options?: {
      forceFlush?: boolean;
    },
  ) => {
    progressChain = progressChain.then(async () => {
      if (issue) {
        errors.push(issue);
        failureCount += 1;
      } else if (result?.status === "failed") {
        failureCount += 1;
      } else if (result && hasItemProcessingFailure(result)) {
        failureCount += 1;
        errors.push(buildItemProcessingFailureMessage(result));
      } else if (result && result.status !== "filtered") {
        successCount += 1;
        if (result.isNew) {
          itemsAdded += 1;
        }
      }

      if (result?.fullTextFetched) {
        fullTextFetchedCount += 1;
        timelineCounters.sourceFetch.fullTextFetched += 1;
      }

      if (result?.metrics?.fullTextFetchAttempted) {
        timelineCounters.sourceFetch.fullTextFetchAttempted += 1;
      }

      if (result?.metrics?.fullTextFetchReason === "rss_html") {
        timelineCounters.sourceFetch.fullTextFetchRssHtml += 1;
      }

      if (result?.metrics?.fullTextFetchReason === "short_content") {
        timelineCounters.sourceFetch.fullTextFetchShortContent += 1;
      }

      if (result?.metrics?.fullTextFetchLocalAttempted) {
        timelineCounters.sourceFetch.fullTextFetchLocalAttempted += 1;
      }

      if (result?.metrics?.fullTextFetchJinaAttempted) {
        timelineCounters.sourceFetch.fullTextFetchJinaAttempted += 1;
      }

      if (result?.metrics?.fullTextFetchSource === "local") {
        timelineCounters.sourceFetch.fullTextFetchLocalUsed += 1;
      }

      if (result?.metrics?.fullTextFetchSource === "jina") {
        timelineCounters.sourceFetch.fullTextFetchJinaUsed += 1;
      }

      if (result?.metrics?.timings) {
        timelineCounters.sourceFetch.fullTextFetchDurationMs += Math.round(result.metrics.timings.fullTextFetchMs ?? 0);
        timelineCounters.ruleFilter.durationMs += Math.round(result.metrics.timings.ruleFilterMs ?? 0);
        timelineCounters.ruleFilter.itemTotalDurationMs += Math.round(result.metrics.timings.totalMs ?? 0);
        timelineCounters.ruleFilter.dbWriteDurationMs += Math.round(result.metrics.timings.dbWriteMs ?? 0);
        timelineCounters.itemAnalysis.durationMs += Math.round(result.metrics.timings.analysisMs ?? 0);
        timelineCounters.clusterAssignment.durationMs += Math.round(result.metrics.timings.clusterAssignmentMs ?? 0);
      }

      if (result?.metrics?.blacklistFiltered) {
        timelineCounters.ruleFilter.ruleFiltered += 1;
      }

      if (result?.metrics?.reusedExisting) {
        timelineCounters.ruleFilter.reusedExisting += 1;
      }

      if (result?.metrics?.summaryCompleted) {
        timelineCounters.itemSummary.completed += 1;
      }

      if (result?.metrics?.summaryFailed) {
        timelineCounters.itemSummary.failed += 1;
      }

      if (result?.metrics?.aggregationParsed) {
        timelineCounters.aggregationParsing.parsed += 1;
      }

      if (result?.metrics?.aggregationParseFailed) {
        timelineCounters.aggregationParsing.failed += 1;
      }

      if (result?.metrics?.aggregationEventCount) {
        timelineCounters.aggregationParsing.events += result.metrics.aggregationEventCount;
      }

      if (result?.metrics?.analysisCompleted) {
        timelineCounters.itemAnalysis.completed += 1;
      }

      if (result?.metrics?.analysisFailed) {
        timelineCounters.itemAnalysis.failed += 1;
      }

      if (result?.metrics?.analysisFiltered) {
        timelineCounters.itemAnalysis.filtered += 1;
      }

      if (result?.metrics?.updatedExisting) {
        timelineCounters.itemAnalysis.updatedExisting += 1;
      }

      if (result?.metrics?.clusterAssignment?.exactMatch) {
        timelineCounters.clusterAssignment.exactMatch += result.metrics.clusterAssignment.exactMatch;
      }

      if (result?.metrics?.clusterAssignment?.cheapRankDirect) {
        timelineCounters.clusterAssignment.cheapRankDirect += result.metrics.clusterAssignment.cheapRankDirect;
      }

      if (result?.metrics?.clusterAssignment?.aiMatch) {
        timelineCounters.clusterAssignment.aiMatch += result.metrics.clusterAssignment.aiMatch;
      }

      if (result?.metrics?.clusterAssignment?.skippedIncompleteSignature) {
        timelineCounters.clusterAssignment.skippedIncompleteSignature +=
          result.metrics.clusterAssignment.skippedIncompleteSignature;
      }

      if (result?.metrics?.clusterAssignment?.newCluster) {
        timelineCounters.clusterAssignment.newCluster += result.metrics.clusterAssignment.newCluster;
      }

      // Collect affected clusters for batch recomputation
      if (result?.affectedClusterId) {
        affectedClusterIds.add(result.affectedClusterId);
      }
      for (const clusterId of result?.affectedClusterIds ?? []) {
        affectedClusterIds.add(clusterId);
      }

      const shouldFlushNow =
        options?.forceFlush ||
        Date.now() - lastProgressFlushAt >= INGESTION_PROGRESS_FLUSH_INTERVAL_MS;

      if (!shouldFlushNow) {
        return;
      }

      await flushProgress("running");
    });

    return progressChain;
  };

  const itemProcessingStage = stageTracker.startStage("item_processing", "内容处理");
  taskStages.itemProcessing = itemProcessingStage;
  try {
    await runWithConcurrency(
      preparedLookups.map(({ preparedItem, lookup }) => async () => {
        try {
          const existingItem = getExistingItemForLookup(lookup, existingByUrlHash);
          const result = await processFeedItem({
            ...preparedItem,
            lookup,
            existingItem,
            blacklist,
            articleFetcher,
            aiProvider: trackedAiProvider,
            clusterAssignmentCoordinator,
            fullTextFetchThreshold,
            contentExtraction,
            now,
          });

          await enqueueProgressUpdate(result);
        } catch (error) {
          const message =
            error instanceof Error
              ? `${preparedItem.sourceName}: ${preparedItem.item.title ?? "Untitled item"}: ${error.message}`
              : `${preparedItem.sourceName}: Unknown item processing error`;
          await enqueueProgressUpdate(null, message);
        }
      }),
      itemConcurrency,
      {
        shouldStop: checkCancellation,
      },
    );

    await enqueueProgressUpdate(null, undefined, { forceFlush: true });
    await progressChain;
  } finally {
    stageTracker.finishStage(itemProcessingStage);
  }
  await throwIfCancellationRequested();

  // Cluster merge pass: AI检查7天内聚合组，合并事件一致但未归入同一组的聚合组
  let mergeResult: Awaited<ReturnType<typeof executeClusterMerge>>;
  const clusterMergeStage = stageTracker.startStage("cluster_merge", "聚合合并");
  taskStages.clusterMerge = clusterMergeStage;
  await emitTaskProgress("running");
  try {
    mergeResult = await executeClusterMerge(
      trackedAiProvider,
      options.now,
      { liveClusterIds: affectedClusterIds },
    );
  } finally {
    stageTracker.finishStage(clusterMergeStage);
  }
  timelineCounters.clusterMerge = {
    baseClusters: mergeResult.baseClusters,
    candidates: mergeResult.candidates,
    totalPairs: mergeResult.totalPairs,
    rejectedObjectConflict: mergeResult.rejectedObjectConflict,
    rejectedDateConflict: mergeResult.rejectedDateConflict,
    rejectedNoEventAnchor: mergeResult.rejectedNoEventAnchor,
    belowGrayScore: mergeResult.belowGrayScore,
    relatedPairs: mergeResult.relatedPairs,
    aiEligiblePairs: mergeResult.aiEligiblePairs,
    cleanPairsSkipped: mergeResult.cleanPairsSkipped,
    precomputedCleanPairsUsed: mergeResult.precomputedCleanPairsUsed,
    precomputedCleanPairsAttemptSkipped: mergeResult.precomputedCleanPairsAttemptSkipped,
    precomputedCleanPairsInvalidSkipped: mergeResult.precomputedCleanPairsInvalidSkipped,
    blockedByCannotLink: mergeResult.blockedByCannotLink,
    blockedByDeclinedDecision: mergeResult.blockedByDeclinedDecision,
    decisionsApproved: mergeResult.decisionsApproved,
    decisionsDeclined: mergeResult.decisionsDeclined,
    decisionsAmbiguous: mergeResult.decisionsAmbiguous,
    decisionsFailed: mergeResult.decisionsFailed,
    dirtyPairs: mergeResult.dirtyPairs,
    preLimitCandidates: mergeResult.preLimitCandidates,
    postLimitCandidates: mergeResult.postLimitCandidates,
    dirtyCandidates: mergeResult.dirtyCandidates,
    aiMergeGroups: mergeResult.aiMergeGroups,
    skipped: mergeResult.skipped,
    merged: mergeResult.mergedCount,
    itemsMoved: mergeResult.itemsMoved,
    failedGroups: mergeResult.failedGroups,
    refreshItemCountsMs: mergeResult.refreshItemCountsMs,
    loadClustersMs: mergeResult.loadClustersMs,
    candidateSelectionMs: mergeResult.candidateSelectionMs,
    promptBuildMs: mergeResult.promptBuildMs,
    promptChars: mergeResult.promptChars,
    promptPairs: mergeResult.promptPairs,
    aiMergeMs: mergeResult.aiMergeMs,
    applyMergeMs: mergeResult.applyMergeMs,
    markEvaluatedMs: mergeResult.markEvaluatedMs,
  };
  if (mergeResult.affectedClusterIds.length > 0) {
    for (const clusterId of mergeResult.affectedClusterIds) {
      affectedClusterIds.add(clusterId);
    }
  }

  const clusterFinalizeStage = stageTracker.startStage("cluster_finalize", "聚合收尾");
  taskStages.clusterFinalize = clusterFinalizeStage;
  await emitTaskProgress("running");
  try {
    const recomputeResults: ClusterRecomputeResult[] = [];

    // Recompute only affected clusters instead of all clusters
    await runWithConcurrency(
      [...affectedClusterIds].map((clusterId) => async () => {
        const result = await recomputeCluster(clusterId, trackedAiProvider);
        recomputeResults.push(result);
      }),
      Math.max(1, Math.min(3, sourceConcurrency)),
    );

    for (const result of recomputeResults) {
      timelineCounters.clusterFinalize.recomputed += 1;

      if (result.updated) {
        timelineCounters.clusterFinalize.updated += 1;
      }

      if (result.deleted) {
        timelineCounters.clusterFinalize.deleted += 1;
      }

      if (result.summaryAttempted) {
        if (result.summarySucceeded) {
          timelineCounters.clusterFinalize.summarySucceeded += 1;
        } else {
          timelineCounters.clusterFinalize.summaryFailed += 1;
        }
      }
    }

    await refreshClusterFeedStatsSafely([...affectedClusterIds], "ingestion cluster finalize");
  } finally {
    stageTracker.finishStage(clusterFinalizeStage);
  }

  await Promise.all(
    [...sourceMetadataCommitCandidates.entries()]
      .map(([sourceId, metadata]) => updateSourceMetadataIfChanged(sourceId, metadata)),
  );

  const status: FetchRunStatus =
    errors.length > 0 || failureCount > 0
      ? successCount > 0
        ? "partial"
        : "failed"
      : "succeeded";

  const completedRun = await completeFetchRun(run.id, {
    status,
    finishedAt: new Date(),
    sourceCount: sources.length,
    itemCount: processableItemCount,
    successCount,
    failureCount,
    itemsAdded,
    errorSummary: errors.length > 0 ? errors.join(" | ") : null,
  });

  await options.onProgress?.({
    status: completedRun.status,
    sourceCount: completedRun.sourceCount,
    sourceFailureCount: timelineCounters.sourceFetch.sourcesFailed,
    itemCount: completedRun.itemCount,
    successCount: completedRun.successCount,
    failureCount: completedRun.failureCount,
    itemsAdded: completedRun.itemsAdded,
    fullTextFetchedCount,
    aiCallCountActual: aiUsage.snapshot().actual,
    aiCallCountEstimated: aiUsage.snapshot().estimated,
    aiCallBreakdown: aiUsage.snapshot().breakdown,
    errorSummary: completedRun.errorSummary,
    stageTimings: stageTracker.snapshot(),
    taskTimeline: buildIngestionTaskTimeline({
      counters: timelineCounters,
      stages: taskStages,
      modelNames: taskTimelineModelNames,
    }),
  });

  if (
    shouldEnqueueProcessingRecoveryFromIngestion({
      summaryFailed: timelineCounters.itemSummary.failed,
      analysisFailed: timelineCounters.itemAnalysis.failed,
      aggregationParseFailed: timelineCounters.aggregationParsing.failed,
      skippedIncompleteSignature: timelineCounters.clusterAssignment.skippedIncompleteSignature,
    })
  ) {
    await enqueueItemProcessingRecoveryTask({
      triggerType: options.onProgress ? "manual" : "scheduled",
      // Ingestion already observed bad rows; skip another full candidate scan.
      force: true,
    }).catch(() => null);
  }

  return completedRun;
}

async function runExistingFetchRun(run: FetchRun, options: ResolvedRunOptions) {
  try {
    const completedRun = await executeIngestion(run, options);
    invalidateAndWarmFeedCache("ingestion:completed");
    return completedRun;
  } catch (error) {
    if (error instanceof TaskRunCancellationError) {
      const cancelledRun = await completeFetchRun(run.id, {
        status: "failed",
        finishedAt: new Date(),
        sourceCount: error.snapshot.sourceCount,
        itemCount: error.snapshot.itemCount,
        successCount: error.snapshot.successCount,
        failureCount: error.snapshot.failureCount,
        itemsAdded: error.snapshot.itemsAdded,
        errorSummary: TASK_RUN_CANCELLED_MESSAGE,
      });

      await options.onProgress?.({
        status: cancelledRun.status,
        sourceCount: cancelledRun.sourceCount,
        sourceFailureCount: error.snapshot.sourceFailureCount,
        itemCount: cancelledRun.itemCount,
        successCount: cancelledRun.successCount,
        failureCount: cancelledRun.failureCount,
        itemsAdded: cancelledRun.itemsAdded,
        fullTextFetchedCount: error.snapshot.fullTextFetchedCount,
        errorSummary: cancelledRun.errorSummary,
        stageTimings: error.snapshot.stageTimings,
        taskTimeline: error.snapshot.taskTimeline,
      });

      invalidateAndWarmFeedCache("ingestion:cancelled");
      return cancelledRun;
    }

    const failedRun = await completeFetchRun(run.id, {
      status: "failed",
      finishedAt: new Date(),
      sourceCount: 0,
      itemCount: 0,
      successCount: 0,
      failureCount: 1,
      itemsAdded: 0,
      errorSummary: error instanceof Error ? error.message : "Unknown ingestion error",
    });

    await options.onProgress?.({
      status: failedRun.status,
      sourceCount: failedRun.sourceCount,
      sourceFailureCount: 0,
      itemCount: failedRun.itemCount,
      successCount: failedRun.successCount,
      failureCount: failedRun.failureCount,
      itemsAdded: failedRun.itemsAdded,
      fullTextFetchedCount: 0,
      errorSummary: failedRun.errorSummary,
      taskTimeline: [],
    });

    invalidateAndWarmFeedCache("ingestion:failed");
    return failedRun;
  }
}

export async function runIngestion(options?: Partial<RunIngestionOptions>) {
  const resolvedOptions = await resolveRunOptions(options);
  const run = await createFetchRun(resolvedOptions.trigger, resolvedOptions.now);

  return runExistingFetchRun(run, resolvedOptions);
}

export async function startIngestionTask(input?: { triggerType?: "scheduled" | "manual" }) {
  const activeTaskCount = await prisma.backgroundTaskRun.count({
    where: {
      kind: "ingestion",
      status: {
        in: ["queued", "running"],
      },
    },
  });

  if (activeTaskCount > 0) {
    throw new Error("An ingestion run is already in progress.");
  }

  return enqueueTaskRun({
    kind: "ingestion",
    triggerType: input?.triggerType ?? "manual",
    label: DEFAULT_INGESTION_TASK_LABEL,
  });
}

function buildTaskProgressLabel(snapshot: {
  sourceCount: number;
  sourceFailureCount?: number;
  successCount: number;
  failureCount: number;
  itemCount: number;
  fullTextFetchedCount?: number;
}) {
  const fullTextFetchedLabel = `，正文补抓 ${snapshot.fullTextFetchedCount ?? 0} 篇`;
  const sourceFailureCount = snapshot.sourceFailureCount ?? 0;
  const itemFailureCount = Math.max(0, snapshot.failureCount - sourceFailureCount);
  const processedItemCount = Math.min(snapshot.itemCount, snapshot.successCount + itemFailureCount);
  const failureLabel = sourceFailureCount > 0
    ? `，内容失败 ${itemFailureCount} 项，源失败 ${sourceFailureCount} 个`
    : `，失败 ${itemFailureCount} 项`;

  if (snapshot.sourceCount === 0) {
    return "正在同步信息源列表";
  }

  if (snapshot.itemCount === 0) {
    return `已同步 ${snapshot.sourceCount} 个源，暂无可处理内容${failureLabel}${fullTextFetchedLabel}`;
  }

  return `已处理 ${processedItemCount}/${snapshot.itemCount} 条内容，来自 ${snapshot.sourceCount} 个源${failureLabel}${fullTextFetchedLabel}`;
}

function calculateTaskProgressCurrent(snapshot: {
  successCount: number;
  failureCount: number;
  sourceFailureCount?: number;
  itemCount: number;
}) {
  const itemFailureCount = Math.max(0, snapshot.failureCount - (snapshot.sourceFailureCount ?? 0));
  return Math.min(snapshot.itemCount, snapshot.successCount + itemFailureCount);
}

export async function runIngestionTask(taskRun: BackgroundTaskRun, options?: Partial<RunIngestionOptions>) {
  const triggerType = taskRun.triggerType === "scheduled" ? "scheduled" : "manual";
  const resolvedOptions = await resolveRunOptions({
    ...options,
    trigger: triggerType,
  });
  const run = await createFetchRun(triggerType, resolvedOptions.now, taskRun.id);
  let latestAiCallCountActual = 0;
  let latestAiCallCountEstimated = 0;
  let latestAiCallBreakdown: TaskAiCallBreakdownSnapshot[] = [];
  let latestStageTimings: TaskStageTimingSnapshot[] = [];
  let latestTaskTimeline: TaskTimelineNodeSnapshot[] = createInitialIngestionTaskTimeline();
  let latestFullTextFetchedCount = 0;
  let latestSourceFailureCount = 0;

  await updateTaskRun(taskRun.id, {
    status: "running",
    startedAt: run.startedAt,
    progressLabel: "正在同步信息源列表",
    fullTextFetchedCount: 0,
    aiCallCountActual: 0,
    aiCallCountEstimated: 0,
    aiCallBreakdown: [],
    taskTimeline: latestTaskTimeline,
  });

  const completedRun = await runExistingFetchRun(run, {
    ...resolvedOptions,
    onProgress: async (snapshot) => {
      latestAiCallCountActual = snapshot.aiCallCountActual ?? latestAiCallCountActual;
      latestAiCallCountEstimated = snapshot.aiCallCountEstimated ?? latestAiCallCountEstimated;
      latestAiCallBreakdown = snapshot.aiCallBreakdown ?? latestAiCallBreakdown;
      latestStageTimings = snapshot.stageTimings ?? latestStageTimings;
      latestTaskTimeline = snapshot.taskTimeline ?? latestTaskTimeline;
      latestFullTextFetchedCount = snapshot.fullTextFetchedCount;
      latestSourceFailureCount = snapshot.sourceFailureCount ?? latestSourceFailureCount;
      await updateTaskRun(taskRun.id, {
        status: snapshot.status,
        progressCurrent: calculateTaskProgressCurrent(snapshot),
        progressTotal: snapshot.itemCount,
        progressLabel: buildTaskProgressLabel(snapshot),
        itemsAdded: snapshot.itemsAdded,
        fullTextFetchedCount: snapshot.fullTextFetchedCount,
        aiCallCountActual: latestAiCallCountActual,
        aiCallCountEstimated: latestAiCallCountEstimated,
        aiCallBreakdown: latestAiCallBreakdown,
        errorSummary: snapshot.errorSummary ?? null,
        stageTimings: snapshot.stageTimings ?? [],
        taskTimeline: snapshot.taskTimeline ?? latestTaskTimeline,
        finishedAt:
          snapshot.status === "running"
            ? null
            : new Date(),
      });
    },
  });

  await updateTaskRun(taskRun.id, {
    status: completedRun.errorSummary === TASK_RUN_CANCELLED_MESSAGE ? "cancelled" : completedRun.status,
    progressCurrent: calculateTaskProgressCurrent({
      ...completedRun,
      sourceFailureCount: latestSourceFailureCount,
    }),
    progressTotal: completedRun.itemCount,
    progressLabel:
      completedRun.errorSummary === TASK_RUN_CANCELLED_MESSAGE
        ? TASK_RUN_CANCELLED_LABEL
        : buildTaskProgressLabel({
            ...completedRun,
            sourceFailureCount: latestSourceFailureCount,
            fullTextFetchedCount: latestFullTextFetchedCount,
          }),
    itemsAdded: completedRun.itemsAdded,
    fullTextFetchedCount: latestFullTextFetchedCount,
    aiCallCountActual: latestAiCallCountActual,
    aiCallCountEstimated: latestAiCallCountEstimated,
    aiCallBreakdown: latestAiCallBreakdown,
    errorSummary: completedRun.errorSummary ?? null,
    stageTimings: latestStageTimings,
    taskTimeline: latestTaskTimeline,
    finishedAt: completedRun.finishedAt,
  });

  if (completedRun.errorSummary !== TASK_RUN_CANCELLED_MESSAGE) {
    await enqueuePrecomputeTask({ triggerType });
  }

  return completedRun;
}
