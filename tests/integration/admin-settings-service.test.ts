import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_DAILY_REPORT_PROMPT,
  DEFAULT_ITEM_UNDERSTANDING_PROMPT,
  LEGACY_DEFAULT_ITEM_UNDERSTANDING_PROMPT,
} from "@/config/prompts";
import { prisma } from "@/lib/db";
import {
  DEFAULT_DAILY_REPORT_TEMPLATE_JSON,
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
    expect(settings.promptConfigs.find((config) => config.type === "daily_report")?.systemPrompt).toContain(
      "优先综合参考 candidateScore、sourceCount、itemCount 和日期相关性",
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

  it("keeps the tightened default daily report prompt in seeded settings", async () => {
    await getIngestionRuntimeConfig();

    const runtimeConfig = await getIngestionRuntimeConfig();
    const dailyReportConfig = runtimeConfig.selectedPromptConfigs?.dailyReport;

    expect(dailyReportConfig?.systemPrompt).toBe(DEFAULT_DAILY_REPORT_PROMPT);
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
    expect(config?.systemPrompt).toContain("固定输出格式：");
    expect(config?.systemPrompt).toContain('"blocks"');
    expect(config?.maxTokens).toBe(40960);
  });

  it("upgrades legacy default daily_report templateJson when it does not contain blocks", async () => {
    await getIngestionRuntimeConfig();
    const legacyTemplateJson = JSON.stringify({
      opening: {
        label: "摘要",
        instruction: "旧版摘要要求",
      },
      sections: [
        {
          title: "今日大事",
          description: "旧版栏目要求",
        },
      ],
      closing: {
        label: "今日观察",
        instruction: "旧版收尾要求",
      },
      globalRules: ["旧版规则"],
    });

    await prisma.promptConfig.updateMany({
      where: { type: "daily_report", isDefault: true },
      data: {
        systemPrompt: "旧版日报系统提示词",
        templateJson: legacyTemplateJson,
        maxTokens: 40960,
      },
    });

    await ensureRuntimeConfigSeeded();

    const config = await prisma.promptConfig.findFirst({
      where: { type: "daily_report", isDefault: true },
    });
    expect(config?.templateJson).toBe(DEFAULT_DAILY_REPORT_TEMPLATE_JSON);
    expect(config?.systemPrompt).toContain("固定输出格式：");
    expect(config?.systemPrompt).toContain('"blocks"');
    expect(config?.maxTokens).toBe(40960);
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
