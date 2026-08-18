import OpenAI from "openai";
import { jsonrepair } from "jsonrepair";

import {
  MODEL_API_CIRCUIT_BREAKER_FAILURE_THRESHOLD,
  MODEL_API_CIRCUIT_BREAKER_OPEN_MS,
  MODEL_API_CIRCUIT_BREAKER_WINDOW_MS,
} from "@/config/constants";
import {
  DEFAULT_CLUSTER_MATCH_PROMPT,
  DEFAULT_CLUSTER_MATCH_USER_PROMPT_TEMPLATE,
  DEFAULT_CLUSTER_MERGE_PROMPT,
  DEFAULT_CLUSTER_MERGE_USER_PROMPT_TEMPLATE,
  DEFAULT_CLUSTER_SUMMARY_PROMPT,
  DEFAULT_CLUSTER_SUMMARY_USER_PROMPT_TEMPLATE,
  DEFAULT_DAILY_REPORT_PROMPT,
  DEFAULT_DAILY_REPORT_USER_PROMPT_TEMPLATE,
  DEFAULT_ITEM_UNDERSTANDING_PROMPT,
  DEFAULT_ITEM_UNDERSTANDING_USER_PROMPT_TEMPLATE,
  ITEM_UNDERSTANDING_FIXED_OUTPUT_RULE,
} from "@/config/prompts";
import type { RuntimeConfig } from "@/config/runtime";
import { normalizeModelResponseText } from "@/lib/ai/response-format";
import { requireUsableGeneratedSummary } from "@/lib/ai/summary-quality";
import type {
  DailyReportAssessmentLedger,
  DailyReportCandidateAssessment,
  DailyReportDraft,
  DailyReportPlan,
  DailyReportPlanningCandidate,
  DailyReportTopicBrief,
  DailyReportViolation,
} from "@/lib/daily-report/types";
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

export type MergeGroup = string[];

export type ClusterMergeDecisionVerdict = "approved" | "declined" | "ambiguous";

export type ClusterMergeDecision = {
  leftClusterId: string;
  rightClusterId: string;
  verdict: ClusterMergeDecisionVerdict;
  confidence: number | null;
  reasonCode: string | null;
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
  assessClusterMergePairs?(clustersJson: string): Promise<ClusterMergeDecision[]>;
  mergeClusters(clustersJson: string): Promise<MergeGroup[]>;
  assessDailyReportCandidates(input: {
    candidates: DailyReportPlanningCandidate[];
    template: NormalizedDailyReportTemplate;
    recentTopicLookbackDays?: number;
  }): Promise<DailyReportCandidateAssessment[]>;
  planDailyReport(input: {
    ledger: DailyReportAssessmentLedger;
    topicBriefs: DailyReportTopicBrief[];
    template: NormalizedDailyReportTemplate;
    recentTopicLookbackDays?: number;
  }): Promise<DailyReportPlan>;
  writeDailyReport(input: {
    selectedCandidates: DailyReportPlanningCandidate[];
    plan: DailyReportPlan;
    template: NormalizedDailyReportTemplate;
  }): Promise<DailyReportDraft>;
  repairDailyReportDraft(input: {
    draft: DailyReportDraft;
    violations: DailyReportViolation[];
    plan: DailyReportPlan;
    template: NormalizedDailyReportTemplate;
  }): Promise<DailyReportDraft>;
};

type CompletionResponse = {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
    };
  }>;
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
  promptTemplate: string;
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
};

export type AiProviderOptions = {
  aggregationSplitMaxEvents?: number;
};

type CompletionResponseFormat = {
  type: "json_object";
};

type CompletionOptions = {
  responseFormat?: CompletionResponseFormat;
  requireCompleteJson?: boolean;
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

class InvalidJsonModelResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidJsonModelResponseError";
  }
}

function isInvalidJsonModelResponseError(error: unknown): error is InvalidJsonModelResponseError {
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

function renderPromptTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => String(values[key] ?? ""));
}

const DAILY_REPORT_MODEL_CANDIDATE_KEYS = [
  "id",
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
  "candidateId：输入候选的 id；isWorthReading：是否进入后续主题合并；relevanceScore：0 到 100 的选题相关性分。",
  "suggestedBlockKey：建议的 section blockKey，必须来自模板 sections，无法判断时为 null；它只是软提示，最终以 PLAN 和本地校验为准。",
  "template.sections 中 blockKey 是稳定栏目键，blockTitle 只是展示名，description 是选题方向，required/minItems/maxItems 是栏目数量约束。",
  "只返回上述四个字段；不要生成 eventHint、evidenceSummary、exclusionReason、confidence 或其他解释字段。",
].join("\n");

const DAILY_REPORT_PLAN_FIELD_GUIDE = [
  "ledger.candidateCount/assessedCount/unassessedCandidateIds/excludedCandidateIds/batchCount：评估覆盖统计；assessedCount 包含被排除候选，unassessedCandidateIds 不能选择；不要据此创建候选或补写评估。",
  "ledger.assessments：只包含 isWorthReading=true 的可规划候选；relevanceScore 和 suggestedBlockKey 是选题信号，不是事实；excludedCandidateIds 中的候选明确不得选择。",
  "topicBriefs[].topicId：系统生成的主题引用；candidateIds：该主题的完整候选成员，不能拆分或跨主题重组。",
  "topicBriefs[].identitySource：主题由 cluster、event-identity、source-key 或 standalone 哪种已有身份线索形成；evidenceCount：聚合证据量。",
  "topicBriefs[].titleHint：主题标题线索；relevanceScore：该主题成员中的最高相关性分；ambiguity：主题存在身份歧义时的候选编号和原因，不能把歧义当成确定事实。",
  "topicBriefs[].candidateBriefs：该主题全部成员的有界内容线索和排序信号；summaryExcerpt 可能只出现在代表候选上，candidateIds 才是完整归属事实。",
  "candidateBriefs[].candidateId/title/sourceName/summaryExcerpt：候选引用、标题、代表来源和摘要片段；摘要片段可能为空且不是全文，不得补造未提供的事实。",
  "candidateBriefs[].candidateScore/qualityScore/relevanceScore/sourceCount/itemCount：本地排序、质量、模型相关性、互证来源数和聚合条目数；综合使用，不要把分数当作事实；极端预算压缩时 qualityScore 可能省略。",
  "candidateBriefs[].publishedAt/publishedAtKnown：源站时间及其可靠性；isFollowUp/newItemCountOnDate/newSourceCountOnDate：后续进展及日报日期新增量信号。",
  "candidateBriefs[].eventType/eventSubject/eventAction/eventObject/eventDate：代表候选的已有事件线索，其他成员可能为空；suggestedBlockKey 是软栏目建议。只用于比较、归类和去重，不得补造输入之外的事实。极端预算压缩时，sourceName/summaryExcerpt/suggestedBlockKey/event* 和 qualityScore 等可选内容字段可能省略，但 candidateId、title、candidateScore、relevanceScore、来源数、条目数、publishedAt 和 follow-up 信号会保留。",
  "recentTopics：近期开过的主题历史（含日期、标题和事件线索），仅用于减少重复；不要把它们当作本期候选。",
  "template.schemaVersion/recentTopicLookbackDays/recentTopicRules：模板版本、历史主题召回窗口和去重规则；sections 是唯一可规划栏目清单。",
  "template.sections[].blockKey 是唯一输出键；blockTitle 仅用于理解栏目，description 是栏目意图，required/minItems/maxItems 是硬约束。",
].join("\n");

const DAILY_REPORT_WRITE_FIELD_GUIDE = [
  "plan.sections：已经确定的栏目和候选归属；WRITE 不得重新选题、换栏目或新增候选。",
  "selectedCandidates：已经被 PLAN 选中的候选；id/sourceNumber 是引用编号，title/itemTitle 是标题，summary 是已有摘要，sourceName/url 是来源信息。",
  "selectedCandidates[].qualityScore/candidateScore/sourceCount/itemCount：质量、排序、互证来源数和聚合条目数；createdAt/publishedAt/publishedAtKnown 是系统入库时间、源站时间及其可靠性。",
  "selectedCandidates[].eventType/eventSubject/eventAction/eventObject/eventDate：已有结构化事件线索；isFollowUp/newItemCountOnDate/newSourceCountOnDate 是后续进展信号；evidenceItems 是可核对的简短来源证据。",
  "selectedCandidates 的所有字段只用于基于事实写作；url、evidenceItems 和摘要不是补充搜索入口，不得引入输入之外的信息。",
  "template.blocks：完整栏目与正文规则；text block 只写模板定义的文本块，section block 按 type/key/title、item.bodyInstruction/bodyRequired 和 notes 规则输出。",
].join("\n");

const DAILY_REPORT_REPAIR_FIELD_GUIDE = [
  "draft.headline：日报标题；draft.blocks：当前完整日报的 text/section block；section.items 中的 title/body/notes/sourceIds 是条目内容和来源引用。只修复问题，不重做内容。",
  "violations：本地校验指出的具体问题；code/stage/message 描述原因，blockKey/candidateIds 用于定位；plan.sections 是不可改变的栏目和候选归属。",
  "template.blocks：模板定义的 block、条目数量、正文和 notes 规则；只按 violation 修复格式或缺失字段。",
  "只修复 violations 指定的问题，不重新选题、不改写事实、不新增来源或栏目。",
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
  validIds: string[];
  allowedPairKeys: Set<string>;
  allowedPairs: Array<[string, string]>;
  itemCounts: Map<string, number>;
};

function buildClusterMergePairKey(leftId: string, rightId: string) {
  return [leftId, rightId].sort().join("\u0000");
}

function parseMergeGroups(rawContent: string, metadata: ClusterMergeInputMetadata): string[][] {
  const normalized = normalizeModelResponseText(rawContent);
  const validSet = new Set(metadata.validIds);

  try {
    const parsed = JSON.parse(normalized) as { approvedPairs?: unknown; pairs?: unknown; mergeGroups?: unknown };
    const approvedPairs = parseApprovedClusterMergePairs(parsed, metadata);

    if (Array.isArray(parsed.approvedPairs) || Array.isArray(parsed.pairs)) {
      return buildClusterMergeGroupsFromApprovedPairs(approvedPairs, metadata);
    }

    if (!Array.isArray(parsed.mergeGroups)) {
      return [];
    }

    const groups: string[][] = [];
    const seenIds = new Set<string>();

    for (const group of parsed.mergeGroups) {
      if (!Array.isArray(group) || group.length < 2) {
        continue;
      }
      const validGroup: string[] = [];
      for (const id of group) {
        if (typeof id === "string" && validSet.has(id) && !seenIds.has(id)) {
          validGroup.push(id);
          seenIds.add(id);
        }
      }
      if (validGroup.length >= 2) {
        groups.push(validGroup);
      }
    }

    return groups;
  } catch (error) {
    throw new InvalidJsonModelResponseError(
      `Invalid cluster merge JSON: ${getJsonParseErrorMessage(error)}`,
    );
  }
}

function parseApprovedClusterMergePairs(
  parsed: { approvedPairs?: unknown; pairs?: unknown },
  metadata: ClusterMergeInputMetadata,
) {
  const validSet = new Set(metadata.validIds);
  const rawPairs = Array.isArray(parsed.approvedPairs)
    ? parsed.approvedPairs
    : Array.isArray(parsed.pairs)
      ? parsed.pairs
      : [];
  const pairs: Array<[string, string]> = [];
  const seenPairKeys = new Set<string>();

  for (const rawPair of rawPairs) {
    const pair = normalizeApprovedClusterMergePair(rawPair, Array.isArray(parsed.approvedPairs));

    if (!pair) {
      continue;
    }

    const [leftId, rightId] = pair;
    const pairKey = buildClusterMergePairKey(leftId, rightId);

    if (
      leftId === rightId ||
      !validSet.has(leftId) ||
      !validSet.has(rightId) ||
      !metadata.allowedPairKeys.has(pairKey) ||
      seenPairKeys.has(pairKey)
    ) {
      continue;
    }

    seenPairKeys.add(pairKey);
    pairs.push([leftId, rightId]);
  }

  return pairs;
}

function normalizeApprovedClusterMergePair(rawPair: unknown, implicitlyApproved: boolean): [string, string] | null {
  if (Array.isArray(rawPair) && typeof rawPair[0] === "string" && typeof rawPair[1] === "string") {
    return [rawPair[0], rawPair[1]];
  }

  if (!rawPair || typeof rawPair !== "object") {
    return null;
  }

  const pair = rawPair as Record<string, unknown>;
  if (!implicitlyApproved && pair.approved !== true) {
    return null;
  }

  const leftId = pair.leftId ?? pair.leftClusterId ?? pair.sourceId ?? getClusterIdFromUnknown(pair.left);
  const rightId = pair.rightId ?? pair.rightClusterId ?? pair.targetId ?? getClusterIdFromUnknown(pair.right);

  return typeof leftId === "string" && typeof rightId === "string" ? [leftId, rightId] : null;
}

function getClusterIdFromUnknown(value: unknown) {
  return value && typeof value === "object" && "id" in value && typeof value.id === "string" ? value.id : null;
}

function buildClusterMergeGroupsFromApprovedPairs(
  approvedPairs: Array<[string, string]>,
  metadata: Pick<ClusterMergeInputMetadata, "itemCounts"> & { preservePairOrder?: boolean },
) {
  const adjacency = new Map<string, Set<string>>();

  for (const [leftId, rightId] of approvedPairs) {
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
  return buildClusterMergeGroupsFromApprovedPairs(
    decisions
      .filter((decision) => decision.verdict === "approved")
      .map((decision) => [decision.leftClusterId, decision.rightClusterId]),
    { itemCounts, preservePairOrder: true },
  );
}

function parseClusterMergeInputMetadata(clustersJson: string): ClusterMergeInputMetadata {
  const parsed = JSON.parse(clustersJson) as unknown;
  const validIds = new Set<string>();
  const allowedPairKeys = new Set<string>();
  const allowedPairs: Array<[string, string]> = [];
  const itemCounts = new Map<string, number>();

  const addCluster = (entry: unknown) => {
    if (!entry || typeof entry !== "object" || !("id" in entry) || typeof entry.id !== "string") {
      return null;
    }

    validIds.add(entry.id);
    if ("itemCount" in entry && typeof entry.itemCount === "number") {
      itemCounts.set(entry.id, entry.itemCount);
    }

    return entry.id;
  };

  const addPair = (leftId: unknown, rightId: unknown) => {
    if (typeof leftId === "string" && typeof rightId === "string" && leftId !== rightId) {
      validIds.add(leftId);
      validIds.add(rightId);
      const pairKey = buildClusterMergePairKey(leftId, rightId);
      if (!allowedPairKeys.has(pairKey)) {
        allowedPairKeys.add(pairKey);
        allowedPairs.push([leftId, rightId]);
      }
    }
  };

  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      addCluster(entry);
    }
    return { validIds: [...validIds], allowedPairKeys, allowedPairs, itemCounts };
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

  return { validIds: [...validIds], allowedPairKeys, allowedPairs, itemCounts };
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
    reasonCode: typeof decision.reasonCode === "string" ? decision.reasonCode.trim() || null : null,
    reasonText: typeof decision.reasonText === "string" ? decision.reasonText.trim() || null : null,
  };
}

function parseClusterMergeDecisions(rawContent: string, metadata: ClusterMergeInputMetadata) {
  const normalized = normalizeModelResponseText(rawContent);
  let parsed: { decisions?: unknown; approvedPairs?: unknown; pairs?: unknown };

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
    const approvedPairs = parseApprovedClusterMergePairs(parsed, metadata);
    if (!Array.isArray(parsed.approvedPairs) && !Array.isArray(parsed.pairs)) {
      throw new InvalidJsonModelResponseError(
        'Cluster merge decision JSON must contain a "decisions" array.',
      );
    }

    const approvedPairKeys = new Set(approvedPairs.map(([leftId, rightId]) => buildClusterMergePairKey(leftId, rightId)));
    return metadata.allowedPairs.map(([leftClusterId, rightClusterId]) => {
      const pairKey = buildClusterMergePairKey(leftClusterId, rightClusterId);
      return {
        leftClusterId,
        rightClusterId,
        verdict: approvedPairKeys.has(pairKey) ? "approved" : "declined",
        confidence: null,
        reasonCode: approvedPairKeys.has(pairKey) ? "legacy_llm_approved" : "legacy_llm_declined",
        reasonText: null,
      } satisfies ClusterMergeDecision;
    });
  }

  for (const rawDecision of parsed.decisions) {
    const decision = normalizeClusterMergeDecision(rawDecision, metadata);
    if (!decision) {
      continue;
    }

    const pairKey = buildClusterMergePairKey(decision.leftClusterId, decision.rightClusterId);
    if (seenPairKeys.has(pairKey)) {
      continue;
    }

    seenPairKeys.add(pairKey);
    decisions.push(decision);
  }

  return decisions;
}

function parseClusterMatchCandidateId(rawContent: string, candidateIds: string[]): string | null {
  const normalized = normalizeModelResponseText(rawContent);
  let parseError: unknown = null;

  try {
    const parsed = JSON.parse(normalized) as { clusterId?: string | null };
    const clusterId = parsed.clusterId?.trim() || "";

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
  defaultSystemPrompt: string,
  defaultPromptTemplate: string,
  runtimeOverride: PromptRuntimeConfig | undefined,
): PromptRuntimeConfig {
  if (runtimeOverride) {
    return {
      systemPrompt: runtimeOverride.systemPrompt || defaultSystemPrompt,
      promptTemplate: runtimeOverride.promptTemplate || defaultPromptTemplate,
      temperature: runtimeOverride.temperature,
      maxTokens: runtimeOverride.maxTokens,
      topP: runtimeOverride.topP,
      modelApi: runtimeOverride.modelApi,
    };
  }

  return {
    systemPrompt: defaultSystemPrompt,
    promptTemplate: defaultPromptTemplate,
  };
}

async function completeText(
  client: OpenAICompatibleClient,
  config: RuntimeConfig["modelApi"],
  promptConfig: PromptRuntimeConfig,
  userContent: string,
  options?: CompletionOptions,
): Promise<string> {
  const request: Record<string, unknown> = {
    model: config.model,
    messages: [
      {
        role: "system",
        content: promptConfig.systemPrompt,
      },
      {
        role: "user",
        content: userContent,
      },
    ],
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
    return normalizeModelResponseText(content);
  }

  // Thinking is disabled for every model call, so reasoning content must not
  // be treated as the final response or leak into JSON/text persistence.
  return "";
}

async function completeTextWithTransientRetry(
  client: OpenAICompatibleClient,
  config: RuntimeConfig["modelApi"],
  promptConfig: PromptRuntimeConfig,
  userContent: string,
  options?: CompletionOptions,
) {
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= TRANSIENT_MODEL_API_RETRY_COUNT; attempt += 1) {
    try {
      return await completeText(client, config, promptConfig, userContent, options);
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
  const globalClient = clientOverrideArg ?? getClient(config);
  const aggregationSplitMaxEvents = normalizeAggregationSplitMaxEvents(options?.aggregationSplitMaxEvents);
  const clientCache = new Map<string, OpenAICompatibleClient | null>();
  const resolvedItemUnderstandingConfig = resolvePromptConfig(
    DEFAULT_ITEM_UNDERSTANDING_PROMPT,
    DEFAULT_ITEM_UNDERSTANDING_USER_PROMPT_TEMPLATE,
    promptOverrides?.itemUnderstanding,
  );
  const itemUnderstandingConfig = promptOverrides?.itemUnderstanding
    ? {
        ...resolvedItemUnderstandingConfig,
        systemPrompt: `${resolvedItemUnderstandingConfig.systemPrompt.trim()}\n\n${ITEM_UNDERSTANDING_FIXED_OUTPUT_RULE}`,
      }
    : {
        ...resolvedItemUnderstandingConfig,
        systemPrompt: `${resolvedItemUnderstandingConfig.systemPrompt.trim()}\n\n${ITEM_UNDERSTANDING_FIXED_OUTPUT_RULE}`,
        temperature: 0,
        maxTokens: 8000,
      };
  const clusterSummaryConfig = resolvePromptConfig(
    DEFAULT_CLUSTER_SUMMARY_PROMPT,
    DEFAULT_CLUSTER_SUMMARY_USER_PROMPT_TEMPLATE,
    promptOverrides?.clusterSummary,
  );
  const clusterMatchConfig = resolvePromptConfig(
    DEFAULT_CLUSTER_MATCH_PROMPT,
    DEFAULT_CLUSTER_MATCH_USER_PROMPT_TEMPLATE,
    promptOverrides?.clusterMatch,
  );
  const clusterMergeConfig = resolvePromptConfig(
    DEFAULT_CLUSTER_MERGE_PROMPT,
    DEFAULT_CLUSTER_MERGE_USER_PROMPT_TEMPLATE,
    promptOverrides?.clusterMerge,
  );
  const dailyReportConfig = resolvePromptConfig(
    DEFAULT_DAILY_REPORT_PROMPT,
    DEFAULT_DAILY_REPORT_USER_PROMPT_TEMPLATE,
    promptOverrides?.dailyReport,
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
  ) => {
    const executionConfig = getExecutionConfig(promptConfig);
    const isDefaultModel = isSameModelApiConfig(executionConfig, config);
    const selectedConfig = !isDefaultModel && isCircuitOpen(executionConfig) ? config : executionConfig;
    const selectedClient = getClientForExecutionConfig(selectedConfig);

    if (!selectedClient) {
      return null;
    }

    try {
      const output = await completeTextWithTransientRetry(selectedClient, selectedConfig, promptConfig, userContent, options);

      if (!isDefaultModel && isSameModelApiConfig(selectedConfig, executionConfig)) {
        recordModelApiSuccess(executionConfig);
      }

      return output;
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

      return completeTextWithTransientRetry(defaultClient, config, promptConfig, userContent, options);
    }
  };

  const completeJsonWithParseRetry = async <T>(
    promptConfig: PromptRuntimeConfig,
    userContent: string,
    parseOutput: (output: string) => T,
  ): Promise<T | null> => {
    let lastParseError: InvalidJsonModelResponseError | null = null;

    for (let attempt = 0; attempt <= JSON_PARSE_RETRY_COUNT; attempt += 1) {
      let output: string | null;
      try {
        output = await completeTextWithCircuitBreaker(
          promptConfig,
          attempt === 0 || !lastParseError ? userContent : buildJsonParseRetryPrompt(userContent, lastParseError),
          {
            responseFormat: { type: "json_object" },
            requireCompleteJson: true,
          },
        );
      } catch (error) {
        if (!isInvalidJsonModelResponseError(error) || attempt >= JSON_PARSE_RETRY_COUNT) {
          throw error;
        }

        lastParseError = error;
        continue;
      }

      if (output == null) {
        return null;
      }

      try {
        return parseOutput(output);
      } catch (error) {
        if (!isInvalidJsonModelResponseError(error) || attempt >= JSON_PARSE_RETRY_COUNT) {
          throw error;
        }

        lastParseError = error;
      }
    }

    return null;
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
        required: section.required === true,
        minItems: section.minItems ?? 0,
        maxItems: section.maxItems,
      })),
      recentTopicRules: template.recentTopicRules,
      recentTopicLookbackDays: recentTopicLookbackDays ?? null,
    });

  const buildDailyReportPlanningTemplate = (template: NormalizedDailyReportTemplate, recentTopicLookbackDays?: number) => {
    const sections = template.blocks.filter(
      (block): block is DailyReportTemplateSectionBlock => block.type === "section",
    );
    return {
      schemaVersion: template.schemaVersion,
      recentTopicRules: template.recentTopicRules,
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

  const buildDailyReportWritingTemplate = (template: NormalizedDailyReportTemplate) => ({
    schemaVersion: template.schemaVersion,
    headlineInstruction: template.headlineInstruction,
    globalRules: template.globalRules,
    blocks: template.blocks,
  });

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

  const parsePlanOutput = (output: string): DailyReportPlan => parseDailyReportStageObject(output) as unknown as DailyReportPlan;
  const parseDraftOutput = (output: string): DailyReportDraft => parseDailyReportStageObject(output) as unknown as DailyReportDraft;

  return {
    async understandItem(inputText, metadata) {
      const fallback = getFallbackUnderstanding(metadata);
      const userContent = renderPromptTemplate(itemUnderstandingConfig.promptTemplate, {
        title: metadata.title,
        sourceName: metadata.sourceName ?? "未知来源",
        translateTitle: metadata.translateTitle ? "是" : "否",
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
      );

      if (result == null) {
        return fallback;
      }

      return result;
    },
    async summarizeCluster(inputText, metadata) {
      const userContent = renderPromptTemplate(clusterSummaryConfig.promptTemplate, {
        title: metadata.title,
        inputText,
      });
      const output = await completeJsonWithParseRetry(
        clusterSummaryConfig,
        userContent,
        parseClusterSummaryOutput,
      );

      return output ?? "";
    },
    async matchClusterCandidate(inputText, metadata) {
      if (metadata.candidates.length === 0) {
        return null;
      }

      const userContent = renderPromptTemplate(clusterMatchConfig.promptTemplate, {
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
      ).catch((error) => {
        if (isInvalidJsonModelResponseError(error)) {
          return null;
        }
        throw error;
      });
    },
    async assessClusterMergePairs(clustersJson) {
      const metadata = parseClusterMergeInputMetadata(clustersJson);
      const userContent = renderPromptTemplate(clusterMergeConfig.promptTemplate, {
        clustersJson,
      });

      const decisions = await completeJsonWithParseRetry(
        clusterMergeConfig,
        userContent,
        (output) => parseClusterMergeDecisions(output, metadata),
      );

      return decisions ?? [];
    },
    async mergeClusters(clustersJson) {
      const metadata = parseClusterMergeInputMetadata(clustersJson);
      const userContent = renderPromptTemplate(clusterMergeConfig.promptTemplate, {
        clustersJson,
      });

      const groups = await completeJsonWithParseRetry(
        clusterMergeConfig,
        userContent,
        (output) => parseMergeGroups(output, metadata),
      ).catch((error) => {
        if (isInvalidJsonModelResponseError(error)) {
          return [];
        }
        throw error;
      });

      return groups ?? [];
    },
    async assessDailyReportCandidates(input) {
      const output = await completeJsonWithParseRetry(
        buildDailyReportStageConfig(
          "ASSESS",
          "不得写正文、不得合并主题、不得重新编号或遗漏候选；必须逐一返回输入中的每个 candidateId。只返回 candidateId、isWorthReading、relevanceScore、suggestedBlockKey 四个字段。suggestedBlockKey 必须来自模板 sections 或为 null。",
        ),
        buildDailyReportStagePrompt(
          "ASSESS",
          "逐一评估输入中的每个 candidateId。每个候选必须返回一次，不得新增或遗漏 ID。返回 {assessments:[{candidateId,isWorthReading,relevanceScore,suggestedBlockKey}]}。只做选题评估，不写正文，不合并主题。",
          {
            template: buildDailyReportAssessmentTemplate(input.template, input.recentTopicLookbackDays),
            input: input.candidates.map(compactDailyReportModelCandidate),
          },
          `${DAILY_REPORT_CANDIDATE_FIELD_GUIDE}\n${DAILY_REPORT_ASSESSMENT_FIELD_GUIDE}`,
        ),
        parseAssessmentOutput,
      );
      return output ?? [];
    },
    async planDailyReport(input) {
      const output = await completeJsonWithParseRetry(
        buildDailyReportStageConfig(
          "PLAN",
          "必须返回 schemaVersion=1；template.sections 是唯一可规划栏目清单；sections 中的 blockKey 只能使用 template.sections[].blockKey，禁止使用 text、type、栏目标题或自造 key；text block 不属于可规划栏目，绝不能出现在 sections 中；每个 topicId 和 candidateId 最多出现一次；candidateIds 的归属以输入 topicBriefs[].candidateIds 为唯一事实，栏目中的每个 candidateId 必须属于该栏目 topicIds 的 candidateIds，并且必须同时列出它的所属 topicId。输出前逐项检查 topicId-candidateId 映射。",
        ),
        buildDailyReportStagePrompt(
          "PLAN",
          "基于可规划 assessment 和 topicBriefs 做全局选题与栏目分配。先综合 summaryExcerpt、candidateScore、relevanceScore、sourceCount、itemCount、日期相关性、后续进展和近期重复，再选择 topicId 和 candidateId；不要只按单一分数排序。template.sections 是唯一可规划栏目清单，输出的每个 section.blockKey 必须逐字复制其中一个 blockKey。candidateIds 必须按输入 topicBriefs[].candidateIds 校验：先选择 topicId，再从该 topic 的 candidateIds 中选择候选；如果选择某个候选，必须把包含该候选的 topicId 也放入同一 section。只返回 {schemaVersion:1,sections:[{blockKey,topicIds,candidateIds}]}。不得输出 blockTitle、headlineHint、excludedCandidateIds、selectionRationale 或其他解释字段；不得写正文、不得创建输入之外的候选或栏目，不得输出 text block。",
          {
            template: buildDailyReportPlanningTemplate(input.template, input.recentTopicLookbackDays),
            input: {
              ledger: input.ledger,
              topicBriefs: input.topicBriefs,
            },
          },
          DAILY_REPORT_PLAN_FIELD_GUIDE,
        ),
        parsePlanOutput,
      );
      if (!output) throw new Error("PLAN 阶段没有返回结果。");
      return output;
    },
    async writeDailyReport(input) {
      const output = await completeJsonWithParseRetry(
        buildDailyReportStageConfig(
          "WRITE",
          "只能使用 plan 中的 section、topic 和 candidate；不得重新选题、合并主题、增加栏目或补造事实。顶层返回 {headline:string,blocks:Array}；text block 返回 {type:\"text\",title,body}，section block 返回 {type:\"section\",blockKey,title,items}，item 返回 {title,body,notes,sourceIds}；notes 必须是 {label:string,text:string} 数组，模板中的 required 和 instruction 只是规则元数据，绝不能原样输出到 notes；模板中 required=true 的 note 必须按模板 label 原样输出且 text 非空，required=false 的 note 可按内容需要输出；只使用模板中定义的 text block 和已规划的 section block。",
        ),
        buildDailyReportStagePrompt(
          "WRITE",
          "严格按照全局计划和模板写作，只返回日报 Draft JSON。只能使用计划中的 candidateId 和输入候选的 id（sourceIds 使用这些 id），不得重新选题、合并、增加栏目或补造事实。每个 section block 必须包含与模板一致的 blockKey 和 title；每个 section item 必须包含 title、body、sourceIds 和 notes；当模板中该栏目 item.bodyRequired=false 时 body 必须为空字符串或省略，不能输出正文，否则 body 必须非空；每个 notes 元素只能是 {label,text}，不要输出 required 或 instruction；notes 中必须包含模板配置的全部 required=true note，label 必须逐字匹配、text 必须非空；每个 text block 必须包含 type、title、body。",
          { template: buildDailyReportWritingTemplate(input.template), input: { plan: input.plan, selectedCandidates: input.selectedCandidates.map(compactDailyReportModelCandidate) } },
          DAILY_REPORT_WRITE_FIELD_GUIDE,
        ),
        parseDraftOutput,
      );
      if (!output) throw new Error("WRITE 阶段没有返回结果。");
      return output;
    },
    async repairDailyReportDraft(input) {
      const output = await completeJsonWithParseRetry(
        {
          ...buildDailyReportStageConfig(
            "REPAIR",
            "逐条修复输入 violations 中列出的问题，不改变事实、计划允许的候选和栏目；必须按违规中的栏目、第几条、条目标题和来源定位目标 item，不能只修复其中一条。补齐模板要求的 required note 时必须使用模板原始 label 和非空 text，notes 元素只能包含 label 和 text。输出前逐项确认每条 violation 都已消除。",
          ),
          temperature: 0,
          maxTokens: Math.min(dailyReportConfig.maxTokens ?? 4096, MAX_DAILY_REPORT_REPAIR_TOKENS),
        },
        buildDailyReportStagePrompt(
          "REPAIR",
          "只修复 violations 中列出的问题。保持 plan 允许的候选和栏目不变，返回完整 Draft JSON；对于缺失的 required note，按违规信息定位到对应的第 N 条 item，按模板要求补齐对应 label 和非空 text，删除 notes 中的 required/instruction 元数据字段；相同栏目出现多个缺失要点时必须逐条补齐，不得遗漏。",
          { template: buildDailyReportWritingTemplate(input.template), input: { draft: input.draft, violations: input.violations, plan: input.plan } },
          DAILY_REPORT_REPAIR_FIELD_GUIDE,
        ),
        parseDraftOutput,
      );
      if (!output) throw new Error("REPAIR 阶段没有返回结果。");
      return output;
    },
  };
}
