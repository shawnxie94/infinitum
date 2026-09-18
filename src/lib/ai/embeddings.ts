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
    create: (payload: Record<string, unknown>) => Promise<EmbeddingsResponse>;
  };
};

export type EmbedTextsFn = (texts: string[]) => Promise<number[][] | null>;

export function isEmbeddingConfigReady(
  config: EmbeddingRuntimeConfig | null | undefined,
): config is EmbeddingRuntimeConfig {
  return Boolean(
    config?.enabled && config.baseUrl && config.modelName && config.apiKey,
  );
}

export function buildEmbeddingCacheHash(modelName: string, text: string): string {
  return createHash("sha256").update(`${modelName}\n${text}`).digest("hex");
}

export function buildEmbeddingText(title: string, summary: string | null | undefined): string {
  return `${title}\n${(summary ?? "").trim()}`;
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
      maxRetries: 2,
    }) as unknown as EmbeddingApiClient);

  return async (texts: string[]): Promise<number[][] | null> => {
    if (texts.length === 0) {
      return [];
    }

    try {
      const hashes = texts.map((text) => buildEmbeddingCacheHash(modelName, text));
      const cached = await loadCachedVectors(hashes);
      const vectors: Array<number[] | null> = hashes.map((hash) => cached.get(hash) ?? null);
      const misses = vectors
        .map((vector, index) => ({ vector, index }))
        .filter((entry) => entry.vector === null)
        .map((entry) => entry.index);

      for (let start = 0; start < misses.length; start += batchSize) {
        const slice = misses.slice(start, start + batchSize);
        const payload: Record<string, unknown> = {
          model: modelName,
          input: slice.map((index) => texts[index]),
        };
        if (config.dimensions && config.dimensions > 0) {
          payload.dimensions = config.dimensions;
        }

        const response = await client.embeddings.create(payload);
        const data = response.data ?? [];
        if (data.length !== slice.length) {
          return null;
        }

        // Responses may be unordered; index field is the contract when present.
        const ordered: Array<number[] | null> = slice.map(() => null);
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

        for (let i = 0; i < slice.length; i += 1) {
          const index = slice[i]!;
          const vector = ordered[i]!;
          vectors[index] = vector;
          await storeCachedVector({
            model: modelName,
            contentHash: hashes[index]!,
            text: texts[index]!,
            vector,
          });
        }
      }

      if (vectors.some((vector) => vector === null)) {
        return null;
      }

      return vectors as number[][];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[embeddings] 调用失败，降级为纯规则排序: ${message.slice(0, 200)}`);
      return null;
    }
  };
}
