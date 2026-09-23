/**
 * 传输实现（spec P1a）：
 * - aiSdkTransport：生产路径，@ai-sdk/openai-compatible（generateText/generateObject；
 *   transformRequestBody 注入 response_format / MiniMax thinking 开关；瞬时重试
 *   下沉为 SDK maxRetries——不再与网关叠层）
 * - compatClientTransport：兼容缝（{chat:{completions:{create}}} 形状），用于既有
 *   测试替身；重试语义与 aiSdk 对齐（同 maxRetries、同瞬时错误判定）
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateObject, generateText } from "ai";

import type {
  CompletionRequest,
  ModelApiConfig,
  ModelTransport,
  UsageSnapshot,
} from "./types";

export class InvalidJsonModelResponse extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidJsonModelResponseError";
  }
}

type WireUsage = {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
  prompt_tokens_details?: { cached_tokens?: number | null } | null;
};

export type WireCompletionResponse = {
  choices?: Array<{
    message?: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: WireUsage;
};

function estimateTokens(messages: Array<{ content: string }>, outputText: string) {
  const promptTokens = Math.max(1, Math.ceil(messages.reduce((total, m) => total + m.content.length, 0) / 4));
  const completionTokens = Math.max(0, Math.ceil(outputText.length / 4));
  return { promptTokens, completionTokens };
}

function normalizeUsage(
  rawUsage: WireUsage | undefined,
  messages: Array<{ content: string }>,
  outputText: string,
  config: ModelApiConfig,
  aiSdkUsage?: {
    inputTokens?: number | null;
    outputTokens?: number | null;
    totalTokens?: number | null;
    inputTokenDetails?: { cacheReadTokens?: number | null };
    raw?: unknown;
  },
): UsageSnapshot {
  const estimates = estimateTokens(messages, outputText);
  const promptTokens = rawUsage?.prompt_tokens ?? aiSdkUsage?.inputTokens ?? estimates.promptTokens;
  const completionTokens = rawUsage?.completion_tokens ?? aiSdkUsage?.outputTokens ?? estimates.completionTokens;
  const totalTokens = rawUsage?.total_tokens ?? aiSdkUsage?.totalTokens ?? promptTokens + completionTokens;
  const sdkRawUsage = aiSdkUsage?.raw && typeof aiSdkUsage.raw === "object"
    ? aiSdkUsage.raw as WireUsage
    : undefined;
  const rawCachedTokens = rawUsage?.prompt_tokens_details?.cached_tokens
    ?? sdkRawUsage?.prompt_tokens_details?.cached_tokens;
  const sdkCacheReadTokens = aiSdkUsage?.inputTokenDetails?.cacheReadTokens;
  const cachedTokensReported = typeof rawCachedTokens === "number"
    || (typeof sdkCacheReadTokens === "number" && sdkCacheReadTokens > 0);
  const cachedTokens = typeof rawCachedTokens === "number"
    ? rawCachedTokens
    : typeof sdkCacheReadTokens === "number" && sdkCacheReadTokens > 0
      ? sdkCacheReadTokens
      : 0;
  const hasPrompt = typeof rawUsage?.prompt_tokens === "number" || typeof aiSdkUsage?.inputTokens === "number";
  const hasCompletion = typeof rawUsage?.completion_tokens === "number" || typeof aiSdkUsage?.outputTokens === "number";
  const hasTotal = typeof rawUsage?.total_tokens === "number" || typeof aiSdkUsage?.totalTokens === "number";
  const providerFieldCount = [hasPrompt, hasCompletion, hasTotal].filter(Boolean).length;
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens,
    cachedTokensReported,
    tokenUsageSource: providerFieldCount === 3 ? "provider" : providerFieldCount === 0 ? "estimated" : "mixed",
    model: config.model,
  };
}

function isMiniMax(config: ModelApiConfig) {
  const base = (config.baseURL ?? "").toLowerCase();
  const model = config.model.toLowerCase();
  return base.includes("minimax") || model.includes("minimax");
}

function getErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const maybe = error as { status?: unknown; statusCode?: unknown; code?: unknown };
  const raw = maybe.status ?? maybe.statusCode ?? maybe.code;
  if (typeof raw === "number" && Number.isInteger(raw)) return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw)) return Number(raw);
  return null;
}

export function isTransientModelApiError(error: unknown) {
  const status = getErrorStatus(error);
  if (status !== null) {
    return status === 408 || status === 429 || status >= 500;
  }
  if (!error || typeof error !== "object") return false;
  const maybe = error as { code?: unknown; name?: unknown; message?: unknown };
  const code = typeof maybe.code === "string" ? maybe.code.toLowerCase() : "";
  const name = typeof maybe.name === "string" ? maybe.name.toLowerCase() : "";
  const message = typeof maybe.message === "string" ? maybe.message.toLowerCase() : "";
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

const DEFAULT_MAX_RETRIES = 1;

function splitInstructions(request: CompletionRequest) {
  const instructions = request.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const rest = request.messages.filter((m) => m.role !== "system");
  return {
    instructions: instructions || undefined,
    ...(rest.length === 1 && rest[0].role === "user"
      ? { prompt: rest[0].content }
      : {
          messages: rest.map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
          })),
        }),
  };
}

/** 生产传输：AI SDK + openai-compatible provider。 */
export function createAiSdkTransport(options?: {
  fetch?: typeof fetch;
  /** 瞬时重试次数（下沉到 AI SDK 内建重试；默认 1，对齐原自研语义）。 */
  maxRetries?: number;
  /** 结构化输出：开启后带 schema 的请求走 generateObject（response_format json_schema）；
   *  端点不支持时自动回退 json_object 模式并记住该端点。 */
  supportsStructuredOutputs?: boolean;
}): ModelTransport {
  const providerCache = new Map<string, ReturnType<typeof createOpenAICompatible>>();
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  // 端点不支持 json_schema 时的回退记忆（key = 模型配置指纹）
  const structuredFallback = new Set<string>();

  return async (request, config) => {
    const cacheKey = [config.apiKey ?? "", config.baseURL ?? "", config.model].join("|");
    let provider = providerCache.get(cacheKey);
    if (!provider) {
      provider = createOpenAICompatible({
        name: "infinitum-model-api",
        baseURL: config.baseURL || "https://api.openai.com/v1",
        apiKey: config.apiKey ?? undefined,
        headers: config.customHeaders ?? undefined,
        fetch: options?.fetch,
        supportsStructuredOutputs: !!options?.supportsStructuredOutputs,
        transformRequestBody: (body) => {
          const next: Record<string, unknown> = { ...body };
          // 本仓全部补全都以 JSON 模式工作（解析层消费 JSON 输出）。
          next.response_format = { type: "json_object" };
          // MiniMax 私有 thinking 开关；OpenAI 兼容端点省略该字段即等价关闭。
          if (isMiniMax(config)) {
            next.thinking = { type: "disabled" };
          }
          return next;
        },
      });
      providerCache.set(cacheKey, provider);
    }

    const model = provider.chatModel(config.model);
    const baseParams = {
      ...splitInstructions(request),
      temperature: request.temperature ?? undefined,
      maxOutputTokens: request.maxTokens ?? undefined,
      topP: request.topP ?? undefined,
      abortSignal: request.signal,
    };

    // 结构化输出路径：语法由模型侧约束解码保证；端点不支持则回退 json_object。
    if (request.schema && options?.supportsStructuredOutputs && !structuredFallback.has(cacheKey)) {
      try {
        const result = await generateObject({
          model,
          schema: request.schema,
          ...baseParams,
          maxRetries,
        });
        return {
          text: JSON.stringify(result.object),
          finishReason: String(result.finishReason ?? "stop"),
          reasoningLength: 0,
          usage: normalizeUsage(undefined, request.messages, JSON.stringify(result.object), config, {
            inputTokens: result.usage?.inputTokens ?? null,
            outputTokens: result.usage?.outputTokens ?? null,
            totalTokens: result.usage?.totalTokens ?? null,
            inputTokenDetails: result.usage?.inputTokenDetails,
            raw: result.usage?.raw,
          }),
        };
      } catch (error) {
        if (isTransientModelApiError(error)) throw error;
        const message = String((error as { message?: unknown })?.message ?? error);
        if (!/response_format|json_schema|structured|schema|not\s*support/i.test(message)) {
          throw error;
        }
        structuredFallback.add(cacheKey);
        console.warn(
          `[ModelGateway] structured output unsupported by ${config.model}, falling back to json_object mode: ${message.slice(0, 160)}`,
        );
      }
    }

    const result = await generateText({
      model,
      ...baseParams,
      maxRetries,
      providerOptions: {
        openaiCompatible: { strictJsonSchema: false },
      },
    });

    const usage = normalizeUsage(undefined, request.messages, result.text, config, {
      inputTokens: result.usage?.inputTokens ?? null,
      outputTokens: result.usage?.outputTokens ?? null,
      totalTokens: result.usage?.totalTokens ?? null,
      inputTokenDetails: result.usage?.inputTokenDetails,
      raw: result.usage?.raw,
    });
    return {
      text: result.text ?? "",
      finishReason: String(result.finishReason ?? "stop"),
      reasoningLength: (result.reasoning ?? "").length,
      usage,
    };
  };
}

type CompatClient = {
  chat: {
    completions: {
      create: (request: Record<string, unknown>) => Promise<unknown>;
    };
  };
};

/** 兼容传输：老 OpenAICompatibleClient 替身（tests）直连；重试语义与 aiSdk 对齐。 */
export function createCompatClientTransport(
  client: unknown,
  options?: { maxRetries?: number },
): ModelTransport {
  const typed = client as CompatClient;
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;

  const callOnce = async (request: CompletionRequest, config: ModelApiConfig) => {
    const wire: Record<string, unknown> = {
      model: config.model,
      messages: request.messages,
      max_tokens: request.maxTokens ?? undefined,
      temperature: request.temperature ?? undefined,
      top_p: request.topP ?? undefined,
      response_format: request.requireCompleteJson ? { type: "json_object" } : undefined,
    };
    if (isMiniMax(config)) {
      wire.thinking = { type: "disabled" };
    }
    const response = (await typed.chat.completions.create(wire)) as WireCompletionResponse;
    const choice = response.choices?.[0];
    const content = choice?.message?.content?.trim() ?? "";
    const usage = normalizeUsage(response.usage, request.messages, content, config);
    return {
      text: content,
      finishReason: choice?.finish_reason ?? null,
      reasoningLength: choice?.message?.reasoning_content?.trim().length ?? 0,
      usage,
    };
  };

  return async (request, config) => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        return await callOnce(request, config);
      } catch (error) {
        lastError = error;
        if (attempt >= maxRetries || !isTransientModelApiError(error)) throw error;
      }
    }
    throw lastError;
  };
}

export { estimateTokens, normalizeUsage };
