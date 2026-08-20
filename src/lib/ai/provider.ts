import OpenAI from "openai";
import { jsonrepair } from "jsonrepair";

import {
  MODEL_API_CIRCUIT_BREAKER_FAILURE_THRESHOLD,
  MODEL_API_CIRCUIT_BREAKER_OPEN_MS,
  MODEL_API_CIRCUIT_BREAKER_WINDOW_MS,
} from "@/config/constants";
import {
  DEFAULT_DAILY_REPORT_REVIEW_PROMPT,
  ITEM_UNDERSTANDING_FIXED_OUTPUT_RULE,
} from "@/config/prompts";
import {
  buildAiUserContent,
  getAiTaskContract,
  normalizeAiUserInstruction,
} from "@/lib/ai/contracts";
import type { RuntimeConfig } from "@/config/runtime";
import type { PromptConfigType } from "@/lib/settings/types";
import { normalizeModelResponseText } from "@/lib/ai/response-format";
import { requireUsableGeneratedSummary } from "@/lib/ai/summary-quality";
import type {
  DailyReportCandidateAssessment,
  DailyReportDraft,
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
import { DAILY_REPORT_REVIEW_VIOLATION_CODES, isDailyReportNotesRepairableViolation } from "@/lib/daily-report/types";
import type {
  DailyReportTemplateSectionBlock,
  NormalizedDailyReportTemplate,
} from "@/lib/daily-report/template";
import { normalizeOptionalText } from "@/lib/utils/text";

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

type AiEnrichment = {
  translatedTitle: string | null;
  moderationStatus: "allowed" | "filtered" | "restored";
  moderationReason: "marketing" | "low_quality" | "duplicate_noise" | "rule_filter" | "rule_blacklist" | "other" | null;
  moderationDetail: string | null;
  qualityScore: number;
  qualityRationale: string;
  eventSignature: AiEventSignature;
};

type ParsedEventSignature = {
  eventType: string | null;
  eventSubject: string | null;
  eventAction: string | null;
  eventObject: string | null;
  eventDate: string | null;
};

type ParsedEvent = ParsedEventSignature & {
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
  assessClusterMergePairs(clustersJson: string): Promise<ClusterMergeDecision[]>;
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

type CompletionResponse = {
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

type OpenAICompatibleClient = {
  chat: {
    completions: {
      create: (payload: Record<string, unknown>) => Promise<CompletionResponse>;
    };
  };
};

type PromptRuntimeConfig = {
  systemPrompt: string;
  /** User-configurable business instruction. Legacy promptTemplate is accepted only for compatibility. */
  userInstruction?: string;
  promptTemplate?: string;
  temperature?: number | null;
  maxTokens?: number | null;
  topP?: number | null;
  modelApi?: RuntimeConfig["modelApi"] | null;
};

type PromptOverrides = {
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
};

type CompletionResponseFormat = {
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

type CompletionOptions = {
  responseFormat?: CompletionResponseFormat;
  requireCompleteJson?: boolean;
  messages?: DailyReportStageMessage[];
  usageKey?: string;
  attemptType?: AiCallUsage["attemptType"];
  onUsage?: (usage: AiCallUsage) => void;
};

const DEFAULT_PARSED_AGGREGATION_MAX_EVENTS = 20;
const TRANSIENT_MODEL_API_RETRY_COUNT = 1;
const JSON_PARSE_RETRY_COUNT = 1;
const MAX_DAILY_REPORT_REPAIR_TOKENS = 8192;
const DAILY_REPORT_JSON_SYNTAX_RULE =
  "JSON 语法是硬约束：所有字符串内部的双引号必须转义为 \\\"，换行必须转义为 \\n；字段之间的逗号和所有括号必须完整；不要把自然语言示例或 Markdown 放在 JSON 对象外。";

type ModelApiCircuitState = {
  failures: number[];
  openUntil: number;
};

const modelApiCircuitStates = new Map<string, ModelApiCircuitState>();

export class InvalidJsonModelResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidJsonModelResponseError";
  }
}

export function isInvalidJsonModelResponseError(error: unknown): error is InvalidJsonModelResponseError {
  return error instanceof InvalidJsonModelResponseError;
}

function getJsonParseErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown JSON parse error";
}

function buildJsonParseRetryPrompt(userContent: string, error: InvalidJsonModelResponseError) {
  return `${userContent}

重要：上一次输出不是合法 JSON，解析错误：${error.message}
请重新生成，必须只输出一个合法 JSON 对象，不要输出 Markdown、代码块或额外解释。请检查字段之间的逗号、完整闭合的括号，以及字符串内部双引号和换行的 JSON 转义。`;
}

function getClient(config: RuntimeConfig["modelApi"]): OpenAICompatibleClient | null {
  const apiKey = config.apiKey;

  if (!apiKey) {
    return null;
  }

  // The official SDK uses overloaded method signatures that are wider than our
  // lightweight compatibility interface, so we narrow it at the boundary.
  return new OpenAI({
    apiKey,
    baseURL: config.baseURL || undefined,
    defaultHeaders: config.customHeaders,
  }) as unknown as OpenAICompatibleClient;
}

function getErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const maybeError = error as { status?: unknown; statusCode?: unknown; code?: unknown };
  const rawStatus = maybeError.status ?? maybeError.statusCode ?? maybeError.code;

  if (typeof rawStatus === "number" && Number.isInteger(rawStatus)) {
    return rawStatus;
  }

  if (typeof rawStatus === "string" && /^\d+$/.test(rawStatus)) {
    return Number(rawStatus);
  }

  return null;
}

function isTransientModelApiError(error: unknown) {
  const status = getErrorStatus(error);
  if (status !== null) {
    return status === 408 || status === 429 || status >= 500;
  }

  if (!error || typeof error !== "object") {
    return false;
  }

  const maybeError = error as { code?: unknown; name?: unknown; message?: unknown };
  const code = typeof maybeError.code === "string" ? maybeError.code.toLowerCase() : "";
  const name = typeof maybeError.name === "string" ? maybeError.name.toLowerCase() : "";
  const message = typeof maybeError.message === "string" ? maybeError.message.toLowerCase() : "";

  return [
    "abort",
    "timeout",
    "timed out",
    "read timeout",
    "gateway timeout",
    "network",
    "econnreset",
    "etimedout",
    "econnrefused",
    "socket hang up",
  ].some((pattern) => code.includes(pattern) || name.includes(pattern) || message.includes(pattern));
}

function getModelApiCircuitKey(config: RuntimeConfig["modelApi"]) {
  return [config.apiKey, config.baseURL, config.model].join("|");
}

function isSameModelApiConfig(left: RuntimeConfig["modelApi"], right: RuntimeConfig["modelApi"]) {
  return left.apiKey === right.apiKey && left.baseURL === right.baseURL && left.model === right.model;
}

function getCircuitState(config: RuntimeConfig["modelApi"]) {
  const key = getModelApiCircuitKey(config);
  const existing = modelApiCircuitStates.get(key);

  if (existing) {
    return existing;
  }

  const next = { failures: [], openUntil: 0 };
  modelApiCircuitStates.set(key, next);
  return next;
}

function isCircuitOpen(config: RuntimeConfig["modelApi"], now = Date.now()) {
  return getCircuitState(config).openUntil > now;
}

function recordModelApiSuccess(config: RuntimeConfig["modelApi"]) {
  const state = getCircuitState(config);
  state.failures = [];
  state.openUntil = 0;
}

function recordModelApiFailure(config: RuntimeConfig["modelApi"], now = Date.now()) {
  const state = getCircuitState(config);
  const windowStart = now - MODEL_API_CIRCUIT_BREAKER_WINDOW_MS;
  state.failures = [...state.failures.filter((timestamp) => timestamp >= windowStart), now];

  if (state.failures.length >= MODEL_API_CIRCUIT_BREAKER_FAILURE_THRESHOLD) {
    state.openUntil = now + MODEL_API_CIRCUIT_BREAKER_OPEN_MS;
  }

  return state.openUntil > now;
}

function getClientForConfig(
  config: RuntimeConfig["modelApi"],
  cache: Map<string, OpenAICompatibleClient | null>,
): OpenAICompatibleClient | null {
  const cacheKey = [
    config.apiKey,
    config.baseURL,
    config.model,
  ].join("|");

  if (cache.has(cacheKey)) {
    return cache.get(cacheKey) ?? null;
  }

  const client = getClient(config);
  cache.set(cacheKey, client);
  return client;
}

const DAILY_REPORT_MODEL_CANDIDATE_KEYS = [
  "id",
  "clusterId",
  "title",
  "summary",
  "sourceName",
  "qualityScore",
  "candidateScore",
  "sourceCount",
  "itemCount",
  "createdAt",
  "publishedAt",
  "publishedAtKnown",
  "eventType",
  "eventSubject",
  "eventAction",
  "eventObject",
  "eventDate",
  "isFollowUp",
  "newItemCountOnDate",
  "newSourceCountOnDate",
] as const;

const DAILY_REPORT_WRITE_CANDIDATE_KEYS = [
  "id",
  "title",
  "summary",
  "sourceName",
  "publishedAt",
  "publishedAtKnown",
  "eventType",
  "eventSubject",
  "eventAction",
  "eventObject",
  "eventDate",
  "isFollowUp",
  "newItemCountOnDate",
  "newSourceCountOnDate",
] as const;

const DAILY_REPORT_CANDIDATE_FIELD_GUIDE = [
  "id：候选编号；ASSESS 输出的 candidateId 必须原样引用。",
  "title：候选标题；summary：已有中文摘要；sourceName：代表性来源。",
  "qualityScore：内容质量分；candidateScore：本地日报候选排序分；两者都是排序信号，不是事实可信度。",
  "sourceCount：互证来源数；itemCount：候选聚合包含的内容数。",
  "createdAt：系统入库时间；publishedAt：源站发布时间；publishedAtKnown：发布时间是否可靠。",
  "eventType/eventSubject/eventAction/eventObject/eventDate：系统已有的结构化事件线索，优先作为事实线索，不要重新发明事件。",
  "isFollowUp：是否是已有主题的事实增量；newItemCountOnDate/newSourceCountOnDate：日报日期新增内容和来源数量。",
  "evidenceItems：候选的简短来源证据；只读取其中的 title/sourceName/publishedAt 核对事实，不要逐条复述。",
].join("\n");

const DAILY_REPORT_ASSESSMENT_FIELD_GUIDE = [
  "candidateId：输入候选的 id；isWorthReading：是否进入 PLAN；relevanceScore：0 到 100 的选题相关性分。",
  "suggestedBlockKey：建议的 section blockKey，必须来自模板 sections，无法判断时为 null；它只是软提示，最终以 PLAN 和本地校验为准。",
  "historyDecision：与 recentTopics 比较后的历史关系，只能是 new、duplicate、follow_up 或 uncertain。duplicate 表示近期开过的日报已覆盖同一事件；follow_up 表示同一事件有新的动作、事实、数据或影响；new 表示新事件；uncertain 表示无法确定。",
  "matchedRecentTopicTitle：当 historyDecision=duplicate 时，填写命中的历史主题标题；其他情况必须为 null。它只用于人工追溯，不改变去重判断。",
  "template.sections 中 blockKey 是稳定栏目键，blockTitle 只是展示名，description 是选题方向；只根据栏目语义判断 suggestedBlockKey。",
  "template.historyTopicRules：后台配置的历史主题判断策略，只用于辅助判断重复报道和后续进展；不改变系统硬过滤、历史数据来源或输出枚举。",
  "recentTopics 是完整的近期已发布日报主题集合。逐一将每个候选与整个集合比较，不要假设代码已经提供了候选与历史主题的关联关系；不要因为主体、来源或 cluster 相同就直接判定重复。",
  "只返回上述六个字段，不附带其他解释字段。",
].join("\n");

const DAILY_REPORT_PLAN_TOPIC_CONTRACT = [
  "主题单位是一个独立事实命题，不是一个栏目主题、行业方向或资讯合集。一个 topic 默认只表达一个主体、一个具体动作、一个对象，以及一个结果或状态变化。",
  "只有以下情况允许把多个候选放入同一个 topic：它们报道同一具体事件、同一次发布或版本变化、同一个项目的同一项能力、同一安全事故、同一份研究/报告/数据集，或同一个产品变化的互证来源。",
  "同一栏目、同属 AI/Agent/开源/研究/安全、同一公司、同一技术方向、同一天发布、能够共同支持一个宏观趋势，都不足以证明是同一 topic。",
  "如果候选的事件主体、动作或对象明显不同，且不是同一事实的互证来源，必须拆成多个 topic；不允许生成工具合集、研究合集、风险合集或其他资讯汇总。",
  "跨 cluster 合并只能在候选明确指向同一具体事实时使用；cluster 只是上游来源聚合线索，不是合并许可。无法确认时宁可拆开。",
  "归类分两步执行：先从全部通过评估的候选中按重要性挑选“热点事件”，热点事件可以跨越产品、研究、安全、开源等内容类型，但必须是独立事实，且进入热点事件的 topic 不得再出现在其他栏目；热点栏目不足时不要用低价值合集凑数。",
  "对未进入热点事件的候选，再按主要事实类型归类：具体安全事故/漏洞/隐私/合规/滥用归安全与风险；研究/报告/财报/数据集/量化发现归数据与洞察；单个开源项目/工具/模型/仓库的发布或能力变化归开源与工具；产品/模型/服务/工程实践的发布、升级、接入或收购归变更与实践；无法归入前述类型但有明确事实增量的单条内容才归其他值得看。",
  "同一 topic 只能进入一个栏目；如果候选同时符合多个专业类型，优先按安全与风险、数据与洞察、开源与工具、变更与实践的顺序归类。热点事件只按重要性优先选入，不是专业类型的覆盖许可。",
  "数量是硬约束，不是候选池提示：template.sections[].topics 只表示最终要写入日报的主题，不得输出待裁剪主题。每个 section 的 topics 数量必须在 minItems 与 maxItems 之间：不能超过 maxItems，达到 maxItems 后立即停止继续添加；可选栏目在可规划候选充足且有足够高价值候选时，应尽量接近 maxItems，而不是只输出少量主题；候选不足时不要为了凑数补造、合并合集或选择低价值候选。",
].join("\n");

const DAILY_REPORT_PLAN_FIELD_GUIDE = [
  "candidateBriefs[]：每个元素对应一个通过 ASSESS 的候选；PLAN 必须基于这些候选重新归纳最终日报主题，不要沿用或假设任何预先主题分组。",
  "candidateBriefs[].candidateId：候选编号，输出时必须原样引用；title：候选标题；summaryExcerpt：有界摘要片段，可能为空且不是全文。",
  "candidateBriefs[].clusterId：上游事件聚合编号，只表示已有来源聚合，不等于最终日报主题；只有确认是同一具体事实时才允许跨 cluster 合并。",
  "candidateBriefs[].sourceName/evidenceItems：代表来源和有限证据线索；candidateScore/qualityScore/relevanceScore/sourceCount/itemCount：排序、质量、相关性、互证来源数和聚合条目数，都是判断信号，不是事实。",
  "candidateBriefs[].publishedAt/publishedAtKnown：源站时间及其可靠性；isFollowUp/newItemCountOnDate/newSourceCountOnDate：后续进展及日报日期新增量信号。",
  "candidateBriefs[].historyDecision：ASSESS 对历史日报的判断；new、follow_up 是可规划候选，duplicate 不应出现在 candidateBriefs，uncertain 需要结合其他字段判断。",
  "candidateBriefs[].eventType/eventSubject/eventAction/eventObject/eventDate：已有结构化事件线索，只用于理解和比较；不得补造输入之外的事实。预算压缩时可选字段可能省略，但 candidateId、title、candidateScore、relevanceScore、sourceCount、itemCount 和 publishedAt 会保留。",
  "template.historyTopicRules：后台配置的历史主题判断策略，只用于辅助识别重复事件或后续进展；recentTopics 是代码提供的历史主题数据，不是本期候选。",
  "recentTopics：近期开过的日报条目，仅用于识别重复事件或后续进展；不要把它们当作本期候选。输入中的 candidateBriefs 已经是 ASSESS 通过的候选全集。",
  "template.sections[].blockKey 是唯一栏目键；blockTitle 仅用于理解栏目，description 是栏目意图，required/minItems/maxItems 是最终主题数量的硬约束；topics 不是候选池，不能先输出全部候选再交给代码裁剪。每个 section 只能返回最终要保留的 topics，数量必须在 minItems 与 maxItems 之间：达到 maxItems 后立即停止；可选栏目在可规划候选充足且有足够高价值候选时，应尽量接近 maxItems，而不是只输出少量主题；不能为了凑数选择低价值候选。",
  "输出 sections[].topics[]：每个 topic 的 candidateIds 表示同一个最终日报主题的全部候选来源；一个候选只能属于一个主题。topicId 由代码生成，不要输出。",
].join("\n");

const DAILY_REPORT_WRITE_FIELD_GUIDE = [
  "selectedTopics[]：每个元素对应一个最终日报条目；topicId 是内部主题编号，blockKey 是唯一栏目键，candidateIds 是只读的主题候选编号，representativeCandidateId 是代码选出的代表候选。WRITE 不得改变这些映射。",
  "selectedTopics[].requiredNotes：当前栏目对该主题要求输出的必填要点；每个 label 必须在 item.notes 中原样出现一次，并填写基于候选事实的非空 text。正文中已经出现相关事实时，也不能省略对应 notes。",
  "selectedTopics[].candidates：只包含写作所需事实；id 是只读候选编号，title 是标题，summary 是已有摘要，sourceName 是代表来源。",
  "selectedTopics[].candidates[].publishedAt/publishedAtKnown：源站时间及其可靠性；eventType/eventSubject/eventAction/eventObject/eventDate：已有结构化事件线索；isFollowUp/newItemCountOnDate/newSourceCountOnDate：后续进展信号。",
  "selectedTopics[].candidates[].evidenceItems：有限来源证据，包含标题、来源、摘要片段和发布时间；只用于核对事实，不逐条复述。",
  "候选字段只用于基于事实写作；不要把内部编号、来源名、时间或事件线索扩写成输入之外的事实。",
  "template.writingRules：后台配置的正文表达和信息侧重规则；只影响写作方式，不包含阶段流程、Topic-Candidate 映射或输出协议。",
  "每个 selectedTopics[] 必须生成一个 section item；item.topicId 必须原样复制对应 topicId；不要输出 sourceIds、candidateIds 或其他来源映射字段，来源关系由代码根据 Topic 映射生成。",
  "template.blocks：完整栏目与正文规则；text block 只写模板定义的文本块，section block 按 type/key/title、item.bodyInstruction/bodyRequired 和 notes 规则输出。",
  "输出结构：输出 JSON 对象本身就是日报内容，顶层必须直接包含 headline 和 blocks。合法结构为 {\"headline\":\"...\",\"blocks\":[...]}；禁止使用 draft、result、data、output 等外层包装键。",
].join("\n");

const DAILY_REPORT_REVIEW_FEEDBACK_GUIDE = [
  "reviewFeedback：仅在 Review 触发的重试中出现，包含上一次审核发现的问题、输入证据和具体修复指导。它是系统维护的定向反馈，不是用户可编辑的输出协议。",
  "reviewFeedback.violations：优先处理 severity=error 的问题；每条 guidance 都是下一次重试的修复方向，必须结合 evidence 和当前阶段输入执行，不得臆测输入之外的事实。",
  "PLAN 重试可以调整主题归纳、候选覆盖和栏目分配；WRITE 重试只能在 selectedTopics 和候选证据范围内修正正文、主题表达和重复内容，不得改变主题候选关系或补造事实。",
  "如果某条指导与当前阶段职责冲突，保留当前阶段边界并在可执行范围内修复；不能因为 reviewFeedback 而输出内部协议、解释文字或额外字段。",
].join("\n");

const DAILY_REPORT_REPAIR_FIELD_GUIDE = [
  "input.draft：待修复日报，仅用于查看现有条目的 notes；不要重写其中的 headline、blocks、正文、主题、候选、栏目或顺序。",
  "violations：本地校验指出的具体问题；code/stage/message 描述原因，blockKey/topicId/candidateIds/itemIndex/itemTitle/noteLabel/noteInstruction 用于精确定位。",
  "missingNotes：按 topicId + noteLabel 列出必须补齐的 notes；每个目标只补对应 label，不要扩大影响范围。",
  "repairTargets：受影响主题及其候选事实；requiredNotes 是该主题允许补齐的必填要点，candidates 是唯一可用的事实来源。",
  "template.blocks：模板定义的 block 和 notes 规则；只按 violation 补齐缺失字段。template.writingRules 只影响表达方式，不能改变修复范围或数据关系。",
  "只修复 violations 指定的问题，不重新归纳主题、不改写正文、不新增来源或栏目。",
  "输出结构：只返回 {\"patches\":[{\"topicId\":\"...\",\"notes\":[{\"label\":\"...\",\"text\":\"...\"}]}]}；不要返回 headline、blocks、draft、result、data、output 或 sourceIds。",
].join("\n");

function compactDailyReportModelCandidate(article: unknown) {
  if (!article || typeof article !== "object" || Array.isArray(article)) {
    return article;
  }

  const input = article as Record<string, unknown>;
  const candidate = Object.fromEntries(
    DAILY_REPORT_MODEL_CANDIDATE_KEYS
      .filter((key) => key in input)
      .map((key) => [key, input[key]]),
  ) as Record<string, unknown>;

  if (Array.isArray(input.evidenceItems)) {
    candidate.evidenceItems = input.evidenceItems
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
      .map((item) => Object.fromEntries(
        ["title", "sourceName", "publishedAt"]
          .filter((key) => key in item)
          .map((key) => [key, item[key]]),
      ));
  }

  return candidate;
}

function truncateDailyReportWritingText(value: unknown, maxChars: number) {
  if (typeof value !== "string") return value;
  const normalized = value.trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`;
}

function compactDailyReportWritingCandidate(article: unknown) {
  if (!article || typeof article !== "object" || Array.isArray(article)) return article;
  const input = article as Record<string, unknown>;
  const candidate = Object.fromEntries(
    DAILY_REPORT_WRITE_CANDIDATE_KEYS
      .filter((key) => key in input)
      .map((key) => [key, key === "title" ? truncateDailyReportWritingText(input[key], 180) : key === "summary" ? truncateDailyReportWritingText(input[key], 2400) : ["eventSubject", "eventAction", "eventObject"].includes(key) ? truncateDailyReportWritingText(input[key], 240) : input[key]]),
  ) as Record<string, unknown>;
  if (Array.isArray(input.evidenceItems)) {
    candidate.evidenceItems = input.evidenceItems
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
      .slice(0, 3)
      .map((item) => ({
        title: truncateDailyReportWritingText(item.title, 180),
        sourceName: truncateDailyReportWritingText(item.sourceName, 100),
        summaryExcerpt: truncateDailyReportWritingText(item.summary ?? item.summaryExcerpt, 360),
        publishedAt: item.publishedAt,
      }));
  }
  return candidate;
}

function stripDailyReportSourceIdsForModel(draft: DailyReportModelDraft | DailyReportDraft): DailyReportModelDraft {
  return {
    ...draft,
    blocks: draft.blocks.map((block) => block.type === "section"
      ? {
          ...block,
          items: block.items.map((item) => Object.fromEntries(
            Object.entries(item).filter(([key]) => key !== "sourceIds"),
          )),
        }
      : block),
  } as DailyReportModelDraft;
}

function getFallbackEnrichment(
  metadata: { title: string; translateTitle: boolean },
): AiEnrichment {
  return {
    translatedTitle: metadata.translateTitle ? metadata.title : null,
    moderationStatus: "allowed",
    moderationReason: null,
    moderationDetail: null,
    qualityScore: 50,
    qualityRationale: "AI analysis unavailable",
    eventSignature: {
      eventType: null,
      eventSubject: null,
      eventAction: null,
      eventObject: null,
      eventDate: null,
    },
  };
}

function getFallbackUnderstanding(
  metadata: { title: string; translateTitle: boolean },
): ItemUnderstandingResult {
  return {
    ...getFallbackEnrichment(metadata),
    summary: "",
    aggregation: { isAggregation: false, mainEvent: null, events: [] },
    diagnostics: {
      summaryValid: false,
      analysisValid: false,
      aggregationValid: false,
    },
  };
}

function isValidQualityScore(value: unknown) {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;

  return Number.isFinite(numeric) && numeric >= 0 && numeric <= 100;
}

function hasCompleteParsedEvent(event: ParsedEvent) {
  return Boolean(
    event.title &&
    event.oneLiner &&
    event.eventSubject &&
    event.eventAction &&
    event.eventObject &&
    isValidQualityScore(event.qualityScore),
  );
}

function parseItemUnderstandingOutput(
  rawContent: string,
  inputText: string,
  fallback: ItemUnderstandingResult,
  translateTitle: boolean,
  maxEvents: number,
): ItemUnderstandingResult {
  const normalized = normalizeModelResponseText(rawContent);
  let parsed: Record<string, unknown>;

  try {
    parsed = JSON.parse(normalized) as Record<string, unknown>;
  } catch (initialError) {
    try {
      parsed = JSON.parse(jsonrepair(normalized)) as Record<string, unknown>;
      console.warn(
        `[AI Provider] Repaired invalid item understanding JSON (length=${normalized.length}, initialError=${getJsonParseErrorMessage(initialError)})`,
      );
    } catch (repairError) {
      throw new InvalidJsonModelResponseError(
        `统一条目理解模型返回了无法解析的 JSON（长度 ${normalized.length}）：${getJsonParseErrorMessage(initialError)}；本地修复失败：${getJsonParseErrorMessage(repairError)}`,
      );
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidJsonModelResponseError("统一条目理解 JSON 顶层必须是对象。");
  }

  let summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  let summaryValid = false;
  if (summary) {
    try {
      summary = requireUsableGeneratedSummary(summary, inputText);
      summaryValid = true;
    } catch {
      summary = "";
    }
  }

  const analysisValid =
    (parsed.moderationStatus === "allowed" || parsed.moderationStatus === "filtered") &&
    isValidQualityScore(parsed.qualityScore) &&
    typeof parsed.qualityRationale === "string" &&
    parsed.qualityRationale.trim().length > 0;
  const enrichment = buildEnrichmentFromParsed(
    parsed as Parameters<typeof buildEnrichmentFromParsed>[0],
    fallback,
    translateTitle,
  );
  const rawAggregation = parsed.aggregation && typeof parsed.aggregation === "object"
    ? parsed.aggregation as Record<string, unknown>
    : null;
  const isAggregation = rawAggregation?.isAggregation === true;
  const events = Array.isArray(rawAggregation?.events)
    ? rawAggregation.events
        .map((event) => normalizeParsedEvent(event as Partial<ParsedEvent>))
        .filter((event): event is ParsedEvent => event !== null)
        .filter(hasCompleteParsedEvent)
        .slice(0, maxEvents)
    : [];
  const mainEvent = normalizeParsedEventSignature(
    rawAggregation?.mainEvent as Partial<ParsedEventSignature> | null | undefined,
  );
  const aggregationValid = Boolean(
    rawAggregation &&
    typeof rawAggregation.isAggregation === "boolean" &&
    (!isAggregation || events.length > 0),
  );
  return {
    ...enrichment,
    summary,
    aggregation: aggregationValid
      ? { isAggregation, mainEvent, events: isAggregation ? events : [] }
      : fallback.aggregation,
    diagnostics: {
      summaryValid,
      analysisValid,
      aggregationValid,
    },
  };
}

function parseClusterSummaryOutput(rawContent: string): string {
  const normalized = normalizeModelResponseText(rawContent);
  let parsed: { title?: unknown; summary?: unknown };

  try {
    parsed = JSON.parse(normalized) as { title?: unknown; summary?: unknown };
  } catch (error) {
    throw new InvalidJsonModelResponseError(
      `聚合摘要模型返回了无法解析的 JSON：${getJsonParseErrorMessage(error)}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidJsonModelResponseError("聚合摘要 JSON 顶层必须是对象。");
  }

  const unknownFields = Object.keys(parsed).filter((key) => key !== "title" && key !== "summary");
  if (unknownFields.length > 0) {
    throw new InvalidJsonModelResponseError(`聚合摘要 JSON 包含未知字段：${unknownFields.join(", ")}`);
  }

  const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";

  if (!title || !summary) {
    throw new InvalidJsonModelResponseError("聚合摘要 JSON 必须包含非空的 title 和 summary。");
  }

  return JSON.stringify({ title, summary });
}

function normalizeAggregationSplitMaxEvents(value: number | null | undefined) {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_PARSED_AGGREGATION_MAX_EVENTS;
}

function normalizeParsedEventSignature(
  raw: Partial<ParsedEventSignature> | null | undefined,
): ParsedEventSignature | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  return {
    eventType: normalizeEventType(raw.eventType ?? null),
    eventSubject: typeof raw.eventSubject === "string" ? raw.eventSubject.trim() || null : null,
    eventAction: typeof raw.eventAction === "string" ? raw.eventAction.trim() || null : null,
    eventObject: typeof raw.eventObject === "string" ? raw.eventObject.trim() || null : null,
    eventDate: normalizeEventDate(raw.eventDate ?? null),
  };
}

function normalizeParsedEvent(raw: Partial<ParsedEvent>): ParsedEvent | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const signature = normalizeParsedEventSignature(raw);
  const title = typeof raw.title === "string" ? raw.title.trim().slice(0, 120) || null : null;
  const oneLiner = typeof raw.oneLiner === "string" ? raw.oneLiner.trim() : "";

  if (!title || !oneLiner || !isValidQualityScore(raw.qualityScore)) {
    return null;
  }

  if (!signature) {
    return {
      eventType: null,
      eventSubject: null,
      eventAction: null,
      eventObject: null,
      eventDate: null,
      title,
      oneLiner,
      qualityScore: normalizeScore(raw.qualityScore, 50),
      sourceUrl: normalizeSourceUrl(raw.sourceUrl ?? null),
    };
  }

  return {
    eventType: signature.eventType,
    eventSubject: signature.eventSubject,
    eventAction: signature.eventAction,
    eventObject: signature.eventObject,
    eventDate: signature.eventDate,
    title,
    oneLiner,
    qualityScore: normalizeScore(raw.qualityScore, 50),
    sourceUrl: normalizeSourceUrl(raw.sourceUrl ?? null),
  };
}

function normalizeModerationStatus(value: string | null | undefined): AiEnrichment["moderationStatus"] {
  return value === "filtered" || value === "restored" ? value : "allowed";
}

function normalizeModerationReason(value: string | null | undefined): AiEnrichment["moderationReason"] {
  return value === "marketing" ||
    value === "low_quality" ||
    value === "duplicate_noise" ||
    value === "rule_filter" ||
    value === "rule_blacklist" ||
    value === "other"
    ? value
    : null;
}

function normalizeScore(value: number | string | null | undefined, fallback: number): number {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;

  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function normalizeEventType(value: string | null | undefined): AiEventSignature["eventType"] {
  return value === "release" ||
    value === "launch" ||
    value === "update" ||
    value === "funding" ||
    value === "acquisition" ||
    value === "partnership" ||
    value === "policy" ||
    value === "research" ||
    value === "security" ||
    value === "other"
    ? value
    : null;
}

function normalizeEventDate(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

function normalizeSourceUrl(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function buildEventSignatureFromParsed(
  parsed: {
    eventType?: string | null;
    eventSubject?: string | null;
    eventAction?: string | null;
    eventObject?: string | null;
    eventDate?: string | null;
    eventSignature?: {
      eventType?: string | null;
      eventSubject?: string | null;
      eventAction?: string | null;
      eventObject?: string | null;
      eventDate?: string | null;
    } | null;
  },
  fallback: AiEventSignature,
): AiEventSignature {
  const parsedSignature = parsed.eventSignature ?? {};

  return {
    eventType: normalizeEventType(parsed.eventType ?? parsedSignature.eventType) ?? fallback.eventType,
    eventSubject: normalizeOptionalText(parsed.eventSubject ?? parsedSignature.eventSubject, fallback.eventSubject),
    eventAction: normalizeOptionalText(parsed.eventAction ?? parsedSignature.eventAction, fallback.eventAction),
    eventObject: normalizeOptionalText(parsed.eventObject ?? parsedSignature.eventObject, fallback.eventObject),
    eventDate: normalizeEventDate(parsed.eventDate ?? parsedSignature.eventDate) ?? fallback.eventDate,
  };
}

function buildEnrichmentFromParsed(
  parsed: {
    translatedTitle?: string | null;
    moderationStatus?: string | null;
    moderationReason?: string | null;
    moderationDetail?: string | null;
    qualityScore?: number | string | null;
    qualityRationale?: string | null;
    eventType?: string | null;
    eventSubject?: string | null;
    eventAction?: string | null;
    eventObject?: string | null;
    eventDate?: string | null;
    eventSignature?: {
      eventType?: string | null;
      eventSubject?: string | null;
      eventAction?: string | null;
      eventObject?: string | null;
      eventDate?: string | null;
    } | null;
  },
  fallback: AiEnrichment,
  translateTitle: boolean,
): AiEnrichment {
  return {
    translatedTitle: translateTitle ? parsed.translatedTitle?.trim() || fallback.translatedTitle : null,
    moderationStatus: normalizeModerationStatus(parsed.moderationStatus),
    moderationReason: normalizeModerationReason(parsed.moderationReason),
    moderationDetail: parsed.moderationDetail?.trim() || fallback.moderationDetail,
    qualityScore: normalizeScore(parsed.qualityScore, fallback.qualityScore),
    qualityRationale: parsed.qualityRationale?.trim() || fallback.qualityRationale,
    eventSignature: buildEventSignatureFromParsed(parsed, fallback.eventSignature),
  };
}

type ClusterMergeInputMetadata = {
  allowedPairKeys: Set<string>;
};

function buildClusterMergePairKey(leftId: string, rightId: string) {
  return [leftId, rightId].sort().join("\u0000");
}

function getClusterIdFromUnknown(value: unknown) {
  return value && typeof value === "object" && "id" in value && typeof value.id === "string" ? value.id : null;
}

function buildClusterMergeGroupsFromApprovedEdges(
  approvedEdges: Array<[string, string]>,
  metadata: { itemCounts: Map<string, number>; preservePairOrder?: boolean },
) {
  const adjacency = new Map<string, Set<string>>();

  for (const [leftId, rightId] of approvedEdges) {
    if (!adjacency.has(leftId)) {
      adjacency.set(leftId, new Set());
    }
    if (!adjacency.has(rightId)) {
      adjacency.set(rightId, new Set());
    }
    adjacency.get(leftId)!.add(rightId);
    adjacency.get(rightId)!.add(leftId);
  }

  const visited = new Set<string>();
  const groups: string[][] = [];

  for (const clusterId of adjacency.keys()) {
    if (visited.has(clusterId)) {
      continue;
    }

    const component: string[] = [];
    const stack = [clusterId];
    visited.add(clusterId);

    while (stack.length > 0) {
      const currentId = stack.pop()!;
      component.push(currentId);

      for (const nextId of adjacency.get(currentId) ?? []) {
        if (!visited.has(nextId)) {
          visited.add(nextId);
          stack.push(nextId);
        }
      }
    }

    if (component.length < 2) {
      continue;
    }

    const targetId = [...component].sort((leftId, rightId) => {
      const itemCountDiff = (metadata.itemCounts.get(rightId) ?? 0) - (metadata.itemCounts.get(leftId) ?? 0);
      return itemCountDiff || (metadata.preservePairOrder ? 0 : leftId.localeCompare(rightId));
    })[0]!;
    const directSources = [...(adjacency.get(targetId) ?? [])].sort((leftId, rightId) => {
      const itemCountDiff = (metadata.itemCounts.get(rightId) ?? 0) - (metadata.itemCounts.get(leftId) ?? 0);
      return itemCountDiff || (metadata.preservePairOrder ? 0 : leftId.localeCompare(rightId));
    });

    if (directSources.length > 0) {
      groups.push([targetId, ...directSources]);
    }
  }

  return groups;
}

export function buildClusterMergeGroupsFromDecisions(
  decisions: Array<Pick<ClusterMergeDecision, "leftClusterId" | "rightClusterId" | "verdict">>,
  itemCounts: Map<string, number>,
) {
  return buildClusterMergeGroupsFromApprovedEdges(
    decisions
      .filter((decision) => decision.verdict === "approved")
      .map((decision) => [decision.leftClusterId, decision.rightClusterId]),
    { itemCounts, preservePairOrder: true },
  );
}

function parseClusterMergeInputMetadata(clustersJson: string): ClusterMergeInputMetadata {
  const parsed = JSON.parse(clustersJson) as unknown;
  const allowedPairKeys = new Set<string>();

  const addCluster = (entry: unknown) => {
    if (!entry || typeof entry !== "object" || !("id" in entry) || typeof entry.id !== "string") {
      return null;
    }

    return entry.id;
  };

  const addPair = (leftId: unknown, rightId: unknown) => {
    if (typeof leftId === "string" && typeof rightId === "string" && leftId !== rightId) {
      allowedPairKeys.add(buildClusterMergePairKey(leftId, rightId));
    }
  };

  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      addCluster(entry);
    }
    return { allowedPairKeys };
  }

  if (parsed && typeof parsed === "object") {
    if ("clusters" in parsed && Array.isArray(parsed.clusters)) {
      for (const entry of parsed.clusters) {
        addCluster(entry);
      }
    }

    if ("allowedPairs" in parsed && Array.isArray(parsed.allowedPairs)) {
      for (const pair of parsed.allowedPairs) {
        if (pair && typeof pair === "object") {
          addPair("leftId" in pair ? pair.leftId : null, "rightId" in pair ? pair.rightId : null);
        }
      }
    }

    if ("pairs" in parsed && Array.isArray(parsed.pairs)) {
      for (const pair of parsed.pairs) {
        if (!pair || typeof pair !== "object") {
          continue;
        }

        const leftId = "left" in pair ? addCluster(pair.left) : null;
        const rightId = "right" in pair ? addCluster(pair.right) : null;
        addPair(leftId, rightId);
      }
    }
  }

  return { allowedPairKeys };
}

function normalizeClusterMergeConfidence(value: unknown) {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;

  if (!Number.isFinite(numeric)) {
    return null;
  }

  const percentage = numeric >= 0 && numeric <= 1 ? numeric * 100 : numeric;
  return Math.max(0, Math.min(100, Math.round(percentage)));
}

function normalizeClusterMergeDecision(
  rawDecision: unknown,
  metadata: ClusterMergeInputMetadata,
): ClusterMergeDecision | null {
  if (!rawDecision || typeof rawDecision !== "object" || Array.isArray(rawDecision)) {
    return null;
  }

  const decision = rawDecision as Record<string, unknown>;
  const leftId = decision.leftClusterId ?? decision.leftId ?? decision.sourceId ?? getClusterIdFromUnknown(decision.left);
  const rightId = decision.rightClusterId ?? decision.rightId ?? decision.targetId ?? getClusterIdFromUnknown(decision.right);
  const verdict = decision.verdict;
  const reasonCode = normalizeClusterMergeReasonCode(decision.reasonCode);

  if (
    typeof leftId !== "string" ||
    typeof rightId !== "string" ||
    leftId === rightId ||
    !metadata.allowedPairKeys.has(buildClusterMergePairKey(leftId, rightId)) ||
    (verdict !== "approved" && verdict !== "declined" && verdict !== "ambiguous")
  ) {
    return null;
  }

  return {
    leftClusterId: leftId,
    rightClusterId: rightId,
    verdict,
    confidence: normalizeClusterMergeConfidence(decision.confidence),
    reasonCode,
    reasonText: typeof decision.reasonText === "string" ? decision.reasonText.trim() || null : null,
  };
}

function normalizeClusterMergeReasonCode(value: unknown): ClusterMergeReasonCode | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return (CLUSTER_MERGE_REASON_CODES as readonly string[]).includes(normalized)
    ? normalized as ClusterMergeReasonCode
    : null;
}

function parseClusterMergeDecisions(rawContent: string, metadata: ClusterMergeInputMetadata) {
  const normalized = normalizeModelResponseText(rawContent);
  let parsed: { decisions?: unknown };

  try {
    parsed = JSON.parse(normalized) as { decisions?: unknown };
  } catch (error) {
    throw new InvalidJsonModelResponseError(
      `Invalid cluster merge decision JSON: ${getJsonParseErrorMessage(error)}`,
    );
  }

  const decisions: ClusterMergeDecision[] = [];
  const seenPairKeys = new Set<string>();

  if (!Array.isArray(parsed.decisions)) {
    throw new InvalidJsonModelResponseError(
      'Cluster merge decision JSON must contain a "decisions" array.',
    );
  }

  for (const rawDecision of parsed.decisions) {
    const decision = normalizeClusterMergeDecision(rawDecision, metadata);
    if (!decision) {
      throw new InvalidJsonModelResponseError("聚合合并 decisions 包含无效或不在输入 Pair 中的决定。");
    }

    const pairKey = buildClusterMergePairKey(decision.leftClusterId, decision.rightClusterId);
    if (seenPairKeys.has(pairKey)) {
      throw new InvalidJsonModelResponseError("聚合合并 decisions 不能重复判断同一个 Pair。");
    }

    seenPairKeys.add(pairKey);
    decisions.push(decision);
  }

  if (seenPairKeys.size !== metadata.allowedPairKeys.size) {
    throw new InvalidJsonModelResponseError("聚合合并 decisions 必须逐一覆盖输入中的每个 Pair。");
  }

  return decisions;
}

function parseClusterMatchCandidateId(rawContent: string, candidateIds: string[]): string | null {
  const normalized = normalizeModelResponseText(rawContent);
  let parseError: unknown = null;

  try {
    const parsed = JSON.parse(normalized) as { clusterId?: unknown };
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("clusterId" in parsed)) {
      throw new InvalidJsonModelResponseError('归组判定 JSON 必须包含 "clusterId" 字段。');
    }
    if (parsed.clusterId !== null && typeof parsed.clusterId !== "string") {
      throw new InvalidJsonModelResponseError('归组判定 "clusterId" 必须是字符串或 null。');
    }
    const clusterId = typeof parsed.clusterId === "string" ? parsed.clusterId.trim() : "";

    if (clusterId && candidateIds.includes(clusterId)) {
      return clusterId;
    }
  } catch (error) {
    parseError = error;
    // Fall through to tolerant parsing below.
  }

  const clusterIdMatch = normalized.match(/"?clusterId"?\s*:\s*(?:"([^"]*)"|'([^']*)'|([^,\n}]+))/i);
  const clusterId = (clusterIdMatch?.[1] ?? clusterIdMatch?.[2] ?? clusterIdMatch?.[3] ?? "").trim();

  if (clusterId && candidateIds.includes(clusterId)) {
    return clusterId;
  }

  if (parseError) {
    throw new InvalidJsonModelResponseError(
      `Invalid cluster match JSON: ${getJsonParseErrorMessage(parseError)}`,
    );
  }

  return null;
}

function resolvePromptConfig(
  type: PromptConfigType,
  runtimeOverride: PromptRuntimeConfig | undefined,
): PromptRuntimeConfig {
  const contract = getAiTaskContract(type);
  if (runtimeOverride) {
    return {
      // The persisted systemPrompt is legacy data and is deliberately ignored.
      systemPrompt: contract.systemPrompt,
      userInstruction: type === "daily_report"
        ? ""
        : normalizeAiUserInstruction(
            runtimeOverride.userInstruction ?? runtimeOverride.promptTemplate ?? contract.defaultUserInstruction,
          ),
      temperature: runtimeOverride.temperature,
      maxTokens: runtimeOverride.maxTokens,
      topP: runtimeOverride.topP,
      modelApi: runtimeOverride.modelApi,
    };
  }

  return {
    systemPrompt: contract.systemPrompt,
    userInstruction: type === "daily_report" ? "" : contract.defaultUserInstruction,
  };
}

async function completeText(
  client: OpenAICompatibleClient,
  config: RuntimeConfig["modelApi"],
  promptConfig: PromptRuntimeConfig,
  userContent: string,
  options?: CompletionOptions,
): Promise<{ text: string; usage: AiCallUsage | null }> {
  const messages = options?.messages ?? [
    {
      role: "system",
      content: promptConfig.systemPrompt,
    },
    {
      role: "user",
      content: userContent,
    },
  ];
  const request: Record<string, unknown> = {
    model: config.model,
    messages,
    max_tokens: promptConfig.maxTokens ?? undefined,
    temperature: promptConfig.temperature ?? undefined,
    top_p: promptConfig.topP ?? undefined,
    response_format: options?.responseFormat,
  };

  // MiniMax exposes a provider-specific thinking switch. OpenAI's Chat
  // Completions endpoint does not accept this field; for non-MiniMax models,
  // omitting it is the compatible equivalent of keeping thinking disabled.
  const normalizedBaseUrl = config.baseURL.toLowerCase();
  const normalizedModel = config.model.toLowerCase();
  if (normalizedBaseUrl.includes("minimax") || normalizedModel.includes("minimax")) {
    request.thinking = { type: "disabled" };
  }

  const response = await client.chat.completions.create(request) as CompletionResponse;
  const rawText = response.choices?.[0]?.message?.content?.trim() ?? "";
  const usage = normalizeCompletionUsage(
    response.usage,
    messages,
    rawText,
    config,
    options?.attemptType ?? "initial",
  );
  options?.onUsage?.(usage);

  const choice = response.choices?.[0];
  const message = choice?.message;
  const content = message?.content?.trim();
  const reasoningContent = message?.reasoning_content?.trim();

  if (options?.requireCompleteJson && choice?.finish_reason === "length") {
    throw new InvalidJsonModelResponseError(
      `模型 JSON 输出被截断（finish_reason=length，content=${content?.length ?? 0} 字符，reasoning=${reasoningContent?.length ?? 0} 字符）`,
    );
  }

  if (content) {
    const text = normalizeModelResponseText(content);
    return {
      text,
      usage,
    };
  }

  // Thinking is disabled for every model call, so reasoning content must not
  // be treated as the final response or leak into JSON/text persistence.
  return { text: "", usage };
}

function estimatePromptTokens(messages: Array<{ role: string; content: string }>) {
  return Math.max(1, Math.ceil(messages.reduce((total, message) => total + message.content.length, 0) / 4));
}

function estimateCompletionTokens(text: string) {
  return Math.max(0, Math.ceil(text.length / 4));
}

function normalizeCompletionUsage(
  rawUsage: NonNullable<CompletionResponse["usage"]> | undefined,
  messages: Array<{ role: string; content: string }>,
  outputText: string,
  config: RuntimeConfig["modelApi"],
  attemptType: AiCallUsage["attemptType"],
): AiCallUsage {
  const promptTokens = rawUsage?.prompt_tokens ?? estimatePromptTokens(messages);
  const completionTokens = rawUsage?.completion_tokens ?? estimateCompletionTokens(outputText);
  const totalTokens = rawUsage?.total_tokens ?? promptTokens + completionTokens;
  const cachedTokens = rawUsage?.prompt_tokens_details?.cached_tokens ?? 0;
  const hasPromptTokens = typeof rawUsage?.prompt_tokens === "number";
  const hasCompletionTokens = typeof rawUsage?.completion_tokens === "number";
  const hasTotalTokens = typeof rawUsage?.total_tokens === "number";
  const providerFieldCount = [hasPromptTokens, hasCompletionTokens, hasTotalTokens].filter(Boolean).length;
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens,
    tokenUsageSource: providerFieldCount === 3
      ? "provider"
      : providerFieldCount === 0
        ? "estimated"
        : "mixed",
    model: config.model,
    attemptType,
  };
}

async function completeTextWithTransientRetry(
  client: OpenAICompatibleClient,
  config: RuntimeConfig["modelApi"],
  promptConfig: PromptRuntimeConfig,
  userContent: string,
  options?: CompletionOptions,
): Promise<{ text: string; usage: AiCallUsage | null }> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= TRANSIENT_MODEL_API_RETRY_COUNT; attempt += 1) {
    try {
      return await completeText(client, config, promptConfig, userContent, {
        ...options,
        attemptType: attempt > 0 ? "transient_retry" : options?.attemptType ?? "initial",
      });
    } catch (error) {
      lastError = error;
      if (attempt >= TRANSIENT_MODEL_API_RETRY_COUNT || !isTransientModelApiError(error)) {
        throw error;
      }
    }
  }

  throw lastError;
}

export function createAiProvider(
  config: RuntimeConfig["modelApi"],
  promptOverrides?: PromptOverrides | null,
  clientOverrideArg?: OpenAICompatibleClient | null,
  options?: AiProviderOptions,
): AiProvider {
  const providerOptions = options;
  const globalClient = clientOverrideArg ?? getClient(config);
  const aggregationSplitMaxEvents = normalizeAggregationSplitMaxEvents(options?.aggregationSplitMaxEvents);
  const clientCache = new Map<string, OpenAICompatibleClient | null>();
  const resolvedItemUnderstandingConfig = resolvePromptConfig(
    "item_understanding",
    promptOverrides?.itemUnderstanding,
  );
  const itemUnderstandingConfig = promptOverrides?.itemUnderstanding
    ? {
        ...resolvedItemUnderstandingConfig,
        systemPrompt: `${resolvedItemUnderstandingConfig.systemPrompt.replaceAll("{{maxEvents}}", String(aggregationSplitMaxEvents)).trim()}\n\n${ITEM_UNDERSTANDING_FIXED_OUTPUT_RULE}`,
      }
    : {
        ...resolvedItemUnderstandingConfig,
        systemPrompt: `${resolvedItemUnderstandingConfig.systemPrompt.replaceAll("{{maxEvents}}", String(aggregationSplitMaxEvents)).trim()}\n\n${ITEM_UNDERSTANDING_FIXED_OUTPUT_RULE}`,
        temperature: 0,
        maxTokens: 8000,
      };
  const clusterSummaryConfig = resolvePromptConfig(
    "cluster_summary",
    promptOverrides?.clusterSummary,
  );
  const clusterMatchConfig = resolvePromptConfig(
    "cluster_match",
    promptOverrides?.clusterMatch,
  );
  const clusterMergeConfig = resolvePromptConfig(
    "cluster_merge",
    promptOverrides?.clusterMerge,
  );
  const dailyReportConfig = resolvePromptConfig(
    "daily_report",
    promptOverrides?.dailyReport,
  );
  const dailyReportReviewConfig = resolvePromptConfig(
    "daily_report_review",
    promptOverrides?.dailyReportReview ?? undefined,
  );

  const getExecutionConfig = (promptConfig: PromptRuntimeConfig) => promptConfig.modelApi ?? config;
  const getClientForExecutionConfig = (executionConfig: RuntimeConfig["modelApi"]) => {
    if (clientOverrideArg || isSameModelApiConfig(executionConfig, config)) {
      return globalClient;
    }

    return getClientForConfig(executionConfig, clientCache);
  };
  const completeTextWithCircuitBreaker = async (
    promptConfig: PromptRuntimeConfig,
    userContent: string,
    options?: CompletionOptions,
  ): Promise<{ text: string; usage: AiCallUsage | null } | null> => {
    const executionConfig = getExecutionConfig(promptConfig);
    const isDefaultModel = isSameModelApiConfig(executionConfig, config);
    const selectedConfig = !isDefaultModel && isCircuitOpen(executionConfig) ? config : executionConfig;
    const selectedClient = getClientForExecutionConfig(selectedConfig);

    if (!selectedClient) {
      return null;
    }

    try {
      const result = await completeTextWithTransientRetry(selectedClient, selectedConfig, promptConfig, userContent, {
        ...options,
        onUsage: (usage) => providerOptions?.onUsage?.(usage, options?.usageKey),
      });

      if (!isDefaultModel && isSameModelApiConfig(selectedConfig, executionConfig)) {
        recordModelApiSuccess(executionConfig);
      }

      return result;
    } catch (error) {
      if (isInvalidJsonModelResponseError(error)) {
        throw error;
      }

      console.error("[AI Provider] completeText failed:", error);
      if (isDefaultModel || !isSameModelApiConfig(selectedConfig, executionConfig)) {
        throw error;
      }

      const opened = recordModelApiFailure(executionConfig);
      if (!opened) {
        throw error;
      }

      const defaultClient = getClientForExecutionConfig(config);
      if (!defaultClient) {
        throw error;
      }

      return completeTextWithTransientRetry(defaultClient, config, promptConfig, userContent, {
        ...options,
        onUsage: (usage) => providerOptions?.onUsage?.(usage, options?.usageKey),
      });
    }
  };

  const completeJsonWithParseRetry = async <T>(
    promptConfig: PromptRuntimeConfig,
    userContent: string,
    parseOutput: (output: string) => T,
    completionOptions?: { usageKey?: string },
  ): Promise<T | null> => {
    let lastParseError: InvalidJsonModelResponseError | null = null;

    for (let attempt = 0; attempt <= JSON_PARSE_RETRY_COUNT; attempt += 1) {
      let result: { text: string; usage: AiCallUsage | null } | null;
      try {
        result = await completeTextWithCircuitBreaker(
          promptConfig,
          attempt === 0 || !lastParseError ? userContent : buildJsonParseRetryPrompt(userContent, lastParseError),
          {
            responseFormat: { type: "json_object" },
            requireCompleteJson: true,
            usageKey: completionOptions?.usageKey,
            attemptType: attempt > 0 ? "json_retry" : "initial",
          },
        );
      } catch (error) {
        if (!isInvalidJsonModelResponseError(error) || attempt >= JSON_PARSE_RETRY_COUNT) {
          throw error;
        }

        lastParseError = error;
        continue;
      }

      if (result == null) {
        return null;
      }

      try {
        return parseOutput(result.text);
      } catch (error) {
        if (!isInvalidJsonModelResponseError(error) || attempt >= JSON_PARSE_RETRY_COUNT) {
          throw error;
        }

        lastParseError = error;
      }
    }

    return null;
  };

  const completeJsonInStageContext = async <T>(
    promptConfig: PromptRuntimeConfig,
    userContent: string,
    parseOutput: (output: string) => T,
    stageContext: DailyReportStageContext,
    validationFeedback?: DailyReportStageValidationFeedback,
    usageKey?: string,
  ): Promise<T> => {
    if (stageContext.messages.length === 0) {
      stageContext.messages.push(
        { role: "system", content: promptConfig.systemPrompt },
        { role: "user", content: userContent },
      );
    } else {
      if (stageContext.stage !== validationFeedback?.stage) {
        throw new Error(`阶段上下文 ${stageContext.stage} 只能接收同阶段校验反馈。`);
      }
      if (!validationFeedback) {
        throw new Error(`阶段上下文 ${stageContext.stage} 缺少校验反馈。`);
      }
      stageContext.repairRound += 1;
      stageContext.lastViolations = validationFeedback.violations;
      stageContext.messages.push({
        role: "user",
        content: [
          "VALIDATION_FEEDBACK",
          JSON.stringify(validationFeedback),
          "只修正反馈中列出的问题，返回完整的当前阶段 JSON 结果。",
        ].join("\n"),
      });
    }

    stageContext.contextTokenEstimate = Math.ceil(
      stageContext.messages.reduce((total, message) => total + message.content.length, 0) / 4,
    );
    const result = await completeTextWithCircuitBreaker(
      promptConfig,
      "",
      {
        responseFormat: { type: "json_object" },
        requireCompleteJson: true,
        usageKey,
        messages: stageContext.messages,
      },
    );
    const output = result?.text ?? null;
    const normalizedOutput = output?.trim() ?? "";
    stageContext.lastOutput = normalizedOutput;
    stageContext.messages.push({ role: "assistant", content: normalizedOutput });

    if (!normalizedOutput) {
      throw new InvalidJsonModelResponseError(`阶段 ${stageContext.stage} 未返回 JSON 内容。`);
    }

    return parseOutput(normalizedOutput);
  };

  const parseDailyReportStageObject = (output: string) => {
    const normalized = normalizeModelResponseText(output);
    if (!normalized) {
      throw new InvalidJsonModelResponseError("日报阶段模型未返回 JSON 内容。");
    }
    try {
      const parsed = JSON.parse(normalized) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("顶层必须是 JSON 对象");
      }
      return parsed as Record<string, unknown>;
    } catch (error) {
      throw new InvalidJsonModelResponseError(
        `日报阶段模型返回了无法解析的 JSON：${getJsonParseErrorMessage(error)}`,
      );
    }
  };

  const buildDailyReportStagePrompt = (
    stage: string,
    instructions: string,
    payload: Record<string, unknown>,
    inputFieldGuide: string,
  ) => [
    `阶段：${stage}`,
    instructions,
    `输入字段说明：\n${inputFieldGuide}`,
    "只输出一个合法 JSON 对象，不要输出 Markdown、代码块或解释。",
    `模板 JSON：${JSON.stringify(payload.template)}`,
    `输入 JSON：${JSON.stringify(payload.input)}`,
  ].join("\n");

  const buildDailyReportAssessmentTemplate = (template: NormalizedDailyReportTemplate, recentTopicLookbackDays?: number) => ({
    schemaVersion: template.schemaVersion,
    sections: template.blocks
      .filter((block): block is DailyReportTemplateSectionBlock => block.type === "section")
      .map((section) => ({
        blockKey: section.key,
        blockTitle: section.title,
        description: section.description,
      })),
    historyTopicRules: template.recentTopicRules,
    recentTopicLookbackDays: recentTopicLookbackDays ?? null,
  });

  const buildDailyReportPlanningTemplate = (template: NormalizedDailyReportTemplate, recentTopicLookbackDays?: number) => {
    const sections = template.blocks.filter(
      (block): block is DailyReportTemplateSectionBlock => block.type === "section",
    );
    return {
      schemaVersion: template.schemaVersion,
      historyTopicRules: template.recentTopicRules,
      recentTopicLookbackDays: recentTopicLookbackDays ?? null,
      sections: sections.map((section) => ({
        blockKey: section.key,
        blockTitle: section.title,
        description: section.description,
        required: section.required === true,
        minItems: section.minItems ?? 0,
        maxItems: section.maxItems,
      })),
    };
  };

  const buildDailyReportWritingTemplate = (template: NormalizedDailyReportTemplate, selectedBlockKeys?: string[]) => ({
    schemaVersion: template.schemaVersion,
    headlineInstruction: template.headlineInstruction,
    writingRules: template.globalRules,
    blocks: selectedBlockKeys && selectedBlockKeys.length > 0
      ? template.blocks.filter((block) => block.type === "text" || (block.key && selectedBlockKeys.includes(block.key)))
      : template.blocks,
  });

  const getRequiredNotesForBlock = (template: NormalizedDailyReportTemplate, blockKey: string) => {
    const block = template.blocks.find((entry): entry is DailyReportTemplateSectionBlock => entry.type === "section" && entry.key === blockKey);
    return block?.item.notes
      .filter((note) => note.required)
      .map((note) => ({ label: note.label, instruction: note.instruction })) ?? [];
  };

  const buildDailyReportStageConfig = (stage: string, contract: string): PromptRuntimeConfig => ({
    ...dailyReportConfig,
    systemPrompt: [
      "你是中文 AI 新闻日报流水线的阶段执行器。只基于输入内容工作，不补造事实。",
      `当前阶段：${stage}。只执行当前阶段职责，不执行其他阶段职责。${contract}`,
      DAILY_REPORT_JSON_SYNTAX_RULE,
      "最终只输出本阶段合同要求的合法 JSON 对象，不要输出 Markdown、代码块或解释。",
    ].filter(Boolean).join("\n\n"),
  });

  const parseAssessmentOutput = (output: string): DailyReportCandidateAssessment[] => {
    const parsed = parseDailyReportStageObject(output);
    const raw = Array.isArray(parsed.assessments) ? parsed.assessments : parsed;
    if (!Array.isArray(raw)) {
      throw new InvalidJsonModelResponseError("ASSESS 返回必须是 assessments 数组。");
    }
    return raw as unknown as DailyReportCandidateAssessment[];
  };

  const parsePlanOutput = (output: string): DailyReportPlanSelection => parseDailyReportStageObject(output) as unknown as DailyReportPlanSelection;
  const parseDraftOutput = (output: string): DailyReportModelDraft => parseDailyReportStageObject(output) as unknown as DailyReportModelDraft;
  const parseRepairPatchOutput = (output: string): DailyReportRepairPatchResult => {
    const parsed = parseDailyReportStageObject(output);
    if (!Array.isArray(parsed.patches)) {
      throw new InvalidJsonModelResponseError("REPAIR 返回必须是 patches 数组。");
    }
    return { patches: parsed.patches as DailyReportRepairPatchResult["patches"] };
  };
  const parseReviewOutput = (output: string): DailyReportReviewResult => {
    const parsed = parseDailyReportStageObject(output) as Record<string, unknown>;
    if (parsed.verdict !== "pass" && parsed.verdict !== "reject") {
      throw new InvalidJsonModelResponseError("REVIEW 返回的 verdict 必须是 pass 或 reject。");
    }
    if (!Array.isArray(parsed.violations)) {
      throw new InvalidJsonModelResponseError("REVIEW 返回必须包含 violations 数组。");
    }
    const violations = parsed.violations.map((rawViolation) => {
      if (!rawViolation || typeof rawViolation !== "object") {
        throw new InvalidJsonModelResponseError("REVIEW violations 包含无效对象。");
      }
      const violation = rawViolation as Record<string, unknown>;
      if (!DAILY_REPORT_REVIEW_VIOLATION_CODES.includes(violation.code as typeof DAILY_REPORT_REVIEW_VIOLATION_CODES[number])) {
        throw new InvalidJsonModelResponseError(`REVIEW 返回未知 violation code：${String(violation.code)}`);
      }
      if (violation.severity !== "error" && violation.severity !== "warning") {
        throw new InvalidJsonModelResponseError("REVIEW violation severity 必须是 error 或 warning。");
      }
      const topicIds = violation.topicIds === undefined
        ? undefined
        : Array.isArray(violation.topicIds) && violation.topicIds.every((value) => typeof value === "string")
          ? violation.topicIds as string[]
          : null;
      const candidateIds = violation.candidateIds === undefined
        ? undefined
        : Array.isArray(violation.candidateIds) && violation.candidateIds.every((value) => typeof value === "number" && Number.isInteger(value))
          ? violation.candidateIds as number[]
          : null;
      if (topicIds === null || candidateIds === null || typeof violation.message !== "string") {
        throw new InvalidJsonModelResponseError("REVIEW violation 字段格式无效。");
      }
      if (typeof violation.evidence !== "string" || !violation.evidence.trim()) {
        throw new InvalidJsonModelResponseError("REVIEW violation 必须包含非空 evidence。");
      }
      if (typeof violation.guidance !== "string" || !violation.guidance.trim()) {
        throw new InvalidJsonModelResponseError("REVIEW violation 必须包含非空 guidance。");
      }
      return {
        code: violation.code as DailyReportReviewResult["violations"][number]["code"],
        severity: violation.severity as "error" | "warning",
        message: violation.message,
        ...(topicIds ? { topicIds } : {}),
        ...(candidateIds ? { candidateIds } : {}),
        evidence: violation.evidence,
        guidance: violation.guidance,
      };
    });
    const summary = typeof parsed.summary === "string" ? parsed.summary : "";
    return { verdict: parsed.verdict, violations, summary };
  };
  return {
    async understandItem(inputText, metadata) {
      const fallback = getFallbackUnderstanding(metadata);
      const userContent = buildAiUserContent(itemUnderstandingConfig.userInstruction, {
        title: metadata.title,
        sourceName: metadata.sourceName ?? "未知来源",
        translateTitle: metadata.translateTitle,
        maxEvents: aggregationSplitMaxEvents,
        inputText,
      });
      const result = await completeJsonWithParseRetry(
        itemUnderstandingConfig,
        userContent,
        (output) => parseItemUnderstandingOutput(
          output,
          inputText,
          fallback,
          metadata.translateTitle,
          aggregationSplitMaxEvents,
        ),
        { usageKey: "item_understanding" },
      );

      if (result == null) {
        return fallback;
      }

      return result;
    },
    async summarizeCluster(inputText, metadata) {
      const userContent = buildAiUserContent(clusterSummaryConfig.userInstruction, {
        title: metadata.title,
        inputText,
      });
      const output = await completeJsonWithParseRetry(
        clusterSummaryConfig,
        userContent,
        parseClusterSummaryOutput,
        { usageKey: "cluster_summary" },
      );

      return output ?? "";
    },
    async matchClusterCandidate(inputText, metadata) {
      if (metadata.candidates.length === 0) {
        return null;
      }

      const userContent = buildAiUserContent(clusterMatchConfig.userInstruction, {
        title: metadata.title,
        inputText,
        candidatesJson: JSON.stringify(metadata.candidates),
      });

      return completeJsonWithParseRetry(
        clusterMatchConfig,
        userContent,
        (output) => parseClusterMatchCandidateId(
          output,
          metadata.candidates.map((candidate) => candidate.id),
        ),
        { usageKey: "cluster_match" },
      ).catch((error) => {
        if (isInvalidJsonModelResponseError(error)) {
          return null;
        }
        throw error;
      });
    },
    async assessClusterMergePairs(clustersJson) {
      const metadata = parseClusterMergeInputMetadata(clustersJson);
      const userContent = buildAiUserContent(clusterMergeConfig.userInstruction, {
        ...JSON.parse(clustersJson) as Record<string, unknown>,
      });

      const decisions = await completeJsonWithParseRetry(
        clusterMergeConfig,
        userContent,
        (output) => parseClusterMergeDecisions(output, metadata),
        { usageKey: "cluster_merge" },
      );

      return decisions ?? [];
    },
    async assessDailyReportCandidates(input) {
      const promptConfig = buildDailyReportStageConfig(
          "ASSESS",
          "不得写正文、不得合并主题、不得重新编号或遗漏候选；必须逐一返回输入中的每个 candidateId。只返回 candidateId、isWorthReading、relevanceScore、suggestedBlockKey、historyDecision、matchedRecentTopicTitle 六个字段。suggestedBlockKey 必须来自模板 sections 或为 null；historyDecision 必须是 new、duplicate、follow_up、uncertain 之一。historyDecision=duplicate 时 matchedRecentTopicTitle 填写命中的历史主题标题，否则为 null。若 historyDecision=duplicate，isWorthReading 必须为 false。",
        );
      const userContent = buildDailyReportStagePrompt(
          "ASSESS",
          "逐一评估输入中的每个 candidateId。每个候选必须返回一次，不得新增或遗漏 ID。返回 {assessments:[{candidateId,isWorthReading,relevanceScore,suggestedBlockKey,historyDecision,matchedRecentTopicTitle}]}。只做选题评估和历史重复判断，不写正文，不合并主题。",
          {
            template: buildDailyReportAssessmentTemplate(input.template, input.recentTopicLookbackDays),
            input: {
              candidates: input.candidates.map(compactDailyReportModelCandidate),
              recentTopics: input.recentTopics,
            },
          },
          `${DAILY_REPORT_CANDIDATE_FIELD_GUIDE}\n${DAILY_REPORT_ASSESSMENT_FIELD_GUIDE}`,
        );
      const output = input.stageContext
        ? await completeJsonInStageContext(promptConfig, userContent, parseAssessmentOutput, input.stageContext, input.validationFeedback, "daily_report_assess")
        : await completeJsonWithParseRetry(promptConfig, userContent, parseAssessmentOutput, { usageKey: "daily_report_assess" });
      return output ?? [];
    },
    async planDailyReport(input) {
      const promptConfig = buildDailyReportStageConfig(
          "PLAN",
          `必须返回 schemaVersion=2；template.sections 是唯一可规划栏目清单；sections 中的 blockKey 只能使用 template.sections[].blockKey，禁止使用 text、type、栏目标题或自造 key；text block 不属于 sections。每个 topics[].candidateIds 必须非空；一个 candidateId 只能属于一个 topic。topicId 由代码生成，不要输出。若输入包含 reviewFeedback，必须优先根据其中的 guidance 修复对应问题，并继续遵守 candidateBriefs、template 和 recentTopics 的输入边界。\n${DAILY_REPORT_PLAN_TOPIC_CONTRACT}`,
        );
      const userContent = buildDailyReportStagePrompt(
          "PLAN",
          `基于所有 candidateBriefs 做全局选题、主题归纳和栏目分配。先按“一个独立事实对应一个 topic”的规则判断候选是否属于同一主题，再决定主题是否入选和放入哪个栏目。${DAILY_REPORT_PLAN_TOPIC_CONTRACT} 综合摘要、事件线索、来源数量、日期相关性、后续进展、近期重复和评分信号，不要只按单一分数排序。输出的每个 section.blockKey 必须逐字复制 template.sections[].blockKey；每个 section 的 topics 数量必须在对应模板的 minItems 与 maxItems 之间，可选栏目在可规划候选充足且有足够高价值候选时，应尽量接近 maxItems，但不能为了凑数选择低价值候选。一个 topics[].candidateIds 数组表示同一个最终日报主题的候选事实或互证来源；每个候选只能出现在一个主题中。只返回 {schemaVersion:2,sections:[{blockKey,topics:[{candidateIds:[number]}]}]}。不要输出主题编号、栏目展示名、标题、理由或其他字段；不得写正文、不得创建输入之外的候选或栏目，不得输出 text block。`,
          {
            template: buildDailyReportPlanningTemplate(input.template, input.recentTopicLookbackDays),
            input: {
              candidateBriefs: input.candidateBriefs,
              recentTopics: input.recentTopics ?? [],
              ...(input.reviewFeedback ? { reviewFeedback: input.reviewFeedback } : {}),
            },
          },
          `${DAILY_REPORT_PLAN_TOPIC_CONTRACT}\n${DAILY_REPORT_PLAN_FIELD_GUIDE}\n${DAILY_REPORT_REVIEW_FEEDBACK_GUIDE}`,
        );
      const output = input.stageContext
        ? await completeJsonInStageContext(promptConfig, userContent, parsePlanOutput, input.stageContext, input.validationFeedback, "daily_report_plan")
        : await completeJsonWithParseRetry(promptConfig, userContent, parsePlanOutput, { usageKey: "daily_report_plan" });
      if (!output) throw new Error("PLAN 阶段没有返回结果。");
      return output;
    },
    async writeDailyReport(input) {
      const selectedBlockKeys = Array.from(new Set(input.selectedTopics.map((topic) => topic.blockKey)));
      const promptConfig = buildDailyReportStageConfig(
          "WRITE",
          "只能使用 selectedTopics 中的主题和候选；不得重新归纳主题、换栏目、增加栏目或补造事实。若输入包含 reviewFeedback，必须优先根据其中的 guidance 修复对应问题，并继续遵守 selectedTopics、template 和候选事实边界。输出对象本身就是日报内容，顶层必须直接包含 headline 和 blocks，合法结构为 {\"headline\":\"...\",\"blocks\":[...]}；禁止输出 draft、result、data、output 等外层包装键。text block 返回 {type:\"text\",title,body}，section block 返回 {type:\"section\",blockKey,title,items}，item 返回 {topicId,title,body,notes}；每个 selectedTopics 必须生成一个 item，topicId 必须原样复制；不要输出 sourceIds、candidateIds 或其他来源映射字段；notes 必须是 {label:string,text:string} 数组，模板中的 required 和 instruction 只是规则元数据，绝不能原样输出到 notes；模板中 required=true 的 note 必须按模板 label 原样输出且 text 非空，required=false 的 note 可按内容需要输出；只使用模板中定义的 text block 和已规划的 section block。正文只写内容本身，不要带栏目名、字段名或标签前缀；除模板允许的加粗和斜体外，不要输出链接、图片、标题、表格、列表或其他 Markdown 结构。",
        );
      const userContent = buildDailyReportStagePrompt(
          "WRITE",
          "严格按照 selectedTopics 和对应 Block 写作，只返回完整日报内容 JSON。输出对象本身就是日报内容，顶层直接包含 headline 和 blocks，不得包在 draft、result、data 或 output 字段中。不得重新选题、合并主题、换栏目、增加栏目或补造事实。每个 section block 必须包含与输入一致的 blockKey 和模板 title；每个 section item 必须包含 topicId、title、body 和 notes，不要输出 sourceIds 或 candidateIds；每个计划主题必须且只能对应一个 item；当模板中该栏目 item.bodyRequired=false 时 body 必须为空字符串或省略，不能输出正文，否则 body 必须非空；每个 notes 元素只能是 {label,text}，不要输出 required 或 instruction；notes 中必须包含模板配置的全部 required=true note，label 必须逐字匹配、text 必须非空；每个 text block 必须包含 type、title、body。",
          { template: buildDailyReportWritingTemplate(input.template, selectedBlockKeys), input: {
            selectedTopics: input.selectedTopics.map((topic) => ({ ...topic, requiredNotes: getRequiredNotesForBlock(input.template, topic.blockKey), candidates: topic.candidates.map(compactDailyReportWritingCandidate) })),
            ...(input.reviewFeedback ? { reviewFeedback: input.reviewFeedback } : {}),
          } },
          `${DAILY_REPORT_WRITE_FIELD_GUIDE}\n${DAILY_REPORT_REVIEW_FEEDBACK_GUIDE}`,
        );
      const output = input.stageContext
        ? await completeJsonInStageContext(promptConfig, userContent, parseDraftOutput, input.stageContext, input.validationFeedback, "daily_report_write")
        : await completeJsonWithParseRetry(promptConfig, userContent, parseDraftOutput, { usageKey: "daily_report_write" });
      if (!output) throw new Error("WRITE 阶段没有返回结果。");
      return output;
    },
    async repairDailyReportDraft(input) {
      const unsupportedViolations = input.violations.filter(
        (violation) => !isDailyReportNotesRepairableViolation(violation),
      );
      if (unsupportedViolations.length > 0) {
        throw new Error("REPAIR notes patch 只支持修复 draft_required_note_missing，不支持修改日报结构。");
      }

      const affectedTopicIds = new Set(
        input.violations
          .map((violation) => violation.topicId)
          .filter((topicId): topicId is string => Boolean(topicId)),
      );
      const repairTargets = input.selectedTopics
        .filter((topic) => affectedTopicIds.size === 0 || affectedTopicIds.has(topic.topicId))
        .map((topic) => ({
          topicId: topic.topicId,
          blockKey: topic.blockKey,
          candidateIds: topic.candidateIds,
          requiredNotes: getRequiredNotesForBlock(input.template, topic.blockKey),
          candidates: topic.candidates.map(compactDailyReportWritingCandidate),
        }));
      const output = await completeJsonWithParseRetry(
        {
          ...buildDailyReportStageConfig(
            "REPAIR",
            "只修复输入 violations 中列出的问题，不改变已有正文、主题、候选、栏目和顺序。REPAIR 只返回 notes 补丁，不返回完整日报草稿；合法结构为 {\"patches\":[{\"topicId\":\"...\",\"notes\":[{\"label\":\"...\",\"text\":\"...\"}]}]}。topicId 必须来自 repairTargets，notes 的 label 必须来自对应 requiredNotes，不能新增主题、候选、栏目或字段。补丁文本只能使用 repairTargets 中的候选事实，不得编造。每条 violation 都必须有对应补丁或已经由现有内容满足。",
          ),
          temperature: 0,
          maxTokens: Math.min(dailyReportConfig.maxTokens ?? 4096, MAX_DAILY_REPORT_REPAIR_TOKENS),
        },
        buildDailyReportStagePrompt(
          "REPAIR",
          "只修复 violations 中列出的问题。返回 notes 补丁，不要返回 headline、blocks、draft、result、data 或 output；每个补丁必须定位到 violations 中的 topicId，并使用 repairTargets 对应候选事实补齐缺失的 required note。相同主题有多个缺失要点时必须在同一个补丁中逐条补齐；只输出 {patches:[{topicId,notes:[{label,text}]}]}。",
          {
            template: buildDailyReportWritingTemplate(input.template, input.selectedTopics.map((topic) => topic.blockKey)),
            input: {
              draft: stripDailyReportSourceIdsForModel(input.draft),
              violations: input.violations,
              missingNotes: input.violations
                .filter((violation) => violation.topicId && violation.noteLabel)
                .map((violation) => ({
                  topicId: violation.topicId,
                  noteLabel: violation.noteLabel,
                  blockKey: violation.blockKey,
                  noteInstruction: violation.noteInstruction,
                })),
              repairTargets,
            },
          },
          DAILY_REPORT_REPAIR_FIELD_GUIDE,
        ),
        parseRepairPatchOutput,
        { usageKey: "daily_report_repair" },
      );
      if (!output) throw new Error("REPAIR 阶段没有返回补丁。");
      return output;
    },
    async reviewDailyReport(input) {
      const customInstruction = normalizeAiUserInstruction(dailyReportReviewConfig.userInstruction);
      const userContent = [
        customInstruction,
        "以下是由系统生成的审核输入 JSON，请只基于其中的内容进行审核：",
        JSON.stringify(input),
      ].filter(Boolean).join("\n\n");
      const output = await completeJsonWithParseRetry(
        {
          ...dailyReportReviewConfig,
          // The Review system contract is owned by the application.
          // A persisted systemPrompt is legacy data and is not user-overridable.
          systemPrompt: DEFAULT_DAILY_REPORT_REVIEW_PROMPT,
        },
        userContent,
        parseReviewOutput,
        { usageKey: "daily_report_review" },
      );
      if (!output) throw new Error("REVIEW 阶段没有返回结果。");
      const knownTopicIds = new Set(input.selectedTopics.map((topic) => topic.topicId));
      const knownCandidateIds = new Set([
        ...input.selectedTopics.flatMap((topic) => topic.candidateIds),
        ...input.candidatePool.topUnselectedCandidates.map((candidate) => candidate.candidateId),
      ]);
      for (const violation of output.violations) {
        if (violation.topicIds?.some((topicId) => !knownTopicIds.has(topicId))) {
          throw new InvalidJsonModelResponseError("REVIEW violation 引用了不存在的 topicId。");
        }
        if (violation.candidateIds?.some((candidateId) => !knownCandidateIds.has(candidateId))) {
          throw new InvalidJsonModelResponseError("REVIEW violation 引用了不在审核输入中的 candidateId。");
        }
      }
      if (output.verdict === "pass" && output.violations.some((violation) => violation.severity === "error")) {
        return {
          ...output,
          verdict: "reject",
          summary: output.summary || "Review 返回了错误级问题。",
        };
      }
      if (output.verdict === "reject" && !output.violations.some((violation) => violation.severity === "error")) {
        throw new InvalidJsonModelResponseError("REVIEW reject 必须包含至少一个 error 级 violation。");
      }
      return output;
    },
  };
}
