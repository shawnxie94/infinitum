import type { ItemStatus, SourceConfig } from "@/lib/feed/types";

import type { AiProvider } from "@/lib/ai/provider";
import type {
  TaskAiCallBreakdownSnapshot,
  TaskStageTimingSnapshot,
  TaskTimelineNodeSnapshot,
} from "@/lib/tasks/types";

export type ParsedFeedItem = {
  title?: string | null;
  link?: string | null;
  isoDate?: string | null;
  pubDate?: string | null;
  creator?: unknown;
  author?: unknown;
  content?: string | null;
  "content:encoded"?: string | null;
  contentSnippet?: string | null;
};

export type ParsedFeed = {
  title?: string | null;
  link?: string | null;
  feedUrl?: string | null;
  items?: ParsedFeedItem[];
  notModified?: boolean;
  etag?: string | null;
  lastModified?: string | null;
};

export type RssParserLike = {
  parseURL(
    url: string,
    options?: {
      headers?: Record<string, string>;
    },
  ): Promise<ParsedFeed>;
};

export type ArticleFetchContext = {
  rssContent?: string | null;
  rssExcerpt?: string | null;
  reason?: "short_content" | "rss_html";
  metrics?: {
    localAttempted?: boolean;
    jinaAttempted?: boolean;
    used?: "local" | "jina" | null;
  };
};

export type ArticleFetcher = (url: string, context?: ArticleFetchContext) => Promise<string | null>;

export type ProcessedItemRecord = {
  id: string;
  status: ItemStatus;
  isNew: boolean;
  errorMessage?: string | null;
  affectedClusterId?: string | null;
  affectedClusterIds?: string[];
  fullTextFetched?: boolean;
  metrics?: {
    blacklistFiltered?: boolean;
    reusedExisting?: boolean;
    summaryCompleted?: boolean;
    summaryFailed?: boolean;
    aggregationParsed?: boolean;
    aggregationParseFailed?: boolean;
    aggregationEventCount?: number;
    analysisCompleted?: boolean;
    analysisFailed?: boolean;
    analysisFiltered?: boolean;
    updatedExisting?: boolean;
    fullTextFetchAttempted?: boolean;
    fullTextFetchReason?: ArticleFetchContext["reason"];
    fullTextFetchLocalAttempted?: boolean;
    fullTextFetchJinaAttempted?: boolean;
    fullTextFetchSource?: "local" | "jina" | null;
    timings?: {
      totalMs?: number;
      fullTextFetchMs?: number;
      ruleFilterMs?: number;
      analysisMs?: number;
      clusterAssignmentMs?: number;
      dbWriteMs?: number;
    };
    clusterAssignment?: {
      exactMatch: number;
      cheapRankDirect: number;
      aiMatch: number;
      skippedIncompleteSignature: number;
      newCluster: number;
    };
  };
};

export type RunIngestionOptions = {
  trigger: "scheduled" | "manual";
  parser: RssParserLike;
  articleFetcher: ArticleFetcher;
  aiProvider: AiProvider;
  sourceConfigs: SourceConfig[];
  blacklist: string[];
  itemConcurrency: number;
  sourceConcurrency: number;
  fullTextFetchThreshold: number;
  contentExtraction: import("@/config/runtime").RuntimeConfig["contentExtraction"];
  perSourceItemLimit: number;
  /** Safety cap applied after time ordering and window filtering, before per-source processing limit. */
  maxFeedItemsToScan?: number;
  processingStartAt?: Date | null;
  now?: Date;
  onProgress?: (snapshot: {
    status: "running" | "succeeded" | "failed" | "partial";
    sourceCount: number;
    sourceFailureCount: number;
    itemCount: number;
    successCount: number;
    failureCount: number;
    itemsAdded: number;
    fullTextFetchedCount: number;
    aiCallCountActual?: number;
    aiCallCountEstimated?: number;
    aiCallBreakdown?: TaskAiCallBreakdownSnapshot[];
    errorSummary?: string | null;
    stageTimings?: TaskStageTimingSnapshot[];
    taskTimeline?: TaskTimelineNodeSnapshot[];
  }) => Promise<void> | void;
};
