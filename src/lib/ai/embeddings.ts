import OpenAI from "openai";

import type { RuntimeConfig } from "@/config/runtime";
import { prisma } from "@/lib/db";
import {
  createEmbedTexts as createFrameworkEmbedTexts,
  decodeVector,
  encodeVector,
  isEmbeddingClientConfigReady,
  type EmbeddingApiClient,
  type EmbeddingVectorStore,
} from "@infinitum/ai/provider/embeddings";

export type EmbeddingRuntimeConfig = RuntimeConfig["embedding"];

export type { EmbeddingApiClient } from "@infinitum/ai/provider/embeddings";
export type { EmbedTextsFn } from "@infinitum/ai/provider/embeddings";
export {
  buildEmbeddingCacheHash,
  cosineSimilarity,
  resetEmbeddingFailureCache,
} from "@infinitum/ai/provider/embeddings";

export function isEmbeddingConfigReady(
  config: EmbeddingRuntimeConfig | null | undefined,
): config is EmbeddingRuntimeConfig {
  return isEmbeddingClientConfigReady(config);
}

export function buildEmbeddingText(
  title: string,
  summary: string | null | undefined,
  event?: {
    eventType?: string | null;
    eventSubject?: string | null;
    eventAction?: string | null;
    eventObject?: string | null;
    eventDate?: string | null;
  },
): string {
  if (!event) {
    return `${title}\n${(summary ?? "").trim()}`;
  }

  const lines = [
    `标题：${title.trim()}`,
    event.eventType ? `事件类型：${event.eventType}` : null,
    event.eventSubject ? `主体：${event.eventSubject}` : null,
    event.eventAction ? `动作：${event.eventAction}` : null,
    event.eventObject ? `对象：${event.eventObject}` : null,
    event.eventDate ? `日期：${event.eventDate}` : null,
    summary?.trim() ? `摘要：${summary.trim()}` : null,
  ];
  return lines.filter(Boolean).join("\n");
}

// Prisma 向量缓存适配器：框架侧只认 EmbeddingVectorStore 接口。
const prismaVectorStore: EmbeddingVectorStore = {
  async loadCached(hashes: string[]): Promise<Map<string, number[]>> {
    if (hashes.length === 0) {
      return new Map();
    }

    const rows = await prisma.embeddingCache.findMany({
      where: { contentHash: { in: hashes } },
      select: { contentHash: true, vector: true },
    });

    return new Map(rows.map((row) => [row.contentHash, decodeVector(row.vector)]));
  },
  async storeCached(entry) {
    try {
      await prisma.embeddingCache.create({
        data: {
          model: entry.model,
          contentHash: entry.contentHash,
          text: entry.text,
          dims: entry.vector.length,
          vector: encodeVector(entry.vector),
        },
      });
    } catch (error) {
      // Concurrent runs may insert the same hash; keeping one row is enough.
      if ((error as { code?: string }).code !== "P2002") {
        throw error;
      }
    }
  },
};

export function createEmbedTexts(
  config: EmbeddingRuntimeConfig | null | undefined,
  deps: { client?: EmbeddingApiClient | null } = {},
) {
  const ready = isEmbeddingClientConfigReady(config);
  const client =
    deps.client ??
    (ready
      ? (new OpenAI({
          apiKey: config.apiKey,
          baseURL: config.baseUrl,
          timeout: config.timeoutMs ?? 15_000,
          // 批次级失败由嵌入管线内部隔离降级，SDK 不做批级重试（避免挂起文本 ×3 放大时延）
          maxRetries: 0,
        }) as unknown as EmbeddingApiClient)
      : null);

  return createFrameworkEmbedTexts(config, { client, vectorStore: prismaVectorStore });
}
