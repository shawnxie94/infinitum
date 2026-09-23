import {
  ITEM_PROCESSING_RECOVERY_BATCH_SIZE,
  ITEM_PROCESSING_RECOVERY_LOOKBACK_MS,
  ITEM_PROCESSING_RECOVERY_MAX_ATTEMPTS,
  ITEM_PROCESSING_RECOVERY_MAX_ROUNDS,
} from "@/config/constants";
import { createAiProvider } from "@/lib/ai/provider-next";
import { type AiProvider } from "@/lib/ai/provider-types";
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

export type RecoveryCandidate = {
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

export async function listRecoveryCandidates(now: Date): Promise<RecoveryCandidate[]> {
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
