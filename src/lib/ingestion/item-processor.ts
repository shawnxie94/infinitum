import type { Item } from "@prisma/client";

import { AGGREGATION_PARSE_STATUS, RETRIABLE_AGGREGATION_PARSE_STATUSES } from "@/lib/aggregation/status";
import { persistAggregationChildItems } from "@/lib/aggregation/persist";
import { normalizeStoredSummary } from "@/lib/ai/summary-quality";
import type { AiEventSignature } from "@/lib/ai/provider";
import type { ClusterAssignmentCoordinator } from "@/lib/clusters/helpers";
import { assignItemToCluster } from "@/lib/clusters/service";
import { prisma } from "@/lib/db";
import {
  findExistingItem,
  upsertItem,
} from "@/lib/feed/repository";
import { shouldTranslateTitle, stripHtmlTags } from "@/lib/feed/presentation";
import { shouldSkipJinaForUrl } from "@/lib/ingestion/article";
import { buildDedupeKeys, shouldFetchFullText } from "@/lib/ingestion/dedupe";
import { evaluateRuleFilter } from "@/lib/ingestion/filtering";
import { buildItemUnderstandingInput } from "@/lib/ingestion/content-input";
import {
  classifyItemProcessingRecoveryReasons,
  clearItemProcessingRetryState,
  degradeExhaustedAggregationItem,
  scheduleItemProcessingRetry,
} from "@/lib/items/processing-state";
import { ITEM_PROCESSING_RECOVERY_MAX_ATTEMPTS } from "@/config/constants";
import { getItemEntityNamesFromEvent, replaceItemEntities } from "@/lib/entities/service";
import type {
  ParsedFeedItem,
  ProcessedItemRecord,
  RunIngestionOptions,
} from "@/lib/ingestion/types";

type ItemProcessingTimings = NonNullable<NonNullable<ProcessedItemRecord["metrics"]>["timings"]>;

export type PreparedFeedItem = {
  item: ParsedFeedItem;
  sourceId: string;
  sourceName: string;
  aiParsingEnabled: boolean;
  aggregationEnabled: boolean;
  aggregationDetectionEnabled: boolean;
};

export type PreparedFeedItemLookup = {
  originalTitle: string;
  originalUrl: string;
  publishedAt: Date;
  publishedAtKnown: boolean;
  rssContent: string | null;
  rssExcerpt: string | null;
  canonicalUrl: string;
  dedupeKeys: {
    canonicalUrl: string;
    urlHash: string;
  };
};

const EVENT_TYPES = new Set<NonNullable<AiEventSignature["eventType"]>>([
  "release",
  "launch",
  "update",
  "funding",
  "acquisition",
  "partnership",
  "policy",
  "research",
  "security",
  "other",
]);
function getBestContent(item: ParsedFeedItem): string {
  return item["content:encoded"] || item.content || item.contentSnippet || "";
}

const HTML_TAG_DETECTION_PATTERN = /<\/?[a-z][\s\S]*>/i;

function looksLikeHtmlContent(value: string | null | undefined) {
  return Boolean(value && HTML_TAG_DETECTION_PATTERN.test(value));
}

function normalizeFeedAuthor(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim() || null;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const candidate = record.name ?? record.title ?? record.email;

  if (Array.isArray(candidate)) {
    const text = candidate.find((entry) => typeof entry === "string" && entry.trim());
    return typeof text === "string" ? text.trim() : null;
  }

  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

function getFeedItemAuthor(item: ParsedFeedItem): string | null {
  return normalizeFeedAuthor(item.creator) ?? normalizeFeedAuthor(item.author);
}

export function parsePublishedAt(item: ParsedFeedItem, fallback: Date): { value: Date; known: boolean } {
  const raw = item.isoDate || item.pubDate;
  const parsed = raw ? new Date(raw) : null;

  if (!parsed || Number.isNaN(parsed.getTime())) {
    return { value: fallback, known: false };
  }

  return { value: parsed, known: true };
}

function resolvePublishedAt(input: {
  existing?: Pick<Item, "publishedAt" | "publishedAtKnown"> | null;
  incoming: Date;
  incomingKnown: boolean;
}) {
  if (input.existing?.publishedAtKnown && !input.incomingKnown) {
    return {
      value: input.existing.publishedAt,
      known: true,
    };
  }

  return {
    value: input.incoming,
    known: Boolean(input.existing?.publishedAtKnown || input.incomingKnown),
  };
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function appendIssue(issues: string[], error: unknown, fallbackMessage: string) {
  console.error(`[Item Processor] ${fallbackMessage}:`, error);
  issues.push(error instanceof Error ? error.message : fallbackMessage);
}

async function replaceItemEntitiesSafely(itemId: string, entities: unknown, issues: string[]) {
  try {
    await replaceItemEntities(itemId, entities);
  } catch (error) {
    appendIssue(issues, error, "Unknown item entity persistence error");
  }
}

function createItemProcessingTimings() {
  return {
    totalMs: 0,
    fullTextFetchMs: 0,
    ruleFilterMs: 0,
    analysisMs: 0,
    clusterAssignmentMs: 0,
    dbWriteMs: 0,
  } satisfies Required<ItemProcessingTimings>;
}

function addElapsed(
  timings: Required<ItemProcessingTimings>,
  key: keyof Required<ItemProcessingTimings>,
  startedAt: number,
) {
  timings[key] += Date.now() - startedAt;
}

export function deriveSourceConcurrency(itemConcurrency: number) {
  return Math.max(1, Math.min(4, Math.ceil(itemConcurrency / 2)));
}

function buildFallbackSummary(rssExcerpt: string | null): string | null {
  const sanitizedExcerpt = stripHtmlTags(rssExcerpt);

  if (sanitizedExcerpt) {
    return sanitizedExcerpt;
  }

  return null;
}

function hasSucceededSummary(existing?: {
  summaryStatus?: string | null;
  summaryText?: string | null;
} | null) {
  return existing?.summaryStatus === "succeeded" && Boolean(normalizeStoredSummary(existing.summaryText));
}

function hasSucceededAnalysis(existing?: {
  analysisStatus?: string | null;
} | null) {
  return existing?.analysisStatus === "succeeded";
}

function normalizeStoredEventType(value: string | null | undefined): AiEventSignature["eventType"] {
  return value && EVENT_TYPES.has(value as NonNullable<AiEventSignature["eventType"]>)
    ? (value as NonNullable<AiEventSignature["eventType"]>)
    : null;
}

function readStoredEventSignature(item?: {
  eventType?: string | null;
  eventSubject?: string | null;
  eventAction?: string | null;
  eventObject?: string | null;
  eventDate?: string | null;
} | null): AiEventSignature | null {
  if (!item) {
    return null;
  }

  return {
    eventType: normalizeStoredEventType(item.eventType),
    eventSubject: item.eventSubject ?? null,
    eventAction: item.eventAction ?? null,
    eventObject: item.eventObject ?? null,
    eventDate: item.eventDate ?? null,
  };
}

function hasRetriableAggregationParse(existing?: {
  aggregationParseStatus?: string | null;
  isAggregation?: boolean | null;
} | null) {
  if (!existing) {
    return false;
  }

  // Items whose aggregation parse failed or was detected-but-not-parsed in a
  // previous run must be re-processed so the next unified understanding can retry it.
  // Without this guard, the "reused existing" early return would silently skip
  // them and the failure would never recover.
  if (existing.aggregationParseStatus && (RETRIABLE_AGGREGATION_PARSE_STATUSES as readonly string[]).includes(existing.aggregationParseStatus)) {
    return true;
  }

  return false;
}

function isCompletedExistingItem(existing?: {
  status?: string | null;
  summaryStatus?: string | null;
  summaryText?: string | null;
  analysisStatus?: string | null;
  aggregationParseStatus?: string | null;
  isAggregation?: boolean | null;
} | null) {
  if (!existing) {
    return false;
  }

  if (hasRetriableAggregationParse(existing)) {
    return false;
  }

  if (existing.status === "filtered") {
    return true;
  }

  return existing.status === "processed" && hasSucceededSummary(existing) && hasSucceededAnalysis(existing);
}

function canReuseExistingByUrl(
  existing: Item | null | undefined,
  lookup: PreparedFeedItemLookup | null,
) {
  return Boolean(
    existing &&
      lookup &&
      existing.urlHash === lookup.dedupeKeys.urlHash &&
      isCompletedExistingItem(existing),
  );
}

export function buildPreparedFeedItemLookup(preparedItem: PreparedFeedItem, now: Date): PreparedFeedItemLookup | null {
  const originalTitle = preparedItem.item.title?.trim();
  const originalUrl = preparedItem.item.link?.trim();

  if (!originalTitle || !originalUrl) {
    return null;
  }

  const parsedPublishedAt = parsePublishedAt(preparedItem.item, now);
  const rssContent = getBestContent(preparedItem.item).trim() || null;
  const rssExcerpt = preparedItem.item.contentSnippet?.trim() || null;
  const canonicalUrl = normalizeUrl(originalUrl);
  const dedupeKeys = buildDedupeKeys({
    canonicalUrl,
  });

  return {
    originalTitle,
    originalUrl,
    publishedAt: parsedPublishedAt.value,
    publishedAtKnown: parsedPublishedAt.known,
    rssContent,
    rssExcerpt,
    canonicalUrl,
    dedupeKeys,
  };
}

export function estimatePreparedItemAiWork(
  preparedItem: PreparedFeedItem,
  lookup: PreparedFeedItemLookup | null,
  existing: Item | null | undefined,
  blacklist: string[],
): boolean {
  if (!lookup || !preparedItem.aiParsingEnabled) {
    return false;
  }

  const initialFilterMatch = evaluateRuleFilter({
    title: lookup.originalTitle,
    content: [lookup.rssContent, lookup.rssExcerpt].filter(Boolean).join("\n"),
    url: lookup.originalUrl,
    sourceName: preparedItem.sourceName,
    blacklist,
  });

  if (initialFilterMatch.filtered) {
    return false;
  }

  if (canReuseExistingByUrl(existing, lookup)) {
    return false;
  }

  return true;
}

export async function processFeedItem({
  item,
  sourceId,
  sourceName,
  aiParsingEnabled,
  aggregationEnabled,
  aggregationDetectionEnabled,
  lookup: providedLookup,
  existingItem,
  blacklist,
  articleFetcher,
  aiProvider,
  clusterAssignmentCoordinator,
  fullTextFetchThreshold,
  contentExtraction,
  now,
}: {
  item: ParsedFeedItem;
  sourceId: string;
  sourceName: string;
  aiParsingEnabled: boolean;
  aggregationEnabled: boolean;
  aggregationDetectionEnabled: boolean;
  lookup?: PreparedFeedItemLookup | null;
  existingItem?: Item | null;
  blacklist: string[];
  articleFetcher: RunIngestionOptions["articleFetcher"];
  aiProvider: RunIngestionOptions["aiProvider"];
  clusterAssignmentCoordinator: ClusterAssignmentCoordinator;
  fullTextFetchThreshold: number;
  contentExtraction: RunIngestionOptions["contentExtraction"];
  now: Date;
}): Promise<ProcessedItemRecord | null> {
  const lookup = providedLookup ?? buildPreparedFeedItemLookup({
    item,
    sourceId,
    sourceName,
    aiParsingEnabled,
    aggregationEnabled,
    aggregationDetectionEnabled,
  }, now);

  if (!lookup) {
    return null;
  }

  const {
    originalTitle,
    originalUrl,
    publishedAt,
    publishedAtKnown,
    rssContent,
    rssExcerpt,
    dedupeKeys,
  } = lookup;
  const existing =
    existingItem === undefined
      ? await findExistingItem(dedupeKeys.urlHash)
      : existingItem;
  const author = getFeedItemAuthor(item);
  const isNew = !existing;
  const hasActiveSplitChildren =
    existing?.isAggregation === true && aggregationDetectionEnabled
      ? (await prisma.aggregationSplitLink.count({
          where: { parentItemId: existing.id },
        })) > 0
      : false;
  const resolvedPublishedAt = resolvePublishedAt({
    existing,
    incoming: publishedAt,
    incomingKnown: publishedAtKnown,
  });

  let fullText = existing?.fullText ?? null;
  let translatedTitle = existing?.translatedTitle ?? null;
  let summaryText = existing?.summaryText ?? null;
  let status: ProcessedItemRecord["status"] = existing?.status ?? "new";
  let summaryStatus: "pending" | "succeeded" | "failed" = existing?.summaryStatus === "succeeded" || existing?.summaryStatus === "failed"
    ? existing.summaryStatus
    : "pending";
  let analysisStatus: "pending" | "succeeded" | "failed" = existing?.analysisStatus === "succeeded" || existing?.analysisStatus === "failed"
    ? existing.analysisStatus
    : "pending";
  let filterReason: string | null = existing?.filterReason ?? null;
  let moderationStatus = existing?.moderationStatus ?? "allowed";
  let moderationReason = existing?.moderationReason ?? null;
  let moderationDetail = existing?.moderationDetail ?? null;
  let qualityScore = existing?.qualityScore ?? 50;
  let qualityRationale = existing?.qualityRationale ?? "AI analysis unavailable";
  let eventSignature: AiEventSignature | null = readStoredEventSignature(existing);
  let itemEntities: string[] = [];
  let fullTextFetched = false;
  let summaryCompleted = false;
  let summaryFailed = false;
  let analysisCompleted = false;
  let analysisFailed = false;
  let aggregationParsed = false;
  let aggregationParseFailed = false;
  let aggregationEventCount = 0;
  const aggregationChildClusterIds = new Set<string>();
  const clusterAssignmentMetrics: NonNullable<NonNullable<ProcessedItemRecord["metrics"]>["clusterAssignment"]> = {
    exactMatch: 0,
    cheapRankDirect: 0,
    aiMatch: 0,
    skippedIncompleteSignature: 0,
    newCluster: 0,
  };
  let hasClusterAssignmentMetrics = false;
  // Retriable aggregation parse must force another unified understanding call.
  // Only preserve isAggregation=true when the item was already treated as an
  // aggregation parent; a plain failed parse should remain visible as a regular
  // item while recovery retries in the background.
  let isAggregation = existing?.isAggregation ?? false;
  let aggregationCheckedAt: Date | null = existing?.aggregationCheckedAt ?? null;
  let aggregationParseStatus: string | null = existing?.aggregationParseStatus ?? null;
  let storedItemId = existing?.id ?? null;
  const issues: string[] = [];
  const processingStartedAt = Date.now();
  const timings = createItemProcessingTimings();
  const finalizeTimings = () => {
    timings.totalMs = Date.now() - processingStartedAt;
    return timings;
  };
  const contentForFullTextDecision = fullText || rssContent || rssExcerpt || "";
  const canReuseExistingByUrlResult = Boolean(
    canReuseExistingByUrl(existing, lookup),
  );
  const initialRuleFilterStartedAt = Date.now();
  const initialRuleFilter = evaluateRuleFilter({
    title: originalTitle,
    content: [rssContent, rssExcerpt].filter(Boolean).join("\n"),
    url: originalUrl,
    sourceName,
    blacklist,
  });
  addElapsed(timings, "ruleFilterMs", initialRuleFilterStartedAt);

  if (initialRuleFilter.filtered) {
    const dbWriteStartedAt = Date.now();
    const stored = await upsertItem(
      {
        id: existing?.id,
        urlHash: dedupeKeys.urlHash,
      },
      {
        sourceId,
        originalUrl,
        canonicalUrl: dedupeKeys.canonicalUrl,
        urlHash: dedupeKeys.urlHash,
        originalTitle,
        translatedTitle,
        author,
        publishedAt: resolvedPublishedAt.value,
        publishedAtKnown: resolvedPublishedAt.known,
        rssExcerpt,
        rssContent,
        fullText,
        summaryText,
        language: shouldTranslateTitle(originalTitle) ? "en" : "unknown",
        status: "filtered",
        summaryStatus: "pending",
        analysisStatus: "pending",
        filterReason: initialRuleFilter.reason,
        moderationStatus: "filtered",
        moderationReason: "rule_filter",
        moderationDetail: initialRuleFilter.detail,
        qualityScore,
        qualityRationale,
        eventType: eventSignature?.eventType ?? null,
        eventSubject: eventSignature?.eventSubject ?? null,
        eventAction: eventSignature?.eventAction ?? null,
        eventObject: eventSignature?.eventObject ?? null,
        eventDate: eventSignature?.eventDate ?? null,
        isAggregation,
        aggregationCheckedAt,
        aggregationParseStatus,
        aiProcessedAt: null,
        clusterId: null,
        manualClusterAssignedAt: null,
        errorMessage: null,
      },
    );
    addElapsed(timings, "dbWriteMs", dbWriteStartedAt);
    await replaceItemEntitiesSafely(stored.id, [], issues);

    return {
      id: stored.id,
      status: stored.status,
      isNew,
      affectedClusterId: existing?.clusterId ?? null,
      fullTextFetched,
      metrics: {
        blacklistFiltered: true,
        timings: finalizeTimings(),
      },
    };
  }

  if (canReuseExistingByUrlResult && existing) {
    const stored = existing;

    return {
      id: stored.id,
      status: stored.status,
      isNew,
      fullTextFetched,
      metrics: {
        reusedExisting: true,
        timings: finalizeTimings(),
      },
    };
  }

  const shouldFetchBecauseContentIsShort = shouldFetchFullText(contentForFullTextDecision, fullTextFetchThreshold);
  const shouldFetchBecauseRssHtml =
    contentExtraction.jinaEnabled &&
    !shouldSkipJinaForUrl(originalUrl) &&
    looksLikeHtmlContent(rssContent);
  const fullTextFetchReason = shouldFetchBecauseRssHtml ? "rss_html" as const : "short_content" as const;
  let fullTextFetchAttempted = false;
  const fullTextFetchMetrics = {
    localAttempted: false,
    jinaAttempted: false,
    used: null as "local" | "jina" | null,
  };

  if (!fullText && (shouldFetchBecauseContentIsShort || shouldFetchBecauseRssHtml)) {
    fullTextFetchAttempted = true;
    const fetchStartedAt = Date.now();
    try {
      const fetchContext = {
        rssContent,
        rssExcerpt,
        reason: fullTextFetchReason,
        metrics: fullTextFetchMetrics,
      };
      const fetchedFullText = await articleFetcher(originalUrl, fetchContext);
      addElapsed(timings, "fullTextFetchMs", fetchStartedAt);
      fullText = fetchedFullText;
      status = "fetched";
      fullTextFetched = Boolean(fetchedFullText && fetchedFullText.trim());
    } catch (error) {
      addElapsed(timings, "fullTextFetchMs", fetchStartedAt);
      appendIssue(issues, error, "Unknown article fetch error");
    }
  }

  const ruleFilterStartedAt = Date.now();
  const ruleFilter = evaluateRuleFilter({
    title: originalTitle,
    content: [rssContent, rssExcerpt, fullText].filter(Boolean).join("\n"),
    url: originalUrl,
    sourceName,
    blacklist,
  });
  addElapsed(timings, "ruleFilterMs", ruleFilterStartedAt);

  if (ruleFilter.filtered) {
    status = "filtered";
    summaryStatus = "pending";
    analysisStatus = "pending";
    filterReason = ruleFilter.reason;
    moderationStatus = "filtered";
    moderationReason = "rule_filter";
    moderationDetail = ruleFilter.detail;
  } else if (aiParsingEnabled) {
    const translateTitle = shouldTranslateTitle(originalTitle);
    const understandingInput = buildItemUnderstandingInput({
      fullText,
      rssContent,
      rssExcerpt,
      originalTitle,
    });
    const understandingStartedAt = Date.now();

    try {
      const understanding = await aiProvider.understandItem(understandingInput, {
        title: originalTitle,
        sourceName,
        translateTitle,
      });
      addElapsed(timings, "analysisMs", understandingStartedAt);

      summaryText = understanding.diagnostics.summaryValid
        ? normalizeStoredSummary(understanding.summary)
        : buildFallbackSummary(rssExcerpt);
      summaryStatus = understanding.diagnostics.summaryValid ? "succeeded" : "failed";
      summaryCompleted = understanding.diagnostics.summaryValid;
      summaryFailed = !understanding.diagnostics.summaryValid;

      if (understanding.diagnostics.analysisValid) {
        if (translateTitle) {
          translatedTitle = understanding.translatedTitle?.trim() || originalTitle;
        }
        moderationStatus = understanding.moderationStatus === "restored" ? "allowed" : understanding.moderationStatus;
        moderationReason = understanding.moderationReason;
        moderationDetail = understanding.moderationDetail;
        qualityScore = understanding.qualityScore;
        qualityRationale = understanding.qualityRationale;
        eventSignature = understanding.eventSignature;
        itemEntities = getItemEntityNamesFromEvent(understanding.eventSignature);
      }
      analysisStatus = understanding.diagnostics.analysisValid ? "succeeded" : "failed";
      analysisCompleted = understanding.diagnostics.analysisValid;
      analysisFailed = !understanding.diagnostics.analysisValid;

      aggregationCheckedAt = aggregationDetectionEnabled ? new Date() : null;
      // A parent with live split children keeps its split when this attempt
      // fails to confirm the aggregation, instead of being re-marked retriable
      // and dragged through another full re-split cycle.
      const preserveExistingSplit =
        hasActiveSplitChildren &&
        aggregationDetectionEnabled &&
        (!understanding.diagnostics.aggregationValid ||
          !Boolean(moderationStatus !== "filtered" && understanding.aggregation.isAggregation));
      if (aggregationDetectionEnabled && understanding.diagnostics.aggregationValid) {
        isAggregation = preserveExistingSplit
          ? true
          : Boolean(
              moderationStatus !== "filtered" && understanding.aggregation.isAggregation,
            );
      }
      aggregationParseStatus = aggregationDetectionEnabled
        ? preserveExistingSplit
          ? AGGREGATION_PARSE_STATUS.parsed
          : understanding.diagnostics.aggregationValid
            ? isAggregation ? AGGREGATION_PARSE_STATUS.detected : AGGREGATION_PARSE_STATUS.notAggregation
            : AGGREGATION_PARSE_STATUS.failed
        : null;

      if (aggregationDetectionEnabled && !understanding.diagnostics.aggregationValid) {
        aggregationParseFailed = !preserveExistingSplit;
      }

      if (isAggregation && !preserveExistingSplit) {
        const events = understanding.aggregation.events;
        const preUpsertStartedAt = Date.now();
        const preUpsert = await upsertItem(
          { id: existing?.id, urlHash: dedupeKeys.urlHash },
          {
            sourceId,
            originalUrl,
            canonicalUrl: dedupeKeys.canonicalUrl,
            urlHash: dedupeKeys.urlHash,
            originalTitle,
            translatedTitle,
            author,
            publishedAt: resolvedPublishedAt.value,
            publishedAtKnown: resolvedPublishedAt.known,
            rssExcerpt,
            rssContent,
            fullText,
            summaryText,
            language: shouldTranslateTitle(originalTitle) ? "en" : "unknown",
            status,
            summaryStatus,
            analysisStatus,
            filterReason,
            moderationStatus,
            moderationReason,
            moderationDetail,
            qualityScore,
            qualityRationale,
            eventType: eventSignature?.eventType ?? null,
            eventSubject: eventSignature?.eventSubject ?? null,
            eventAction: eventSignature?.eventAction ?? null,
            eventObject: eventSignature?.eventObject ?? null,
            eventDate: eventSignature?.eventDate ?? null,
            isAggregation: true,
            aggregationCheckedAt,
            aggregationParseStatus: AGGREGATION_PARSE_STATUS.detected,
            parentItemId: null,
            aiProcessedAt: analysisStatus === "succeeded" ? new Date() : null,
            clusterId: null,
            manualClusterAssignedAt: null,
            errorMessage: null,
          },
        );
        addElapsed(timings, "dbWriteMs", preUpsertStartedAt);
        storedItemId = preUpsert.id;

        const childPersistStartedAt = Date.now();
        const { childItemIds } = await persistAggregationChildItems({
          sourceId,
          parent: preUpsert,
          publishedAt: resolvedPublishedAt.value,
          publishedAtKnown: resolvedPublishedAt.known,
          events,
        });
        addElapsed(timings, "dbWriteMs", childPersistStartedAt);

        for (const childId of childItemIds) {
          const childClusterAssignmentStartedAt = Date.now();
          try {
            const assignment = await assignItemToCluster(childId, {
              aiProvider,
              coordinator: clusterAssignmentCoordinator,
              aggregationEnabled: true,
            });
            hasClusterAssignmentMetrics = true;
            clusterAssignmentMetrics.exactMatch += assignment.matchSource === "exact_match" ? 1 : 0;
            clusterAssignmentMetrics.cheapRankDirect += assignment.matchSource === "cheap_rank_direct" ? 1 : 0;
            clusterAssignmentMetrics.aiMatch += assignment.matchSource === "ai_match" ? 1 : 0;
            clusterAssignmentMetrics.skippedIncompleteSignature += assignment.skippedIncompleteSignature ? 1 : 0;
            clusterAssignmentMetrics.newCluster += assignment.createdNewCluster ? 1 : 0;
            if (assignment.clusterId) {
              aggregationChildClusterIds.add(assignment.clusterId);
            }
          } catch (assignError) {
            appendIssue(issues, assignError, `Unknown cluster assignment error for child item ${childId}`);
          } finally {
            addElapsed(timings, "clusterAssignmentMs", childClusterAssignmentStartedAt);
          }
        }

        qualityScore = Math.max(qualityScore, ...events.map((event) => event.qualityScore));
        qualityRationale = `聚合内容拆出 ${events.length} 条子事件`;
        aggregationParseStatus = AGGREGATION_PARSE_STATUS.parsed;
        aggregationParsed = true;
        aggregationEventCount = events.length;
      }
    } catch (error) {
      addElapsed(timings, "analysisMs", understandingStartedAt);
      appendIssue(issues, error, "Unknown item understanding error");
      summaryStatus = "failed";
      summaryText = existing?.summaryText ?? buildFallbackSummary(rssExcerpt);
      summaryFailed = true;
      analysisStatus = "failed";
      analysisFailed = true;
      if (aggregationDetectionEnabled) {
        aggregationCheckedAt = new Date();
        aggregationParseStatus = hasActiveSplitChildren
          ? AGGREGATION_PARSE_STATUS.parsed
          : AGGREGATION_PARSE_STATUS.failed;
        aggregationParseFailed = !hasActiveSplitChildren;
      }
    }

    status = moderationStatus === "filtered" ? "filtered" : "processed";
  } else {
    if (shouldTranslateTitle(originalTitle)) {
      translatedTitle = originalTitle;
    }

    summaryText = buildFallbackSummary(rssExcerpt);
    summaryStatus = "pending";
    analysisStatus = "pending";
    moderationStatus = "allowed";
    moderationReason = null;
    moderationDetail = null;
    qualityScore = 50;
    qualityRationale = "AI parsing disabled for this source";
    eventSignature = null;
    itemEntities = [];
    status = "processed";
  }

  const dbWriteStartedAt = Date.now();
  const stored = await upsertItem(
    {
      id: storedItemId ?? undefined,
      urlHash: dedupeKeys.urlHash,
    },
    {
      sourceId,
      originalUrl,
      canonicalUrl: dedupeKeys.canonicalUrl,
      urlHash: dedupeKeys.urlHash,
      originalTitle,
      translatedTitle,
      author,
      publishedAt: resolvedPublishedAt.value,
      publishedAtKnown: resolvedPublishedAt.known,
      rssExcerpt,
      rssContent,
      fullText,
      summaryText,
      language: shouldTranslateTitle(originalTitle) ? "en" : "unknown",
      status,
      summaryStatus,
      analysisStatus,
      filterReason,
      moderationStatus,
      moderationReason,
      moderationDetail,
      qualityScore,
      qualityRationale,
      eventType: eventSignature?.eventType ?? null,
      eventSubject: eventSignature?.eventSubject ?? null,
      eventAction: eventSignature?.eventAction ?? null,
      eventObject: eventSignature?.eventObject ?? null,
      eventDate: eventSignature?.eventDate ?? null,
      isAggregation,
      aggregationCheckedAt,
      aggregationParseStatus,
      aiProcessedAt: analysisStatus === "succeeded" ? new Date() : null,
      clusterId: moderationStatus === "filtered" || isAggregation ? null : existing?.clusterId ?? null,
      manualClusterAssignedAt: moderationStatus === "filtered" || isAggregation ? null : existing?.manualClusterAssignedAt ?? null,
      errorMessage: issues.length > 0 ? issues.join(" | ") : null,
    },
  );
  addElapsed(timings, "dbWriteMs", dbWriteStartedAt);

  if (!isAggregation) {
    await replaceItemEntitiesSafely(
      stored.id,
      status === "processed" && analysisStatus === "succeeded" ? itemEntities : [],
      issues,
    );
  }

  let affectedClusterId: string | null = null;
  if (moderationStatus === "filtered" || isAggregation) {
    if (existing?.clusterId) {
      affectedClusterId = existing.clusterId;
    }
  } else if (existing?.manualClusterAssignedAt && stored.clusterId) {
    const manualCluster = await prisma.contentCluster.findUnique({
      where: { id: stored.clusterId },
      select: { id: true, status: true },
    });

    if (manualCluster?.status === "active") {
      affectedClusterId = stored.clusterId;
    } else {
      await prisma.item.update({
        where: { id: stored.id },
        data: { manualClusterAssignedAt: null },
      });
    }
  }

  if (moderationStatus !== "filtered" && !isAggregation && (!existing?.manualClusterAssignedAt || !stored.clusterId || !affectedClusterId)) {
    if (existing?.manualClusterAssignedAt && stored.clusterId) {
      await prisma.item.update({
        where: { id: stored.id },
        data: { manualClusterAssignedAt: null },
      });
    }

    const clusterAssignmentStartedAt = Date.now();
    const clusterAssignment = await assignItemToCluster(stored.id, {
      eventSignature,
      aiProvider,
      coordinator: clusterAssignmentCoordinator,
      aggregationEnabled,
      allowIncompleteSignaturePending: true,
    });
    addElapsed(timings, "clusterAssignmentMs", clusterAssignmentStartedAt);

    hasClusterAssignmentMetrics = true;
    clusterAssignmentMetrics.exactMatch += clusterAssignment.matchSource === "exact_match" ? 1 : 0;
    clusterAssignmentMetrics.cheapRankDirect += clusterAssignment.matchSource === "cheap_rank_direct" ? 1 : 0;
    clusterAssignmentMetrics.aiMatch += clusterAssignment.matchSource === "ai_match" ? 1 : 0;
    clusterAssignmentMetrics.skippedIncompleteSignature += clusterAssignment.skippedIncompleteSignature ? 1 : 0;
    clusterAssignmentMetrics.newCluster += clusterAssignment.createdNewCluster ? 1 : 0;

    if (clusterAssignment.clusterId && (isNew || existing?.clusterId !== clusterAssignment.clusterId)) {
      affectedClusterId = clusterAssignment.clusterId;
    }
  }


  // Schedule automatic recovery outside RSS top-N reuse, or clear retry state on success.
  try {
    const retryItem = await prisma.item.findUnique({
      where: { id: stored.id },
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
    if (retryItem) {
      const reasons = classifyItemProcessingRecoveryReasons({
        ...retryItem,
        hasActiveSplitChildren: retryItem._count.aggregationSplitChildren > 0,
      });
      if (reasons.length === 0) {
        if (retryItem.nextProcessingRetryAt || retryItem.lastProcessingError) {
          await clearItemProcessingRetryState(retryItem.id);
        }
      } else if (
        reasons.includes("aggregation_retriable") &&
        (retryItem.processingAttemptCount + 1) >= ITEM_PROCESSING_RECOVERY_MAX_ATTEMPTS
      ) {
        const degrade = await degradeExhaustedAggregationItem(
          retryItem.id,
          `aggregation recovery exhausted during ingestion: ${reasons.join(",")}`,
        );
        if (degrade.degradedToRegular) {
          // Parent becomes visible as a regular item; assign a pending/regular cluster.
          const assignment = await assignItemToCluster(retryItem.id, {
            eventSignature,
            aiProvider,
            coordinator: clusterAssignmentCoordinator,
            aggregationEnabled,
            allowIncompleteSignaturePending: true,
          });
          if (assignment.clusterId) {
            affectedClusterId = assignment.clusterId;
          }
          // Reload stored snapshot fields used by metrics/status.
          const degraded = await prisma.item.findUnique({ where: { id: retryItem.id } });
          if (degraded) {
            // no-op: process return uses local variables; feed will pick DB state.
          }
        }
      } else {
        await scheduleItemProcessingRetry({
          itemId: retryItem.id,
          reasons,
          attemptCount: retryItem.processingAttemptCount,
          now,
        });
      }
    }
  } catch (retryError) {
    appendIssue(issues, retryError, "Failed to schedule item processing recovery");
  }

  return {
    id: stored.id,
    status: stored.status,
    isNew,
    errorMessage: stored.errorMessage,
    affectedClusterId,
    affectedClusterIds: [...aggregationChildClusterIds],
    fullTextFetched,
    metrics: {
      blacklistFiltered: ruleFilter.filtered,
      summaryCompleted,
      summaryFailed,
      aggregationParsed,
      aggregationParseFailed,
      aggregationEventCount,
      analysisCompleted,
      analysisFailed,
      analysisFiltered: analysisCompleted && moderationStatus === "filtered",
      updatedExisting: !isNew && moderationStatus !== "filtered",
      fullTextFetchAttempted,
      fullTextFetchReason: fullTextFetchAttempted ? fullTextFetchReason : undefined,
      fullTextFetchLocalAttempted: fullTextFetchAttempted ? fullTextFetchMetrics.localAttempted : undefined,
      fullTextFetchJinaAttempted: fullTextFetchAttempted ? fullTextFetchMetrics.jinaAttempted : undefined,
      fullTextFetchSource: fullTextFetchAttempted ? fullTextFetchMetrics.used : undefined,
      timings: finalizeTimings(),
      clusterAssignment: hasClusterAssignmentMetrics ? clusterAssignmentMetrics : undefined,
    },
  };
}
