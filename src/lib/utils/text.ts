/**
 * 文本处理工具函数
 * 提供通用的文本规范化、清理和转换功能
 */

/**
 * 规范化可选文本值
 * 去除首尾空白，如果结果为空则返回 null 或 fallback
 */
export function normalizeOptionalText(
  value: string | null | undefined,
  fallback: string | null = null,
): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed || fallback;
}

/**
 * 规范化文本值
 * 去除首尾空白，处理 null/undefined 为 ""
 */
export function normalizeText(value: string | null | undefined): string {
  return value?.trim() || "";
}

/**
 * 折叠多个连续空白为单个空格
 */
export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * 去除文本边界标点符号
 */
export function trimBoundaryPunctuation(value: string): string {
  return value.replace(/^[\s,.;:()[\]{}\-_/]+|[\s,.;:()[\]{}\-_/]+$/g, "").trim();
}

/**
 * 去除 HTML 标签
 */
export function stripHtmlTags(html: string | null | undefined): string {
  if (!html) {
    return "";
  }
  return html.replace(/<[^>]*>/g, "");
}

/**
 * 规范化关键词
 * 去除首尾空白
 */
export function normalizeKeyword(keyword: string): string {
  return keyword.trim();
}

/**
 * 尝试解析 URL
 * 解析失败返回 null
 */
export function tryParseUrl(value: string | null | undefined): URL | null {
  if (!value) {
    return null;
  }

  try {
    return new URL(value.trim());
  } catch {
    return null;
  }
}

/**
 * 规范化 URL
 * 去除首尾空白，解析失败返回 null
 */
export function normalizeUrl(value: string | null | undefined): string | null {
  return tryParseUrl(value)?.toString() ?? null;
}
