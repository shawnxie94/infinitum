import type { BackgroundTaskRun, FetchRunStatus } from "@prisma/client";
import type { DomainTaskContext } from "@infinitum/ai/orchestration/task-definition";
import { createClusterAssignmentCoordinator } from "@/lib/clusters/helpers";
import { executeClusterMerge, recomputeCluster } from "@/lib/clusters/service";
import { refreshClusterFeedStatsSafely } from "@/lib/clusters/feed-stats";
import { prisma } from "@/lib/db";
import { invalidateFeedCache } from "@/lib/feed/cache";
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
import type { TaskAiCallBreakdownSnapshot } from "@/lib/tasks/types";

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
};

function asTaskRun(input: unknown): Pick<BackgroundTaskRun, "id" | "triggerType"> {
  if (!input || typeof input !== "object" || !("id" in input) || typeof input.id !== "string") {
    throw new Error("Ingestion task id is required.");
  }
  return input as Pick<BackgroundTaskRun, "id" | "triggerType">;
}

function taskRunIdFromInput(input: unknown): string {
  return asTaskRun(input).id;
}

async function resolveStageOptions(payload?: IngestionWorkflowPayload): Promise<ResolvedRunOptions> {
  return resolveRunOptions({
    trigger: payload?.trigger ?? "manual",
    now: payload ? new Date(payload.now) : new Date(),
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
): Promise<IngestionWorkflowPayload> {
  const trigger = taskRun.triggerType === "scheduled" ? "scheduled" : "manual";
  const now = new Date();
  const options = await resolveRunOptions({ trigger, now });
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

  const payload: IngestionWorkflowPayload = {
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
  };
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
  });
  return payload;
}

async function runItemProcessingStage(
  payload: IngestionWorkflowPayload,
  context: DomainTaskContext,
): Promise<IngestionWorkflowPayload> {
  const options = await resolveStageOptions(payload);
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

  await updateTaskRun(taskRunIdFromInput({ id: context.taskRunId }), {
    progressCurrent: 0,
    progressTotal: preparedLookups.length,
    progressLabel: `开始处理 ${preparedLookups.length} 条内容`,
  });
  await runWithConcurrency(
    preparedLookups.map(({ preparedItem, lookup }) => async () => {
      await context.checkCancellation();
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
        if (result.status === "failed" || hasItemProcessingFailure(result)) {
          failureCount += 1;
          if (hasItemProcessingFailure(result)) errors.push(buildItemProcessingFailureMessage(result));
        } else if (result.status !== "filtered") {
          successCount += 1;
          if (result.isNew) itemsAdded += 1;
        }
        if (result.fullTextFetched) fullTextFetchedCount += 1;
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
  const next: IngestionWorkflowPayload = {
    ...payload,
    processableItemCount: preparedLookups.length,
    successCount,
    failureCount,
    itemsAdded,
    fullTextFetchedCount,
    errors,
    affectedClusterIds: [...affectedClusterIds],
    aiCallCountActual: snapshot.actual,
    aiCallCountEstimated: snapshot.estimated,
    aiCallBreakdown: snapshot.breakdown,
  };
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
  });
  return next;
}

async function runClusterMergeStage(payload: IngestionWorkflowPayload, context: DomainTaskContext): Promise<IngestionWorkflowPayload> {
  await context.checkCancellation();
  const options = await resolveStageOptions(payload);
  const trackedAiProvider = options.aiUsage.wrapProvider(options.aiProvider);
  const result = await executeClusterMerge(trackedAiProvider, new Date(payload.now), {
    liveClusterIds: payload.affectedClusterIds,
  });
  const affectedClusterIds = new Set(payload.affectedClusterIds);
  for (const clusterId of result.affectedClusterIds) affectedClusterIds.add(clusterId);
  return { ...payload, affectedClusterIds: [...affectedClusterIds], aiCallCountActual: options.aiUsage.snapshot().actual, aiCallCountEstimated: options.aiUsage.snapshot().estimated, aiCallBreakdown: options.aiUsage.snapshot().breakdown };
}

async function runClusterFinalizeStage(payload: IngestionWorkflowPayload, context: DomainTaskContext): Promise<IngestionWorkflowPayload> {
  const options = await resolveStageOptions(payload);
  const trackedAiProvider = options.aiUsage.wrapProvider(options.aiProvider);
  for (const clusterId of payload.affectedClusterIds) {
    await context.checkCancellation();
    await recomputeCluster(clusterId, trackedAiProvider);
  }
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
    aiCallCountActual: payload.aiCallCountActual,
    aiCallCountEstimated: payload.aiCallCountEstimated,
    aiCallBreakdown: payload.aiCallBreakdown,
    errorSummary: completedRun.errorSummary,
    finishedAt: completedRun.finishedAt,
  });
  invalidateFeedCache();
  if (status !== "failed") {
    await enqueuePrecomputeTask({ triggerType: payload.trigger });
  }
  if (payload.failureCount > payload.sourceFailureCount) {
    await enqueueItemProcessingRecoveryTask({ triggerType: payload.trigger, force: true }).catch(() => null);
  }
  return payload;
}

export async function executeIngestionWorkflowStage(
  stage: IngestionWorkflowStage,
  input: unknown,
  context: DomainTaskContext,
): Promise<IngestionWorkflowPayload> {
  try {
    if (stage === "source_sync") return runSourceSyncStage(asTaskRun(input), context);
    if (!input || typeof input !== "object" || !("fetchRunId" in input)) throw new Error(`Ingestion stage ${stage} requires previous stage output.`);
    const payload = input as IngestionWorkflowPayload;
    if (stage === "item_processing") return runItemProcessingStage(payload, context);
    if (stage === "cluster_merge") return runClusterMergeStage(payload, context);
    return runClusterFinalizeStage(payload, context);
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
