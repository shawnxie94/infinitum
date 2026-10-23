/**
 * 传输实现（spec P1a）：
 * - aiSdkTransport：生产路径，@ai-sdk/openai-compatible（generateText/generateObject；
 *   transformRequestBody 注入 response_format / MiniMax thinking 开关）
 * - compatClientTransport：兼容缝（{chat:{completions:{create}}} 形状），用于既有
 *   测试替身
 * 两者的 SDK/内建不透明重试一律关闭（maxRetries: 0 / 显式循环），瞬时重试改为
 * 受控插桩重试：每次真实调用都先过审计准入（beforeDispatch），结算时持久化
 * 原始响应回执（settle）。unknown（超时/中断/网络类无响应错误）一律不再重试。
 */
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateObject, generateText } from "ai";

import type {
  CompletionRequest,
  ModelApiConfig,
  ModelTransport,
  TransportAuditHooks,
  TransportAttemptContext,
  UsageSnapshot,
} from "./types";

export class InvalidJsonModelResponse extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidJsonModelResponseError";
  }
}

/** 无响应结局（超时/中断/网络类）：请求可能已到达提供方，禁止自动重试或回退。 */
export class UnknownTransportOutcomeError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "UnknownTransportOutcomeError";
  }
}

export type TransportAdmissionReason = "budget_exhausted" | "unresolved_outcome" | "audit_storage";

/** 审计准入拒绝：预算耗尽 / 同任务未决结果阻断 / 审计存储失败（fail-closed）。 */
export class TransportAdmissionError extends Error {
  constructor(readonly reason: TransportAdmissionReason, message: string, readonly cause?: unknown) {
    super(message);
    this.name = "TransportAdmissionError";
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

/** M3.1 起 adaptive thinking 模型：显式 disabled 会被 API 拒收（400），只能保持省略按自适应运行。 */
function isMiniMaxAdaptiveModel(config: ModelApiConfig) {
  return /m3\.1|adaptive/i.test(config.model);
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

/**
 * 结局分类：拿到 HTTP 状态码 = 已知失败；无状态且命中 abort/timeout/network
 * 模式 = unknown（请求可能已到达提供方，禁止自动重试/回退）。
 */
export function classifyTransportOutcome(error: unknown): "failed" | "unknown" {
  if (getErrorStatus(error) !== null) return "failed";
  if (!error || typeof error !== "object") return "failed";
  const maybe = error as { code?: unknown; name?: unknown; message?: unknown };
  const code = typeof maybe.code === "string" ? maybe.code.toLowerCase() : "";
  const name = typeof maybe.name === "string" ? maybe.name.toLowerCase() : "";
  const message = typeof maybe.message === "string" ? maybe.message.toLowerCase() : "";
  const unknownPatterns = ["abort", "timeout", "timed out", "read timeout", "network", "econnreset", "etimedout", "econnrefused", "socket hang up", "fetch failed"];
  const isUnknown = unknownPatterns.some((pattern) => code.includes(pattern) || name.includes(pattern) || message.includes(pattern));
  return isUnknown ? "unknown" : "failed";
}

const ADMISSION_REASON_BY_ERROR_NAME: Record<string, TransportAdmissionReason> = {
  RequestBudgetExceededError: "budget_exhausted",
  UnresolvedAttemptBlockError: "unresolved_outcome",
};

function wrapAdmissionError(error: unknown): TransportAdmissionError {
  const name = (error as { name?: unknown })?.name;
  const reason = (typeof name === "string" && ADMISSION_REASON_BY_ERROR_NAME[name]) || "audit_storage";
  const message = error instanceof Error ? error.message : String(error);
  return new TransportAdmissionError(reason, `AI 请求审计准入拒绝（${reason}）: ${message}`, error);
}

export function isTerminalTransportError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "UnknownTransportOutcomeError" || name === "TransportAdmissionError";
}

function promptFingerprint(request: CompletionRequest) {
  const hash = createHash("sha256");
  for (const message of request.messages) {
    hash.update(message.role);
    hash.update("\u0000");
    hash.update(message.content);
    hash.update("\u0001");
  }
  return hash.digest("hex");
}

function promptBytes(request: CompletionRequest) {
  return request.messages.reduce((total, message) => total + Buffer.byteLength(message.content, "utf8"), 0);
}

const RETRY_BASE_DELAY_MS = 250;
const RETRY_MAX_DELAY_MS = 2_000;

function retryDelayMs(attemptIndex: number) {
  return Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attemptIndex - 1));
}

type AuditedDispatchOutcome = {
  rawText: string;
  finishReason: string | null;
  usage: UsageSnapshot;
};

/**
 * 受控插桩派发：每次真实调用先准入后结算；瞬时已知失败可在额度内受控重试；
 * unknown 结局（未拿到响应）或准入拒绝直接抛终态错误，绝不自动重试。
 */
async function dispatchWithAudit<T>(
  input: {
    hooks?: TransportAuditHooks;
    base: Omit<TransportAttemptContext, "requestId" | "attemptIndex">;
    maxRetries: number;
    run: () => Promise<T>;
    outcomeOf: (result: T) => AuditedDispatchOutcome;
  },
): Promise<T & { requestId: string }> {
  const { hooks, base, maxRetries, run, outcomeOf } = input;
  let attemptIndex = 0;
  for (;;) {
    const context: TransportAttemptContext = { ...base, requestId: randomUUID(), attemptIndex };
    if (hooks) {
      try {
        await hooks.beforeDispatch(context);
      } catch (error) {
        throw wrapAdmissionError(error);
      }
    }
    try {
      const result = await run();
      if (hooks) {
        const outcome = outcomeOf(result);
        await hooks.settle(context, {
          status: "succeeded",
          rawText: outcome.rawText,
          finishReason: outcome.finishReason,
          usage: outcome.usage,
        });
      }
      return { ...result, requestId: context.requestId } as T & { requestId: string };
    } catch (error) {
      const status = classifyTransportOutcome(error);
      if (hooks) {
        await hooks.settle(context, {
          status,
          errorName: typeof (error as { name?: unknown } | null)?.name === "string"
            ? (error as { name: string }).name
            : undefined,
          errorMessage: error instanceof Error ? error.message : String(error),
        }).catch((settleError) => {
          throw wrapAdmissionError(settleError);
        });
      }
      if (status === "unknown") {
        throw new UnknownTransportOutcomeError(
          `模型调用结局未知（超时/中断/网络），已停止自动重试: ${error instanceof Error ? error.message : String(error)}`,
          error,
        );
      }
      if (attemptIndex >= maxRetries || !isTransientModelApiError(error)) throw error;
      attemptIndex += 1;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attemptIndex)));
    }
  }
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

/** 生产传输：AI SDK + openai-compatible provider（SDK 内建重试关闭，重试受控插桩）。 */
export function createAiSdkTransport(options?: {
  fetch?: typeof fetch;
  /** 瞬时重试次数（受控插桩重试；默认 1，对齐原自研语义）。 */
  maxRetries?: number;
  /** 结构化输出：开启后带 schema 的请求走 generateObject（response_format json_schema）；
   *  端点不支持时自动回退 json_object 模式并记住该端点。 */
  supportsStructuredOutputs?: boolean;
  /** 审计钩子：真实传输调用粒度准入与原始响应回执。 */
  auditHooks?: TransportAuditHooks;
}): ModelTransport {
  const providerCache = new Map<string, ReturnType<typeof createOpenAICompatible>>();
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const auditHooks = options?.auditHooks;
  // 端点不支持 json_schema 时的回退记忆（key = 模型配置指纹）
  const structuredFallback = new Set<string>();

  const auditBase = (request: CompletionRequest, config: ModelApiConfig, attemptType: TransportAttemptContext["attemptType"]) => ({
    attemptType,
    model: config.model,
    baseURL: config.baseURL ?? null,
    usageKey: request.usageKey,
    step: request.step,
    promptFingerprint: promptFingerprint(request),
    promptBytes: promptBytes(request),
  });

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
          // M3.1 起 adaptive 模型不接受显式 disabled（API 400），这类模型保持省略、按自适应运行。
          if (isMiniMax(config) && !isMiniMaxAdaptiveModel(config)) {
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
    const baseAttemptType = request.attemptType ?? "initial";

    // 结构化输出路径：语法由模型侧约束解码保证；端点不支持则回退 json_object。
    // 该尝试是一次真实传输调用，同样过审计准入与回执结算。
    const schema = request.schema;
    if (schema && options?.supportsStructuredOutputs && !structuredFallback.has(cacheKey)) {
      try {
        const result = await dispatchWithAudit({
          hooks: auditHooks,
          base: auditBase(request, config, baseAttemptType),
          maxRetries,
          run: async () => {
            const structured = await generateObject({
              model,
              schema,
              ...baseParams,
              maxRetries: 0,
            });
            return {
              text: JSON.stringify(structured.object),
              finishReason: String(structured.finishReason ?? "stop"),
              reasoningLength: 0,
              usage: normalizeUsage(undefined, request.messages, JSON.stringify(structured.object), config, {
                inputTokens: structured.usage?.inputTokens ?? null,
                outputTokens: structured.usage?.outputTokens ?? null,
                totalTokens: structured.usage?.totalTokens ?? null,
                inputTokenDetails: structured.usage?.inputTokenDetails,
                raw: structured.usage?.raw,
              }),
            };
          },
          outcomeOf: (result) => ({
            rawText: result.text,
            finishReason: result.finishReason,
            usage: result.usage,
          }),
        });
        return result;
      } catch (error) {
        if (isTerminalTransportError(error)) throw error;
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

    const result = await dispatchWithAudit({
      hooks: auditHooks,
      base: auditBase(
        request,
        config,
        // 结构化输出不支持触发的回退是一次独立的真实调用，单独标注。
        schema && options?.supportsStructuredOutputs && structuredFallback.has(cacheKey) && baseAttemptType === "initial"
          ? "structured_fallback"
          : baseAttemptType,
      ),
      maxRetries,
      run: async () => {
        const completion = await generateText({
          model,
          ...baseParams,
          maxRetries: 0,
          providerOptions: {
            openaiCompatible: { strictJsonSchema: false },
          },
        });
        return {
          text: completion.text ?? "",
          finishReason: String(completion.finishReason ?? "stop"),
          reasoningLength: (completion.reasoning ?? "").length,
          usage: normalizeUsage(undefined, request.messages, completion.text, config, {
            inputTokens: completion.usage?.inputTokens ?? null,
            outputTokens: completion.usage?.outputTokens ?? null,
            totalTokens: completion.usage?.totalTokens ?? null,
            inputTokenDetails: completion.usage?.inputTokenDetails,
            raw: completion.usage?.raw,
          }),
        };
      },
      outcomeOf: (result) => ({
        rawText: result.text,
        finishReason: result.finishReason,
        usage: result.usage,
      }),
    });

    return result;
  };
}

type CompatClient = {
  chat: {
    completions: {
      create: (request: Record<string, unknown>) => Promise<unknown>;
    };
  };
};

/** 兼容传输：老 OpenAICompatibleClient 替身（tests）直连；重试为受控插桩循环。 */
export function createCompatClientTransport(
  client: unknown,
  options?: { maxRetries?: number; auditHooks?: TransportAuditHooks },
): ModelTransport {
  const typed = client as CompatClient;
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const auditHooks = options?.auditHooks;

  const callOnce = (request: CompletionRequest, config: ModelApiConfig) => {
    const wire: Record<string, unknown> = {
      model: config.model,
      messages: request.messages,
      max_tokens: request.maxTokens ?? undefined,
      temperature: request.temperature ?? undefined,
      top_p: request.topP ?? undefined,
      response_format: request.requireCompleteJson ? { type: "json_object" } : undefined,
    };
    if (isMiniMax(config) && !isMiniMaxAdaptiveModel(config)) {
      wire.thinking = { type: "disabled" };
    }
    return typed.chat.completions.create(wire) as Promise<WireCompletionResponse>;
  };

  return async (request, config) => {
    const result = await dispatchWithAudit({
      hooks: auditHooks,
      base: {
        attemptType: request.attemptType ?? "initial",
        model: config.model,
        baseURL: config.baseURL ?? null,
        usageKey: request.usageKey,
        step: request.step,
        promptFingerprint: promptFingerprint(request),
        promptBytes: promptBytes(request),
      },
      maxRetries,
      run: async () => {
        const response = await callOnce(request, config);
        const choice = response.choices?.[0];
        const content = choice?.message?.content?.trim() ?? "";
        return {
          text: content,
          finishReason: choice?.finish_reason ?? null,
          reasoningLength: choice?.message?.reasoning_content?.trim().length ?? 0,
          usage: normalizeUsage(response.usage, request.messages, content, config),
        };
      },
      outcomeOf: (result) => ({
        rawText: result.text,
        finishReason: result.finishReason,
        usage: result.usage,
      }),
    });

    return result;
  };
}

export { estimateTokens, normalizeUsage };
