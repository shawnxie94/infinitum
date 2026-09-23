import { afterEach, describe, expect, it, vi } from "vitest";

const requireAdmin = vi.fn();
const getBackgroundTaskMonitorSnapshot = vi.fn();
const getSourceMonitorSnapshot = vi.fn();
const updateDefaultIngestionSchedule = vi.fn();
const requestTaskRunCancellation = vi.fn();
const getTaskRun = vi.fn();
const attachTaskEntityTitles = vi.fn();
const enqueueTaskRun = vi.fn();

vi.mock("@/lib/admin/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admin/session")>();

  return {
    ...actual,
    requireAdmin,
  };
});

vi.mock("@/lib/tasks/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tasks/service")>();

  return {
    ...actual,
    getBackgroundTaskMonitorSnapshot,
    getTaskRun,
    attachTaskEntityTitles,
    enqueueTaskRun,
    updateDefaultIngestionSchedule,
    requestTaskRunCancellation,
  };
});

vi.mock("@/lib/source-monitor/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/source-monitor/service")>();

  return {
    ...actual,
    getSourceMonitorSnapshot,
  };
});

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe("/api/admin/monitor", () => {
  it("returns schedule, running tasks and recent tasks", async () => {
    requireAdmin.mockResolvedValue(undefined);
    getBackgroundTaskMonitorSnapshot.mockResolvedValue({
      schedule: {
        key: "ingestion_default",
        enabled: true,
        cronExpression: "0 * * * *",
        sourceConcurrency: 2,
        fullTextFetchThreshold: 80,
        timezone: "Asia/Shanghai",
        lastHeartbeatAt: "2026-04-12T00:00:00.000Z",
        lastRunStartedAt: null,
        lastRunFinishedAt: null,
        lastRunStatus: null,
        nextRunAt: "2026-04-12T01:00:00.000Z",
        isHeartbeatStale: false,
      },
      runningTasks: [],
      recentTasks: [],
    });

    const { GET } = await import("@/app/api/admin/monitor/route");
    const response = await GET(new Request("http://localhost/api/admin/monitor"));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.schedule.key).toBe("ingestion_default");
    expect(Array.isArray(json.runningTasks)).toBe(true);
    expect(Array.isArray(json.recentTasks)).toBe(true);
  });

  it("returns source monitor health and inactivity snapshot", async () => {
    requireAdmin.mockResolvedValue(undefined);
    getSourceMonitorSnapshot.mockResolvedValue({
      generatedAt: "2026-04-21T00:00:00.000Z",
      totalEnabledSourceCount: 1,
      filteredSourceCount: 1,
      pagination: {
        page: 1,
        pageSize: 10,
        totalItems: 1,
        totalPages: 1,
      },
      sources: [
        {
          id: "source-1",
          name: "异常源",
          rssUrl: "https://example.com/feed.xml",
          siteUrl: "https://example.com",
          groupName: null,
          healthStatus: "failed",
          healthMessage: "RSS fetch failed with status 500",
          healthCheckedAt: "2026-04-21T00:00:00.000Z",
          lastFetchedAt: null,
          lastItemCreatedAt: null,
          inactiveDays: null,
          itemCount: 0,
        },
      ],
      health: {
        healthyCount: 0,
        failedCount: 1,
        unknownCount: 0,
        attentionSources: [],
      },
      inactivityBuckets: [],
      groups: [{ value: "all", label: "全部", count: 1 }],
    });

    const { GET } = await import("@/app/api/admin/monitor/sources/route");
    const response = await GET(new Request("http://localhost/api/admin/monitor/sources?page=2&pageSize=20&healthStatus=failed&inactivity=year&groupName=%E6%9C%AA%E5%88%86%E7%BB%84"));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(getSourceMonitorSnapshot).toHaveBeenCalledWith(expect.any(Date), {
      page: 2,
      pageSize: 20,
      healthStatus: "failed",
      inactivity: "year",
      groupName: "未分组",
    });
    expect(json.health.failedCount).toBe(1);
    expect(json.sources[0].name).toBe("异常源");
  });

  it("normalizes invalid source monitor query params", async () => {
    requireAdmin.mockResolvedValue(undefined);
    getSourceMonitorSnapshot.mockResolvedValue({
      generatedAt: "2026-04-21T00:00:00.000Z",
      totalEnabledSourceCount: 0,
      filteredSourceCount: 0,
      pagination: {
        page: 1,
        pageSize: 10,
        totalItems: 0,
        totalPages: 1,
      },
      sources: [],
      health: {
        healthyCount: 0,
        failedCount: 0,
        unknownCount: 0,
        attentionSources: [],
      },
      inactivityBuckets: [],
      groups: [{ value: "all", label: "全部", count: 0 }],
    });

    const { GET } = await import("@/app/api/admin/monitor/sources/route");
    const response = await GET(
      new Request("http://localhost/api/admin/monitor/sources?page=-1&pageSize=999&healthStatus=bad&inactivity=nope&groupName=all"),
    );

    expect(response.status).toBe(200);
    expect(getSourceMonitorSnapshot).toHaveBeenCalledWith(expect.any(Date), {
      page: 1,
      pageSize: 100,
      healthStatus: "all",
      inactivity: "all",
      groupName: "all",
    });
  });

  it("updates enabled and cronExpression", async () => {
    requireAdmin.mockResolvedValue(undefined);
    updateDefaultIngestionSchedule.mockResolvedValue({
      key: "ingestion_default",
      enabled: false,
      cronExpression: "*/15 * * * *",
      sourceConcurrency: 4,
      fullTextFetchThreshold: 120,
      aggregationSplitMaxEvents: 12,
      timezone: "Asia/Shanghai",
      lastHeartbeatAt: null,
      lastRunStartedAt: null,
      lastRunFinishedAt: null,
      lastRunStatus: null,
      nextRunAt: new Date("2026-04-12T02:00:00.000Z"),
    });

    const { PATCH } = await import("@/app/api/admin/monitor/schedule/ingestion-default/route");
    const response = await PATCH(
      new Request("http://localhost/api/admin/monitor/schedule/ingestion-default", {
        method: "PATCH",
        body: JSON.stringify({
          enabled: false,
          cronExpression: "*/15 * * * *",
          sourceConcurrency: 4,
          fullTextFetchThreshold: 120,
          perSourceItemLimit: 50,
          aggregationSplitMaxEvents: 12,
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(updateDefaultIngestionSchedule).toHaveBeenCalledWith({
      enabled: false,
      cronExpression: "*/15 * * * *",
      sourceConcurrency: 4,
      fullTextFetchThreshold: 120,
      perSourceItemLimit: 50,
      aggregationSplitMaxEvents: 12,
      processingStartAt: null,
    });
    expect(json.schedule.enabled).toBe(false);
    expect(json.schedule.cronExpression).toBe("*/15 * * * *");
    expect(json.schedule.sourceConcurrency).toBe(4);
    expect(json.schedule.fullTextFetchThreshold).toBe(120);
    expect(json.schedule.aggregationSplitMaxEvents).toBe(12);
  });

  it("attaches the target title to task detail responses", async () => {
    requireAdmin.mockResolvedValue(undefined);
    const taskRun = {
      id: "task-item-1",
      kind: "item_reanalyze",
      triggerType: "admin_action",
      status: "succeeded",
      label: "内容重分析",
      entityId: "item-1",
      progressCurrent: 1,
      progressTotal: 1,
      progressLabel: "已完成",
      itemsAdded: 0,
      fullTextFetchedCount: 0,
      aiCallCountActual: 1,
      aiCallCountEstimated: 0,
      aiCallBreakdownJson: "[]",
      cancelRequestedAt: null,
      startedAt: new Date("2026-04-12T00:30:00.000Z"),
      finishedAt: new Date("2026-04-12T00:31:00.000Z"),
      errorSummary: null,
      stageTimingsJson: "[]",
      taskTimelineJson: "[]",
    };
    getTaskRun.mockResolvedValue(taskRun);
    attachTaskEntityTitles.mockImplementation(async ([task]) => [{ ...task, entityTitle: "目标条目标题" }]);

    const { GET } = await import("@/app/api/admin/monitor/tasks/[id]/route");
    const response = await GET(new Request("http://localhost/api/admin/monitor/tasks/task-item-1"), {
      params: Promise.resolve({ id: "task-item-1" }),
    });
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(attachTaskEntityTitles).toHaveBeenCalledWith([expect.objectContaining({ entityId: "item-1" })]);
    expect(json.task.entityTitle).toBe("目标条目标题");
  });

  it("retries a historical standalone merge precompute using the unified precompute task", async () => {
    requireAdmin.mockResolvedValue(undefined);
    getTaskRun.mockResolvedValue({
      id: "legacy-precompute-1",
      kind: "cluster_merge_precompute_clean_pairs",
      status: "failed",
      label: "旧版聚合合并缓存预计算",
      entityId: null,
      pipelineCheckpointJson: null,
    });
    enqueueTaskRun.mockResolvedValue({
      id: "precompute-retry-1",
      kind: "precompute",
      triggerType: "admin_action",
      status: "queued",
      label: "预计算（旧版聚合合并缓存任务重试）",
      entityId: null,
      progressCurrent: 0,
      progressTotal: 0,
      progressLabel: null,
      itemsAdded: 0,
      fullTextFetchedCount: 0,
      aiCallCountActual: 0,
      aiCallCountEstimated: 0,
      aiCallBreakdownJson: "[]",
      cancelRequestedAt: null,
      startedAt: null,
      finishedAt: null,
      errorSummary: null,
      stageTimingsJson: "[]",
      taskTimelineJson: "[]",
      pipelineCheckpointJson: null,
    });

    const { POST } = await import("@/app/api/admin/monitor/tasks/[id]/retrigger/route");
    const response = await POST(new Request("http://localhost/api/admin/monitor/tasks/legacy-precompute-1/retrigger", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    }), { params: Promise.resolve({ id: "legacy-precompute-1" }) });
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(enqueueTaskRun).toHaveBeenCalledWith({
      kind: "precompute",
      triggerType: "admin_action",
      label: "预计算（旧版聚合合并缓存任务重试）",
      entityId: null,
    });
    expect(json.task.kind).toBe("precompute");
  });

  it("does not recreate a retired aggregation reparse task", async () => {
    requireAdmin.mockResolvedValue(undefined);
    getTaskRun.mockResolvedValue({
      id: "legacy-reparse-1",
      kind: "item_reparse_aggregations",
      status: "failed",
      label: "旧版聚合内容重拆",
      entityId: null,
      pipelineCheckpointJson: null,
    });

    const { POST } = await import("@/app/api/admin/monitor/tasks/[id]/retrigger/route");
    const response = await POST(new Request("http://localhost/api/admin/monitor/tasks/legacy-reparse-1/retrigger", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    }), { params: Promise.resolve({ id: "legacy-reparse-1" }) });

    expect(response.status).toBe(410);
    expect(enqueueTaskRun).not.toHaveBeenCalled();
  });

  it("requests cancellation for a running task", async () => {
    requireAdmin.mockResolvedValue(undefined);
    requestTaskRunCancellation.mockResolvedValue({
      id: "task-1",
      kind: "ingestion",
      triggerType: "manual",
      status: "running",
      label: "默认抓取任务",
      entityId: null,
      progressCurrent: 3,
      progressTotal: 10,
      progressLabel: "已处理 3/10 条内容，来自 1 个源，失败 0 项",
      startedAt: new Date("2026-04-12T00:30:00.000Z"),
      finishedAt: null,
      cancelRequestedAt: new Date("2026-04-12T00:31:00.000Z"),
      errorSummary: null,
    });

    const { POST } = await import("@/app/api/admin/monitor/tasks/[id]/cancel/route");
    const response = await POST(new Request("http://localhost/api/admin/monitor/tasks/task-1/cancel", { method: "POST" }), {
      params: Promise.resolve({ id: "task-1" }),
    });
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(requestTaskRunCancellation).toHaveBeenCalledWith("task-1");
    expect(json.task.id).toBe("task-1");
    expect(json.task.cancelRequestedAt).toBe("2026-04-12T00:31:00.000Z");
  });
});
