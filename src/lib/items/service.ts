import type { BackgroundTaskRun, Item } from "@prisma/client";

import {
  AGGREGATION_PARSE_STATUS,
  RETRIABLE_AGGREGATION_PARSE_STATUSES,
} from "@/lib/aggregation/status";
import { createAiProvider, type AiCallUsage, type AiEventSignature, type AiProvider, type ItemUnderstandingResult } from "@/lib/ai/provider";
import { invalidateDailyReportCache } from "@/lib/daily-report/cache";
import { assignItemToCluster, recomputeCluster } from "@/lib/clusters/service";
import {
  persistAggregationChildItems,
  reassignAggregationChildParentIfLinked,
  retireAggregationChildItems,
} from "@/lib/aggregation/persist";
import { prisma } from "@/lib/db";
import { invalidateFeedCache } from "@/lib/feed/cache";
import { archiveItemDedupeHistories } from "@/lib/feed/repository";
import { shouldTranslateTitle } from "@/lib/feed/presentation";
import { buildItemUnderstandingInput } from "@/lib/ingestion/content-input";
import { normalizeStoredEventType } from "@/lib/clusters/normalization";
import { getIngestionRuntimeConfig } from "@/lib/settings/service";
import { getItemEntityNamesFromEvent, replaceItemEntities } from "@/lib/entities/service";
import {
  classifyItemProcessingRecoveryReasons,
  clearItemProcessingRetryState,
  scheduleItemProcessingRetry,
} from "@/lib/items/processing-state";
import { createTaskAiUsageTracker } from "@/lib/tasks/ai-usage";
import {
  enqueueTaskRun,
  ensureDefaultItemCleanupSchedule,
  isTaskRunCancellationRequested,
  TASK_RUN_CANCELLED_LABEL,
  TASK_RUN_CANCELLED_MESSAGE,
  updateTaskRun,
} from "@/lib/tasks/service";

type RegenerationTarget = "translation" | "summary";

type RegenerationOptions = {
  aiProvider?: AiProvider;
};

type AggregationReparseCandidate = {
  id: string;
  sourceId: string;
  originalTitle: string;
  originalUrl: string;
  clusterId: string | null;
  publishedAt: Date;
  publishedAtKnown: boolean;
  fullText: string | null;
  rssContent: string | null;
  rssExcerpt: string | null;
  source: { name: string };
};

type AggregationReparseResult = {
  status: "parsed" | "not_aggregation" | "failed";
  childItemIds: string[];
  affectedClusterIds: Set<string>;
  errorMessage: string | null;
};

async function countActiveAggregationChildren(parentItemId: string) {
  return prisma.item.count({
    where: {
      status: "processed",
      moderationStatus: { not: "filtered" },
      OR: [
        { parentItemId },
        {
          aggregationSplitParents: {
            some: { parentItemId },
          },
        },
      ],
    },
  });
}

async function buildItemReanalyzeCompletionLabel(item: Item) {
  if (item.isAggregation) {
    const childCount = await countActiveAggregationChildren(item.id);
    return `已完成重新 AI 判定（聚合 · 子事件 ${childCount} · 处理成功）`;
  }

  return "已完成重新 AI 判定（非聚合 · 处理成功）";
}

async function replaceItemEntitiesSafely(itemId: string, entities: unknown) {
  try {
    await replaceItemEntities(itemId, entities);
  } catch (error) {
    console.error("[Items] Failed to persist item entities:", error);
  }
}

async function resolveItemUnderstanding(
  aiProvider: AiProvider,
  item: Item & { source: { name: string } },
): Promise<ItemUnderstandingResult> {
  const input = buildItemUnderstandingInput(item);

  return aiProvider.understandItem(input, {
    title: item.originalTitle,
    sourceName: item.source.name,
    translateTitle: shouldTranslateTitle(item.originalTitle),
  });
}

function serializeEventSignature(eventSignature?: {
  eventType?: string | null;
  eventSubject?: string | null;
  eventAction?: string | null;
  eventObject?: string | null;
  eventDate?: string | null;
} | null) {
  return {
    eventType: eventSignature?.eventType ?? null,
    eventSubject: eventSignature?.eventSubject ?? null,
    eventAction: eventSignature?.eventAction ?? null,
    eventObject: eventSignature?.eventObject ?? null,
    eventDate: eventSignature?.eventDate ?? null,
  };
}

async function resolveAiProvider(
  aiProvider?: AiProvider,
  options?: { onUsage?: (usage: AiCallUsage, usageKey?: string) => void },
) {
  if (aiProvider) {
    return aiProvider;
  }

  const runtimeConfig = await getIngestionRuntimeConfig();
  return createAiProvider(runtimeConfig.modelApi, {
    itemUnderstanding: runtimeConfig.selectedPromptConfigs?.itemUnderstanding,
    clusterSummary: runtimeConfig.selectedPromptConfigs?.clusterSummary,
    clusterMatch: runtimeConfig.selectedPromptConfigs?.clusterMatch,
  }, undefined, {
    aggregationSplitMaxEvents: runtimeConfig.ingestion.aggregationSplitMaxEvents,
    ...(options?.onUsage ? { onUsage: options.onUsage } : {}),
  });
}

export async function enqueueItemRegenerationTask(itemId: string, target: RegenerationTarget) {
  return enqueueTaskRun({
    kind: target === "translation" ? "item_regenerate_translation" : "item_regenerate_summary",
    triggerType: "admin_action",
    label: target === "translation" ? "重生成翻译标题" : "重生成摘要",
    entityId: itemId,
  });
}

export async function enqueueItemReanalyzeTask(itemId: string) {
  return enqueueTaskRun({
    kind: "item_reanalyze",
    triggerType: "admin_action",
    label: "重新 AI 判定",
    entityId: itemId,
  });
}

export async function regenerateItemContent(
  itemId: string,
  target: RegenerationTarget,
  options?: RegenerationOptions,
): Promise<Item & { source: { name: string } }> {
  const item = await prisma.item.findUnique({
    where: { id: itemId },
    include: { source: true },
  });

  if (!item || item.status !== "processed") {
    throw new Error("Item not found");
  }

  const aiProvider = await resolveAiProvider(options?.aiProvider);
  try {
    const understanding = await resolveItemUnderstanding(aiProvider, item);
    if (target === "translation") {
      await prisma.item.update({
        where: { id: item.id },
        data: {
          translatedTitle:
            shouldTranslateTitle(item.originalTitle) ? understanding.translatedTitle?.trim() || item.originalTitle : item.translatedTitle,
          errorMessage: null,
        },
      });
    } else {
      if (!understanding.diagnostics.summaryValid || !understanding.summary) {
        throw new Error("Item understanding returned an invalid summary");
      }
      await prisma.item.update({
        where: { id: item.id },
        data: {
          summaryText: understanding.summary || item.summaryText,
          summaryStatus: understanding.diagnostics.summaryValid ? "succeeded" : "failed",
          errorMessage: null,
        },
      });
    }

    invalidateFeedCache();
  } catch (error) {
    await prisma.item.update({
      where: { id: item.id },
      data: {
        ...(target === "summary"
          ? {
              summaryStatus: "failed" as const,
            }
          : {}),
        errorMessage: error instanceof Error ? error.message : "Unknown regeneration error",
      },
    });
  }

  const regenerated = await prisma.item.findUniqueOrThrow({
    where: { id: item.id },
    include: { source: true },
  });

  return regenerated;
}

export async function executeItemRegenerationTask(
  taskRun: { id: string; entityId: string | null },
  target: RegenerationTarget,
  options?: RegenerationOptions,
) {
  if (!taskRun.entityId) {
    throw new Error("Task entityId is required.");
  }

  // Summary and translation regeneration each issue one unified understanding
  // call, while persisting only the requested target field.
  const aiUsage = createTaskAiUsageTracker(1, "item_understanding");
  const trackedAiProvider = aiUsage.wrapProvider(
    await resolveAiProvider(options?.aiProvider, {
      onUsage: (usage, usageKey) => aiUsage.addUsageByKey(usageKey, usage),
    }),
    { understandItemEstimated: false },
  );
  const initialAiUsage = aiUsage.snapshot();

  await updateTaskRun(taskRun.id, {
    status: "running",
    progressLabel: "正在读取条目",
    aiCallCountActual: 0,
    aiCallCountEstimated: initialAiUsage.estimated,
    aiCallBreakdown: initialAiUsage.breakdown,
  });

  const item = await regenerateItemContent(taskRun.entityId, target, {
    ...options,
    aiProvider: trackedAiProvider,
  });
  const succeeded = !item.errorMessage;

  await updateTaskRun(taskRun.id, {
    status: succeeded ? "succeeded" : "failed",
    progressCurrent: 1,
    progressTotal: 1,
    progressLabel: succeeded ? "已完成条目更新" : "条目更新失败",
    aiCallCountActual: aiUsage.snapshot().actual,
    aiCallCountEstimated: aiUsage.snapshot().estimated,
    aiCallBreakdown: aiUsage.snapshot().breakdown,
    finishedAt: new Date(),
    errorSummary: item.errorMessage ?? null,
  });

  return item;
}

export async function restoreFilteredItem(itemId: string, options?: RegenerationOptions) {
  const item = await prisma.item.findUnique({
    where: { id: itemId },
    include: { source: true },
  });

  if (!item) {
    throw new Error("Item not found");
  }

  const restored = await prisma.item.update({
    where: { id: item.id },
    data: {
      moderationStatus: "restored",
      restoredByAdminAt: new Date(),
      status: "processed",
    },
    include: { source: true },
  });

  const assignment = await assignItemToCluster(restored.id, {
    eventSignature: null,
    aiProvider: options?.aiProvider,
  });
  if (assignment.clusterId) {
    await recomputeCluster(assignment.clusterId, options?.aiProvider);
  }
  invalidateFeedCache();

  return prisma.item.findUniqueOrThrow({
    where: { id: restored.id },
    include: { source: true },
  });
}

export async function manuallyFilterItem(itemId: string, options?: RegenerationOptions) {
  const item = await prisma.item.findUnique({
    where: { id: itemId },
    include: { source: true },
  });

  if (!item) {
    throw new Error("Item not found");
  }

  const previousClusterId = item.clusterId;
  const filtered = await prisma.item.update({
    where: { id: item.id },
    data: {
      moderationStatus: "filtered",
      moderationReason: "other",
      moderationDetail: "管理员手动过滤",
      status: "filtered",
      clusterId: null,
      manualClusterAssignedAt: null,
      restoredByAdminAt: null,
      errorMessage: null,
    },
    include: { source: true },
  });

  if (previousClusterId) {
    await recomputeCluster(previousClusterId, options?.aiProvider);
  }

  invalidateFeedCache();

  return prisma.item.findUniqueOrThrow({
    where: { id: filtered.id },
    include: { source: true },
  });
}

export async function cancelAggregationSplit(parentItemId: string, options?: RegenerationOptions) {
  const parent = await prisma.item.findUnique({
    where: { id: parentItemId },
    include: {
      source: true,
      children: {
        select: {
          id: true,
          clusterId: true,
        },
      },
      aggregationSplitChildren: {
        select: {
          childItemId: true,
          child: {
            select: {
              id: true,
              clusterId: true,
            },
          },
        },
      },
    },
  });

  if (!parent || !parent.isAggregation) {
    throw new Error("Aggregation parent not found");
  }

  const affectedClusterIds = new Set<string>();
  if (parent.clusterId) {
    affectedClusterIds.add(parent.clusterId);
  }
  for (const child of parent.children) {
    if (child.clusterId) {
      affectedClusterIds.add(child.clusterId);
    }
  }
  for (const link of parent.aggregationSplitChildren) {
    if (link.child.clusterId) {
      affectedClusterIds.add(link.child.clusterId);
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.item.update({
      where: { id: parent.id },
      data: {
        isAggregation: false,
        aggregationParseStatus: AGGREGATION_PARSE_STATUS.manualCancelled,
        status: "processed",
        moderationStatus:
          parent.moderationStatus === "filtered" ? "restored" : parent.moderationStatus,
        restoredByAdminAt: parent.moderationStatus === "filtered" ? new Date() : parent.restoredByAdminAt,
        clusterId: null,
        manualClusterAssignedAt: null,
        errorMessage: null,
      },
    });

    const linkedChildIds = parent.aggregationSplitChildren.map((link) => link.childItemId);
    await tx.aggregationSplitLink.deleteMany({
      where: { parentItemId: parent.id },
    });

    for (const childId of linkedChildIds) {
      const hasRemainingParent = await reassignAggregationChildParentIfLinked(
        tx,
        childId,
        parent.id,
      );
      if (hasRemainingParent) {
        continue;
      }
      await tx.item.updateMany({
        where: { id: childId },
        data: {
          status: "filtered",
          moderationStatus: "filtered",
          moderationReason: "other",
          moderationDetail: "管理员取消聚合拆分",
          filterReason: "aggregation_split_cancelled",
          clusterId: null,
          manualClusterAssignedAt: null,
          errorMessage: null,
        },
      });
    }

    await tx.item.updateMany({
      where: {
        parentItemId: parent.id,
        aggregationSplitParents: { none: {} },
      },
      data: {
        status: "filtered",
        moderationStatus: "filtered",
        moderationReason: "other",
        moderationDetail: "管理员取消聚合拆分",
        filterReason: "aggregation_split_cancelled",
        clusterId: null,
        manualClusterAssignedAt: null,
        errorMessage: null,
      },
    });
  });

  const aiProvider = options?.aiProvider;
  const assignment = await assignItemToCluster(parent.id, {
    eventSignature: null,
    aiProvider,
  });

  if (assignment.clusterId) {
    affectedClusterIds.add(assignment.clusterId);
  }

  for (const clusterId of affectedClusterIds) {
    await recomputeCluster(clusterId, aiProvider);
  }

  invalidateFeedCache();
  invalidateDailyReportCache();

  return prisma.item.findUniqueOrThrow({
    where: { id: parent.id },
    include: { source: true },
  });
}

export async function deleteItem(itemId: string, options?: RegenerationOptions) {
  const item = await prisma.item.findUnique({
    where: { id: itemId },
    include: { source: true },
  });

  if (!item) {
    throw new Error("Item not found");
  }

  const previousClusterId = item.clusterId;

  await prisma.item.delete({
    where: { id: item.id },
  });

  if (previousClusterId) {
    await recomputeCluster(previousClusterId, options?.aiProvider);
  }

  invalidateFeedCache();

  return {
    id: item.id,
    previousClusterId,
  };
}

type ItemReanalyzeOutcome = {
  item: Item & { source: { name: string } };
  failedFields: Array<"summary" | "analysis" | "aggregation">;
};


async function syncItemProcessingRetryState(itemId: string) {
  const item = await prisma.item.findUnique({
    where: { id: itemId },
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
        },
      },
    },
  });
  if (!item) {
    return;
  }

  const reasons = classifyItemProcessingRecoveryReasons({
    ...item,
    hasActiveSplitChildren: item._count.aggregationSplitChildren > 0,
  });
  if (reasons.length === 0) {
    await clearItemProcessingRetryState(itemId);
    return;
  }

  await scheduleItemProcessingRetry({
    itemId,
    reasons,
    attemptCount: item.processingAttemptCount,
  });
}

export async function reanalyzeItem(itemId: string, options?: RegenerationOptions): Promise<ItemReanalyzeOutcome> {
  const item = await prisma.item.findUnique({
    where: { id: itemId },
    include: {
      _count: {
        select: {
          aggregationSplitChildren: true,
        },
      },
      source: true,
    },
  });

  if (!item) {
    throw new Error("Item not found");
  }

  const hasActiveSplitChildren = item._count.aggregationSplitChildren > 0;
  const aiProvider = await resolveAiProvider(options?.aiProvider);
  const understanding = await resolveItemUnderstanding(aiProvider, item);
  const summaryText = understanding.diagnostics.summaryValid
    ? understanding.summary
    : item.summaryText;
  const previousClusterId = item.clusterId;
  const aggregationDetectionEnabled = item.source.aggregationDetectionEnabled === true;
  const failedFields: ItemReanalyzeOutcome["failedFields"] = [
    ...(!understanding.diagnostics.summaryValid ? ["summary" as const] : []),
    ...(!understanding.diagnostics.analysisValid ? ["analysis" as const] : []),
    ...(aggregationDetectionEnabled && !understanding.diagnostics.aggregationValid
      ? ["aggregation" as const]
      : []),
  ];
  const candidate: AggregationReparseCandidate = {
    id: item.id,
    sourceId: item.sourceId,
    originalTitle: item.originalTitle,
    originalUrl: item.originalUrl,
    clusterId: item.clusterId,
    publishedAt: item.publishedAt,
    publishedAtKnown: item.publishedAtKnown,
    fullText: item.fullText,
    rssContent: item.rssContent,
    rssExcerpt: item.rssExcerpt,
    source: { name: item.source.name },
  };
  const affectedClusterIds = new Set<string>();
  if (previousClusterId) {
    affectedClusterIds.add(previousClusterId);
  }

  const moderationStatus = understanding.moderationStatus === "restored"
    ? "allowed"
    : understanding.moderationStatus;
  const analysisStatus = understanding.diagnostics.analysisValid ? "succeeded" : "failed";
  const summaryStatus = understanding.diagnostics.summaryValid ? "succeeded" : "failed";
  const aggregationIsValid = aggregationDetectionEnabled && understanding.diagnostics.aggregationValid;

  if (!understanding.diagnostics.analysisValid || (aggregationDetectionEnabled && !understanding.diagnostics.aggregationValid)) {
    const aggregationInvalid =
      aggregationDetectionEnabled && !understanding.diagnostics.aggregationValid;
    // An aggregation parent with live split children keeps its split even when
    // this understanding attempt fails to confirm the aggregation.
    const preserveSplit = aggregationInvalid && hasActiveSplitChildren;
    const updated = await prisma.item.update({
      where: { id: item.id },
      data: {
        summaryText,
        summaryStatus,
        ...(!understanding.diagnostics.analysisValid
          ? { analysisStatus: "failed" as const, aiProcessedAt: null }
          : {}),
        ...(aggregationInvalid
          ? {
              aggregationCheckedAt: new Date(),
              ...(preserveSplit
                ? {}
                : { aggregationParseStatus: AGGREGATION_PARSE_STATUS.failed }),
            }
          : {}),
        errorMessage: preserveSplit
          ? `统一条目理解部分字段无效：${failedFields.join(", ")}（聚合解析未确认，保留现有拆分）`
          : `统一条目理解部分字段无效：${failedFields.join(", ")}`,
      },
      include: { source: true },
    });

    if (previousClusterId && understanding.diagnostics.summaryValid) {
      await recomputeCluster(previousClusterId, aiProvider);
    }
    invalidateFeedCache();
    await syncItemProcessingRetryState(item.id);

    return { item: updated, failedFields };
  }

  const isAggregation = Boolean(
    aggregationIsValid &&
    moderationStatus !== "filtered" &&
    understanding.aggregation.isAggregation,
  );
  let regularAggregationParseStatus = aggregationIsValid
    ? AGGREGATION_PARSE_STATUS.notAggregation
    : AGGREGATION_PARSE_STATUS.failed;

  if (isAggregation) {
    await prisma.item.update({
      where: { id: item.id },
      data: {
        translatedTitle:
          shouldTranslateTitle(item.originalTitle)
            ? understanding.translatedTitle?.trim() || item.originalTitle
            : item.translatedTitle,
        summaryText,
        summaryStatus,
        analysisStatus,
        status: "processed",
        moderationStatus,
        moderationReason: understanding.moderationReason,
        moderationDetail: understanding.moderationDetail,
        qualityScore: understanding.qualityScore,
        qualityRationale: understanding.qualityRationale,
        ...serializeEventSignature(understanding.eventSignature),
        isAggregation: true,
        aggregationCheckedAt: new Date(),
        aggregationParseStatus: AGGREGATION_PARSE_STATUS.detected,
        aiProcessedAt: analysisStatus === "succeeded" ? new Date() : null,
        clusterId: null,
        manualClusterAssignedAt: null,
        errorMessage: null,
      },
    });
    await replaceItemEntitiesSafely(item.id, []);

    const reparseResult = await reparseAggregationCandidate(candidate, {
      aiProvider,
      retireExistingChildrenOnNotAggregation: false,
      retireExistingChildrenOnFailure: false,
      trackRetiredChildClusters: true,
      understanding,
    });

    if (reparseResult.status === "parsed") {
      for (const clusterId of reparseResult.affectedClusterIds) {
        await recomputeCluster(clusterId, aiProvider);
      }

      invalidateFeedCache();
      invalidateDailyReportCache();

      const updated = await prisma.item.findUniqueOrThrow({
        where: { id: item.id },
        include: { source: true },
      });
      await syncItemProcessingRetryState(item.id);
      return { item: updated, failedFields };
    }

    if (reparseResult.status === "failed") {
      invalidateFeedCache();
      invalidateDailyReportCache();
      if (hasActiveSplitChildren) {
        // The pre-reparse update marked the parent "detected"; when the re-split
        // itself fails, the existing children are still the active split, so
        // keep the parse state truthful instead of leaving it stuck retriable.
        await prisma.item.update({
          where: { id: item.id },
          data: {
            aggregationParseStatus: AGGREGATION_PARSE_STATUS.parsed,
          },
        });
      }
      const updated = await prisma.item.findUniqueOrThrow({
        where: { id: item.id },
        include: { source: true },
      });
      await syncItemProcessingRetryState(item.id);
      return { item: updated, failedFields: [...failedFields, "aggregation"] };
    }

    for (const clusterId of reparseResult.affectedClusterIds) {
      affectedClusterIds.add(clusterId);
    }
    regularAggregationParseStatus = AGGREGATION_PARSE_STATUS.notAggregation;
  }

  if (hasActiveSplitChildren && !isAggregation) {
    // New understanding did not confirm aggregation: keep the existing split
    // children and parse state instead of retiring them, and only refresh the
    // content fields that are still valid.
    const nextStatus = moderationStatus === "filtered" ? "filtered" : "processed";
    const updated = await prisma.item.update({
      where: { id: item.id },
      data: {
        translatedTitle:
          shouldTranslateTitle(item.originalTitle)
            ? understanding.translatedTitle?.trim() || item.originalTitle
            : item.translatedTitle,
        summaryText,
        summaryStatus,
        analysisStatus,
        moderationStatus,
        moderationReason: understanding.moderationReason,
        moderationDetail: understanding.moderationDetail,
        qualityScore: understanding.qualityScore,
        qualityRationale: understanding.qualityRationale,
        ...serializeEventSignature(understanding.eventSignature),
        aiProcessedAt: analysisStatus === "succeeded" ? new Date() : null,
        status: nextStatus,
        aggregationCheckedAt: aggregationDetectionEnabled ? new Date() : null,
        errorMessage: "统一条目理解未确认聚合，保留现有拆分",
      },
      include: { source: true },
    });
    await replaceItemEntitiesSafely(updated.id, []);
    invalidateFeedCache();
    await syncItemProcessingRetryState(item.id);

    return { item: updated, failedFields };
  }

  const nextStatus = moderationStatus === "filtered" ? "filtered" : "processed";
  const regularAggregationFields = aggregationDetectionEnabled
    ? {
        isAggregation: false,
        aggregationCheckedAt: new Date(),
        aggregationParseStatus: regularAggregationParseStatus,
      }
    : {
        isAggregation: false,
        aggregationCheckedAt: null,
        aggregationParseStatus: null,
      };

  const updated = await prisma.item.update({
    where: { id: item.id },
    data: {
      translatedTitle:
        shouldTranslateTitle(item.originalTitle)
          ? understanding.translatedTitle?.trim() || item.originalTitle
          : item.translatedTitle,
      summaryText,
      summaryStatus,
      analysisStatus,
      moderationStatus,
      moderationReason: understanding.moderationReason,
      moderationDetail: understanding.moderationDetail,
      qualityScore: understanding.qualityScore,
      qualityRationale: understanding.qualityRationale,
      ...serializeEventSignature(understanding.eventSignature),
      aiProcessedAt: analysisStatus === "succeeded" ? new Date() : null,
      status: nextStatus,
      clusterId: null,
      manualClusterAssignedAt: null,
      errorMessage: null,
      ...regularAggregationFields,
    },
    include: { source: true },
  });
  await replaceItemEntitiesSafely(
    updated.id,
    nextStatus === "processed" && analysisStatus === "succeeded"
      ? getItemEntityNamesFromEvent(understanding.eventSignature)
      : [],
  );

  if (aggregationDetectionEnabled || item.isAggregation) {
    for (const clusterId of await collectAggregationChildClusterIds(item.id)) {
      affectedClusterIds.add(clusterId);
    }
    await retireAggregationChildItems(item.id);
  }

  if (moderationStatus === "filtered") {
    if (previousClusterId) {
      affectedClusterIds.add(previousClusterId);
    }
  } else {
    const assignment = await assignItemToCluster(updated.id, {
      eventSignature: understanding.eventSignature,
      aiProvider,
    });
    if (assignment.clusterId) {
      affectedClusterIds.add(assignment.clusterId);
    }
  }

  for (const clusterId of affectedClusterIds) {
    await recomputeCluster(clusterId, aiProvider);
  }

  invalidateFeedCache();
  if (aggregationDetectionEnabled || item.isAggregation) {
    invalidateDailyReportCache();
  }

  const result = await prisma.item.findUniqueOrThrow({
    where: { id: updated.id },
    include: { source: true },
  });
  await syncItemProcessingRetryState(result.id);
  return { item: result, failedFields };
}

export async function executeItemReanalyzeTask(
  taskRun: { id: string; entityId: string | null },
  options?: RegenerationOptions,
) {
  if (!taskRun.entityId) {
    throw new Error("Task entityId is required.");
  }

  // One unified understanding call rewrites summary, analysis, and aggregation.
  // Cluster summaries remain downstream and are tracked separately.
  const aiUsage = createTaskAiUsageTracker(1, "item_understanding");
  aiUsage.addEstimated(2, "cluster_summary");
  const trackedAiProvider = aiUsage.wrapProvider(
    await resolveAiProvider(options?.aiProvider, {
      onUsage: (usage, usageKey) => aiUsage.addUsageByKey(usageKey, usage),
    }),
    { understandItemEstimated: false },
  );
  const initialAiUsage = aiUsage.snapshot();

  await updateTaskRun(taskRun.id, {
    status: "running",
    progressLabel: "正在重新 AI 判定",
    aiCallCountActual: 0,
    aiCallCountEstimated: initialAiUsage.estimated,
    aiCallBreakdown: initialAiUsage.breakdown,
  });

  try {
    const outcome = await reanalyzeItem(taskRun.entityId, {
      ...options,
      aiProvider: trackedAiProvider,
    });
    const completionLabel = await buildItemReanalyzeCompletionLabel(outcome.item);
    const isPartial = outcome.failedFields.length > 0;

    await updateTaskRun(taskRun.id, {
      status: isPartial ? "partial" : "succeeded",
      progressCurrent: 1,
      progressTotal: 1,
      progressLabel: isPartial
        ? `${completionLabel}（部分字段失败：${outcome.failedFields.join(", ")}）`
        : completionLabel,
      aiCallCountActual: aiUsage.snapshot().actual,
      aiCallCountEstimated: aiUsage.snapshot().estimated,
      aiCallBreakdown: aiUsage.snapshot().breakdown,
      finishedAt: new Date(),
      errorSummary: isPartial ? `统一条目理解部分字段无效：${outcome.failedFields.join(", ")}` : null,
    });

    return outcome.item;
  } catch (error) {
    await updateTaskRun(taskRun.id, {
      status: "failed",
      progressCurrent: 1,
      progressTotal: 1,
      progressLabel: "重新 AI 判定失败",
      aiCallCountActual: aiUsage.snapshot().actual,
      aiCallCountEstimated: aiUsage.snapshot().estimated,
      aiCallBreakdown: aiUsage.snapshot().breakdown,
      finishedAt: new Date(),
      errorSummary: error instanceof Error ? error.message : "Unknown item reanalyze error",
    });
    throw error;
  }
}

const CLEANUP_BATCH_SIZE = 5000;
const REPARSE_AGGREGATIONS_BATCH_SIZE = 200;
const REPARSE_AGGREGATIONS_MIN_TEXT_CHARS = 40;
const REPARSE_AGGREGATIONS_PROGRESS_UPDATE_INTERVAL = 10;

export async function executeItemCleanupTask(taskRun: BackgroundTaskRun) {
  const schedule = await ensureDefaultItemCleanupSchedule();
  const retentionDays = schedule.cleanupRetentionDays;
  const now = new Date();
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

  // Cooperative cancellation check before starting
  if (await isTaskRunCancellationRequested(taskRun.id)) {
    await updateTaskRun(taskRun.id, {
      status: "cancelled",
      progressLabel: TASK_RUN_CANCELLED_LABEL,
      errorSummary: TASK_RUN_CANCELLED_MESSAGE,
      finishedAt: now,
    });
    return;
  }

  await updateTaskRun(taskRun.id, {
    status: "running",
    progressLabel: "正在查找过期文章...",
  });

  // Find affected cluster IDs before deleting
  const itemsToClean = await prisma.item.findMany({
    where: { createdAt: { lt: cutoff } },
    select: { clusterId: true },
  });
  const affectedClusterIds = [...new Set(itemsToClean.map((i) => i.clusterId).filter(Boolean))] as string[];

  // Estimate total count for progress tracking (snapshot before deletion)
  const estimatedTotal = itemsToClean.length;
  let totalDeleted = 0;

  // Batch delete old items to avoid long SQLite write locks.
  // Prisma's deleteMany doesn't support LIMIT, so we batch by IDs.
  while (true) {
    if (await isTaskRunCancellationRequested(taskRun.id)) {
      await updateTaskRun(taskRun.id, {
        status: "cancelled",
        progressCurrent: totalDeleted,
        progressTotal: estimatedTotal,
        progressLabel: TASK_RUN_CANCELLED_LABEL,
        errorSummary: TASK_RUN_CANCELLED_MESSAGE,
        finishedAt: new Date(),
      });
      invalidateFeedCache();
      return;
    }

    const batchItems = await prisma.item.findMany({
      where: { createdAt: { lt: cutoff } },
      include: {
        source: {
          select: { name: true },
        },
      },
      take: CLEANUP_BATCH_SIZE,
    });

    if (batchItems.length === 0) {
      break;
    }

    await archiveItemDedupeHistories(batchItems, now);

    const deleted = await prisma.item.deleteMany({
      where: { id: { in: batchItems.map((i) => i.id) } },
    });

    totalDeleted += deleted.count;

    await updateTaskRun(taskRun.id, {
      progressCurrent: totalDeleted,
      progressTotal: estimatedTotal,
      progressLabel: `已清理 ${totalDeleted}/${estimatedTotal} 篇文章...`,
    });
  }

  // Recompute affected clusters (empty ones will be auto-deleted)
  for (const clusterId of affectedClusterIds) {
    if (await isTaskRunCancellationRequested(taskRun.id)) {
      await updateTaskRun(taskRun.id, {
        status: "cancelled",
        progressCurrent: totalDeleted,
        progressTotal: totalDeleted,
        progressLabel: TASK_RUN_CANCELLED_LABEL,
        errorSummary: TASK_RUN_CANCELLED_MESSAGE,
        finishedAt: new Date(),
      });
      return;
    }

    await recomputeCluster(clusterId);
  }

  invalidateFeedCache();

  await updateTaskRun(taskRun.id, {
    status: "succeeded",
    progressCurrent: totalDeleted,
    progressTotal: totalDeleted,
    progressLabel: `已清理 ${totalDeleted} 篇文章，涉及 ${affectedClusterIds.length} 个聚合`,
    finishedAt: new Date(),
  });
}


function serializeParsedEventSignature(input: {
  eventType?: string | null;
  eventSubject?: string | null;
  eventAction?: string | null;
  eventObject?: string | null;
  eventDate?: string | null;
} | null | undefined): AiEventSignature | null {
  if (!input) {
    return null;
  }
  return {
    eventType: normalizeStoredEventType(input.eventType ?? null),
    eventSubject: input.eventSubject ?? null,
    eventAction: input.eventAction ?? null,
    eventObject: input.eventObject ?? null,
    eventDate: input.eventDate ?? null,
  };
}

function isCompleteParsedAggregation(
  parsed: ItemUnderstandingResult["aggregation"] | null | undefined,
): parsed is ItemUnderstandingResult["aggregation"] & {
  events: Array<AiEventSignature & { oneLiner: string; qualityScore: number }>;
} {
  return Boolean(parsed && parsed.events && parsed.events.length > 0);
}

async function collectAggregationChildClusterIds(parentItemId: string) {
  const [linkedChildren, legacyChildren] = await Promise.all([
    prisma.aggregationSplitLink.findMany({
      where: { parentItemId },
      select: {
        child: {
          select: {
            clusterId: true,
          },
        },
      },
    }),
    prisma.item.findMany({
      where: { parentItemId },
      select: { clusterId: true },
    }),
  ]);

  return [
    ...linkedChildren.map((link) => link.child.clusterId),
    ...legacyChildren.map((child) => child.clusterId),
  ].filter((clusterId): clusterId is string => Boolean(clusterId));
}

async function markAggregationCandidateNotAggregation(
  candidate: AggregationReparseCandidate,
  options?: { retireExistingChildren?: boolean },
) {
  const affectedClusterIds = new Set<string>();
  if (candidate.clusterId) {
    affectedClusterIds.add(candidate.clusterId);
  }

  if (options?.retireExistingChildren) {
    for (const clusterId of await collectAggregationChildClusterIds(candidate.id)) {
      affectedClusterIds.add(clusterId);
    }
    await retireAggregationChildItems(candidate.id);
  }

  await prisma.item.update({
    where: { id: candidate.id },
    data: {
      isAggregation: false,
      aggregationCheckedAt: new Date(),
      aggregationParseStatus: AGGREGATION_PARSE_STATUS.notAggregation,
    },
  });

  return affectedClusterIds;
}

async function reparseAggregationCandidate(
  candidate: AggregationReparseCandidate,
  options: {
    aiProvider: AiProvider;
    retireExistingChildrenOnNotAggregation?: boolean;
    retireExistingChildrenOnFailure?: boolean;
    trackRetiredChildClusters?: boolean;
    understanding?: ItemUnderstandingResult;
  },
): Promise<AggregationReparseResult> {
  const affectedClusterIds = new Set<string>();
  if (candidate.clusterId) {
    affectedClusterIds.add(candidate.clusterId);
  }

  const understandingInput = buildItemUnderstandingInput({
    fullText: candidate.fullText,
    rssContent: candidate.rssContent,
    rssExcerpt: candidate.rssExcerpt,
    originalTitle: candidate.originalTitle,
  });

  if (understandingInput.length < REPARSE_AGGREGATIONS_MIN_TEXT_CHARS) {
    const retiredClusterIds = await markAggregationCandidateNotAggregation(candidate, {
      retireExistingChildren: options.retireExistingChildrenOnNotAggregation,
    });
    for (const clusterId of retiredClusterIds) {
      affectedClusterIds.add(clusterId);
    }
    return {
      status: "not_aggregation",
      childItemIds: [],
      affectedClusterIds,
      errorMessage: null,
    };
  }

  try {
    const understanding = options.understanding ?? await options.aiProvider.understandItem(
      understandingInput,
      {
        title: candidate.originalTitle,
        sourceName: candidate.source.name,
        translateTitle: shouldTranslateTitle(candidate.originalTitle),
      },
    );
    if (!understanding.diagnostics.aggregationValid) {
      throw new Error("Unified item understanding returned an invalid aggregation result");
    }
    const parsedAggregation = understanding.aggregation;

    if (!isCompleteParsedAggregation(parsedAggregation)) {
      const retiredClusterIds = await markAggregationCandidateNotAggregation(candidate, {
        retireExistingChildren: options.retireExistingChildrenOnNotAggregation,
      });
      for (const clusterId of retiredClusterIds) {
        affectedClusterIds.add(clusterId);
      }
      return {
        status: "not_aggregation",
        childItemIds: [],
        affectedClusterIds,
        errorMessage: null,
      };
    }

    if (options.trackRetiredChildClusters) {
      for (const clusterId of await collectAggregationChildClusterIds(candidate.id)) {
        affectedClusterIds.add(clusterId);
      }
    }
    await retireAggregationChildItems(candidate.id);

    const { childItemIds } = await persistAggregationChildItems({
      sourceId: candidate.sourceId,
      parent: {
        id: candidate.id,
        originalUrl: candidate.originalUrl,
        originalTitle: candidate.originalTitle,
      },
      publishedAt: candidate.publishedAt,
      publishedAtKnown: candidate.publishedAtKnown,
      events: parsedAggregation.events.map((event) => ({
        eventType: event.eventType,
        eventSubject: event.eventSubject,
        eventAction: event.eventAction,
        eventObject: event.eventObject,
        eventDate: event.eventDate,
        title: event.title,
        oneLiner: event.oneLiner,
        qualityScore: event.qualityScore,
        sourceUrl: event.sourceUrl,
      })),
    });

    for (const childId of childItemIds) {
      try {
        const assignment = await assignItemToCluster(childId, {
          aiProvider: options.aiProvider,
          aggregationEnabled: true,
        });
        if (assignment.clusterId) {
          affectedClusterIds.add(assignment.clusterId);
        }
      } catch (assignError) {
        console.error(`[Item Reparse] cluster assignment failed for ${childId}:`, assignError);
      }
    }

    const mainEvent = serializeParsedEventSignature(parsedAggregation.mainEvent);
    await prisma.item.update({
      where: { id: candidate.id },
      data: {
        isAggregation: true,
        aggregationCheckedAt: new Date(),
        aggregationParseStatus: AGGREGATION_PARSE_STATUS.parsed,
        eventType: mainEvent?.eventType ?? null,
        eventSubject: mainEvent?.eventSubject ?? null,
        eventAction: mainEvent?.eventAction ?? null,
        eventObject: mainEvent?.eventObject ?? null,
        eventDate: mainEvent?.eventDate ?? null,
        clusterId: null,
        manualClusterAssignedAt: null,
        qualityScore: Math.max(...parsedAggregation.events.map((event) => event.qualityScore)),
        qualityRationale: "聚合内容重拆后取主事件签名",
        aiProcessedAt: new Date(),
      },
    });

    return {
      status: "parsed",
      childItemIds,
      affectedClusterIds,
      errorMessage: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown reparse error";

    if (options.retireExistingChildrenOnFailure) {
      for (const clusterId of await collectAggregationChildClusterIds(candidate.id)) {
        affectedClusterIds.add(clusterId);
      }
      await retireAggregationChildItems(candidate.id);
    }

    await prisma.item.update({
      where: { id: candidate.id },
      data: {
        aggregationCheckedAt: new Date(),
        aggregationParseStatus: AGGREGATION_PARSE_STATUS.failed,
      },
    });

    return {
      status: "failed",
      childItemIds: [],
      affectedClusterIds,
      errorMessage: message,
    };
  }
}

function shouldWriteReparseProgress(processedCount: number, totalCandidates: number) {
  return processedCount === totalCandidates ||
    processedCount % REPARSE_AGGREGATIONS_PROGRESS_UPDATE_INTERVAL === 0;
}

/**
 * Backfill task that re-runs unified item understanding for items from sources
 * opted into aggregation detection. Selects items where the source has
 * aggregationDetectionEnabled=true, the item has not been checked or is in a
 * retriable parse state, and useful source text is available.
 */
export async function executeItemReparseAggregationsTask(
  taskRun: { id: string; entityId?: string | null },
  options?: RegenerationOptions,
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

  const candidates = await prisma.item.findMany({
    where: {
      status: "processed",
      OR: [
        {
          isAggregation: false,
          aggregationParseStatus: null,
        },
        {
          aggregationParseStatus: { in: RETRIABLE_AGGREGATION_PARSE_STATUSES },
        },
      ],
      AND: [
        {
          OR: [
            { fullText: { not: null } },
            { rssContent: { not: null } },
            { rssExcerpt: { not: null } },
          ],
        },
      ],
      source: { is: { aggregationDetectionEnabled: true, enabled: true } },
    },
    select: {
      id: true,
      sourceId: true,
      originalTitle: true,
      originalUrl: true,
      clusterId: true,
      publishedAt: true,
      publishedAtKnown: true,
      fullText: true,
      rssContent: true,
      rssExcerpt: true,
      source: { select: { name: true } },
    },
    orderBy: { publishedAt: "desc" },
    take: REPARSE_AGGREGATIONS_BATCH_SIZE,
  });

  const totalCandidates = candidates.length;
  if (totalCandidates === 0) {
    await updateTaskRun(taskRun.id, {
      status: "succeeded",
      progressCurrent: 0,
      progressTotal: 0,
      progressLabel: "无需重拆的聚合内容",
      finishedAt: new Date(),
    });
    return;
  }

  const aiUsage = createTaskAiUsageTracker(totalCandidates, "item_understanding");
  const aiProvider = await resolveAiProvider(options?.aiProvider, {
    onUsage: (usage, usageKey) => aiUsage.addUsageByKey(usageKey, usage),
  });
  const trackedAiProvider = aiUsage.wrapProvider(aiProvider);
  const initialAiUsage = aiUsage.snapshot();

  await updateTaskRun(taskRun.id, {
    status: "running",
    progressCurrent: 0,
    progressTotal: totalCandidates,
    progressLabel: `开始重拆 ${totalCandidates} 条聚合内容`,
    aiCallCountActual: 0,
    aiCallCountEstimated: initialAiUsage.estimated,
    aiCallBreakdown: initialAiUsage.breakdown,
  });

  let processedCount = 0;
  let reparsedCount = 0;
  const affectedClusterIds = new Set<string>();
  const issues: string[] = [];

  for (const candidate of candidates) {
    if (await isTaskRunCancellationRequested(taskRun.id)) {
      await updateTaskRun(taskRun.id, {
        status: "cancelled",
        progressCurrent: processedCount,
        progressTotal: totalCandidates,
        progressLabel: TASK_RUN_CANCELLED_LABEL,
        errorSummary: TASK_RUN_CANCELLED_MESSAGE,
        finishedAt: new Date(),
      });
      return;
    }

    processedCount += 1;
    const reparseResult = await reparseAggregationCandidate(candidate, {
      aiProvider: trackedAiProvider,
    });

    if (reparseResult.status === "parsed") {
      reparsedCount += 1;
    } else if (reparseResult.status === "failed") {
      const message = reparseResult.errorMessage ?? "Unknown reparse error";
      issues.push(`${candidate.id}: ${message}`);
      console.error(`[Item Reparse] Failed for ${candidate.id}:`, message);
    }

    for (const clusterId of reparseResult.affectedClusterIds) {
      affectedClusterIds.add(clusterId);
    }

    if (shouldWriteReparseProgress(processedCount, totalCandidates)) {
      await updateTaskRun(taskRun.id, {
        progressCurrent: processedCount,
        progressTotal: totalCandidates,
        progressLabel: `已扫描 ${processedCount}/${totalCandidates} 条，识别 ${reparsedCount} 条聚合`,
      });
    }
  }

  for (const clusterId of affectedClusterIds) {
    if (await isTaskRunCancellationRequested(taskRun.id)) {
      await updateTaskRun(taskRun.id, {
        status: "cancelled",
        progressCurrent: processedCount,
        progressTotal: totalCandidates,
        progressLabel: TASK_RUN_CANCELLED_LABEL,
        errorSummary: TASK_RUN_CANCELLED_MESSAGE,
        finishedAt: new Date(),
      });
      return;
    }
    await recomputeCluster(clusterId, trackedAiProvider);
  }

  if (reparsedCount > 0) {
    invalidateFeedCache();
    invalidateDailyReportCache();
  }

  const finalStatus =
    issues.length > 0 && reparsedCount === 0
      ? "failed"
      : issues.length > 0
        ? "partial"
        : "succeeded";
  await updateTaskRun(taskRun.id, {
    status: finalStatus,
    progressCurrent: processedCount,
    progressTotal: totalCandidates,
    progressLabel: `聚合重拆完成，识别 ${reparsedCount} 条聚合${issues.length > 0 ? `，${issues.length} 条失败` : ""}`,
    aiCallCountActual: aiUsage.snapshot().actual,
    aiCallCountEstimated: aiUsage.snapshot().estimated,
    aiCallBreakdown: aiUsage.snapshot().breakdown,
    errorSummary: issues.length > 0 ? issues.slice(0, 5).join("; ") : null,
    finishedAt: new Date(),
  });
}
