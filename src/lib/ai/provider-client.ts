import OpenAI from "openai";

import {
  MODEL_API_CIRCUIT_BREAKER_FAILURE_THRESHOLD,
  MODEL_API_CIRCUIT_BREAKER_OPEN_MS,
  MODEL_API_CIRCUIT_BREAKER_WINDOW_MS,
} from "@/config/constants";
import type { RuntimeConfig } from "@/config/runtime";
import { normalizeModelResponseText } from "@/lib/ai/response-format";
import type {
  AiCallUsage,
  CompletionOptions,
  CompletionResponse,
  OpenAICompatibleClient,
  PromptRuntimeConfig,
} from "@/lib/ai/provider-types";
import { InvalidJsonModelResponseError } from "@/lib/ai/provider-types";

const TRANSIENT_MODEL_API_RETRY_COUNT = 1;
export const JSON_PARSE_RETRY_COUNT = 1;

type ModelApiCircuitState = {
  failures: number[];
  openUntil: number;
};

const modelApiCircuitStates = new Map<string, ModelApiCircuitState>();

export function getJsonParseErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown JSON parse error";
}

export function buildJsonParseRetryPrompt(userContent: string, error: InvalidJsonModelResponseError) {
  return `${userContent}

重要：上一次输出不是合法 JSON，解析错误：${error.message}
请重新生成，必须只输出一个合法 JSON 对象，不要输出 Markdown、代码块或额外解释。请检查字段之间的逗号、完整闭合的括号，以及字符串内部双引号和换行的 JSON 转义。`;
}

export function getClient(config: RuntimeConfig["modelApi"]): OpenAICompatibleClient | null {
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

export function isSameModelApiConfig(left: RuntimeConfig["modelApi"], right: RuntimeConfig["modelApi"]) {
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

export function isCircuitOpen(config: RuntimeConfig["modelApi"], now = Date.now()) {
  return getCircuitState(config).openUntil > now;
}

export function recordModelApiSuccess(config: RuntimeConfig["modelApi"]) {
  const state = getCircuitState(config);
  state.failures = [];
  state.openUntil = 0;
}

export function recordModelApiFailure(config: RuntimeConfig["modelApi"], now = Date.now()) {
  const state = getCircuitState(config);
  const windowStart = now - MODEL_API_CIRCUIT_BREAKER_WINDOW_MS;
  state.failures = [...state.failures.filter((timestamp) => timestamp >= windowStart), now];

  if (state.failures.length >= MODEL_API_CIRCUIT_BREAKER_FAILURE_THRESHOLD) {
    state.openUntil = now + MODEL_API_CIRCUIT_BREAKER_OPEN_MS;
  }

  return state.openUntil > now;
}

export function getClientForConfig(
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

export async function completeTextWithTransientRetry(
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
