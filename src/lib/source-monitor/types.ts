export type SourceMonitorHealthStatus = "unknown" | "healthy" | "failed";

export type SourceInactivityBucketKey =
  | "day"
  | "week"
  | "month"
  | "quarter"
  | "half_year"
  | "year";

export type SourceMonitorEntry = {
  id: string;
  name: string;
  rssUrl: string | null;
  siteUrl: string;
  groupName: string | null;
  healthStatus: SourceMonitorHealthStatus;
  healthMessage: string | null;
  healthCheckedAt: string | null;
  lastFetchedAt: string | null;
  lastItemCreatedAt: string | null;
  inactiveDays: number | null;
  itemCount: number;
  attentionReasons?: string[];
};

export type SourceInactivityBucketSnapshot = {
  key: SourceInactivityBucketKey;
  label: string;
  days: number;
  cutoff: string;
  count: number;
};

export type SourceMonitorPagination = {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
};

export type SourceMonitorGroupOption = {
  value: string;
  label: string;
  count: number;
};

export type SourceMonitorHealthSummary = {
  healthyCount: number;
  failedCount: number;
  unknownCount: number;
  attentionSources?: SourceMonitorEntry[];
};

export type SourceMonitorSnapshot = {
  generatedAt: string;
  totalEnabledSourceCount: number;
  filteredSourceCount: number;
  pagination: SourceMonitorPagination;
  sources: SourceMonitorEntry[];
  health: SourceMonitorHealthSummary;
  inactivityBuckets: SourceInactivityBucketSnapshot[];
  groups: SourceMonitorGroupOption[];
};
