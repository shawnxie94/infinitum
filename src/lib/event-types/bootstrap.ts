import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { validateEventTypeDefinitions } from "@/lib/event-types/validation";
import type { EventTypeDefinitionInput } from "@/lib/event-types/types";

export class BootstrapEventTypesConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BootstrapEventTypesConfigError";
  }
}

export type BootstrapEventTypesConfig = {
  eventTypes?: EventTypeDefinitionInput[];
};

/**
 * 引导配置（config/infinitum.config.json，或 INFINITUM_CONFIG_PATH 指向文件）
 * 的 eventTypes 域包读取：
 * - 文件缺失 / eventTypes 字段缺失 / 空数组 → null（使用内置十条默认）；
 * - 显式提供但非法（非数组、条目形状错误、重复 key、受保护违规、别名冲突）
 *   → 抛 BootstrapEventTypesConfigError，绝不静默回退 AI 默认。
 * 仅注册表初始化时读取；运行期不回读，管理员编辑不会被配置文件覆盖。
 */
export function readBootstrapEventTypes(): EventTypeDefinitionInput[] | null {
  const configPath = process.env.INFINITUM_CONFIG_PATH
    ? path.resolve(process.cwd(), process.env.INFINITUM_CONFIG_PATH)
    : path.resolve(process.cwd(), "config", "infinitum.config.json");

  if (!existsSync(configPath)) {
    return null;
  }

  let parsed: BootstrapEventTypesConfig;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8")) as BootstrapEventTypesConfig;
  } catch (error) {
    throw new BootstrapEventTypesConfigError(
      `引导配置 JSON 解析失败（${configPath}）：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new BootstrapEventTypesConfigError(`引导配置顶层必须是对象（${configPath}）。`);
  }

  if (parsed.eventTypes === undefined || parsed.eventTypes === null) {
    return null;
  }

  if (!Array.isArray(parsed.eventTypes)) {
    throw new BootstrapEventTypesConfigError("引导配置 eventTypes 必须是数组。");
  }

  if (parsed.eventTypes.length === 0) {
    return null;
  }

  for (const entry of parsed.eventTypes) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new BootstrapEventTypesConfigError("eventTypes 条目必须是对象。");
    }
    const candidate = entry as Record<string, unknown>;
    if (candidate.label !== undefined && typeof candidate.label !== "string") {
      throw new BootstrapEventTypesConfigError("eventTypes 条目 label 必须是字符串。");
    }
    if (candidate.key !== undefined && candidate.key !== null && typeof candidate.key !== "string") {
      throw new BootstrapEventTypesConfigError("eventTypes 条目 key 必须是字符串或 null。");
    }
    if (candidate.description !== undefined && candidate.description !== null && typeof candidate.description !== "string") {
      throw new BootstrapEventTypesConfigError("eventTypes 条目 description 必须是字符串或 null。");
    }
    if (candidate.aliases !== undefined && !Array.isArray(candidate.aliases)) {
      throw new BootstrapEventTypesConfigError("eventTypes 条目 aliases 必须是字符串数组。");
    }
    if (candidate.enabled !== undefined && typeof candidate.enabled !== "boolean") {
      throw new BootstrapEventTypesConfigError("eventTypes 条目 enabled 必须是布尔值。");
    }
    if (candidate.sortOrder !== undefined && typeof candidate.sortOrder !== "number") {
      throw new BootstrapEventTypesConfigError("eventTypes 条目 sortOrder 必须是数字。");
    }
  }

  // 显式定义走完整校验：重复 key、受保护违规、别名冲突都在此拒绝并原样上抛。
  return validateEventTypeDefinitions(parsed.eventTypes);
}
