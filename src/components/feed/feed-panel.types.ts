import type { Dayjs } from "dayjs";

import type {
  ClusterDTO,
  FeedEntryKey,
  FeedEntryDTO,
  FeedGroupOption,
  FeedPagination,
  FeedRange,
  FeedSort,
  FeedSourceOption,
  FetchRunSnapshot,
} from "@/lib/feed/types";
import type { AdminHeaderLink } from "@/lib/settings/types";

export type FeedPanelProps = {
  initialItems: FeedEntryDTO[];
  initialRange: FeedRange;
  initialCreatedRangeExplicit?: boolean;
  initialSort: FeedSort;
  initialStartDate: string | null;
  initialEndDate: string | null;
  initialPublishedStartDate?: string | null;
  initialPublishedEndDate?: string | null;
  initialNextCursor?: string | null;
  initialPagination?: FeedPagination | null;
  initialStatus: FetchRunSnapshot | null;
  isAdmin: boolean;
  hydrateAdminClient?: boolean;
  initialGroupId?: string | null;
  initialSourceId?: string | null;
  initialTitle?: string | null;
  initialEntryKeys?: FeedEntryKey[];
  availableGroups?: FeedGroupOption[];
  initialGroupTotalCount?: number;
  availableSources?: FeedSourceOption[];
  initialHeaderLinks?: AdminHeaderLink[];
};

export type FeedQueryState = {
  range: FeedRange;
  sort: FeedSort;
  startDate: string | null;
  endDate: string | null;
  publishedStartDate: string | null;
  publishedEndDate: string | null;
  groupId: string | null;
  sourceId: string | null;
  title: string | null;
  entryKeys: FeedEntryKey[];
  createdRangeExplicit?: boolean;
};

export type FeedbackTone = "info" | "success" | "error";

export type FeedFeedback = {
  tone: FeedbackTone;
  message: string;
};

export type RegenerateDialogState = {
  itemId: string;
  canRegenerateTranslation: boolean;
  shouldAnnounceClusterRefresh?: boolean;
} | null;

export type RegenerateMode = "summary" | "translation" | "both" | "reanalyze";

export type AssignClusterDialogState = {
  itemId: string;
  itemTitle: string;
  currentClusterId?: string | null;
} | null;

export type ManualFilterDialogState = {
  itemId: string;
  itemTitle: string;
} | null;

export type DeleteItemDialogState = {
  itemId: string;
  itemTitle: string;
} | null;

export type BatchActionType = "regenerate" | "filter" | "delete" | "merge";

export type BatchActionDialogState = {
  type: BatchActionType;
  itemIds: string[];
  itemTitles: string[];
} | null;

export type DateRangeValue = [Dayjs | null, Dayjs | null] | null;

export type FeedClusterOptionsState = {
  clusterOptions: ClusterDTO[];
  clusterSearch: string;
  selectedClusterId: string | null;
  isLoadingClusterOptions: boolean;
};
