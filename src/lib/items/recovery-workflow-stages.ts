import {
  ITEM_PROCESSING_RECOVERY_MAX_ATTEMPTS,
  ITEM_PROCESSING_RECOVERY_MAX_ROUNDS,
} from "@/config/constants";
import { createAiProvider, type AiProvider } from "@/lib/ai/provider";
import { assignItemToCluster, recomputeCluster } from "@/lib/clusters/service";
import { prisma } from "@/lib/db";
import { invalidateDailyReportCache } from "@/lib/daily-report/cache";
import { invalidateFeedCache } from "@/lib/feed/cache";
import {
  buildEventSignatureFromItemFields,
  classifyItemProcessingRecoveryReasons,
  degradeExhaustedAggregationItem,
  scheduleItemProcessingRetry,
} from "@/lib/items/processing-state";
import { reanalyzeItem, regenerateItemContent } from "@/lib/items/service";
import { updateTaskRun } from "@/lib/tasks/service";
import { createTaskAiUsageTracker } from "@/lib/tasks/ai-usage";
import type { DomainTaskContext } from "@infinitum/ai/orchestration/task-definition";
import { getIngestionRuntimeConfig } from "@/lib/settings/service";
import { listRecoveryCandidates, type RecoveryCandidate } from "@/lib/items/processing-recovery";

export type RecoveryWorkflowPayload = {
  now: string;
  processedCount: number;
  recoveredCount: number;
  degradedCount: number;
  reassignedCount: number;
  roundsCompleted: number;
  progressTotal: number;
  issues: string[];
  affectedClusterIds: string[];
  feedInvalidated: boolean;
  aiCallCountActual: number;
  aiCallCountEstimated: number;
  aiCallBreakdown: ReturnType<ReturnType<typeof createTaskAiUsageTracker>["snapshot"]>["breakdown"];
};

async function createTrackedProvider(
  provided: AiProvider | undefined,
  aiUsage: ReturnType<typeof createTaskAiUsageTracker>,
): Promise<AiProvider> {
  if (provided) return aiUsage.wrapProvider(provided);
  const runtimeConfig = await getIngestionRuntimeConfig();
  const provider = createAiProvider(
    runtimeConfig.modelApi,
    {
      itemUnderstanding: runtimeConfig.selectedPromptConfigs?.itemUnderstanding,
      clusterSummary: runtimeConfig.selectedPromptConfigs?.clusterSummary,
      clusterMatch: runtimeConfig.selectedPromptConfigs?.clusterMatch,
    },
    undefined,
    {
      aggregationSplitMaxEvents: runtimeConfig.ingestion.aggregationSplitMaxEvents,
      embedding: runtimeConfig.embedding,
      onUsage: (usage, usageKey) => aiUsage.addUsageByKey(usageKey, usage),
    },
  );
  return aiUsage.wrapProvider(provider);
}

async function processCandidate(
  candidate: RecoveryCandidate,
  aiProvider: AiProvider,
  now: Date,
  checkCancellation: () => Promise<void>,
): Promise<{
  recovered: boolean;
  degraded: boolean;
  reassigned: boolean;
  feedInvalidated: boolean;
  affectedClusterIds: string[];
}> {
  await checkCancellation();
  const affectedClusterIds = new Set<string>();
  if (candidate.hasActiveSplitChildren) {
    await regenerateItemContent(candidate.id, "summary", { aiProvider });
    const refreshed = await prisma.item.findUniqueOrThrow({
      where: { id: candidate.id },
      include: {
        _count: { select: { aggregationSplitChildren: true } },
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
    if (remaining.length > 0) {
      await scheduleItemProcessingRetry({
        itemId: candidate.id,
        reasons: remaining,
        attemptCount: candidate.processingAttemptCount,
        now,
      });
    }
    return {
      recovered: remaining.length === 0,
      degraded: false,
      reassigned: false,
      feedInvalidated: true,
      affectedClusterIds: [],
    };
  }

  const outcome = await reanalyzeItem(candidate.id, { aiProvider });
  const refreshed = await prisma.item.findUniqueOrThrow({
    where: { id: candidate.id },
    include: {
      _count: { select: { aggregationSplitChildren: true } },
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

  if (outcome.item.clusterId) affectedClusterIds.add(outcome.item.clusterId);
  if (candidate.clusterId && candidate.clusterId !== outcome.item.clusterId) affectedClusterIds.add(candidate.clusterId);

  let degraded = false;
  let reassigned = false;
  if (
    remaining.includes("aggregation_retriable") &&
    (refreshed.processingAttemptCount >= ITEM_PROCESSING_RECOVERY_MAX_ATTEMPTS || refreshed.nextProcessingRetryAt == null)
  ) {
    const result = await degradeExhaustedAggregationItem(
      candidate.id,
      `aggregation recovery exhausted: ${remaining.join(",")}`,
    );
    degraded = true;
    if (result.degradedToRegular) {
      const assignment = await assignItemToCluster(candidate.id, {
        eventSignature: buildEventSignatureFromItemFields(refreshed),
        aiProvider,
        aggregationEnabled: refreshed.source.aggregationEnabled,
        allowIncompleteSignaturePending: true,
      });
      if (assignment.clusterId) {
        affectedClusterIds.add(assignment.clusterId);
        reassigned = true;
      }
    }
  } else if (remaining.includes("incomplete_signature") && !refreshed.clusterId && !refreshed.isAggregation) {
    const assignment = await assignItemToCluster(candidate.id, {
      eventSignature: buildEventSignatureFromItemFields(refreshed),
      aiProvider,
      aggregationEnabled: refreshed.source.aggregationEnabled,
      allowIncompleteSignaturePending: true,
    });
    if (assignment.clusterId) {
      affectedClusterIds.add(assignment.clusterId);
      reassigned = true;
    }
  }

  return {
    recovered: remaining.length === 0,
    degraded,
    reassigned,
    feedInvalidated: true,
    affectedClusterIds: [...affectedClusterIds],
  };
}

export async function executeRecoveryWorkflowStage(
  stage: "recovery_batch" | "recovery_persist",
  input: unknown,
  context: DomainTaskContext,
): Promise<RecoveryWorkflowPayload> {
  const taskRunId = context.taskRunId;
  const previous = input && typeof input === "object" && "now" in input
    ? input as RecoveryWorkflowPayload
    : null;
  const now = new Date(previous?.now ?? new Date().toISOString());

  if (stage === "recovery_persist") {
    if (!previous) throw new Error("Recovery persist stage requires batch output.");
    const aiUsage = createTaskAiUsageTracker();
    const provider = await createTrackedProvider(undefined, aiUsage);
    for (const clusterId of previous.affectedClusterIds) {
      await context.checkCancellation();
      await recomputeCluster(clusterId, provider);
    }
    if (previous.feedInvalidated || previous.recoveredCount > 0 || previous.degradedCount > 0 || previous.reassignedCount > 0) {
      invalidateFeedCache();
      invalidateDailyReportCache();
    }
    const finalStatus =
      previous.issues.length > 0 && previous.recoveredCount === 0 && previous.degradedCount === 0
        ? "failed"
        : previous.issues.length > 0 ? "partial" : "succeeded";
    await updateTaskRun(taskRunId, {
      status: finalStatus,
      progressCurrent: previous.processedCount,
      progressTotal: previous.progressTotal,
      progressLabel: `补偿完成：${previous.roundsCompleted} 轮，恢复 ${previous.recoveredCount}，降级 ${previous.degradedCount}，重归组 ${previous.reassignedCount}${previous.issues.length > 0 ? `，失败 ${previous.issues.length}` : ""}`,
      aiCallCountActual: previous.aiCallCountActual,
      aiCallCountEstimated: previous.aiCallCountEstimated,
      aiCallBreakdown: previous.aiCallBreakdown,
      errorSummary: previous.issues.length > 0 ? previous.issues.slice(0, 5).join(" | ") : null,
      finishedAt: new Date(),
    });
    return previous;
  }

  const firstBatch = await listRecoveryCandidates(now);
  if (firstBatch.length === 0) {
    const empty: RecoveryWorkflowPayload = {
      now: now.toISOString(), processedCount: 0, recoveredCount: 0, degradedCount: 0,
      reassignedCount: 0, roundsCompleted: 0, progressTotal: 0, issues: [],
      affectedClusterIds: [], feedInvalidated: false, aiCallCountActual: 0,
      aiCallCountEstimated: 0, aiCallBreakdown: [],
    };
    await updateTaskRun(taskRunId, {
      progressCurrent: 0,
      progressTotal: 0,
      progressLabel: "无需补偿的失败条目",
    });
    return empty;
  }

  const aiUsage = createTaskAiUsageTracker(firstBatch.length * ITEM_PROCESSING_RECOVERY_MAX_ROUNDS, "item_understanding");
  const provider = await createTrackedProvider(undefined, aiUsage);
  let processedCount = 0;
  let recoveredCount = 0;
  let degradedCount = 0;
  let reassignedCount = 0;
  let roundsCompleted = 0;
  let progressTotal = firstBatch.length;
  let nextBatch: RecoveryCandidate[] | null = firstBatch;
  const issues: string[] = [];
  const affectedClusterIds = new Set<string>();
  let feedInvalidated = false;

  await updateTaskRun(taskRunId, {
    progressCurrent: 0,
    progressTotal,
    progressLabel: `开始补偿，第 1/${ITEM_PROCESSING_RECOVERY_MAX_ROUNDS} 轮，候选 ${firstBatch.length} 条`,
    aiCallCountActual: 0,
    aiCallCountEstimated: aiUsage.snapshot().estimated,
    aiCallBreakdown: aiUsage.snapshot().breakdown,
  });

  while (nextBatch && nextBatch.length > 0 && roundsCompleted < ITEM_PROCESSING_RECOVERY_MAX_ROUNDS) {
    await context.checkCancellation();
    roundsCompleted += 1;
    const candidates = nextBatch;
    nextBatch = null;
    const processedIds = new Set<string>();
    progressTotal = Math.max(progressTotal, processedCount + candidates.length);

    for (const candidate of candidates) {
      await context.checkCancellation();
      processedCount += 1;
      processedIds.add(candidate.id);
      try {
        const result = await processCandidate(candidate, provider, now, context.checkCancellation);
        if (result.recovered) recoveredCount += 1;
        if (result.degraded) degradedCount += 1;
        if (result.reassigned) reassignedCount += 1;
        feedInvalidated ||= result.feedInvalidated;
        for (const clusterId of result.affectedClusterIds) affectedClusterIds.add(clusterId);
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
      const snapshot = aiUsage.snapshot();
      await updateTaskRun(taskRunId, {
        progressCurrent: processedCount,
        progressTotal,
        progressLabel: `第 ${roundsCompleted}/${ITEM_PROCESSING_RECOVERY_MAX_ROUNDS} 轮：已补偿 ${processedCount} 条，恢复 ${recoveredCount}，降级 ${degradedCount}`,
        aiCallCountActual: snapshot.actual,
        aiCallCountEstimated: snapshot.estimated,
        aiCallBreakdown: snapshot.breakdown,
      });
    }

    if (roundsCompleted < ITEM_PROCESSING_RECOVERY_MAX_ROUNDS && candidates.length > 0) {
      const remaining = (await listRecoveryCandidates(now)).filter((candidate) => !processedIds.has(candidate.id));
      if (remaining.length > 0) {
        nextBatch = remaining;
        progressTotal = processedCount + remaining.length;
      }
    }
  }

  const snapshot = aiUsage.snapshot();
  return {
    now: now.toISOString(),
    processedCount,
    recoveredCount,
    degradedCount,
    reassignedCount,
    roundsCompleted,
    progressTotal,
    issues,
    affectedClusterIds: [...affectedClusterIds],
    feedInvalidated,
    aiCallCountActual: snapshot.actual,
    aiCallCountEstimated: snapshot.estimated,
    aiCallBreakdown: snapshot.breakdown,
  };
}

