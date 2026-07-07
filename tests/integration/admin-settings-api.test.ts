import { afterEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/db";

const requireAdmin = vi.fn();
const getAdminSettings = vi.fn();
const createModelApiConfig = vi.fn();
const createPromptConfig = vi.fn();
const getModelApiConfig = vi.fn();
const updatePromptConfig = vi.fn();
const createHeaderLink = vi.fn();
const updateEventBriefingConfig = vi.fn();
const updateBriefingPreferenceConfig = vi.fn();

vi.mock("@/lib/admin/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admin/session")>();

  return {
    ...actual,
    requireAdmin,
  };
});

vi.mock("@/lib/settings/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/settings/service")>();

  return {
    ...actual,
    getAdminSettings,
    createModelApiConfig,
    createPromptConfig,
    createHeaderLink,
    updateEventBriefingConfig,
    updateBriefingPreferenceConfig,
    getModelApiConfig,
    updatePromptConfig,
  };
});

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe("/api/admin/settings", () => {
  it("returns the settings payload for admins", async () => {
    requireAdmin.mockResolvedValue(undefined);
    getAdminSettings.mockResolvedValue({
      modelApiConfigs: [
        {
          id: "model-1",
          name: "默认模型配置",
          baseUrl: "https://example.com/v1",
          modelName: "gpt-test",
          ingestionItemConcurrency: 3,
          apiKeyMasked: "••••••••••••",
          hasApiKey: true,
          isEnabled: true,
          isDefault: true,
          createdAt: "2026-04-20T10:00:00.000Z",
          updatedAt: "2026-04-20T10:00:00.000Z",
        },
      ],
      promptConfigs: [
        {
          id: "prompt-1",
          name: "默认条目摘要提示词",
          type: "item_summary",
          prompt: "标题：{{title}}\n来源：{{sourceName}}\n正文：{{inputText}}",
          systemPrompt: "摘要内容",
          temperature: null,
          maxTokens: null,
          topP: null,
          modelApiConfigId: "model-1",
          modelApiConfigName: "默认模型配置",
          isUsingDefaultModel: false,
          isEnabled: true,
          isDefault: true,
          createdAt: "2026-04-20T10:00:00.000Z",
          updatedAt: "2026-04-20T10:00:00.000Z",
        },
      ],
      blacklistKeywords: ["layoffs"],
      taskSchedule: {
        key: "ingestion_default",
        enabled: true,
        cronExpression: "0 * * * *",
        sourceConcurrency: 2,
        fullTextFetchThreshold: 80,
        timezone: "Asia/Shanghai",
        lastHeartbeatAt: "2026-04-20T10:00:00.000Z",
        lastRunStartedAt: "2026-04-20T10:00:00.000Z",
        lastRunFinishedAt: "2026-04-20T10:05:00.000Z",
        lastRunStatus: "succeeded",
        nextRunAt: "2026-04-20T11:00:00.000Z",
        isHeartbeatStale: false,
      },
      groups: [{ id: "group-1", name: "Core" }],
      sources: [],
    });

    const { GET } = await import("@/app/api/admin/settings/route");
    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.modelApiConfigs[0].apiKeyMasked).toBe("••••••••••••");
    expect(json.promptConfigs[0].type).toBe("item_summary");
    expect(json.taskSchedule.key).toBe("ingestion_default");
  });

  it("returns raw api key only from the single model config detail endpoint", async () => {
    requireAdmin.mockResolvedValue(undefined);
    getModelApiConfig.mockResolvedValue({
      id: "model-1",
      name: "默认模型配置",
      baseUrl: "https://example.com/v1",
      modelName: "gpt-test",
      ingestionItemConcurrency: 3,
      apiKeyMasked: "••••••••••••",
      apiKeyRaw: "sk-test-1234",
      hasApiKey: true,
      isEnabled: true,
      isDefault: true,
      createdAt: "2026-04-20T10:00:00.000Z",
      updatedAt: "2026-04-20T10:00:00.000Z",
    });

    const { GET } = await import("@/app/api/admin/settings/model-api-configs/[id]/route");
    const response = await GET(new Request("http://localhost/api/admin/settings/model-api-configs/model-1"), {
      params: Promise.resolve({ id: "model-1" }),
    });
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.apiKeyMasked).toBe("••••••••••••");
    expect(json.apiKeyRaw).toBe("sk-test-1234");
  });

  it("creates model api configs for admins", async () => {
    requireAdmin.mockResolvedValue(undefined);
    createModelApiConfig.mockResolvedValue({ id: "model-1" });

    const { POST } = await import("@/app/api/admin/settings/model-api-configs/route");
    const response = await POST(
      new Request("http://localhost/api/admin/settings/model-api-configs", {
        method: "POST",
        body: JSON.stringify({
          name: "默认模型配置",
          baseUrl: "https://example.com/v1",
          apiKey: "sk-test",
          modelName: "gpt-4.1-mini",
          ingestionItemConcurrency: 4,
          isEnabled: true,
          isDefault: true,
        }),
        headers: {
          "content-type": "application/json",
        },
      }),
    );

    expect(response.status).toBe(201);
    expect(createModelApiConfig).toHaveBeenCalledWith({
      name: "默认模型配置",
      baseUrl: "https://example.com/v1",
      apiKey: "sk-test",
      apiKeyMode: "replace",
      modelName: "gpt-4.1-mini",
      ingestionItemConcurrency: 4,
      customHeaders: {},
      isEnabled: true,
      isDefault: true,
    });
  });

  it("creates header links for admins", async () => {
    requireAdmin.mockResolvedValue(undefined);
    createHeaderLink.mockResolvedValue({
      id: "header-link-aff",
      label: "AFF",
      url: "https://shawnxie.top/aff/",
      enabled: true,
      sortOrder: 0,
      openInNewTab: true,
      rel: "sponsored noopener noreferrer",
      createdAt: "2026-06-28T00:00:00.000Z",
      updatedAt: "2026-06-28T00:00:00.000Z",
    });

    const { POST } = await import("@/app/api/admin/settings/header-links/route");
    const response = await POST(
      new Request("http://localhost/api/admin/settings/header-links", {
        method: "POST",
        body: JSON.stringify({
          label: "AFF",
          url: "https://shawnxie.top/aff/",
          enabled: true,
          sortOrder: 0,
          openInNewTab: true,
          rel: "sponsored noopener noreferrer",
        }),
        headers: {
          "content-type": "application/json",
        },
      }),
    );
    const json = await response.json();

    expect(response.status).toBe(201);
    expect(json.link.label).toBe("AFF");
    expect(createHeaderLink).toHaveBeenCalledWith({
      label: "AFF",
      url: "https://shawnxie.top/aff/",
      enabled: true,
      sortOrder: 0,
      openInNewTab: true,
      rel: "sponsored noopener noreferrer",
    });
  });

  it("updates event briefing settings for admins", async () => {
    requireAdmin.mockResolvedValue(undefined);
    updateEventBriefingConfig.mockResolvedValue({
      id: "event-briefing-config",
      minRankScore: 10,
      channels: [
        {
          id: "important",
          name: "重点事件",
          sourceGroupIds: [],
          enabled: true,
          sortOrder: 0,
        },
      ],
      createdAt: "2026-06-30T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    updateBriefingPreferenceConfig.mockResolvedValue({
      id: "briefing-preference-config",
      weightedRules: [
        { type: "tag", value: "AI Coding", weight: 6 },
        { type: "event_type", value: "security", weight: -2 },
      ],
      maxCuratorBoost: 15,
      maxCuratorPenalty: 20,
      createdAt: "2026-06-30T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    });

    const { PATCH } = await import("@/app/api/admin/settings/event-briefing/route");
    const response = await PATCH(
      new Request("http://localhost/api/admin/settings/event-briefing", {
        method: "PATCH",
        body: JSON.stringify({
          config: {
            minRankScore: 10,
            channels: [
              {
                id: "important",
                name: "重点事件",
                sourceGroupIds: [],
                enabled: true,
                sortOrder: 0,
              },
            ],
          },
          preference: {
            weightedRules: [
              { type: "tag", value: "AI Coding", weight: 6 },
              { type: "event_type", value: "security", weight: -2 },
            ],
            maxCuratorBoost: 15,
            maxCuratorPenalty: 20,
          },
        }),
        headers: {
          "content-type": "application/json",
        },
      }),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.eventBriefing.config.minRankScore).toBe(10);
    expect(updateEventBriefingConfig).toHaveBeenCalledWith({
      minRankScore: 10,
      channels: [
        {
          id: "important",
          name: "重点事件",
          sourceGroupIds: [],
          enabled: true,
          sortOrder: 0,
        },
      ],
    });
    expect(updateBriefingPreferenceConfig).toHaveBeenCalledWith({
      weightedRules: [
        { type: "tag", value: "AI Coding", weight: 6 },
        { type: "event_type", value: "security", weight: -2 },
      ],
      maxCuratorBoost: 15,
      maxCuratorPenalty: 20,
    });
  });

  it("creates prompt configs for admins", async () => {
    requireAdmin.mockResolvedValue(undefined);
    createPromptConfig.mockResolvedValue({ id: "prompt-1" });

    const { POST } = await import("@/app/api/admin/settings/prompt-configs/route");
    const response = await POST(
      new Request("http://localhost/api/admin/settings/prompt-configs", {
        method: "POST",
        body: JSON.stringify({
          name: "默认条目摘要提示词",
          type: "item_summary",
          prompt: "标题：{{title}}\n来源：{{sourceName}}\n正文：{{inputText}}",
          systemPrompt: "摘要内容",
          temperature: null,
          maxTokens: null,
          topP: null,
          modelApiConfigId: "model-1",
          isEnabled: true,
          isDefault: true,
        }),
        headers: {
          "content-type": "application/json",
        },
      }),
    );

    expect(response.status).toBe(201);
    expect(createPromptConfig).toHaveBeenCalledWith({
      name: "默认条目摘要提示词",
      type: "item_summary",
      prompt: "标题：{{title}}\n来源：{{sourceName}}\n正文：{{inputText}}",
      systemPrompt: "摘要内容",
      temperature: null,
      maxTokens: null,
      topP: null,
      modelApiConfigId: "model-1",
      isEnabled: true,
      isDefault: true,
    });
  });

  it("accepts cluster merge prompt configs", async () => {
    requireAdmin.mockResolvedValue(undefined);
    createPromptConfig.mockResolvedValue({ id: "prompt-merge" });

    const { POST } = await import("@/app/api/admin/settings/prompt-configs/route");
    const response = await POST(
      new Request("http://localhost/api/admin/settings/prompt-configs", {
        method: "POST",
        body: JSON.stringify({
          name: "默认聚合合并提示词",
          type: "cluster_merge",
          prompt: "候选聚合 Pair JSON：{{clustersJson}}",
          systemPrompt: "聚合合并系统提示词",
          temperature: 0,
          maxTokens: 2000,
          topP: null,
          modelApiConfigId: null,
          isEnabled: true,
          isDefault: true,
        }),
        headers: {
          "content-type": "application/json",
        },
      }),
    );

    expect(response.status).toBe(201);
    expect(createPromptConfig).toHaveBeenCalledWith({
      name: "默认聚合合并提示词",
      type: "cluster_merge",
      prompt: "候选聚合 Pair JSON：{{clustersJson}}",
      systemPrompt: "聚合合并系统提示词",
      temperature: 0,
      maxTokens: 2000,
      topP: null,
      modelApiConfigId: null,
      isEnabled: true,
      isDefault: true,
    });
  });

  it("accepts aggregation split prompt configs", async () => {
    requireAdmin.mockResolvedValue(undefined);
    createPromptConfig.mockResolvedValue({ id: "prompt-aggregation" });

    const { POST } = await import("@/app/api/admin/settings/prompt-configs/route");
    const response = await POST(
      new Request("http://localhost/api/admin/settings/prompt-configs", {
        method: "POST",
        body: JSON.stringify({
          name: "默认聚合拆分提示词",
          type: "item_aggregation",
          prompt: "标题：{{title}}\n来源：{{sourceName}}\n正文：{{inputText}}",
          systemPrompt: "聚合拆分系统提示词",
          temperature: 0,
          maxTokens: 8000,
          topP: null,
          modelApiConfigId: null,
          isEnabled: true,
          isDefault: true,
        }),
        headers: {
          "content-type": "application/json",
        },
      }),
    );

    expect(response.status).toBe(201);
    expect(createPromptConfig).toHaveBeenCalledWith({
      name: "默认聚合拆分提示词",
      type: "item_aggregation",
      prompt: "标题：{{title}}\n来源：{{sourceName}}\n正文：{{inputText}}",
      systemPrompt: "聚合拆分系统提示词",
      temperature: 0,
      maxTokens: 8000,
      topP: null,
      modelApiConfigId: null,
      isEnabled: true,
      isDefault: true,
    });
  });

  it("passes daily report templateJson to the prompt config service", async () => {
    requireAdmin.mockResolvedValue(undefined);
    createPromptConfig.mockResolvedValue({ id: "prompt-daily" });

    const { POST } = await import("@/app/api/admin/settings/prompt-configs/route");
    const response = await POST(
      new Request("http://localhost/api/admin/settings/prompt-configs", {
        method: "POST",
        body: JSON.stringify({
          name: "结构化日报提示词",
          type: "daily_report",
          prompt: "日期：{{date}}\n候选内容 JSON：{{articlesJson}}",
          systemPrompt: "编译后的系统提示词",
          templateJson: "{\"opening\":{\"label\":\"摘要\"}}",
          temperature: 0,
          maxTokens: 8000,
          topP: null,
          modelApiConfigId: null,
          isEnabled: true,
          isDefault: true,
        }),
        headers: {
          "content-type": "application/json",
        },
      }),
    );

    expect(response.status).toBe(201);
    expect(createPromptConfig).toHaveBeenCalledWith({
      name: "结构化日报提示词",
      type: "daily_report",
      prompt: "日期：{{date}}\n候选内容 JSON：{{articlesJson}}",
      systemPrompt: "编译后的系统提示词",
      templateJson: "{\"opening\":{\"label\":\"摘要\"}}",
      temperature: 0,
      maxTokens: 8000,
      topP: null,
      modelApiConfigId: null,
      isEnabled: true,
      isDefault: true,
    });
  });

  it("updates cluster merge prompt configs", async () => {
    requireAdmin.mockResolvedValue(undefined);
    updatePromptConfig.mockResolvedValue({ id: "prompt-merge" });

    const { PUT } = await import("@/app/api/admin/settings/prompt-configs/[id]/route");
    const response = await PUT(
      new Request("http://localhost/api/admin/settings/prompt-configs/prompt-merge", {
        method: "PUT",
        body: JSON.stringify({
          name: "默认聚合合并提示词",
          type: "cluster_merge",
          prompt: "候选聚合 Pair JSON：{{clustersJson}}",
          systemPrompt: "聚合合并系统提示词",
          temperature: 0,
          maxTokens: 2000,
          topP: null,
          modelApiConfigId: null,
          isEnabled: true,
          isDefault: true,
        }),
        headers: {
          "content-type": "application/json",
        },
      }),
      {
        params: Promise.resolve({ id: "prompt-merge" }),
      },
    );

    expect(response.status).toBe(200);
    expect(updatePromptConfig).toHaveBeenCalledWith("prompt-merge", {
      name: "默认聚合合并提示词",
      type: "cluster_merge",
      prompt: "候选聚合 Pair JSON：{{clustersJson}}",
      systemPrompt: "聚合合并系统提示词",
      temperature: 0,
      maxTokens: 2000,
      topP: null,
      modelApiConfigId: null,
      isEnabled: true,
      isDefault: true,
    });
  });
});

describe("/api/admin/settings/sources", () => {
  it("returns aggregation detection flags in the paginated source list", async () => {
    requireAdmin.mockResolvedValue(undefined);
    await prisma.item.deleteMany();
    await prisma.source.deleteMany();
    await prisma.sourceGroup.deleteMany();
    await prisma.source.create({
      data: {
        name: "Aggregation Source",
        rssUrl: "https://aggregation.example.com/feed.xml",
        siteUrl: "https://aggregation.example.com",
        enabled: true,
        aiParsingEnabled: true,
        aggregationEnabled: true,
        aggregationDetectionEnabled: true,
      },
    });

    const { GET } = await import("@/app/api/admin/settings/sources/route");
    const response = await GET(new Request("http://localhost/api/admin/settings/sources?page=1&pageSize=10"));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.sources).toEqual([
      expect.objectContaining({
        name: "Aggregation Source",
        aggregationEnabled: true,
        aggregationDetectionEnabled: true,
      }),
    ]);
  });
});
