import crypto from "node:crypto";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import {
  prepareItemTagReplacements,
  replacePreparedItemTagsInTransaction,
  type PreparedItemTagAssignment,
} from "@/lib/tags/service";

export type AggregationChildEventInput = {
  title?: string | null;
  oneLiner: string;
  qualityScore: number;
  eventType: string | null;
  eventSubject: string | null;
  eventAction: string | null;
  eventObject: string | null;
  eventDate: string | null;
  sourceUrl: string | null;
  tags?: unknown;
  fingerprint?: string | null;
};

type PrismaTransaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

function buildSemanticEventFingerprint(event: AggregationChildEventInput) {
  return crypto
    .createHash("sha256")
    .update(
      [
        event.eventType ?? "",
        event.eventSubject ?? "",
        event.eventAction ?? "",
        event.eventObject ?? "",
        event.eventDate ?? "",
      ]
        .join("|")
        .toLowerCase(),
    )
    .digest("hex");
}

function buildStableChildDedupeKey({
  sourceId,
  eventFingerprint,
  sourceUrl,
}: {
  sourceId: string;
  eventFingerprint: string;
  sourceUrl: string | null;
}) {
  if (sourceUrl && isSpecificContentUrl(sourceUrl)) {
    try {
      return `source-url:${normalizeUrlForComparison(sourceUrl)}`;
    } catch {
      return `source-url:${sourceUrl}`;
    }
  }

  return `semantic:${sourceId}|${eventFingerprint}`;
}

function buildAggregationChildItemInput({
  sourceId,
  parent,
  publishedAt,
  event,
}: {
  sourceId: string;
  parent: { id: string; originalUrl: string; originalTitle: string };
  publishedAt: Date;
  event: AggregationChildEventInput;
}): Prisma.ItemUncheckedCreateInput {
  const eventFingerprint = event.fingerprint ?? buildSemanticEventFingerprint(event);
  const normalizedSourceUrl = normalizeHttpUrl(event.sourceUrl);
  const normalizedParentUrl = normalizeHttpUrl(parent.originalUrl) ?? parent.originalUrl;
  const independentSourceUrl =
    normalizedSourceUrl &&
    isSpecificContentUrl(normalizedSourceUrl) &&
    !areEquivalentContentUrls(normalizedSourceUrl, normalizedParentUrl)
      ? normalizedSourceUrl
      : null;
  const displayUrl = independentSourceUrl ?? normalizedParentUrl;
  const stableChildKey = buildStableChildDedupeKey({
    sourceId,
    eventFingerprint,
    sourceUrl: independentSourceUrl,
  });
  const stableChildHash = crypto.createHash("sha256").update(stableChildKey).digest("hex");
  // Keep the user-facing URL as the best available article. Use a separate
  // internal key so urlHash stays stable even when a parent roundup changes.
  const childUrlKey = `${displayUrl}#event-${stableChildHash.slice(0, 32)}`;
  const urlHash = crypto.createHash("sha256").update(childUrlKey).digest("hex");
  const canonicalUrl = displayUrl.split("#")[0] ?? displayUrl;
  const childTitle =
    normalizeChildTitle(event.title) ||
    normalizeChildTitle(event.oneLiner) ||
    [event.eventSubject, event.eventAction, event.eventObject]
      .filter(Boolean)
      .join(" ")
      .slice(0, 200) ||
    parent.originalTitle;

  return {
    sourceId,
    parentItemId: parent.id,
    publishedAt,
    originalUrl: displayUrl,
    canonicalUrl,
    urlHash,
    originalTitle: childTitle,
    summaryText: event.oneLiner,
    summaryStatus: "succeeded",
    analysisStatus: "succeeded",
    moderationStatus: "allowed",
    moderationReason: null,
    moderationDetail: null,
    qualityScore: event.qualityScore,
    qualityRationale: "由聚合内容拆出",
    eventType: event.eventType,
    eventSubject: event.eventSubject,
    eventAction: event.eventAction,
    eventObject: event.eventObject,
    eventDate: event.eventDate,
    language: "zh",
    status: "processed",
    filterReason: null,
    aiProcessedAt: new Date(),
    isAggregation: false,
    aggregationCheckedAt: null,
    aggregationParseStatus: null,
    errorMessage: null,
  };
}

function normalizeHttpUrl(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function isSpecificContentUrl(value: string) {
  try {
    const parsed = new URL(value);
    const path = parsed.pathname.replace(/\/+$/, "");
    if (path && path !== "") {
      return true;
    }
    return parsed.search.length > 1;
  } catch {
    return false;
  }
}

function normalizeChildTitle(value: string | null | undefined) {
  const normalized = value
    ?.replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/[`_[\]()#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return null;
  }
  return normalized.slice(0, 120);
}

function normalizeUrlForComparison(value: string) {
  const parsed = new URL(value);
  parsed.hash = "";
  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = parsed.hostname.toLowerCase();
  if (parsed.pathname.length > 1) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  }
  return parsed.toString();
}

function areEquivalentContentUrls(left: string, right: string) {
  try {
    return normalizeUrlForComparison(left) === normalizeUrlForComparison(right);
  } catch {
    return left === right;
  }
}

async function upsertItemInTx(
  tx: PrismaTransaction,
  data: Prisma.ItemUncheckedCreateInput,
): Promise<{ id: string }> {
  if (!data.urlHash) {
    throw new Error("Aggregation child item missing urlHash");
  }
  const existing = await tx.item.findFirst({
    where: {
      urlHash: data.urlHash,
    },
    select: { id: true },
  });
  if (existing) {
    return tx.item.update({
      where: { id: existing.id },
      data: buildAggregationChildItemUpdateInput(data),
      select: { id: true },
    });
  }
  try {
    return await tx.item.create({ data, select: { id: true } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const conflict = await tx.item.findFirst({
        where: {
          urlHash: data.urlHash,
        },
        select: { id: true },
      });
      if (conflict) {
        return tx.item.update({
          where: { id: conflict.id },
          data: buildAggregationChildItemUpdateInput(data),
          select: { id: true },
        });
      }
    }
    throw error;
  }
}

function buildAggregationChildItemUpdateInput(
  data: Prisma.ItemUncheckedCreateInput,
): Prisma.ItemUncheckedUpdateInput {
  return {
    originalUrl: data.originalUrl,
    canonicalUrl: data.canonicalUrl,
    urlHash: data.urlHash,
    originalTitle: data.originalTitle,
    summaryText: data.summaryText,
    summaryStatus: data.summaryStatus,
    analysisStatus: data.analysisStatus,
    moderationStatus: data.moderationStatus,
    moderationReason: data.moderationReason,
    moderationDetail: data.moderationDetail,
    qualityScore: data.qualityScore,
    qualityRationale: data.qualityRationale,
    eventType: data.eventType,
    eventSubject: data.eventSubject,
    eventAction: data.eventAction,
    eventObject: data.eventObject,
    eventDate: data.eventDate,
    language: data.language,
    status: data.status,
    filterReason: data.filterReason,
    aiProcessedAt: data.aiProcessedAt,
    isAggregation: data.isAggregation,
    aggregationCheckedAt: data.aggregationCheckedAt,
    aggregationParseStatus: data.aggregationParseStatus,
    errorMessage: data.errorMessage,
  };
}

export async function reassignAggregationChildParentIfLinked(
  tx: PrismaTransaction,
  childItemId: string,
  removedParentId: string,
): Promise<boolean> {
  const replacementLink = await tx.aggregationSplitLink.findFirst({
    where: { childItemId },
    orderBy: [{ createdAt: "asc" }, { eventIndex: "asc" }],
    select: { parentItemId: true },
  });

  if (!replacementLink) {
    return false;
  }

  await tx.item.updateMany({
    where: {
      id: childItemId,
      OR: [{ parentItemId: removedParentId }, { parentItemId: null }],
    },
    data: {
      parentItemId: replacementLink.parentItemId,
    },
  });

  return true;
}

export type PersistAggregationResult = {
  childItemIds: string[];
};

/**
 * Persist each parsed event as a full child Item inside a single transaction.
 * Idempotent: re-running with the same events produces the same child item ids
 * (urlHash collisions resolve to update).
 *
 * Callers are expected to assign clusters to the returned ids in a separate
 * step (assignItemToCluster acquires its own window-level lock and may invoke
 * AI for cluster matching, so it cannot share the upsert transaction).
 */
export async function persistAggregationChildItems({
  sourceId,
  parent,
  publishedAt,
  events,
}: {
  sourceId: string;
  parent: { id: string; originalUrl: string; originalTitle: string };
  publishedAt: Date;
  events: AggregationChildEventInput[];
}): Promise<PersistAggregationResult> {
  if (events.length === 0) {
    return { childItemIds: [] };
  }
  const preparedTagReplacements = await prepareItemTagReplacements(
    events.map((event) => event.tags),
  );
  const childItemIds: string[] = [];
  await prisma.$transaction(async (tx) => {
    const linkedUrlHashes = new Set<string>();
    const retainedEventIndexes: number[] = [];
    const tagAssignments: PreparedItemTagAssignment[] = [];
    for (const [eventIndex, event] of events.entries()) {
      const childInput = buildAggregationChildItemInput({
        sourceId,
        parent,
        publishedAt,
        event,
      });
      const urlHash = String(childInput.urlHash);
      if (linkedUrlHashes.has(urlHash)) {
        continue;
      }
      linkedUrlHashes.add(urlHash);
      const child = await upsertItemInTx(tx, childInput);
      tagAssignments.push({
        itemId: child.id,
        replacement: preparedTagReplacements[eventIndex] ?? {
          tags: [],
          autoCanonicalAliases: [],
        },
      });
      const fingerprint = event.fingerprint ?? buildSemanticEventFingerprint(event);
      await tx.aggregationSplitLink.upsert({
        where: {
          parentItemId_eventIndex: {
            parentItemId: parent.id,
            eventIndex,
          },
        },
        create: {
          parentItemId: parent.id,
          childItemId: child.id,
          eventIndex,
          fingerprint,
          title: event.title ?? null,
          oneLiner: event.oneLiner,
          sourceUrl: normalizeHttpUrl(event.sourceUrl),
        },
        update: {
          childItemId: child.id,
          fingerprint,
          title: event.title ?? null,
          oneLiner: event.oneLiner,
          sourceUrl: normalizeHttpUrl(event.sourceUrl),
        },
      });
      retainedEventIndexes.push(eventIndex);
      childItemIds.push(child.id);
    }

    await replacePreparedItemTagsInTransaction(tx, tagAssignments);

    await tx.aggregationSplitLink.deleteMany({
      where: {
        parentItemId: parent.id,
        eventIndex: { notIn: retainedEventIndexes },
      },
    });
  }, { timeout: 15_000 });
  return { childItemIds };
}

/**
 * Retire child items that reference the given parent. Used by the reparse task
 * to hide stale splits while preserving cluster history and admin auditability.
 */
export async function retireAggregationChildItems(parentId: string): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const links = await tx.aggregationSplitLink.findMany({
      where: { parentItemId: parentId },
      select: { childItemId: true },
    });
    await tx.aggregationSplitLink.deleteMany({
      where: { parentItemId: parentId },
    });

    let retiredCount = 0;
    for (const { childItemId } of links) {
      const hasRemainingParent = await reassignAggregationChildParentIfLinked(
        tx,
        childItemId,
        parentId,
      );
      if (hasRemainingParent) {
        continue;
      }
      const result = await tx.item.updateMany({
        where: {
          id: childItemId,
          OR: [
            { status: { not: "filtered" } },
            { moderationStatus: { not: "filtered" } },
            { filterReason: { not: "reparsed_parent" } },
          ],
        },
        data: {
          status: "filtered",
          moderationStatus: "filtered",
          filterReason: "reparsed_parent",
          errorMessage: null,
        },
      });
      retiredCount += result.count;
    }

    const legacyResult = await tx.item.updateMany({
      where: {
        parentItemId: parentId,
        aggregationSplitParents: { none: {} },
        OR: [
          { status: { not: "filtered" } },
          { moderationStatus: { not: "filtered" } },
          { filterReason: { not: "reparsed_parent" } },
        ],
      },
      data: {
        status: "filtered",
        moderationStatus: "filtered",
        filterReason: "reparsed_parent",
        errorMessage: null,
      },
    });
    return retiredCount + legacyResult.count;
  });
}
