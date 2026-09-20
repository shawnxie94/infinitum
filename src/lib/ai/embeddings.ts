import { createHash } from "node:crypto";

import OpenAI from "openai";

import type { RuntimeConfig } from "@/config/runtime";
import { prisma } from "@/lib/db";

export type EmbeddingRuntimeConfig = RuntimeConfig["embedding"];

type EmbeddingsResponse = {
  data?: Array<{
    embedding?: number[];
    index?: number;
  }>;
  usage?: {
    prompt_tokens?: number;
    total_tokens?: number;
  };
};

export type EmbeddingApiClient = {
  embeddings: {
    create: (
      payload: Record<string, unknown>,
      options?: { maxRetries?: number },
    ) => Promise<EmbeddingsResponse>;
  };
};

// 向量数组与输入文本一一对应；个别文本嵌入失败时对应位为 null，
// 调用方（矩阵构建 / RRF 召回）需容忍缺失。整体 null 仅表示通道不可用。
export type EmbedTextsFn = (texts: string[]) => Promise<Array<number[] | null> | null>;

// 进程内负缓存：嵌入失败的文本哈希，同进程后续调用直接跳过（重试由下一轮任务完成）
const failedEmbeddingHashes = new Set<string>();

export function resetEmbeddingFailureCache() {
  failedEmbeddingHashes.clear();
}

export function isEmbeddingConfigReady(
  config: EmbeddingRuntimeConfig | null | undefined,
): config is EmbeddingRuntimeConfig {
  return Boolean(
    config?.enabled && config.baseUrl && config.modelName && config.apiKey,
  );
}

export function buildEmbeddingCacheHash(
  modelName: string,
  text: string,
  dimensions?: number | null,
): string {
  const dimensionKey = dimensions && dimensions > 0 ? String(Math.floor(dimensions)) : "default";
  return createHash("sha256").update(`${modelName}\n${dimensionKey}\n${text}`).digest("hex");
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

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) {
    return 0;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i += 1) {
    dot += left[i]! * right[i]!;
    leftNorm += left[i]! * left[i]!;
    rightNorm += right[i]! * right[i]!;
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function decodeVector(bytes: Uint8Array): number[] {
  const floats = new Float32Array(
    bytes.buffer,
    bytes.byteOffset,
    Math.floor(bytes.byteLength / 4),
  );
  return Array.from(floats);
}

function encodeVector(values: number[]): Buffer {
  return Buffer.from(new Float32Array(values).buffer);
}

function clampBatchSize(value: number): number {
  if (!Number.isFinite(value)) {
    return 32;
  }

  return Math.min(128, Math.max(1, Math.floor(value)));
}

async function loadCachedVectors(hashes: string[]): Promise<Map<string, number[]>> {
  if (hashes.length === 0) {
    return new Map();
  }

  const rows = await prisma.embeddingCache.findMany({
    where: { contentHash: { in: hashes } },
    select: { contentHash: true, vector: true },
  });

  return new Map(rows.map((row) => [row.contentHash, decodeVector(row.vector)]));
}

async function storeCachedVector(entry: {
  model: string;
  contentHash: string;
  text: string;
  vector: number[];
}) {
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
}

export function createEmbedTexts(
  config: EmbeddingRuntimeConfig | null | undefined,
  deps: { client?: EmbeddingApiClient | null } = {},
): EmbedTextsFn {
  if (!isEmbeddingConfigReady(config)) {
    return async () => null;
  }

  const modelName = config.modelName;
  const batchSize = clampBatchSize(config.batchSize ?? 32);
  const timeoutMs = config.timeoutMs ?? 15_000;
  const client =
    deps.client ??
    (new OpenAI({
      apiKey: config.apiKey!,
      baseURL: config.baseUrl,
      timeout: timeoutMs,
      // 批次级失败由 createEmbedTexts 内部隔离降级，SDK 不做批级重试（避免挂起文本 ×3 放大时延）
      maxRetries: 0,
    }) as unknown as EmbeddingApiClient);

  const embedBatch = async (input: string[]): Promise<number[][] | null> => {
    const response = await client.embeddings.create(
      {
        model: modelName,
        input,
        ...(config.dimensions && config.dimensions > 0 ? { dimensions: config.dimensions } : {}),
      },
      { maxRetries: 0 },
    );
    const data = response.data ?? [];
    if (data.length !== input.length) {
      return null;
    }

    // Responses may be unordered; index field is the contract when present.
    const ordered: Array<number[] | null> = input.map(() => null);
    data.forEach((row, position) => {
      const target = typeof row.index === "number" ? row.index : position;
      if (!row.embedding || target < 0 || target >= ordered.length) {
        return;
      }
      ordered[target] = row.embedding;
    });
    if (ordered.some((vector) => vector === null)) {
      return null;
    }
    return ordered as number[][];
  };

  return async (texts: string[]): Promise<Array<number[] | null> | null> => {
    if (texts.length === 0) {
      return [];
    }

    try {
      const dimensions = config.dimensions && config.dimensions > 0 ? Math.floor(config.dimensions) : null;
      const hashes = texts.map((text) => buildEmbeddingCacheHash(modelName, text, dimensions));
      const cached = await loadCachedVectors(hashes);
      const vectors: Array<number[] | null> = hashes.map((hash) => cached.get(hash) ?? null);
      const misses = hashes
        .map((hash, index) => ({ hash, index }))
        .filter((entry) => vectors[entry.index] === null && !failedEmbeddingHashes.has(entry.hash));

      let failureCount = 0;
      for (let start = 0; start < misses.length; start += batchSize) {
        const slice = misses.slice(start, start + batchSize);
        let batchVectors: number[][] | null = null;
        try {
          batchVectors = await embedBatch(slice.map((entry) => texts[entry.index]!));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[embeddings] 批次异常: ${message.slice(0, 120)}`);
        }

        if (batchVectors) {
          for (let i = 0; i < slice.length; i += 1) {
            const { hash, index } = slice[i]!;
            vectors[index] = batchVectors[i]!;
            await storeCachedVector({
              model: modelName,
              contentHash: hash,
              text: texts[index]!,
              vector: batchVectors[i]!,
            });
          }
          continue;
        }

        // 批次失败（供应商 5xx / 挂起超时 / 响应不齐）：隔离降级为单条，
        // 好文本照常入缓存，坏文本跳过并记入负缓存，不拖垮整轮。
        console.warn(
          `[embeddings] 批次失败（${slice.length} 条），隔离为单条重试: hash=${slice[0]!.hash.slice(0, 12)}..`,
        );
        for (const entry of slice) {
          let single: number[][] | null = null;
          try {
            single = await embedBatch([texts[entry.index]!]);
          } catch {
            single = null;
          }
          if (single?.[0]) {
            vectors[entry.index] = single[0];
            await storeCachedVector({
              model: modelName,
              contentHash: entry.hash,
              text: texts[entry.index]!,
              vector: single[0],
            });
          } else {
            failureCount += 1;
            failedEmbeddingHashes.add(entry.hash);
            console.warn(
              `[embeddings] 单条嵌入失败，跳过（进程内负缓存）: hash=${entry.hash.slice(0, 12)} text="${texts[entry.index]!.slice(0, 60)}"`,
            );
          }
        }
      }

      if (failureCount > 0) {
        console.warn(`[embeddings] 本轮 ${failureCount} 条文本嵌入失败已跳过`);
      }
      return vectors;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[embeddings] 调用失败，降级为纯规则排序: ${message.slice(0, 200)}`);
      return null;
    }
  };
}
