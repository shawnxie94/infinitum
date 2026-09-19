import { PromptConfigType } from "@prisma/client";
import { DEFAULT_DAILY_REPORT_REVIEW_PROMPT } from "@/config/prompts";

import type { RuntimeConfig } from "@/config/runtime";
import { prisma } from "@/lib/db";
import {
  ensureContentExtractionConfig,
  serializeAdminContentExtractionConfig,
  serializeRuntimeContentExtractionConfig,
} from "@/lib/settings/content-extraction-service";
import {
  ensureBriefingPreferenceConfig,
  ensureEventBriefingConfig,
  serializeAdminBriefingPreferenceConfig,
  serializeAdminEventBriefingConfig,
} from "@/lib/settings/event-briefing-service";
import { listAdminHeaderLinks } from "@/lib/settings/header-link-service";
import {
  ensureRuntimeConfigSeeded,
  pickPromptConfigByType,
  resolvePromptSystemPrompt,
  serializeAdminModelApiConfig,
  serializeAdminPromptConfig,
  serializeRuntimeModelApi,
  serializeSelectedPromptConfig,
  toSourceConfig,
} from "@/lib/settings/core";
import type { AdminSettingsSnapshot, ModelApiConfigRow } from "@/lib/settings/types";
import { ensureDefaultDailyReportSchedule, ensureDefaultIngestionSchedule, ensureDefaultItemCleanupSchedule, toTaskScheduleSnapshot } from "@/lib/tasks/service";

// 向量模型从模型 API 配置解析：启用中的向量模型行即全局生效（默认标记优先，其次最新创建）
function serializeRuntimeEmbeddingFromModelConfig(
  config: ModelApiConfigRow | null,
): RuntimeConfig["embedding"] {
  if (!config) {
    return {
      enabled: false,
      baseUrl: "",
      apiKey: null,
      modelName: "",
      dimensions: null,
      batchSize: 32,
      timeoutMs: 15_000,
    };
  }

  return {
    enabled: true,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey || null,
    modelName: config.modelName,
    dimensions: config.dimensions,
    batchSize: config.batchSize ?? 32,
    timeoutMs: config.timeoutMs ?? 15_000,
  };
}

export async function getIngestionRuntimeConfig(): Promise<RuntimeConfig> {
  // Runtime reads are the reliable startup path for the standalone Docker
  // server and worker. Keep the migration itself idempotent and restricted to
  // untouched official defaults, but do not skip it here or persisted default
  // templates will remain stale when the instrumentation hook is unavailable.
  await ensureRuntimeConfigSeeded({ migrateDailyReportTemplates: true });

  const [sources, blacklist, defaultModelConfig, embeddingModelConfig, promptConfigs, taskSchedule, contentExtractionConfig] = await Promise.all([
    prisma.source.findMany({
      where: { enabled: true },
      orderBy: { name: "asc" },
    }),
    prisma.blacklistKeyword.findMany({
      orderBy: { keyword: "asc" },
    }),
    prisma.modelApiConfig.findFirst({
      where: {
        type: "chat",
        isEnabled: true,
        isDefault: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.modelApiConfig.findFirst({
      where: {
        type: "embedding",
        isEnabled: true,
      },
      orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
    }),
    prisma.promptConfig.findMany({
      where: {
        isDefault: true,
      },
      include: {
        modelApiConfig: true,
      },
      orderBy: [{ createdAt: "asc" }],
    }),
    ensureDefaultIngestionSchedule(),
    ensureContentExtractionConfig(),
  ]);

  if (!defaultModelConfig) {
    throw new Error("缺少启用中的默认模型配置。");
  }

  const enabledPromptConfigs = promptConfigs.filter((config) => config.isEnabled);
  const itemUnderstandingConfig = pickPromptConfigByType(enabledPromptConfigs, PromptConfigType.item_understanding);
  const clusterSummaryConfig = pickPromptConfigByType(enabledPromptConfigs, PromptConfigType.cluster_summary);
  const clusterMatchConfig = pickPromptConfigByType(enabledPromptConfigs, PromptConfigType.cluster_match);
  const clusterMergeConfig = pickPromptConfigByType(enabledPromptConfigs, PromptConfigType.cluster_merge);
  const dailyReportConfig = pickPromptConfigByType(enabledPromptConfigs, PromptConfigType.daily_report);
  const dailyReportReviewConfig = promptConfigs.find(
    (config) => config.type === PromptConfigType.daily_report_review,
  ) ?? null;

  return {
    rssSources: sources.map((source) => toSourceConfig(source)),
    blacklistKeywords: blacklist.map((entry) => entry.keyword),
    ingestion: {
      itemConcurrency: defaultModelConfig.ingestionItemConcurrency,
      sourceConcurrency: taskSchedule.sourceConcurrency,
      fullTextFetchThreshold: taskSchedule.fullTextFetchThreshold,
      perSourceItemLimit: taskSchedule.perSourceItemLimit,
      aggregationSplitMaxEvents: taskSchedule.aggregationSplitMaxEvents,
      processingStartAt: taskSchedule.processingStartAt,
    },
    contentExtraction: serializeRuntimeContentExtractionConfig(contentExtractionConfig),
    embedding: serializeRuntimeEmbeddingFromModelConfig(embeddingModelConfig),
    modelApi: serializeRuntimeModelApi(defaultModelConfig),
    prompts: {
      itemUnderstanding: resolvePromptSystemPrompt(itemUnderstandingConfig),
      clusterSummary: resolvePromptSystemPrompt(clusterSummaryConfig),
      clusterMatch: resolvePromptSystemPrompt(clusterMatchConfig),
      clusterMerge: resolvePromptSystemPrompt(clusterMergeConfig),
      dailyReport: resolvePromptSystemPrompt(dailyReportConfig),
    dailyReportReview: dailyReportReviewConfig
        ? DEFAULT_DAILY_REPORT_REVIEW_PROMPT
        : "",
    },
    selectedPromptConfigs: {
      itemUnderstanding: serializeSelectedPromptConfig(itemUnderstandingConfig),
      clusterSummary: serializeSelectedPromptConfig(clusterSummaryConfig),
      clusterMatch: serializeSelectedPromptConfig(clusterMatchConfig),
      clusterMerge: serializeSelectedPromptConfig(clusterMergeConfig),
      dailyReport: serializeSelectedPromptConfig(dailyReportConfig),
      dailyReportReview: dailyReportReviewConfig
        ? {
            ...serializeSelectedPromptConfig(dailyReportReviewConfig),
            systemPrompt: DEFAULT_DAILY_REPORT_REVIEW_PROMPT,
          }
        : null,
    },
  };
}

export async function getAdminSettings(): Promise<AdminSettingsSnapshot> {
  await ensureRuntimeConfigSeeded({ migrateDailyReportTemplates: true });

  const [
    modelApiConfigs,
    promptConfigs,
    blacklist,
    groups,
    sources,
    taskSchedule,
    dailyReportSchedule,
    cleanupSchedule,
    contentExtractionConfig,
    eventBriefingConfig,
    briefingPreferenceConfig,
    headerLinks,
  ] = await Promise.all([
    prisma.modelApiConfig.findMany({
      orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
    }),
    prisma.promptConfig.findMany({
      include: {
        modelApiConfig: {
          select: {
            name: true,
          },
        },
      },
      orderBy: [{ type: "asc" }, { isDefault: "desc" }, { createdAt: "desc" }],
    }),
    prisma.blacklistKeyword.findMany({
      orderBy: { keyword: "asc" },
    }),
    prisma.sourceGroup.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    prisma.source.findMany({
      include: { group: true },
      orderBy: [{ name: "asc" }],
    }),
    ensureDefaultIngestionSchedule(),
    ensureDefaultDailyReportSchedule(),
    ensureDefaultItemCleanupSchedule(),
    ensureContentExtractionConfig(),
    ensureEventBriefingConfig(),
    ensureBriefingPreferenceConfig(),
    listAdminHeaderLinks(),
  ]);

  const defaultModelConfig = modelApiConfigs.find((config) => config.isDefault && config.type === "chat");
  const latestItemsBySource = sources.length > 0
    ? await prisma.item.groupBy({
      by: ["sourceId"],
      where: { sourceId: { in: sources.map((source) => source.id) } },
      _max: { createdAt: true },
    })
    : [];
  const latestItemCreatedAtBySourceId = new Map(
    latestItemsBySource.map((entry) => [entry.sourceId, entry._max.createdAt]),
  );

  return {
    modelApiConfigs: modelApiConfigs.map(serializeAdminModelApiConfig),
    promptConfigs: promptConfigs
      .filter((config) => config.type !== "entity_alias_check")
      .map((config) => serializeAdminPromptConfig(config, defaultModelConfig)),
    headerLinks,
    eventBriefing: {
      config: serializeAdminEventBriefingConfig(eventBriefingConfig),
      preference: serializeAdminBriefingPreferenceConfig(briefingPreferenceConfig),
    },
    contentExtraction: serializeAdminContentExtractionConfig(contentExtractionConfig),
    blacklistKeywords: blacklist.map((entry) => entry.keyword),
    taskSchedule: toTaskScheduleSnapshot(taskSchedule) as AdminSettingsSnapshot["taskSchedule"],
    dailyReportSchedule: toTaskScheduleSnapshot(dailyReportSchedule) as AdminSettingsSnapshot["dailyReportSchedule"],
    itemCleanupSchedule: toTaskScheduleSnapshot(cleanupSchedule) as AdminSettingsSnapshot["itemCleanupSchedule"],
    groups: groups.map((group) => ({
      id: group.id,
      name: group.name,
      color: group.color,
      sortOrder: group.sortOrder,
    })),
    sources: sources.map((source) => ({
      id: source.id,
      name: source.name,
      rssUrl: source.rssUrl,
      siteUrl: source.siteUrl,
      enabled: source.enabled,
      aiParsingEnabled: source.aiParsingEnabled,
      aggregationEnabled: source.aggregationEnabled,
      aggregationDetectionEnabled: source.aggregationDetectionEnabled,
      groupId: source.groupId,
      groupName: source.group?.name ?? null,
      lastItemCreatedAt: latestItemCreatedAtBySourceId.get(source.id)?.toISOString() ?? null,
    })),
  };
}
