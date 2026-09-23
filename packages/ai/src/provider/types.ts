import type { ZodType } from "zod";

/**
 * 模型网关类型（spec P1a）：与具体传输无关的请求/响应形状。
 * 传输实现负责映射到 @ai-sdk/openai-compatible 或兼容 client。
 */

export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = { role: ChatRole; content: string };

export type StepExecutionIdentity = {
  stepId: string;
  workflowId?: string;
  workflowRunId?: string;
  taskRunId?: string;
};

export type ModelApiConfig = {
  apiKey?: string | null;
  baseURL?: string | null;
  model: string;
  customHeaders?: Record<string, string> | null;
};

/** 一次补全请求（业务语义层）。 */
export type CompletionRequest = {
  messages: ChatMessage[];
  temperature?: number | null;
  maxTokens?: number | null;
  topP?: number | null;
  /** JSON 模式：注入 response_format json_object；finish_reason=length 报截断。 */
  requireCompleteJson?: boolean;
  signal?: AbortSignal;
  /** 用量归集键（网关 onUsage 透传）。 */
  usageKey?: string;
  /** 当前 Mastra step，用于 usage/attempt 按 step 归因。 */
  step?: StepExecutionIdentity;
  /** 结构化输出（可选）：提供时走模型侧 JSON Schema 约束解码（generateObject），
   * 语法错误在模型侧消除；端点不支持时传输层自动回退 json_object 模式。 */
  schema?: ZodType;
};

export type UsageAttemptType = "initial" | "json_retry" | "transient_retry" | "stage_context";

export type UsageSnapshot = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  cachedTokensReported: boolean;
  tokenUsageSource: "provider" | "estimated" | "mixed";
  model: string;
  attemptType?: UsageAttemptType;
  step?: StepExecutionIdentity;
};

export type CompletionResult = {
  text: string;
  finishReason: string | null;
  reasoningLength: number;
  usage: UsageSnapshot;
};

/** 传输：把补全请求送到具体模型 API。生产 = @ai-sdk/openai-compatible；测试 = 兼容 client 注入。 */
export type ModelTransport = (request: CompletionRequest, config: ModelApiConfig) => Promise<CompletionResult>;

export type ModelGatewayOptions = {
  defaultModelApi: ModelApiConfig;
  /** 传输：生产传 createAiSdkTransport()，测试可注入兼容 client 传输。 */
  transport: ModelTransport;
  /** 文本归一化钩子（主仓 normalizeModelResponseText 语义：剥 ```json 围栏等）。 */
  normalizeText?: (text: string) => string;
  /** JSON 解析失败重试提示组装（默认内置中文版）。 */
  buildJsonParseRetryPrompt?: JsonParseRetryPromptBuilder;
  /** 采样温度锁定的任务类型：这些 taskType 强制 temperature 0（applySamplingContract 契约）。 */
  temperatureLockedTaskTypes?: ReadonlySet<string>;
  circuitBreaker?: {
    failureThreshold: number;
    windowMs: number;
    openMs: number;
  };
  jsonParseRetryCount?: number;
  /** usage 上报（逐次调用）。 */
  onUsage?: (usage: UsageSnapshot, usageKey?: string) => void;
  /** 通用 attempt 分类；不携带 token，供产品层审计 retry/fallback 次数。 */
  onAttempt?: (event: { usageKey?: string; attemptType: "initial" | "json_retry" | "transient_retry" | "structured_fallback" | "business_repair"; step?: StepExecutionIdentity }) => void;
};

type JsonParseRetryPromptBuilder = (userContent: string, error: Error) => string;

export type JsonCompleteRequest = {
  taskType: string;
  systemPrompt: string;
  userContent: string;
  /** 结构化输出 schema（可选，见 CompletionRequest.schema）。 */
  schema?: ZodType;
  temperature?: number | null;
  maxTokens?: number | null;
  topP?: number | null;
  /** 域级执行配置（不同 modelApi 的熔断与回退）。缺省用 defaultModelApi。 */
  modelApi?: ModelApiConfig;
  usageKey?: string;
  /** 当前 Mastra step，用于 usage/attempt 按 step 归因。 */
  step?: StepExecutionIdentity;
  /** operation contract 可覆盖的 JSON 解析重试次数。 */
  jsonParseRetryCount?: number;
  /** 日报阶段上下文模式：多轮对话 transcript，由网关维护追加。 */
  stageContext?: StageContext;
  validationFeedback?: StageValidationFeedback;
};

export type StageContextMessage = ChatMessage;

export type StageContext = {
  stage: string;
  messages: StageContextMessage[];
  repairRound: number;
  cleanRetryAttempt: number;
  lastOutput: string | null;
  lastViolations: unknown[];
  inputHash?: string;
  contextTokenEstimate?: number;
  contextOverflow?: boolean;
};

export type StageValidationFeedback = {
  type: "VALIDATION_FEEDBACK";
  stage: string;
  violations: unknown[];
  missingNotes?: Array<{ topicId: string; noteLabel: string; blockKey?: string; noteInstruction?: string }>;
  instruction: string;
};
