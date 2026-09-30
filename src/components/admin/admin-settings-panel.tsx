"use client";
import { closestCenter, DndContext, type DragEndEvent, KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useEffect, useRef, useState, useTransition } from "react";

import { importSourcesFromOpmlText, deleteHeaderLink, reorderHeaderLinks, reorderSourceGroups, resolveSourceFromRssUrl, saveContentExtractionConfig, saveDefaultDailyReportSchedule, saveDefaultIngestionSchedule, saveDefaultItemCleanupSchedule, saveEventBriefingSettings, saveHeaderLink, submitAdminSettingsAction } from "@/components/admin/admin-settings-panel.api";
import { AiSettingsPanel } from "@/components/admin/ai-settings-panel";
import { EntitySettingsPanel } from "@/components/admin/entity-settings-panel";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageShell } from "@/components/ui/page-shell";
import { FilterInput } from "@/components/ui/filter-input";
import { FilterSelect } from "@/components/ui/filter-select";
import { FormField } from "@/components/ui/form-field";
import { IconButton } from "@/components/ui/icon-button";
import { IconEdit, IconPlus, IconTrash } from "@/components/ui/icons";
import { ModalShell } from "@/components/ui/modal-shell";
import { PaginationControls } from "@/components/ui/pagination-controls";
import { SelectField } from "@/components/ui/select-field";
import { TextArea } from "@/components/ui/text-area";
import { TextInput } from "@/components/ui/text-input";
import { useToast } from "@/components/ui/toast";
import type { AdminEventBriefingChannel, AdminSettingsSnapshot, PromptConfigType } from "@/lib/settings/types";
import { DEFAULT_SCHEDULE_TIMEZONE, DEFAULT_DAILY_REPORT_RECENT_TOPIC_LOOKBACK_DAYS, MAX_CLEANUP_RETENTION_DAYS, MAX_AGGREGATION_SPLIT_MAX_EVENTS, MAX_DAILY_REPORT_OFFSET_DAYS, MAX_FULL_TEXT_FETCH_THRESHOLD, MAX_SOURCE_CONCURRENCY, MIN_CLEANUP_RETENTION_DAYS, MIN_AGGREGATION_SPLIT_MAX_EVENTS, MIN_DAILY_REPORT_OFFSET_DAYS, MIN_FULL_TEXT_FETCH_THRESHOLD, MIN_SOURCE_CONCURRENCY, MAX_PER_SOURCE_ITEM_LIMIT, MAX_DAILY_REPORT_CANDIDATE_LIMIT, MIN_DAILY_REPORT_CANDIDATE_LIMIT, MIN_DAILY_REPORT_RECENT_TOPIC_LOOKBACK_DAYS, MIN_PER_SOURCE_ITEM_LIMIT } from "@/lib/tasks/scheduler";
import { cx } from "@/lib/ui/cx";

import { appendMissingOptions, areEventBriefingChannelsEqual, areStringArraysEqual, checkboxInputClassName, createEventBriefingChannel, DEFAULT_DAILY_REPORT_CHANNEL_ID, downloadTextFile, escapeXml, formatSourceUpdateTime, getInitialSourceFilterNumber, getInitialSourceFilterValue, HEADER_LINK_REL_DEFAULT, HEADER_LINK_REL_SPONSORED, headerLinkRelOptions, normalizeHeaderLinkRelOption, normalizeSourceEnabledFilter, refreshPage, sourceFilterQueryKeys, toDateTimeLocalValue, toIsoDateTimeOrNull, type AdminSettingsSection } from "@/components/admin/admin-settings-panel.helpers";
import { AdminWorkspaceSidebar, GroupRow, HeaderLinkRow } from "@/components/admin/admin-settings-panel-rows";
type AdminSettingsPanelProps = {
  initialSettings: AdminSettingsSnapshot;
  onRefresh?: () => void;
  embedMode?: boolean;
  activeSection?: AdminSettingsSection;
  initialPromptType?: PromptConfigType;
  initialOpenEntitySuggestions?: boolean;
};

export function AdminSettingsPanel({
  initialSettings,
  onRefresh,
  embedMode,
  activeSection: externalActiveSection,
  initialPromptType,
  initialOpenEntitySuggestions = false,
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
  const [dailyReportPlanningBatchSize, setDailyReportPlanningBatchSize] = useState(
    initialSettings.dailyReportSchedule.dailyReportPlanningBatchSize == null
      ? ""
      : String(initialSettings.dailyReportSchedule.dailyReportPlanningBatchSize),
  );
  const [dailyReportOffsetDays, setDailyReportOffsetDays] = useState(
    String(initialSettings.dailyReportSchedule.dailyReportOffsetDays),
  );
  const [dailyReportRecentTopicLookbackDays, setDailyReportRecentTopicLookbackDays] = useState(
    String(initialSettings.dailyReportSchedule.dailyReportRecentTopicLookbackDays ?? DEFAULT_DAILY_REPORT_RECENT_TOPIC_LOOKBACK_DAYS),
  );
  const [dailyReportAutoPublish, setDailyReportAutoPublish] = useState(
    initialSettings.dailyReportSchedule.dailyReportAutoPublish,
  );
  const [dailyReportChannelIds, setDailyReportChannelIds] = useState(
    initialSettings.dailyReportSchedule.dailyReportChannelIds?.length
      ? initialSettings.dailyReportSchedule.dailyReportChannelIds
      : [DEFAULT_DAILY_REPORT_CHANNEL_ID],
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
  const [eventBriefingChannels, setEventBriefingChannels] = useState(
    initialSettings.eventBriefing.config.channels,
  );
  const [eventBriefingChannelModalMode, setEventBriefingChannelModalMode] =
    useState<"create" | "edit" | null>(null);
  const [eventBriefingChannelDraft, setEventBriefingChannelDraft] =
    useState<AdminEventBriefingChannel | null>(null);
  const normalizedBlacklistKeywords = blacklistText
    .split("\n")
    .map((keyword) => keyword.trim())
    .filter(Boolean);
  const eventBriefingSourceGroupSelectOptions = appendMissingOptions(
    orderedGroups.map((group) => ({
      value: group.id,
      label: group.name,
    })),
    eventBriefingChannels.flatMap((channel) => channel.sourceGroupIds),
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
  const getEventBriefingChannelGroupSummary = (channel: AdminEventBriefingChannel) => {
    if (channel.sourceGroupIds.length === 0) {
      return "全部组";
    }

    return channel.sourceGroupIds
      .map((groupId) => eventBriefingSourceGroupSelectOptions.find((option) => option.value === groupId)?.label ?? groupId)
      .join("、");
  };
  const openCreateEventBriefingChannelModal = () => {
    setEventBriefingChannelDraft(createEventBriefingChannel(eventBriefingChannels.length));
    setEventBriefingChannelModalMode("create");
  };
  const openEditEventBriefingChannelModal = (channel: AdminEventBriefingChannel) => {
    setEventBriefingChannelDraft({
      ...channel,
      sourceGroupIds: [...channel.sourceGroupIds],
    });
    setEventBriefingChannelModalMode("edit");
  };
  const closeEventBriefingChannelModal = () => {
    setEventBriefingChannelModalMode(null);
    setEventBriefingChannelDraft(null);
  };
  const saveEventBriefingChannelDraft = () => {
    if (!eventBriefingChannelDraft) {
      return;
    }

    const normalizedDraft: AdminEventBriefingChannel = {
      ...eventBriefingChannelDraft,
      name: eventBriefingChannelDraft.name.trim(),
      sourceGroupIds: orderedGroups
        .map((group) => group.id)
        .filter((groupId) => eventBriefingChannelDraft.sourceGroupIds.includes(groupId)),
    };

    if (!normalizedDraft.name) {
      showToast("速览频道名称不能为空。", "error");
      return;
    }

    if (eventBriefingChannelModalMode === "create") {
      setEventBriefingChannels((current) => [
        ...current,
        { ...normalizedDraft, sortOrder: current.length },
      ]);
    } else {
      setEventBriefingChannels((current) =>
        current.map((channel) => channel.id === normalizedDraft.id ? normalizedDraft : channel),
      );
    }
    closeEventBriefingChannelModal();
  };
  const removeEventBriefingChannel = (channelId: string) => {
    setEventBriefingChannels((current) => {
      if (current.length <= 1) {
        showToast("至少保留一个速览频道。", "error");
        return current;
      }

      return current
        .filter((channel) => channel.id !== channelId)
        .map((channel, index) => ({ ...channel, sortOrder: index }));
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
    const normalizedChannels = eventBriefingChannels.map((channel, index) => ({
      ...channel,
      name: channel.name.trim(),
      sourceGroupIds: [...new Set(channel.sourceGroupIds.filter(Boolean))],
      sortOrder: index,
    }));
    const numericFields: Array<[number, number, number, string]> = [
      [parsedMinRankScore, 0, 100, "最低入选分"],
    ];

    for (const [value, min, max, label] of numericFields) {
      if (!Number.isInteger(value) || value < min || value > max) {
        showToast(`${label}需为 ${min}-${max} 的整数。`, "error");
        return;
      }
    }
    if (normalizedChannels.some((channel) => !channel.name)) {
      showToast("速览频道名称不能为空。", "error");
      return;
    }
    if (!normalizedChannels.some((channel) => channel.enabled)) {
      showToast("至少需要启用一个速览频道。", "error");
      return;
    }

    startTransition(async () => {
      try {
        const saved = await saveEventBriefingSettings({
          config: {
            ...eventBriefingSnapshot.config,
            minRankScore: parsedMinRankScore,
            channels: normalizedChannels,
          },
        });

        setEventBriefingSnapshot(saved);
        setEventBriefingMinRankScore(String(saved.config.minRankScore));
        setEventBriefingChannels(saved.config.channels);
        showToast("速览配置已保存。", "success");
      } catch (error) {
        showToast(error instanceof Error ? error.message : "速览配置保存失败。", "error");
      }
    });
  };

  const saveDailyReportSchedule = () => {
    const parsedDailyReportCandidateLimit = Number.parseInt(dailyReportCandidateLimit.trim(), 10);
    const parsedDailyReportPlanningBatchSize = dailyReportPlanningBatchSize.trim()
      ? Number.parseInt(dailyReportPlanningBatchSize.trim(), 10)
      : null;
    const parsedDailyReportOffsetDays = Number.parseInt(dailyReportOffsetDays.trim(), 10);
    const parsedDailyReportRecentTopicLookbackDays = Number.parseInt(dailyReportRecentTopicLookbackDays.trim(), 10);

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
      parsedDailyReportPlanningBatchSize !== null &&
      (!Number.isInteger(parsedDailyReportPlanningBatchSize) || parsedDailyReportPlanningBatchSize < 1)
    ) {
      showToast("规划批次大小需留空或填写正整数。", "error");
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
      !Number.isInteger(parsedDailyReportRecentTopicLookbackDays) ||
      parsedDailyReportRecentTopicLookbackDays < MIN_DAILY_REPORT_RECENT_TOPIC_LOOKBACK_DAYS
    ) {
      showToast(
        `历史主题召回天数需为不小于 ${MIN_DAILY_REPORT_RECENT_TOPIC_LOOKBACK_DAYS} 的整数。`,
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
          dailyReportPlanningBatchSize: parsedDailyReportPlanningBatchSize,
          dailyReportOffsetDays: parsedDailyReportOffsetDays,
          dailyReportRecentTopicLookbackDays: parsedDailyReportRecentTopicLookbackDays,
          dailyReportAutoPublish,
          dailyReportChannelIds,
        });

        setDailyReportScheduleSnapshot(schedule);
        setDailyReportScheduleEnabled(schedule.enabled);
        setDailyReportScheduleCronExpression(schedule.cronExpression);
        setDailyReportCandidateLimit(String(schedule.dailyReportCandidateLimit));
        setDailyReportPlanningBatchSize(
          schedule.dailyReportPlanningBatchSize == null ? "" : String(schedule.dailyReportPlanningBatchSize),
        );
        setDailyReportOffsetDays(String(schedule.dailyReportOffsetDays));
        setDailyReportRecentTopicLookbackDays(String(schedule.dailyReportRecentTopicLookbackDays ?? DEFAULT_DAILY_REPORT_RECENT_TOPIC_LOOKBACK_DAYS));
        setDailyReportAutoPublish(schedule.dailyReportAutoPublish);
        setDailyReportChannelIds(schedule.dailyReportChannelIds?.length
          ? schedule.dailyReportChannelIds
          : [DEFAULT_DAILY_REPORT_CHANNEL_ID]);
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
    !areEventBriefingChannelsEqual(
      eventBriefingChannels.map((channel, index) => ({ ...channel, sortOrder: index })),
      eventBriefingSnapshot.config.channels,
    );
  const dailyReportScheduleIsDirty =
    dailyReportScheduleEnabled !== dailyReportScheduleSnapshot.enabled ||
    dailyReportScheduleCronExpression.trim() !== dailyReportScheduleSnapshot.cronExpression ||
    dailyReportCandidateLimit.trim() !== String(dailyReportScheduleSnapshot.dailyReportCandidateLimit) ||
    dailyReportPlanningBatchSize.trim() !== (dailyReportScheduleSnapshot.dailyReportPlanningBatchSize == null
      ? ""
      : String(dailyReportScheduleSnapshot.dailyReportPlanningBatchSize)) ||
    dailyReportOffsetDays.trim() !== String(dailyReportScheduleSnapshot.dailyReportOffsetDays) ||
    dailyReportRecentTopicLookbackDays.trim() !== String(dailyReportScheduleSnapshot.dailyReportRecentTopicLookbackDays ?? DEFAULT_DAILY_REPORT_RECENT_TOPIC_LOOKBACK_DAYS) ||
    dailyReportAutoPublish !== dailyReportScheduleSnapshot.dailyReportAutoPublish ||
    !areStringArraysEqual(
      dailyReportChannelIds,
      dailyReportScheduleSnapshot.dailyReportChannelIds?.length
        ? dailyReportScheduleSnapshot.dailyReportChannelIds
        : [DEFAULT_DAILY_REPORT_CHANNEL_ID],
    );
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

        {activeSection === "entities" ? (
          <EntitySettingsPanel initialOpenSuggestions={initialOpenEntitySuggestions} />
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
                    配置速览的展示规则、频道和事件偏好。
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

              <section className="space-y-4 border-t border-[color:var(--line)] pt-5" aria-labelledby="event-briefing-channel-settings">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <h3 id="event-briefing-channel-settings" className="text-sm font-semibold text-[var(--text-1)]">
                    速览频道
                  </h3>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={openCreateEventBriefingChannelModal}
                  >
                    新增频道
                  </Button>
                </div>

                <div className="w-full overflow-x-auto">
                  <table className="w-full min-w-[52rem] table-fixed text-sm">
                    <colgroup>
                      <col className="w-[22%]" />
                      <col />
                      <col className="w-[9rem]" />
                      <col className="w-[6rem]" />
                    </colgroup>
                    <thead className="bg-[var(--bg-muted)] text-[var(--muted)]">
                      <tr>
                        <th className="whitespace-nowrap px-4 py-3 text-left">频道名称</th>
                        <th className="px-4 py-3 text-left">候选来源组</th>
                        <th className="whitespace-nowrap px-4 py-3 text-left">状态</th>
                        <th className="whitespace-nowrap px-4 py-3 text-right">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[color:var(--line)]">
                      {eventBriefingChannels.map((channel) => (
                        <tr
                          key={channel.id}
                          className="transition-colors hover:bg-[var(--bg-muted)]"
                        >
                          <td className="px-4 py-3">
                            <div className="font-medium text-[var(--foreground)]">
                              {channel.name}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-[var(--text-2)]">
                            <div className="max-w-[32rem] truncate" title={getEventBriefingChannelGroupSummary(channel)}>
                              {getEventBriefingChannelGroupSummary(channel)}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-[var(--text-2)]">
                            {channel.enabled ? "已启用" : "已停用"}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <div className="flex items-center justify-end gap-1">
                              <IconButton
                                variant="secondary"
                                size="sm"
                                title="编辑频道"
                                onClick={() => openEditEventBriefingChannelModal(channel)}
                              >
                                <IconEdit className="h-4 w-4" />
                              </IconButton>
                              <IconButton
                                variant="secondary"
                                size="sm"
                                title="删除频道"
                                className="text-[var(--danger-ink)] hover:bg-[var(--danger-surface)] hover:text-[var(--danger-ink)]"
                                onClick={() => removeEventBriefingChannel(channel.id)}
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
              </section>

              <ModalShell
                isOpen={Boolean(eventBriefingChannelModalMode)}
                onClose={closeEventBriefingChannelModal}
                title={eventBriefingChannelModalMode === "edit" ? "编辑频道" : "新增频道"}
                widthClassName="max-w-xl"
                headerClassName="border-b border-[color:var(--line)] p-6"
                bodyClassName="space-y-4 p-6"
                footerClassName="border-t border-[color:var(--line)] bg-[var(--bg-muted)] p-6"
                footer={
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="secondary"
                      onClick={closeEventBriefingChannelModal}
                      disabled={isPending}
                    >
                      取消
                    </Button>
                    <Button
                      variant="primary"
                      onClick={saveEventBriefingChannelDraft}
                      disabled={isPending || !eventBriefingChannelDraft?.name.trim()}
                    >
                      {eventBriefingChannelModalMode === "edit" ? "保存" : "添加"}
                    </Button>
                  </div>
                }
              >
                {eventBriefingChannelDraft ? (
                  <>
                    <FormField label="频道名称" htmlFor="event-briefing-channel-name">
                      <TextInput
                        id="event-briefing-channel-name"
                        aria-label="频道名称"
                        value={eventBriefingChannelDraft.name}
                        maxLength={24}
                        onChange={(event) => setEventBriefingChannelDraft((current) => (
                          current ? { ...current, name: event.target.value } : current
                        ))}
                      />
                    </FormField>
                    <FormField label="候选来源组" htmlFor="event-briefing-channel-source-groups">
                      <SelectField
                        id="event-briefing-channel-source-groups"
                        aria-label="候选来源组"
                        mode="multiple"
                        allowClear
                        multiline
                        placeholder="全部组"
                        value={eventBriefingChannelDraft.sourceGroupIds}
                        options={eventBriefingSourceGroupSelectOptions}
                        onChange={(value) => {
                          const nextIds = Array.isArray(value) ? value.map(String) : [];
                          setEventBriefingChannelDraft((current) => (
                            current
                              ? {
                                  ...current,
                                  sourceGroupIds: orderedGroups
                                    .map((group) => group.id)
                                    .filter((groupId) => nextIds.includes(groupId)),
                                }
                              : current
                          ));
                        }}
                      />
                    </FormField>
                    <label className="inline-flex items-center gap-2 text-sm text-[var(--text-2)]">
                      <input
                        className={checkboxInputClassName}
                        type="checkbox"
                        checked={eventBriefingChannelDraft.enabled}
                        onChange={(event) => setEventBriefingChannelDraft((current) => (
                          current ? { ...current, enabled: event.target.checked } : current
                        ))}
                      />
                      启用频道
                    </label>
                  </>
                ) : null}
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

                <FormField label="规划批次大小" htmlFor="daily-report-planning-batch-size">
                  <TextInput
                    id="daily-report-planning-batch-size"
                    type="number"
                    min={1}
                    value={dailyReportPlanningBatchSize}
                    onChange={(event) => setDailyReportPlanningBatchSize(event.target.value)}
                    placeholder="留空则完整候选集一次处理"
                  />
                </FormField>

                <FormField label="历史主题召回天数" htmlFor="daily-report-recent-topic-lookback-days">
                  <TextInput
                    id="daily-report-recent-topic-lookback-days"
                    type="number"
                    min={MIN_DAILY_REPORT_RECENT_TOPIC_LOOKBACK_DAYS}
                    value={dailyReportRecentTopicLookbackDays}
                    onChange={(event) => setDailyReportRecentTopicLookbackDays(event.target.value)}
                  />
                </FormField>
              </div>

              <div className="mt-4">
                <FormField label="日报候选频道" htmlFor="daily-report-channel-ids">
                  <SelectField
                    id="daily-report-channel-ids"
                    aria-label="日报候选频道"
                    mode="multiple"
                    multiline
                    className="w-full"
                    placeholder="选择速览频道"
                    value={dailyReportChannelIds}
                    options={eventBriefingChannels
                      .filter((channel) => channel.enabled)
                      .map((channel) => ({
                        value: channel.id,
                        label: channel.name,
                      }))}
                    onChange={(value) => {
                      const nextIds = Array.isArray(value) ? value.map(String) : [];
                      if (nextIds.length === 0) {
                        setDailyReportChannelIds([DEFAULT_DAILY_REPORT_CHANNEL_ID]);
                        return;
                      }
                      const selectedIds = eventBriefingChannels
                        .filter((channel) => channel.enabled)
                        .map((channel) => channel.id)
                        .filter((channelId) => nextIds.includes(channelId));
                      setDailyReportChannelIds(selectedIds.length > 0 ? selectedIds : [DEFAULT_DAILY_REPORT_CHANNEL_ID]);
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
