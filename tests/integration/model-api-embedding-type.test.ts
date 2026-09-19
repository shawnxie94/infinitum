import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db";
import {
  createModelApiConfig,
  createPromptConfig,
  getAdminSettings,
  getIngestionRuntimeConfig,
} from "@/lib/settings/service";

function buildChatInput(overrides: Partial<Parameters<typeof createModelApiConfig>[0]> = {}) {
  return {
    type: "chat" as const,
    name: "聊天模型",
    baseUrl: "https://chat.example.com/v1",
    apiKey: "sk-chat",
    modelName: "gpt-test",
    ingestionItemConcurrency: 3,
    customHeaders: {},
    dimensions: null,
    batchSize: null,
    timeoutMs: null,
    isEnabled: true,
    isDefault: true,
    ...overrides,
  };
}

function buildEmbeddingInput(overrides: Partial<Parameters<typeof createModelApiConfig>[0]> = {}) {
  return {
    type: "embedding" as const,
    name: "向量模型",
    baseUrl: "https://embed.example.com/v1",
    apiKey: "sk-embed",
    modelName: "BAAI/bge-m3",
    ingestionItemConcurrency: 3,
    customHeaders: {},
    dimensions: null,
    batchSize: 32,
    timeoutMs: 15000,
    isEnabled: true,
    isDefault: false,
    ...overrides,
  };
}

describe("model api config embedding type", () => {
  beforeEach(async () => {
    await prisma.item.deleteMany();
    await prisma.promptConfig.deleteMany();
    await prisma.modelApiConfig.deleteMany();
  });

  it("rejects isDefault on embedding configs", async () => {
    await expect(createModelApiConfig(buildEmbeddingInput({ isDefault: true }))).rejects.toThrow(
      "向量模型不支持设为默认模型",
    );
  });

  it("validates embedding tuning ranges", async () => {
    await expect(createModelApiConfig(buildEmbeddingInput({ dimensions: 8 }))).rejects.toThrow("向量维度");
    await expect(createModelApiConfig(buildEmbeddingInput({ batchSize: 0 }))).rejects.toThrow("批量大小");
    await expect(createModelApiConfig(buildEmbeddingInput({ timeoutMs: 100 }))).rejects.toThrow("请求超时");
  });

  it("keeps only one enabled embedding config", async () => {
    const first = await createModelApiConfig(buildEmbeddingInput({ name: "向量A" }));
    const second = await createModelApiConfig(buildEmbeddingInput({ name: "向量B" }));

    const rows = await prisma.modelApiConfig.findMany({ where: { type: "embedding" } });
    const enabled = rows.filter((row) => row.isEnabled);
    expect(enabled).toHaveLength(1);
    expect(enabled[0]?.id).toBe(second.id);

    // 禁用第二条后，第一条不会自动恢复启用（启用态只由保存动作驱动）
    const disabled = rows.find((row) => row.id === first.id);
    expect(disabled?.isEnabled).toBe(false);
  });

  it("resolves runtime embedding from the enabled embedding config without touching chat default", async () => {
    const chat = await createModelApiConfig(buildChatInput());
    await createModelApiConfig(buildEmbeddingInput());

    const runtime = await getIngestionRuntimeConfig();

    expect(runtime.modelApi.baseURL).toBe(chat.baseUrl);
    expect(runtime.modelApi.model).toBe(chat.modelName);
    expect(runtime.embedding.enabled).toBe(true);
    expect(runtime.embedding.baseUrl).toBe("https://embed.example.com/v1");
    expect(runtime.embedding.modelName).toBe("BAAI/bge-m3");
    expect(runtime.embedding.batchSize).toBe(32);
  });

  it("disables the embedding channel when no embedding config is enabled", async () => {
    await createModelApiConfig(buildChatInput());
    await createModelApiConfig(buildEmbeddingInput({ isEnabled: false }));

    const runtime = await getIngestionRuntimeConfig();

    expect(runtime.embedding.enabled).toBe(false);
  });

  it("excludes entity alias check prompt rows from admin settings snapshot", async () => {
    await createModelApiConfig(buildChatInput());
    await prisma.promptConfig.create({
      data: {
        name: "默认实体别名判定提示词",
        type: "entity_alias_check",
        prompt: "",
        userPrompt: "候选实体对 JSON：{{pairsJson}}",
        isEnabled: true,
        isDefault: true,
      },
    });

    const settings = await getAdminSettings();

    expect(settings.promptConfigs.find((config) => config.type === "entity_alias_check")).toBeUndefined();
  });

  it("rejects prompt configs linked to an embedding model config", async () => {
    const chat = await createModelApiConfig(buildChatInput());
    const embedding = await createModelApiConfig(buildEmbeddingInput());

    await expect(
      createPromptConfig({
        name: "条目理解",
        type: "item_understanding",
        userPrompt: null,
        modelApiConfigId: embedding.id,
        isEnabled: true,
        isDefault: true,
      }),
    ).rejects.toThrow("提示词不能关联向量模型配置");

    await expect(
      createPromptConfig({
        name: "条目理解",
        type: "item_understanding",
        userPrompt: null,
        modelApiConfigId: chat.id,
        isEnabled: true,
        isDefault: true,
      }),
    ).resolves.toBeDefined();
  });
});
