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
} from "@/config/prompts";
import type { RuntimeConfig } from "@/config/runtime";
import { normalizeModelResponseText } from "@/lib/ai/response-format";
import { requireUsableGeneratedSummary } from "@/lib/ai/summary-quality";
import { buildDailyReportRuntimeFallbackInstructionLines } from "@/lib/daily-report/runtime-rules";
import { normalizeItemTags } from "@/lib/tags/normalization";
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
  tags: string[];
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
  tags: string[];
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
  mergeClusters(clustersJson: string): Promise<MergeGroup[]>;
  generateDailyReport(
    input: { date: string; timezone: string; articles: unknown[]; recentTopics?: unknown[] },
  ): Promise<string | null>;
  repairDailyReportJson(rawContent: string): Promise<string | null>;
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

function buildDailyReportUserPrompt(config: {
  systemPrompt: string;
  promptTemplate: string;
}, input: {
  date: string;
  timezone: string;
  articles: unknown[];
  recentTopics?: unknown[];
}) {
  const recentTopicsJson = JSON.stringify(input.recentTopics ?? []);
  const rendered = renderPromptTemplate(config.promptTemplate, {
    date: input.date,
    timezone: input.timezone,
    articlesJson: JSON.stringify(input.articles),
    recentTopicsJson,
  });
  const extraInstructions = buildDailyReportRuntimeFallbackInstructionLines({
    systemPrompt: config.systemPrompt,
    promptTemplate: config.promptTemplate,
    recentTopicsJson,
  });

  return [rendered, ...extraInstructions].join("\n");
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
    tags: [],
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
      tags: normalizeItemTags(raw.tags).map((tag) => tag.name),
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
    tags: normalizeItemTags(raw.tags).map((tag) => tag.name),
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
    tags?: unknown;
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
    tags: normalizeItemTags(parsed.tags).map((tag) => tag.name),
  };
}

type ClusterMergeInputMetadata = {
  validIds: string[];
  allowedPairKeys: Set<string>;
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
  metadata: ClusterMergeInputMetadata,
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
      return itemCountDiff || leftId.localeCompare(rightId);
    })[0]!;
    const directSources = [...(adjacency.get(targetId) ?? [])].sort((leftId, rightId) => {
      const itemCountDiff = (metadata.itemCounts.get(rightId) ?? 0) - (metadata.itemCounts.get(leftId) ?? 0);
      return itemCountDiff || leftId.localeCompare(rightId);
    });

    if (directSources.length > 0) {
      groups.push([targetId, ...directSources]);
    }
  }

  return groups;
}

function parseClusterMergeInputMetadata(clustersJson: string): ClusterMergeInputMetadata {
  const parsed = JSON.parse(clustersJson) as unknown;
  const validIds = new Set<string>();
  const allowedPairKeys = new Set<string>();
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
      allowedPairKeys.add(buildClusterMergePairKey(leftId, rightId));
    }
  };

  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      addCluster(entry);
    }
    return { validIds: [...validIds], allowedPairKeys, itemCounts };
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

  return { validIds: [...validIds], allowedPairKeys, itemCounts };
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
  const response = await client.chat.completions.create({
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
  }) as CompletionResponse;

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

  return normalizeModelResponseText(reasoningContent);
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
    ? resolvedItemUnderstandingConfig
    : {
        ...resolvedItemUnderstandingConfig,
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

  const parseDailyReportJsonOutput = (output: string) => {
    const normalized = normalizeModelResponseText(output);
    if (!normalized) {
      throw new InvalidJsonModelResponseError("日报模型未返回最终 JSON 内容。");
    }

    try {
      const parsed = JSON.parse(normalized) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("顶层必须是 JSON 对象");
      }
      return normalized;
    } catch (error) {
      throw new InvalidJsonModelResponseError(
        `日报模型返回了无法解析的 JSON（${normalized.length} 字符）：${getJsonParseErrorMessage(error)}`,
      );
    }
  };

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
    async generateDailyReport(input) {
      return completeJsonWithParseRetry(
        dailyReportConfig,
        buildDailyReportUserPrompt(dailyReportConfig, input),
        parseDailyReportJsonOutput,
      );
    },
    async repairDailyReportJson(rawContent) {
      return completeJsonWithParseRetry(
        {
          ...dailyReportConfig,
          systemPrompt: "你是 JSON 修复器。请把用户提供的内容修复为合法 JSON 对象，只输出修复后的 JSON，不要输出 Markdown、代码块或解释。不要补充新事实，不要改写字段含义。",
          temperature: 0,
          maxTokens: Math.min(dailyReportConfig.maxTokens ?? 4096, MAX_DAILY_REPORT_REPAIR_TOKENS),
        },
        `待修复内容：\n${rawContent}`,
        parseDailyReportJsonOutput,
      );
    },
  };
}
