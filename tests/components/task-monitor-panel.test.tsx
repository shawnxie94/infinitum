import type { ReactNode } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TaskMonitorPanel } from "@/components/admin/task-monitor-panel";
import { ToastProvider } from "@/components/ui/toast";
import type { BackgroundTaskMonitorSnapshot } from "@/lib/tasks/types";

function renderWithProviders(node: ReactNode) {
  return render(<ToastProvider>{node}</ToastProvider>);
}

function buildMonitorSnapshot(): BackgroundTaskMonitorSnapshot {
  return {
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
      lastHeartbeatAt: null,
      lastRunStartedAt: null,
      lastRunFinishedAt: null,
      lastRunStatus: "running",
      nextRunAt: "2026-04-21T01:00:00.000Z",
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
        progressCurrent: 2,
        progressTotal: 10,
        progressLabel: "已处理 2/10 条内容，来自 1 个源，失败 0 项，正文补抓 2 篇",
        itemsAdded: 1,
        fullTextFetchedCount: 2,
        aiCallCountActual: 1,
        aiCallCountEstimated: 5,
        aiCallBreakdown: [
          {
            key: "item_understanding",
            label: "条目理解",
            actual: 1,
            estimated: 2,
          },
          {
            key: "cluster_match",
            label: "聚合匹配",
            actual: 0,
            estimated: 2,
          },
          {
            key: "cluster_summary",
            label: "聚合摘要",
            actual: 0,
            estimated: 1,
          },
        ],
        cancelRequestedAt: null,
        startedAt: "2026-04-21T00:00:00.000Z",
        finishedAt: null,
        errorSummary: null,
        stageTimings: [
          {
            key: "source_sync",
            label: "信息源同步",
            startedAt: "2026-04-21T00:00:00.000Z",
            finishedAt: "2026-04-21T00:00:08.000Z",
            durationMs: 8_000,
          },
          {
            key: "item_processing",
            label: "内容处理",
            startedAt: "2026-04-21T00:00:08.000Z",
            finishedAt: null,
            durationMs: null,
          },
        ],
        taskTimeline: [
          {
            key: "source_fetch",
            label: "信息抓取",
            status: "succeeded",
            startedAt: "2026-04-21T00:00:00.000Z",
            finishedAt: "2026-04-21T00:00:08.000Z",
            durationMs: 8_000,
            metrics: [
              { label: "抓取源", value: 1 },
              { label: "抓取内容", value: 10 },
              { label: "正文补抓", value: 2 },
            ],
          },
          {
            key: "rule_filter",
            label: "规则过滤",
            status: "running",
            startedAt: "2026-04-21T00:00:08.000Z",
            finishedAt: null,
            durationMs: null,
            metrics: [
              { label: "命中黑名单", value: 2 },
              { label: "复用已有处理", value: 1 },
            ],
          },
          {
            key: "item_understanding",
            label: "条目理解",
            status: "partial",
            startedAt: "2026-04-21T00:00:08.000Z",
            finishedAt: null,
            durationMs: null,
            modelName: "gpt-4.1-mini-understanding",
            metrics: [
              { label: "摘要完成", value: 5 },
              { label: "摘要失败", value: 1 },
              { label: "分析完成", value: 4 },
              { label: "分析失败", value: 0 },
              { label: "拆分成功", value: 1 },
              { label: "拆分失败", value: 0 },
              { label: "子事件", value: 12 },
              { label: "过滤", value: 2 },
              { label: "更新/重处理", value: 1 },
            ],
          },
          {
            key: "cluster_assignment",
            label: "归组决策",
            status: "running",
            startedAt: "2026-04-21T00:00:08.000Z",
            finishedAt: null,
            durationMs: null,
            modelName: "gpt-4.1-mini-match",
            metrics: [
              { label: "指纹命中", value: 1 },
              { label: "本地直连", value: 2 },
              { label: "AI归组", value: 1 },
              { label: "跳过", value: 0 },
              { label: "新建", value: 1 },
            ],
          },
          {
            key: "cluster_merge",
            label: "聚合合并",
            status: "succeeded",
            startedAt: null,
            finishedAt: null,
            durationMs: null,
            modelName: "gpt-4.1-mini-merge",
            metrics: [
              { label: "基础池", value: 120 },
              { label: "本地Pair", value: 240 },
              { label: "对象冲突", value: 30 },
              { label: "日期冲突", value: 10 },
              { label: "无锚点", value: 80 },
              { label: "低分", value: 60 },
              { label: "相关Pair", value: 60 },
              { label: "AI候选Pair", value: 12 },
              { label: "Hash跳过", value: 4 },
              { label: "预计算Pair", value: 0 },
              { label: "预计算限次", value: 0 },
              { label: "预计算失效", value: 0 },
              { label: "Dirty Pair", value: 8 },
              { label: "裁剪前", value: 18 },
              { label: "候选组", value: 12 },
              { label: "Dirty候选", value: 5 },
              { label: "送模Pair", value: 12 },
              { label: "输入字符", value: 84545 },
              { label: "刷新数量ms", value: 120 },
              { label: "加载候选ms", value: 80 },
              { label: "候选计算ms", value: 70000 },
              { label: "构造输入ms", value: 1 },
              { label: "模型调用ms", value: 180000 },
              { label: "执行合并ms", value: 400 },
              { label: "标记Hashms", value: 90 },
              { label: "AI返回组", value: 2 },
              { label: "跳过", value: 0 },
              { label: "合并后", value: 9 },
              { label: "移动条目", value: 6 },
              { label: "失败组", value: 1 },
            ],
          },
          {
            key: "cluster_finalize",
            label: "聚合收尾",
            status: "running",
            startedAt: "2026-04-21T00:00:08.000Z",
            finishedAt: null,
            durationMs: null,
            modelName: "gpt-4.1-mini-cluster",
            metrics: [
              { label: "参与重算", value: 2 },
              { label: "完成更新", value: 2 },
              { label: "摘要完成", value: 1 },
              { label: "摘要失败", value: 0 },
              { label: "已删除", value: 0 },
            ],
          },
        ],
      },
    ],
    recentTasks: [],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("TaskMonitorPanel", () => {
  it("opens the task detail modal from the initial focus task id", async () => {
    renderWithProviders(
      <TaskMonitorPanel
        runningTasks={buildMonitorSnapshot().runningTasks}
        recentTasks={buildMonitorSnapshot().recentTasks}
        initialFocusTaskId="task-1"
      />,
    );

    const dialog = await screen.findByRole("dialog", { name: "任务详情" });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText("默认抓取任务")).toBeInTheDocument();
    expect(dialog.querySelector(".overflow-y-auto.p-6")).toBeTruthy();
    expect(within(dialog).queryByText("AI 调用")).not.toBeInTheDocument();
    expect(within(dialog).getByText("信息抓取")).toBeInTheDocument();
    expect(within(dialog).getAllByText("规则过滤").length).toBeGreaterThan(0);
    expect(within(dialog).getByText("条目理解 · 模型 gpt-4.1-mini-understanding")).toBeInTheDocument();
    expect(within(dialog).getByText("归组决策 · 模型 gpt-4.1-mini-match")).toBeInTheDocument();
    expect(within(dialog).getByText("聚合合并 · 模型 gpt-4.1-mini-merge")).toBeInTheDocument();
    expect(within(dialog).getByText("聚合收尾 · 模型 gpt-4.1-mini-cluster")).toBeInTheDocument();
    expect(within(dialog).queryByText("进度")).not.toBeInTheDocument();
    expect(within(dialog).getByText("摘要")).toBeInTheDocument();
    expect(
      within(dialog).getByText("7/10 已精确分类 = 1 (最终新增) + 2 (AI 过滤) + 1 (更新/重处理) + 1 (重复过滤) + 2 (规则过滤)"),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("抓取 1 个源 · 10 篇内容 · 正文补抓 2 篇")).toBeInTheDocument();
    expect(within(dialog).getByText("规则过滤 2 · 复用 1")).toBeInTheDocument();
    expect(within(dialog).getByText("摘要 5/1 · 分析 4/0 · 拆分 1/0 · 子事件 12 · 过滤 2 · 更新/重处理 1")).toBeInTheDocument();
    expect(within(dialog).getByText("指纹命中 1 · 本地直连 2 · AI归组 1 · 跳过 0 · 新建 1")).toBeInTheDocument();
    expect(within(dialog).getByText("候选 12/18 · Dirty 5 · Hash跳过 4 · AI返回 2 · 移动 6 · 失败 1 · 已合并 · 合并后 9 组")).toBeInTheDocument();
    expect(within(dialog).getByText("参与重算 2 · 完成更新 2 · 摘要完成 1 · 摘要失败 0 · 已删除 0")).toBeInTheDocument();
  });

  it("keeps finished ingestion summaries closed when reused items include filtered records", async () => {
    renderWithProviders(
      <TaskMonitorPanel
        runningTasks={[]}
        recentTasks={[
          {
            ...buildMonitorSnapshot().runningTasks[0],
            id: "task-production-regression",
            status: "succeeded",
            progressCurrent: 74,
            progressTotal: 91,
            progressLabel: "已处理 74/91 条内容，来自 113 个源，失败 0 项，正文补抓 18 篇",
            itemsAdded: 10,
            fullTextFetchedCount: 18,
            startedAt: "2026-06-19T09:00:00.909Z",
            finishedAt: "2026-06-19T09:21:21.854Z",
            taskTimeline: [
              {
                key: "source_fetch",
                label: "信息抓取",
                status: "succeeded",
                startedAt: "2026-06-19T09:00:00.950Z",
                finishedAt: "2026-06-19T09:02:15.358Z",
                durationMs: 134_408,
                metrics: [
                  { label: "抓取源", value: 113 },
                  { label: "抓取内容", value: 91 },
                  { label: "正文补抓", value: 18 },
                ],
              },
              {
                key: "rule_filter",
                label: "规则过滤",
                status: "succeeded",
                startedAt: "2026-06-19T09:02:15.456Z",
                finishedAt: "2026-06-19T09:17:06.032Z",
                durationMs: 890_576,
                metrics: [
                  { label: "命中规则过滤", value: 0 },
                  { label: "复用已有处理", value: 57 },
                ],
              },
              {
                key: "item_understanding",
                label: "内容分析",
                status: "succeeded",
                startedAt: "2026-06-19T09:02:15.456Z",
                finishedAt: "2026-06-19T09:17:06.032Z",
                durationMs: 890_576,
                metrics: [
                  { label: "完成", value: 34 },
                  { label: "过滤", value: 5 },
                  { label: "更新/重处理", value: 19 },
                ],
              },
            ],
          },
        ]}
        initialFocusTaskId="task-production-regression"
      />,
    );

    const dialog = await screen.findByRole("dialog", { name: "任务详情" });
    expect(
      within(dialog).getByText("91 = 10 (最终新增) + 5 (AI 过滤) + 19 (更新/重处理) + 57 (重复过滤)"),
    ).toBeInTheDocument();
  });

  it("separates source fetch failures from the content processing summary", async () => {
    renderWithProviders(
      <TaskMonitorPanel
        runningTasks={[]}
        recentTasks={[
          {
            ...buildMonitorSnapshot().runningTasks[0],
            id: "task-source-failure-regression",
            status: "partial",
            progressCurrent: 43,
            progressTotal: 55,
            progressLabel: "已处理 43/55 条内容，来自 113 个源，失败 3 项，正文补抓 7 篇",
            itemsAdded: 5,
            fullTextFetchedCount: 7,
            errorSummary: "TLTD: RSS fetch failed with status 502 | AI Breakfast: RSS fetch failed with status 502 | AI Valley: RSS fetch failed with status 502",
            startedAt: "2026-06-19T12:00:00.684Z",
            finishedAt: "2026-06-19T12:12:10.000Z",
            taskTimeline: [
              {
                key: "source_fetch",
                label: "信息抓取",
                status: "succeeded",
                startedAt: "2026-06-19T12:00:00.711Z",
                finishedAt: "2026-06-19T12:05:05.867Z",
                durationMs: 305_156,
                metrics: [
                  { label: "抓取源", value: 113 },
                  { label: "抓取内容", value: 55 },
                  { label: "正文补抓", value: 7 },
                ],
              },
              {
                key: "rule_filter",
                label: "规则过滤",
                status: "succeeded",
                startedAt: "2026-06-19T12:05:05.919Z",
                finishedAt: "2026-06-19T12:08:03.750Z",
                durationMs: 177_831,
                metrics: [
                  { label: "命中规则过滤", value: 0 },
                  { label: "复用已有处理", value: 36 },
                ],
              },
              {
                key: "item_understanding",
                label: "内容分析",
                status: "succeeded",
                startedAt: "2026-06-19T12:05:05.919Z",
                finishedAt: "2026-06-19T12:08:03.750Z",
                durationMs: 177_831,
                metrics: [
                  { label: "完成", value: 19 },
                  { label: "过滤", value: 0 },
                ],
              },
            ],
          },
        ]}
        initialFocusTaskId="task-source-failure-regression"
      />,
    );

    const dialog = await screen.findByRole("dialog", { name: "任务详情" });
    expect(
      within(dialog).getByText("41/55 已精确分类 = 5 (最终新增) + 0 (AI 过滤) + 更新/重处理暂无精确数据 + 36 (重复过滤)；源抓取失败 3 个"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("抓取 113 个源 · 失败 3 个源 · 55 篇内容 · 正文补抓 7 篇"),
    ).toBeInTheDocument();
  });

  it("keeps explicit content failures when source failures are also present", async () => {
    renderWithProviders(
      <TaskMonitorPanel
        runningTasks={[]}
        recentTasks={[
          {
            ...buildMonitorSnapshot().runningTasks[0],
            id: "task-mixed-failures",
            status: "partial",
            progressCurrent: 55,
            progressTotal: 55,
            progressLabel: "已处理 55/55 条内容，来自 113 个源，内容失败 2 项，源失败 3 个，正文补抓 7 篇",
            itemsAdded: 5,
            fullTextFetchedCount: 7,
            errorSummary: "TLTD: RSS fetch failed with status 502 | AI Breakfast: RSS fetch failed with status 502 | AI Valley: RSS fetch failed with status 502",
            startedAt: "2026-06-19T12:00:00.684Z",
            finishedAt: "2026-06-19T12:12:10.000Z",
            taskTimeline: [
              {
                key: "source_fetch",
                label: "信息抓取",
                status: "partial",
                startedAt: "2026-06-19T12:00:00.711Z",
                finishedAt: "2026-06-19T12:05:05.867Z",
                durationMs: 305_156,
                metrics: [
                  { label: "抓取源", value: 113 },
                  { label: "失败源", value: 3 },
                  { label: "抓取内容", value: 55 },
                  { label: "正文补抓", value: 7 },
                ],
              },
              {
                key: "rule_filter",
                label: "规则过滤",
                status: "succeeded",
                startedAt: "2026-06-19T12:05:05.919Z",
                finishedAt: "2026-06-19T12:08:03.750Z",
                durationMs: 177_831,
                metrics: [
                  { label: "命中规则过滤", value: 0 },
                  { label: "复用已有处理", value: 36 },
                ],
              },
              {
                key: "item_understanding",
                label: "内容分析",
                status: "partial",
                startedAt: "2026-06-19T12:05:05.919Z",
                finishedAt: "2026-06-19T12:08:03.750Z",
                durationMs: 177_831,
                metrics: [
                  { label: "过滤", value: 0 },
                  { label: "更新/重处理", value: 12 },
                ],
              },
            ],
          },
        ]}
        initialFocusTaskId="task-mixed-failures"
      />,
    );

    const dialog = await screen.findByRole("dialog", { name: "任务详情" });
    expect(
      within(dialog).getByText("55 = 5 (最终新增) + 0 (AI 过滤) + 12 (更新/重处理) + 36 (重复过滤) + 2 (处理失败)；源抓取失败 3 个"),
    ).toBeInTheDocument();
  });

  it("shows item or cluster title in regeneration task details", async () => {
    renderWithProviders(
      <TaskMonitorPanel
        runningTasks={[]}
        recentTasks={[
          {
            ...buildMonitorSnapshot().runningTasks[0],
            id: "task-item",
            kind: "item_regenerate_summary",
            label: "重生成摘要",
            entityId: "item-1",
            entityTitle: "单条新闻标题",
            status: "succeeded",
            startedAt: "2026-04-21T00:00:00.000Z",
            finishedAt: "2026-04-21T00:00:10.000Z",
          },
        ]}
        initialFocusTaskId="task-item"
      />,
    );

    const dialog = await screen.findByRole("dialog", { name: "任务详情" });
    expect(within(dialog).getByText("条目标题:")).toBeInTheDocument();
    expect(within(dialog).getByText("单条新闻标题")).toBeInTheDocument();
  });

  it("shows reanalysis result in the completed task detail node", async () => {
    renderWithProviders(
      <TaskMonitorPanel
        runningTasks={[]}
        recentTasks={[
          {
            ...buildMonitorSnapshot().runningTasks[0],
            id: "task-reanalyze-result",
            kind: "item_reanalyze",
            label: "重新 AI 判定",
            entityId: "item-1",
            entityTitle: "单条新闻标题",
            status: "succeeded",
            progressLabel: "已完成重新 AI 判定（聚合 · 子事件 2 · 处理成功）",
            startedAt: "2026-04-21T00:00:00.000Z",
            finishedAt: "2026-04-21T00:00:10.000Z",
            stageTimings: [],
            taskTimeline: [],
          },
        ]}
        initialFocusTaskId="task-reanalyze-result"
      />,
    );

    const dialog = await screen.findByRole("dialog", { name: "任务详情" });
    expect(within(dialog).getByText("已完成")).toBeInTheDocument();
    expect(
      within(dialog).getByText("已完成重新 AI 判定（聚合 · 子事件 2 · 处理成功）"),
    ).toBeInTheDocument();
  });

  it("lists every task kind in the type filter and filters cleanup tasks precisely", async () => {
    const user = userEvent.setup();
    const baseTask = buildMonitorSnapshot().runningTasks[0];
    const recentTasks: BackgroundTaskMonitorSnapshot["recentTasks"] = [
      { ...baseTask, id: "task-ingestion", kind: "ingestion", label: "默认抓取任务", status: "succeeded" },
      { ...baseTask, id: "task-generic-precompute", kind: "precompute", label: "预计算", status: "succeeded" },
      { ...baseTask, id: "task-reanalyze", kind: "item_reanalyze", label: "内容重分析", status: "succeeded" },
      { ...baseTask, id: "task-summary", kind: "item_regenerate_summary", label: "摘要重生成", status: "succeeded" },
      { ...baseTask, id: "task-translation", kind: "item_regenerate_translation", label: "译文重生成", status: "succeeded" },
      { ...baseTask, id: "task-cluster", kind: "cluster_regenerate_summary", label: "聚合摘要重生成", status: "succeeded" },
      { ...baseTask, id: "task-precompute", kind: "cluster_merge_precompute_clean_pairs", label: "合并候选预计算", status: "succeeded" },
      { ...baseTask, id: "task-daily", kind: "daily_report_generate", label: "AI 日报生成", status: "succeeded" },
      { ...baseTask, id: "task-cleanup", kind: "item_cleanup", label: "清理历史文章", status: "succeeded" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            ...buildMonitorSnapshot(),
            runningTasks: [],
            recentTasks,
            recentTotal: recentTasks.length,
          }),
        ),
      ),
    );

    renderWithProviders(
      <TaskMonitorPanel
        runningTasks={[]}
        recentTasks={recentTasks}
      />,
    );

    const kindSelect = screen.getByLabelText("任务类型") as HTMLSelectElement;
    expect(Array.from(kindSelect.options).map((option) => option.textContent)).toEqual([
      "全部",
      "抓取任务",
      "预计算",
      "内容重分析",
      "抓取失败补偿",
      "摘要重生成",
      "译文重生成",
      "聚合摘要重生成",
      "合并候选预计算",
      "AI 日报生成",
      "文章自动清理",
      "聚合内容重拆",
    ]);

    expect(within(await screen.findByRole("table")).getAllByText("合并候选预计算")).toHaveLength(2);

    await user.selectOptions(kindSelect, "item_cleanup");

    expect(screen.getByText("清理历史文章")).toBeInTheDocument();
    expect(screen.getAllByText("文章自动清理")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /默认抓取任务/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /内容重分析/ })).not.toBeInTheDocument();
  });

  it("keeps current pagination when opening a task detail route", async () => {
    const user = userEvent.setup();
    const onDetailRouteChange = vi.fn();
    const recentTasks = Array.from({ length: 12 }, (_, index) => ({
      ...buildMonitorSnapshot().runningTasks[0],
      id: `task-${index + 1}`,
      status: "succeeded" as const,
      startedAt: "2026-04-21T00:00:00.000Z",
      finishedAt: "2026-04-21T00:00:10.000Z",
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            ...buildMonitorSnapshot(),
            runningTasks: [],
            recentTasks,
            recentTotal: recentTasks.length,
          }),
        ),
      ),
    );

    renderWithProviders(
      <TaskMonitorPanel
        runningTasks={[]}
        recentTasks={recentTasks}
        initialPage={2}
        initialPageSize={10}
        onDetailRouteChange={onDetailRouteChange}
      />,
    );

    await user.click(await screen.findByRole("button", { name: /默认抓取任务\s+#task-11/ }));

    expect(onDetailRouteChange).toHaveBeenLastCalledWith("task-11", {
      page: 2,
      pageSize: 10,
    });
  });

  it("renders the next page returned by the monitor API without carrying running tasks into every page", async () => {
    const user = userEvent.setup();
    const baseTask = buildMonitorSnapshot().runningTasks[0];
    const pageOneTasks = Array.from({ length: 10 }, (_, index) => ({
      ...baseTask,
      id: `page-1-task-${index + 1}`,
      label: `第一页任务 ${index + 1}`,
      status: "succeeded" as const,
      startedAt: "2026-04-21T00:00:00.000Z",
      finishedAt: "2026-04-21T00:00:10.000Z",
    }));
    const pageTwoTasks = [
      {
        ...baseTask,
        id: "page-2-task-1",
        label: "第二页任务 1",
        status: "succeeded" as const,
        startedAt: "2026-04-20T00:00:00.000Z",
        finishedAt: "2026-04-20T00:00:10.000Z",
      },
      {
        ...baseTask,
        id: "page-2-task-2",
        label: "第二页任务 2",
        status: "succeeded" as const,
        startedAt: "2026-04-20T00:00:00.000Z",
        finishedAt: "2026-04-20T00:00:10.000Z",
      },
    ];
    const runningTask = {
      ...baseTask,
      id: "running-task",
      label: "运行中但不属于当前页",
      status: "running" as const,
    };
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = new URL(String(input), "http://localhost");
      const requestedPage = Number(url.searchParams.get("page")) || 1;

      return Promise.resolve(
        new Response(
          JSON.stringify({
            ...buildMonitorSnapshot(),
            runningTasks: [runningTask],
            recentTasks: requestedPage === 2 ? pageTwoTasks : pageOneTasks,
            recentTotal: 12,
            page: requestedPage,
            pageSize: 10,
          }),
        ),
      );
    });

    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<TaskMonitorPanel runningTasks={[]} recentTasks={[]} />);

    expect(await screen.findByText("第一页任务 1")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "下一页" }));

    expect(await screen.findByText("第二页任务 1")).toBeInTheDocument();
    expect(screen.getByText("第二页任务 2")).toBeInTheDocument();
    expect(screen.queryByText("第一页任务 1")).not.toBeInTheDocument();
    expect(screen.queryByText("运行中但不属于当前页")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenLastCalledWith("/api/admin/monitor?page=2&pageSize=10");
  });

  it("refreshes task progress from the task detail modal", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ...buildMonitorSnapshot(),
          runningTasks: [
            {
              ...buildMonitorSnapshot().runningTasks[0],
              progressCurrent: 4,
              progressLabel: "已处理 4/10 条内容，来自 1 个源，失败 0 项，正文补抓 3 篇",
              itemsAdded: 3,
              fullTextFetchedCount: 3,
              taskTimeline: [
                {
                  key: "source_fetch",
                  label: "信息抓取",
                  status: "succeeded",
                  startedAt: "2026-04-21T00:00:00.000Z",
                  finishedAt: "2026-04-21T00:00:08.000Z",
                  durationMs: 8_000,
                  metrics: [
                    { label: "抓取源", value: 1 },
                    { label: "抓取内容", value: 10 },
                    { label: "正文补抓", value: 3 },
                  ],
                },
                {
                  key: "rule_filter",
                  label: "规则过滤",
                  status: "running",
                  startedAt: "2026-04-21T00:00:08.000Z",
                  finishedAt: null,
                  durationMs: null,
                  metrics: [
                    { label: "命中黑名单", value: 2 },
                    { label: "复用已有处理", value: 1 },
                  ],
                },
              ],
            },
          ],
        }),
      ),
    );

    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(
      <TaskMonitorPanel
        runningTasks={buildMonitorSnapshot().runningTasks}
        recentTasks={buildMonitorSnapshot().recentTasks}
        initialFocusTaskId="task-1"
      />,
    );

    await screen.findByRole("dialog", { name: "任务详情" });
    await user.click(screen.getByTitle("刷新进度"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/admin/monitor?page="));
    });

    const dialog = await screen.findByRole("dialog", { name: "任务详情" });
    expect(
      await within(dialog).findByText("抓取 1 个源 · 10 篇内容 · 正文补抓 3 篇"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("规则过滤 2 · 复用 1"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("6/10 已精确分类 = 3 (最终新增) + 0 (AI 过滤) + 更新/重处理暂无精确数据 + 1 (重复过滤) + 2 (规则过滤)"),
    ).toBeInTheDocument();
  });

  it("opens daily report recovery choices and submits the selected stage", async () => {
    const user = userEvent.setup();
    const dailyReportTask = {
      ...buildMonitorSnapshot().runningTasks[0],
      id: "daily-report-failed",
      kind: "daily_report_generate" as const,
      label: "AI 日报生成 2026-04-21",
      entityId: "2026-04-21",
      status: "succeeded" as const,
      startedAt: "2026-04-21T00:00:00.000Z",
      finishedAt: "2026-04-21T00:02:00.000Z",
      errorSummary: null,
      pipelineCheckpoint: {
        version: 1 as const,
        pipelineVersion: "daily-report-topic-first-v2",
        stage: "validate",
        completedStages: ["prepare", "assess", "merge", "plan", "plan_validate", "write"],
        inputHash: "input",
        templateSignature: "template",
        candidateSnapshotHash: "candidates",
        resumeEligible: true,
        assessmentBatches: [{ index: 0, candidateIds: [1], status: "succeeded" as const, attempt: 1 }],
        ledger: { schemaVersion: 1 },
        planningCandidateBriefs: [{ candidateId: 1 }],
        plan: { schemaVersion: 2, sections: [] },
        draft: { headline: "旧草稿", blocks: [] },
        violations: [{ code: "draft_topic_missing", stage: "draft" as const, message: "缺少主题" }],
      },
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        ...buildMonitorSnapshot(),
        runningTasks: [],
        recentTasks: [dailyReportTask],
        recentTotal: 1,
      })),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(
      <TaskMonitorPanel runningTasks={[]} recentTasks={[dailyReportTask]} />,
    );

    await screen.findByText("AI 日报生成 2026-04-21");
    await user.click(screen.getByTitle("重新生成"));
    const dialog = await screen.findByRole("dialog", { name: "选择日报重试方式" });
    const recoverySelect = within(dialog).getByLabelText("日报重试方式");
    expect(recoverySelect).toHaveValue("write");
    expect(within(dialog).getByRole("option", { name: "全部重试" })).toBeInTheDocument();
    expect(within(dialog).getByRole("option", { name: "从 WRITE 继续" })).toBeInTheDocument();
    expect(within(dialog).queryByText("从 REPAIR 继续")).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/推荐/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/当前 checkpoint/)).not.toBeInTheDocument();

    await user.selectOptions(recoverySelect, "write");
    await user.click(within(dialog).getByRole("button", { name: "确认重试" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/monitor/tasks/daily-report-failed/retrigger",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ retryFrom: "write" }),
        }),
      );
    });
  });
});
