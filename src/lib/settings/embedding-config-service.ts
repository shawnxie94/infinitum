import type { EmbeddingConfig } from "@prisma/client";

import { getRuntimeConfig } from "@/config/runtime";
import type { RuntimeConfig } from "@/config/runtime";
import { prisma } from "@/lib/db";
import { maskApiKey, toIsoString } from "@/lib/settings/core";
import type { AdminSettingsSnapshot } from "@/lib/settings/types";

export type SaveEmbeddingConfigInput = {
  enabled: boolean;
  baseUrl: string;
  apiKey?: string;
  apiKeyMode?: "replace" | "clear" | "keep";
  modelName: string;
  dimensions: number | null;
  batchSize: number;
  timeoutMs: number;
};

const EMBEDDING_DEFAULTS = getRuntimeConfig().embedding;

function normalizeBaseUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("请填写 Embedding API 地址。");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Embedding API 地址格式无效。");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Embedding API 地址必须使用 HTTP 或 HTTPS。");
  }

  return parsed.toString();
}

function validateInteger(value: number, min: number, max: number, label: string) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label}需为 ${min}-${max} 的整数。`);
  }
}

export function validateEmbeddingConfigInput(input: SaveEmbeddingConfigInput) {
  normalizeBaseUrl(input.baseUrl);

  if (!input.modelName.trim()) {
    throw new Error("请填写 Embedding 模型名称。");
  }

  if (input.dimensions !== null) {
    validateInteger(input.dimensions, 16, 4096, "向量维度");
  }

  validateInteger(input.batchSize, 1, 128, "批量大小");
  validateInteger(input.timeoutMs, 3_000, 60_000, "请求超时");

  if (input.apiKeyMode === "replace" && !input.apiKey?.trim()) {
    throw new Error("替换 Embedding API Key 时不能为空。");
  }
}

export async function ensureEmbeddingConfig(): Promise<EmbeddingConfig> {
  const existing = await prisma.embeddingConfig.findFirst({
    orderBy: { createdAt: "asc" },
  });

  if (existing) {
    return existing;
  }

  return prisma.embeddingConfig.create({
    data: {
      enabled: EMBEDDING_DEFAULTS.enabled,
      baseUrl: EMBEDDING_DEFAULTS.baseUrl,
      apiKey: EMBEDDING_DEFAULTS.apiKey,
      modelName: EMBEDDING_DEFAULTS.modelName,
      dimensions: EMBEDDING_DEFAULTS.dimensions,
      batchSize: EMBEDDING_DEFAULTS.batchSize,
      timeoutMs: EMBEDDING_DEFAULTS.timeoutMs,
    },
  });
}

export function serializeAdminEmbeddingConfig(
  config: EmbeddingConfig,
): AdminSettingsSnapshot["embedding"] {
  return {
    id: config.id,
    enabled: config.enabled,
    baseUrl: config.baseUrl,
    apiKeyMasked: maskApiKey(config.apiKey ?? ""),
    hasApiKey: Boolean(config.apiKey),
    modelName: config.modelName,
    dimensions: config.dimensions,
    batchSize: config.batchSize,
    timeoutMs: config.timeoutMs,
    createdAt: toIsoString(config.createdAt),
    updatedAt: toIsoString(config.updatedAt),
  };
}

export function serializeRuntimeEmbeddingConfig(
  config: EmbeddingConfig,
): RuntimeConfig["embedding"] {
  return {
    enabled: config.enabled,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    modelName: config.modelName,
    dimensions: config.dimensions,
    batchSize: config.batchSize,
    timeoutMs: config.timeoutMs,
  };
}

export async function updateEmbeddingConfig(input: SaveEmbeddingConfigInput) {
  validateEmbeddingConfigInput(input);

  const current = await ensureEmbeddingConfig();
  const apiKey =
    input.apiKeyMode === "clear"
      ? null
      : input.apiKeyMode === "replace"
        ? input.apiKey?.trim() || null
        : current.apiKey;

  const config = await prisma.embeddingConfig.update({
    where: { id: current.id },
    data: {
      enabled: input.enabled,
      baseUrl: normalizeBaseUrl(input.baseUrl),
      apiKey,
      modelName: input.modelName.trim(),
      dimensions: input.dimensions,
      batchSize: input.batchSize,
      timeoutMs: input.timeoutMs,
    },
  });

  return serializeAdminEmbeddingConfig(config);
}
