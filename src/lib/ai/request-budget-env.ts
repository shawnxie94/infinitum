/**
 * AI 每日聊天请求预算的唯一生效来源：环境变量 AI_DAILY_CHAT_REQUEST_LIMIT。
 * - 未设置 / 空串 / 纯空白 = 不限（默认）。
 * - "0" = 暂停全部业务聊天派发；非负十进制整数 = 每日（UTC）硬请求上限。
 * - 其他任何值（负数、小数、科学计数、超安全整数等）= 非法，fail-closed。
 * 每次调用时读取 process.env，不做模块加载期缓存；存量 DB 配置一律忽略。
 * 非法值不回显原始内容（可能是误放的密钥），只保留变量名与配置错误信号。
 */

export const AI_DAILY_CHAT_REQUEST_LIMIT_ENV = "AI_DAILY_CHAT_REQUEST_LIMIT";

/** 预算生效状态：invalid 绝不伪装为 unlimited。 */
export type AiRequestBudgetState = "unlimited" | "paused" | "limited" | "invalid";

export type EnvDailyChatRequestLimit =
  | { kind: "unlimited"; state: "unlimited" }
  | { kind: "limit"; value: number; state: "paused" | "limited" }
  | { kind: "invalid"; state: "invalid" };

export function resolveEnvDailyChatRequestLimit(
  source: Record<string, string | undefined> = process.env,
): EnvDailyChatRequestLimit {
  const raw = source[AI_DAILY_CHAT_REQUEST_LIMIT_ENV];
  if (raw === undefined || raw.trim() === "") return { kind: "unlimited", state: "unlimited" };
  if (!/^\d+$/.test(raw)) return { kind: "invalid", state: "invalid" };
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return { kind: "invalid", state: "invalid" };
  return { kind: "limit", value, state: value === 0 ? "paused" : "limited" };
}
