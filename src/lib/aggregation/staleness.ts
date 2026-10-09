import type { Item } from "@prisma/client";

import { prisma } from "@/lib/db";
import { invalidateFeedCache } from "@/lib/feed/cache";
import {
  evaluateStaleContent,
  STALE_CONTENT_MODERATION_REASON,
} from "@/lib/ingestion/staleness";

export type AggregationChildStalenessInput = Pick<
  Item,
  | "eventDate"
  | "publishedAt"
  | "publishedAtKnown"
  | "restoredByAdminAt"
  | "originalTitle"
  | "summaryText"
  | "rssContent"
  | "rssExcerpt"
  | "fullText"
> & {
  referenceAt?: Date;
  eventDateCutoff?: Date | null;
};

function hasCompleteEventDateEvidence(eventDate: string | null, evidence: string): boolean {
  const parts = eventDate?.match(/^(20\d{2})-(\d{2})-(\d{2})$/);
  if (!parts) return false;
  const [, year, monthPart, dayPart] = parts;
  const month = String(Number(monthPart));
  const day = String(Number(dayPart));
  const datePattern = new RegExp(
    `(?:^|\\D)(?:${year}\\s*年\\s*0?${month}\\s*月\\s*0?${day}\\s*日|${year}\\s*[-/]\\s*0?${month}\\s*[-/]\\s*0?${day})(?!\\d)`,
  );
  return datePattern.test(evidence);
}

/** Use only child-owned text, and require its complete event date before stale filtering. */
export function evaluateAggregationChildStaleness(input: AggregationChildStalenessInput) {
  const childEvidence = [
    input.originalTitle,
    input.summaryText,
    input.rssContent,
    input.rssExcerpt,
    input.fullText,
  ].filter(Boolean).join("\n");
  return evaluateStaleContent({
    eventDate: input.eventDate,
    publishedAt: input.publishedAt,
    publishedAtKnown: input.publishedAtKnown,
    restoredByAdminAt: input.restoredByAdminAt,
    referenceAt: input.referenceAt,
    eventDateCutoff: input.eventDateCutoff,
    contentText: hasCompleteEventDateEvidence(input.eventDate, childEvidence) ? childEvidence : "",
  });
}

const childStalenessSelect = {
  id: true,
  eventDate: true,
  publishedAt: true,
  publishedAtKnown: true,
  restoredByAdminAt: true,
  originalTitle: true,
  summaryText: true,
  rssContent: true,
  rssExcerpt: true,
  fullText: true,
  status: true,
  moderationStatus: true,
  filterReason: true,
  clusterId: true,
} as const;

/** Filter only stale active split children, retaining other filter decisions and restored items. */
export async function filterStaleAggregationChildren({
  parentItemId,
  referenceAt = new Date(),
  eventDateCutoff,
}: {
  parentItemId: string;
  referenceAt?: Date;
  eventDateCutoff?: Date | null;
}): Promise<{ clusterIds: string[]; filteredCount: number }> {
  const result = await prisma.$transaction(async (tx) => {
    const [linked, legacy] = await Promise.all([
      tx.aggregationSplitLink.findMany({
        where: { parentItemId },
        select: { child: { select: childStalenessSelect } },
      }),
      tx.item.findMany({
        where: { parentItemId },
        select: childStalenessSelect,
      }),
    ]);
    const children = new Map<string, (typeof legacy)[number]>();
    for (const link of linked) children.set(link.child.id, link.child);
    for (const child of legacy) children.set(child.id, child);

    const affectedClusters = new Set<string>();
    let filteredCount = 0;
    for (const child of children.values()) {
      // Existing unrelated moderation/filter outcomes and administrator restores are authoritative.
      if (
        child.restoredByAdminAt ||
        child.moderationStatus === "restored" ||
        child.moderationStatus === "filtered" ||
        child.status === "filtered" ||
        (child.filterReason && child.filterReason !== "stale_event_content")
      ) continue;
      const result = evaluateAggregationChildStaleness({
        ...child,
        referenceAt,
        eventDateCutoff,
      });
      if (!result.stale) continue;

      const update = await tx.item.updateMany({
        where: {
          id: child.id,
          restoredByAdminAt: null,
          moderationStatus: { not: "filtered" },
          status: { not: "filtered" },
          OR: [{ filterReason: null }, { filterReason: "stale_event_content" }],
        },
        data: {
          status: "filtered",
          moderationStatus: "filtered",
          moderationReason: STALE_CONTENT_MODERATION_REASON,
          moderationDetail: result.detail,
          filterReason: result.reason,
        },
      });
      if (update.count > 0) {
        filteredCount += update.count;
        if (child.clusterId) affectedClusters.add(child.clusterId);
      }
    }
    return { clusterIds: [...affectedClusters], filteredCount };
  });

  if (result.filteredCount > 0) invalidateFeedCache();
  return result;
}
