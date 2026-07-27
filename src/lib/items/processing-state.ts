import {
  ITEM_PROCESSING_RECOVERY_BASE_DELAY_MS,
  ITEM_PROCESSING_RECOVERY_MAX_ATTEMPTS,
  ITEM_PROCESSING_RECOVERY_MAX_DELAY_MS,
} from "@/config/constants";
import type { AiEventSignature } from "@/lib/ai/provider";
import {
  AGGREGATION_PARSE_STATUS,
  RETRIABLE_AGGREGATION_PARSE_STATUSES,
} from "@/lib/aggregation/status";
import { hasCompleteClusterMatchSignature } from "@/lib/clusters/helpers";
import { prisma } from "@/lib/db";

export type ItemProcessingRecoveryReason =
  | "summary_failed"
  | "analysis_failed"
  | "aggregation_retriable"
  | "incomplete_signature";

export function computeItemProcessingRetryAt(attemptCount: number, now = new Date()) {
  const exponent = Math.max(0, attemptCount - 1);
  const delayMs = Math.min(
    ITEM_PROCESSING_RECOVERY_MAX_DELAY_MS,
    ITEM_PROCESSING_RECOVERY_BASE_DELAY_MS * 2 ** exponent,
  );
  return new Date(now.getTime() + delayMs);
}

export function buildEventSignatureFromItemFields(item: {
  eventType?: string | null;
  eventSubject?: string | null;
  eventAction?: string | null;
  eventObject?: string | null;
  eventDate?: string | null;
}): AiEventSignature {
  return {
    eventType: (item.eventType as AiEventSignature["eventType"]) ?? null,
    eventSubject: item.eventSubject ?? null,
    eventAction: item.eventAction ?? null,
    eventObject: item.eventObject ?? null,
    eventDate: item.eventDate ?? null,
  };
}

export function classifyItemProcessingRecoveryReasons(item: {
  status?: string | null;
  moderationStatus?: string | null;
  summaryStatus?: string | null;
  analysisStatus?: string | null;
  isAggregation?: boolean | null;
  aggregationParseStatus?: string | null;
  eventType?: string | null;
  eventSubject?: string | null;
  eventAction?: string | null;
  eventObject?: string | null;
  eventDate?: string | null;
  source?: {
    aiParsingEnabled?: boolean | null;
    aggregationDetectionEnabled?: boolean | null;
  } | null;
}): ItemProcessingRecoveryReason[] {
  const reasons: ItemProcessingRecoveryReason[] = [];
  const aiParsingEnabled = item.source?.aiParsingEnabled !== false;
  const aggregationDetectionEnabled = Boolean(item.source?.aggregationDetectionEnabled);
  const isDisplayable =
    item.status === "processed" &&
    (item.moderationStatus === "allowed" || item.moderationStatus === "restored");

  if (!isDisplayable) {
    return reasons;
  }

  if (aiParsingEnabled && item.summaryStatus === "failed") {
    reasons.push("summary_failed");
  }

  if (aiParsingEnabled && item.analysisStatus === "failed") {
    reasons.push("analysis_failed");
  }

  if (
    aggregationDetectionEnabled &&
    item.aggregationParseStatus &&
    (RETRIABLE_AGGREGATION_PARSE_STATUSES as readonly string[]).includes(item.aggregationParseStatus)
  ) {
    reasons.push("aggregation_retriable");
  }

  if (
    aiParsingEnabled &&
    item.analysisStatus === "succeeded" &&
    item.summaryStatus !== "failed" &&
    !item.isAggregation &&
    !(
      item.aggregationParseStatus &&
      (RETRIABLE_AGGREGATION_PARSE_STATUSES as readonly string[]).includes(item.aggregationParseStatus)
    ) &&
    !hasCompleteClusterMatchSignature(buildEventSignatureFromItemFields(item))
  ) {
    reasons.push("incomplete_signature");
  }

  return reasons;
}

export async function clearItemProcessingRetryState(itemId: string) {
  await prisma.item.update({
    where: { id: itemId },
    data: {
      processingAttemptCount: 0,
      nextProcessingRetryAt: null,
      lastProcessingError: null,
    },
  });
}

export async function scheduleItemProcessingRetry(input: {
  itemId: string;
  reasons: Array<ItemProcessingRecoveryReason | string>;
  attemptCount?: number;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const current =
    input.attemptCount == null
      ? await prisma.item.findUnique({
          where: { id: input.itemId },
          select: { processingAttemptCount: true },
        })
      : { processingAttemptCount: input.attemptCount };

  const nextAttemptCount = (current?.processingAttemptCount ?? 0) + 1;
  const exhausted = nextAttemptCount >= ITEM_PROCESSING_RECOVERY_MAX_ATTEMPTS;

  await prisma.item.update({
    where: { id: input.itemId },
    data: {
      processingAttemptCount: nextAttemptCount,
      nextProcessingRetryAt: exhausted ? null : computeItemProcessingRetryAt(nextAttemptCount, now),
      lastProcessingError: input.reasons.join(","),
    },
  });

  return {
    attemptCount: nextAttemptCount,
    exhausted,
  };
}

export async function degradeExhaustedAggregationItem(itemId: string, reason: string) {
  const existingChildren = await prisma.item.count({
    where: {
      parentItemId: itemId,
      status: "processed",
      moderationStatus: { in: ["allowed", "restored"] },
    },
  });

  if (existingChildren > 0) {
    await prisma.item.update({
      where: { id: itemId },
      data: {
        aggregationParseStatus: AGGREGATION_PARSE_STATUS.failed,
        nextProcessingRetryAt: null,
        lastProcessingError: reason,
      },
    });
    return { degradedToRegular: false as const };
  }

  await prisma.item.update({
    where: { id: itemId },
    data: {
      isAggregation: false,
      aggregationParseStatus: AGGREGATION_PARSE_STATUS.failed,
      nextProcessingRetryAt: null,
      lastProcessingError: reason,
    },
  });

  return { degradedToRegular: true as const };
}
