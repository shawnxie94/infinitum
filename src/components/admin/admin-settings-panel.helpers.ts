
import type { AdminBriefingWeightRule, AdminBriefingWeightRuleType, AdminEventBriefingChannel } from "@/lib/settings/types";


export type AdminSettingsSection =
  | "ai-model-api"
  | "ai-prompt"
  | "entities"
  | "blacklist"
  | "event-briefing"
  | "groups"
  | "header-links"
  | "sources"
  | "content-extraction"
  | "task-ingestion"
  | "task-daily-report"
  | "task-cleanup";

export const surfaceCardClassName =
  "rounded-[1.1rem] border border-[color:var(--line)] bg-[color-mix(in_srgb,var(--surface)_96%,transparent)] shadow-[var(--shadow-sm)]";
export const checkboxInputClassName =
  "h-4 w-4 rounded border-[color:var(--line-strong)] text-[var(--accent)] focus:ring-[color:var(--accent-soft)]";
export const DEFAULT_DAILY_REPORT_CHANNEL_ID = "important";
export const settingsNavItems: Array<{
  key: AdminSettingsSection;
  label: string;
}> = [
  { key: "ai-model-api", label: "模型API" },
  { key: "ai-prompt", label: "提示词" },
  { key: "entities", label: "实体管理" },
  { key: "blacklist", label: "黑名单" },
  { key: "groups", label: "分组" },
  { key: "header-links", label: "导航栏配置" },
  { key: "sources", label: "信息源" },
  { key: "content-extraction", label: "正文解析" },
  { key: "event-briefing", label: "速览配置" },
  { key: "task-ingestion", label: "采集任务" },
  { key: "task-daily-report", label: "日报任务" },
  { key: "task-cleanup", label: "清理任务" },
] as const;
export const HEADER_LINK_REL_DEFAULT = "noopener noreferrer";
export const HEADER_LINK_REL_SPONSORED = "sponsored noopener noreferrer";
export const headerLinkRelOptions = [
  { value: HEADER_LINK_REL_DEFAULT, label: "普通链接" },
  { value: HEADER_LINK_REL_SPONSORED, label: "AFF/赞助链接" },
];
export const eventTypeOptions = [
  { value: "release", label: "版本发布" },
  { value: "launch", label: "产品上线" },
  { value: "update", label: "进展更新" },
  { value: "funding", label: "融资" },
  { value: "acquisition", label: "收购" },
  { value: "partnership", label: "合作" },
  { value: "policy", label: "政策" },
  { value: "research", label: "研究" },
  { value: "security", label: "安全" },
  { value: "other", label: "其他" },
];
export const eventBriefingRuleTypeOptions: Array<{ value: AdminBriefingWeightRuleType; label: string }> = [
  { value: "entity", label: "实体" },
  { value: "keyword", label: "关键词" },
  { value: "source_group", label: "来源组" },
  { value: "event_type", label: "事件类型" },
];
export const eventBriefingRuleTypeLabels: Record<AdminBriefingWeightRuleType, string> = {
  entity: "实体",
  keyword: "关键词",
  source_group: "来源组",
  event_type: "事件类型",
};
export type BriefingPreferenceSuggestionSort = "sample_desc" | "weight_desc" | "updated_desc";
export const BRIEFING_PREFERENCE_SUGGESTION_PAGE_SIZE = 10;


export function formatSignedWeight(value: number) {
  return value > 0 ? `+${value}` : String(value);
}


export function normalizeHeaderLinkRelOption(rel: string) {
  return rel.split(/\s+/).includes("sponsored") ? HEADER_LINK_REL_SPONSORED : HEADER_LINK_REL_DEFAULT;
}

export function toDateTimeLocalValue(value: string | null | undefined) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const offsetDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return offsetDate.toISOString().slice(0, 16);
}

export function toIsoDateTimeOrNull(value: string) {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function areStringArraysEqual(left: string[], right: string[]) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

export function areWeightRulesEqual(left: AdminBriefingWeightRule[], right: AdminBriefingWeightRule[]) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => {
    const other = right[index];
    return other && value.type === other.type && value.value === other.value && value.weight === other.weight;
  });
}

export function areEventBriefingChannelsEqual(left: AdminEventBriefingChannel[], right: AdminEventBriefingChannel[]) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => {
    const other = right[index];
    return Boolean(other) &&
      value.id === other.id &&
      value.name === other.name &&
      value.enabled === other.enabled &&
      value.sortOrder === other.sortOrder &&
      areStringArraysEqual(value.sourceGroupIds, other.sourceGroupIds);
  });
}

export function createEventBriefingChannel(index: number): AdminEventBriefingChannel {
  const randomId = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().slice(0, 8)
    : `${Date.now().toString(36)}-${index}`;

  return {
    id: `channel-${randomId}`,
    name: `速览频道 ${index + 1}`,
    sourceGroupIds: [],
    enabled: true,
    sortOrder: index,
  };
}

export function buildSelectedBackfillOptions(values: string[]) {
  return values.map((value) => ({ value, label: value }));
}

export function appendMissingOptions(
  options: Array<{ value: string; label: string }>,
  values: string[],
) {
  const existing = new Set(options.map((option) => option.value));
  return [
    ...options,
    ...buildSelectedBackfillOptions(values.filter((value) => !existing.has(value))),
  ];
}

export function refreshPage() {
  if (typeof window !== "undefined") {
    window.location.reload();
  }
}

export const sourceUpdateFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

export const sourceFilterQueryKeys = {
  name: "sourceName",
  group: "sourceGroup",
  enabled: "sourceEnabled",
  page: "sourcePage",
  pageSize: "sourcePageSize",
} as const;

export function getInitialSourceFilterValue(key: string) {
  if (typeof window === "undefined") {
    return "";
  }

  return new URLSearchParams(window.location.search).get(key) ?? "";
}

export function normalizeSourceEnabledFilter(value: string | null | undefined) {
  if (value === "true" || value === "enabled") {
    return "true";
  }

  if (value === "false" || value === "disabled") {
    return "false";
  }

  return "";
}

export function getInitialSourceFilterNumber(key: string, fallback: number) {
  const value = Number.parseInt(getInitialSourceFilterValue(key), 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function downloadTextFile(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function formatSourceUpdateTime(value: string | null) {
  if (!value) {
    return "暂无入库";
  }

  return sourceUpdateFormatter.format(new Date(value));
}

