import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminSettingsSnapshot } from "@/lib/settings/types";

const {
  openMock,
  pathnameMock,
  searchParamsState,
} = vi.hoisted(() => ({
  openMock: vi.fn(),
  pathnameMock: "/admin",
  searchParamsState: {
    value: "",
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameMock,
  useSearchParams: () => new URLSearchParams(searchParamsState.value),
}));

vi.mock("@/components/ui/global-header", () => ({
  GlobalHeader: () => <div>Global Header</div>,
}));

vi.mock("@/components/admin/content-review-panel", () => ({
  ContentReviewPanel: ({
    activeTab,
    initialPage,
    initialPageSize,
  }: {
    activeTab: string;
    initialPage?: number | null;
    initialPageSize?: number | null;
  }) => (
    <div>{`内容审核:${activeTab}:${initialPage ?? "none"}:${initialPageSize ?? "none"}`}</div>
  ),
}));

vi.mock("@/components/admin/task-monitor-panel", () => ({
  TaskMonitorPanel: ({
    initialFocusTaskId,
  }: {
    initialFocusTaskId?: string | null;
  }) => <div>{`任务监控面板:${initialFocusTaskId ?? "none"}`}</div>,
}));

vi.mock("@/components/admin/ingestion-dashboard", () => ({
  IngestionDashboard: ({
    initialOpenSourceAttentionSummary,
  }: {
    initialOpenSourceAttentionSummary?: boolean;
  }) => (
    <div>
      数据监控面板
      {initialOpenSourceAttentionSummary ? <span>打开信息源异常摘要</span> : null}
    </div>
  ),
}));

vi.mock("@/components/admin/action-items-panel", () => ({
  ActionItemsPanel: () => <div>待办事项面板</div>,
}));

vi.mock("@/components/admin/admin-settings-panel", () => ({
  AdminSettingsPanel: ({
    activeSection,
    initialOpenBriefingPreferenceSuggestions,
  }: {
    activeSection: string;
    initialOpenBriefingPreferenceSuggestions?: boolean;
  }) => (
    <div>
      {`设置面板:${activeSection}`}
      {initialOpenBriefingPreferenceSuggestions ? <span>打开偏好建议</span> : null}
    </div>
  ),
}));

import { AdminPageClient } from "@/components/admin/admin-page-client";

function buildInitialSettings(): AdminSettingsSnapshot {
  return {
    modelApiConfigs: [],
    promptConfigs: [],
    eventBriefing: {
      config: {
        id: "event-briefing-config",
        minRankScore: 0,
        channels: [
          {
            id: "important",
            name: "重点事件",
            sourceGroupIds: [],
            enabled: true,
            sortOrder: 0,
          },
        ],
        createdAt: "2026-04-20T10:00:00.000Z",
        updatedAt: "2026-04-20T10:00:00.000Z",
      },
      preference: {
        id: "briefing-preference-config",
        weightedRules: [],
        maxCuratorBoost: 15,
        maxCuratorPenalty: 20,
        createdAt: "2026-04-20T10:00:00.000Z",
        updatedAt: "2026-04-20T10:00:00.000Z",
      },
    },
    contentExtraction: {
      id: "content-extraction-1",
      jinaEnabled: false,
      jinaBaseUrl: "https://r.jina.ai/",
      jinaApiKeyMasked: "",
      hasJinaApiKey: false,
      timeoutMs: 15000,
      concurrency: 1,
      rpmLimit: 10,
      maxPerRun: 20,
      minChars: 500,
      maxChars: 32000,
      createdAt: "2026-04-20T10:00:00.000Z",
      updatedAt: "2026-04-20T10:00:00.000Z",
    },
    blacklistKeywords: [],
    taskSchedule: {
      key: "ingestion_default",
      enabled: true,
      cronExpression: "0 * * * *",
      sourceConcurrency: 2,
      fullTextFetchThreshold: 80,
      perSourceItemLimit: 20,
      aggregationSplitMaxEvents: 20,
      dailyReportCandidateLimit: 120,
      dailyReportOffsetDays: 0,
      dailyReportAutoPublish: false,
      dailyReportMaxRetries: 0,
      dailyReportChannelIds: ["important"],
      timezone: "Asia/Shanghai",
      lastHeartbeatAt: null,
      lastRunStartedAt: null,
      lastRunFinishedAt: null,
      lastRunStatus: null,
      nextRunAt: "2026-04-21T00:00:00.000Z",
      cleanupRetentionDays: 365,
      isHeartbeatStale: false,
    },
    dailyReportSchedule: {
      key: "daily_report_default",
      enabled: false,
      cronExpression: "30 8 * * *",
      sourceConcurrency: 2,
      fullTextFetchThreshold: 80,
      perSourceItemLimit: 20,
      aggregationSplitMaxEvents: 20,
      dailyReportCandidateLimit: 120,
      dailyReportOffsetDays: 0,
      dailyReportAutoPublish: false,
      dailyReportMaxRetries: 0,
      dailyReportChannelIds: ["important"],
      timezone: "Asia/Shanghai",
      lastHeartbeatAt: null,
      lastRunStartedAt: null,
      lastRunFinishedAt: null,
      lastRunStatus: null,
      nextRunAt: "2026-04-21T00:30:00.000Z",
      cleanupRetentionDays: 365,
      isHeartbeatStale: false,
    },
    itemCleanupSchedule: {
      key: "item_cleanup_default",
      enabled: false,
      cronExpression: "0 3 * * *",
      cleanupRetentionDays: 365,
      timezone: "Asia/Shanghai",
      lastHeartbeatAt: null,
      lastRunStartedAt: null,
      lastRunFinishedAt: null,
      lastRunStatus: null,
      nextRunAt: "2026-04-22T03:00:00.000Z",
      isHeartbeatStale: false,
    },
    groups: [],
    sources: [],
  };
}

function renderAdminPageClient() {
  // Stub the settings API fetch that AdminPageClient calls on mount.
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
    new Response(JSON.stringify(buildInitialSettings())),
  ));

  return render(<AdminPageClient />);
}

let replaceStateSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  replaceStateSpy = vi.fn();
  vi.stubGlobal("history", {
    ...window.history,
    replaceState: replaceStateSpy,
  });
});

afterEach(() => {
  openMock.mockReset();
  searchParamsState.value = "";
  vi.unstubAllGlobals();
});

describe("AdminPageClient", () => {
  it("restores the current settings tab from the url query", async () => {
    searchParamsState.value = "tab=settings&section=tasks";

    renderAdminPageClient();

    await waitFor(() => {
      expect(screen.getByText("设置模块")).toBeInTheDocument();
    });
    expect(screen.getByText("设置面板:task-ingestion")).toBeInTheDocument();
  });

  it("restores the content extraction settings section from the url query", async () => {
    searchParamsState.value = "tab=settings&section=content&view=content-extraction";

    renderAdminPageClient();

    await waitFor(() => {
      expect(screen.getByText("设置模块")).toBeInTheDocument();
    });
    expect(screen.getByText("设置面板:content-extraction")).toBeInTheDocument();
  });

  it("restores event briefing preference suggestions from the url query", async () => {
    searchParamsState.value = "tab=settings&section=content&view=event-briefing&suggestions=open";

    renderAdminPageClient();

    await waitFor(() => {
      expect(screen.getByText("设置面板:event-briefing")).toBeInTheDocument();
    });
    expect(screen.getByText("打开偏好建议")).toBeInTheDocument();
    expect(replaceStateSpy).toHaveBeenLastCalledWith(
      null,
      "",
      "/admin?tab=settings&section=content&view=event-briefing&suggestions=open",
    );
  });

  it("restores task subsections from the url query", async () => {
    searchParamsState.value = "tab=settings&section=tasks&view=daily-report";

    renderAdminPageClient();

    await waitFor(() => {
      expect(screen.getByText("设置模块")).toBeInTheDocument();
    });
    expect(screen.getByText("设置面板:task-daily-report")).toBeInTheDocument();
  });

  it("restores the current monitoring sub tab from the url query", () => {
    searchParamsState.value = "tab=monitoring&section=content&view=clusters";

    renderAdminPageClient();

    expect(screen.getByText("内容审核:clusters:none:none")).toBeInTheDocument();
  });

  it("defaults monitoring to action items", () => {
    searchParamsState.value = "tab=monitoring";

    renderAdminPageClient();

    expect(screen.getByText("待办事项面板")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "待办事项" })).toBeInTheDocument();
  });

  it("shows a desktop-first notice for mobile admin browsing", () => {
    searchParamsState.value = "tab=monitoring";

    renderAdminPageClient();

    expect(
      screen.getByText("管理后台优先适配桌面端。移动端主要用于内容查看；复杂配置与批量操作建议在电脑上完成。"),
    ).toBeInTheDocument();
  });

  it("restores entity management as a monitoring content sub tab", async () => {
    searchParamsState.value = "tab=monitoring&section=content&view=entities";

    renderAdminPageClient();

    await waitFor(() => {
      expect(screen.getByText("设置面板:entities")).toBeInTheDocument();
    });
  });

  it("passes content pagination from the url into the content review panel", () => {
    searchParamsState.value = "tab=monitoring&section=content&view=clusters&contentPage=3&contentPageSize=20";

    renderAdminPageClient();

    expect(screen.getByText("内容审核:clusters:3:20")).toBeInTheDocument();
  });

  it("passes the task id from the url query into the task monitor panel", () => {
    searchParamsState.value = "tab=monitoring&section=tasks&task=task-123";

    renderAdminPageClient();

    expect(screen.getByText("任务监控面板:task-123")).toBeInTheDocument();
  });

  it("pushes the selected settings tab into the url", async () => {
    const user = userEvent.setup();
    searchParamsState.value = "tab=settings&section=ai&view=model-api";

    renderAdminPageClient();

    await waitFor(() => {
      expect(screen.getByText("设置面板:ai-model-api")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "任务配置" }));

    expect(replaceStateSpy).toHaveBeenLastCalledWith(
      null,
      "",
      "/admin?tab=settings&section=tasks&view=ingestion",
    );
  });

  it("shows content extraction in the settings menu and updates the url when selected", async () => {
    const user = userEvent.setup();
    searchParamsState.value = "tab=settings&section=ai&view=model-api";

    renderAdminPageClient();

    await waitFor(() => {
      expect(screen.getByText("设置面板:ai-model-api")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "内容管理" }));
    await user.click(screen.getByRole("button", { name: "正文解析" }));

    expect(screen.getByText("设置面板:content-extraction")).toBeInTheDocument();
    expect(replaceStateSpy).toHaveBeenLastCalledWith(
      null,
      "",
      "/admin?tab=settings&section=content&view=content-extraction",
    );
  });

  it("collapses an expanded settings group when clicking it again", async () => {
    const user = userEvent.setup();
    searchParamsState.value = "tab=settings&section=ai&view=model-api";

    renderAdminPageClient();

    await waitFor(() => {
      expect(screen.getByText("设置面板:ai-model-api")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "模型API" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "AI配置" }));

    expect(screen.queryByRole("button", { name: "模型API" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "提示词" })).not.toBeInTheDocument();
  });

  it("collapses unrelated settings groups when switching sections", async () => {
    const user = userEvent.setup();
    searchParamsState.value = "tab=settings&section=content&view=content-extraction";

    renderAdminPageClient();

    await waitFor(() => {
      expect(screen.getByText("设置面板:content-extraction")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "黑名单" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "正文解析" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "任务配置" }));

    expect(screen.queryByRole("button", { name: "黑名单" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "正文解析" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "采集任务" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "日报任务" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "清理任务" })).toBeInTheDocument();
  });

  it("collapses monitoring content review when clicking it again", async () => {
    const user = userEvent.setup();
    searchParamsState.value = "tab=monitoring&section=content&view=filtered";

    renderAdminPageClient();

    expect(screen.getByText("内容审核:filtered:none:none")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "过滤内容" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "聚合管理" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "实体管理" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "内容审核" }));

    expect(screen.queryByRole("button", { name: "过滤内容" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "聚合管理" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "聚合拆分" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "实体管理" })).not.toBeInTheDocument();
  });

  it("collapses monitoring content review when switching to task monitoring", async () => {
    const user = userEvent.setup();
    searchParamsState.value = "tab=monitoring&section=content&view=clusters";

    renderAdminPageClient();

    expect(screen.getByText("内容审核:clusters:none:none")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "聚合管理" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "任务监控" }));

    expect(screen.getByText("任务监控面板:none")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "过滤内容" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "聚合管理" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "聚合拆分" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "实体管理" })).not.toBeInTheDocument();
  });

  it("updates the url when selecting a monitoring sub tab", async () => {
    const user = userEvent.setup();
    searchParamsState.value = "tab=monitoring&section=content";

    renderAdminPageClient();

    await user.click(screen.getByRole("button", { name: "聚合管理" }));

    expect(replaceStateSpy).toHaveBeenLastCalledWith(
      null,
      "",
      "/admin?tab=monitoring&section=content&view=clusters",
    );
  });

  it("updates the url when selecting action items", async () => {
    const user = userEvent.setup();
    searchParamsState.value = "tab=monitoring&section=dashboard";

    renderAdminPageClient();

    await user.click(screen.getByRole("button", { name: "待办事项" }));

    expect(screen.getByText("待办事项面板")).toBeInTheDocument();
    expect(replaceStateSpy).toHaveBeenLastCalledWith(
      null,
      "",
      "/admin?tab=monitoring&section=action-items",
    );
  });

  it("opens source attention summary from the dashboard route", () => {
    searchParamsState.value = "tab=monitoring&section=dashboard&sourceSummary=open";

    renderAdminPageClient();

    expect(screen.getByText("数据监控面板")).toBeInTheDocument();
    expect(screen.getByText("打开信息源异常摘要")).toBeInTheDocument();
    expect(replaceStateSpy).toHaveBeenLastCalledWith(
      null,
      "",
      "/admin?tab=monitoring&section=dashboard&sourceSummary=open",
    );
  });

  it("updates the url when selecting entity management", async () => {
    const user = userEvent.setup();
    searchParamsState.value = "tab=monitoring&section=content";

    renderAdminPageClient();

    await user.click(screen.getByRole("button", { name: "实体管理" }));

    await waitFor(() => {
      expect(screen.getByText("设置面板:entities")).toBeInTheDocument();
    });
    expect(replaceStateSpy).toHaveBeenLastCalledWith(
      null,
      "",
      "/admin?tab=monitoring&section=content&view=entities",
    );
  });

  it("defaults to action items when an unknown monitoring section is in the url", () => {
    searchParamsState.value = "tab=monitoring&section=sources";

    renderAdminPageClient();

    expect(screen.getByText("待办事项面板")).toBeInTheDocument();
  });
});
