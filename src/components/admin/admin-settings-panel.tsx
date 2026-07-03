"use client";
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useEffect, useRef, useState, useTransition } from "react";

import {
  acceptBriefingPreferenceSuggestion,
  generateBriefingPreferenceSuggestions,
  importSourcesFromOpmlText,
  deleteHeaderLink,
  dismissBriefingPreferenceSuggestion,
  listBriefingPreferenceSuggestions,
  listAdminTags,
  reorderHeaderLinks,
  reorderSourceGroups,
  resolveSourceFromRssUrl,
  saveContentExtractionConfig,
  saveDefaultDailyReportSchedule,
  saveDefaultIngestionSchedule,
  saveDefaultItemCleanupSchedule,
  saveEventBriefingSettings,
  saveHeaderLink,
  submitAdminSettingsAction,
  type AdminTag,
} from "@/components/admin/admin-settings-panel.api";
import { AiSettingsPanel } from "@/components/admin/ai-settings-panel";
import { TagSettingsPanel } from "@/components/admin/tag-settings-panel";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageShell } from "@/components/ui/page-shell";
import { FilterInput } from "@/components/ui/filter-input";
import { FilterSelect } from "@/components/ui/filter-select";
import { FormField } from "@/components/ui/form-field";
import { IconButton } from "@/components/ui/icon-button";
import { IconCheck, IconEdit, IconGrip, IconLink, IconPlus, IconTag, IconTrash, IconX } from "@/components/ui/icons";
import { ModalShell } from "@/components/ui/modal-shell";
import { PaginationControls } from "@/components/ui/pagination-controls";
import { SelectField } from "@/components/ui/select-field";
import { TextArea } from "@/components/ui/text-area";
import { TextInput } from "@/components/ui/text-input";
import { useToast } from "@/components/ui/toast";
import type {
  AdminBriefingPreferenceSuggestion,
  AdminBriefingWeightRule,
  AdminBriefingWeightRuleType,
  AdminSettingsSnapshot,
  PromptConfigType,
} from "@/lib/settings/types";
import {
  DEFAULT_SCHEDULE_TIMEZONE,
  MAX_CLEANUP_RETENTION_DAYS,
  MAX_AGGREGATION_SPLIT_MAX_EVENTS,
  MAX_DAILY_REPORT_OFFSET_DAYS,
  MAX_FULL_TEXT_FETCH_THRESHOLD,
  MAX_SOURCE_CONCURRENCY,
  MIN_CLEANUP_RETENTION_DAYS,
  MIN_AGGREGATION_SPLIT_MAX_EVENTS,
  MIN_DAILY_REPORT_OFFSET_DAYS,
  MIN_FULL_TEXT_FETCH_THRESHOLD,
  MIN_SOURCE_CONCURRENCY,
  MAX_PER_SOURCE_ITEM_LIMIT,
  MAX_DAILY_REPORT_CANDIDATE_LIMIT,
  MAX_DAILY_REPORT_MAX_RETRIES,
  MIN_DAILY_REPORT_CANDIDATE_LIMIT,
  MIN_DAILY_REPORT_MAX_RETRIES,
  MIN_PER_SOURCE_ITEM_LIMIT,
} from "@/lib/tasks/scheduler";
import { getStableGroupBadgeColor } from "@/lib/groups/badge";
import { cx } from "@/lib/ui/cx";

type AdminSettingsPanelProps = {
  initialSettings: AdminSettingsSnapshot;
  onRefresh?: () => void;
  embedMode?: boolean;
  activeSection?: AdminSettingsSection;
  initialPromptType?: PromptConfigType;
  initialOpenTagSuggestions?: boolean;
  initialOpenBriefingPreferenceSuggestions?: boolean;
};

type AdminSettingsSection =
  | "ai-model-api"
  | "ai-prompt"
  | "tags"
  | "blacklist"
  | "event-briefing"
  | "groups"
  | "header-links"
  | "sources"
  | "content-extraction"
  | "task-ingestion"
  | "task-daily-report"
  | "task-cleanup";

const surfaceCardClassName =
  "rounded-[1.1rem] border border-[color:var(--line)] bg-[color-mix(in_srgb,var(--surface)_96%,transparent)] shadow-[var(--shadow-sm)]";
const checkboxInputClassName =
  "h-4 w-4 rounded border-[color:var(--line-strong)] text-[var(--accent)] focus:ring-[color:var(--accent-soft)]";
const ALL_DAILY_REPORT_GROUPS_SELECT_VALUE = "__all_daily_report_groups__";
const settingsNavItems: Array<{
  key: AdminSettingsSection;
  label: string;
}> = [
  { key: "ai-model-api", label: "模型API" },
  { key: "ai-prompt", label: "提示词" },
  { key: "tags", label: "标签管理" },
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
const HEADER_LINK_REL_DEFAULT = "noopener noreferrer";
const HEADER_LINK_REL_SPONSORED = "sponsored noopener noreferrer";
const headerLinkRelOptions = [
  { value: HEADER_LINK_REL_DEFAULT, label: "普通链接" },
  { value: HEADER_LINK_REL_SPONSORED, label: "AFF/赞助链接" },
];
const eventTypeOptions = [
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
const eventBriefingRuleTypeOptions: Array<{ value: AdminBriefingWeightRuleType; label: string }> = [
  { value: "tag", label: "标签" },
  { value: "keyword", label: "关键词" },
  { value: "source_group", label: "来源组" },
  { value: "event_type", label: "事件类型" },
];
const eventBriefingRuleTypeLabels: Record<AdminBriefingWeightRuleType, string> = {
  tag: "标签",
  keyword: "关键词",
  source_group: "来源组",
  event_type: "事件类型",
};
type BriefingPreferenceSuggestionSort = "sample_desc" | "weight_desc" | "updated_desc";
const briefingPreferenceSuggestionSortOptions: Array<{ value: BriefingPreferenceSuggestionSort; label: string }> = [
  { value: "sample_desc", label: "按证据次数" },
  { value: "weight_desc", label: "按建议权重" },
  { value: "updated_desc", label: "按更新时间" },
];
const BRIEFING_PREFERENCE_SUGGESTION_PAGE_SIZE = 10;

type BriefingPreferenceSuggestionModalProps = {
  suggestions: AdminBriefingPreferenceSuggestion[];
  totalCount: number;
  page: number;
  pageSize: number;
  search: string;
  sort: BriefingPreferenceSuggestionSort;
  isOpen: boolean;
  isBusy: boolean;
  onClose: () => void;
  onSearchChange: (value: string) => void;
  onSortChange: (value: BriefingPreferenceSuggestionSort) => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  onAccept: (suggestion: AdminBriefingPreferenceSuggestion) => void;
  onDismiss: (suggestion: AdminBriefingPreferenceSuggestion) => void;
  onRefresh: () => void;
};

function formatSignedWeight(value: number) {
  return value > 0 ? `+${value}` : String(value);
}

function BriefingPreferenceSuggestionModal({
  suggestions,
  totalCount,
  page,
  pageSize,
  search,
  sort,
  isOpen,
  isBusy,
  onClose,
  onSearchChange,
  onSortChange,
  onPageChange,
  onPageSizeChange,
  onAccept,
  onDismiss,
  onRefresh,
}: BriefingPreferenceSuggestionModalProps) {
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      title="偏好建议"
      widthClassName="max-w-6xl"
      headerClassName="border-b border-[color:var(--line)] p-4"
      bodyClassName="space-y-4 p-4 max-h-[76vh] overflow-y-auto"
      footerClassName="border-t border-[color:var(--line)] bg-[var(--bg-muted)] p-4"
      footer={
        <div className="flex flex-wrap items-center justify-end gap-4">
          <Button onClick={onRefresh} variant="secondary" disabled={isBusy}>
            刷新建议
          </Button>
          <Button onClick={onClose} variant="secondary" disabled={isBusy}>
            关闭
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid w-full grid-cols-1 gap-3 md:grid-cols-2">
          <FilterInput
            id="briefing-preference-suggestion-keyword"
            label="筛选建议"
            ariaLabel="偏好建议筛选"
            placeholder="搜索类型、内容或原因"
            value={search}
            onChange={onSearchChange}
          />
          <FilterSelect
            id="briefing-preference-suggestion-sort"
            label="排序"
            ariaLabel="偏好建议排序"
            value={sort}
            onChange={(value) => onSortChange(value as BriefingPreferenceSuggestionSort)}
            options={briefingPreferenceSuggestionSortOptions}
            showSearch={false}
          />
        </div>

        {suggestions.length === 0 ? (
          <EmptyState className="border-0 bg-[var(--bg-muted)]">
            {search.trim() ? "暂无匹配建议" : "暂无待处理建议"}
          </EmptyState>
        ) : (
          <div className="w-full overflow-x-auto">
            <table className="w-full table-auto text-sm">
              <thead className="bg-[var(--bg-muted)] text-[var(--muted)]">
                <tr>
                  <th className="w-[12%] whitespace-nowrap px-3 py-2 text-left">类型</th>
                  <th className="w-[24%] px-3 py-2 text-left">建议</th>
                  <th className="w-[10%] whitespace-nowrap px-3 py-2 text-right">权重</th>
                  <th className="w-[14%] whitespace-nowrap px-3 py-2 text-right">证据次数</th>
                  <th className="px-3 py-2 text-left">原因</th>
                  <th className="w-[12%] whitespace-nowrap px-3 py-2 text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--line)]">
                {suggestions.map((suggestion) => (
                  <tr key={suggestion.id} className="align-top transition-colors hover:bg-[var(--bg-muted)]">
                    <td className="px-3 py-3 text-[var(--text-2)]">
                      {eventBriefingRuleTypeLabels[suggestion.ruleType]}
                    </td>
                    <td className="px-3 py-3">
                      <div className="font-medium text-[var(--foreground)]">
                        {suggestion.label ?? suggestion.value}
                      </div>
                    </td>
                    <td className={cx(
                      "px-3 py-3 text-right font-mono font-medium",
                      suggestion.suggestedWeight > 0 ? "text-[var(--accent-strong)]" : "text-[var(--danger-ink)]",
                    )}>
                      {formatSignedWeight(suggestion.suggestedWeight)}
                    </td>
                    <td className="px-3 py-3 text-right text-[var(--text-2)]">
                      {suggestion.sampleCount} 次
                    </td>
                    <td className="px-3 py-3 text-xs leading-5 text-[var(--text-2)]">
                      {suggestion.reason}
                    </td>
                    <td className="px-3 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <IconButton
                          aria-label={`接受偏好建议：${suggestion.label ?? suggestion.value}`}
                          title="接受建议"
                          size="sm"
                          variant="ghost"
                          disabled={isBusy}
                          onClick={() => onAccept(suggestion)}
                        >
                          <IconCheck className="h-4 w-4" />
                        </IconButton>
                        <IconButton
                          aria-label={`忽略偏好建议：${suggestion.label ?? suggestion.value}`}
                          title="忽略建议"
                          size="sm"
                          variant="ghost"
                          disabled={isBusy}
                          onClick={() => onDismiss(suggestion)}
                        >
                          <IconX className="h-4 w-4" />
                        </IconButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {totalCount > 0 ? (
          <PaginationControls
            totalItems={totalCount}
            page={page}
            totalPages={totalPages}
            pageSize={pageSize}
            onPageChange={onPageChange}
            onPageSizeChange={onPageSizeChange}
            disabled={isBusy}
          />
        ) : null}
      </div>
    </ModalShell>
  );
}

function normalizeHeaderLinkRelOption(rel: string) {
  return rel.split(/\s+/).includes("sponsored") ? HEADER_LINK_REL_SPONSORED : HEADER_LINK_REL_DEFAULT;
}

function toDateTimeLocalValue(value: string | null | undefined) {
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

function toIsoDateTimeOrNull(value: string) {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function areStringArraysEqual(left: string[], right: string[]) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

function areWeightRulesEqual(left: AdminBriefingWeightRule[], right: AdminBriefingWeightRule[]) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => {
    const other = right[index];
    return other && value.type === other.type && value.value === other.value && value.weight === other.weight;
  });
}

function buildSelectedBackfillOptions(values: string[]) {
  return values.map((value) => ({ value, label: value }));
}

function appendMissingOptions(
  options: Array<{ value: string; label: string }>,
  values: string[],
) {
  const existing = new Set(options.map((option) => option.value));
  return [
    ...options,
    ...buildSelectedBackfillOptions(values.filter((value) => !existing.has(value))),
  ];
}

function refreshPage() {
  if (typeof window !== "undefined") {
    window.location.reload();
  }
}

const sourceUpdateFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

const sourceFilterQueryKeys = {
  name: "sourceName",
  group: "sourceGroup",
  enabled: "sourceEnabled",
  page: "sourcePage",
  pageSize: "sourcePageSize",
} as const;

function getInitialSourceFilterValue(key: string) {
  if (typeof window === "undefined") {
    return "";
  }

  return new URLSearchParams(window.location.search).get(key) ?? "";
}

function normalizeSourceEnabledFilter(value: string | null | undefined) {
  if (value === "true" || value === "enabled") {
    return "true";
  }

  if (value === "false" || value === "disabled") {
    return "false";
  }

  return "";
}

function getInitialSourceFilterNumber(key: string, fallback: number) {
  const value = Number.parseInt(getInitialSourceFilterValue(key), 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function downloadTextFile(filename: string, content: string, type: string) {
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

function formatSourceUpdateTime(value: string | null) {
  if (!value) {
    return "暂无入库";
  }

  return sourceUpdateFormatter.format(new Date(value));
}

export function AdminSettingsPanel({
  initialSettings,
  onRefresh,
  embedMode,
  activeSection: externalActiveSection,
  initialPromptType,
  initialOpenTagSuggestions = false,
  initialOpenBriefingPreferenceSuggestions = false,
}: AdminSettingsPanelProps) {
  type AdminSource = AdminSettingsSnapshot["sources"][number];
  type AdminHeaderLink = NonNullable<AdminSettingsSnapshot["headerLinks"]>[number];
  const [isPending, startTransition] = useTransition();
  const { showToast } = useToast();
  const [sourceGroupOverrides, setSourceGroupOverrides] = useState<Record<string, { groupId: string | null; groupName: string | null }>>({});
  const [internalActiveSection, setInternalActiveSection] =
    useState<AdminSettingsSection>(externalActiveSection ?? "ai-model-api");
  const activeSection = externalActiveSection ?? internalActiveSection;
  const [blacklistText, setBlacklistText] = useState(
    initialSettings.blacklistKeywords.join("\n"),
  );
  const [showCreateGroupComposer, setShowCreateGroupComposer] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [orderedGroups, setOrderedGroups] = useState(initialSettings.groups);
  const [headerLinks, setHeaderLinks] = useState<AdminHeaderLink[]>(initialSettings.headerLinks ?? []);
  const [headerLinkFormMode, setHeaderLinkFormMode] = useState<"create" | "edit" | null>(null);
  const [editingHeaderLinkId, setEditingHeaderLinkId] = useState<string | null>(null);
  const [headerLinkDeleteTarget, setHeaderLinkDeleteTarget] = useState<AdminHeaderLink | null>(null);
  const [headerLinkForm, setHeaderLinkForm] = useState({
    label: "",
    url: "",
    enabled: true,
    openInNewTab: true,
    rel: "sponsored noopener noreferrer",
  });
  const [sourceGroupLinkTarget, setSourceGroupLinkTarget] = useState<AdminSettingsSnapshot["groups"][number] | null>(null);
  const [sourceGroupLinkSearch, setSourceGroupLinkSearch] = useState("");
  const [sourceGroupAssociationConfirm, setSourceGroupAssociationConfirm] = useState<{
    source: AdminSource;
    group: AdminSettingsSnapshot["groups"][number];
    nextGroupId: string | null;
  } | null>(null);
  const opmlFileInputRef = useRef<HTMLInputElement | null>(null);
  const [sourceModalMode, setSourceModalMode] = useState<"create" | "edit" | null>(null);
  const [editingSourceId, setEditingSourceId] = useState<string | null>(null);
  const [sourceDeleteTarget, setSourceDeleteTarget] = useState<AdminSource | null>(null);
  const [sourceNameFilter, setSourceNameFilter] = useState(() => getInitialSourceFilterValue(sourceFilterQueryKeys.name));
  const [sourceGroupFilter, setSourceGroupFilter] = useState(() => getInitialSourceFilterValue(sourceFilterQueryKeys.group));
  const [sourceEnabledFilter, setSourceEnabledFilter] = useState(() =>
    normalizeSourceEnabledFilter(getInitialSourceFilterValue(sourceFilterQueryKeys.enabled)),
  );
  const [sourcePage, setSourcePage] = useState(() => getInitialSourceFilterNumber(sourceFilterQueryKeys.page, 1));
  const [sourcePageSize, setSourcePageSize] = useState(() => getInitialSourceFilterNumber(sourceFilterQueryKeys.pageSize, 10));
  const [sourceForm, setSourceForm] = useState({
    name: "",
    rssUrl: "",
    siteUrl: "",
    enabled: true,
    aiParsingEnabled: true,
    aggregationEnabled: true,
    aggregationDetectionEnabled: false,
    groupId: "",
  });
  const [taskScheduleEnabled, setTaskScheduleEnabled] = useState(
    initialSettings.taskSchedule.enabled,
  );
  const [taskScheduleCronExpression, setTaskScheduleCronExpression] = useState(
    initialSettings.taskSchedule.cronExpression,
  );
  const [taskScheduleSourceConcurrency, setTaskScheduleSourceConcurrency] =
    useState(String(initialSettings.taskSchedule.sourceConcurrency));
  const [taskScheduleFullTextFetchThreshold, setTaskScheduleFullTextFetchThreshold] =
    useState(String(initialSettings.taskSchedule.fullTextFetchThreshold));
  const [taskSchedulePerSourceItemLimit, setTaskSchedulePerSourceItemLimit] =
    useState(String(initialSettings.taskSchedule.perSourceItemLimit));
  const [taskScheduleAggregationSplitMaxEvents, setTaskScheduleAggregationSplitMaxEvents] =
    useState(String(initialSettings.taskSchedule.aggregationSplitMaxEvents));
  const [taskScheduleProcessingStartAt, setTaskScheduleProcessingStartAt] = useState(
    toDateTimeLocalValue(initialSettings.taskSchedule.processingStartAt),
  );
  const [taskScheduleSnapshot, setTaskScheduleSnapshot] = useState(
    initialSettings.taskSchedule,
  );
  const [dailyReportScheduleEnabled, setDailyReportScheduleEnabled] = useState(
    initialSettings.dailyReportSchedule.enabled,
  );
  const [dailyReportScheduleCronExpression, setDailyReportScheduleCronExpression] = useState(
    initialSettings.dailyReportSchedule.cronExpression,
  );
  const [dailyReportCandidateLimit, setDailyReportCandidateLimit] = useState(
    String(initialSettings.dailyReportSchedule.dailyReportCandidateLimit),
  );
  const [dailyReportOffsetDays, setDailyReportOffsetDays] = useState(
    String(initialSettings.dailyReportSchedule.dailyReportOffsetDays),
  );
  const [dailyReportAutoPublish, setDailyReportAutoPublish] = useState(
    initialSettings.dailyReportSchedule.dailyReportAutoPublish,
  );
  const [dailyReportMaxRetries, setDailyReportMaxRetries] = useState(
    String(initialSettings.dailyReportSchedule.dailyReportMaxRetries),
  );
  const [dailyReportGroupIds, setDailyReportGroupIds] = useState(
    initialSettings.dailyReportSchedule.dailyReportGroupIds ?? [],
  );
  const [dailyReportScheduleSnapshot, setDailyReportScheduleSnapshot] = useState(
    initialSettings.dailyReportSchedule,
  );
  const [cleanupScheduleEnabled, setCleanupScheduleEnabled] = useState(
    initialSettings.itemCleanupSchedule.enabled,
  );
  const [cleanupScheduleCronExpression, setCleanupScheduleCronExpression] = useState(
    initialSettings.itemCleanupSchedule.cronExpression,
  );
  const [cleanupScheduleRetentionDays, setCleanupScheduleRetentionDays] = useState(
    String(initialSettings.itemCleanupSchedule.cleanupRetentionDays),
  );
  const [cleanupScheduleSnapshot, setCleanupScheduleSnapshot] = useState(
    initialSettings.itemCleanupSchedule,
  );
  const [contentExtractionSnapshot, setContentExtractionSnapshot] = useState(
    initialSettings.contentExtraction,
  );
  const [contentExtractionProvider, setContentExtractionProvider] = useState<"local" | "jina">(
    initialSettings.contentExtraction.jinaEnabled ? "jina" : "local",
  );
  const [contentExtractionBaseUrl, setContentExtractionBaseUrl] = useState(
    initialSettings.contentExtraction.jinaBaseUrl,
  );
  const [contentExtractionApiKey, setContentExtractionApiKey] = useState("");
  const [contentExtractionApiKeyTouched, setContentExtractionApiKeyTouched] = useState(false);
  const [contentExtractionTimeoutMs, setContentExtractionTimeoutMs] = useState(
    String(initialSettings.contentExtraction.timeoutMs),
  );
  const [contentExtractionConcurrency, setContentExtractionConcurrency] = useState(
    String(initialSettings.contentExtraction.concurrency),
  );
  const [contentExtractionRpmLimit, setContentExtractionRpmLimit] = useState(
    String(initialSettings.contentExtraction.rpmLimit),
  );
  const [contentExtractionMaxPerRun, setContentExtractionMaxPerRun] = useState(
    String(initialSettings.contentExtraction.maxPerRun),
  );
  const [contentExtractionMinChars, setContentExtractionMinChars] = useState(
    String(initialSettings.contentExtraction.minChars),
  );
  const [contentExtractionMaxChars, setContentExtractionMaxChars] = useState(
    String(initialSettings.contentExtraction.maxChars),
  );
  const [eventBriefingSnapshot, setEventBriefingSnapshot] = useState(initialSettings.eventBriefing);
  const [eventBriefingMinRankScore, setEventBriefingMinRankScore] = useState(
    String(initialSettings.eventBriefing.config.minRankScore),
  );
  const [eventBriefingWeightedRules, setEventBriefingWeightedRules] = useState(
    initialSettings.eventBriefing.preference.weightedRules,
  );
  const [eventBriefingMaxCuratorBoost, setEventBriefingMaxCuratorBoost] = useState(
    String(initialSettings.eventBriefing.preference.maxCuratorBoost),
  );
  const [eventBriefingMaxCuratorPenalty, setEventBriefingMaxCuratorPenalty] = useState(
    String(initialSettings.eventBriefing.preference.maxCuratorPenalty),
  );
  const [eventBriefingRuleModalOpen, setEventBriefingRuleModalOpen] = useState(false);
  const [eventBriefingRuleDraft, setEventBriefingRuleDraft] = useState<{
    type: AdminBriefingWeightRuleType;
    value: string;
    weight: string;
  }>({ type: "tag", value: "", weight: "5" });
  const [briefingPreferenceSuggestions, setBriefingPreferenceSuggestions] = useState<AdminBriefingPreferenceSuggestion[]>([]);
  const [briefingPreferenceSuggestionsLoaded, setBriefingPreferenceSuggestionsLoaded] = useState(false);
  const [briefingPreferenceSuggestionModalOpen, setBriefingPreferenceSuggestionModalOpen] = useState(
    initialOpenBriefingPreferenceSuggestions,
  );
  const [briefingPreferenceSuggestionSearch, setBriefingPreferenceSuggestionSearch] = useState("");
  const [briefingPreferenceSuggestionSort, setBriefingPreferenceSuggestionSort] =
    useState<BriefingPreferenceSuggestionSort>("sample_desc");
  const [briefingPreferenceSuggestionPage, setBriefingPreferenceSuggestionPage] = useState(1);
  const [briefingPreferenceSuggestionPageSize, setBriefingPreferenceSuggestionPageSize] = useState(
    BRIEFING_PREFERENCE_SUGGESTION_PAGE_SIZE,
  );
  const [briefingPreferenceAcceptTarget, setBriefingPreferenceAcceptTarget] =
    useState<AdminBriefingPreferenceSuggestion | null>(null);
  const [briefingPreferenceDismissTarget, setBriefingPreferenceDismissTarget] =
    useState<AdminBriefingPreferenceSuggestion | null>(null);
  const [eventBriefingTags, setEventBriefingTags] = useState<AdminTag[]>([]);
  const [eventBriefingTagsLoaded, setEventBriefingTagsLoaded] = useState(false);
  const normalizedBlacklistKeywords = blacklistText
    .split("\n")
    .map((keyword) => keyword.trim())
    .filter(Boolean);
  const eventBriefingTagSelectOptions = appendMissingOptions(
    eventBriefingTags.map((tag) => ({
      value: tag.name,
      label: `${tag.name} (${tag.itemCount})`,
    })),
    eventBriefingWeightedRules.filter((rule) => rule.type === "tag").map((rule) => rule.value),
  );
  const eventBriefingSourceGroupSelectOptions = appendMissingOptions(
    orderedGroups.map((group) => ({
      value: group.id,
      label: group.name,
    })),
    eventBriefingWeightedRules.filter((rule) => rule.type === "source_group").map((rule) => rule.value),
  );
  const eventBriefingEventTypeSelectOptions = appendMissingOptions(
    eventTypeOptions,
    eventBriefingWeightedRules.filter((rule) => rule.type === "event_type").map((rule) => rule.value),
  );

  // Paginated source list fetched from the dedicated sources API.
  const [paginatedSourceList, setPaginatedSourceList] = useState<AdminSource[]>([]);
  const [sourceTotal, setSourceTotal] = useState(0);
  const [sourceTotalPages, setSourceTotalPages] = useState(1);
  const [sourceListRefreshKey, setSourceListRefreshKey] = useState(0);
  const sourceFetchIdRef = useRef(0);

  useEffect(() => {
    if (activeSection !== "sources") return;

    const fetchId = ++sourceFetchIdRef.current;
    const params = new URLSearchParams({
      page: String(sourcePage),
      pageSize: String(sourcePageSize),
    });
    if (sourceNameFilter) params.set("search", sourceNameFilter);
    if (sourceGroupFilter) params.set("groupId", sourceGroupFilter);
    if (sourceEnabledFilter) params.set("enabled", sourceEnabledFilter);

    fetch(`/api/admin/settings/sources?${params.toString()}`)
      .then((r) => r.json())
      .then((data: { sources: AdminSource[]; total: number; totalPages: number; page: number }) => {
        if (fetchId !== sourceFetchIdRef.current) return;
        const merged = data.sources.map((source) => ({
          ...source,
          ...(sourceGroupOverrides[source.id] ?? {}),
        }));
        setPaginatedSourceList(merged);
        setSourceTotal(data.total);
        setSourceTotalPages(data.totalPages);
        if (data.page !== sourcePage) setSourcePage(data.page);
      })
      .catch(() => { /* ignore */ });
  }, [activeSection, sourcePage, sourcePageSize, sourceNameFilter, sourceGroupFilter, sourceEnabledFilter, sourceGroupOverrides, sourceListRefreshKey]);

  useEffect(() => {
    if (activeSection !== "event-briefing" || eventBriefingTagsLoaded) {
      return;
    }

    let ignore = false;

    listAdminTags({ sort: "usage_desc", page: 1, pageSize: 100 })
      .then((payload) => {
        if (ignore) {
          return;
        }
        setEventBriefingTags(payload.tags);
        setEventBriefingTagsLoaded(true);
      })
      .catch(() => {
        if (ignore) {
          return;
        }
        setEventBriefingTagsLoaded(true);
      });

    return () => {
      ignore = true;
    };
  }, [activeSection, eventBriefingTagsLoaded]);

  useEffect(() => {
    if (
      activeSection !== "event-briefing" ||
      !briefingPreferenceSuggestionModalOpen ||
      briefingPreferenceSuggestionsLoaded
    ) {
      return;
    }

    let ignore = false;

    listBriefingPreferenceSuggestions()
      .then((suggestions) => {
        if (ignore) {
          return;
        }
        setBriefingPreferenceSuggestions(suggestions);
        setBriefingPreferenceSuggestionsLoaded(true);
      })
      .catch(() => {
        if (ignore) {
          return;
        }
        setBriefingPreferenceSuggestionsLoaded(true);
      });

    return () => {
      ignore = true;
    };
  }, [activeSection, briefingPreferenceSuggestionModalOpen, briefingPreferenceSuggestionsLoaded]);

  // Lighter-weight search for the group-linking modal — fetches with a larger
  // page size since the modal needs instant client-side filtering.
  const [groupLinkSourceList, setGroupLinkSourceList] = useState<AdminSource[]>([]);
  const groupLinkFetchIdRef = useRef(0);
  useEffect(() => {
    if (!sourceGroupLinkTarget) {
      // Reset list after a tick to avoid sync setState in effect.
      const id = window.setTimeout(() => setGroupLinkSourceList([]), 0);
      return () => window.clearTimeout(id);
    }
    const fetchId = ++groupLinkFetchIdRef.current;
    const params = new URLSearchParams({ page: "1", pageSize: "100" });
    if (sourceGroupLinkSearch) params.set("search", sourceGroupLinkSearch);

    fetch(`/api/admin/settings/sources?${params.toString()}`)
      .then((r) => r.json())
      .then((data: { sources: AdminSource[] }) => {
        if (fetchId !== groupLinkFetchIdRef.current) return;
        setGroupLinkSourceList(data.sources);
      })
      .catch(() => { /* ignore */ });
  }, [sourceGroupLinkTarget, sourceGroupLinkSearch]);

  const safeSourcePage = Math.min(sourcePage, sourceTotalPages);
  const getEventBriefingRuleOptions = (type: AdminBriefingWeightRuleType) => {
    if (type === "tag") {
      return eventBriefingTagSelectOptions;
    }
    if (type === "source_group") {
      return eventBriefingSourceGroupSelectOptions;
    }
    if (type === "event_type") {
      return eventBriefingEventTypeSelectOptions;
    }
    return [];
  };
  const getEventBriefingRuleLabel = (rule: AdminBriefingWeightRule) => {
    if (rule.type === "keyword") {
      return rule.value;
    }

    return getEventBriefingRuleOptions(rule.type).find((option) => option.value === rule.value)?.label ?? rule.value;
  };
  const filteredBriefingPreferenceSuggestions = briefingPreferenceSuggestions
    .filter((suggestion) => {
      const search = briefingPreferenceSuggestionSearch.trim().toLowerCase();
      if (!search) {
        return true;
      }

      return [
        eventBriefingRuleTypeLabels[suggestion.ruleType],
        suggestion.value,
        suggestion.label,
        suggestion.reason,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(search);
    })
    .sort((left, right) => {
      if (briefingPreferenceSuggestionSort === "sample_desc") {
        return right.sampleCount - left.sampleCount || right.confidence - left.confidence;
      }
      if (briefingPreferenceSuggestionSort === "weight_desc") {
        return Math.abs(right.suggestedWeight) - Math.abs(left.suggestedWeight) || right.confidence - left.confidence;
      }
      if (briefingPreferenceSuggestionSort === "updated_desc") {
        return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
      }

      return right.sampleCount - left.sampleCount || right.confidence - left.confidence;
    });
  const briefingPreferenceSuggestionTotalCount = filteredBriefingPreferenceSuggestions.length;
  const briefingPreferenceSuggestionTotalPages = Math.max(
    1,
    Math.ceil(briefingPreferenceSuggestionTotalCount / briefingPreferenceSuggestionPageSize),
  );
  const safeBriefingPreferenceSuggestionPage = Math.min(
    briefingPreferenceSuggestionPage,
    briefingPreferenceSuggestionTotalPages,
  );
  const pagedBriefingPreferenceSuggestions = filteredBriefingPreferenceSuggestions.slice(
    (safeBriefingPreferenceSuggestionPage - 1) * briefingPreferenceSuggestionPageSize,
    safeBriefingPreferenceSuggestionPage * briefingPreferenceSuggestionPageSize,
  );
  const openEventBriefingRuleModal = () => {
    setEventBriefingRuleDraft({ type: "tag", value: "", weight: "5" });
    setEventBriefingRuleModalOpen(true);
  };
  const openBriefingPreferenceSuggestionModal = () => {
    setBriefingPreferenceSuggestionModalOpen(true);
  };
  const addEventBriefingWeightRule = () => {
    const value = eventBriefingRuleDraft.value.trim();
    const parsedWeight = Number.parseInt(eventBriefingRuleDraft.weight.trim(), 10);

    if (!value) {
      showToast("请选择或输入规则内容。", "error");
      return;
    }
    if (!Number.isInteger(parsedWeight) || parsedWeight < -50 || parsedWeight > 30 || parsedWeight === 0) {
      showToast("权重需为 -50 到 30 之间的非 0 整数。", "error");
      return;
    }

    const nextRule: AdminBriefingWeightRule = {
      type: eventBriefingRuleDraft.type,
      value: eventBriefingRuleDraft.type === "event_type" ? value.toLowerCase() : value,
      weight: parsedWeight,
    };

    setEventBriefingWeightedRules((current) => [...current, nextRule]);
    setEventBriefingRuleModalOpen(false);
  };
  const removeEventBriefingWeightRule = (index: number) => {
    setEventBriefingWeightedRules((current) => current.filter((_, currentIndex) => currentIndex !== index));
  };
  const refreshBriefingPreferenceSuggestions = () => {
    startTransition(async () => {
      try {
        const suggestions = await generateBriefingPreferenceSuggestions();
        setBriefingPreferenceSuggestions(suggestions);
        setBriefingPreferenceSuggestionsLoaded(true);
        setBriefingPreferenceSuggestionPage(1);
        showToast(suggestions.length > 0 ? "偏好建议已更新。" : "暂无新的偏好建议。", "success");
      } catch (error) {
        showToast(error instanceof Error ? error.message : "偏好建议生成失败。", "error");
      }
    });
  };
  const acceptBriefingPreferenceSuggestionItem = (suggestion: AdminBriefingPreferenceSuggestion) => {
    startTransition(async () => {
      try {
        const preference = await acceptBriefingPreferenceSuggestion(suggestion.id);
        const nextSnapshot = {
          ...eventBriefingSnapshot,
          preference,
        };

        setEventBriefingSnapshot(nextSnapshot);
        setEventBriefingWeightedRules(preference.weightedRules);
        setEventBriefingMaxCuratorBoost(String(preference.maxCuratorBoost));
        setEventBriefingMaxCuratorPenalty(String(preference.maxCuratorPenalty));
        setBriefingPreferenceSuggestions((current) => current.filter((item) => item.id !== suggestion.id));
        setBriefingPreferenceSuggestionPage(1);
        showToast("偏好建议已写入事件偏好。", "success");
      } catch (error) {
        showToast(error instanceof Error ? error.message : "偏好建议接受失败。", "error");
      }
    });
  };
  const dismissBriefingPreferenceSuggestionItem = (suggestion: AdminBriefingPreferenceSuggestion) => {
    startTransition(async () => {
      try {
        await dismissBriefingPreferenceSuggestion(suggestion.id);
        setBriefingPreferenceSuggestions((current) => current.filter((item) => item.id !== suggestion.id));
        setBriefingPreferenceSuggestionPage(1);
        showToast("偏好建议已忽略。", "success");
      } catch (error) {
        showToast(error instanceof Error ? error.message : "偏好建议忽略失败。", "error");
      }
    });
  };

  const updateSourceFilterUrl = (next: {
    name?: string;
    group?: string;
    enabled?: string;
    page?: number;
    pageSize?: number;
  }) => {
    if (typeof window === "undefined") {
      return;
    }

    const url = new URL(window.location.href);
    const values = {
      name: next.name ?? sourceNameFilter,
      group: next.group ?? sourceGroupFilter,
      enabled: normalizeSourceEnabledFilter(next.enabled ?? sourceEnabledFilter),
      page: next.page ?? sourcePage,
      pageSize: next.pageSize ?? sourcePageSize,
    };

    const entries: Array<[string, string | number, string | number]> = [
      [sourceFilterQueryKeys.name, values.name, ""],
      [sourceFilterQueryKeys.group, values.group, ""],
      [sourceFilterQueryKeys.enabled, values.enabled, ""],
      [sourceFilterQueryKeys.page, values.page, 1],
      [sourceFilterQueryKeys.pageSize, values.pageSize, 10],
    ];

    for (const [key, value, defaultValue] of entries) {
      if (value === defaultValue || value === "") {
        url.searchParams.delete(key);
      } else {
        url.searchParams.set(key, String(value));
      }
    }

    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  };

  const submitJson = (
    url: string,
    method: string,
    body: unknown,
    successMessage: string,
    reload = false,
    onSuccess?: () => void,
  ) => {
    startTransition(async () => {
      try {
        await submitAdminSettingsAction(url, method, body);

        showToast(successMessage, "success");
        onSuccess?.();

        if (reload) {
          triggerRefresh();
        }
      } catch (error) {
        showToast(error instanceof Error ? error.message : "保存失败", "error");
      }
    });
  };

  const triggerRefresh = () => {
    onRefresh?.();

    if (!onRefresh) {
      refreshPage();
    }
  };

  const openCreateSourceModal = () => {
    setSourceModalMode("create");
    setEditingSourceId(null);
    setSourceForm({
      name: "",
      rssUrl: "",
      siteUrl: "",
      enabled: true,
      aiParsingEnabled: true,
      aggregationEnabled: true,
      aggregationDetectionEnabled: false,
      groupId: "",
    });
  };

  const openSourceGroupLinkModal = (group: AdminSettingsSnapshot["groups"][number]) => {
    setSourceGroupLinkTarget(group);
    setSourceGroupLinkSearch("");
  };

  const openSourceGroupAssociationConfirm = (source: AdminSource, groupId: string | null) => {
    if (!sourceGroupLinkTarget) {
      return;
    }

    setSourceGroupAssociationConfirm({
      source,
      group: sourceGroupLinkTarget,
      nextGroupId: groupId,
    });
  };

  const confirmSourceGroupAssociation = () => {
    if (!sourceGroupAssociationConfirm) {
      return;
    }

    const { source, group, nextGroupId } = sourceGroupAssociationConfirm;
    const isUnlinking = nextGroupId === null;

    startTransition(async () => {
      try {
        await submitAdminSettingsAction(
          `/api/admin/settings/sources/${source.id}`,
          "PATCH",
          {
            name: source.name,
            rssUrl: source.rssUrl,
            siteUrl: source.siteUrl,
            enabled: source.enabled,
            aiParsingEnabled: source.aiParsingEnabled,
            aggregationEnabled: source.aggregationEnabled,
            aggregationDetectionEnabled: source.aggregationDetectionEnabled ?? false,
            groupId: nextGroupId,
          },
        );

        showToast(
          isUnlinking
            ? `已取消「${source.name}」与「${group.name}」的关联。`
            : `已将「${source.name}」关联到「${group.name}」。`,
          "success",
        );
        setSourceGroupOverrides((currentOverrides) => ({
          ...currentOverrides,
          [source.id]: {
            groupId: nextGroupId,
            groupName: nextGroupId ? group.name : null,
          },
        }));
        setSourceGroupAssociationConfirm(null);
      } catch (error) {
        showToast(error instanceof Error ? error.message : "信息源分组更新失败。", "error");
      }
    });
  };

  const openEditSourceModal = (source: AdminSource) => {
    setSourceModalMode("edit");
    setEditingSourceId(source.id);
    setSourceForm({
      name: source.name,
      rssUrl: source.rssUrl,
      siteUrl: source.siteUrl,
      enabled: source.enabled,
      aiParsingEnabled: source.aiParsingEnabled ?? true,
      aggregationEnabled: source.aggregationEnabled ?? true,
      aggregationDetectionEnabled: source.aggregationDetectionEnabled ?? false,
      groupId: source.groupId ?? "",
    });
  };

  const resolveSourceFromRss = () => {
    if (!sourceForm.rssUrl.trim()) {
      showToast("请先输入 RSS URL。", "error");
      return;
    }

    startTransition(async () => {
      try {
        const source = await resolveSourceFromRssUrl(sourceForm.rssUrl.trim());

        setSourceForm((current) => ({
          ...current,
          name: source.name,
          rssUrl: source.rssUrl,
          siteUrl: source.siteUrl,
          aiParsingEnabled: source.suggestedAiParsingEnabled,
        }));
        showToast("已根据 RSS 自动填充信息源基本信息。", "success");
      } catch (error) {
        showToast(error instanceof Error ? error.message : "RSS 解析失败", "error");
      }
    });
  };

  const importOpml = (file: File | null) => {
    if (!file) {
      showToast("请先选择 OPML 文件。", "error");
      return;
    }

    startTransition(async () => {
      try {
        const opmlText = await file.text();
        const summary = await importSourcesFromOpmlText(opmlText);

        showToast(
          `OPML 导入完成：新建 ${summary.createdCount} 个，更新 ${summary.updatedCount} 个，失败 ${summary.failedCount} 个。`,
          "success",
        );
        if (opmlFileInputRef.current) {
          opmlFileInputRef.current.value = "";
        }
        window.setTimeout(() => {
          triggerRefresh();
        }, 600);
      } catch (error) {
        showToast(error instanceof Error ? error.message : "OPML 导入失败", "error");
      }
    });
  };

  const exportOpml = async () => {
    // Fetch all sources for OPML export (up to 1000).
    let allSources: AdminSource[] = [];
    try {
      const res = await fetch("/api/admin/settings/sources?page=1&pageSize=1000");
      const data = await res.json() as { sources: AdminSource[] };
      allSources = data.sources ?? [];
    } catch { /* use empty list if fetch fails */ }

    const groupsById = new Map(orderedGroups.map((group) => [group.id, group.name]));
    const groupedSources = new Map<string, AdminSource[]>();
    const ungroupedSources: AdminSource[] = [];

    for (const source of allSources) {
      if (source.groupId) {
        groupedSources.set(source.groupId, [...(groupedSources.get(source.groupId) ?? []), source]);
      } else {
        ungroupedSources.push(source);
      }
    }

    const sourceOutline = (source: AdminSource, indent = "    ") =>
      `${indent}<outline text="${escapeXml(source.name)}" title="${escapeXml(source.name)}" type="rss" xmlUrl="${escapeXml(source.rssUrl)}" htmlUrl="${escapeXml(source.siteUrl)}" infinitum:enabled="${source.enabled ? "true" : "false"}" infinitum:aiParsingEnabled="${source.aiParsingEnabled !== false ? "true" : "false"}" infinitum:aggregationEnabled="${source.aggregationEnabled !== false ? "true" : "false"}" infinitum:aggregationDetectionEnabled="${source.aggregationDetectionEnabled === true ? "true" : "false"}" />`;
    const outlines = [
      ...orderedGroups.flatMap((group) => {
        const sources = groupedSources.get(group.id) ?? [];

        if (sources.length === 0) {
          return [];
        }

        return [
          `    <outline text="${escapeXml(groupsById.get(group.id) ?? group.name)}" title="${escapeXml(groupsById.get(group.id) ?? group.name)}">`,
          ...sources.map((source) => sourceOutline(source, "      ")),
          "    </outline>",
        ];
      }),
      ...ungroupedSources.map((source) => sourceOutline(source)),
    ];
    const opml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<opml version="2.0" xmlns:infinitum="https://infinitum.app/opml">',
      "  <head>",
      "    <title>Infinitum Subscriptions</title>",
      `    <dateCreated>${new Date().toUTCString()}</dateCreated>`,
      "  </head>",
      "  <body>",
      ...outlines,
      "  </body>",
      "</opml>",
      "",
    ].join("\n");

    downloadTextFile("infinitum-subscriptions.opml", opml, "text/x-opml;charset=utf-8");
  };

  const handleSourcePageSizeChange = (nextPageSize: number) => {
    setSourcePageSize(nextPageSize);
    setSourcePage(1);
    updateSourceFilterUrl({ page: 1, pageSize: nextPageSize });
  };

  const saveGroupOrder = (nextGroups: AdminSettingsSnapshot["groups"]) => {
    startTransition(async () => {
      try {
        const savedGroups = await reorderSourceGroups(nextGroups.map((group) => group.id));
        setOrderedGroups(savedGroups);
        showToast("分组排序已保存。", "success");
      } catch (error) {
        setOrderedGroups(initialSettings.groups);
        showToast(error instanceof Error ? error.message : "分组排序保存失败。", "error");
      }
    });
  };

  const openCreateHeaderLinkForm = () => {
    setHeaderLinkFormMode("create");
    setEditingHeaderLinkId(null);
    setHeaderLinkForm({
      label: "",
      url: "",
      enabled: true,
      openInNewTab: true,
      rel: HEADER_LINK_REL_SPONSORED,
    });
  };

  const openEditHeaderLinkForm = (link: AdminHeaderLink) => {
    setHeaderLinkFormMode("edit");
    setEditingHeaderLinkId(link.id);
    setHeaderLinkForm({
      label: link.label,
      url: link.url,
      enabled: link.enabled,
      openInNewTab: link.openInNewTab,
      rel: normalizeHeaderLinkRelOption(link.rel),
    });
  };

  const closeHeaderLinkForm = () => {
    setHeaderLinkFormMode(null);
    setEditingHeaderLinkId(null);
  };

  const saveHeaderLinkForm = () => {
    const label = headerLinkForm.label.trim();
    const url = headerLinkForm.url.trim();

    if (!label) {
      showToast("请输入链接名称。", "error");
      return;
    }

    if (label.length > 20) {
      showToast("链接名称不能超过 20 个字符。", "error");
      return;
    }

    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        showToast("链接 URL 仅支持 http 或 https。", "error");
        return;
      }
    } catch {
      showToast("请输入有效的链接 URL。", "error");
      return;
    }

    const currentLink = editingHeaderLinkId
      ? headerLinks.find((link) => link.id === editingHeaderLinkId)
      : null;
    const sortOrder = currentLink?.sortOrder ?? headerLinks.length;

    startTransition(async () => {
      try {
        const savedLink = await saveHeaderLink({
          id: editingHeaderLinkId,
          label,
          url,
          enabled: headerLinkForm.enabled,
          sortOrder,
          openInNewTab: headerLinkForm.openInNewTab,
          rel: headerLinkForm.rel,
        });

        setHeaderLinks((current) => {
          const existingIndex = current.findIndex((link) => link.id === savedLink.id);
          if (existingIndex < 0) {
            return [...current, savedLink].sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
          }

          const next = [...current];
          next[existingIndex] = savedLink;
          return next.sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
        });
        closeHeaderLinkForm();
        showToast(headerLinkFormMode === "edit" ? "导航栏配置已更新。" : "导航栏配置已创建。", "success");
      } catch (error) {
        showToast(error instanceof Error ? error.message : "导航栏配置保存失败。", "error");
      }
    });
  };

  const confirmDeleteHeaderLink = () => {
    if (!headerLinkDeleteTarget) {
      return;
    }

    startTransition(async () => {
      try {
        await deleteHeaderLink(headerLinkDeleteTarget.id);
        setHeaderLinks((current) => current.filter((link) => link.id !== headerLinkDeleteTarget.id));
        setHeaderLinkDeleteTarget(null);
        showToast("导航栏配置已删除。", "success");
      } catch (error) {
        showToast(error instanceof Error ? error.message : "导航栏配置删除失败。", "error");
      }
    });
  };

  const saveHeaderLinkOrder = (nextLinks: AdminHeaderLink[]) => {
    setHeaderLinks(nextLinks.map((link, index) => ({ ...link, sortOrder: index })));

    startTransition(async () => {
      try {
        const savedLinks = await reorderHeaderLinks(nextLinks.map((link) => link.id));
        setHeaderLinks(savedLinks);
        showToast("导航栏配置排序已保存。", "success");
      } catch (error) {
        setHeaderLinks(headerLinks);
        showToast(error instanceof Error ? error.message : "导航栏配置排序保存失败。", "error");
      }
    });
  };

  const groupSortSensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleGroupDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (!over || active.id === over.id) {
      return;
    }

    const oldIndex = orderedGroups.findIndex((group) => group.id === active.id);
    const newIndex = orderedGroups.findIndex((group) => group.id === over.id);

    if (oldIndex < 0 || newIndex < 0) {
      return;
    }

    const nextGroups = arrayMove(orderedGroups, oldIndex, newIndex);
    setOrderedGroups(nextGroups);
    saveGroupOrder(nextGroups);
  };

  const handleHeaderLinkDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (!over || active.id === over.id) {
      return;
    }

    const oldIndex = headerLinks.findIndex((link) => link.id === active.id);
    const newIndex = headerLinks.findIndex((link) => link.id === over.id);

    if (oldIndex < 0 || newIndex < 0) {
      return;
    }

    saveHeaderLinkOrder(arrayMove(headerLinks, oldIndex, newIndex));
  };

  const handleSaveSource = () => {
    const payload = {
      ...sourceForm,
      groupId: sourceForm.groupId || null,
    };
    const refreshCurrentSourceList = () => {
      setSourceModalMode(null);
      setEditingSourceId(null);
      setSourceListRefreshKey((current) => current + 1);
    };

    if (sourceModalMode === "edit" && editingSourceId) {
      submitJson(
        `/api/admin/settings/sources/${editingSourceId}`,
        "PATCH",
        payload,
        "信息源已更新。",
        false,
        refreshCurrentSourceList,
      );
      return;
    }

    submitJson(
      "/api/admin/settings/sources",
      "POST",
      payload,
      "信息源已创建。",
      false,
      refreshCurrentSourceList,
    );
  };

  const handleConfirmDeleteSource = () => {
    if (!sourceDeleteTarget) {
      return;
    }

    submitJson(
      `/api/admin/settings/sources/${sourceDeleteTarget.id}`,
      "DELETE",
      {},
      "信息源已删除。",
      false,
      () => {
        setSourceDeleteTarget(null);
        setSourceListRefreshKey((current) => current + 1);
      },
    );
  };

  const saveTaskSchedule = () => {
    const parsedSourceConcurrency = Number.parseInt(
      taskScheduleSourceConcurrency.trim(),
      10,
    );
    const parsedFullTextFetchThreshold = Number.parseInt(
      taskScheduleFullTextFetchThreshold.trim(),
      10,
    );
    const parsedPerSourceItemLimit = Number.parseInt(
      taskSchedulePerSourceItemLimit.trim(),
      10,
    );
    const parsedAggregationSplitMaxEvents = Number.parseInt(
      taskScheduleAggregationSplitMaxEvents.trim(),
      10,
    );

    if (
      !Number.isInteger(parsedSourceConcurrency) ||
      parsedSourceConcurrency < MIN_SOURCE_CONCURRENCY ||
      parsedSourceConcurrency > MAX_SOURCE_CONCURRENCY
    ) {
      showToast(
        `源抓取并发需为 ${MIN_SOURCE_CONCURRENCY}-${MAX_SOURCE_CONCURRENCY} 的整数。`,
        "error",
      );
      return;
    }

    if (
      !Number.isInteger(parsedFullTextFetchThreshold) ||
      parsedFullTextFetchThreshold < MIN_FULL_TEXT_FETCH_THRESHOLD ||
      parsedFullTextFetchThreshold > MAX_FULL_TEXT_FETCH_THRESHOLD
    ) {
      showToast(
        `正文补抓阈值需为 ${MIN_FULL_TEXT_FETCH_THRESHOLD}-${MAX_FULL_TEXT_FETCH_THRESHOLD} 的整数。`,
        "error",
      );
      return;
    }

    if (
      !Number.isInteger(parsedPerSourceItemLimit) ||
      parsedPerSourceItemLimit < MIN_PER_SOURCE_ITEM_LIMIT ||
      parsedPerSourceItemLimit > MAX_PER_SOURCE_ITEM_LIMIT
    ) {
      showToast(
        `每源处理上限需为 ${MIN_PER_SOURCE_ITEM_LIMIT}-${MAX_PER_SOURCE_ITEM_LIMIT} 的整数。`,
        "error",
      );
      return;
    }

    if (
      !Number.isInteger(parsedAggregationSplitMaxEvents) ||
      parsedAggregationSplitMaxEvents < MIN_AGGREGATION_SPLIT_MAX_EVENTS ||
      parsedAggregationSplitMaxEvents > MAX_AGGREGATION_SPLIT_MAX_EVENTS
    ) {
      showToast(
        `单条聚合拆分上限需为 ${MIN_AGGREGATION_SPLIT_MAX_EVENTS}-${MAX_AGGREGATION_SPLIT_MAX_EVENTS} 的整数。`,
        "error",
      );
      return;
    }

    startTransition(async () => {
      try {
        const schedule = await saveDefaultIngestionSchedule({
          enabled: taskScheduleEnabled,
          cronExpression: taskScheduleCronExpression,
          sourceConcurrency: parsedSourceConcurrency,
          fullTextFetchThreshold: parsedFullTextFetchThreshold,
          perSourceItemLimit: parsedPerSourceItemLimit,
          aggregationSplitMaxEvents: parsedAggregationSplitMaxEvents,
          processingStartAt: toIsoDateTimeOrNull(taskScheduleProcessingStartAt),
        });

        setTaskScheduleSnapshot(schedule);
        setTaskScheduleEnabled(schedule.enabled);
        setTaskScheduleCronExpression(schedule.cronExpression);
        setTaskScheduleSourceConcurrency(String(schedule.sourceConcurrency));
        setTaskScheduleFullTextFetchThreshold(String(schedule.fullTextFetchThreshold));
        setTaskSchedulePerSourceItemLimit(String(schedule.perSourceItemLimit));
        setTaskScheduleAggregationSplitMaxEvents(String(schedule.aggregationSplitMaxEvents));
        setTaskScheduleProcessingStartAt(toDateTimeLocalValue(schedule.processingStartAt));
        showToast("任务配置已保存。", "success");
      } catch (error) {
        showToast(error instanceof Error ? error.message : "任务配置保存失败。", "error");
      }
    });
  };

  const saveContentExtractionSettings = () => {
    const parsedTimeoutMs = Number.parseInt(contentExtractionTimeoutMs.trim(), 10);
    const parsedConcurrency = Number.parseInt(contentExtractionConcurrency.trim(), 10);
    const parsedRpmLimit = Number.parseInt(contentExtractionRpmLimit.trim(), 10);
    const parsedMaxPerRun = Number.parseInt(contentExtractionMaxPerRun.trim(), 10);
    const parsedMinChars = Number.parseInt(contentExtractionMinChars.trim(), 10);
    const parsedMaxChars = Number.parseInt(contentExtractionMaxChars.trim(), 10);

    if (!contentExtractionBaseUrl.trim()) {
      showToast("请填写 Jina Reader API 地址。", "error");
      return;
    }

    const numericFields: Array<[number, number, number, string]> = [
      [parsedTimeoutMs, 3_000, 60_000, "请求超时"],
      [parsedConcurrency, 1, 5, "Jina 并发"],
      [parsedRpmLimit, 1, 500, "每分钟调用上限"],
      [parsedMaxPerRun, 0, 200, "单次任务调用上限"],
      [parsedMinChars, 0, 10_000, "最小有效字符数"],
      [parsedMaxChars, 1_000, 100_000, "最大保留字符数"],
    ];

    for (const [value, min, max, label] of numericFields) {
      if (!Number.isInteger(value) || value < min || value > max) {
        showToast(`${label}需为 ${min}-${max} 的整数。`, "error");
        return;
      }
    }

    if (parsedMaxChars <= parsedMinChars) {
      showToast("最大保留字符数必须大于最小有效字符数。", "error");
      return;
    }

    startTransition(async () => {
      try {
        const normalizedApiKey = contentExtractionApiKey.trim();
        const jinaApiKeyMode = normalizedApiKey
          ? "replace"
          : contentExtractionApiKeyTouched
            ? "clear"
            : "keep";
        const config = await saveContentExtractionConfig({
          jinaEnabled: contentExtractionProvider === "jina",
          jinaBaseUrl: contentExtractionBaseUrl,
          jinaApiKey: normalizedApiKey,
          jinaApiKeyMode,
          timeoutMs: parsedTimeoutMs,
          concurrency: parsedConcurrency,
          rpmLimit: parsedRpmLimit,
          maxPerRun: parsedMaxPerRun,
          minChars: parsedMinChars,
          maxChars: parsedMaxChars,
        });

        setContentExtractionSnapshot(config);
        setContentExtractionProvider(config.jinaEnabled ? "jina" : "local");
        setContentExtractionBaseUrl(config.jinaBaseUrl);
        setContentExtractionApiKey("");
        setContentExtractionApiKeyTouched(false);
        setContentExtractionTimeoutMs(String(config.timeoutMs));
        setContentExtractionConcurrency(String(config.concurrency));
        setContentExtractionRpmLimit(String(config.rpmLimit));
        setContentExtractionMaxPerRun(String(config.maxPerRun));
        setContentExtractionMinChars(String(config.minChars));
        setContentExtractionMaxChars(String(config.maxChars));
        showToast("正文解析设置已保存。", "success");
      } catch (error) {
        showToast(error instanceof Error ? error.message : "正文解析设置保存失败。", "error");
      }
    });
  };

  const saveEventBriefingSettingsForm = () => {
    const parsedMinRankScore = Number.parseInt(eventBriefingMinRankScore.trim(), 10);
    const parsedMaxCuratorBoost = Number.parseInt(eventBriefingMaxCuratorBoost.trim(), 10);
    const parsedMaxCuratorPenalty = Number.parseInt(eventBriefingMaxCuratorPenalty.trim(), 10);
    const numericFields: Array<[number, number, number, string]> = [
      [parsedMinRankScore, 0, 100, "最低入选分"],
      [parsedMaxCuratorBoost, 0, 30, "主理人加权上限"],
      [parsedMaxCuratorPenalty, 0, 50, "主理人降权上限"],
    ];

    for (const [value, min, max, label] of numericFields) {
      if (!Number.isInteger(value) || value < min || value > max) {
        showToast(`${label}需为 ${min}-${max} 的整数。`, "error");
        return;
      }
    }

    startTransition(async () => {
      try {
        const saved = await saveEventBriefingSettings({
          config: {
            ...eventBriefingSnapshot.config,
            minRankScore: parsedMinRankScore,
          },
          preference: {
            ...eventBriefingSnapshot.preference,
            weightedRules: eventBriefingWeightedRules,
            maxCuratorBoost: parsedMaxCuratorBoost,
            maxCuratorPenalty: parsedMaxCuratorPenalty,
          },
        });

        setEventBriefingSnapshot(saved);
        setEventBriefingMinRankScore(String(saved.config.minRankScore));
        setEventBriefingWeightedRules(saved.preference.weightedRules);
        setEventBriefingMaxCuratorBoost(String(saved.preference.maxCuratorBoost));
        setEventBriefingMaxCuratorPenalty(String(saved.preference.maxCuratorPenalty));
        showToast("速览配置已保存。", "success");
      } catch (error) {
        showToast(error instanceof Error ? error.message : "速览配置保存失败。", "error");
      }
    });
  };

  const saveDailyReportSchedule = () => {
    const parsedDailyReportCandidateLimit = Number.parseInt(dailyReportCandidateLimit.trim(), 10);
    const parsedDailyReportOffsetDays = Number.parseInt(dailyReportOffsetDays.trim(), 10);
    const parsedDailyReportMaxRetries = Number.parseInt(dailyReportMaxRetries.trim(), 10);

    if (
      !Number.isInteger(parsedDailyReportCandidateLimit) ||
      parsedDailyReportCandidateLimit < MIN_DAILY_REPORT_CANDIDATE_LIMIT ||
      parsedDailyReportCandidateLimit > MAX_DAILY_REPORT_CANDIDATE_LIMIT
    ) {
      showToast(
        `日报候选上限需为 ${MIN_DAILY_REPORT_CANDIDATE_LIMIT}-${MAX_DAILY_REPORT_CANDIDATE_LIMIT} 的整数。`,
        "error",
      );
      return;
    }

    if (
      !Number.isInteger(parsedDailyReportOffsetDays) ||
      parsedDailyReportOffsetDays < MIN_DAILY_REPORT_OFFSET_DAYS ||
      parsedDailyReportOffsetDays > MAX_DAILY_REPORT_OFFSET_DAYS
    ) {
      showToast(
        `T- 天数需为 ${MIN_DAILY_REPORT_OFFSET_DAYS}-${MAX_DAILY_REPORT_OFFSET_DAYS} 的整数。`,
        "error",
      );
      return;
    }

    if (
      !Number.isInteger(parsedDailyReportMaxRetries) ||
      parsedDailyReportMaxRetries < MIN_DAILY_REPORT_MAX_RETRIES ||
      parsedDailyReportMaxRetries > MAX_DAILY_REPORT_MAX_RETRIES
    ) {
      showToast(
        `最大重试次数需为 ${MIN_DAILY_REPORT_MAX_RETRIES}-${MAX_DAILY_REPORT_MAX_RETRIES} 的整数。`,
        "error",
      );
      return;
    }

    startTransition(async () => {
      try {
        const schedule = await saveDefaultDailyReportSchedule({
          enabled: dailyReportScheduleEnabled,
          cronExpression: dailyReportScheduleCronExpression,
          dailyReportCandidateLimit: parsedDailyReportCandidateLimit,
          dailyReportOffsetDays: parsedDailyReportOffsetDays,
          dailyReportAutoPublish,
          dailyReportMaxRetries: parsedDailyReportMaxRetries,
          dailyReportGroupIds,
        });

        setDailyReportScheduleSnapshot(schedule);
        setDailyReportScheduleEnabled(schedule.enabled);
        setDailyReportScheduleCronExpression(schedule.cronExpression);
        setDailyReportCandidateLimit(String(schedule.dailyReportCandidateLimit));
        setDailyReportOffsetDays(String(schedule.dailyReportOffsetDays));
        setDailyReportAutoPublish(schedule.dailyReportAutoPublish);
        setDailyReportMaxRetries(String(schedule.dailyReportMaxRetries));
        setDailyReportGroupIds(schedule.dailyReportGroupIds ?? []);
        showToast("日报任务配置已保存。", "success");
      } catch (error) {
        showToast(error instanceof Error ? error.message : "日报任务配置保存失败。", "error");
      }
    });
  };
  const saveItemCleanupSchedule = () => {
    const parsedRetentionDays = Number.parseInt(cleanupScheduleRetentionDays.trim(), 10);

    if (
      !Number.isInteger(parsedRetentionDays) ||
      parsedRetentionDays < MIN_CLEANUP_RETENTION_DAYS ||
      parsedRetentionDays > MAX_CLEANUP_RETENTION_DAYS
    ) {
      showToast(
        `保留天数需为 ${MIN_CLEANUP_RETENTION_DAYS}-${MAX_CLEANUP_RETENTION_DAYS} 的整数。`,
        "error",
      );
      return;
    }

    startTransition(async () => {
      try {
        const schedule = await saveDefaultItemCleanupSchedule({
          enabled: cleanupScheduleEnabled,
          cronExpression: cleanupScheduleCronExpression,
          cleanupRetentionDays: parsedRetentionDays,
        });

        setCleanupScheduleSnapshot(schedule);
        setCleanupScheduleEnabled(schedule.enabled);
        setCleanupScheduleCronExpression(schedule.cronExpression);
        setCleanupScheduleRetentionDays(String(schedule.cleanupRetentionDays));
        showToast("清理任务配置已保存。", "success");
      } catch (error) {
        showToast(error instanceof Error ? error.message : "清理任务配置保存失败。", "error");
      }
    });
  };
  const taskScheduleIsDirty =
    taskScheduleEnabled !== taskScheduleSnapshot.enabled ||
    taskScheduleCronExpression.trim() !== taskScheduleSnapshot.cronExpression ||
    taskScheduleSourceConcurrency.trim() !== String(taskScheduleSnapshot.sourceConcurrency) ||
    taskScheduleFullTextFetchThreshold.trim() !== String(taskScheduleSnapshot.fullTextFetchThreshold) ||
    taskSchedulePerSourceItemLimit.trim() !== String(taskScheduleSnapshot.perSourceItemLimit) ||
    taskScheduleAggregationSplitMaxEvents.trim() !== String(taskScheduleSnapshot.aggregationSplitMaxEvents) ||
    taskScheduleProcessingStartAt.trim() !== toDateTimeLocalValue(taskScheduleSnapshot.processingStartAt);
  const contentExtractionIsDirty =
    (contentExtractionProvider === "jina") !== contentExtractionSnapshot.jinaEnabled ||
    contentExtractionBaseUrl.trim() !== contentExtractionSnapshot.jinaBaseUrl ||
    contentExtractionApiKeyTouched ||
    contentExtractionApiKey.trim().length > 0 ||
    contentExtractionTimeoutMs.trim() !== String(contentExtractionSnapshot.timeoutMs) ||
    contentExtractionConcurrency.trim() !== String(contentExtractionSnapshot.concurrency) ||
    contentExtractionRpmLimit.trim() !== String(contentExtractionSnapshot.rpmLimit) ||
    contentExtractionMaxPerRun.trim() !== String(contentExtractionSnapshot.maxPerRun) ||
    contentExtractionMinChars.trim() !== String(contentExtractionSnapshot.minChars) ||
    contentExtractionMaxChars.trim() !== String(contentExtractionSnapshot.maxChars);
  const eventBriefingIsDirty =
    eventBriefingMinRankScore.trim() !== String(eventBriefingSnapshot.config.minRankScore) ||
    !areWeightRulesEqual(eventBriefingWeightedRules, eventBriefingSnapshot.preference.weightedRules) ||
    eventBriefingMaxCuratorBoost.trim() !== String(eventBriefingSnapshot.preference.maxCuratorBoost) ||
    eventBriefingMaxCuratorPenalty.trim() !== String(eventBriefingSnapshot.preference.maxCuratorPenalty);
  const dailyReportScheduleIsDirty =
    dailyReportScheduleEnabled !== dailyReportScheduleSnapshot.enabled ||
    dailyReportScheduleCronExpression.trim() !== dailyReportScheduleSnapshot.cronExpression ||
    dailyReportCandidateLimit.trim() !== String(dailyReportScheduleSnapshot.dailyReportCandidateLimit) ||
    dailyReportOffsetDays.trim() !== String(dailyReportScheduleSnapshot.dailyReportOffsetDays) ||
    dailyReportMaxRetries.trim() !== String(dailyReportScheduleSnapshot.dailyReportMaxRetries) ||
    dailyReportAutoPublish !== dailyReportScheduleSnapshot.dailyReportAutoPublish ||
    !areStringArraysEqual(dailyReportGroupIds, dailyReportScheduleSnapshot.dailyReportGroupIds ?? []);
  const cleanupScheduleIsDirty =
    cleanupScheduleEnabled !== cleanupScheduleSnapshot.enabled ||
    cleanupScheduleCronExpression.trim() !== cleanupScheduleSnapshot.cronExpression ||
    cleanupScheduleRetentionDays.trim() !== String(cleanupScheduleSnapshot.cleanupRetentionDays);

  const content = (
    <section aria-label="后台设置工作台" className="space-y-4">
      <section
        aria-labelledby={`settings-tab-${activeSection}`}
        className="space-y-4"
        id={`settings-panel-${activeSection}`}
        role="tabpanel"
      >
        {activeSection === "ai-model-api" ? (
          <AiSettingsPanel initialSettings={initialSettings} mode="model-api" />
        ) : null}

        {activeSection === "ai-prompt" ? (
          <AiSettingsPanel initialSettings={initialSettings} mode="prompt" initialPromptType={initialPromptType} />
        ) : null}

        {activeSection === "tags" ? (
          <TagSettingsPanel initialOpenSuggestions={initialOpenTagSuggestions} />
        ) : null}

        {activeSection === "blacklist" ? (
          <div
            aria-labelledby="settings-blacklist"
            className="w-full min-w-0"
          >
            <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <h2
                  className="text-lg font-semibold text-[var(--text-1)]"
                  id="settings-blacklist"
                >
                  黑名单
                </h2>
                <p className="text-sm text-[var(--text-3)]">
                  配置关键词黑名单过滤规则
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="primary"
                  size="md"
                  onClick={() =>
                    submitJson(
                      "/api/admin/settings/blacklist",
                      "PUT",
                      {
                        keywords: normalizedBlacklistKeywords,
                      },
                      "黑名单已保存。",
                    )
                  }
                  disabled={isPending}
                >
                  保存配置
                </Button>
              </div>
            </div>

            <section aria-label="黑名单关键词编辑区">
              <div className="flex items-center gap-2 mb-1">
                <label
                  className="block text-sm text-[var(--text-2)]"
                  htmlFor="blacklist-keywords-textarea"
                >
                  关键词列表
                </label>
                <div className="relative group">
                  <span className="inline-flex h-5 w-5 cursor-default items-center justify-center rounded-full border border-[color:var(--line)] text-xs text-[var(--text-3)]">
                    ?
                  </span>
                  <div className="pointer-events-none absolute left-1/2 top-full z-10 mt-2 -translate-x-1/2 whitespace-nowrap rounded-sm border border-[color:var(--line)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text-2)] shadow-[0_1px_3px_rgba(0,0,0,0.06)] opacity-0 transition group-hover:opacity-100">
                    支持换行分隔，保存时自动去掉空行与首尾空格
                  </div>
                </div>
              </div>

              <TextArea
                id="blacklist-keywords-textarea"
                className="min-h-[112px]"
                rows={4}
                placeholder="每行一个黑名单关键词"
                value={blacklistText}
                onChange={(event) => setBlacklistText(event.target.value)}
              />
            </section>
          </div>
        ) : null}

        {activeSection === "event-briefing" ? (
          <div
            className={cx(
              "w-full min-w-0",
              embedMode
                ? ""
                : "rounded-sm border border-[color:var(--line)] bg-[var(--surface)] p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]",
            )}
          >
            <div className="space-y-5">
              <div className="flex flex-col gap-3 border-b border-[color:var(--line)] pb-5 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 space-y-1">
                  <h2 className="text-lg font-semibold text-[var(--text-1)]">
                    速览配置
                  </h2>
                  <p className="text-sm text-[var(--text-3)]">
                    配置速览的展示规则和事件偏好。
                  </p>
                </div>
                <Button
                  variant="primary"
                  size="md"
                  className="w-full sm:w-auto"
                  onClick={saveEventBriefingSettingsForm}
                  disabled={isPending || !eventBriefingIsDirty}
                >
                  保存配置
                </Button>
              </div>

              <section className="space-y-4" aria-labelledby="event-briefing-display-settings">
                <h3 id="event-briefing-display-settings" className="text-sm font-semibold text-[var(--text-1)]">
                  展示规则
                </h3>
                <div className="grid grid-cols-1 items-end gap-4 lg:grid-cols-2">
                  <FormField label="最低入选分" htmlFor="event-briefing-min-score">
                    <TextInput
                      id="event-briefing-min-score"
                      className="h-10"
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={100}
                      step={1}
                      value={eventBriefingMinRankScore}
                      onChange={(event) => setEventBriefingMinRankScore(event.target.value)}
                    />
                  </FormField>
                </div>
              </section>

              <section className="space-y-4 border-t border-[color:var(--line)] pt-5" aria-labelledby="event-briefing-preference-settings">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <h3 id="event-briefing-preference-settings" className="text-sm font-semibold text-[var(--text-1)]">
                    事件偏好
                  </h3>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={openBriefingPreferenceSuggestionModal}
                    >
                      偏好建议
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={openEventBriefingRuleModal}
                    >
                      新增规则
                    </Button>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  <FormField label="加权上限" htmlFor="event-briefing-max-boost">
                    <TextInput
                      id="event-briefing-max-boost"
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={30}
                      step={1}
                      value={eventBriefingMaxCuratorBoost}
                      onChange={(event) => setEventBriefingMaxCuratorBoost(event.target.value)}
                    />
                  </FormField>
                  <FormField label="降权上限" htmlFor="event-briefing-max-penalty">
                    <TextInput
                      id="event-briefing-max-penalty"
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={50}
                      step={1}
                      value={eventBriefingMaxCuratorPenalty}
                      onChange={(event) => setEventBriefingMaxCuratorPenalty(event.target.value)}
                    />
                  </FormField>
                </div>

                <div className="overflow-x-auto rounded-sm border border-[color:var(--line)]">
                  {eventBriefingWeightedRules.length > 0 ? (
                    <table className="w-full min-w-[42rem] table-fixed text-sm">
                      <colgroup>
                        <col className="w-[8rem]" />
                        <col />
                        <col className="w-[8rem]" />
                        <col className="w-[5rem]" />
                      </colgroup>
                      <thead className="bg-[var(--bg-muted)] text-[var(--muted)]">
                        <tr>
                          <th className="px-3 py-2 text-left">类型</th>
                          <th className="px-3 py-2 text-left">内容</th>
                          <th className="px-3 py-2 text-right">权重</th>
                          <th className="px-3 py-2 text-right">操作</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[color:var(--line)]">
                        {eventBriefingWeightedRules.map((rule, index) => (
                          <tr key={`${rule.type}:${rule.value}:${rule.weight}:${index}`} className="bg-[var(--surface)]">
                            <td className="px-3 py-2 text-[var(--text-2)]">
                              {eventBriefingRuleTypeLabels[rule.type]}
                            </td>
                            <td className="px-3 py-2 font-medium text-[var(--text-1)]">
                              {getEventBriefingRuleLabel(rule)}
                            </td>
                            <td className={cx(
                              "px-3 py-2 text-right font-mono text-sm",
                              rule.weight > 0 ? "text-[var(--accent)]" : "text-[var(--danger-ink)]",
                            )}>
                              {rule.weight > 0 ? `+${rule.weight}` : rule.weight}
                            </td>
                            <td className="px-3 py-2 text-right">
                              <IconButton
                                variant="secondary"
                                size="sm"
                                title="删除规则"
                                className="text-[var(--danger-ink)] hover:bg-[var(--danger-surface)] hover:text-[var(--danger-ink)]"
                                onClick={() => removeEventBriefingWeightRule(index)}
                              >
                                <IconTrash className="h-4 w-4" />
                              </IconButton>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div className="bg-[var(--surface)] px-4 py-8 text-center text-sm text-[var(--text-3)]">
                      暂无加权规则。
                    </div>
                  )}
                </div>

              </section>

              <BriefingPreferenceSuggestionModal
                suggestions={pagedBriefingPreferenceSuggestions}
                totalCount={briefingPreferenceSuggestionTotalCount}
                page={safeBriefingPreferenceSuggestionPage}
                pageSize={briefingPreferenceSuggestionPageSize}
                search={briefingPreferenceSuggestionSearch}
                sort={briefingPreferenceSuggestionSort}
                isOpen={briefingPreferenceSuggestionModalOpen}
                isBusy={isPending}
                onClose={() => setBriefingPreferenceSuggestionModalOpen(false)}
                onSearchChange={(value) => {
                  setBriefingPreferenceSuggestionSearch(value);
                  setBriefingPreferenceSuggestionPage(1);
                }}
                onSortChange={(value) => {
                  setBriefingPreferenceSuggestionSort(value);
                  setBriefingPreferenceSuggestionPage(1);
                }}
                onPageChange={setBriefingPreferenceSuggestionPage}
                onPageSizeChange={(nextPageSize) => {
                  setBriefingPreferenceSuggestionPageSize(nextPageSize);
                  setBriefingPreferenceSuggestionPage(1);
                }}
                onAccept={setBriefingPreferenceAcceptTarget}
                onDismiss={setBriefingPreferenceDismissTarget}
                onRefresh={refreshBriefingPreferenceSuggestions}
              />

              <ModalShell
                isOpen={Boolean(briefingPreferenceAcceptTarget)}
                onClose={() => setBriefingPreferenceAcceptTarget(null)}
                title="接受偏好建议"
                widthClassName="max-w-md"
                bodyClassName="space-y-3 p-6"
                footerClassName="border-t border-[color:var(--line)] bg-[var(--bg-muted)] p-4"
                footer={
                  <div className="flex justify-end gap-3">
                    <Button
                      variant="secondary"
                      onClick={() => setBriefingPreferenceAcceptTarget(null)}
                      disabled={isPending}
                    >
                      取消
                    </Button>
                    <Button
                      variant="primary"
                      onClick={() => {
                        if (!briefingPreferenceAcceptTarget) {
                          return;
                        }

                        const target = briefingPreferenceAcceptTarget;
                        setBriefingPreferenceAcceptTarget(null);
                        acceptBriefingPreferenceSuggestionItem(target);
                      }}
                      disabled={isPending}
                    >
                      接受
                    </Button>
                  </div>
                }
              >
                <p className="text-sm leading-6 text-[var(--text-2)]">
                  接受后会写入事件偏好规则，并影响后续事件速览排序。
                </p>
                <div className="rounded-sm border border-[color:var(--line)] bg-[var(--bg-muted)] px-3 py-2 text-sm text-[var(--text-1)]">
                  {briefingPreferenceAcceptTarget
                    ? `${eventBriefingRuleTypeLabels[briefingPreferenceAcceptTarget.ruleType]}：${briefingPreferenceAcceptTarget.label ?? briefingPreferenceAcceptTarget.value} ${formatSignedWeight(briefingPreferenceAcceptTarget.suggestedWeight)}`
                    : ""}
                </div>
              </ModalShell>

              <ModalShell
                isOpen={Boolean(briefingPreferenceDismissTarget)}
                onClose={() => setBriefingPreferenceDismissTarget(null)}
                title="忽略偏好建议"
                widthClassName="max-w-md"
                bodyClassName="space-y-3 p-6"
                footerClassName="border-t border-[color:var(--line)] bg-[var(--bg-muted)] p-4"
                footer={
                  <div className="flex justify-end gap-3">
                    <Button
                      variant="secondary"
                      onClick={() => setBriefingPreferenceDismissTarget(null)}
                      disabled={isPending}
                    >
                      取消
                    </Button>
                    <Button
                      variant="primary"
                      onClick={() => {
                        if (!briefingPreferenceDismissTarget) {
                          return;
                        }

                        const target = briefingPreferenceDismissTarget;
                        setBriefingPreferenceDismissTarget(null);
                        dismissBriefingPreferenceSuggestionItem(target);
                      }}
                      disabled={isPending}
                    >
                      忽略
                    </Button>
                  </div>
                }
              >
                <p className="text-sm leading-6 text-[var(--text-2)]">
                  忽略后这条建议会从待处理列表中移除，不会写入事件偏好规则。
                </p>
                <div className="rounded-sm border border-[color:var(--line)] bg-[var(--bg-muted)] px-3 py-2 text-sm text-[var(--text-1)]">
                  {briefingPreferenceDismissTarget
                    ? `${eventBriefingRuleTypeLabels[briefingPreferenceDismissTarget.ruleType]}：${briefingPreferenceDismissTarget.label ?? briefingPreferenceDismissTarget.value}`
                    : ""}
                </div>
              </ModalShell>

              <ModalShell
                isOpen={eventBriefingRuleModalOpen}
                onClose={() => setEventBriefingRuleModalOpen(false)}
                title="新增加权规则"
                widthClassName="max-w-lg"
                bodyClassName="space-y-4 p-6"
                footerClassName="border-t border-[color:var(--line)] bg-[var(--bg-muted)] p-6"
                footer={
                  <div className="flex justify-end gap-2">
                    <Button variant="secondary" onClick={() => setEventBriefingRuleModalOpen(false)}>
                      取消
                    </Button>
                    <Button variant="primary" onClick={addEventBriefingWeightRule}>
                      添加
                    </Button>
                  </div>
                }
              >
                <FormField label="类型" htmlFor="event-briefing-rule-type">
                  <SelectField
                    id="event-briefing-rule-type"
                    aria-label="类型"
                    value={eventBriefingRuleDraft.type}
                    options={eventBriefingRuleTypeOptions}
                    showSearch={false}
                    onChange={(value) => setEventBriefingRuleDraft({
                      type: (value as AdminBriefingWeightRuleType) || "tag",
                      value: "",
                      weight: eventBriefingRuleDraft.weight,
                    })}
                  />
                </FormField>
                {eventBriefingRuleDraft.type === "keyword" ? (
                  <FormField label="内容" htmlFor="event-briefing-rule-keyword">
                    <TextInput
                      id="event-briefing-rule-keyword"
                      value={eventBriefingRuleDraft.value}
                      placeholder="OpenAI"
                      onChange={(event) => setEventBriefingRuleDraft((current) => ({
                        ...current,
                        value: event.target.value,
                      }))}
                    />
                  </FormField>
                ) : (
                  <FormField label="内容" htmlFor="event-briefing-rule-value">
                    <SelectField
                      id="event-briefing-rule-value"
                      aria-label="内容"
                      value={eventBriefingRuleDraft.value}
                      options={getEventBriefingRuleOptions(eventBriefingRuleDraft.type)}
                      placeholder={
                        eventBriefingRuleDraft.type === "tag" && !eventBriefingTagsLoaded
                          ? "加载标签中"
                          : "选择一项"
                      }
                      onChange={(value) => setEventBriefingRuleDraft((current) => ({
                        ...current,
                        value: String(value ?? ""),
                      }))}
                    />
                  </FormField>
                )}
                <FormField label="权重" htmlFor="event-briefing-rule-weight">
                  <TextInput
                    id="event-briefing-rule-weight"
                    type="number"
                    inputMode="numeric"
                    min={-50}
                    max={30}
                    step={1}
                    value={eventBriefingRuleDraft.weight}
                    onChange={(event) => setEventBriefingRuleDraft((current) => ({
                      ...current,
                      weight: event.target.value,
                    }))}
                  />
                </FormField>
              </ModalShell>
            </div>
          </div>
        ) : null}

        {activeSection === "groups" ? (
          <div
            className={cx(
              "w-full min-w-0",
              embedMode
                ? ""
                : "rounded-sm border border-[color:var(--line)] bg-[var(--surface)] p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]",
            )}
          >
            <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <h2 className="text-lg font-semibold text-[var(--text-1)]" id="settings-groups">
                  分组列表
                </h2>
                <p className="text-sm text-[var(--text-3)]">
                  用于对信息源进行分类管理，方便后续筛选。
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="primary"
                  size="md"
                  onClick={() => setShowCreateGroupComposer((current) => !current)}
                >
                  + 新增分组
                </Button>
              </div>
            </div>

            {showCreateGroupComposer ? (
              <div className="mb-4 rounded-lg border border-[color:var(--line)] bg-[var(--surface)] px-3 py-3 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded bg-[var(--accent)] text-sm font-bold text-white">
                      <IconPlus className="h-4 w-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-[var(--text-1)]">新增分组</div>
                      <div className="text-xs text-[var(--text-2)]">创建后可直接用于信息源归类。</div>
                    </div>
                  </div>

                  <div className="flex flex-1 flex-col gap-3 sm:max-w-xl sm:flex-row sm:items-center sm:justify-end">
                    <TextInput
                      className="sm:flex-1"
                      placeholder="新分组名称"
                      value={newGroupName}
                      onChange={(event) => setNewGroupName(event.target.value)}
                    />
                    <div className="flex gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          setShowCreateGroupComposer(false);
                          setNewGroupName("");
                        }}
                      >
                        取消
                      </Button>
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() =>
                          submitJson(
                            "/api/admin/settings/groups",
                            "POST",
                            { name: newGroupName },
                            "分组已创建。",
                            true,
                          )
                        }
                        disabled={isPending || !newGroupName.trim()}
                      >
                        创建
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            {orderedGroups.length ? (
              <DndContext sensors={groupSortSensors} collisionDetection={closestCenter} onDragEnd={handleGroupDragEnd}>
                <SortableContext items={orderedGroups.map((group) => group.id)} strategy={verticalListSortingStrategy}>
                  <div className="space-y-3">
                    {orderedGroups.map((group) => (
                      <GroupRow
                        key={group.id}
                        group={group}
                        submitJson={submitJson}
                        onOpenSourceLink={openSourceGroupLinkModal}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            ) : (
              <EmptyState
                className="text-[var(--text-3)]"
                action={
                  <Button variant="primary" size="md" onClick={() => setShowCreateGroupComposer(true)}>
                    新增分组
                  </Button>
                }
              >
                暂无分组
              </EmptyState>
            )}

            <ModalShell
              isOpen={Boolean(sourceGroupLinkTarget)}
              onClose={() => {
                setSourceGroupLinkTarget(null);
                setSourceGroupLinkSearch("");
              }}
              title={sourceGroupLinkTarget ? `关联信息源：${sourceGroupLinkTarget.name}` : "关联信息源"}
              widthClassName="max-w-2xl"
              bodyClassName="space-y-4 p-6"
              footerClassName="border-t border-[color:var(--line)] bg-[var(--bg-muted)] p-6"
              footer={
                <div className="flex justify-end">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setSourceGroupLinkTarget(null);
                      setSourceGroupLinkSearch("");
                    }}
                  >
                    关闭
                  </Button>
                </div>
              }
            >
              <TextInput
                aria-label="搜索信息源"
                placeholder="搜索信息源名称、RSS、站点或当前分组"
                value={sourceGroupLinkSearch}
                onChange={(event) => setSourceGroupLinkSearch(event.target.value)}
              />

              <div className="max-h-96 space-y-2 overflow-y-auto rounded-sm border border-[color:var(--line)] p-2">
                {groupLinkSourceList.length ? (
                  groupLinkSourceList.map((source) => {
                    const displaySource = {
                      ...source,
                      ...(sourceGroupOverrides[source.id] ?? {}),
                    };
                    const isLinked = displaySource.groupId === sourceGroupLinkTarget?.id;

                    return (
                      <div
                        key={displaySource.id}
                        className="flex flex-col gap-3 rounded-sm border border-[color:var(--line)] bg-[var(--surface)] px-3 py-3 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-[var(--text-1)]">{displaySource.name}</div>
                          <div className="mt-1 truncate text-xs text-[var(--text-3)]">{displaySource.rssUrl}</div>
                          <div className="mt-1 text-xs text-[var(--text-2)]">
                            当前分组：{displaySource.groupName ?? "未分组"}
                          </div>
                        </div>
                        <Button
                          variant={isLinked ? "secondary" : "primary"}
                          size="sm"
                          disabled={isPending}
                          onClick={() => openSourceGroupAssociationConfirm(displaySource, isLinked ? null : sourceGroupLinkTarget?.id ?? null)}
                        >
                          {isLinked ? "取消关联" : `关联到 ${sourceGroupLinkTarget?.name ?? ""}`}
                        </Button>
                      </div>
                    );
                  })
                ) : (
                  <div className="px-3 py-8 text-center text-sm text-[var(--text-3)]">没有匹配的信息源。</div>
                )}
              </div>
            </ModalShell>

            <ModalShell
              isOpen={Boolean(sourceGroupAssociationConfirm)}
              onClose={() => setSourceGroupAssociationConfirm(null)}
              title={sourceGroupAssociationConfirm?.nextGroupId === null ? "确认取消关联" : "确认关联信息源"}
              widthClassName="max-w-md"
              bodyClassName="space-y-3 p-6"
              footerClassName="border-t border-[color:var(--line)] bg-[var(--bg-muted)] p-6"
              footer={
                <div className="flex justify-end gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => setSourceGroupAssociationConfirm(null)}
                    disabled={isPending}
                  >
                    取消
                  </Button>
                  <Button
                    variant="primary"
                    onClick={confirmSourceGroupAssociation}
                    disabled={isPending}
                  >
                    确认
                  </Button>
                </div>
              }
            >
              <p className="text-sm leading-6 text-[var(--text-2)]">
                {sourceGroupAssociationConfirm?.nextGroupId === null
                  ? `确认取消「${sourceGroupAssociationConfirm?.source.name ?? ""}」与「${sourceGroupAssociationConfirm?.group.name ?? ""}」的分组关联？`
                  : `确认将「${sourceGroupAssociationConfirm?.source.name ?? ""}」关联到「${sourceGroupAssociationConfirm?.group.name ?? ""}」？`}
              </p>
            </ModalShell>
          </div>
        ) : null}

        {activeSection === "header-links" ? (
          <div
            className={cx(
              "w-full min-w-0",
              embedMode
                ? ""
                : "rounded-sm border border-[color:var(--line)] bg-[var(--surface)] p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]",
            )}
          >
            <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <h2 className="text-lg font-semibold text-[var(--text-1)]" id="settings-header-links">
                  导航栏配置
                </h2>
                <p className="text-sm text-[var(--text-3)]">
                  维护显示在站点 header 主导航中的外部链接。
                </p>
              </div>
              <Button
                variant="primary"
                size="md"
                onClick={openCreateHeaderLinkForm}
              >
                + 新增链接
              </Button>
            </div>

            {headerLinkFormMode ? (
              <div className="mb-4 rounded-lg border border-[color:var(--line)] bg-[var(--surface)] px-3 py-3 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
                <div className="grid gap-3 lg:grid-cols-[120px_minmax(220px,1fr)_180px] lg:items-end">
                  <FormField label="名称" htmlFor="header-link-label">
                    <TextInput
                      id="header-link-label"
                      placeholder="AFF"
                      value={headerLinkForm.label}
                      onChange={(event) =>
                        setHeaderLinkForm((current) => ({ ...current, label: event.target.value }))
                      }
                    />
                  </FormField>
                  <FormField label="URL" htmlFor="header-link-url">
                    <TextInput
                      id="header-link-url"
                      placeholder="https://shawnxie.top/aff/"
                      value={headerLinkForm.url}
                      onChange={(event) =>
                        setHeaderLinkForm((current) => ({ ...current, url: event.target.value }))
                      }
                    />
                  </FormField>
                  <FormField
                    label="链接类型"
                    htmlFor="header-link-rel"
                  >
                    <SelectField
                      id="header-link-rel"
                      options={headerLinkRelOptions}
                      value={headerLinkForm.rel}
                      showSearch={false}
                      onChange={(value) =>
                        setHeaderLinkForm((current) => ({
                          ...current,
                          rel: typeof value === "string" ? value : HEADER_LINK_REL_DEFAULT,
                        }))
                      }
                    />
                  </FormField>
                </div>

                <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex flex-wrap items-center gap-4">
                    <label className="inline-flex items-center gap-2 text-sm text-[var(--text-2)]">
                      <input
                        type="checkbox"
                        className={checkboxInputClassName}
                        checked={headerLinkForm.enabled}
                        onChange={(event) =>
                          setHeaderLinkForm((current) => ({ ...current, enabled: event.target.checked }))
                        }
                      />
                      启用
                    </label>
                    <label className="inline-flex items-center gap-2 text-sm text-[var(--text-2)]">
                      <input
                        type="checkbox"
                        className={checkboxInputClassName}
                        checked={headerLinkForm.openInNewTab}
                        onChange={(event) =>
                          setHeaderLinkForm((current) => ({ ...current, openInNewTab: event.target.checked }))
                        }
                      />
                      新窗口打开
                    </label>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={closeHeaderLinkForm}
                      disabled={isPending}
                    >
                      取消
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={saveHeaderLinkForm}
                      disabled={isPending}
                    >
                      保存
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}

            {headerLinks.length ? (
              <DndContext sensors={groupSortSensors} collisionDetection={closestCenter} onDragEnd={handleHeaderLinkDragEnd}>
                <SortableContext items={headerLinks.map((link) => link.id)} strategy={verticalListSortingStrategy}>
                  <div className="space-y-3">
                    {headerLinks.map((link) => (
                      <HeaderLinkRow
                        key={link.id}
                        link={link}
                        onEdit={openEditHeaderLinkForm}
                        onDelete={setHeaderLinkDeleteTarget}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            ) : (
              <EmptyState
                className="text-[var(--text-3)]"
                action={
                  <Button variant="primary" size="md" onClick={openCreateHeaderLinkForm}>
                    新增链接
                  </Button>
                }
              >
                暂无导航栏配置
              </EmptyState>
            )}

            <ModalShell
              isOpen={Boolean(headerLinkDeleteTarget)}
              onClose={() => setHeaderLinkDeleteTarget(null)}
              title="删除导航栏配置"
              widthClassName="max-w-md"
              bodyClassName="space-y-3 p-6"
              footerClassName="border-t border-[color:var(--line)] bg-[var(--bg-muted)] p-6"
              footer={
                <div className="flex justify-end gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => setHeaderLinkDeleteTarget(null)}
                    disabled={isPending}
                  >
                    取消
                  </Button>
                  <Button
                    variant="danger"
                    onClick={confirmDeleteHeaderLink}
                    disabled={isPending}
                  >
                    删除
                  </Button>
                </div>
              }
            >
              <p className="text-sm leading-6 text-[var(--text-2)]">
                确认删除「{headerLinkDeleteTarget?.label ?? ""}」？删除后 header 将不再显示该链接。
              </p>
            </ModalShell>
          </div>
        ) : null}

        {activeSection === "sources" ? (
          <div className="space-y-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <h2 className="text-lg font-semibold text-[var(--foreground)]">
                  信息源管理
                </h2>
                <p className="text-sm text-[var(--muted)]">
                  集中维护 RSS 信息源。
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={opmlFileInputRef}
                  aria-label="OPML 文件"
                  accept=".opml,.xml,text/xml,application/xml"
                  type="file"
                  className="sr-only"
                  onChange={(event) => importOpml(event.target.files?.[0] ?? null)}
                />
                <Button
                  variant="secondary"
                  size="md"
                  onClick={() => opmlFileInputRef.current?.click()}
                  disabled={isPending}
                >
                  导入 OPML
                </Button>
                <Button
                  variant="secondary"
                  size="md"
                  onClick={exportOpml}
                  disabled={sourceTotal === 0}
                >
                  导出 OPML
                </Button>
                <Button variant="primary" size="md" onClick={openCreateSourceModal}>
                  新建信息源
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <FilterInput
                id="source-filter-name"
                label="RSS源名称"
                ariaLabel="RSS源名称"
                value={sourceNameFilter}
                placeholder="按名称或 RSS URL 搜索"
                onChange={(value) => {
                  setSourceNameFilter(value);
                  setSourcePage(1);
                  updateSourceFilterUrl({ name: value, page: 1 });
                }}
              />
              <FilterSelect
                id="source-filter-group"
                label="分组"
                ariaLabel="分组"
                value={sourceGroupFilter}
                onChange={(value) => {
                  setSourceGroupFilter(value);
                  setSourcePage(1);
                  updateSourceFilterUrl({ group: value, page: 1 });
                }}
                showSearch={false}
                options={[
                  { value: "", label: "全部分组" },
                  { value: "__ungrouped__", label: "未分组" },
                  ...orderedGroups.map((group) => ({
                    value: group.id,
                    label: group.name,
                  })),
                ]}
              />
              <FilterSelect
                id="source-filter-enabled"
                label="是否启用"
                ariaLabel="是否启用"
                value={sourceEnabledFilter}
                onChange={(value) => {
                  const normalized = normalizeSourceEnabledFilter(value);
                  setSourceEnabledFilter(normalized);
                  setSourcePage(1);
                  updateSourceFilterUrl({ enabled: normalized, page: 1 });
                }}
                showSearch={false}
                options={[
                  { value: "", label: "全部" },
                  { value: "true", label: "已启用" },
                  { value: "false", label: "已停用" },
                ]}
              />
            </div>

            {paginatedSourceList.length === 0 ? (
              <EmptyState>
                {sourceTotal > 0
                  ? "暂无匹配信息源"
                  : "暂无信息源"}
              </EmptyState>
            ) : (
              <div className="w-full overflow-x-auto">
                <table className="w-full min-w-[56rem] table-fixed text-sm">
                  <colgroup>
                    <col className="w-[24%]" />
                    <col className="w-[8rem]" />
                    <col className="w-[11rem]" />
                    <col className="w-[7.5rem]" />
                    <col />
                    <col className="w-[5.5rem]" />
                  </colgroup>
                  <thead className="bg-[var(--bg-muted)] text-[var(--muted)]">
                    <tr>
                      <th className="whitespace-nowrap px-4 py-3 text-left">RSS 源名称</th>
                      <th className="whitespace-nowrap px-4 py-3 text-left">分组</th>
                      <th className="whitespace-nowrap px-4 py-3 text-left">状态</th>
                      <th className="whitespace-nowrap px-4 py-3 text-left">最近更新</th>
                      <th className="px-4 py-3 text-left">站点信息</th>
                      <th className="whitespace-nowrap px-4 py-3 text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[color:var(--line)]">
                    {paginatedSourceList.map((source) => (
                      <tr
                        key={source.id}
                        className="transition-colors hover:bg-[var(--bg-muted)]"
                      >
                        <td className="px-4 py-3">
                          <div className="font-medium text-[var(--foreground)]">
                            {source.name}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-[var(--text-2)]">
                          {source.groupName ?? "未分组"}
                        </td>
                        <td className="px-4 py-3 text-[var(--text-2)]">
                          <div>{source.enabled ? "已启用" : "已停用"}</div>
                          <div className="mt-1 whitespace-nowrap text-xs text-[var(--text-3)]">
                            {source.aiParsingEnabled !== false ? "AI解析" : "仅RSS"}
                            {" · "}
                            {source.aggregationEnabled !== false ? "参与聚合" : "不聚合"}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-xs text-[var(--text-3)]">
                          {formatSourceUpdateTime(source.lastItemCreatedAt)}
                        </td>
                        <td className="px-4 py-3 text-xs text-[var(--text-3)]">
                          <div className="max-w-[18rem] truncate" title={source.siteUrl}>
                            {(() => {
                              try {
                                const parsed = new URL(source.siteUrl);
                                if (parsed.protocol === "http:" || parsed.protocol === "https:") {
                                  return (
                                    <button
                                      type="button"
                                      onClick={() => window.open(source.siteUrl, "_blank", "noopener,noreferrer")}
                                      className="hover:text-[var(--accent)] hover:underline cursor-pointer"
                                    >
                                      {source.siteUrl}
                                    </button>
                                  );
                                }
                              } catch { /* invalid URL — render as plain text */ }
                              return <span>{source.siteUrl}</span>;
                            })()}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-1">
                            <IconButton
                              variant="secondary"
                              size="sm"
                              title="编辑"
                              onClick={() => openEditSourceModal(source)}
                            >
                              <IconEdit className="h-4 w-4" />
                            </IconButton>
                            <IconButton
                              variant="secondary"
                              size="sm"
                              title="删除"
                              className="text-[var(--danger-ink)] hover:bg-[var(--danger-surface)] hover:text-[var(--danger-ink)]"
                              onClick={() => setSourceDeleteTarget(source)}
                            >
                              <IconTrash className="h-4 w-4" />
                            </IconButton>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {sourceTotal > 0 ? (
              <PaginationControls
                totalItems={sourceTotal}
                page={safeSourcePage}
                totalPages={sourceTotalPages}
                pageSize={sourcePageSize}
                onPageChange={(nextPage) => {
                  setSourcePage(nextPage);
                  updateSourceFilterUrl({ page: nextPage });
                }}
                onPageSizeChange={handleSourcePageSizeChange}
              />
            ) : null}

            <ModalShell
              isOpen={Boolean(sourceModalMode)}
              onClose={() => {
                setSourceModalMode(null);
                setEditingSourceId(null);
              }}
              title={sourceModalMode === "edit" ? "编辑信息源" : "新建信息源"}
              widthClassName="max-w-2xl"
              headerClassName="border-b border-[color:var(--line)] p-6"
              bodyClassName="space-y-4 p-6"
              footerClassName="border-t border-[color:var(--line)] bg-[var(--bg-muted)] p-6"
              footer={
                <div className="flex justify-end gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setSourceModalMode(null);
                      setEditingSourceId(null);
                    }}
                  >
                    取消
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={resolveSourceFromRss}
                    disabled={isPending || !sourceForm.rssUrl.trim()}
                  >
                    自动填充
                  </Button>
                  <Button
                    variant="primary"
                    onClick={handleSaveSource}
                    disabled={
                      isPending ||
                      !sourceForm.name.trim() ||
                      !sourceForm.rssUrl.trim() ||
                      !sourceForm.siteUrl.trim()
                    }
                  >
                    {sourceModalMode === "edit" ? "保存" : "创建"}
                  </Button>
                </div>
              }
            >
              <div className="grid gap-4 md:grid-cols-2">
                <FilterInput
                  id="source-form-name"
                  label="名称"
                  ariaLabel="名称"
                  value={sourceForm.name}
                  placeholder="信息源名称"
                  onChange={(value) =>
                    setSourceForm((current) => ({ ...current, name: value }))
                  }
                />
                <FilterInput
                  id="source-form-rss"
                  label="RSS URL"
                  ariaLabel="RSS URL"
                  value={sourceForm.rssUrl}
                  placeholder="https://example.com/feed.xml"
                  onChange={(value) =>
                    setSourceForm((current) => ({ ...current, rssUrl: value }))
                  }
                />
                <FilterInput
                  id="source-form-site"
                  label="站点 URL"
                  ariaLabel="站点 URL"
                  value={sourceForm.siteUrl}
                  placeholder="https://example.com"
                  onChange={(value) =>
                    setSourceForm((current) => ({ ...current, siteUrl: value }))
                  }
                />
                <FilterSelect
                  id="source-form-group"
                  label="所属分组"
                  ariaLabel="所属分组"
                  value={sourceForm.groupId}
                  onChange={(value) =>
                    setSourceForm((current) => ({ ...current, groupId: value }))
                  }
                  showSearch={false}
                  options={[
                    { value: "", label: "未分组" },
                    ...orderedGroups.map((group) => ({
                      value: group.id,
                      label: group.name,
                    })),
                  ]}
                />
              </div>

              <div className="flex items-center gap-4">
                <label className="flex flex-wrap items-center gap-2">
                  <input
                    checked={sourceForm.enabled}
                    className={checkboxInputClassName}
                    type="checkbox"
                    onChange={(event) =>
                      setSourceForm((current) => ({
                        ...current,
                        enabled: event.target.checked,
                      }))
                    }
                  />
                  <span className="text-sm text-[var(--text-2)]">启用此信息源</span>
                </label>
                <label className="flex flex-wrap items-center gap-2">
                  <input
                    checked={sourceForm.aiParsingEnabled}
                    className={checkboxInputClassName}
                    type="checkbox"
                    onChange={(event) =>
                      setSourceForm((current) => ({
                        ...current,
                        aiParsingEnabled: event.target.checked,
                      }))
                    }
                  />
                  <span className="text-sm text-[var(--text-2)]">AI解析</span>
                </label>
                <label className="flex flex-wrap items-center gap-2">
                  <input
                    checked={sourceForm.aggregationEnabled}
                    className={checkboxInputClassName}
                    type="checkbox"
                    onChange={(event) =>
                      setSourceForm((current) => ({
                        ...current,
                        aggregationEnabled: event.target.checked,
                      }))
                    }
                  />
                  <span className="text-sm text-[var(--text-2)]">参与聚合</span>
                </label>
                <label className="flex flex-wrap items-center gap-2">
                  <input
                    checked={sourceForm.aggregationDetectionEnabled}
                    className={checkboxInputClassName}
                    type="checkbox"
                    onChange={(event) =>
                      setSourceForm((current) => ({
                        ...current,
                        aggregationDetectionEnabled: event.target.checked,
                      }))
                    }
                  />
                  <span className="text-sm text-[var(--text-2)]">聚合自动拆分</span>
                </label>
              </div>
            </ModalShell>

            <ModalShell
              isOpen={Boolean(sourceDeleteTarget)}
              onClose={() => setSourceDeleteTarget(null)}
              title="确认删除信息源"
              widthClassName="max-w-md"
              bodyClassName="space-y-3 p-6"
              footerClassName="border-t border-[color:var(--line)] bg-[var(--bg-muted)] p-6"
              footer={
                <div className="flex justify-end gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => setSourceDeleteTarget(null)}
                  >
                    取消
                  </Button>
                  <Button
                    variant="primary"
                    onClick={handleConfirmDeleteSource}
                    disabled={isPending}
                  >
                    确认删除
                  </Button>
                </div>
              }
            >
              <p className="text-sm text-[var(--text-2)]">
                将删除信息源
                <span className="font-medium text-[var(--foreground)]">
                  {sourceDeleteTarget ? `「${sourceDeleteTarget.name}」` : ""}
                </span>
                ，该操作不可撤销。
              </p>
            </ModalShell>
          </div>
        ) : null}

        {activeSection === "content-extraction" ? (
          <div
            className={cx(
              "w-full min-w-0",
              embedMode
                ? ""
                : "rounded-sm border border-[color:var(--line)] bg-[var(--surface)] p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]",
            )}
          >
            <div className="space-y-5">
              <div className="flex flex-col gap-3 border-b border-[color:var(--line)] pb-5 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 space-y-1">
                  <h2 className="text-lg font-semibold text-[var(--text-1)]">
                    正文解析
                  </h2>
                  <p className="text-sm text-[var(--text-3)]">
                    配置正文解析策略
                  </p>
                </div>
                <Button
                  variant="primary"
                  size="md"
                  className="w-full sm:w-auto"
                  onClick={saveContentExtractionSettings}
                  disabled={isPending || !contentExtractionIsDirty}
                >
                  保存配置
                </Button>
              </div>

              <div className="space-y-5">
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                  <div className="space-y-1.5">
                    <label htmlFor="content-extraction-provider" className="block text-sm text-[var(--muted)]">
                      解析策略
                    </label>
                    <SelectField
                      id="content-extraction-provider"
                      aria-label="解析策略"
                      value={contentExtractionProvider}
                      onChange={(value) => setContentExtractionProvider(value === "jina" ? "jina" : "local")}
                      options={[
                        { value: "local", label: "本地" },
                        { value: "jina", label: "Jina" },
                      ]}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor="content-extraction-base-url" className="block text-sm text-[var(--muted)]">
                      API 地址
                    </label>
                    <TextInput
                      id="content-extraction-base-url"
                      value={contentExtractionBaseUrl}
                      onChange={(event) => setContentExtractionBaseUrl(event.target.value)}
                      placeholder="https://r.jina.ai/"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor="content-extraction-api-key" className="block text-sm text-[var(--muted)]">
                      API Key
                    </label>
                    <TextInput
                      id="content-extraction-api-key"
                      type="password"
                      value={contentExtractionApiKey}
                      onChange={(event) => {
                        setContentExtractionApiKeyTouched(true);
                        setContentExtractionApiKey(event.target.value);
                      }}
                      placeholder={
                        contentExtractionSnapshot.hasJinaApiKey
                          ? "已配置 Key，留空保持当前 Key"
                          : "留空表示无 Key 调用"
                      }
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                  <div className="space-y-1.5">
                    <label htmlFor="content-extraction-timeout-ms" className="block text-sm text-[var(--muted)]">
                      请求超时
                    </label>
                    <TextInput
                      id="content-extraction-timeout-ms"
                      type="number"
                      inputMode="numeric"
                      min={3000}
                      max={60000}
                      step={1000}
                      value={contentExtractionTimeoutMs}
                      onChange={(event) => setContentExtractionTimeoutMs(event.target.value)}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor="content-extraction-concurrency" className="block text-sm text-[var(--muted)]">
                      并发数
                    </label>
                    <TextInput
                      id="content-extraction-concurrency"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={5}
                      step={1}
                      value={contentExtractionConcurrency}
                      onChange={(event) => setContentExtractionConcurrency(event.target.value)}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor="content-extraction-rpm-limit" className="block text-sm text-[var(--muted)]">
                      每分钟调用上限
                    </label>
                    <TextInput
                      id="content-extraction-rpm-limit"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={500}
                      step={1}
                      value={contentExtractionRpmLimit}
                      onChange={(event) => setContentExtractionRpmLimit(event.target.value)}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                  <div className="space-y-1.5">
                    <label htmlFor="content-extraction-max-per-run" className="block text-sm text-[var(--muted)]">
                      单次任务调用上限
                    </label>
                    <TextInput
                      id="content-extraction-max-per-run"
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={200}
                      step={1}
                      value={contentExtractionMaxPerRun}
                      onChange={(event) => setContentExtractionMaxPerRun(event.target.value)}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor="content-extraction-min-chars" className="block text-sm text-[var(--muted)]">
                      最小有效字符数
                    </label>
                    <TextInput
                      id="content-extraction-min-chars"
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={10000}
                      step={1}
                      value={contentExtractionMinChars}
                      onChange={(event) => setContentExtractionMinChars(event.target.value)}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor="content-extraction-max-chars" className="block text-sm text-[var(--muted)]">
                      最大保留字符数
                    </label>
                    <TextInput
                      id="content-extraction-max-chars"
                      type="number"
                      inputMode="numeric"
                      min={1000}
                      max={100000}
                      step={1000}
                      value={contentExtractionMaxChars}
                      onChange={(event) => setContentExtractionMaxChars(event.target.value)}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {activeSection === "task-ingestion" || activeSection === "task-daily-report" ? (
          <div
            className={cx(
              "w-full min-w-0 space-y-6",
              embedMode
                ? ""
                : "rounded-sm border border-[color:var(--line)] bg-[var(--surface)] p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]",
            )}
          >
            <div className={cx(
              "flex flex-wrap items-start justify-between gap-3",
              activeSection !== "task-ingestion" ? "hidden" : "",
            )}>
              <div className="space-y-1">
                <h2 className="text-lg font-semibold text-[var(--text-1)]">
                  采集任务
                </h2>
                <p className="text-sm text-[var(--text-3)]">
                  配置抓取任务的启用状态、Cron 调度、抓取规模与聚合拆分上限
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="primary"
                  size="md"
                  onClick={saveTaskSchedule}
                  disabled={isPending || !taskScheduleCronExpression.trim() || !taskScheduleIsDirty}
                >
                  保存配置
                </Button>
              </div>
            </div>

            <div className={cx(
              "space-y-6",
              activeSection !== "task-ingestion" ? "hidden" : "",
            )}>
              {/* Row 1: 任务开关 + Cron 表达式 + 处理开始时间点 */}
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                <div className="space-y-1.5">
                  <div className="block text-sm text-[var(--muted)]">任务开关</div>
                  <label className="flex min-h-10 w-full items-center gap-2 rounded-sm border border-[color:var(--line)] bg-[var(--surface)] px-3 text-sm text-[var(--text-2)]">
                    <input
                      aria-label="启用默认抓取任务"
                      checked={taskScheduleEnabled}
                      className={checkboxInputClassName}
                      type="checkbox"
                      onChange={(event) => setTaskScheduleEnabled(event.target.checked)}
                    />
                    <span>启用默认抓取任务</span>
                  </label>
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="task-schedule-cron"
                    className="block text-sm text-[var(--muted)]"
                  >
                    采集 Cron 表达式
                  </label>
                  <TextInput
                    id="task-schedule-cron"
                    value={taskScheduleCronExpression}
                    onChange={(event) => setTaskScheduleCronExpression(event.target.value)}
                    placeholder="例如 0 * * * *"
                  />
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="task-schedule-processing-start-at"
                    className="block text-sm text-[var(--muted)]"
                  >
                    处理开始时间点
                  </label>
                  <TextInput
                    id="task-schedule-processing-start-at"
                    type="datetime-local"
                    value={taskScheduleProcessingStartAt}
                    onChange={(event) => setTaskScheduleProcessingStartAt(event.target.value)}
                  />
                </div>
              </div>

              {/* Row 2: 源抓取并发 + 正文补抓阈值 + 每源处理上限 + 聚合拆分上限 */}
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
                <div className="space-y-1.5">
                  <label
                    htmlFor="task-schedule-source-concurrency"
                    className="block text-sm text-[var(--muted)]"
                  >
                    源抓取并发
                  </label>
                  <TextInput
                    id="task-schedule-source-concurrency"
                    type="number"
                    inputMode="numeric"
                    min={MIN_SOURCE_CONCURRENCY}
                    max={MAX_SOURCE_CONCURRENCY}
                    step={1}
                    value={taskScheduleSourceConcurrency}
                    onChange={(event) => setTaskScheduleSourceConcurrency(event.target.value)}
                    placeholder="例如 2"
                  />
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="task-schedule-full-text-fetch-threshold"
                    className="block text-sm text-[var(--muted)]"
                  >
                    正文补抓阈值
                  </label>
                  <TextInput
                    id="task-schedule-full-text-fetch-threshold"
                    type="number"
                    inputMode="numeric"
                    min={MIN_FULL_TEXT_FETCH_THRESHOLD}
                    max={MAX_FULL_TEXT_FETCH_THRESHOLD}
                    step={1}
                    value={taskScheduleFullTextFetchThreshold}
                    onChange={(event) => setTaskScheduleFullTextFetchThreshold(event.target.value)}
                    placeholder="例如 80"
                  />
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="task-schedule-per-source-item-limit"
                    className="block text-sm text-[var(--muted)]"
                  >
                    每源处理上限
                  </label>
                  <TextInput
                    id="task-schedule-per-source-item-limit"
                    type="number"
                    inputMode="numeric"
                    min={MIN_PER_SOURCE_ITEM_LIMIT}
                    max={MAX_PER_SOURCE_ITEM_LIMIT}
                    step={1}
                    value={taskSchedulePerSourceItemLimit}
                    onChange={(event) => setTaskSchedulePerSourceItemLimit(event.target.value)}
                    placeholder="例如 20"
                  />
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="task-schedule-aggregation-split-max-events"
                    className="block text-sm text-[var(--muted)]"
                  >
                    单条聚合拆分上限
                  </label>
                  <TextInput
                    id="task-schedule-aggregation-split-max-events"
                    type="number"
                    inputMode="numeric"
                    min={MIN_AGGREGATION_SPLIT_MAX_EVENTS}
                    max={MAX_AGGREGATION_SPLIT_MAX_EVENTS}
                    step={1}
                    value={taskScheduleAggregationSplitMaxEvents}
                    onChange={(event) => setTaskScheduleAggregationSplitMaxEvents(event.target.value)}
                    placeholder="例如 20"
                  />
                </div>
              </div>

              {taskScheduleSnapshot.timezone !== DEFAULT_SCHEDULE_TIMEZONE ? (
                <FormField label="时区" htmlFor="task-schedule-timezone">
                  <TextInput
                    id="task-schedule-timezone"
                    value={taskScheduleSnapshot.timezone}
                    readOnly
                    disabled
                  />
                </FormField>
              ) : null}
            </div>

            <div
              className={cx(
                activeSection === "task-daily-report"
                  ? "pt-0"
                  : "hidden",
              )}
            >
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <h2 className="text-lg font-semibold text-[var(--text-1)]">
                    日报任务
                  </h2>
                  <p className="text-sm text-[var(--text-3)]">
                    独立控制日报草稿生成时间，不影响 采集任务。
                  </p>
                </div>
                <Button
                  variant="primary"
                  size="md"
                  onClick={saveDailyReportSchedule}
                  disabled={isPending || !dailyReportScheduleCronExpression.trim() || !dailyReportScheduleIsDirty}
                >
                  保存配置
                </Button>
              </div>
              <div className="grid w-full grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                <div className="space-y-1.5">
                  <div className="block text-sm text-[var(--muted)]">任务开关</div>
                  <label className="flex min-h-10 w-full items-center gap-2 rounded-sm border border-[color:var(--line)] bg-[var(--surface)] px-3 text-sm text-[var(--text-2)]">
                    <input
                      aria-label="启用 AI 日报任务"
                      checked={dailyReportScheduleEnabled}
                      className={checkboxInputClassName}
                      type="checkbox"
                      onChange={(event) => setDailyReportScheduleEnabled(event.target.checked)}
                    />
                    <span>启用 AI 日报任务</span>
                  </label>
                </div>

                <div className="space-y-1.5">
                  <div className="block text-sm text-[var(--muted)]">发布方式</div>
                  <label className="flex min-h-10 w-full items-center gap-2 rounded-sm border border-[color:var(--line)] bg-[var(--surface)] px-3 text-sm text-[var(--text-2)]">
                    <input
                      aria-label="生成后自动发布 AI 日报"
                      checked={dailyReportAutoPublish}
                      className={checkboxInputClassName}
                      type="checkbox"
                      onChange={(event) => setDailyReportAutoPublish(event.target.checked)}
                    />
                    <span>生成后自动发布</span>
                  </label>
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="daily-report-schedule-cron"
                    className="block text-sm text-[var(--muted)]"
                  >
                    日报 Cron 表达式
                  </label>
                  <TextInput
                    id="daily-report-schedule-cron"
                    value={dailyReportScheduleCronExpression}
                    onChange={(event) => setDailyReportScheduleCronExpression(event.target.value)}
                    placeholder="例如 30 8 * * *"
                  />
                </div>
              </div>

              <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                <FormField label="最大重试次数" htmlFor="daily-report-max-retries">
                  <TextInput
                    id="daily-report-max-retries"
                    type="number"
                    min={MIN_DAILY_REPORT_MAX_RETRIES}
                    max={MAX_DAILY_REPORT_MAX_RETRIES}
                    value={dailyReportMaxRetries}
                    onChange={(event) => setDailyReportMaxRetries(event.target.value)}
                  />
                </FormField>

                <FormField label="T-" htmlFor="daily-report-offset-days">
                  <TextInput
                    id="daily-report-offset-days"
                    type="number"
                    min={MIN_DAILY_REPORT_OFFSET_DAYS}
                    max={MAX_DAILY_REPORT_OFFSET_DAYS}
                    value={dailyReportOffsetDays}
                    onChange={(event) => setDailyReportOffsetDays(event.target.value)}
                  />
                </FormField>

                <FormField label="候选内容上限" htmlFor="daily-report-candidate-limit">
                  <TextInput
                    id="daily-report-candidate-limit"
                    type="number"
                    min={MIN_DAILY_REPORT_CANDIDATE_LIMIT}
                    max={MAX_DAILY_REPORT_CANDIDATE_LIMIT}
                    value={dailyReportCandidateLimit}
                    onChange={(event) => setDailyReportCandidateLimit(event.target.value)}
                  />
                </FormField>
              </div>

              <div className="mt-4">
                <FormField label="日报分组范围" htmlFor="daily-report-group-ids">
                  <SelectField
                    id="daily-report-group-ids"
                    aria-label="日报分组范围"
                    mode="multiple"
                    allowClear
                    multiline
                    className="w-full"
                    placeholder="全部分组"
                    value={dailyReportGroupIds.length > 0 ? dailyReportGroupIds : [ALL_DAILY_REPORT_GROUPS_SELECT_VALUE]}
                    options={[
                      {
                        value: ALL_DAILY_REPORT_GROUPS_SELECT_VALUE,
                        label: "全部分组",
                      },
                      ...orderedGroups.map((group) => ({
                        value: group.id,
                        label: group.name,
                      })),
                    ]}
                    onChange={(value) => {
                      const nextIds = Array.isArray(value) ? value.map(String) : [];
                      if (nextIds.length === 0) {
                        setDailyReportGroupIds([]);
                        return;
                      }
                      if (nextIds.includes(ALL_DAILY_REPORT_GROUPS_SELECT_VALUE)) {
                        const concreteIds = nextIds.filter((groupId) => groupId !== ALL_DAILY_REPORT_GROUPS_SELECT_VALUE);
                        setDailyReportGroupIds(dailyReportGroupIds.length > 0 ? [] : concreteIds);
                        return;
                      }
                      setDailyReportGroupIds(
                        orderedGroups
                          .map((group) => group.id)
                          .filter((groupId) => nextIds.includes(groupId)),
                      );
                    }}
                  />
                </FormField>
              </div>
            </div>
          </div>
        ) : null}

        {activeSection === "task-cleanup" ? (
          <div
            className={cx(
              "w-full min-w-0",
              embedMode
                ? ""
                : "rounded-sm border border-[color:var(--line)] bg-[var(--surface)] p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]",
            )}
          >
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <h2 className="text-lg font-semibold text-[var(--text-1)]">
                  清理任务
                </h2>
                <p className="text-sm text-[var(--text-3)]">
                  自动清理超过保留天数的文章，已删除文章关联的聚合将自动重算
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  onClick={() =>
                    saveItemCleanupSchedule()
                  }
                  variant="primary"
                  disabled={!cleanupScheduleIsDirty}
                >
                  保存配置
                </Button>
              </div>
            </div>

            <div className="min-w-0 space-y-4">
              <div className="grid gap-4 md:grid-cols-3">
                <FormField label="启用" htmlFor="cleanup-schedule-enabled">
                  <label className="flex min-h-10 items-center gap-2 rounded-sm border border-[color:var(--line)] bg-[var(--surface)] px-3 text-sm text-[var(--text-2)]">
                    <input
                      id="cleanup-schedule-enabled"
                      checked={cleanupScheduleEnabled}
                      className={checkboxInputClassName}
                      type="checkbox"
                      onChange={(event) => setCleanupScheduleEnabled(event.target.checked)}
                    />
                    <span>启用自动清理</span>
                  </label>
                </FormField>

                <FormField label="Cron 表达式" htmlFor="cleanup-cron-expression">
                  <TextInput
                    id="cleanup-cron-expression"
                    value={cleanupScheduleCronExpression}
                    onChange={(event) => setCleanupScheduleCronExpression(event.target.value)}
                  />
                </FormField>

                <FormField label="保留天数" htmlFor="cleanup-retention-days">
                  <TextInput
                    id="cleanup-retention-days"
                    type="number"
                    min={MIN_CLEANUP_RETENTION_DAYS}
                    max={MAX_CLEANUP_RETENTION_DAYS}
                    value={cleanupScheduleRetentionDays}
                    onChange={(event) => setCleanupScheduleRetentionDays(event.target.value)}
                  />
                </FormField>
              </div>
            </div>
          </div>
        ) : null}
      </section>
    </section>
  );

  if (embedMode) {
    return content;
  }

  return (
    <PageShell
      header={{ activeNav: null, isAdmin: true }}
      contentClassName="gap-4"
      contentWidth="workspace"
      sidebar={
        <AdminWorkspaceSidebar
          activeSection={activeSection}
          onSelect={setInternalActiveSection}
        />
      }
    >
      {content}
    </PageShell>
  );
}

function AdminWorkspaceSidebar({
  activeSection,
  onSelect,
}: {
  activeSection: AdminSettingsSection;
  onSelect: (section: AdminSettingsSection) => void;
}) {
  return (
    <aside
      aria-label="设置导航"
      className={cx(surfaceCardClassName, "p-3.5 xl:sticky xl:top-24")}
    >
      <div
        aria-label="设置标签"
        className="space-y-1.5"
        role="tablist"
        aria-orientation="vertical"
      >
        {settingsNavItems.map((item) => {
          const isActive = item.key === activeSection;

          return (
            <button
              key={item.key}
              aria-controls={`settings-panel-${item.key}`}
              aria-label={item.label}
              aria-selected={isActive}
              className={cx(
                "flex w-full rounded-[1rem] border px-3 py-3 text-left text-sm font-semibold transition",
                isActive
                  ? "border-[color:var(--line-strong)] bg-[var(--surface-highlight)] shadow-[var(--shadow-sm)]"
                  : "border-transparent bg-transparent hover:border-[color:var(--line)] hover:bg-[var(--surface)]",
              )}
              id={`settings-tab-${item.key}`}
              role="tab"
              type="button"
              onClick={() => onSelect(item.key)}
            >
              <span className="block text-[var(--foreground)]">
                {item.label}
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

function HeaderLinkRow({
  link,
  onEdit,
  onDelete,
}: {
  link: NonNullable<AdminSettingsSnapshot["headerLinks"]>[number];
  onEdit: (link: NonNullable<AdminSettingsSnapshot["headerLinks"]>[number]) => void;
  onDelete: (link: NonNullable<AdminSettingsSnapshot["headerLinks"]>[number]) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: link.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.55 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cx(
        "rounded-lg border border-[color:var(--line)] bg-[var(--surface)] px-3 py-3 transition hover:shadow-[0_1px_3px_rgba(0,0,0,0.06)]",
        isDragging && "opacity-60 ring-2 ring-[rgba(59,130,246,0.35)]",
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            {...attributes}
            {...listeners}
            className="cursor-grab rounded-sm px-1 text-[var(--text-3)] transition hover:text-[var(--text-2)] active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(59,130,246,0.35)]"
            title="拖动排序"
            aria-label="拖动排序"
          >
            <IconGrip className="h-4 w-4" />
          </button>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-[var(--text-1)]">
                {link.label}
              </h3>
              <span
                className={cx(
                  "rounded-sm px-2 py-0.5 text-xs",
                  link.enabled
                    ? "bg-[var(--success-surface)] text-[var(--success-ink)]"
                    : "bg-[var(--bg-muted)] text-[var(--text-3)]",
                )}
              >
                {link.enabled ? "启用" : "停用"}
              </span>
              <span className="rounded-sm bg-[var(--bg-muted)] px-2 py-0.5 text-xs text-[var(--text-2)]">
                {link.openInNewTab ? "新窗口" : "当前页"}
              </span>
              {link.rel.includes("sponsored") ? (
                <span className="rounded-sm bg-[var(--accent-soft)] px-2 py-0.5 text-xs text-[var(--accent)]">
                  AFF/赞助
                </span>
              ) : null}
            </div>
            <a
              className="mt-1 block truncate text-sm text-[var(--text-3)] hover:text-[var(--accent)]"
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {link.url}
            </a>
          </div>
        </div>

        <div className="flex gap-1">
          <IconButton
            variant="secondary"
            size="sm"
            title="编辑"
            onClick={() => onEdit(link)}
          >
            <IconEdit className="h-4 w-4" />
          </IconButton>
          <IconButton
            variant="secondary"
            size="sm"
            title="删除"
            className="text-[var(--danger-ink)] hover:bg-[var(--danger-surface)] hover:text-[var(--danger-ink)]"
            onClick={() => onDelete(link)}
          >
            <IconTrash className="h-4 w-4" />
          </IconButton>
        </div>
      </div>
    </div>
  );
}

function GroupRow({
  group,
  submitJson,
  onOpenSourceLink,
}: {
  group: AdminSettingsSnapshot["groups"][number];
  submitJson: (
    url: string,
    method: string,
    body: unknown,
    successMessage: string,
    reload?: boolean,
    onSuccess?: () => void,
  ) => void;
  onOpenSourceLink: (group: AdminSettingsSnapshot["groups"][number]) => void;
}) {
  const [name, setName] = useState(group.name);
  const [isEditing, setIsEditing] = useState(false);
  const initial = group.name.charAt(0).toUpperCase();
  const badgeColor = group.color || getStableGroupBadgeColor(group.name);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: group.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.55 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cx(
        "rounded-lg border border-[color:var(--line)] bg-[var(--surface)] px-3 py-3 transition hover:shadow-[0_1px_3px_rgba(0,0,0,0.06)]",
        isDragging && "opacity-60 ring-2 ring-[rgba(59,130,246,0.35)]",
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            {...attributes}
            {...listeners}
            className="cursor-grab rounded-sm px-1 text-[var(--text-3)] transition hover:text-[var(--text-2)] active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(59,130,246,0.35)]"
            title="拖动排序"
            aria-label="拖动排序"
          >
            <IconGrip className="h-4 w-4" />
          </button>
          <div
            className="flex h-8 w-8 items-center justify-center rounded text-sm font-bold text-white"
            style={{ backgroundColor: badgeColor }}
          >
            {initial || <IconTag className="h-4 w-4" />}
          </div>
          <div className="min-w-0">
            {isEditing ? (
              <TextInput
                className="min-w-[12rem]"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            ) : (
              <h3 className="text-sm font-semibold text-[var(--text-1)]">
                {group.name}
              </h3>
            )}
          </div>
        </div>

        <div className="flex gap-1">
          {isEditing ? (
            <>
              <IconButton
                variant="secondary"
                size="sm"
                title="保存"
                onClick={() => {
                  submitJson(
                    `/api/admin/settings/groups/${group.id}`,
                    "PATCH",
                    { name },
                    "分组已更新。",
                  );
                  setIsEditing(false);
                }}
                disabled={!name.trim()}
              >
                <IconCheck className="h-4 w-4" />
              </IconButton>
              <IconButton
                variant="secondary"
                size="sm"
                title="取消"
                onClick={() => {
                  setName(group.name);
                  setIsEditing(false);
                }}
              >
                <IconX className="h-4 w-4" />
              </IconButton>
            </>
          ) : (
            <IconButton
              variant="secondary"
              size="sm"
              title="编辑"
              onClick={() => setIsEditing(true)}
            >
              <IconEdit className="h-4 w-4" />
            </IconButton>
          )}
          <IconButton
            variant="secondary"
            size="sm"
            title="关联信息源"
            aria-label={`关联信息源：${group.name}`}
            onClick={() => onOpenSourceLink(group)}
          >
            <IconLink className="h-4 w-4" />
          </IconButton>
          <IconButton
            variant="secondary"
            size="sm"
            title="删除"
            className="text-[var(--danger-ink)] hover:bg-[var(--danger-surface)] hover:text-[var(--danger-ink)]"
            onClick={() =>
              submitJson(
                `/api/admin/settings/groups/${group.id}`,
                "DELETE",
                {},
                "分组已删除。",
                true,
              )
            }
          >
            <IconTrash className="h-4 w-4" />
          </IconButton>
        </div>
      </div>
    </div>
  );
}
