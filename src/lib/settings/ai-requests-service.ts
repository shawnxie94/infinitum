import {
  AI_DAILY_CHAT_REQUEST_LIMIT_ENV,
  resolveEnvDailyChatRequestLimit,
  type AiRequestBudgetState,
} from "@/lib/ai/request-budget-env";

/**
 * AI 请求预算只读快照：唯一生效来源是环境变量 AI_DAILY_CHAT_REQUEST_LIMIT。
 * 不读取、不创建、不更新任何 DB 配置；state=unlimited|paused|limited|invalid，
 * invalid 绝不伪装为 unlimited（此时 dailyChatRequestLimit 为 null 但 state 明确标注）。
 */
export function getAiRequestsSettings() {
  const limit = resolveEnvDailyChatRequestLimit();
  return {
    dailyChatRequestLimit: limit.kind === "limit" ? limit.value : null,
    state: limit.state satisfies AiRequestBudgetState,
    sourceEnv: AI_DAILY_CHAT_REQUEST_LIMIT_ENV,
  };
}
