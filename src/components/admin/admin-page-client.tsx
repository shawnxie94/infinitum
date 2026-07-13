"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

import { GlobalHeader } from "@/components/ui/global-header";
import { AppFooter } from "@/components/ui/app-footer";
import { ContentReviewPanel } from "@/components/admin/content-review-panel";
import { AdminSettingsPanel } from "@/components/admin/admin-settings-panel";
import { TaskMonitorPanel } from "@/components/admin/task-monitor-panel";
import { IngestionDashboard } from "@/components/admin/ingestion-dashboard";
import { ActionItemsPanel } from "@/components/admin/action-items-panel";
import { SelectableButton } from "@/components/ui/selectable-button";
import { SectionToggleButton } from "@/components/ui/section-toggle-button";
import {
  IconTag,
  IconList,
  IconRobot,
  IconNote,
  IconPlug,
  IconShield,
  IconGlobe,
  IconLink,
  IconClock,
  IconArrowUp,
  IconArrowDown,
  IconFilter,
  IconSplit,
  IconMonitor,
} from "@/components/ui/icons";
import type { AdminHeaderLink, AdminSettingsSnapshot, PromptConfigType } from "@/lib/settings/types";
import type { BackgroundTaskRunStatus, TaskRunSnapshot } from "@/lib/tasks/types";

type PrimaryTab = "monitoring" | "settings";
type MonitorSubSection = "action-items" | "dashboard" | "content" | "tasks";
type ContentSubSection = "filtered" | "clusters" | "splits" | "tags";
type SettingsSection = "groups" | "sources" | "navigation" | "ai" | "content" | "tasks";
type AISubSection = "model-api" | "prompt";
type ContentSettingsSubSection = "blacklist" | "event-briefing" | "content-extraction";
type TaskSettingsSubSection = "ingestion" | "daily-report" | "cleanup";

type AdminRouteState = {
  primaryTab: PrimaryTab;
  monitoringSubSection: MonitorSubSection;
  contentSubSection: ContentSubSection;
  settingsSection: SettingsSection;
  aiSubSection: AISubSection;
  contentSettingsSubSection: ContentSettingsSubSection;
  taskSettingsSubSection: TaskSettingsSubSection;
};

type AdminSearchParams = {
  get: (key: string) => string | null;
};

function normalizePrimaryTab(value: string | null): PrimaryTab {
  return value === "settings" ? "settings" : "monitoring";
}

function normalizeMonitorSubSection(value: string | null): MonitorSubSection {
  if (value === "dashboard") {
    return "dashboard";
  }

  if (value === "content") {
    return "content";
  }

  return value === "tasks" ? "tasks" : "action-items";
}

function normalizeContentSubSection(value: string | null): ContentSubSection {
  if (value === "clusters" || value === "splits" || value === "tags") {
    return value;
  }

  return "filtered";
}

function normalizeSettingsSection(value: string | null): SettingsSection {
  if (
    value === "groups" ||
    value === "sources" ||
    value === "navigation" ||
    value === "ai" ||
    value === "content" ||
    value === "tasks"
  ) {
    return value;
  }

  return "groups";
}

function normalizeContentSettingsSubSection(value: string | null): ContentSettingsSubSection {
  if (value === "blacklist") {
    return "blacklist";
  }

  if (value === "event-briefing") {
    return "event-briefing";
  }

  if (value === "content-extraction") {
    return "content-extraction";
  }

  return "blacklist";
}

function normalizeAISubSection(value: string | null): AISubSection {
  return value === "prompt" ? "prompt" : "model-api";
}

function normalizeTaskSettingsSubSection(value: string | null): TaskSettingsSubSection {
  if (value === "daily-report" || value === "cleanup") {
    return value;
  }

  return "ingestion";
}

function normalizePromptType(value: string | null): PromptConfigType {
  if (
    value === "item_understanding" ||
    value === "cluster_summary" ||
    value === "cluster_match" ||
    value === "cluster_merge" ||
    value === "daily_report"
  ) {
    return value;
  }

  return "item_understanding";
}

function normalizeTaskId(value: string | null): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeTaskStatusFilter(value: string | null): BackgroundTaskRunStatus | null {
  if (
    value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "partial" ||
    value === "cancelled"
  ) {
    return value;
  }

  return null;
}

function normalizeTaskKindFilter(value: string | null): TaskRunSnapshot["kind"] | null {
  if (
    value === "ingestion" ||
    value === "precompute" ||
    value === "item_regenerate_translation" ||
    value === "item_regenerate_summary" ||
    value === "item_reanalyze" ||
    value === "cluster_regenerate_summary" ||
    value === "cluster_merge_precompute_clean_pairs" ||
    value === "daily_report_generate" ||
    value === "item_cleanup" ||
    value === "item_reparse_aggregations"
  ) {
    return value;
  }

  return null;
}

function normalizeTaskTimeRangeFilter(value: string | null, rangeDays: string | null): "day1" | "day3" | "day7" | "month" | null {
  if (rangeDays === "1" || value === "today") {
    return "day1";
  }

  if (rangeDays === "3") {
    return "day3";
  }

  if (rangeDays === "7" || value === "week") {
    return "day7";
  }

  if (value === "month") {
    return value;
  }

  return null;
}

function normalizeRangeDays(value: string | null): 1 | 3 | 7 | null {
  if (value === "1" || value === "3" || value === "7") {
    return Number(value) as 1 | 3 | 7;
  }

  return null;
}

function normalizePositiveInteger(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolveRouteState(searchParams: AdminSearchParams): AdminRouteState {
  const primaryTab = normalizePrimaryTab(searchParams.get("tab"));

  if (primaryTab === "monitoring") {
    const monitoringSubSection = normalizeMonitorSubSection(searchParams.get("section"));
    return {
      primaryTab,
      monitoringSubSection,
      contentSubSection: normalizeContentSubSection(searchParams.get("view")),
      settingsSection: "groups",
      aiSubSection: "model-api",
      contentSettingsSubSection: "blacklist",
      taskSettingsSubSection: "ingestion",
    };
  }

  const settingsSection = normalizeSettingsSection(searchParams.get("section"));
  const settingsView = searchParams.get("view");
  return {
    primaryTab,
    monitoringSubSection: "action-items",
    contentSubSection: "filtered",
    settingsSection,
    aiSubSection: normalizeAISubSection(settingsView),
    contentSettingsSubSection: normalizeContentSettingsSubSection(settingsView),
    taskSettingsSubSection: normalizeTaskSettingsSubSection(settingsView),
  };
}

function resolveCollapsedSections(routeState: AdminRouteState) {
  return {
    monitoringContent: !(routeState.primaryTab === "monitoring" && routeState.monitoringSubSection === "content"),
    ai: !(routeState.primaryTab === "settings" && routeState.settingsSection === "ai"),
    content: !(routeState.primaryTab === "settings" && routeState.settingsSection === "content"),
    tasks: !(routeState.primaryTab === "settings" && routeState.settingsSection === "tasks"),
  };
}

export function AdminPageClient({ headerLinks = [] }: { headerLinks?: AdminHeaderLink[] }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Use local state for route so tab navigation doesn't trigger RSC fetch.
  const [routeState, setRouteState] = useState<AdminRouteState>(() =>
    resolveRouteState(searchParams),
  );
  const {
    primaryTab,
    monitoringSubSection,
    contentSubSection,
    settingsSection,
    aiSubSection,
    contentSettingsSubSection,
    taskSettingsSubSection,
  } = routeState;

  // Fetch settings eagerly so all settings sections have data.
  const [settings, setSettings] = useState<AdminSettingsSnapshot | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/settings")
      .then((r) => r.json())
      .then((data: AdminSettingsSnapshot) => {
        if (!cancelled) setSettings(data);
      })
      .catch(() => { /* settings load failed */ });
    return () => { cancelled = true; };
  }, []);

  const focusedTaskId = normalizeTaskId(searchParams.get("task"));
  const taskPage = normalizePositiveInteger(searchParams.get("taskPage"));
  const taskPageSize = normalizePositiveInteger(searchParams.get("taskPageSize"));
  const taskStatusFilter = normalizeTaskStatusFilter(searchParams.get("status"));
  const taskKindFilter = normalizeTaskKindFilter(searchParams.get("kind"));
  const rangeDaysFilter = normalizeRangeDays(searchParams.get("rangeDays"));
  const taskTimeRangeFilter = normalizeTaskTimeRangeFilter(searchParams.get("timeRange"), searchParams.get("rangeDays"));
  const contentPage = normalizePositiveInteger(searchParams.get("contentPage"));
  const contentPageSize = normalizePositiveInteger(searchParams.get("contentPageSize"));
  const shouldOpenClusterReview = searchParams.get("review") === "pending";
  const shouldOpenTagSuggestions = searchParams.get("suggestions") === "open";
  const shouldOpenBriefingPreferenceSuggestions = searchParams.get("suggestions") === "open";
  const shouldOpenSourceAttentionSummary = searchParams.get("sourceSummary") === "open";
  const selectedPromptType = normalizePromptType(searchParams.get("promptType"));
  const [collapsedSections, setCollapsedSections] = useState(() =>
    resolveCollapsedSections(routeState),
  );
  const isAISectionCollapsed = collapsedSections.ai;
  const isSettingsContentSectionCollapsed = collapsedSections.content;
  const isTaskSettingsSectionCollapsed = collapsedSections.tasks;
  const isContentSectionCollapsed = collapsedSections.monitoringContent;

  // Sync route state on browser back/forward (popstate). We listen to
  // popstate directly rather than depending on useSearchParams to avoid
  // reference-churn re-render loops.
  useEffect(() => {
    const handlePopState = () => {
      const nextSearchParams = new URLSearchParams(window.location.search);
      const nextRouteState = resolveRouteState(nextSearchParams);
      setRouteState(nextRouteState);
      setCollapsedSections(resolveCollapsedSections(nextRouteState));
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const navigateAdmin = useCallback((nextState: Partial<AdminRouteState>) => {
    setRouteState((prev) => ({
      primaryTab: nextState.primaryTab ?? prev.primaryTab,
      monitoringSubSection: nextState.monitoringSubSection ?? prev.monitoringSubSection,
      contentSubSection: nextState.contentSubSection ?? prev.contentSubSection,
      settingsSection: nextState.settingsSection ?? prev.settingsSection,
      aiSubSection: nextState.aiSubSection ?? prev.aiSubSection,
      contentSettingsSubSection: nextState.contentSettingsSubSection ?? prev.contentSettingsSubSection,
      taskSettingsSubSection: nextState.taskSettingsSubSection ?? prev.taskSettingsSubSection,
    }));
  }, []);

  // Sync URL to reflect current route state — runs after render, not during
  // the event handler, so Next.js's patched history.replaceState won't
  // trigger a second re-render that causes child re-mounts / double-fetches.
  useEffect(() => {
    const params = new URLSearchParams();
    params.set("tab", routeState.primaryTab);

    if (routeState.primaryTab === "monitoring") {
      params.set("section", routeState.monitoringSubSection);
      if (routeState.monitoringSubSection === "content") {
        params.set("view", routeState.contentSubSection);
        if (rangeDaysFilter && (
          routeState.contentSubSection === "filtered" ||
          routeState.contentSubSection === "splits" ||
          routeState.contentSubSection === "clusters"
        )) {
          params.set("rangeDays", String(rangeDaysFilter));
        }
        if (routeState.contentSubSection === "clusters" && shouldOpenClusterReview) {
          params.set("review", "pending");
        }
        if (routeState.contentSubSection === "tags" && shouldOpenTagSuggestions) {
          params.set("suggestions", "open");
        }
      } else if (routeState.monitoringSubSection === "tasks") {
        if (taskStatusFilter) {
          params.set("status", taskStatusFilter);
        }
        if (taskKindFilter) {
          params.set("kind", taskKindFilter);
        }
        if (taskTimeRangeFilter === "day1" || taskTimeRangeFilter === "day3" || taskTimeRangeFilter === "day7") {
          params.set("rangeDays", taskTimeRangeFilter.replace("day", ""));
        } else if (taskTimeRangeFilter) {
          params.set("timeRange", taskTimeRangeFilter);
        }
        if (taskPage) {
          params.set("taskPage", String(taskPage));
        }
        if (taskPageSize) {
          params.set("taskPageSize", String(taskPageSize));
        }
        if (focusedTaskId) {
          params.set("task", focusedTaskId);
        }
      } else if (
        routeState.monitoringSubSection === "dashboard" &&
        shouldOpenSourceAttentionSummary
      ) {
        params.set("sourceSummary", "open");
      }
    } else {
      params.set("section", routeState.settingsSection);
      if (routeState.settingsSection === "ai") {
        params.set("view", routeState.aiSubSection);
      } else if (routeState.settingsSection === "content") {
        params.set("view", routeState.contentSettingsSubSection);
        if (
          routeState.contentSettingsSubSection === "event-briefing" &&
          shouldOpenBriefingPreferenceSuggestions
        ) {
          params.set("suggestions", "open");
        }
      } else if (routeState.settingsSection === "tasks") {
        params.set("view", routeState.taskSettingsSubSection);
      }
    }

    window.history.replaceState(null, "", `${pathname}?${params.toString()}`);
  }, [
    focusedTaskId,
    pathname,
    routeState,
    rangeDaysFilter,
    shouldOpenClusterReview,
    shouldOpenBriefingPreferenceSuggestions,
    shouldOpenSourceAttentionSummary,
    shouldOpenTagSuggestions,
    taskKindFilter,
    taskPage,
    taskPageSize,
    taskStatusFilter,
    taskTimeRangeFilter,
  ]);

  const navigateTaskDetail = useCallback((taskId: string | null, state?: { page: number; pageSize: number }) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", "monitoring");
    params.set("section", "tasks");
    params.delete("view");

    if (state) {
      params.set("taskPage", String(state.page));
      params.set("taskPageSize", String(state.pageSize));
    }

    if (taskId) {
      params.set("task", taskId);
    } else {
      params.delete("task");
    }
    window.history.replaceState(null, "", `${pathname}?${params.toString()}`);
  }, [pathname, searchParams]);

  const replaceContentPageState = useCallback((state: { page: number; pageSize: number }) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", "monitoring");
    params.set("section", "content");
    params.set("view", contentSubSection);
    params.set("contentPage", String(state.page));
    params.set("contentPageSize", String(state.pageSize));
    window.history.replaceState(null, "", `${pathname}?${params.toString()}`);
  }, [contentSubSection, pathname, searchParams]);

  const navigateTaskFromContent = useCallback((taskId: string, state: { page: number; pageSize: number }) => {
    replaceContentPageState(state);
    window.open(
      `${pathname}?tab=monitoring&section=tasks&task=${encodeURIComponent(taskId)}&taskPage=1&taskPageSize=${taskPageSize ?? 10}`,
      "_blank",
      "noopener,noreferrer",
    );
  }, [pathname, replaceContentPageState, taskPageSize]);

  const handleToggleAISection = useCallback(() => {
    const nextCollapsed = !isAISectionCollapsed;
    setCollapsedSections((prev) =>
      nextCollapsed
        ? { ...prev, ai: true }
        : { ...prev, ai: false, content: true, tasks: true },
    );
    if (!nextCollapsed) {
      navigateAdmin({
        primaryTab: "settings",
        settingsSection: "ai",
        aiSubSection: aiSubSection,
      });
    }
  }, [aiSubSection, isAISectionCollapsed, navigateAdmin]);

  const handleToggleSettingsContentSection = useCallback(() => {
    const nextCollapsed = !isSettingsContentSectionCollapsed;
    setCollapsedSections((prev) =>
      nextCollapsed
        ? { ...prev, content: true }
        : { ...prev, ai: true, content: false, tasks: true },
    );
    if (!nextCollapsed) {
      navigateAdmin({
        primaryTab: "settings",
        settingsSection: "content",
        contentSettingsSubSection,
      });
    }
  }, [contentSettingsSubSection, isSettingsContentSectionCollapsed, navigateAdmin]);

  const handleToggleTaskSettingsSection = useCallback(() => {
    const nextCollapsed = !isTaskSettingsSectionCollapsed;
    setCollapsedSections((prev) =>
      nextCollapsed
        ? { ...prev, tasks: true }
        : { ...prev, ai: true, content: true, tasks: false },
    );
    if (!nextCollapsed) {
      navigateAdmin({
        primaryTab: "settings",
        settingsSection: "tasks",
        taskSettingsSubSection,
      });
    }
  }, [isTaskSettingsSectionCollapsed, navigateAdmin, taskSettingsSubSection]);

  const handleToggleContentSection = useCallback(() => {
    const nextCollapsed = !isContentSectionCollapsed;
    setCollapsedSections((prev) => ({
      ...prev,
      monitoringContent: nextCollapsed,
    }));
    if (!nextCollapsed) {
      navigateAdmin({
        primaryTab: "monitoring",
        monitoringSubSection: "content",
      });
    }
  }, [isContentSectionCollapsed, navigateAdmin]);

  const renderMainContent = () => {
    // Monitoring - Action Items
    if (primaryTab === "monitoring" && monitoringSubSection === "action-items") {
      return <ActionItemsPanel />;
    }

    // Monitoring - Dashboard
    if (primaryTab === "monitoring" && monitoringSubSection === "dashboard") {
      return (
        <IngestionDashboard
          initialOpenSourceAttentionSummary={shouldOpenSourceAttentionSummary}
        />
      );
    }

    // Monitoring - Content Review
    if (primaryTab === "monitoring" && monitoringSubSection === "content") {
      if (contentSubSection === "tags") {
        if (!settings) {
          return (
            <div className="space-y-6 animate-pulse">
              <div className="h-8 w-48 rounded bg-[var(--bg-muted)]" />
              <div className="h-[240px] rounded-sm bg-[var(--bg-muted)]" />
            </div>
          );
        }

        return (
          <AdminSettingsPanel
            initialSettings={settings}
            activeSection="tags"
            embedMode
            initialOpenTagSuggestions={shouldOpenTagSuggestions}
          />
        );
      }

      return (
        <ContentReviewPanel
          embedMode
          activeTab={contentSubSection}
          initialPage={contentPage}
          initialPageSize={contentPageSize}
          initialRangeDays={rangeDaysFilter}
          initialOpenClusterReview={shouldOpenClusterReview}
          onPageStateChange={replaceContentPageState}
          onTaskCreated={navigateTaskFromContent}
        />
      );
    }

    // Monitoring - Tasks
    if (primaryTab === "monitoring" && monitoringSubSection === "tasks") {
      return (
        <TaskMonitorPanel
          initialFocusTaskId={focusedTaskId}
          initialPage={taskPage}
          initialPageSize={taskPageSize}
          initialStatusFilter={taskStatusFilter}
          initialKindFilter={taskKindFilter}
          initialTimeRangeFilter={taskTimeRangeFilter}
          onDetailRouteChange={navigateTaskDetail}
        />
      );
    }

    // Settings tabs need loaded data; show skeleton while fetching.
    if (primaryTab === "settings" && !settings) {
      return (
        <div className="space-y-6 animate-pulse">
          <div className="h-8 w-48 rounded bg-[var(--bg-muted)]" />
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-[88px] rounded-sm bg-[var(--bg-muted)]" />
            ))}
          </div>
        </div>
      );
    }

    // Settings - AI Section
    if (primaryTab === "settings" && settingsSection === "ai") {
      if (aiSubSection === "model-api") {
        return (
          <AdminSettingsPanel
            initialSettings={settings!}
            activeSection="ai-model-api"
            embedMode
          />
        );
      }
      if (aiSubSection === "prompt") {
        return (
          <AdminSettingsPanel
            initialSettings={settings!}
            activeSection="ai-prompt"
            initialPromptType={selectedPromptType}
            embedMode
          />
        );
      }
    }

    // Settings - Content Management
    if (
      primaryTab === "settings" &&
      settingsSection === "content" &&
      contentSettingsSubSection === "blacklist"
    ) {
      return <AdminSettingsPanel initialSettings={settings!} activeSection="blacklist" embedMode />;
    }

    if (
      primaryTab === "settings" &&
      settingsSection === "content" &&
      contentSettingsSubSection === "event-briefing"
    ) {
      return (
        <AdminSettingsPanel
          initialSettings={settings!}
          activeSection="event-briefing"
          embedMode
          initialOpenBriefingPreferenceSuggestions={shouldOpenBriefingPreferenceSuggestions}
        />
      );
    }

    // Settings - Groups
    if (primaryTab === "settings" && settingsSection === "groups") {
      return <AdminSettingsPanel initialSettings={settings!} activeSection="groups" embedMode />;
    }

    // Settings - Sources
    if (primaryTab === "settings" && settingsSection === "sources") {
      return <AdminSettingsPanel initialSettings={settings!} activeSection="sources" embedMode />;
    }

    if (primaryTab === "settings" && settingsSection === "navigation") {
      return <AdminSettingsPanel initialSettings={settings!} activeSection="header-links" embedMode />;
    }

    if (
      primaryTab === "settings" &&
      settingsSection === "content" &&
      contentSettingsSubSection === "content-extraction"
    ) {
      return <AdminSettingsPanel initialSettings={settings!} activeSection="content-extraction" embedMode />;
    }

    if (primaryTab === "settings" && settingsSection === "tasks") {
      if (taskSettingsSubSection === "daily-report") {
        return <AdminSettingsPanel initialSettings={settings!} activeSection="task-daily-report" embedMode />;
      }

      if (taskSettingsSubSection === "cleanup") {
        return <AdminSettingsPanel initialSettings={settings!} activeSection="task-cleanup" embedMode />;
      }

      return <AdminSettingsPanel initialSettings={settings!} activeSection="task-ingestion" embedMode />;
    }

    return null;
  };

  return (
    <>
      <GlobalHeader activeNav="admin" isAdmin={true} customLinks={headerLinks} />
      <div className="flex min-h-screen flex-col bg-[var(--background)]">
        <div className="max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 pt-6">
          <div className="flex gap-1 border-b border-[color:var(--line)]">
            <SelectableButton
              onClick={() => {
                setCollapsedSections((prev) => ({
                  ...prev,
                  monitoringContent: true,
                }));
                navigateAdmin({
                  primaryTab: "monitoring",
                  monitoringSubSection: "action-items",
                });
              }}
              active={primaryTab === "monitoring"}
              variant="tab"
            >
              监控
            </SelectableButton>
            <SelectableButton
              onClick={() => {
                setCollapsedSections((prev) => ({
                  ...prev,
                  ai: true,
                  content: true,
                  tasks: true,
                }));
                navigateAdmin({
                  primaryTab: "settings",
                  settingsSection: "groups",
                });
              }}
              active={primaryTab === "settings"}
              variant="tab"
            >
              设置
            </SelectableButton>
          </div>
        </div>

        <div className="max-w-7xl mx-auto w-full flex-1 px-4 sm:px-6 lg:px-8 py-6">
          <div className="flex min-w-0 flex-col gap-6 lg:flex-row">
            <aside className="w-full flex-shrink-0 lg:w-64">
              <div className="bg-[var(--surface)] rounded-lg shadow-[var(--shadow-sm)] border border-[color:var(--line)] p-4">
                <h2 className="font-semibold text-[var(--foreground)] mb-4">
                  {primaryTab === "monitoring" ? "监控模块" : "设置模块"}
                </h2>
                <div className="space-y-2">
                  {primaryTab === "monitoring" ? (
                    <>
                      <SelectableButton
                        onClick={() => {
                          setCollapsedSections((prev) => ({
                            ...prev,
                            monitoringContent: true,
                          }));
                          navigateAdmin({
                            primaryTab: "monitoring",
                            monitoringSubSection: "action-items",
                          });
                        }}
                        active={monitoringSubSection === "action-items"}
                        variant="menu"
                      >
                        <span className="inline-flex items-center gap-2">
                          <IconNote className="h-4 w-4" />
                          <span>待办事项</span>
                        </span>
                      </SelectableButton>

                      <SelectableButton
                        onClick={() => {
                          setCollapsedSections((prev) => ({
                            ...prev,
                            monitoringContent: true,
                          }));
                          navigateAdmin({
                            primaryTab: "monitoring",
                            monitoringSubSection: "dashboard",
                          });
                        }}
                        active={monitoringSubSection === "dashboard"}
                        variant="menu"
                      >
                        <span className="inline-flex items-center gap-2">
                          <IconMonitor className="h-4 w-4" />
                          <span>数据监控</span>
                        </span>
                      </SelectableButton>

                      <SectionToggleButton
                        label="内容审核"
                        active={monitoringSubSection === "content"}
                        expanded={!isContentSectionCollapsed}
                        onMainClick={handleToggleContentSection}
                        onToggle={handleToggleContentSection}
                        toggleAriaLabel={isContentSectionCollapsed ? "展开" : "收起"}
                        icon={<IconShield className="h-4 w-4" />}
                        expandedIndicator={<IconArrowUp className="h-4 w-4" />}
                        collapsedIndicator={<IconArrowDown className="h-4 w-4" />}
                      />

                      {!isContentSectionCollapsed && (
                        <>
                          <SelectableButton
                            onClick={() => {
                              setCollapsedSections((prev) => ({
                                ...prev,
                                monitoringContent: false,
                              }));
                              navigateAdmin({
                                primaryTab: "monitoring",
                                monitoringSubSection: "content",
                                contentSubSection: "filtered",
                              });
                            }}
                            active={
                              monitoringSubSection === "content" &&
                              contentSubSection === "filtered"
                            }
                            variant="submenu"
                          >
                            <span className="inline-flex items-center gap-2">
                              <IconFilter className="h-4 w-4" />
                              <span>过滤内容</span>
                            </span>
                          </SelectableButton>
                          <SelectableButton
                            onClick={() => {
                              setCollapsedSections((prev) => ({
                                ...prev,
                                monitoringContent: false,
                              }));
                              navigateAdmin({
                                primaryTab: "monitoring",
                                monitoringSubSection: "content",
                                contentSubSection: "tags",
                              });
                            }}
                            active={
                              monitoringSubSection === "content" &&
                              contentSubSection === "tags"
                            }
                            variant="submenu"
                          >
                            <span className="inline-flex items-center gap-2">
                              <IconTag className="h-4 w-4" />
                              <span>标签管理</span>
                            </span>
                          </SelectableButton>
                          <SelectableButton
                            onClick={() => {
                              setCollapsedSections((prev) => ({
                                ...prev,
                                monitoringContent: false,
                              }));
                              navigateAdmin({
                                primaryTab: "monitoring",
                                monitoringSubSection: "content",
                                contentSubSection: "clusters",
                              });
                            }}
                            active={
                              monitoringSubSection === "content" &&
                              contentSubSection === "clusters"
                            }
                            variant="submenu"
                          >
                            <span className="inline-flex items-center gap-2">
                              <IconGlobe className="h-4 w-4" />
                              <span>聚合管理</span>
                            </span>
                          </SelectableButton>
                          <SelectableButton
                            onClick={() => {
                              setCollapsedSections((prev) => ({
                                ...prev,
                                monitoringContent: false,
                              }));
                              navigateAdmin({
                                primaryTab: "monitoring",
                                monitoringSubSection: "content",
                                contentSubSection: "splits",
                              });
                            }}
                            active={
                              monitoringSubSection === "content" &&
                              contentSubSection === "splits"
                            }
                            variant="submenu"
                          >
                            <span className="inline-flex items-center gap-2">
                              <IconSplit className="h-4 w-4" />
                              <span>聚合拆分</span>
                            </span>
                          </SelectableButton>
                        </>
                      )}

                      <SelectableButton
                        onClick={() => {
                          setCollapsedSections((prev) => ({
                            ...prev,
                            monitoringContent: true,
                          }));
                          navigateAdmin({
                            primaryTab: "monitoring",
                            monitoringSubSection: "tasks",
                          });
                        }}
                        active={monitoringSubSection === "tasks"}
                        variant="menu"
                      >
                        <span className="inline-flex items-center gap-2">
                          <IconList className="h-4 w-4" />
                          <span>任务监控</span>
                        </span>
                      </SelectableButton>
                    </>
                  ) : (
                    <>
                      <SelectableButton
                        onClick={() => {
                          setCollapsedSections((prev) => ({
                            ...prev,
                            ai: true,
                            content: true,
                            tasks: true,
                          }));
                          navigateAdmin({
                            primaryTab: "settings",
                            settingsSection: "groups",
                          });
                        }}
                        active={settingsSection === "groups"}
                        variant="menu"
                      >
                        <span className="inline-flex items-center gap-2">
                          <IconTag className="h-4 w-4" />
                          <span>分组管理</span>
                        </span>
                      </SelectableButton>

                      <SelectableButton
                        onClick={() => {
                          setCollapsedSections((prev) => ({
                            ...prev,
                            ai: true,
                            content: true,
                            tasks: true,
                          }));
                          navigateAdmin({
                            primaryTab: "settings",
                            settingsSection: "sources",
                          });
                        }}
                        active={settingsSection === "sources"}
                        variant="menu"
                      >
                        <span className="inline-flex items-center gap-2">
                          <IconGlobe className="h-4 w-4" />
                          <span>信息源管理</span>
                        </span>
                      </SelectableButton>

                      <SelectableButton
                        onClick={() => {
                          setCollapsedSections((prev) => ({
                            ...prev,
                            ai: true,
                            content: true,
                            tasks: true,
                          }));
                          navigateAdmin({
                            primaryTab: "settings",
                            settingsSection: "navigation",
                          });
                        }}
                        active={settingsSection === "navigation"}
                        variant="menu"
                      >
                        <span className="inline-flex items-center gap-2">
                          <IconLink className="h-4 w-4" />
                          <span>导航栏配置</span>
                        </span>
                      </SelectableButton>

                      <SectionToggleButton
                        label="AI配置"
                        active={settingsSection === "ai"}
                        expanded={!isAISectionCollapsed}
                        onMainClick={handleToggleAISection}
                        onToggle={handleToggleAISection}
                        toggleAriaLabel={isAISectionCollapsed ? "展开" : "收起"}
                        icon={<IconRobot className="h-4 w-4" />}
                        expandedIndicator={<IconArrowUp className="h-4 w-4" />}
                        collapsedIndicator={<IconArrowDown className="h-4 w-4" />}
                      />

                      {!isAISectionCollapsed && (
                        <>
                          <SelectableButton
                            onClick={() => {
                              setCollapsedSections((prev) => ({
                                ...prev,
                                ai: false,
                                content: true,
                                tasks: true,
                              }));
                              navigateAdmin({
                                primaryTab: "settings",
                                settingsSection: "ai",
                                aiSubSection: "model-api",
                              });
                            }}
                            active={
                              settingsSection === "ai" &&
                              aiSubSection === "model-api"
                            }
                            variant="submenu"
                          >
                            <span className="inline-flex items-center gap-2">
                              <IconPlug className="h-4 w-4" />
                              <span>模型API</span>
                            </span>
                          </SelectableButton>
                          <SelectableButton
                            onClick={() => {
                              setCollapsedSections((prev) => ({
                                ...prev,
                                ai: false,
                                content: true,
                                tasks: true,
                              }));
                              navigateAdmin({
                                primaryTab: "settings",
                                settingsSection: "ai",
                                aiSubSection: "prompt",
                              });
                            }}
                            active={
                              settingsSection === "ai" &&
                              aiSubSection === "prompt"
                            }
                            variant="submenu"
                          >
                            <span className="inline-flex items-center gap-2">
                              <IconNote className="h-4 w-4" />
                              <span>提示词</span>
                            </span>
                          </SelectableButton>
                        </>
                      )}

                      <SectionToggleButton
                        label="内容管理"
                        active={settingsSection === "content"}
                        expanded={!isSettingsContentSectionCollapsed}
                        onMainClick={handleToggleSettingsContentSection}
                        onToggle={handleToggleSettingsContentSection}
                        toggleAriaLabel={isSettingsContentSectionCollapsed ? "展开" : "收起"}
                        icon={<IconShield className="h-4 w-4" />}
                        expandedIndicator={<IconArrowUp className="h-4 w-4" />}
                        collapsedIndicator={<IconArrowDown className="h-4 w-4" />}
                      />

                      {!isSettingsContentSectionCollapsed && (
                        <>
                          <SelectableButton
                            onClick={() => {
                              setCollapsedSections((prev) => ({
                                ...prev,
                                ai: true,
                                content: false,
                                tasks: true,
                              }));
                              navigateAdmin({
                                primaryTab: "settings",
                                settingsSection: "content",
                                contentSettingsSubSection: "blacklist",
                              });
                            }}
                            active={
                              settingsSection === "content" &&
                              contentSettingsSubSection === "blacklist"
                            }
                            variant="submenu"
                          >
                            <span className="inline-flex items-center gap-2">
                              <IconShield className="h-4 w-4" />
                              <span>黑名单</span>
                            </span>
                          </SelectableButton>
                          <SelectableButton
                            onClick={() => {
                              setCollapsedSections((prev) => ({
                                ...prev,
                                ai: true,
                                content: false,
                                tasks: true,
                              }));
                              navigateAdmin({
                                primaryTab: "settings",
                                settingsSection: "content",
                                contentSettingsSubSection: "content-extraction",
                              });
                            }}
                            active={
                              settingsSection === "content" &&
                              contentSettingsSubSection === "content-extraction"
                            }
                            variant="submenu"
                          >
                            <span className="inline-flex items-center gap-2">
                              <IconLink className="h-4 w-4" />
                              <span>正文解析</span>
                            </span>
                          </SelectableButton>
                          <SelectableButton
                            onClick={() => {
                              setCollapsedSections((prev) => ({
                                ...prev,
                                ai: true,
                                content: false,
                                tasks: true,
                              }));
                              navigateAdmin({
                                primaryTab: "settings",
                                settingsSection: "content",
                                contentSettingsSubSection: "event-briefing",
                              });
                            }}
                            active={
                              settingsSection === "content" &&
                              contentSettingsSubSection === "event-briefing"
                            }
                            variant="submenu"
                          >
                            <span className="inline-flex items-center gap-2">
                              <IconList className="h-4 w-4" />
                              <span>速览配置</span>
                            </span>
                          </SelectableButton>
                        </>
                      )}

                      <SectionToggleButton
                        label="任务配置"
                        active={settingsSection === "tasks"}
                        expanded={!isTaskSettingsSectionCollapsed}
                        onMainClick={handleToggleTaskSettingsSection}
                        onToggle={handleToggleTaskSettingsSection}
                        toggleAriaLabel={isTaskSettingsSectionCollapsed ? "展开" : "收起"}
                        icon={<IconClock className="h-4 w-4" />}
                        expandedIndicator={<IconArrowUp className="h-4 w-4" />}
                        collapsedIndicator={<IconArrowDown className="h-4 w-4" />}
                      />

                      {!isTaskSettingsSectionCollapsed && (
                        <>
                          <SelectableButton
                            onClick={() => {
                              setCollapsedSections((prev) => ({
                                ...prev,
                                ai: true,
                                content: true,
                                tasks: false,
                              }));
                              navigateAdmin({
                                primaryTab: "settings",
                                settingsSection: "tasks",
                                taskSettingsSubSection: "ingestion",
                              });
                            }}
                            active={
                              settingsSection === "tasks" &&
                              taskSettingsSubSection === "ingestion"
                            }
                            variant="submenu"
                          >
                            <span className="inline-flex items-center gap-2">
                              <IconList className="h-4 w-4" />
                              <span>采集任务</span>
                            </span>
                          </SelectableButton>
                          <SelectableButton
                            onClick={() => {
                              setCollapsedSections((prev) => ({
                                ...prev,
                                ai: true,
                                content: true,
                                tasks: false,
                              }));
                              navigateAdmin({
                                primaryTab: "settings",
                                settingsSection: "tasks",
                                taskSettingsSubSection: "daily-report",
                              });
                            }}
                            active={
                              settingsSection === "tasks" &&
                              taskSettingsSubSection === "daily-report"
                            }
                            variant="submenu"
                          >
                            <span className="inline-flex items-center gap-2">
                              <IconNote className="h-4 w-4" />
                              <span>日报任务</span>
                            </span>
                          </SelectableButton>
                          <SelectableButton
                            onClick={() => {
                              setCollapsedSections((prev) => ({
                                ...prev,
                                ai: true,
                                content: true,
                                tasks: false,
                              }));
                              navigateAdmin({
                                primaryTab: "settings",
                                settingsSection: "tasks",
                                taskSettingsSubSection: "cleanup",
                              });
                            }}
                            active={
                              settingsSection === "tasks" &&
                              taskSettingsSubSection === "cleanup"
                            }
                            variant="submenu"
                          >
                            <span className="inline-flex items-center gap-2">
                              <IconClock className="h-4 w-4" />
                              <span>清理任务</span>
                            </span>
                          </SelectableButton>
                        </>
                      )}
                    </>
                  )}
                </div>
              </div>
            </aside>

            {/* Main Content - matches Lumina structure */}
            <main className="flex-1 w-full min-w-0">
              <div className="bg-[var(--surface)] rounded-sm shadow-[var(--shadow-sm)] border border-[color:var(--line)] p-6 w-full min-w-0">
                {renderMainContent()}
              </div>
            </main>
          </div>
        </div>
        <AppFooter />
      </div>
    </>
  );
}
