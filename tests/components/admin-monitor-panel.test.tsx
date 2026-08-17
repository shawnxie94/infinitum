import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "@/components/ui/toast";
import type { BackgroundTaskMonitorSnapshot } from "@/lib/tasks/types";
const { pushMock, refreshMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  refreshMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushMock,
    refresh: refreshMock,
  }),
}));

import { AdminMonitorPanel } from "@/components/admin/admin-monitor-panel";

function renderWithProviders(node: ReactNode) {
  return render(<ToastProvider>{node}</ToastProvider>);
}

afterEach(() => {
  vi.useRealTimers();
  pushMock.mockReset();
  refreshMock.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AdminMonitorPanel", () => {
  const initialSnapshot: BackgroundTaskMonitorSnapshot = {
    schedule: {
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
      timezone: "Asia/Shanghai",
      lastHeartbeatAt: "2026-04-12T00:00:00.000Z",
      lastRunStartedAt: null,
      lastRunFinishedAt: null,
      lastRunStatus: null,
      nextRunAt: "2026-04-12T01:00:00.000Z",
      cleanupRetentionDays: 365,
      isHeartbeatStale: false,
    },
    runningTasks: [
      {
        id: "task-1",
        kind: "ingestion",
        triggerType: "manual",
        status: "running",
        label: "默认抓取任务",
        entityId: null,
        progressCurrent: 3,
        progressTotal: 10,
        progressLabel: "已处理 3/10 条内容，来自 1 个源，失败 0 项",
        itemsAdded: 3,
        aiCallCountActual: 2,
        aiCallCountEstimated: 6,
        startedAt: "2026-04-12T00:30:00.000Z",
        finishedAt: null,
        cancelRequestedAt: null,
        errorSummary: null,
        stageTimings: [],
      },
    ],
    recentTasks: [],
  };

  it("renders the monitor workspace with aligned global and sidebar navigation", () => {
    renderWithProviders(<AdminMonitorPanel initialSnapshot={initialSnapshot} />);

    expect(screen.getByRole("navigation", { name: "主导航" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "主页" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "管理" })).toHaveAttribute("href", "/admin");
    expect(screen.getByRole("heading", { name: "任务监控", level: 1 })).toBeInTheDocument();
    expect(screen.queryByText("Task Monitor")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "调度设置" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "运行中任务" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "最近任务" })).toBeInTheDocument();
    expect(screen.getAllByText("默认抓取任务")[0]).toBeInTheDocument();
    expect(screen.getByLabelText("Cron 表达式")).toHaveValue("0 * * * *");
    expect(screen.getByLabelText("源抓取并发")).toHaveValue(2);
    expect(screen.getByLabelText("正文补抓阈值")).toHaveValue(80);
    expect(screen.getByText("已处理 3/10 条内容，来自 1 个源，失败 0 项")).toBeInTheDocument();
    expect(screen.getByText("AI 调用：2 / 6")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "终止任务" })).toBeInTheDocument();
  });

  it("submits schedule changes", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            schedule: {
              ...initialSnapshot.schedule,
              enabled: false,
              cronExpression: "*/15 * * * *",
              sourceConcurrency: 4,
              fullTextFetchThreshold: 120,
              aggregationSplitMaxEvents: 12,
            },
          }),
        ),
      );

    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<AdminMonitorPanel initialSnapshot={initialSnapshot} />);

    await user.clear(screen.getByLabelText("Cron 表达式"));
    await user.type(screen.getByLabelText("Cron 表达式"), "*/15 * * * *");
    await user.clear(screen.getByLabelText("源抓取并发"));
    await user.type(screen.getByLabelText("源抓取并发"), "4");
    await user.clear(screen.getByLabelText("正文补抓阈值"));
    await user.type(screen.getByLabelText("正文补抓阈值"), "120");
    await user.clear(screen.getByLabelText("单条聚合拆分上限"));
    await user.type(screen.getByLabelText("单条聚合拆分上限"), "12");
    await user.click(screen.getByLabelText("启用默认抓取任务"));
    await user.click(screen.getByRole("button", { name: "保存调度设置" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/monitor/schedule/ingestion-default", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          enabled: false,
          cronExpression: "*/15 * * * *",
          sourceConcurrency: 4,
          fullTextFetchThreshold: 120,
          perSourceItemLimit: 20,
          aggregationSplitMaxEvents: 12,
          processingStartAt: null,
        }),
      });
    });
  });

  it("shows an error banner when saving schedule changes fails", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("network down"));

    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<AdminMonitorPanel initialSnapshot={initialSnapshot} />);

    await user.click(screen.getByRole("button", { name: "保存调度设置" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("调度配置保存失败。");
    });
  });

  it("keeps dirty schedule form values when polling refreshes snapshot", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ...initialSnapshot,
          schedule: {
            ...initialSnapshot.schedule,
            enabled: true,
            cronExpression: "0 * * * *",
            sourceConcurrency: 2,
            fullTextFetchThreshold: 80,
            nextRunAt: "2026-04-12T02:00:00.000Z",
          },
        }),
      ),
    );

    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<AdminMonitorPanel initialSnapshot={initialSnapshot} />);

    const intervalInput = screen.getByLabelText("Cron 表达式");
    const sourceConcurrencyInput = screen.getByLabelText("源抓取并发");
    const fullTextFetchThresholdInput = screen.getByLabelText("正文补抓阈值");
    const enabledCheckbox = screen.getByLabelText("启用默认抓取任务");

    fireEvent.change(intervalInput, { target: { value: "*/15 * * * *" } });
    fireEvent.change(sourceConcurrencyInput, { target: { value: "5" } });
    fireEvent.change(fullTextFetchThresholdInput, { target: { value: "140" } });
    fireEvent.click(enabledCheckbox);

    expect(intervalInput).toHaveValue("*/15 * * * *");
    expect(sourceConcurrencyInput).toHaveValue(5);
    expect(fullTextFetchThresholdInput).toHaveValue(140);
    expect(enabledCheckbox).not.toBeChecked();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledWith("/api/admin/monitor");

    expect(intervalInput).toHaveValue("*/15 * * * *");
    expect(sourceConcurrencyInput).toHaveValue(5);
    expect(fullTextFetchThresholdInput).toHaveValue(140);
    expect(enabledCheckbox).not.toBeChecked();
  });

  it("submits a cancel request for a running task", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            task: {
              ...initialSnapshot.runningTasks[0],
              cancelRequestedAt: "2026-04-12T00:31:00.000Z",
            },
          }),
        ),
      );

    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<AdminMonitorPanel initialSnapshot={initialSnapshot} />);

    await user.click(screen.getByRole("button", { name: "终止任务" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/monitor/tasks/task-1/cancel", {
        method: "POST",
      });
    });

    expect(screen.getByRole("button", { name: "终止中" })).toBeDisabled();
  });
});
