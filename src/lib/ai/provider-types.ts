import type { RuntimeConfig } from "@/config/runtime";
import type {
  DailyReportCandidateAssessment,
  DailyReportModelDraft,
  DailyReportPlanSelection,
  DailyReportPlanningCandidate,
  DailyReportPlanningCandidateBrief,
  DailyReportRepairPatchResult,
  DailyReportReviewFeedback,
  DailyReportReviewInput,
  DailyReportReviewResult,
  DailyReportSelectedTopic,
  DailyReportViolation,
  RecentDailyReportTopic,
} from "@/lib/daily-report/types";
import type { NormalizedDailyReportTemplate } from "@/lib/daily-report/template";

export type AiEventSignature = {
  eventType:
    | "release"
    | "launch"
    | "update"
    | "funding"
    | "acquisition"
    | "partnership"
    | "policy"
    | "research"
    | "security"
    | "other"
    | null;
  eventSubject: string | null;
  eventAction: string | null;
  eventObject: string | null;
  eventDate: string | null;
};

export type AiEnrichment = {
  translatedTitle: string | null;
  moderationStatus: "allowed" | "filtered" | "restored";
  moderationReason: "marketing" | "low_quality" | "duplicate_noise" | "rule_filter" | "rule_blacklist" | "other" | null;
  moderationDetail: string | null;
  qualityScore: number;
  qualityRationale: string;
  eventSignature: AiEventSignature;
};

export type ParsedEventSignature = {
  eventType: string | null;
  eventSubject: string | null;
  eventAction: string | null;
  eventObject: string | null;
  eventDate: string | null;
};

export type ParsedEvent = ParsedEventSignature & {
  title: string | null;
  oneLiner: string;
  qualityScore: number;
  sourceUrl: string | null;
};

export type ItemUnderstandingResult = AiEnrichment & {
  summary: string;
  aggregation: {
    isAggregation: boolean;
    mainEvent: ParsedEventSignature | null;
    events: ParsedEvent[];
  };
  diagnostics: {
    summaryValid: boolean;
    analysisValid: boolean;
    aggregationValid: boolean;
  };
};

export type ClusterMergeDecisionVerdict = "approved" | "declined" | "ambiguous";

export const CLUSTER_MERGE_REASON_CODES = [
  "same_event",
  "insufficient_evidence",
  "different_event",
  "object_conflict",
  "action_conflict",
  "date_conflict",
  "subject_conflict",
] as const;

export type ClusterMergeReasonCode = typeof CLUSTER_MERGE_REASON_CODES[number];

export type ClusterMergeDecision = {
  leftClusterId: string;
  rightClusterId: string;
  verdict: ClusterMergeDecisionVerdict;
  confidence: number | null;
  reasonCode: ClusterMergeReasonCode | null;
  reasonText: string | null;
};

export type EntityAliasCheckConfidence = "high" | "medium" | "low";

export type EntityAliasCheckDecision = {
  isSameEntity: boolean;
  confidence: EntityAliasCheckConfidence;
  canonicalName: string | null;
};

export type AiProvider = {
  understandItem(
    inputText: string,
    metadata: { title: string; sourceName?: string; translateTitle: boolean },
  ): Promise<ItemUnderstandingResult>;
  summarizeCluster(inputText: string, metadata: { title: string }): Promise<string>;
  matchClusterCandidate(
    inputText: string,
    metadata: { title: string; candidates: Array<{ id: string; title: string; summary: string }> },
  ): Promise<string | null>;
  /** 语义向量批量接口；未启用或调用失败时返回 null，调用方降级为纯规则排序。个别文本嵌入失败时对应位为 null。 */
  embedTexts?(texts: string[]): Promise<Array<number[] | null> | null>;
  assessClusterMergePairs(clustersJson: string): Promise<ClusterMergeDecision[]>;
  /** 实体别名判定：批量判断两个实体名称是否指同一现实世界主体；未配置时调用方跳过仲裁 */
  assessEntityAliasPairs?(input: {
    pairs: Array<{ aName: string; bName: string; evidence: string[] }>;
  }): Promise<EntityAliasCheckDecision[]>;
  assessDailyReportCandidates(input: {
    candidates: DailyReportPlanningCandidate[];
    template: NormalizedDailyReportTemplate;
    recentTopics: RecentDailyReportTopic[];
    recentTopicLookbackDays?: number;
    stageContext?: DailyReportStageContext;
    validationFeedback?: DailyReportStageValidationFeedback;
  }): Promise<DailyReportCandidateAssessment[]>;
  planDailyReport(input: {
    candidateBriefs: DailyReportPlanningCandidateBrief[];
    template: NormalizedDailyReportTemplate;
    recentTopics?: RecentDailyReportTopic[];
    recentTopicLookbackDays?: number;
    stageContext?: DailyReportStageContext;
    validationFeedback?: DailyReportStageValidationFeedback;
    reviewFeedback?: DailyReportReviewFeedback;
  }): Promise<DailyReportPlanSelection>;
  writeDailyReport(input: {
    selectedTopics: DailyReportSelectedTopic[];
    template: NormalizedDailyReportTemplate;
    stageContext?: DailyReportStageContext;
    validationFeedback?: DailyReportStageValidationFeedback;
    reviewFeedback?: DailyReportReviewFeedback;
  }): Promise<DailyReportModelDraft>;
  repairDailyReportDraft(input: {
    draft: DailyReportModelDraft;
    violations: DailyReportViolation[];
    selectedTopics: DailyReportSelectedTopic[];
    template: NormalizedDailyReportTemplate;
  }): Promise<DailyReportRepairPatchResult>;
  reviewDailyReport(input: DailyReportReviewInput): Promise<DailyReportReviewResult>;
};

export type DailyReportStage = "assess" | "plan" | "write";

export type DailyReportStageMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type DailyReportStageValidationFeedback = {
  type: "VALIDATION_FEEDBACK";
  stage: DailyReportStage;
  violations: DailyReportViolation[];
  missingNotes?: Array<{
    topicId: string;
    noteLabel: string;
    blockKey?: string;
    noteInstruction?: string;
  }>;
  instruction: string;
};

export type DailyReportStageContext = {
  stage: DailyReportStage;
  messages: DailyReportStageMessage[];
  repairRound: number;
  cleanRetryAttempt: number;
  lastOutput: string | null;
  lastViolations: DailyReportViolation[];
  inputHash?: string;
  contextTokenEstimate?: number;
  contextOverflow?: boolean;
};

export function createDailyReportStageContext(stage: DailyReportStage, inputHash?: string): DailyReportStageContext {
  return {
    stage,
    messages: [],
    repairRound: 0,
    cleanRetryAttempt: 0,
    lastOutput: null,
    lastViolations: [],
    ...(inputHash ? { inputHash } : {}),
  };
}

export type CompletionResponse = {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
  };
};

export type OpenAICompatibleClient = {
  chat: {
    completions: {
      create: (payload: Record<string, unknown>) => Promise<CompletionResponse>;
    };
  };
};

export type PromptRuntimeConfig = {
  systemPrompt: string;
  /** User-configurable business instruction. Legacy promptTemplate is accepted only for compatibility. */
  userInstruction?: string;
  promptTemplate?: string;
  /** 结构化配置载荷（item_understanding 存评分规则 JSON），由 settings 序列化层透传。 */
  templateJson?: string | null;
  temperature?: number | null;
  maxTokens?: number | null;
  topP?: number | null;
  modelApi?: RuntimeConfig["modelApi"] | null;
};

export type PromptOverrides = {
  itemUnderstanding?: PromptRuntimeConfig;
  clusterSummary?: PromptRuntimeConfig;
  clusterMatch?: PromptRuntimeConfig;
  clusterMerge?: PromptRuntimeConfig;
  dailyReport?: PromptRuntimeConfig;
  dailyReportReview?: PromptRuntimeConfig | null;
};

export type AiProviderOptions = {
  aggregationSplitMaxEvents?: number;
  /** 每次底层模型调用返回时回调实际（或估算）的 token 用量，用于任务上下文消耗统计。 */
  onUsage?: (usage: AiCallUsage, usageKey?: string) => void;
  /** Embedding 召回配置；缺省或未启用时 provider 不具备 embedTexts 能力。 */
  embedding?: RuntimeConfig["embedding"] | null;
};

export type CompletionResponseFormat = {
  type: "json_object";
};

export type AiCallUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  tokenUsageSource?: "provider" | "estimated" | "mixed";
  model?: string;
  attemptType?: "initial" | "transient_retry" | "json_retry";
};

export type CompletionOptions = {
  responseFormat?: CompletionResponseFormat;
  requireCompleteJson?: boolean;
  messages?: DailyReportStageMessage[];
  usageKey?: string;
  attemptType?: AiCallUsage["attemptType"];
  onUsage?: (usage: AiCallUsage) => void;
};


export class InvalidJsonModelResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidJsonModelResponseError";
  }
}

export function isInvalidJsonModelResponseError(error: unknown): error is InvalidJsonModelResponseError {
  return error instanceof InvalidJsonModelResponseError;
}
