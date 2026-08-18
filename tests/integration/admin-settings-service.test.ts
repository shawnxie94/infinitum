import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_CLUSTER_MERGE_PROMPT,
  DEFAULT_DAILY_REPORT_PROMPT,
  DEFAULT_ITEM_UNDERSTANDING_PROMPT,
  LEGACY_DEFAULT_CLUSTER_MERGE_PROMPT,
  LEGACY_DEFAULT_ITEM_UNDERSTANDING_PROMPT,
  PREVIOUS_DEFAULT_CLUSTER_MERGE_PROMPT,
  PREVIOUS_DEFAULT_ITEM_UNDERSTANDING_PROMPT,
} from "@/config/prompts";
import { prisma } from "@/lib/db";
import {
  DEFAULT_DAILY_REPORT_TEMPLATE,
  DEFAULT_DAILY_REPORT_TEMPLATE_JSON,
  compileDailyReportTemplatePrompt,
  getLegacyDefaultDailyReportSystemPrompt,
  parseDailyReportTemplateJson,
  stringifyDailyReportTemplate,
} from "@/lib/daily-report/template";
import * as settingsService from "@/lib/settings/service";
import {
  createModelApiConfig,
  createPromptConfig,
  deleteModelApiConfig,
  deletePromptConfig,
  deleteSource,
  deleteSourceGroup,
  ensureRuntimeConfigSeeded,
  getAdminSettings,
  getIngestionRuntimeConfig,
  updateContentExtractionConfig,
} from "@/lib/settings/service";

describe("admin settings service", () => {
  beforeEach(async () => {
    await prisma.item.deleteMany();
    await prisma.fetchRun.deleteMany();
    await prisma.taskSchedule.deleteMany();
    await prisma.promptConfig.deleteMany();
    await prisma.modelApiConfig.deleteMany();
    await prisma.source.deleteMany();
    await prisma.sourceGroup.deleteMany();
    await prisma.blacklistKeyword.deleteMany();
    await prisma.contentExtractionConfig.deleteMany();
    await prisma.eventBriefingConfig.deleteMany();
    await prisma.briefingPreferenceConfig.deleteMany();
  });

  it("seeds code defaults into model and prompt tables when the database is empty", async () => {
    const runtimeConfig = await getIngestionRuntimeConfig();
    const settings = await getAdminSettings();

    expect(runtimeConfig.rssSources.length).toBeGreaterThan(0);
    expect(runtimeConfig.blacklistKeywords).toEqual([]);
    expect(runtimeConfig.ingestion.itemConcurrency).toBe(3);
    expect(runtimeConfig.ingestion.sourceConcurrency).toBe(2);
    expect(runtimeConfig.ingestion.fullTextFetchThreshold).toBe(80);
    expect(runtimeConfig.ingestion.aggregationSplitMaxEvents).toBe(20);
    expect(runtimeConfig.modelApi.apiKey).toBe("");
    expect(runtimeConfig.modelApi.baseURL).toBe("");
    expect(runtimeConfig.modelApi.model).toBe("gpt-4.1-mini");
    expect(runtimeConfig.prompts.itemUnderstanding).toBe(DEFAULT_ITEM_UNDERSTANDING_PROMPT);
    expect(runtimeConfig.selectedPromptConfigs?.itemUnderstanding.promptTemplate).toContain("{{sourceName}}");
    expect(runtimeConfig.selectedPromptConfigs?.itemUnderstanding.promptTemplate).toContain("{{title}}");
    expect(runtimeConfig.selectedPromptConfigs?.itemUnderstanding.promptTemplate).toContain("{{inputText}}");

    expect(settings.modelApiConfigs).toHaveLength(1);
    expect(settings.modelApiConfigs[0]?.baseUrl).toBe("");
    expect(settings.modelApiConfigs[0]?.apiKeyMasked).toBe("");
    expect(settings.modelApiConfigs[0]?.ingestionItemConcurrency).toBe(3);
    expect(settings.taskSchedule.aggregationSplitMaxEvents).toBe(20);
    expect(settings.promptConfigs).toHaveLength(5);
    expect(settings.promptConfigs.find((config) => config.type === "daily_report")?.systemPrompt).toContain("AI 新闻日报");
    expect(settings.promptConfigs.find((config) => config.type === "daily_report")?.templateJson).toBe(
      DEFAULT_DAILY_REPORT_TEMPLATE_JSON,
    );
    expect(settings.promptConfigs.find((config) => config.type === "daily_report")?.systemPrompt).toBe(
      DEFAULT_DAILY_REPORT_PROMPT,
    );
    expect(settings.taskSchedule.key).toBe("ingestion_default");
    expect(settings.taskSchedule.enabled).toBe(false);
    expect(settings.taskSchedule.cronExpression).toBe("0 * * * *");
    expect(settings.taskSchedule.sourceConcurrency).toBe(2);
    expect(settings.taskSchedule.fullTextFetchThreshold).toBe(80);
    expect(settings.eventBriefing.config.minRankScore).toBe(0);
    expect(settings.eventBriefing.preference.maxCuratorBoost).toBe(15);
    expect(settings.eventBriefing.preference.weightedRules).toEqual([]);
    expect(settings.promptConfigs.find((config) => config.type === "item_understanding")?.systemPrompt).toContain(
      "一次完成摘要、内容分析、事件识别与聚合拆分",
    );
    expect(settings.promptConfigs.find((config) => config.type === "item_understanding")).toMatchObject({
      name: "默认条目理解提示词",
      systemPrompt: DEFAULT_ITEM_UNDERSTANDING_PROMPT,
      temperature: 0,
      maxTokens: 8000,
      topP: null,
      modelApiConfigId: null,
      isEnabled: true,
      isDefault: true,
    });
    expect(settings.promptConfigs.find((config) => config.type === "item_understanding")?.systemPrompt).toContain(
      "自动生成实体关联",
    );
    expect(settings.promptConfigs.find((config) => config.type === "item_understanding")?.systemPrompt).not.toContain(
      '"tags":',
    );
    expect(settings.promptConfigs.find((config) => config.type === "cluster_summary")).toMatchObject({
      temperature: 0.2,
      maxTokens: 2000,
      topP: null,
    });
    expect(settings.promptConfigs.find((config) => config.type === "cluster_match")).toMatchObject({
      temperature: 0,
      maxTokens: 80,
      topP: null,
    });
  });

  it("upgrades the previous default item understanding prompt idempotently", async () => {
    await prisma.promptConfig.create({
      data: {
        id: "prompt-previous-default",
        name: "默认条目理解提示词",
        type: "item_understanding",
        prompt: "正文：{{inputText}}",
        systemPrompt: PREVIOUS_DEFAULT_ITEM_UNDERSTANDING_PROMPT,
        isEnabled: true,
        isDefault: true,
      },
    });

    await ensureRuntimeConfigSeeded();

    const upgraded = await prisma.promptConfig.findUniqueOrThrow({
      where: { id: "prompt-previous-default" },
    });
    expect(upgraded.systemPrompt).toBe(DEFAULT_ITEM_UNDERSTANDING_PROMPT);

    // Idempotent: a second run leaves the already-upgraded row unchanged.
    await ensureRuntimeConfigSeeded();
    const afterSecondRun = await prisma.promptConfig.findUniqueOrThrow({
      where: { id: "prompt-previous-default" },
    });
    expect(afterSecondRun.systemPrompt).toBe(DEFAULT_ITEM_UNDERSTANDING_PROMPT);
  });

  it("never overwrites administrator-edited item understanding prompts", async () => {
    const customPrompt = "这是一条管理员手工修改过的自定义条目理解提示词。";
    await prisma.promptConfig.create({
      data: {
        id: "prompt-custom",
        name: "自定义条目理解提示词",
        type: "item_understanding",
        prompt: "正文：{{inputText}}",
        systemPrompt: customPrompt,
        isEnabled: true,
        isDefault: true,
      },
    });

    await ensureRuntimeConfigSeeded();

    const untouched = await prisma.promptConfig.findUniqueOrThrow({
      where: { id: "prompt-custom" },
    });
    expect(untouched.systemPrompt).toBe(customPrompt);
  });

  it("upgrades the untouched legacy cluster merge prompt idempotently", async () => {
    await prisma.promptConfig.create({
      data: {
        id: "prompt-legacy-cluster-merge",
        name: "默认聚合合并提示词",
        type: "cluster_merge",
        prompt: "候选聚合 Pair JSON：{{clustersJson}}",
        systemPrompt: LEGACY_DEFAULT_CLUSTER_MERGE_PROMPT,
        isEnabled: true,
        isDefault: true,
      },
    });

    await ensureRuntimeConfigSeeded();

    const upgraded = await prisma.promptConfig.findUniqueOrThrow({
      where: { id: "prompt-legacy-cluster-merge" },
    });
    expect(upgraded.systemPrompt).toBe(DEFAULT_CLUSTER_MERGE_PROMPT);

    await ensureRuntimeConfigSeeded();
    const afterSecondRun = await prisma.promptConfig.findUniqueOrThrow({
      where: { id: "prompt-legacy-cluster-merge" },
    });
    expect(afterSecondRun.systemPrompt).toBe(DEFAULT_CLUSTER_MERGE_PROMPT);
  });

  it("removes historical compatibility wording from the upgraded cluster merge prompt", async () => {
    await prisma.promptConfig.create({
      data: {
        id: "prompt-previous-cluster-merge",
        name: "默认聚合合并提示词",
        type: "cluster_merge",
        prompt: "候选聚合 Pair JSON：{{clustersJson}}",
        systemPrompt: PREVIOUS_DEFAULT_CLUSTER_MERGE_PROMPT,
        isEnabled: true,
        isDefault: true,
      },
    });

    await ensureRuntimeConfigSeeded();

    const upgraded = await prisma.promptConfig.findUniqueOrThrow({
      where: { id: "prompt-previous-cluster-merge" },
    });
    expect(upgraded.systemPrompt).toBe(DEFAULT_CLUSTER_MERGE_PROMPT);
    expect(upgraded.systemPrompt).not.toContain("approvedPairs");
    expect(upgraded.systemPrompt).not.toContain("mergeGroups");
  });

  it("rejects newly saved legacy cluster merge output protocols", async () => {
    await expect(createPromptConfig({
      name: "旧版聚合合并提示词",
      type: "cluster_merge",
      systemPrompt: '只输出 JSON：{"approvedPairs": []}',
      prompt: "候选聚合 Pair JSON：{{clustersJson}}",
      temperature: 0,
      maxTokens: 2000,
      topP: null,
      modelApiConfigId: null,
      isEnabled: true,
      isDefault: false,
    })).rejects.toThrow("必须使用 decisions/verdict 协议");
  });

  it("rejects mixed cluster merge output protocols", async () => {
    await expect(createPromptConfig({
      name: "混合聚合合并提示词",
      type: "cluster_merge",
      systemPrompt: '输出 decisions/verdict；不要输出 approvedPairs。示例：{"approvedPairs": []}',
      prompt: "候选聚合 Pair JSON：{{clustersJson}}",
      temperature: 0,
      maxTokens: 2000,
      topP: null,
      modelApiConfigId: null,
      isEnabled: true,
      isDefault: false,
    })).rejects.toThrow("必须使用 decisions/verdict 协议");
  });

  it("saves content extraction connection and limits", async () => {
    const config = await updateContentExtractionConfig({
      jinaEnabled: true,
      jinaBaseUrl: "https://reader.example.com/",
      jinaApiKey: "jina_secret",
      jinaApiKeyMode: "replace",
      timeoutMs: 20_000,
      concurrency: 2,
      rpmLimit: 60,
      maxPerRun: 30,
      minChars: 300,
      maxChars: 20_000,
    });

    expect(config).toMatchObject({
      jinaEnabled: true,
      jinaBaseUrl: "https://reader.example.com/",
      hasJinaApiKey: true,
      timeoutMs: 20_000,
      concurrency: 2,
      rpmLimit: 60,
      maxPerRun: 30,
      minChars: 300,
      maxChars: 20_000,
    });

    const stored = await prisma.contentExtractionConfig.findFirstOrThrow();
    expect(stored.jinaApiKey).toBe("jina_secret");
  });

  it("cleans removed daily report refinement prompt configs before reading settings", async () => {
    await getIngestionRuntimeConfig();

    await prisma.$executeRawUnsafe(
      `
      INSERT INTO "prompt_configs" (
        "id", "name", "type", "prompt", "systemPrompt", "isEnabled", "isDefault", "updatedAt"
      ) VALUES
        ('removed-refine-chat', '旧日报微调对话提示词', 'daily_report_refinement_chat', '模板', '系统提示词', true, false, CURRENT_TIMESTAMP),
        ('removed-refine-generate', '旧日报微调生成提示词', 'daily_report_refinement_generate', '模板', '系统提示词', true, false, CURRENT_TIMESTAMP)
      `,
    );

    const settings = await getAdminSettings();
    const staleRows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `
      SELECT COUNT(*) AS count
      FROM "prompt_configs"
      WHERE "type" IN ('daily_report_refinement_chat', 'daily_report_refinement_generate')
      `,
    );

    expect(settings.promptConfigs.map((config) => config.type)).not.toContain("daily_report_refinement_chat");
    expect(Number(staleRows[0]?.count ?? 0)).toBe(0);
  });

  it("does not overwrite a customized cluster summary prompt", async () => {
    await getIngestionRuntimeConfig();
    await prisma.promptConfig.updateMany({
      where: {
        type: "cluster_summary",
        isDefault: true,
      },
      data: {
        systemPrompt: "自定义聚合摘要提示词",
        maxTokens: 300,
      },
    });

    await ensureRuntimeConfigSeeded();

    const runtimeConfig = await getIngestionRuntimeConfig();
    const clusterSummaryConfig = runtimeConfig.selectedPromptConfigs?.clusterSummary;

    expect(clusterSummaryConfig?.systemPrompt).toBe("自定义聚合摘要提示词");
    expect(clusterSummaryConfig?.maxTokens).toBe(300);
  });

  it("does not overwrite a customized cluster merge prompt", async () => {
    await getIngestionRuntimeConfig();
    await prisma.promptConfig.updateMany({
      where: {
        type: "cluster_merge",
        isDefault: true,
      },
      data: {
        systemPrompt: "自定义聚合合并提示词",
        prompt: "候选：{{clustersJson}}",
      },
    });

    await ensureRuntimeConfigSeeded();

    const runtimeConfig = await getIngestionRuntimeConfig();
    const clusterMergeConfig = runtimeConfig.selectedPromptConfigs?.clusterMerge;

    expect(clusterMergeConfig?.systemPrompt).toBe("自定义聚合合并提示词");
    expect(clusterMergeConfig?.promptTemplate).toBe("候选：{{clustersJson}}");
  });

  it("compiles the default daily report template for runtime settings", async () => {
    await getIngestionRuntimeConfig();

    const runtimeConfig = await getIngestionRuntimeConfig();
    const dailyReportConfig = runtimeConfig.selectedPromptConfigs?.dailyReport;

    expect(dailyReportConfig?.systemPrompt).toBe(compileDailyReportTemplatePrompt(DEFAULT_DAILY_REPORT_TEMPLATE));
    expect(dailyReportConfig?.systemPrompt).toContain("items 为空数组时会在渲染时自动隐藏");
    expect(dailyReportConfig?.systemPrompt).toContain("说明变化内容、适用对象、实践价值或可能影响");
    expect(dailyReportConfig?.systemPrompt).toContain("多个来源只能用于同一事件的互证");
    expect(dailyReportConfig?.systemPrompt).toContain("同一事件只出现一次，避免跨栏目重复");
  });

  it("compiles and stores daily report templateJson when saving prompt configs", async () => {
    const template = parseDailyReportTemplateJson(DEFAULT_DAILY_REPORT_TEMPLATE_JSON)!;
    const opening = template.blocks.find((block) => block.type === "text");
    if (opening?.type === "text") opening.title = "开场";
    const firstSection = template.blocks.find((block) => block.type === "section");
    if (firstSection?.type === "section") firstSection.title = "核心动态";
    const templateJson = stringifyDailyReportTemplate(template);

    const config = await createPromptConfig({
      name: "结构化日报提示词",
      type: "daily_report",
      systemPrompt: "旧系统提示词不应生效",
      templateJson,
      prompt: "日期：{{date}}\n候选内容 JSON：{{articlesJson}}",
      temperature: 0,
      maxTokens: 8000,
      topP: null,
      modelApiConfigId: null,
      isEnabled: true,
      isDefault: true,
    });

    expect(config.templateJson).toBe(templateJson);
    expect(config.systemPrompt).toContain('"title":"开场"');
    expect(config.systemPrompt).toContain('"核心动态"');

    const runtimeConfig = await getIngestionRuntimeConfig();
    expect(runtimeConfig.selectedPromptConfigs?.dailyReport.systemPrompt).toContain('"title":"开场"');
    expect(runtimeConfig.prompts.dailyReport).toContain('"核心动态"');
    expect(runtimeConfig.prompts.dailyReport).not.toContain("旧系统提示词不应生效");
  });

  it("uses enabled default configs to build the runtime mapping", async () => {
    const modelConfig = await createModelApiConfig({
      name: "默认模型配置",
      baseUrl: "https://example.com/v1",
      apiKey: "sk-live",
      modelName: "gpt-live",
      ingestionItemConcurrency: 6,
      isEnabled: true,
      isDefault: true,
    });

    await createPromptConfig({
      name: "默认条目理解提示词",
      type: "item_understanding",
      systemPrompt: "条目理解系统提示词",
      prompt: "标题：{{title}}\n来源：{{sourceName}}\n正文：{{inputText}}",
      temperature: 0,
      maxTokens: 8000,
      topP: null,
      modelApiConfigId: modelConfig.id,
      isEnabled: true,
      isDefault: true,
    });
    await createPromptConfig({
      name: "默认聚合摘要提示词",
      type: "cluster_summary",
      systemPrompt: "聚合系统提示词",
      prompt: "主题：{{title}}\n候选内容：{{inputText}}",
      temperature: 0.2,
      maxTokens: 300,
      topP: null,
      modelApiConfigId: null,
      isEnabled: true,
      isDefault: true,
    });
    await createPromptConfig({
      name: "默认归组判定提示词",
      type: "cluster_match",
      systemPrompt: "归组系统提示词",
      prompt: "当前内容标题：{{title}}\n候选聚合组：{{candidatesJson}}",
      temperature: 0,
      maxTokens: 80,
      topP: null,
      modelApiConfigId: null,
      isEnabled: true,
      isDefault: true,
    });

    const runtimeConfig = await getIngestionRuntimeConfig();

    expect(runtimeConfig.ingestion.itemConcurrency).toBe(6);
    expect(runtimeConfig.ingestion.sourceConcurrency).toBe(2);
    expect(runtimeConfig.ingestion.fullTextFetchThreshold).toBe(80);
    expect(runtimeConfig.ingestion.aggregationSplitMaxEvents).toBe(20);
    expect(runtimeConfig.modelApi.model).toBe("gpt-live");
    expect(runtimeConfig.selectedPromptConfigs?.itemUnderstanding.systemPrompt).toBe("条目理解系统提示词");
    expect(runtimeConfig.selectedPromptConfigs?.itemUnderstanding.modelApi?.model).toBe("gpt-live");
    expect(runtimeConfig.selectedPromptConfigs?.itemUnderstanding.maxTokens).toBe(8000);
    expect(runtimeConfig.selectedPromptConfigs?.clusterSummary.maxTokens).toBe(300);
    expect(runtimeConfig.selectedPromptConfigs?.clusterMatch.maxTokens).toBe(80);
  });

  it("prevents deleting the default model config", async () => {
    const modelConfig = await createModelApiConfig({
      name: "默认模型配置",
      baseUrl: "https://example.com/v1",
      apiKey: "sk-live",
      modelName: "gpt-live",
      ingestionItemConcurrency: 6,
      isEnabled: true,
      isDefault: true,
    });

    await expect(deleteModelApiConfig(modelConfig.id)).rejects.toThrow("默认模型配置不能删除。");
  });

  it("prevents deleting the default prompt config", async () => {
    const modelConfig = await createModelApiConfig({
      name: "默认模型配置",
      baseUrl: "https://example.com/v1",
      apiKey: "sk-live",
      modelName: "gpt-live",
      ingestionItemConcurrency: 6,
      isEnabled: true,
      isDefault: true,
    });

    const promptConfig = await createPromptConfig({
      name: "默认内容分析提示词",
      type: "item_understanding",
      systemPrompt: "分析系统提示词",
      prompt: "标题：{{title}}\n正文：{{inputText}}",
      temperature: 0.2,
      maxTokens: 1000,
      topP: null,
      modelApiConfigId: modelConfig.id,
      isEnabled: true,
      isDefault: true,
    });

    await expect(deletePromptConfig(promptConfig.id)).rejects.toThrow("默认提示词配置不能删除。");
  });

  it("blocks deleting a group that still owns sources", async () => {
    const group = await prisma.sourceGroup.create({
      data: {
        name: "Core Sources",
      },
    });

    await prisma.source.create({
      data: {
        name: "Grouped Feed",
        rssUrl: "https://grouped.example.com/feed.xml",
        siteUrl: "https://grouped.example.com",
        enabled: true,
        aiParsingEnabled: true,
        groupId: group.id,
      },
    });

    await expect(deleteSourceGroup(group.id)).rejects.toThrow(
      "Please move sources out of this group before deleting it.",
    );
  });

  it("includes each source latest item ingestion time in admin settings", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Tracked Feed",
        rssUrl: "https://tracked.example.com/feed.xml",
        siteUrl: "https://tracked.example.com",
        enabled: true,
        aiParsingEnabled: true,
      },
    });

    await prisma.item.createMany({
      data: [
        {
          sourceId: source.id,
          originalUrl: "https://tracked.example.com/old",
          canonicalUrl: "https://tracked.example.com/old",
          urlHash: "tracked-old",
          originalTitle: "Old item",
          publishedAt: new Date("2026-04-19T08:00:00.000Z"),
          createdAt: new Date("2026-04-19T08:01:00.000Z"),
        },
        {
          sourceId: source.id,
          originalUrl: "https://tracked.example.com/new",
          canonicalUrl: "https://tracked.example.com/new",
          urlHash: "tracked-new",
          originalTitle: "New item",
          publishedAt: new Date("2026-04-20T08:00:00.000Z"),
          createdAt: new Date("2026-04-20T08:01:00.000Z"),
        },
      ],
    });

    const settings = await getAdminSettings();

    expect(settings.sources.find((entry) => entry.id === source.id)?.lastItemCreatedAt).toBe(
      "2026-04-20T08:01:00.000Z",
    );
  });

  it("imports OPML sources into matching groups", async () => {
    const importSourcesFromOpml = (
      settingsService as typeof settingsService & {
        importSourcesFromOpml?: (opmlText: string, options?: unknown) => Promise<unknown>;
      }
    ).importSourcesFromOpml;

    expect(importSourcesFromOpml).toBeTypeOf("function");

    await importSourcesFromOpml!(
      `<?xml version="1.0" encoding="UTF-8"?>
      <opml version="2.0" xmlns:infinitum="https://infinitum.app/opml">
        <body>
          <outline text="AI">
            <outline
              text="Import Feed One"
              title="Import Feed One"
              type="rss"
              xmlUrl="https://feeds.example.com/one.xml"
              htmlUrl="https://feeds.example.com/one"
            />
          </outline>
          <outline text="Infra">
            <outline
              text="Import Feed Two"
              title="Import Feed Two"
              type="rss"
              xmlUrl="https://feeds.example.com/two.xml"
              htmlUrl="https://feeds.example.com/two"
              infinitum:enabled="false"
              infinitum:aiParsingEnabled="false"
            />
          </outline>
        </body>
      </opml>`,
      {
        resolveMetadata: async () => ({
          name: "Resolved Feed",
          rssUrl: "https://feeds.example.com/fallback.xml",
          siteUrl: "https://feeds.example.com",
        }),
      },
    );

    const groups = await prisma.sourceGroup.findMany({
      orderBy: { name: "asc" },
    });
    const sources = await prisma.source.findMany({
      include: { group: true },
      orderBy: { rssUrl: "asc" },
    });

    expect(groups.map((group) => group.name)).toEqual(["AI", "Infra"]);
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({
      rssUrl: "https://feeds.example.com/one.xml",
      name: "Import Feed One",
      siteUrl: "https://feeds.example.com/one",
      group: {
        name: "AI",
      },
    });
    expect(sources[1]).toMatchObject({
      rssUrl: "https://feeds.example.com/two.xml",
      name: "Import Feed Two",
      siteUrl: "https://feeds.example.com/two",
      enabled: false,
      aiParsingEnabled: false,
      group: {
        name: "Infra",
      },
    });
  });

  it("does not reseed default sources after admins delete all sources", async () => {
    const initialSettings = await getAdminSettings();

    expect(initialSettings.sources.length).toBeGreaterThan(0);

    for (const source of initialSettings.sources) {
      await deleteSource(source.id);
    }

    const sourcesAfterDeletion = await prisma.source.findMany();
    expect(sourcesAfterDeletion).toHaveLength(0);

    const settingsAfterDeletion = await getAdminSettings();

    expect(settingsAfterDeletion.sources).toHaveLength(0);
  });

  it("keeps a user-customized daily_report systemPrompt untouched", async () => {
    await getIngestionRuntimeConfig();
    const customPrompt = "用户自定 daily_report systemPrompt - 保留我的修改";
    await prisma.promptConfig.updateMany({
      where: { type: "daily_report", isDefault: true },
      data: {
        systemPrompt: customPrompt,
        maxTokens: 2048,
      },
    });

    await ensureRuntimeConfigSeeded();

    const config = await prisma.promptConfig.findFirst({
      where: { type: "daily_report", isDefault: true },
    });
    expect(config?.systemPrompt).toBe(customPrompt);
    expect(config?.maxTokens).toBe(2048);
  });

  it("upgrades only the legacy default item_understanding prompt", async () => {
    await getIngestionRuntimeConfig();
    await prisma.promptConfig.updateMany({
      where: { type: "item_understanding", isDefault: true },
      data: { systemPrompt: LEGACY_DEFAULT_ITEM_UNDERSTANDING_PROMPT },
    });
    const custom = await prisma.promptConfig.create({
      data: {
        name: "自定义条目理解",
        type: "item_understanding",
        prompt: "正文：{{inputText}}",
        systemPrompt: "用户自定义条目理解提示词",
        maxTokens: 3000,
        isEnabled: true,
        isDefault: false,
      },
    });

    await ensureRuntimeConfigSeeded();

    const defaultConfig = await prisma.promptConfig.findFirstOrThrow({
      where: { type: "item_understanding", isDefault: true },
    });
    const customConfig = await prisma.promptConfig.findUniqueOrThrow({ where: { id: custom.id } });
    expect(defaultConfig.systemPrompt).toBe(DEFAULT_ITEM_UNDERSTANDING_PROMPT);
    expect(defaultConfig.systemPrompt).toContain("双引号必须转义");
    expect(customConfig.systemPrompt).toBe("用户自定义条目理解提示词");
  });

  it("upgrades a persisted default item_understanding prompt that still emits tags", async () => {
    await getIngestionRuntimeConfig();
    await prisma.promptConfig.updateMany({
      where: { type: "item_understanding", isDefault: true },
      data: {
        systemPrompt: `${DEFAULT_ITEM_UNDERSTANDING_PROMPT}\n输出字段："tags":[]\ntags 返回 0-5 个具体、稳定、可复用的筛选标签。`,
      },
    });

    await ensureRuntimeConfigSeeded();

    const config = await prisma.promptConfig.findFirstOrThrow({
      where: { type: "item_understanding", isDefault: true },
    });
    expect(config.systemPrompt).toBe(DEFAULT_ITEM_UNDERSTANDING_PROMPT);
    expect(config.systemPrompt).not.toContain('"tags":');
  });

  it("upgrades only the legacy default cluster_summary token budget", async () => {
    await getIngestionRuntimeConfig();
    await prisma.promptConfig.updateMany({
      where: { type: "cluster_summary", isDefault: true },
      data: { maxTokens: 450 },
    });
    const custom = await prisma.promptConfig.create({
      data: {
        name: "自定义聚合摘要",
        type: "cluster_summary",
        prompt: "候选：{{inputText}}",
        systemPrompt: "自定义提示词",
        maxTokens: 900,
        isEnabled: true,
        isDefault: false,
      },
    });

    await ensureRuntimeConfigSeeded();

    const defaultConfig = await prisma.promptConfig.findFirstOrThrow({
      where: { type: "cluster_summary", isDefault: true },
    });
    const customConfig = await prisma.promptConfig.findUniqueOrThrow({ where: { id: custom.id } });
    expect(defaultConfig.maxTokens).toBe(2000);
    expect(customConfig.maxTokens).toBe(900);
  });

  it("upgrades legacy default daily_report prompt to the template-based format", async () => {
    await getIngestionRuntimeConfig();
    const legacyPrompt = `你是中文 AI 新闻日报编辑。只基于输入候选内容生成一份 Briefing 型 AI 日报。

固定输出格式：
{"openingSummary":"...","sections":{"今日大事":[{"topic":"...","summary":"...","whyImportant":"...","sourceIds":[1,2]}]},"closingThought":"..."}`;
    await prisma.promptConfig.updateMany({
      where: { type: "daily_report", isDefault: true },
      data: {
        systemPrompt: legacyPrompt,
        templateJson: null,
        maxTokens: 40960,
      },
    });

    await ensureRuntimeConfigSeeded();

    const config = await prisma.promptConfig.findFirst({
      where: { type: "daily_report", isDefault: true },
    });
    expect(config?.templateJson).toBe(DEFAULT_DAILY_REPORT_TEMPLATE_JSON);
    expect(config?.systemPrompt).toBe(DEFAULT_DAILY_REPORT_PROMPT);
    expect(config?.maxTokens).toBe(40960);
  });

  it("upgrades legacy default daily_report templateJson when it does not contain blocks", async () => {
    await getIngestionRuntimeConfig();
    const legacyTemplateJson = JSON.stringify({
      opening: {
        label: "摘要",
        instruction: "约 100-180 字。概括当天 AI 领域最关键的事项和主线变化，优先覆盖重大发布、模型/产品进展、产业合作、安全风险、开源工具或关键数据。格式固定为“{{date}} AI 领域呈现...，值得关注的信息：...”，例如：“2026-04-29 AI 领域呈现多线并进格局，值得关注的信息：...”。可使用有限 Markdown 行内标记突出关键信息：用 **加粗** 标注事件主体、关键变化、数字或结论，用 *斜体* 标注必要背景或不确定性；不要使用链接、图片、标题、表格或列表。",
      },
      sections: [
        { title: "今日大事", description: "输出 3-5 条。优先综合参考 candidateScore、sourceCount、itemCount 和日期相关性；在新闻价值接近时优先选择更热、多源确认、eventDate 明确等于日报日期，或能从 publishedAt/正文判断发生于日报日期的事项。不要机械按日期或热度排序。" },
        { title: "热点事件", description: "输出 3-5 条。优先综合参考 candidateScore、sourceCount、itemCount 和日期相关性；在新闻价值接近时优先选择更热、多源确认、eventDate 明确等于日报日期，或能从 publishedAt/正文判断发生于日报日期的事项。不要机械按日期或热度排序。" },
        { title: "变更与实践", description: "输出 2-5 条。聚焦产品、模型、工程实践和生态变化。每条只覆盖一个独立事件或实践变化；不要为了压缩篇幅把无关更新并列到同一条。" },
        { title: "安全与风险", description: "可为空；有相关内容时输出 1-5 条。聚焦安全事件、漏洞、滥用风险、合规风险或模型行为风险；不要输出 severity、riskLevel、风险级别等风险等级字段。" },
        { title: "开源与工具", description: "可为空；有相关内容时输出 1-5 条。聚焦值得开发者关注的开源项目、工具链、框架或工程资产。" },
        { title: "数据与洞察", description: "可为空；有相关内容时输出 1-5 条。聚焦关键数据、趋势、研究结论或生态变化信号。" },
      ],
      closing: {
        label: "今日观察",
        instruction: "约 80-140 字。总结当天值得持续关注的主线，说明这些变化可能如何影响普通用户、开发者、内容创作者、企业采购或日常工作流；可基于当天信息给出谨慎判断，但不要引入输入之外的新事实。可使用有限 Markdown 行内标记突出关键信息。",
      },
      globalRules: ["旧版规则"],
    });

    await prisma.promptConfig.updateMany({
      where: { type: "daily_report", isDefault: true },
      data: {
        systemPrompt: getLegacyDefaultDailyReportSystemPrompt(),
        templateJson: legacyTemplateJson,
        maxTokens: 40960,
      },
    });

    await ensureRuntimeConfigSeeded();

    const config = await prisma.promptConfig.findFirst({
      where: { type: "daily_report", isDefault: true },
    });
    expect(config?.templateJson).toBe(DEFAULT_DAILY_REPORT_TEMPLATE_JSON);
    expect(config?.systemPrompt).toBe(DEFAULT_DAILY_REPORT_PROMPT);
    expect(config?.maxTokens).toBe(40960);
  });

  it("keeps custom legacy daily report templates visible without breaking runtime config loading", async () => {
    await getIngestionRuntimeConfig();
    const customSystemPrompt = "自定义旧日报提示词";
    const customTemplateJson = JSON.stringify({
      opening: { label: "自定义开场", instruction: "只写自定义摘要。" },
      sections: [{ title: "核心动态", description: "只写自定义栏目。" }],
      closing: { label: "自定义收尾", instruction: "只写自定义收尾。" },
    });
    await prisma.promptConfig.updateMany({
      where: { type: "daily_report", isDefault: true },
      data: { systemPrompt: customSystemPrompt, templateJson: customTemplateJson },
    });

    const runtimeConfig = await getIngestionRuntimeConfig();
    expect(runtimeConfig.selectedPromptConfigs?.dailyReport.systemPrompt).toBe(customSystemPrompt);
    await expect(prisma.promptConfig.findFirstOrThrow({ where: { type: "daily_report", isDefault: true } }))
      .resolves.toMatchObject({ templateJson: customTemplateJson });
  });

  it("does not rewrite an unchanged custom legacy migration audit", async () => {
    await getIngestionRuntimeConfig();
    await prisma.promptConfig.updateMany({
      where: { type: "daily_report", isDefault: true },
      data: {
        systemPrompt: "自定义旧日报提示词",
        templateJson: JSON.stringify({
          opening: { label: "自定义开场", instruction: "只写自定义摘要。" },
          sections: [{ title: "核心动态", description: "只写自定义栏目。" }],
          closing: { label: "自定义收尾", instruction: "只写自定义收尾。" },
        }),
      },
    });

    await ensureRuntimeConfigSeeded();
    const first = await prisma.promptConfig.findFirstOrThrow({
      where: { type: "daily_report", isDefault: true },
      select: { templateMigrationAuditJson: true },
    });

    await ensureRuntimeConfigSeeded();
    const second = await prisma.promptConfig.findFirstOrThrow({
      where: { type: "daily_report", isDefault: true },
      select: { templateMigrationAuditJson: true },
    });

    expect(second.templateMigrationAuditJson).toBe(first.templateMigrationAuditJson);
  });

  it("preserves null daily_report systemPrompts when reseeding", async () => {
    await getIngestionRuntimeConfig();
    await prisma.promptConfig.updateMany({
      where: { type: "daily_report", isDefault: true },
      data: { systemPrompt: null },
    });

    await ensureRuntimeConfigSeeded();

    const config = await prisma.promptConfig.findFirst({
      where: { type: "daily_report", isDefault: true },
    });
    expect(config?.systemPrompt).toBeNull();
  });
});
