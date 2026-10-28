import { EventTypeValidationError } from "@/lib/event-types/types";

// key 的稳定安全机器格式：小写字母/数字开头结尾，中间允许 - 和 _，≤64 字符。
const EVENT_TYPE_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62})[a-z0-9]$/;
const SINGLE_CHAR_KEY_PATTERN = /^[a-z0-9]$/;

/**
 * 把任意输入规整为 key 的机器格式：小写、空白折叠为 -、去掉不允许字符。
 * 返回 null 表示输入无法形成合法 key（调用方报 invalid_key）。
 */
export function normalizeEventTypeKeyInput(value: string | null | undefined): string | null {
  const lowered = (value ?? "").trim().toLowerCase();
  if (!lowered) {
    return null;
  }

  const collapsed = lowered
    .replace(/\s+/gu, "-")
    .replace(/[^a-z0-9_-]+/gu, "")
    .replace(/-{2,}/gu, "-")
    .replace(/^-+|-+$/gu, "");

  if (!collapsed) {
    return null;
  }

  if (SINGLE_CHAR_KEY_PATTERN.test(collapsed) || EVENT_TYPE_KEY_PATTERN.test(collapsed)) {
    return collapsed;
  }

  // 首尾是非字母数字（如下划线开头）时修边再验一次。
  const trimmed = collapsed.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gu, "");
  if (SINGLE_CHAR_KEY_PATTERN.test(trimmed) || EVENT_TYPE_KEY_PATTERN.test(trimmed)) {
    return trimmed;
  }

  return null;
}

export function assertValidEventTypeKey(key: string) {
  if (!SINGLE_CHAR_KEY_PATTERN.test(key) && !EVENT_TYPE_KEY_PATTERN.test(key)) {
    throw new EventTypeValidationError(
      `事件类型 key 只能使用小写字母、数字、- 和 _，且以字母或数字开头结尾（收到：${key}）。`,
      "invalid_key",
    );
  }
}

/** 别名/标签匹配统一走小写折叠，保证 alias 命中稳定。 */
export function foldEventTypeToken(value: string) {
  return value.trim().toLowerCase();
}
