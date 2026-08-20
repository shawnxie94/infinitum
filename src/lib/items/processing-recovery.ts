import {
  ITEM_PROCESSING_RECOVERY_BATCH_SIZE,
  ITEM_PROCESSING_RECOVERY_LOOKBACK_MS,
  ITEM_PROCESSING_RECOVERY_MAX_ATTEMPTS,
  ITEM_PROCESSING_RECOVERY_MAX_ROUNDS,
} from "@/config/constants";
import { createAiProvider, type AiProvider } from "@/lib/ai/provider";
import { RETRIABLE_AGGREGATION_PARSE_STATUSES } from "@/lib/aggregation/status";
import { assignItemToCluster, recomputeCluster } from "@/lib/clusters/service";
import { prisma } from "@/lib/db";
import { invalidateDailyReportCache } from "@/lib/daily-report/cache";
import { invalidateFeedCache } from "@/lib/feed/cache";
import {
  buildEventSignatureFromItemFields,
  classifyItemProcessingRecoveryReasons,
  degradeExhaustedAggregationItem,
  scheduleItemProcessingRetry,
  type ItemProcessingRecoveryReason,
} from "@/lib/items/processing-state";
import { reanalyzeItem, regenerateItemContent } from "@/lib/items/service";
import { createTaskAiUsageTracker } from "@/lib/tasks/ai-usage";
import {
  enqueueTaskRun,
  isTaskRunCancellationRequested,
  TASK_RUN_CANCELLED_LABEL,
  TASK_RUN_CANCELLED_MESSAGE,
  updateTaskRun,
} from "@/lib/tasks/service";

type RecoveryCandidate = {
  id: string;
  originalTitle: string;
  clusterId: string | null;
  isAggregation: boolean;
  aggregationParseStatus: string | null;
  hasActiveSplitChildren?: boolean;
  processingAttemptCount: number;
  summaryStatus: string;
  analysisStatus: string;
  eventType: string | null;
  eventSubject: string | null;
  eventAction: string | null;
  eventObject: string | null;
  eventDate: string | null;
  source: {
    aiParsingEnabled: boolean;
    aggregationDetectionEnabled: boolean;
    aggregationEnabled: boolean;
  };
  reasons: ItemProcessingRecoveryReason[];
};

async function listRecoveryCandidates(now: Date): Promise<RecoveryCandidate[]> {
  const since = new Date(now.getTime() - ITEM_PROCESSING_RECOVERY_LOOKBACK_MS);
  const rows = await prisma.item.findMany({
    where: {
      status: "processed",
      moderationStatus: { in: ["allowed", "restored"] },
      parentItemId: null,
      updatedAt: { gte: since },
      processingAttemptCount: { lt: ITEM_PROCESSING_RECOVERY_MAX_ATTEMPTS },
      OR: [
        { nextProcessingRetryAt: null },
        { nextProcessingRetryAt: { lte: now } },
      ],
      AND: [
        {
          OR: [
            { summaryStatus: "failed" },
            { analysisStatus: "failed" },
            {
              aggregationParseStatus: {
                in: [...RETRIABLE_AGGREGATION_PARSE_STATUSES],
              },
            },
            {
              AND: [
                { analysisStatus: "succeeded" },
                { isAggregation: false },
                {
                  OR: [
                    { eventSubject: null },
                    { eventObject: null },
                    {
                      AND: [
                        { eventAction: null },
                        { eventType: null },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      source: {
        is: {
          enabled: true,
          aiParsingEnabled: true,
        },
      },
    },
    select: {
      id: true,
      originalTitle: true,
      clusterId: true,
      status: true,
      moderationStatus: true,
      isAggregation: true,
      aggregationParseStatus: true,
      processingAttemptCount: true,
      nextProcessingRetryAt: true,
      summaryStatus: true,
      analysisStatus: true,
      eventType: true,
      eventSubject: true,
      eventAction: true,
      eventObject: true,
      eventDate: true,
      _count: {
        select: {
          aggregationSplitChildren: true,
        },
      },
      source: {
        select: {
          aiParsingEnabled: true,
          aggregationDetectionEnabled: true,
          aggregationEnabled: true,
        },
      },
    },
    orderBy: [
      { updatedAt: "desc" },
      { nextProcessingRetryAt: "asc" },
    ],
    take: ITEM_PROCESSING_RECOVERY_BATCH_SIZE * 3,
  });

  return rows
    .map((row) => {
      const hasActiveSplitChildren = row._count.aggregationSplitChildren > 0;
      return {
        ...row,
        hasActiveSplitChildren,
        reasons: classifyItemProcessingRecoveryReasons({
          ...row,
          hasActiveSplitChildren,
        }),
      };
    })
    .filter((row) => row.reasons.length > 0)
    .slice(0, ITEM_PROCESSING_RECOVERY_BATCH_SIZE);
}

/**
 * Enqueue recovery only when explicitly needed.
 * Prefer calling with force=true after ingestion already observed recoverable failures,
 * so we do not scan candidates on every worker loop tick.
 */
export async function enqueueItemProcessingRecoveryTask(input?: {
  triggerType?: "scheduled" | "manual" | "admin_action";
  force?: boolean;
  now?: Date;
}) {
  const activeTaskCount = await prisma.backgroundTaskRun.count({
    where: {
      kind: "item_processing_recovery",
      status: { in: ["queued", "running"] },
    },
  });

  if (activeTaskCount > 0) {
    return null;
  }

  if (!input?.force) {
    const candidates = await listRecoveryCandidates(input?.now ?? new Date());
    if (candidates.length === 0) {
      return null;
    }
  }

  return enqueueTaskRun({
    kind: "item_processing_recovery",
    triggerType: input?.triggerType ?? "manual",
    label: "抓取失败补偿",
  });
}

export async function executeItemProcessingRecoveryTask(
  taskRun: { id: string },
  options?: { aiProvider?: AiProvider; now?: Date },
) {
  if (await isTaskRunCancellationRequested(taskRun.id)) {
    await updateTaskRun(taskRun.id, {
      status: "cancelled",
      progressLabel: TASK_RUN_CANCELLED_LABEL,
      errorSummary: TASK_RUN_CANCELLED_MESSAGE,
      finishedAt: new Date(),
    });
    return;
  }

  const now = options?.now ?? new Date();
  const firstBatch = await listRecoveryCandidates(now);

  if (firstBatch.length === 0) {
    await updateTaskRun(taskRun.id, {
      status: "succeeded",
      progressCurrent: 0,
      progressTotal: 0,
      progressLabel: "无需补偿的失败条目",
      finishedAt: new Date(),
    });
    return;
  }

  const aiUsage = createTaskAiUsageTracker(
    firstBatch.length * ITEM_PROCESSING_RECOVERY_MAX_ROUNDS,
    "item_understanding",
  );
  let baseProvider = options?.aiProvider;
  if (!baseProvider) {
    const { getIngestionRuntimeConfig } = await import("@/lib/settings/service");
    const runtimeConfig = await getIngestionRuntimeConfig();
    baseProvider = createAiProvider(runtimeConfig.modelApi, {
      itemUnderstanding: runtimeConfig.selectedPromptConfigs?.itemUnderstanding,
      clusterSummary: runtimeConfig.selectedPromptConfigs?.clusterSummary,
      clusterMatch: runtimeConfig.selectedPromptConfigs?.clusterMatch,
    }, undefined, {
      aggregationSplitMaxEvents: runtimeConfig.ingestion.aggregationSplitMaxEvents,
      onUsage: (usage, usageKey) => aiUsage.addUsageByKey(usageKey, usage),
    });
  }
  const trackedAiProvider = aiUsage.wrapProvider(baseProvider);

  let processedCount = 0;
  let recoveredCount = 0;
  let degradedCount = 0;
  let reassignedCount = 0;
  let roundsCompleted = 0;
  const issues: string[] = [];
  const affectedClusterIds = new Set<string>();
  let feedInvalidated = false;
  let progressTotal = firstBatch.length;
  let nextBatch: RecoveryCandidate[] | null = firstBatch;

  await updateTaskRun(taskRun.id, {
    status: "running",
    progressCurrent: 0,
    progressTotal,
    progressLabel: `开始补偿，第 1/${ITEM_PROCESSING_RECOVERY_MAX_ROUNDS} 轮，候选 ${firstBatch.length} 条`,
    aiCallCountActual: 0,
    aiCallCountEstimated: aiUsage.snapshot().estimated,
    aiCallBreakdown: aiUsage.snapshot().breakdown,
  });

  while (nextBatch && nextBatch.length > 0 && roundsCompleted < ITEM_PROCESSING_RECOVERY_MAX_ROUNDS) {
    if (await isTaskRunCancellationRequested(taskRun.id)) {
      await updateTaskRun(taskRun.id, {
        status: "cancelled",
        progressCurrent: processedCount,
        progressTotal,
        progressLabel: TASK_RUN_CANCELLED_LABEL,
        errorSummary: TASK_RUN_CANCELLED_MESSAGE,
        finishedAt: new Date(),
      });
      return;
    }

    roundsCompleted += 1;
    const candidates = nextBatch;
    nextBatch = null;
    progressTotal = Math.max(progressTotal, processedCount + candidates.length);
    const processedIds = new Set<string>();

    await updateTaskRun(taskRun.id, {
      status: "running",
      progressCurrent: processedCount,
      progressTotal,
      progressLabel: `第 ${roundsCompleted}/${ITEM_PROCESSING_RECOVERY_MAX_ROUNDS} 轮补偿 ${candidates.length} 条`,
      aiCallCountActual: aiUsage.snapshot().actual,
      aiCallCountEstimated: aiUsage.snapshot().estimated,
      aiCallBreakdown: aiUsage.snapshot().breakdown,
    });

    for (const candidate of candidates) {
      if (await isTaskRunCancellationRequested(taskRun.id)) {
        await updateTaskRun(taskRun.id, {
          status: "cancelled",
          progressCurrent: processedCount,
          progressTotal,
          progressLabel: TASK_RUN_CANCELLED_LABEL,
          errorSummary: TASK_RUN_CANCELLED_MESSAGE,
          finishedAt: new Date(),
        });
        return;
      }

      processedCount += 1;
      processedIds.add(candidate.id);

      try {
        if (candidate.hasActiveSplitChildren) {
          // Aggregation parents with live split children only need their
          // summary regenerated; a full re-analysis would retire and rebuild
          // the split on every flaky understanding response.
          await regenerateItemContent(candidate.id, "summary", {
            aiProvider: trackedAiProvider,
          });
          const refreshed = await prisma.item.findUniqueOrThrow({
            where: { id: candidate.id },
            include: {
              _count: {
                select: {
                  aggregationSplitChildren: true,
                },
              },
              source: {
                select: {
                  aiParsingEnabled: true,
                  aggregationDetectionEnabled: true,
                  aggregationEnabled: true,
                },
              },
            },
          });
          const remaining = classifyItemProcessingRecoveryReasons({
            ...refreshed,
            hasActiveSplitChildren: refreshed._count.aggregationSplitChildren > 0,
          });
          if (remaining.length === 0) {
            recoveredCount += 1;
          } else {
            await scheduleItemProcessingRetry({
              itemId: candidate.id,
              reasons: remaining,
              attemptCount: candidate.processingAttemptCount,
              now,
            });
          }
          feedInvalidated = true;
          continue;
        }

        const outcome = await reanalyzeItem(candidate.id, {
          aiProvider: trackedAiProvider,
        });
        const refreshed = await prisma.item.findUniqueOrThrow({
          where: { id: candidate.id },
          include: {
            _count: {
              select: {
                aggregationSplitChildren: true,
              },
            },
            source: {
              select: {
                aiParsingEnabled: true,
                aggregationDetectionEnabled: true,
                aggregationEnabled: true,
              },
            },
          },
        });
        const remaining = classifyItemProcessingRecoveryReasons({
          ...refreshed,
          hasActiveSplitChildren: refreshed._count.aggregationSplitChildren > 0,
        });

        if (outcome.item.clusterId) {
          affectedClusterIds.add(outcome.item.clusterId);
        }
        if (candidate.clusterId && candidate.clusterId !== outcome.item.clusterId) {
          affectedClusterIds.add(candidate.clusterId);
        }

        // reanalyzeItem already synced retry state; only handle terminal aggregation degrade here.
        if (remaining.length === 0) {
          recoveredCount += 1;
        } else if (
          remaining.includes("aggregation_retriable") &&
          (
            refreshed.processingAttemptCount >= ITEM_PROCESSING_RECOVERY_MAX_ATTEMPTS ||
            refreshed.nextProcessingRetryAt == null
          )
        ) {
          const degrade = await degradeExhaustedAggregationItem(
            candidate.id,
            `aggregation recovery exhausted: ${remaining.join(",")}`,
          );
          degradedCount += 1;
          if (degrade.degradedToRegular) {
            const assignment = await assignItemToCluster(candidate.id, {
              eventSignature: buildEventSignatureFromItemFields(refreshed),
              aiProvider: trackedAiProvider,
              aggregationEnabled: refreshed.source.aggregationEnabled,
              allowIncompleteSignaturePending: true,
            });
            if (assignment.clusterId) {
              affectedClusterIds.add(assignment.clusterId);
              reassignedCount += 1;
            }
            feedInvalidated = true;
          }
        } else if (
          remaining.includes("incomplete_signature") &&
          !refreshed.clusterId &&
          !refreshed.isAggregation
        ) {
          const assignment = await assignItemToCluster(candidate.id, {
            eventSignature: buildEventSignatureFromItemFields(refreshed),
            aiProvider: trackedAiProvider,
            aggregationEnabled: refreshed.source.aggregationEnabled,
            allowIncompleteSignaturePending: true,
          });
          if (assignment.clusterId) {
            affectedClusterIds.add(assignment.clusterId);
            reassignedCount += 1;
          }
        }

        feedInvalidated = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown recovery error";
        issues.push(`${candidate.id}: ${message}`);
        await scheduleItemProcessingRetry({
          itemId: candidate.id,
          reasons: [`recovery_error:${message}`],
          attemptCount: candidate.processingAttemptCount,
          now,
        });
      }

      await updateTaskRun(taskRun.id, {
        progressCurrent: processedCount,
        progressTotal,
        progressLabel: `第 ${roundsCompleted}/${ITEM_PROCESSING_RECOVERY_MAX_ROUNDS} 轮：已补偿 ${processedCount} 条，恢复 ${recoveredCount}，降级 ${degradedCount}`,
        aiCallCountActual: aiUsage.snapshot().actual,
        aiCallCountEstimated: aiUsage.snapshot().estimated,
        aiCallBreakdown: aiUsage.snapshot().breakdown,
      });
    }

    if (roundsCompleted >= ITEM_PROCESSING_RECOVERY_MAX_ROUNDS) {
      break;
    }

    // Continue only when the previous round hit the batch ceiling and fresh due
    // candidates still remain. This keeps one compensation task bounded while
    // still draining a larger fresh failure burst from the latest ingestion.
    if (candidates.length >= ITEM_PROCESSING_RECOVERY_BATCH_SIZE) {
      const remainingCandidates = (await listRecoveryCandidates(now))
        .filter((candidate) => !processedIds.has(candidate.id));
      if (remainingCandidates.length > 0) {
        nextBatch = remainingCandidates;
        progressTotal = processedCount + remainingCandidates.length;
      }
    }
  }

  for (const clusterId of affectedClusterIds) {
    await recomputeCluster(clusterId, trackedAiProvider);
  }

  if (feedInvalidated || recoveredCount > 0 || degradedCount > 0 || reassignedCount > 0) {
    invalidateFeedCache();
    invalidateDailyReportCache();
  }

  const finalStatus =
    issues.length > 0 && recoveredCount === 0 && degradedCount === 0
      ? "failed"
      : issues.length > 0
        ? "partial"
        : "succeeded";

  await updateTaskRun(taskRun.id, {
    status: finalStatus,
    progressCurrent: processedCount,
    progressTotal,
    progressLabel: `补偿完成：${roundsCompleted} 轮，恢复 ${recoveredCount}，降级 ${degradedCount}，重归组 ${reassignedCount}${issues.length > 0 ? `，失败 ${issues.length}` : ""}`,
    aiCallCountActual: aiUsage.snapshot().actual,
    aiCallCountEstimated: aiUsage.snapshot().estimated,
    aiCallBreakdown: aiUsage.snapshot().breakdown,
    errorSummary: issues.length > 0 ? issues.slice(0, 5).join(" | ") : null,
    finishedAt: new Date(),
  });
}
