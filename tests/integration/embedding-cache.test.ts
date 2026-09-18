import { afterEach, describe, expect, it } from "vitest";

import type { EmbeddingApiClient } from "@/lib/ai/embeddings";
import { buildEmbeddingCacheHash, createEmbedTexts } from "@/lib/ai/embeddings";
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

  it("degrades to null when the API client fails", async () => {
    const failing = {
      embeddings: {
        create: async () => {
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
    expect(result).toBeNull();
    const rows = await prisma.embeddingCache.findMany({ where: { model: MODEL } });
    expect(rows).toHaveLength(0);
  });
});
