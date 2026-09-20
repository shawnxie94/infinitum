/**
 * 传输实现（spec P1a）：
 * - aiSdkTransport：生产路径，@ai-sdk/openai-compatible（generateText + transformRequestBody 注入 response_format / MiniMax thinking 开关）
 * - compatClientTransport：兼容缝（{chat:{completions:{create}}} 形状），用于既有测试替身与灰度回退
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";

import type {
  CompletionRequest,
  CompletionResult,
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
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
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
  aiSdkUsage?: { inputTokens?: number | null; outputTokens?: number | null; totalTokens?: number | null; cachedInputTokens?: number | null },
): UsageSnapshot {
  const estimates = estimateTokens(messages, outputText);
  const promptTokens = rawUsage?.prompt_tokens ?? aiSdkUsage?.inputTokens ?? estimates.promptTokens;
  const completionTokens = rawUsage?.completion_tokens ?? aiSdkUsage?.outputTokens ?? estimates.completionTokens;
  const totalTokens = rawUsage?.total_tokens ?? aiSdkUsage?.totalTokens ?? promptTokens + completionTokens;
  const cachedTokens = rawUsage?.prompt_tokens_details?.cached_tokens ?? aiSdkUsage?.cachedInputTokens ?? 0;
  const hasPrompt = typeof rawUsage?.prompt_tokens === "number" || typeof aiSdkUsage?.inputTokens === "number";
  const hasCompletion = typeof rawUsage?.completion_tokens === "number" || typeof aiSdkUsage?.outputTokens === "number";
  const hasTotal = typeof rawUsage?.total_tokens === "number" || typeof aiSdkUsage?.totalTokens === "number";
  const providerFieldCount = [hasPrompt, hasCompletion, hasTotal].filter(Boolean).length;
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens,
    tokenUsageSource: providerFieldCount === 3 ? "provider" : providerFieldCount === 0 ? "estimated" : "mixed",
    model: config.model,
  };
}

function isMiniMax(config: ModelApiConfig) {
  const base = (config.baseURL ?? "").toLowerCase();
  const model = config.model.toLowerCase();
  return base.includes("minimax") || model.includes("minimax");
}

/** 生产传输：AI SDK + openai-compatible provider。response_format/thinking 经 transformRequestBody 注入。 */
export function createAiSdkTransport(options?: { fetch?: typeof fetch }): ModelTransport {
  const providerCache = new Map<string, ReturnType<typeof createOpenAICompatible>>();

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
    try {
      const result = await generateText({
        model,
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
        temperature: request.temperature ?? undefined,
        maxOutputTokens: request.maxTokens ?? undefined,
        topP: request.topP ?? undefined,
        abortSignal: request.signal,
        providerOptions: {
          "openai-compatible": { strictJsonSchema: false },
        },
      });

      const usage = normalizeUsage(undefined, request.messages, result.text, config, {
        inputTokens: result.usage?.inputTokens ?? null,
        outputTokens: result.usage?.outputTokens ?? null,
        totalTokens: result.usage?.totalTokens ?? null,
        cachedInputTokens: null,
      });
      return {
        text: result.text ?? "",
        finishReason: String(result.finishReason ?? "stop"),
        reasoningLength: (result.reasoning ?? "").length,
        usage,
      };
    } catch (error) {
      // AI SDK 错误保持 status/message 形状，供瞬时重试/熔断判定。
      throw error;
    }
  };
}

type CompatClient = {
  chat: {
    completions: {
      create: (request: Record<string, unknown>) => Promise<unknown>;
    };
  };
};

/** 兼容传输：老 OpenAICompatibleClient 替身（tests）直连。 */
export function createCompatClientTransport(client: unknown): ModelTransport {
  const typed = client as CompatClient;
  return async (request, config) => {
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
}

export { estimateTokens, normalizeUsage };
