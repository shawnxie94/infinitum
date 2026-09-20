import { afterEach, describe, expect, it } from "vitest";

import type { EmbeddingApiClient } from "@/lib/ai/embeddings";
import { buildEmbeddingCacheHash, createEmbedTexts, resetEmbeddingFailureCache } from "@/lib/ai/embeddings";
import { prisma } from "@/lib/db";

const MODEL = "test-embed-model";

function fakeClient(impl: (input: string[]) => number[][]) {
  let calls = 0;
  const client = {
    embeddings: {
      create: async (payload: Record<string, unknown>) => {
        calls += 1;
        const input = payload.input as string[];
        const vectors = impl(input);
        return {
          data: vectors.map((embedding, index) => ({ embedding, index })),
        };
      },
    },
  } as unknown as EmbeddingApiClient & { embeddings: { create: unknown } };
  return {
    client: client as EmbeddingApiClient,
    callCount: () => calls,
  };
}

afterEach(async () => {
  resetEmbeddingFailureCache();
  await prisma.embeddingCache.deleteMany({ where: { model: MODEL } });
});

describe("createEmbedTexts cache behaviour", () => {
  it("stores fetched vectors and serves subsequent calls from cache", async () => {
    const { client, callCount } = fakeClient((input) =>
      input.map((_, index) => [index + 0.5, 1, 0]),
    );
    const embed = createEmbedTexts(
      {
        enabled: true,
        baseUrl: "http://localhost:3000/v1",
        apiKey: "test-key",
        modelName: MODEL,
        dimensions: null,
        batchSize: 2,
        timeoutMs: 5000,
      },
      { client },
    );

    const texts = ["文本甲", "文本乙", "文本丙"];
    const first = await embed(texts);
    expect(first).not.toBeNull();
    expect(first).toHaveLength(3);
    expect(first![0]).toEqual([0.5, 1, 0]);
    expect(callCount()).toBe(2); // batchSize=2 → 分两批

    const rows = await prisma.embeddingCache.findMany({ where: { model: MODEL } });
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.contentHash).sort()).toEqual(
      texts.map((text) => buildEmbeddingCacheHash(MODEL, text)).sort(),
    );

    // 全量命中缓存：不再调用 API，且顺序保持
    const second = await embed([...texts].reverse());
    expect(callCount()).toBe(2);
    expect(second![2]).toEqual([0.5, 1, 0]);
  });

  it("isolates a failing text inside a batch and caches the healthy ones", async () => {
    const calls: string[][] = [];
    const client = {
      embeddings: {
        create: async (payload: Record<string, unknown>) => {
          const input = payload.input as string[];
          calls.push(input);
          // 毒文本：包含「毒」字的请求整批失败（模拟供应商挂起/500）
          if (input.some((text) => text.includes("毒"))) {
            throw new Error("upstream 500");
          }
          return {
            data: input.map((text, index) => ({ embedding: [text.length + index, 1, 0], index })),
          };
        },
      },
    };
    const embed = createEmbedTexts(
      {
        enabled: true,
        baseUrl: "http://localhost:3000/v1",
        apiKey: "test-key",
        modelName: MODEL,
        dimensions: null,
        batchSize: 8,
        timeoutMs: 5000,
      },
      { client: client as unknown as EmbeddingApiClient },
    );

    const texts = ["健康甲", "毒文本", "健康乙"];
    const result = await embed(texts);
    expect(result).toHaveLength(3);
    // mock 向量 = [批内 index + 文本长度, 1, 0]：单条回退时 index 恒为 0
    expect(result![0]).toEqual([3, 1, 0]);
    expect(result![1]).toBeNull(); // 毒文本跳过
    expect(result![2]).toEqual([3, 1, 0]);

    // 健康文本已入缓存；毒文本负缓存后同轮不重复请求
    const healthyCalls = calls.filter((input) => !input.some((text) => text.includes("毒")));
    const poisonCalls = calls.filter((input) => input.some((text) => text.includes("毒")));
    expect(healthyCalls.length).toBeGreaterThanOrEqual(1);
    // 批次失败 1 次 + 单条隔离 1 次（毒文本自身）
    expect(poisonCalls.length).toBe(2);
    const rows = await prisma.embeddingCache.findMany({ where: { model: MODEL } });
    expect(rows).toHaveLength(2);

    // 再次调用：健康文本走缓存，毒文本走负缓存，不再发起任何请求
    const callsBefore = calls.length;
    const second = await embed(texts);
    expect(second).toHaveLength(3);
    expect(second![1]).toBeNull();
    expect(calls.length).toBe(callsBefore);
  });

  it("degrades to per-text nulls when the API client fails entirely", async () => {
    let calls = 0;
    const failing = {
      embeddings: {
        create: async () => {
          calls += 1;
          throw new Error("connection refused");
        },
      },
    };
    const embed = createEmbedTexts(
      {
        enabled: true,
        baseUrl: "http://localhost:3000/v1",
        apiKey: "test-key",
        modelName: MODEL,
        dimensions: null,
        batchSize: 8,
        timeoutMs: 5000,
      },
      { client: failing as unknown as EmbeddingApiClient },
    );

    const result = await embed(["文本"]);
    expect(result).toEqual([null]);
    const rows = await prisma.embeddingCache.findMany({ where: { model: MODEL } });
    expect(rows).toHaveLength(0);
    // 首轮：1 次批次 + 1 次单条回退
    expect(calls).toBe(2);

    // 负缓存：同进程内同文本不再重复请求
    await embed(["文本"]);
    expect(calls).toBe(2);
  });
});
