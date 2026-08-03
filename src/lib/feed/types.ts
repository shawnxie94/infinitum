import type { GroupBadge } from "@/lib/groups/badge";

export type FeedRange = "today" | "3d" | "7d" | "1m" | "1y" | "all";
export type FeedSort = "time_desc" | "score_desc";
export type FeedEntryType = "single" | "cluster";
export type FeedEntryKey = `${FeedEntryType}:${string}`;

export type FeedFilters = {
  range: FeedRange;
  sort: FeedSort;
  start: string | null;
  end: string | null;
  publishedStart: string | null;
  publishedEnd: string | null;
  groupId: string | null;
  sourceId: string | null;
  title: string | null;
  entity: string | null;
  entryId: string | null;
  entryType: FeedEntryType | null;
  entryKeys: FeedEntryKey[];
};

export const DEFAULT_FEED_PAGE_SIZE = 50;
export const FEED_PAGE_SIZE_OPTIONS = [50, 100, 200] as const;

export type FeedPagination = {
  page: number;
  size: number;
  total: number;
  totalPages: number;
};

export type FeedSingleEntryDTO = {
  id: string;
  type: "single";
  title: string;
  originalUrl: string;
  publishedAt: string;
  createdAt: string;
  latestPublishedAt: string;
  sourceName: string;
  author?: string | null;
  summary: string;
  group?: GroupBadge | null;
  score: number;
  sourceCount: number;
  itemCount: number;
  canRegenerateTranslation?: boolean;
  aggregationParent?: FeedAggregationParentDTO | null;
};

export type FeedAggregationParentDTO = {
  id: string;
  title: string;
  originalUrl: string;
};

export type FeedClusterPreviewItemDTO = {
  id: string;
  title: string;
  originalTitle?: string;
  originalUrl: string;
  publishedAt: string;
  sourceName: string;
  author?: string | null;
  summary: string;
  group?: GroupBadge | null;
  score: number;
  eventType?: string | null;
  eventSubject?: string | null;
  eventAction?: string | null;
  eventObject?: string | null;
  eventDate?: string | null;
  canRegenerateTranslation?: boolean;
  aggregationParent?: FeedAggregationParentDTO | null;
};

export type ClusterAssignmentExplanationDTO = {
  eventType: string | null;
  eventSubject: string | null;
  eventAction: string | null;
  eventObject: string | null;
  eventDate: string | null;
  sourceCount: number;
  itemCount: number;
  reasons: string[];
};

export type FeedClusterEntryDTO = {
  id: string;
  type: "cluster";
  title: string;
  summary: string;
  group?: GroupBadge | null;
  publishedAt: string;
  createdAt: string;
  latestPublishedAt: string;
  score: number;
  sourceCount: number;
  itemCount: number;
  itemsPreview: FeedClusterPreviewItemDTO[];
  hasMoreItems: boolean;
};

export type FeedEntryDTO = FeedSingleEntryDTO | FeedClusterEntryDTO;
export type FeedItemDTO = FeedSingleEntryDTO;

export type ReviewItemDTO = {
  id: string;
  title: string;
  originalUrl: string;
  publishedAt: string;
  sourceName: string;
  author?: string | null;
  summary: string;
  moderationStatus: "allowed" | "filtered" | "restored";
  moderationReason: "marketing" | "low_quality" | "duplicate_noise" | "rule_filter" | "rule_blacklist" | "other" | null;
  moderationDetail: string | null;
  qualityScore: number;
  qualityRationale: string;
  canRegenerateTranslation?: boolean;
};

export type ClusterDTO = {
  id: string;
  title: string;
  summary: string;
  score: number;
  itemCount: number;
  latestPublishedAt: string;
  latestItemUpdatedAt?: string;
  status: "active" | "hidden";
  items: FeedClusterPreviewItemDTO[];
  assignmentExplanation?: ClusterAssignmentExplanationDTO;
};

export type ClusterReviewCandidateDTO = {
  id: string;
  verdict: "approved" | "declined" | "ambiguous" | "failed";
  source: "local_rule" | "llm" | "manual" | "system";
  reasonCode: string | null;
  reasonText: string | null;
  localScore: number | null;
  confidence: number | null;
  attemptCount: number;
  expiresAt: string | null;
  createdAt: string;
  leftCluster: Pick<ClusterDTO, "id" | "title" | "summary" | "itemCount" | "score" | "latestPublishedAt" | "status">;
  rightCluster: Pick<ClusterDTO, "id" | "title" | "summary" | "itemCount" | "score" | "latestPublishedAt" | "status">;
  targetClusterId: string;
  sourceClusterId: string;
};

export type AggregationSplitChildDTO = {
  id: string;
  title: string;
  originalUrl: string;
  publishedAt: string;
  sourceName: string;
  summary: string;
  status: ItemStatus;
  moderationStatus: ReviewItemDTO["moderationStatus"];
  filterReason: string | null;
  qualityScore: number;
  eventType: string | null;
  eventSubject: string | null;
  eventAction: string | null;
  eventObject: string | null;
  eventDate: string | null;
  clusterId: string | null;
  clusterTitle: string | null;
  usesParentUrl: boolean;
};

export type AggregationSplitParentDTO = {
  id: string;
  title: string;
  originalUrl: string;
  publishedAt: string;
  createdAt: string;
  aggregationCheckedAt: string | null;
  sourceName: string;
  summary: string;
  status: ItemStatus;
  moderationStatus: ReviewItemDTO["moderationStatus"];
  aggregationParseStatus: string | null;
  errorMessage: string | null;
  childCount: number;
  eventUrlCount: number;
  parentUrlCount: number;
  qualityScore: number;
  children?: AggregationSplitChildDTO[];
};

export type IngestionTrigger = "scheduled" | "manual";

export type ItemStatus = "new" | "fetched" | "filtered" | "processed" | "failed";

export type FetchRunSnapshot = {
  id: string;
  status: "running" | "succeeded" | "failed" | "partial";
  triggerType: IngestionTrigger;
  startedAt: string;
  finishedAt: string | null;
  sourceCount: number;
  itemCount: number;
  successCount: number;
  failureCount: number;
  itemsAdded: number;
  errorSummary?: string | null;
};

export type FeedGroupOption = {
  id: string;
  name: string;
  count: number;
  color?: string;
};

export type FeedSourceOption = {
  id: string;
  name: string;
  groupId: string | null;
};


export type SourceConfig = {
  name: string;
  rssUrl: string;
  siteUrl: string;
  enabled: boolean;
  aiParsingEnabled: boolean;
  aggregationEnabled?: boolean;
  aggregationDetectionEnabled?: boolean;
};
