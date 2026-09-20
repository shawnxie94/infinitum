/**
 * 模型网关（spec P1a）：自研 provider HTTP 层的替代引擎。
 * 语义对齐原 provider-client/provider：瞬时重试、按配置熔断（域级回退）、
 * JSON 解析重试、阶段上下文多轮、采样温度契约、用量归一与上报。
 */
import { InvalidJsonModelResponse } from "./transports";
import type {
  ChatMessage,
  CompletionRequest,
  JsonCompleteRequest,
  ModelApiConfig,
  ModelGatewayOptions,
  ModelTransport,
  StageContext,
  UsageSnapshot,
} from "./types";

export { InvalidJsonModelResponse as InvalidJsonModelResponseError };

/**
 * 跨模块判定：业务解析层（主仓）与网关各自有同名错误类，instanceof 不可靠，
 * 统一按 name 判定（与 stage-loop 的 duck-typing 口径一致）。
 */
function isInvalidJsonModelResponse(error: unknown): error is Error {
  return Boolean(
    error && typeof error === "object" && (error as { name?: unknown }).name === "InvalidJsonModelResponseError",
  );
}

const DEFAULT_TRANSIENT_RETRY_COUNT = 1;
const DEFAULT_JSON_PARSE_RETRY_COUNT = 1;
const DEFAULT_CIRCUIT = { failureThreshold: 3, windowMs: 60_000, openMs: 180_000 };

export type JsonParseRetryPromptBuilder = (userContent: string, error: Error) => string;

function defaultBuildJsonParseRetryPrompt(userContent: string, error: Error) {
  return `${userContent}

重要：上一次输出不是合法 JSON，解析错误：${error.message}
请重新生成，必须只输出一个合法 JSON 对象，不要输出 Markdown、代码块或额外解释。请检查字段之间的逗号、完整闭合的括号，以及字符串内部双引号和换行的 JSON 转义。`;
}

function getErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const maybe = error as { status?: unknown; statusCode?: unknown; code?: unknown };
  const raw = maybe.status ?? maybe.statusCode ?? maybe.code;
  if (typeof raw === "number" && Number.isInteger(raw)) return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw)) return Number(raw);
  return null;
}

function isTransientModelApiError(error: unknown) {
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

type CircuitState = { failures: number[]; openUntil: number };

function modelApiCircuitKey(config: ModelApiConfig) {
  return [config.apiKey ?? "", config.baseURL ?? "", config.model].join("|");
}

function isSameModelApiConfig(left: ModelApiConfig, right: ModelApiConfig) {
  return left.apiKey === right.apiKey && left.baseURL === right.baseURL && left.model === right.model;
}

export type ModelGateway = {
  readonly defaultModelApi: ModelApiConfig;
  completeText(
    request: CompletionRequest,
    execution: { config: ModelApiConfig; attemptType?: UsageSnapshot["attemptType"] },
  ): Promise<{ text: string; usage: UsageSnapshot } | null>;
  /** JSON 任务：解析重试（无 stageContext）或阶段上下文多轮（有 stageContext）。parse 抛 InvalidJsonModelResponse 触发重试。 */
  completeJson<T>(request: JsonCompleteRequest, parse: (output: string) => T): Promise<T | null>;
  isCircuitOpen(config: ModelApiConfig, now?: number): boolean;
};

export function createModelGateway(options: ModelGatewayOptions): ModelGateway {
  const circuit = options.circuitBreaker ?? DEFAULT_CIRCUIT;
  const transientRetryCount = options.transientRetryCount ?? DEFAULT_TRANSIENT_RETRY_COUNT;
  const jsonParseRetryCount = options.jsonParseRetryCount ?? DEFAULT_JSON_PARSE_RETRY_COUNT;
  const buildRetryPrompt = options.buildJsonParseRetryPrompt ?? defaultBuildJsonParseRetryPrompt;
  const lockedTypes = options.temperatureLockedTaskTypes ?? new Set<string>();
  const circuitStates = new Map<string, CircuitState>();
  const transport: ModelTransport = options.transport;

  function circuitStateFor(config: ModelApiConfig) {
    const key = modelApiCircuitKey(config);
    let state = circuitStates.get(key);
    if (!state) {
      state = { failures: [], openUntil: 0 };
      circuitStates.set(key, state);
    }
    return state;
  }

  function recordSuccess(config: ModelApiConfig) {
    const state = circuitStateFor(config);
    state.failures = [];
    state.openUntil = 0;
  }

  function recordFailure(config: ModelApiConfig, now = Date.now()) {
    const state = circuitStateFor(config);
    const windowStart = now - circuit.windowMs;
    state.failures = [...state.failures.filter((t) => t >= windowStart), now];
    if (state.failures.length >= circuit.failureThreshold) {
      state.openUntil = now + circuit.openMs;
    }
    return state.openUntil > now;
  }

  async function completeTextOnce(
    config: ModelApiConfig,
    request: CompletionRequest,
    attemptType: UsageSnapshot["attemptType"],
  ): Promise<{ text: string; usage: UsageSnapshot } | null> {
    if (!config.apiKey) return null;
    const result = await transport(request, config);
    const usage: UsageSnapshot = { ...result.usage, attemptType };
    options.onUsage?.(usage, request.usageKey);
    if (request.requireCompleteJson && result.finishReason === "length") {
      throw new InvalidJsonModelResponse(
        `模型 JSON 输出被截断（finish_reason=length，content=${result.text.length} 字符，reasoning=${result.reasoningLength} 字符）`,
      );
    }
    const text = result.text ? (options.normalizeText ? options.normalizeText(result.text) : result.text) : "";
    return { text, usage };
  }

  async function completeTextWithTransientRetry(
    config: ModelApiConfig,
    request: CompletionRequest,
    attemptType: UsageSnapshot["attemptType"],
  ): Promise<{ text: string; usage: UsageSnapshot } | null> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= transientRetryCount; attempt += 1) {
      try {
        return await completeTextOnce(config, request, attempt > 0 ? "transient_retry" : attemptType);
      } catch (error) {
        if (isInvalidJsonModelResponse(error)) throw error;
        lastError = error;
        if (attempt >= transientRetryCount || !isTransientModelApiError(error)) throw error;
      }
    }
    throw lastError;
  }

  async function completeTextWithCircuitBreaker(
    request: CompletionRequest,
    config: ModelApiConfig,
    attemptType: UsageSnapshot["attemptType"],
  ): Promise<{ text: string; usage: UsageSnapshot } | null> {
    const isDefaultModel = isSameModelApiConfig(config, options.defaultModelApi);
    const selectedConfig = !isDefaultModel && circuitStateFor(config).openUntil > Date.now() ? options.defaultModelApi : config;

    try {
      const result = await completeTextWithTransientRetry(selectedConfig, request, attemptType);
      if (!isDefaultModel && isSameModelApiConfig(selectedConfig, config)) {
        recordSuccess(config);
      }
      return result;
    } catch (error) {
      if (isInvalidJsonModelResponse(error)) throw error;
      console.error("[ModelGateway] completeText failed:", error);
      if (isDefaultModel || !isSameModelApiConfig(selectedConfig, config)) {
        throw error;
      }
      const opened = recordFailure(config);
      if (!opened) throw error;
      return completeTextWithTransientRetry(options.defaultModelApi, request, attemptType);
    }
  }

  function buildStageMessages(request: JsonCompleteRequest, context: StageContext): ChatMessage[] {
    if (context.messages.length === 0) {
      context.messages.push(
        { role: "system", content: request.systemPrompt },
        { role: "user", content: request.userContent },
      );
      return context.messages;
    }
    const feedback = request.validationFeedback;
    if (!feedback) {
      throw new Error(`阶段上下文 ${context.stage} 缺少校验反馈。`);
    }
    if (context.stage !== feedback.stage) {
      throw new Error(`阶段上下文 ${context.stage} 只能接收同阶段校验反馈。`);
    }
    context.repairRound += 1;
    context.lastViolations = feedback.violations;
    context.messages.push({
      role: "user",
      content: [
        "VALIDATION_FEEDBACK",
        JSON.stringify(feedback),
        "只修正反馈中列出的问题，返回完整的当前阶段 JSON 结果。",
      ].join("\n"),
    });
    return context.messages;
  }

  return {
    defaultModelApi: options.defaultModelApi,

    isCircuitOpen(config: ModelApiConfig, now = Date.now()) {
      return circuitStateFor(config).openUntil > now;
    },

    async completeText(request, execution) {
      return completeTextWithCircuitBreaker(request, execution.config, execution.attemptType ?? "initial");
    },

    async completeJson<T>(rawRequest: JsonCompleteRequest, parse: (output: string) => T): Promise<T | null> {
      const request = applySamplingLock(rawRequest);
      const config = request.modelApi ?? options.defaultModelApi;

      // 阶段上下文模式：同一 transcript 内做校验反馈修复，不做整请求重试（D1 语义）。
      if (request.stageContext) {
        const context = request.stageContext;
        const messages = buildStageMessages(request, context);
        context.contextTokenEstimate = Math.ceil(
          context.messages.reduce((total, message) => total + message.content.length, 0) / 4,
        );
        const result = await completeTextWithCircuitBreaker(
          { messages, requireCompleteJson: true, usageKey: request.usageKey },
          config,
          "stage_context",
        );
        const output = result?.text ?? null;
        const normalized = output?.trim() ?? "";
        context.lastOutput = normalized;
        context.messages.push({ role: "assistant", content: normalized });
        if (!normalized) {
          throw new InvalidJsonModelResponse(`阶段 ${context.stage} 未返回 JSON 内容。`);
        }
        return parse(normalized);
      }

      // 普通 JSON 模式：解析失败换修复提示重试。
      let lastParseError: Error | null = null;
      for (let attempt = 0; attempt <= jsonParseRetryCount; attempt += 1) {
        const userContent = attempt === 0 || !lastParseError
          ? request.userContent
          : buildRetryPrompt(request.userContent, lastParseError);
        let result: { text: string; usage: UsageSnapshot } | null;
        try {
          result = await completeTextWithCircuitBreaker(
            {
              messages: [
                { role: "system", content: request.systemPrompt },
                { role: "user", content: userContent },
              ],
              temperature: request.temperature,
              maxTokens: request.maxTokens,
              topP: request.topP,
              requireCompleteJson: true,
              usageKey: request.usageKey,
            },
            config,
            attempt > 0 ? "json_retry" : "initial",
          );
        } catch (error) {
          if (!isInvalidJsonModelResponse(error) || attempt >= jsonParseRetryCount) throw error;
          lastParseError = error;
          continue;
        }
        if (result == null) return null;
        try {
          return parse(result.text);
        } catch (error) {
          if (!isInvalidJsonModelResponse(error) || attempt >= jsonParseRetryCount) throw error;
          lastParseError = error;
        }
      }
      return null;
    },
  };

  function applySamplingLock(request: JsonCompleteRequest): JsonCompleteRequest {
    if (!lockedTypes.has(request.taskType)) {
      return request;
    }
    return { ...request, temperature: 0 };
  }
}
