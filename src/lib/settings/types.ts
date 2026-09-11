export const PROMPT_CONFIG_TYPES = [
  "item_understanding",
  "cluster_summary",
  "cluster_match",
  "cluster_merge",
  "daily_report",
  "daily_report_review",
] as const;

export type PromptConfigType = typeof PROMPT_CONFIG_TYPES[number];

export type AdminModelApiConfig = {
  id: string;
  name: string;
  baseUrl: string;
  modelName: string;
  ingestionItemConcurrency: number;
  customHeaders?: Record<string, string>;
  apiKeyMasked: string;
  hasApiKey: boolean;
  isEnabled: boolean;
  isDefault: boolean;
  /** Which of the two OrcaRouter authentication choices produced the stored key. */
  authMethod: "api-key" | "pkce";
  oauthAccountId: string;
  oauthScope: string;
  credentialGeneration: number;
  /** Terminal `401` from the relay: the exact account must sign in again. */
  needsReauth: boolean;
  createdAt: string;
  updatedAt: string;
};

export type AdminModelApiConfigDetail = AdminModelApiConfig & {
  apiKeyRaw: string;
};

export type OrcaRouterModelOption = {
  id: string;
  name: string | null;
  contextLength: number | null;
  inputModalities: string[];
  reasoning: boolean;
  reasoningEfforts: string[];
};

export type OrcaRouterConnectSessionView = {
  attemptId: string;
  generation: number;
  status: "idle" | "pending" | "exchange-error" | "denied" | "timeout" | "cancelled" | "success";
  authorizeUrl: string;
  requestedScope: string;
  callbackMode: "loopback" | "out-of-band";
  accountId: string | null;
  grantedScope: string | null;
  error: string | null;
};

export type AdminPromptConfig = {
  id: string;
  name: string;
  type: PromptConfigType;
  prompt: string;
  userPrompt?: string | null;
  systemPrompt: string | null;
  contractVersion?: string;
  contractHash?: string;
  templateJson: string | null;
  temperature: number | null;
  maxTokens: number | null;
  topP: number | null;
  modelApiConfigId: string | null;
  modelApiConfigName: string | null;
  isUsingDefaultModel: boolean; // true if modelApiConfigId is null in database
  isEnabled: boolean;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
};

export type AdminHeaderLink = {
  id: string;
  label: string;
  url: string;
  enabled: boolean;
  sortOrder: number;
  openInNewTab: boolean;
  rel: string;
  createdAt: string;
  updatedAt: string;
};

export type AdminEventBriefingConfig = {
  id: string;
  minRankScore: number;
  channels: AdminEventBriefingChannel[];
  createdAt: string;
  updatedAt: string;
};

export type AdminEventBriefingChannel = {
  id: string;
  name: string;
  sourceGroupIds: string[];
  enabled: boolean;
  sortOrder: number;
};

export type AdminBriefingPreferenceConfig = {
  id: string;
  weightedRules: AdminBriefingWeightRule[];
  maxCuratorBoost: number;
  maxCuratorPenalty: number;
  createdAt: string;
  updatedAt: string;
};

export type AdminBriefingWeightRuleType = "entity" | "keyword" | "source_group" | "event_type";

export type AdminBriefingWeightRule = {
  type: AdminBriefingWeightRuleType;
  value: string;
  weight: number;
};

export type AdminBriefingPreferenceSuggestion = {
  id: string;
  ruleType: AdminBriefingWeightRuleType;
  value: string;
  label: string | null;
  suggestedWeight: number;
  confidence: number;
  positiveScore: number;
  negativeScore: number;
  sampleCount: number;
  reason: string;
  status: "pending" | "accepted" | "dismissed";
  createdAt: string;
  updatedAt: string;
};

export type AdminSettingsSnapshot = {
  modelApiConfigs: AdminModelApiConfig[];
  promptConfigs: AdminPromptConfig[];
  headerLinks?: AdminHeaderLink[];
  eventBriefing: {
    config: AdminEventBriefingConfig;
    preference: AdminBriefingPreferenceConfig;
  };
  contentExtraction: {
    id: string;
    jinaEnabled: boolean;
    jinaBaseUrl: string;
    jinaApiKeyMasked: string;
    hasJinaApiKey: boolean;
    timeoutMs: number;
    concurrency: number;
    rpmLimit: number;
    maxPerRun: number;
    minChars: number;
    maxChars: number;
    createdAt: string;
    updatedAt: string;
  };
  blacklistKeywords: string[];
  taskSchedule: {
    key: "ingestion_default";
    enabled: boolean;
    cronExpression: string;
    sourceConcurrency: number;
    fullTextFetchThreshold: number;
    perSourceItemLimit: number;
    aggregationSplitMaxEvents: number;
    dailyReportCandidateLimit: number;
    dailyReportPlanningBatchSize?: number | null;
    dailyReportOffsetDays: number;
    dailyReportRecentTopicLookbackDays?: number;
    dailyReportAutoPublish: boolean;
    dailyReportChannelIds?: string[];
    processingStartAt?: string | null;
    cleanupRetentionDays: number;
    timezone: string;
    lastHeartbeatAt: string | null;
    lastRunStartedAt: string | null;
    lastRunFinishedAt: string | null;
    lastRunStatus: "queued" | "running" | "succeeded" | "failed" | "partial" | "cancelled" | null;
    nextRunAt: string;
    isHeartbeatStale: boolean;
  };
  dailyReportSchedule: {
    key: "daily_report_default";
    enabled: boolean;
    cronExpression: string;
    sourceConcurrency: number;
    fullTextFetchThreshold: number;
    perSourceItemLimit: number;
    aggregationSplitMaxEvents: number;
    dailyReportCandidateLimit: number;
    dailyReportPlanningBatchSize?: number | null;
    dailyReportOffsetDays: number;
    dailyReportRecentTopicLookbackDays?: number;
    dailyReportAutoPublish: boolean;
    dailyReportChannelIds: string[];
    processingStartAt?: string | null;
    cleanupRetentionDays: number;
    timezone: string;
    lastHeartbeatAt: string | null;
    lastRunStartedAt: string | null;
    lastRunFinishedAt: string | null;
    lastRunStatus: "queued" | "running" | "succeeded" | "failed" | "partial" | "cancelled" | null;
    nextRunAt: string;
    isHeartbeatStale: boolean;
  };
  itemCleanupSchedule: {
    key: "item_cleanup_default";
    enabled: boolean;
    cronExpression: string;
    cleanupRetentionDays: number;
    timezone: string;
    lastHeartbeatAt: string | null;
    lastRunStartedAt: string | null;
    lastRunFinishedAt: string | null;
    lastRunStatus: "queued" | "running" | "succeeded" | "failed" | "partial" | "cancelled" | null;
    nextRunAt: string;
    isHeartbeatStale: boolean;
  };
  groups: Array<{
    id: string;
    name: string;
    color: string;
    sortOrder: number;
  }>;
  sources: Array<{
    id: string;
    name: string;
    rssUrl: string;
    siteUrl: string;
    enabled: boolean;
    aiParsingEnabled: boolean;
    aggregationEnabled: boolean;
    aggregationDetectionEnabled: boolean;
    groupId: string | null;
    groupName: string | null;
    lastItemCreatedAt: string | null;
  }>;
};

export type ResolvedSourceMetadata = {
  name: string;
  rssUrl: string;
  siteUrl: string;
  suggestedAiParsingEnabled: boolean;
};

export type OpmlImportFailure = {
  rssUrl: string | null;
  message: string;
};

export type OpmlImportSummary = {
  totalCount: number;
  createdCount: number;
  updatedCount: number;
  failedCount: number;
  failures: OpmlImportFailure[];
};
