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
import { canonicalizeCustomRequestParams } from "./custom-request-params";
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

/**
 * 模型能力策略：thinking 开关（集中一处，SDK 与兼容路径共用同一份判定）。
 *
 * 官方协议（MiniMax OpenAI 兼容接口，2026-10-20 核对）：
 * https://platform.minimax.io/docs/api-reference/text-openai-api.md
 *  - `thinking.type` 可取 `disabled` / `adaptive`；省略即默认开启思考。
 *  - `MiniMax-M3.1-Flash` 恒思考：显式 `disabled`（含 reasoning_effort=none）
 *    直接返回 400，错误码 2013：
 *    `model "MiniMax-M3.1-Flash" requires adaptive thinking;
 *     thinking.type="disabled" (including reasoning.effort=none) is not allowed (2013)`
 *  - `MiniMax-M3` 接受 `disabled`（跳过思考直接作答）；M2.x 接受但忽略。
 *  - `reasoning_split=true` 把思考内容分离到 `reasoning_content`，
 *    `false` 会把思考包在 content 的 think 标签里；M3.1-Flash 不支持 false。
 */
export type ThinkingPolicy = {
  /** 请求体应写入的 thinking 字段；undefined = 不写（端点默认行为）。 */
  thinking?: { type: "disabled" | "adaptive" };
  /** 是否要求把思考内容分离到 reasoning_content（保护 JSON 正文不被 think 标签污染）。 */
  reasoningSplit?: boolean;
  /** 该模型是否强制要求 adaptive thinking（禁用 thinking 即 400/2013）。 */
  requiresAdaptiveThinking: boolean;
};

/** 强制 adaptive thinking 的模型（官方点名 MiniMax-M3.1-Flash 恒思考）。 */
const MINIMAX_REQUIRED_ADAPTIVE_PATTERN = /m3[._-]?1[._-]?flash/;

/**
 * 解析 thinking 策略。
 *
 * - 非 MiniMax：不写任何 thinking 字段（沿用 OpenAI 兼容端点默认）。
 * - MiniMax-M3.1-Flash：必须 adaptive，并把思考分离到 reasoning_content，
 *   否则思考文本会混进 content，JSON 正文不再可解析。
 * - 其余 MiniMax 模型（M3 / M2.x）：保持既有 `disabled` 行为不变。
 */
export function resolveThinkingPolicy(config: ModelApiConfig): ThinkingPolicy {
  if (!isMiniMax(config)) {
    return { requiresAdaptiveThinking: false };
  }
  if (MINIMAX_REQUIRED_ADAPTIVE_PATTERN.test(config.model.toLowerCase())) {
    return {
      thinking: { type: "adaptive" },
      reasoningSplit: true,
      requiresAdaptiveThinking: true,
    };
  }
  return {
    thinking: { type: "disabled" },
    requiresAdaptiveThinking: false,
  };
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

function failedAuditDetails(error: unknown) {
  const chain: object[] = [];
  const seen = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current && typeof current === "object" && !seen.has(current); depth += 1) {
    seen.add(current);
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  const firstString = (key: string) => {
    for (const item of chain) {
      const value = (item as Record<string, unknown>)[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
    return undefined;
  };
  const number = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
  const rawUsageObjects: Record<string, unknown>[] = [];
  const normalizedUsageObjects: Record<string, unknown>[] = [];
  for (const item of chain) {
    const usage = (item as { usage?: unknown }).usage;
    if (usage && typeof usage === "object") {
      const usageRecord = usage as Record<string, unknown>;
      if (usageRecord.tokenUsageSource !== "estimated" && usageRecord.tokenUsageSource !== "mixed") {
        const raw = usageRecord.raw;
        if (raw && typeof raw === "object") rawUsageObjects.push(raw as Record<string, unknown>);
        else normalizedUsageObjects.push(usageRecord);
      }
    }
    const responseBody = (item as { response?: { body?: unknown } }).response?.body;
    if (responseBody && typeof responseBody === "object") {
      const responseUsage = (responseBody as { usage?: unknown }).usage;
      if (responseUsage && typeof responseUsage === "object") rawUsageObjects.push(responseUsage as Record<string, unknown>);
    }
  }
  // AI SDK usage.totalTokens is normalized by summing input/output tokens. Prefer
  // provider raw fields when present; without raw usage, retain only the SDK's
  // direct input/output values and leave total unknown.
  const usageObjects = rawUsageObjects.length > 0 ? rawUsageObjects : normalizedUsageObjects;
  const findUsage = (keys: string[]) => {
    for (const usage of usageObjects) {
      if (usage.tokenUsageSource === "estimated" || usage.tokenUsageSource === "mixed") continue;
      for (const key of keys) {
        const value = number(usage[key]);
        if (value !== undefined) return value;
      }
    }
    return undefined;
  };
  const promptTokens = findUsage(rawUsageObjects.length > 0
    ? ["prompt_tokens", "input_tokens", "inputTokens", "promptTokens"]
    : ["inputTokens", "promptTokens"]);
  const completionTokens = findUsage(rawUsageObjects.length > 0
    ? ["completion_tokens", "output_tokens", "outputTokens", "completionTokens"]
    : ["outputTokens", "completionTokens"]);
  const totalTokens = rawUsageObjects.length > 0
    ? findUsage(["total_tokens", "totalTokens"])
    : undefined;
  const partialUsage = promptTokens !== undefined || completionTokens !== undefined || totalTokens !== undefined
    ? {
        ...(promptTokens !== undefined ? { promptTokens } : {}),
        ...(completionTokens !== undefined ? { completionTokens } : {}),
        ...(totalTokens !== undefined ? { totalTokens } : {}),
        tokenUsageSource: "provider" as const,
      }
    : undefined;
  return {
    errorName: firstString("name"),
    errorMessage: error instanceof Error ? error.message : String(error),
    finishReason: firstString("finishReason"),
    rawText: firstString("text") ?? firstString("responseBody"),
    usage: partialUsage,
  };
}

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
        const details = failedAuditDetails(error);
        await hooks.settle(context, {
          status,
          ...details,
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
    const customParams = canonicalizeCustomRequestParams(config.customRequestParams);
    const cacheKey = [config.apiKey ?? "", config.baseURL ?? "", config.model, JSON.stringify(config.customHeaders ?? {}), JSON.stringify(customParams)].join("|");
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
          const next: Record<string, unknown> = { ...body, ...customParams };
          // 本仓全部补全都以 JSON 模式工作（解析层消费 JSON 输出）。
          next.response_format = { type: "json_object" };
          // MiniMax 私有 thinking 开关（SDK 与兼容路径共用同一份能力策略）。
          const thinkingPolicy = resolveThinkingPolicy(config);
          if (thinkingPolicy.thinking) {
            next.thinking = thinkingPolicy.thinking;
          }
          // 强制思考的模型必须把思考分离出去，否则 think 标签会污染 JSON 正文。
          if (thinkingPolicy.reasoningSplit) {
            next.reasoning_split = true;
          }
          return { ...next, ...customParams };
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
      ...canonicalizeCustomRequestParams(config.customRequestParams),
      model: config.model,
      messages: request.messages,
      max_tokens: request.maxTokens ?? undefined,
      temperature: request.temperature ?? undefined,
      top_p: request.topP ?? undefined,
      response_format: request.requireCompleteJson ? { type: "json_object" } : undefined,
    };
    // MiniMax 私有 thinking 开关（与 SDK 路径共用同一份能力策略）。
    const thinkingPolicy = resolveThinkingPolicy(config);
    if (thinkingPolicy.thinking) {
      wire.thinking = thinkingPolicy.thinking;
    }
    // 强制思考的模型必须把思考分离出去，否则 think 标签会污染 JSON 正文。
    if (thinkingPolicy.reasoningSplit) {
      wire.reasoning_split = true;
    }
    Object.assign(wire, canonicalizeCustomRequestParams(config.customRequestParams));
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
