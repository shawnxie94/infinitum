import type { AdminBriefingPreferenceSuggestion, AdminSettingsSnapshot } from "@/lib/settings/types";

type SourceResolvePayload = {
  source?: {
    name: string;
    rssUrl: string;
    siteUrl: string;
    suggestedAiParsingEnabled: boolean;
  };
  error?: string;
};

type SourceImportPayload = {
  summary?: {
    createdCount: number;
    updatedCount: number;
    failedCount: number;
  };
  error?: string;
};

type SchedulePayload = {
  error?: string;
  schedule?: AdminSettingsSnapshot["taskSchedule"];
};

type DailyReportSchedulePayload = {
  error?: string;
  schedule?: AdminSettingsSnapshot["dailyReportSchedule"];
};

type ItemCleanupSchedulePayload = {
  error?: string;
  schedule?: AdminSettingsSnapshot["itemCleanupSchedule"];
};

type ContentExtractionPayload = {
  error?: string;
  config?: AdminSettingsSnapshot["contentExtraction"];
};

type EventBriefingPayload = {
  error?: string;
  eventBriefing?: AdminSettingsSnapshot["eventBriefing"];
};

type BriefingPreferenceSuggestionsPayload = {
  error?: string;
  suggestions?: AdminBriefingPreferenceSuggestion[];
  dismissedCount?: number;
};

type BriefingPreferenceSuggestionAcceptPayload = {
  error?: string;
  suggestion?: AdminBriefingPreferenceSuggestion;
  preference?: AdminSettingsSnapshot["eventBriefing"]["preference"];
};

type BriefingPreferenceSuggestionPayload = {
  error?: string;
  suggestion?: AdminBriefingPreferenceSuggestion;
};

type GroupReorderPayload = {
  error?: string;
  groups?: AdminSettingsSnapshot["groups"];
};

type HeaderLinksPayload = {
  error?: string;
  links?: NonNullable<AdminSettingsSnapshot["headerLinks"]>;
};

type HeaderLinkPayload = {
  error?: string;
  link?: NonNullable<AdminSettingsSnapshot["headerLinks"]>[number];
};

export type AdminEntityAlias = {
  id: string;
  aliasName: string;
  aliasNormalized: string;
  createdBy: string;
  createdAt: string;
};

export type AdminEntity = {
  id: string;
  name: string;
  normalized: string;
  itemCount: number;
  aliasCount: number;
  aliases: AdminEntityAlias[];
  createdAt: string;
  updatedAt: string;
};

export type AdminEntityListPayload = {
  error?: string;
  entities: AdminEntity[];
  totalCount: number;
  page: number;
  pageSize: number;
};

export type AdminEntitySort = "usage_desc" | "updated_desc" | "name_asc" | "alias_desc";

export type AdminEntitySuggestion = {
  id: string;
  sourceEntity: Pick<AdminEntity, "id" | "name" | "normalized" | "itemCount" | "aliasCount">;
  targetEntity: Pick<AdminEntity, "id" | "name" | "normalized" | "itemCount" | "aliasCount">;
  confidence: number;
  reasons: string[];
  affectedItemCount: number;
};

export type AdminEntitySuggestionListPayload = {
  error?: string;
  suggestions: AdminEntitySuggestion[];
  totalCount: number;
  page: number;
  pageSize: number;
};

export type AdminEntitySuggestionSort = "confidence_desc" | "affected_desc";

type EntityAliasPayload = {
  error?: string;
  alias?: AdminEntityAlias;
};

type EntityMergePayload = {
  error?: string;
  mergedCount: number;
  affectedClusterCount: number;
};

type EntitySuggestionDecisionPayload = {
  error?: string;
  ok: boolean;
};

type EntitySuggestionAutoMergePayload = {
  error?: string;
  scannedCount: number;
  mergedCount: number;
  affectedClusterCount: number;
  skippedCount: number;
  failedCount: number;
};

type EntitySuggestionPrecomputePayload = {
  error?: string;
  entityCount: number;
  scannedPairs: number;
  candidateCount: number;
  storedCandidates: number;
  durationMs: number;
};

async function requestAdminSettingsJson<T extends { error?: string }>(
  url: string,
  method: string,
  body?: unknown,
  fallbackMessage = "请求失败",
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = (await response.json()) as T;

  if (!response.ok || payload.error) {
    throw new Error(payload.error ?? fallbackMessage);
  }

  return payload;
}

export function submitAdminSettingsAction(url: string, method: string, body: unknown) {
  return requestAdminSettingsJson<{ error?: string }>(url, method, body, "保存失败");
}

export async function resolveSourceFromRssUrl(rssUrl: string) {
  const payload = await requestAdminSettingsJson<SourceResolvePayload>(
    "/api/admin/settings/sources/resolve",
    "POST",
    { rssUrl },
    "RSS 解析失败",
  );

  if (!payload.source) {
    throw new Error("RSS 解析失败");
  }

  return payload.source;
}

export async function importSourcesFromOpmlText(opmlText: string) {
  const payload = await requestAdminSettingsJson<SourceImportPayload>(
    "/api/admin/settings/sources/import",
    "POST",
    { opmlText },
    "OPML 导入失败",
  );

  if (!payload.summary) {
    throw new Error("OPML 导入失败");
  }

  return payload.summary;
}

export async function saveDefaultIngestionSchedule(input: {
  enabled: boolean;
  cronExpression: string;
  sourceConcurrency: number;
  fullTextFetchThreshold: number;
  perSourceItemLimit: number;
  aggregationSplitMaxEvents: number;
  processingStartAt: string | null;
}) {
  const payload = await requestAdminSettingsJson<SchedulePayload>(
    "/api/admin/monitor/schedule/ingestion-default",
    "PATCH",
    input,
    "任务配置保存失败。",
  );

  if (!payload.schedule) {
    throw new Error("任务配置保存失败。");
  }

  return payload.schedule;
}

export async function saveDefaultDailyReportSchedule(input: {
  enabled: boolean;
  cronExpression: string;
  dailyReportCandidateLimit: number;
  dailyReportPlanningBatchSize: number | null;
  dailyReportOffsetDays: number;
  dailyReportRecentTopicLookbackDays: number;
  dailyReportAutoPublish: boolean;
  dailyReportChannelIds: string[];
}) {
  const payload = await requestAdminSettingsJson<DailyReportSchedulePayload>(
    "/api/admin/monitor/schedule/daily-report-default",
    "PATCH",
    input,
    "日报任务配置保存失败。",
  );

  if (!payload.schedule) {
    throw new Error("日报任务配置保存失败。");
  }

  return payload.schedule;
}

export async function saveDefaultItemCleanupSchedule(input: {
  enabled: boolean;
  cronExpression: string;
  cleanupRetentionDays: number;
}) {
  const payload = await requestAdminSettingsJson<ItemCleanupSchedulePayload>(
    "/api/admin/monitor/schedule/item-cleanup-default",
    "PATCH",
    input,
    "清理任务配置保存失败。",
  );

  if (!payload.schedule) {
    throw new Error("清理任务配置保存失败。");
  }

  return payload.schedule;
}

export async function saveContentExtractionConfig(input: {
  jinaEnabled: boolean;
  jinaBaseUrl: string;
  jinaApiKey: string;
  jinaApiKeyMode: "replace" | "clear" | "keep";
  timeoutMs: number;
  concurrency: number;
  rpmLimit: number;
  maxPerRun: number;
  minChars: number;
  maxChars: number;
}) {
  const payload = await requestAdminSettingsJson<ContentExtractionPayload>(
    "/api/admin/settings/content-extraction",
    "PATCH",
    input,
    "正文解析设置保存失败。",
  );

  if (!payload.config) {
    throw new Error("正文解析设置保存失败。");
  }

  return payload.config;
}

export async function saveEventBriefingSettings(input: AdminSettingsSnapshot["eventBriefing"]) {
  const payload = await requestAdminSettingsJson<EventBriefingPayload>(
    "/api/admin/settings/event-briefing",
    "PATCH",
    {
      config: {
        minRankScore: input.config.minRankScore,
        channels: input.config.channels,
      },
      preference: {
        weightedRules: input.preference.weightedRules,
        maxCuratorBoost: input.preference.maxCuratorBoost,
        maxCuratorPenalty: input.preference.maxCuratorPenalty,
      },
    },
    "速览配置保存失败。",
  );

  if (!payload.eventBriefing) {
    throw new Error("速览配置保存失败。");
  }

  return payload.eventBriefing;
}

export async function listBriefingPreferenceSuggestions() {
  const payload = await requestAdminSettingsJson<BriefingPreferenceSuggestionsPayload>(
    "/api/admin/settings/event-briefing/suggestions",
    "GET",
    undefined,
    "偏好建议加载失败。",
  );

  return payload.suggestions ?? [];
}

export async function generateBriefingPreferenceSuggestions() {
  const payload = await requestAdminSettingsJson<BriefingPreferenceSuggestionsPayload>(
    "/api/admin/settings/event-briefing/suggestions",
    "POST",
    undefined,
    "偏好建议生成失败。",
  );

  return payload.suggestions ?? [];
}

export async function acceptBriefingPreferenceSuggestion(id: string) {
  const payload = await requestAdminSettingsJson<BriefingPreferenceSuggestionAcceptPayload>(
    `/api/admin/settings/event-briefing/suggestions/${id}/accept`,
    "POST",
    undefined,
    "偏好建议接受失败。",
  );

  if (!payload.preference) {
    throw new Error("偏好建议接受失败。");
  }

  return payload.preference;
}

export async function dismissBriefingPreferenceSuggestion(id: string) {
  const payload = await requestAdminSettingsJson<BriefingPreferenceSuggestionPayload>(
    `/api/admin/settings/event-briefing/suggestions/${id}/dismiss`,
    "POST",
    undefined,
    "偏好建议忽略失败。",
  );

  if (!payload.suggestion) {
    throw new Error("偏好建议忽略失败。");
  }

  return payload.suggestion;
}

export async function dismissBriefingPreferenceSuggestions(suggestionIds: string[]) {
  const payload = await requestAdminSettingsJson<BriefingPreferenceSuggestionsPayload>(
    "/api/admin/settings/event-briefing/suggestions",
    "POST",
    { action: "dismiss_ids", suggestionIds },
    "忽略偏好建议失败。",
  );

  return payload.dismissedCount ?? 0;
}

export async function reorderSourceGroups(groupIds: string[]) {
  const payload = await requestAdminSettingsJson<GroupReorderPayload>(
    "/api/admin/settings/groups/reorder",
    "PATCH",
    { groupIds },
    "分组排序保存失败。",
  );

  if (!payload.groups) {
    throw new Error("分组排序保存失败。");
  }

  return payload.groups;
}

export async function saveHeaderLink(
  input: {
    id?: string | null;
    label: string;
    url: string;
    enabled: boolean;
    sortOrder: number;
    openInNewTab: boolean;
    rel: string;
  },
) {
  const payload = await requestAdminSettingsJson<HeaderLinkPayload>(
    input.id ? `/api/admin/settings/header-links/${input.id}` : "/api/admin/settings/header-links",
    input.id ? "PATCH" : "POST",
    {
      label: input.label,
      url: input.url,
      enabled: input.enabled,
      sortOrder: input.sortOrder,
      openInNewTab: input.openInNewTab,
      rel: input.rel,
    },
    "导航栏配置保存失败。",
  );

  if (!payload.link) {
    throw new Error("导航栏配置保存失败。");
  }

  return payload.link;
}

export async function deleteHeaderLink(id: string) {
  await requestAdminSettingsJson<{ error?: string }>(
    `/api/admin/settings/header-links/${id}`,
    "DELETE",
    {},
    "导航栏配置删除失败。",
  );
}

export async function reorderHeaderLinks(linkIds: string[]) {
  const payload = await requestAdminSettingsJson<HeaderLinksPayload>(
    "/api/admin/settings/header-links/reorder",
    "PATCH",
    { linkIds },
    "导航栏配置排序保存失败。",
  );

  if (!payload.links) {
    throw new Error("导航栏配置排序保存失败。");
  }

  return payload.links;
}

export async function listAdminEntities(input: {
  search?: string;
  sort?: AdminEntitySort;
  page?: number;
  pageSize?: number;
}) {
  const search = new URLSearchParams();
  if (input.search?.trim()) {
    search.set("search", input.search.trim());
  }
  if (input.sort) {
    search.set("sort", input.sort);
  }
  if (input.page) {
    search.set("page", String(input.page));
  }
  if (input.pageSize) {
    search.set("pageSize", String(input.pageSize));
  }
  const queryString = search.toString();
  const payload = await requestAdminSettingsJson<AdminEntityListPayload>(
    `/api/admin/settings/entities${queryString ? `?${queryString}` : ""}`,
    "GET",
    undefined,
    "实体列表加载失败。",
  );

  return payload;
}

export async function addAdminEntityAlias(input: {
  entityId: string;
  aliasName: string;
}) {
  const payload = await requestAdminSettingsJson<EntityAliasPayload>(
    "/api/admin/settings/entities/aliases",
    "POST",
    input,
    "别名添加失败。",
  );

  if (!payload.alias) {
    throw new Error("别名添加失败。");
  }

  return payload.alias;
}

export async function deleteAdminEntityAlias(aliasId: string) {
  await requestAdminSettingsJson<{ error?: string }>(
    `/api/admin/settings/entities/aliases/${encodeURIComponent(aliasId)}`,
    "DELETE",
    {},
    "别名删除失败。",
  );
}

export async function mergeAdminEntities(input: {
  targetEntityId: string;
  sourceEntityIds: string[];
}) {
  return requestAdminSettingsJson<EntityMergePayload>(
    "/api/admin/settings/entities/merge",
    "POST",
    input,
    "实体合并失败。",
  );
}

export async function listAdminEntitySuggestions(input?: {
  search?: string;
  page?: number;
  pageSize?: number;
  limit?: number;
  sort?: AdminEntitySuggestionSort;
}) {
  const search = new URLSearchParams();
  if (input?.search?.trim()) {
    search.set("search", input.search.trim());
  }
  if (input?.sort) {
    search.set("sort", input.sort);
  }
  if (input?.page) {
    search.set("page", String(input.page));
  }
  if (input?.pageSize) {
    search.set("pageSize", String(input.pageSize));
  }
  if (input?.limit) {
    search.set("limit", String(input.limit));
  }
  const queryString = search.toString();

  return requestAdminSettingsJson<AdminEntitySuggestionListPayload>(
    `/api/admin/settings/entities/suggestions${queryString ? `?${queryString}` : ""}`,
    "GET",
    undefined,
    "实体治理建议加载失败。",
  );
}

export async function dismissAdminEntitySuggestion(input: {
  sourceEntityId: string;
  targetEntityId: string;
  decision: "ignored" | "kept";
}) {
  return requestAdminSettingsJson<EntitySuggestionDecisionPayload>(
    "/api/admin/settings/entities/suggestions",
    "POST",
    input,
    "实体治理建议处理失败。",
  );
}

export async function autoMergeHighConfidenceAdminEntitySuggestions(input?: {
  limit?: number;
}) {
  return requestAdminSettingsJson<EntitySuggestionAutoMergePayload>(
    "/api/admin/settings/entities/suggestions",
    "POST",
    {
      action: "auto_merge_high_confidence",
      limit: input?.limit,
    },
    "高置信实体自动合并失败。",
  );
}

export async function precomputeAdminEntitySuggestions() {
  return requestAdminSettingsJson<EntitySuggestionPrecomputePayload>(
    "/api/admin/settings/entities/suggestions",
    "POST",
    {
      action: "precompute",
    },
    "实体治理建议预计算失败。",
  );
}
