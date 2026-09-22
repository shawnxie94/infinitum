import { createHash } from "node:crypto";

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { embedMany } from "ai";

// 运行时配置的形状保持宽松（业务侧 RuntimeConfig["embedding"] 结构兼容即可）。
export type EmbeddingClientConfig = {
  enabled?: boolean | null;
  baseUrl?: string | null;
  modelName?: string | null;
  apiKey?: string | null;
  dimensions?: number | null;
  batchSize?: number | null;
  timeoutMs?: number | null;
};

export type ReadyEmbeddingClientConfig = EmbeddingClientConfig & {
  baseUrl: string;
  modelName: string;
  apiKey: string;
};

export function isEmbeddingClientConfigReady(
  config: EmbeddingClientConfig | null | undefined,
): config is ReadyEmbeddingClientConfig {
  return Boolean(
    config?.enabled && config.baseUrl && config.modelName && config.apiKey,
  );
}

// 向量数组与输入文本一一对应；个别文本嵌入失败时对应位为 null，
// 调用方（矩阵构建 / RRF 召回）需容忍缺失。整体 null 仅表示通道不可用。
export type EmbedTextsFn = (texts: string[]) => Promise<Array<number[] | null> | null>;

// 传输缝：输入文本数组 → 与输入对齐的向量数组；失败抛错（由管线隔离降级）。
export type EmbeddingTransport = (values: string[]) => Promise<number[][]>;

// 向量缓存由业务侧注入（框架不感知 Prisma / 存储细节）。
export type EmbeddingVectorStore = {
  loadCached(hashes: string[]): Promise<Map<string, number[]>>;
  storeCached(entry: {
    model: string;
    contentHash: string;
    text: string;
    vector: number[];
  }): Promise<void>;
};

export type EmbeddingDeps = {
  transport: EmbeddingTransport | null;
  vectorStore: EmbeddingVectorStore;
};

export function buildEmbeddingCacheHash(
  modelName: string,
  text: string,
  dimensions?: number | null,
): string {
  const dimensionKey = dimensions && dimensions > 0 ? String(Math.floor(dimensions)) : "default";
  return createHash("sha256").update(`${modelName}\n${dimensionKey}\n${text}`).digest("hex");
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

export function decodeVector(bytes: Uint8Array): number[] {
  const floats = new Float32Array(
    bytes.buffer,
    bytes.byteOffset,
    Math.floor(bytes.byteLength / 4),
  );
  return Array.from(floats);
}

export function encodeVector(values: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(values).buffer);
}

function clampBatchSize(value: number): number {
  if (!Number.isFinite(value)) {
    return 32;
  }

  return Math.min(128, Math.max(1, Math.floor(value)));
}

// 进程内负缓存：嵌入失败的文本哈希，同进程后续调用直接跳过（重试由下一轮任务完成）
const failedEmbeddingHashes = new Set<string>();

export function resetEmbeddingFailureCache() {
  failedEmbeddingHashes.clear();
}

// 默认传输：@ai-sdk/openai-compatible embedMany。maxRetries=0——批次级失败
// 由嵌入管线内部隔离降级为单条，SDK 不做批级重试（避免挂起文本 ×3 放大时延）；
// dimensions 经 providerOptions 透传到 /embeddings 请求体。
export function createOpenAICompatibleEmbeddingTransport(
  config: ReadyEmbeddingClientConfig,
): EmbeddingTransport {
  const provider = createOpenAICompatible({
    name: "infinitum-embedding",
    baseURL: config.baseUrl,
    apiKey: config.apiKey,
  });
  const model = provider.embeddingModel(config.modelName);

  return async (values) => {
    const { embeddings } = await embedMany({
      model,
      values,
      maxRetries: 0,
      abortSignal: config.timeoutMs ? AbortSignal.timeout(config.timeoutMs) : undefined,
      providerOptions: {
        openaiCompatible: {
          ...(config.dimensions && config.dimensions > 0
            ? { dimensions: Math.floor(config.dimensions) }
            : {}),
        },
      },
    });
    return embeddings;
  };
}

export function createEmbedTexts(
  config: EmbeddingClientConfig | null | undefined,
  deps: EmbeddingDeps,
): EmbedTextsFn {
  if (!isEmbeddingClientConfigReady(config) || !deps.transport) {
    return async () => null;
  }

  const modelName = config.modelName;
  const batchSize = clampBatchSize(config.batchSize ?? 32);
  const transport = deps.transport;
  const vectorStore = deps.vectorStore;

  // 传输层返回不齐（协议违约）按批次失败处理，走隔离降级。
  const callTransport = async (values: string[]): Promise<number[][] | null> => {
    const result = await transport(values);
    return Array.isArray(result)
      && result.length === values.length
      && result.every((vector) => Array.isArray(vector))
      ? result
      : null;
  };

  return async (texts: string[]): Promise<Array<number[] | null> | null> => {
    if (texts.length === 0) {
      return [];
    }

    try {
      const dimensions = config.dimensions && config.dimensions > 0 ? Math.floor(config.dimensions) : null;
      const hashes = texts.map((text) => buildEmbeddingCacheHash(modelName, text, dimensions));
      const cached = await vectorStore.loadCached(hashes);
      const vectors: Array<number[] | null> = hashes.map((hash) => cached.get(hash) ?? null);
      const misses = hashes
        .map((hash, index) => ({ hash, index }))
        .filter((entry) => vectors[entry.index] === null && !failedEmbeddingHashes.has(entry.hash));

      let failureCount = 0;
      for (let start = 0; start < misses.length; start += batchSize) {
        const slice = misses.slice(start, start + batchSize);
        let batchVectors: number[][] | null = null;
        try {
          batchVectors = await callTransport(slice.map((entry) => texts[entry.index]!));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[embeddings] 批次异常: ${message.slice(0, 120)}`);
        }

        if (batchVectors) {
          for (let i = 0; i < slice.length; i += 1) {
            const { hash, index } = slice[i]!;
            vectors[index] = batchVectors[i]!;
            await vectorStore.storeCached({
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
            single = await callTransport([texts[entry.index]!]);
          } catch {
            single = null;
          }
          if (single?.[0]) {
            vectors[entry.index] = single[0];
            await vectorStore.storeCached({
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
