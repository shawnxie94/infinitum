const LEADING_THINK_BLOCK_PATTERN = /^(?:\s*<think>[\s\S]*?<\/think>\s*)+/i;

// JSON 规范禁止字符串字面量内出现未转义的 C0 控制字符（U+0000-U+001F）。
// \t \n \r 在 token 之间是合法空白，必须保留；其余控制字符在 JSON 任何位置都非法，
// 出现即整篇文档被 JSON.parse 拒绝。模型偶发在回抄文本时把空格吐成 NUL（实测
// 2026-10-03：reasonText 内 "The\u0000 New Stack" 使整批判定作废），故在此剔除。
const NEVER_LEGAL_JSON_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

export function stripCodeFence(value: string) {
  return value.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

export function stripLeadingThinking(value: string) {
  return value.replace(LEADING_THINK_BLOCK_PATTERN, '').trim();
}

export function stripIllegalJsonControlChars(value: string) {
  return value.replace(NEVER_LEGAL_JSON_CONTROL_CHARS, '');
}

export function normalizeModelResponseText(value: string | null | undefined) {
  return stripIllegalJsonControlChars(
    stripCodeFence(stripLeadingThinking(stripCodeFence(value ?? ''))),
  );
}
