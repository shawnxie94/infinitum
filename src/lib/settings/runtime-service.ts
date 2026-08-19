import { PromptConfigType } from "@prisma/client";

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
import type { AdminSettingsSnapshot } from "@/lib/settings/types";
import { ensureDefaultDailyReportSchedule, ensureDefaultIngestionSchedule, ensureDefaultItemCleanupSchedule, toTaskScheduleSnapshot } from "@/lib/tasks/service";

export async function getIngestionRuntimeConfig(): Promise<RuntimeConfig> {
  // Runtime reads are the reliable startup path for the standalone Docker
  // server and worker. Keep the migration itself idempotent and restricted to
  // untouched official defaults, but do not skip it here or persisted default
  // templates will remain stale when the instrumentation hook is unavailable.
  await ensureRuntimeConfigSeeded({ migrateDailyReportTemplates: true });

  const [sources, blacklist, defaultModelConfig, promptConfigs, taskSchedule, contentExtractionConfig] = await Promise.all([
    prisma.source.findMany({
      where: { enabled: true },
      orderBy: { name: "asc" },
    }),
    prisma.blacklistKeyword.findMany({
      orderBy: { keyword: "asc" },
    }),
    prisma.modelApiConfig.findFirst({
      where: {
        isEnabled: true,
        isDefault: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.promptConfig.findMany({
      where: {
        isEnabled: true,
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

  const itemUnderstandingConfig = pickPromptConfigByType(promptConfigs, PromptConfigType.item_understanding);
  const clusterSummaryConfig = pickPromptConfigByType(promptConfigs, PromptConfigType.cluster_summary);
  const clusterMatchConfig = pickPromptConfigByType(promptConfigs, PromptConfigType.cluster_match);
  const clusterMergeConfig = pickPromptConfigByType(promptConfigs, PromptConfigType.cluster_merge);
  const dailyReportConfig = pickPromptConfigByType(promptConfigs, PromptConfigType.daily_report);

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
    modelApi: serializeRuntimeModelApi(defaultModelConfig),
    prompts: {
      itemUnderstanding: resolvePromptSystemPrompt(itemUnderstandingConfig),
      clusterSummary: resolvePromptSystemPrompt(clusterSummaryConfig),
      clusterMatch: resolvePromptSystemPrompt(clusterMatchConfig),
      clusterMerge: resolvePromptSystemPrompt(clusterMergeConfig),
      dailyReport: resolvePromptSystemPrompt(dailyReportConfig),
    },
    selectedPromptConfigs: {
      itemUnderstanding: serializeSelectedPromptConfig(itemUnderstandingConfig),
      clusterSummary: serializeSelectedPromptConfig(clusterSummaryConfig),
      clusterMatch: serializeSelectedPromptConfig(clusterMatchConfig),
      clusterMerge: serializeSelectedPromptConfig(clusterMergeConfig),
      dailyReport: serializeSelectedPromptConfig(dailyReportConfig),
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

  const defaultModelConfig = modelApiConfigs.find((config) => config.isDefault);
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
    promptConfigs: promptConfigs.map((config) => serializeAdminPromptConfig(config, defaultModelConfig)),
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
