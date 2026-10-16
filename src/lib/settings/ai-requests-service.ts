import type { AiRequestsConfig } from "@prisma/client";

import { prisma } from "@/lib/db";
import {
  normalizeDailyChatRequestLimit,
  validateDailyChatRequestLimit,
} from "@/lib/ai/request-audit";

/**
 * AI 请求预算配置：单个最小控制项（每日 UTC 业务聊天请求硬上限）。
 * null/缺省 = 不限（默认，向后兼容），0 = 全部暂停，正整数 = 上限。
 */

export type SaveAiRequestsConfigInput = {
  dailyChatRequestLimit: number | null;
};

export async function ensureAiRequestsConfig(): Promise<AiRequestsConfig> {
  const existing = await prisma.aiRequestsConfig.findFirst({
    orderBy: { createdAt: "asc" },
  });
  if (existing) return existing;
  return prisma.aiRequestsConfig.create({ data: { dailyChatRequestLimit: null } });
}

export function serializeAiRequestsConfig(config: AiRequestsConfig) {
  return {
    dailyChatRequestLimit: normalizeDailyChatRequestLimit(config.dailyChatRequestLimit),
    updatedAt: config.updatedAt.toISOString(),
  };
}

export async function getAiRequestsSettings() {
  return serializeAiRequestsConfig(await ensureAiRequestsConfig());
}

export async function updateAiRequestsConfig(input: SaveAiRequestsConfigInput) {
  const dailyChatRequestLimit = validateDailyChatRequestLimit(input.dailyChatRequestLimit);
  const current = await ensureAiRequestsConfig();
  const config = await prisma.aiRequestsConfig.update({
    where: { id: current.id },
    data: { dailyChatRequestLimit },
  });
  return serializeAiRequestsConfig(config);
}
