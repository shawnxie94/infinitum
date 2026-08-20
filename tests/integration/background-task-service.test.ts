import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db";
import {
  claimNextQueuedTaskRun,
  ensureDefaultDailyReportSchedule,
  getBackgroundTaskMonitorSnapshot,
  ensureDefaultIngestionSchedule,
  enqueueTaskRun,
  listRecentTaskRuns,
  requestTaskRunCancellation,
  resumeTaskRun,
  TASK_RUN_CANCELLED_LABEL,
  TASK_RUN_CANCELLED_MESSAGE,
  updateTaskRun,
  updateDefaultIngestionSchedule,
} from "@/lib/tasks/service";
import { recoverStaleTaskRuns, runWorkerCycle } from "@/lib/tasks/worker";

describe("background task persistence", () => {
  beforeEach(async () => {
    await prisma.item.deleteMany();
    await prisma.fetchRun.deleteMany();
    await prisma.backgroundTaskRun.deleteMany();
    await prisma.source.deleteMany();
    await prisma.sourceGroup.deleteMany();
    await prisma.blacklistKeyword.deleteMany();
    await prisma.taskSchedule.deleteMany();
  });

  it("creates the default ingestion schedule once", async () => {
    const schedule = await prisma.taskSchedule.create({
      data: {
        key: "ingestion_default",
        enabled: true,
        cronExpression: "0 * * * *",
        sourceConcurrency: 2,
        fullTextFetchThreshold: 80,
        timezone: "Asia/Shanghai",
        nextRunAt: new Date("2026-04-12T01:00:00.000Z"),
      },
    });

    expect(schedule.key).toBe("ingestion_default");
    expect(schedule.cronExpression).toBe("0 * * * *");
    expect(schedule.sourceConcurrency).toBe(2);
    expect(schedule.fullTextFetchThreshold).toBe(80);
  });

  it("links fetch runs to a background task run", async () => {
    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "ingestion",
        triggerType: "manual",
        status: "queued",
        label: "默认抓取任务",
      },
    });

    const fetchRun = await prisma.fetchRun.create({
      data: {
        taskRunId: taskRun.id,
        triggerType: "manual",
        status: "running",
      },
    });

    expect(fetchRun.taskRunId).toBe(taskRun.id);
  });

  it("seeds the default ingestion schedule", async () => {
    const schedule = await ensureDefaultIngestionSchedule();

    expect(schedule.key).toBe("ingestion_default");
    expect(schedule.enabled).toBe(false);
    expect(schedule.cronExpression).toBe("0 * * * *");
    expect(schedule.sourceConcurrency).toBe(2);
    expect(schedule.fullTextFetchThreshold).toBe(80);
  });

  it("claims a queued task only once", async () => {
    const created = await enqueueTaskRun({
      kind: "ingestion",
      triggerType: "manual",
      label: "默认抓取任务",
    });

    const firstClaim = await claimNextQueuedTaskRun();
    const secondClaim = await claimNextQueuedTaskRun();

    expect(firstClaim?.id).toBe(created.id);
    expect(secondClaim).toBeNull();
  });

  it("lists the newest tasks first", async () => {
    await enqueueTaskRun({
      kind: "ingestion",
      triggerType: "manual",
      label: "默认抓取任务",
    });
    await enqueueTaskRun({
      kind: "item_reanalyze",
      triggerType: "admin_action",
      label: "重新 AI 判定",
      entityId: "item-1",
    });

    const tasks = await listRecentTaskRuns({ limit: 20 });

    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.createdAt.getTime()).toBeGreaterThanOrEqual(tasks[1]?.createdAt.getTime() ?? 0);
  });

  it("paginates task monitor runs with a stable order when tasks share a createdAt timestamp", async () => {
    const createdAt = new Date("2026-04-12T00:00:00.000Z");

    await prisma.backgroundTaskRun.createMany({
      data: Array.from({ length: 12 }, (_, index) => {
        const taskNumber = index + 1;

        return {
          id: `task-${String(taskNumber).padStart(2, "0")}`,
          kind: "item_regenerate_summary",
          triggerType: "admin_action",
          status: "succeeded",
          label: `摘要重生成 ${taskNumber}`,
          createdAt,
        } as const;
      }),
    });

    const pageOne = await getBackgroundTaskMonitorSnapshot(new Date("2026-04-12T01:00:00.000Z"), {
      page: 1,
      pageSize: 5,
    });
    const pageTwo = await getBackgroundTaskMonitorSnapshot(new Date("2026-04-12T01:00:00.000Z"), {
      page: 2,
      pageSize: 5,
    });

    expect(pageOne.recentTasks.map((task) => task.id)).toEqual([
      "task-12",
      "task-11",
      "task-10",
      "task-09",
      "task-08",
    ]);
    expect(pageTwo.recentTasks.map((task) => task.id)).toEqual([
      "task-07",
      "task-06",
      "task-05",
      "task-04",
      "task-03",
    ]);
    expect(new Set([...pageOne.recentTasks, ...pageTwo.recentTasks].map((task) => task.id)).size).toBe(10);
  });

  it("orders task monitor runs by startedAt and falls back to createdAt for queued tasks", async () => {
    await prisma.backgroundTaskRun.createMany({
      data: [
        {
          id: "created-later-started-earlier",
          kind: "ingestion",
          triggerType: "manual",
          status: "succeeded",
          label: "创建晚但开始早",
          createdAt: new Date("2026-04-12T00:20:00.000Z"),
          startedAt: new Date("2026-04-12T00:10:00.000Z"),
          finishedAt: new Date("2026-04-12T00:11:00.000Z"),
        },
        {
          id: "queued-latest-created",
          kind: "daily_report_generate",
          triggerType: "scheduled",
          status: "queued",
          label: "最新排队任务",
          createdAt: new Date("2026-04-12T00:25:00.000Z"),
        },
        {
          id: "created-earlier-started-later",
          kind: "item_regenerate_summary",
          triggerType: "admin_action",
          status: "running",
          label: "创建早但开始晚",
          createdAt: new Date("2026-04-12T00:00:00.000Z"),
          startedAt: new Date("2026-04-12T00:30:00.000Z"),
        },
      ],
    });

    const snapshot = await getBackgroundTaskMonitorSnapshot(new Date("2026-04-12T01:00:00.000Z"), {
      page: 1,
      pageSize: 10,
    });

    expect(snapshot.recentTasks.map((task) => task.id)).toEqual([
      "created-earlier-started-later",
      "queued-latest-created",
      "created-later-started-earlier",
    ]);
  });

  it("marks stale running tasks as failed during recovery", async () => {
    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "ingestion",
        triggerType: "manual",
        status: "running",
        label: "默认抓取任务",
        startedAt: new Date("2026-04-12T00:00:00.000Z"),
      },
    });
    const fetchRun = await prisma.fetchRun.create({
      data: {
        taskRunId: taskRun.id,
        triggerType: "manual",
        status: "running",
        startedAt: new Date("2026-04-12T00:00:00.000Z"),
      },
    });

    const recovered = await recoverStaleTaskRuns(new Date("2026-04-12T00:20:00.000Z"));
    const updatedTaskRun = await prisma.backgroundTaskRun.findUniqueOrThrow({
      where: { id: taskRun.id },
    });
    const updatedFetchRun = await prisma.fetchRun.findUniqueOrThrow({
      where: { id: fetchRun.id },
    });

    expect(recovered).toBe(1);
    expect(updatedTaskRun.status).toBe("failed");
    expect(updatedTaskRun.errorSummary).toContain("Worker exited");
    expect(updatedFetchRun.status).toBe("failed");
    expect(updatedFetchRun.errorSummary).toContain("Worker exited");
    expect(updatedFetchRun.finishedAt).not.toBeNull();
  });

  it("marks interrupted running tasks as failed during worker startup recovery", async () => {
    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "ingestion",
        triggerType: "manual",
        status: "running",
        label: "默认抓取任务",
        startedAt: new Date("2026-04-12T00:10:00.000Z"),
      },
    });
    const fetchRun = await prisma.fetchRun.create({
      data: {
        taskRunId: taskRun.id,
        triggerType: "manual",
        status: "running",
        startedAt: new Date("2026-04-12T00:10:00.000Z"),
      },
    });

    const recovered = await recoverStaleTaskRuns(new Date("2026-04-12T00:12:00.000Z"), {
      recoverInterruptedRuns: true,
    });
    const updatedTaskRun = await prisma.backgroundTaskRun.findUniqueOrThrow({
      where: { id: taskRun.id },
    });
    const updatedFetchRun = await prisma.fetchRun.findUniqueOrThrow({
      where: { id: fetchRun.id },
    });

    expect(recovered).toBe(1);
    expect(updatedTaskRun.status).toBe("failed");
    expect(updatedTaskRun.finishedAt).not.toBeNull();
    expect(updatedTaskRun.errorSummary).toContain("Worker exited");
    expect(updatedFetchRun.status).toBe("failed");
    expect(updatedFetchRun.finishedAt).not.toBeNull();
    expect(updatedFetchRun.errorSummary).toContain("Worker exited");
  });

  it("reconciles cancellation-requested running tasks as cancelled during recovery", async () => {
    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "ingestion",
        triggerType: "manual",
        status: "running",
        label: "默认抓取任务",
        startedAt: new Date("2026-04-12T00:10:00.000Z"),
        cancelRequestedAt: new Date("2026-04-12T00:12:00.000Z"),
        errorSummary: TASK_RUN_CANCELLED_MESSAGE,
      },
    });
    const fetchRun = await prisma.fetchRun.create({
      data: {
        taskRunId: taskRun.id,
        triggerType: "manual",
        status: "running",
        startedAt: new Date("2026-04-12T00:10:00.000Z"),
        sourceCount: 1,
        itemCount: 50,
        successCount: 26,
        itemsAdded: 17,
      },
    });

    const recovered = await recoverStaleTaskRuns(new Date("2026-04-12T00:13:00.000Z"));
    const updatedTaskRun = await prisma.backgroundTaskRun.findUniqueOrThrow({
      where: { id: taskRun.id },
    });
    const updatedFetchRun = await prisma.fetchRun.findUniqueOrThrow({
      where: { id: fetchRun.id },
    });

    expect(recovered).toBe(1);
    expect(updatedTaskRun.status).toBe("cancelled");
    expect(updatedTaskRun.finishedAt).not.toBeNull();
    expect(updatedTaskRun.progressLabel).toBe(TASK_RUN_CANCELLED_LABEL);
    expect(updatedTaskRun.errorSummary).toBe(TASK_RUN_CANCELLED_MESSAGE);
    expect(updatedFetchRun.status).toBe("failed");
    expect(updatedFetchRun.finishedAt).not.toBeNull();
    expect(updatedFetchRun.errorSummary).toBe(TASK_RUN_CANCELLED_MESSAGE);
  });

  it("reconciles running fetch runs whose linked task is already terminal", async () => {
    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "ingestion",
        triggerType: "manual",
        status: "failed",
        label: "默认抓取任务",
        startedAt: new Date("2026-04-12T00:00:00.000Z"),
        finishedAt: new Date("2026-04-12T00:05:00.000Z"),
        errorSummary: "Worker exited before completing the task.",
      },
    });
    const fetchRun = await prisma.fetchRun.create({
      data: {
        taskRunId: taskRun.id,
        triggerType: "manual",
        status: "running",
        startedAt: new Date("2026-04-12T00:00:00.000Z"),
      },
    });

    const recovered = await recoverStaleTaskRuns(new Date("2026-04-12T00:20:00.000Z"));
    const updatedFetchRun = await prisma.fetchRun.findUniqueOrThrow({
      where: { id: fetchRun.id },
    });

    expect(recovered).toBe(0);
    expect(updatedFetchRun.status).toBe("failed");
    expect(updatedFetchRun.errorSummary).toContain("Worker exited");
    expect(updatedFetchRun.finishedAt).not.toBeNull();
  });

  it("enqueues a scheduled ingestion task when due", async () => {
    await prisma.taskSchedule.create({
      data: {
        key: "ingestion_default",
        enabled: true,
        cronExpression: "0 * * * *",
        sourceConcurrency: 2,
        fullTextFetchThreshold: 80,
        timezone: "Asia/Shanghai",
        nextRunAt: new Date("2026-04-12T01:00:00.000Z"),
      },
    });

    const result = await runWorkerCycle({
      now: new Date("2026-04-12T01:00:00.000Z"),
      executeTaskRun: async () => undefined,
    });
    const ingestionTasks = await prisma.backgroundTaskRun.findMany({
      where: { kind: "ingestion" },
      orderBy: { createdAt: "asc" },
    });

    expect(result.enqueuedScheduledRun).toBe(true);
    expect(ingestionTasks).toHaveLength(1);
    expect(ingestionTasks[0]?.triggerType).toBe("scheduled");
    expect(ingestionTasks[0]?.status).toBe("running");
  });

  it("enqueues a scheduled daily report for the current Shanghai day by default when due", async () => {
    await ensureDefaultDailyReportSchedule();
    await prisma.taskSchedule.update({
      where: { key: "daily_report_default" },
      data: {
        enabled: true,
        cronExpression: "30 8 * * *",
        nextRunAt: new Date("2026-04-25T00:30:00.000Z"),
      },
    });

    const result = await runWorkerCycle({
      now: new Date("2026-04-25T00:30:00.000Z"),
      executeTaskRun: async () => undefined,
    });
    const dailyReportTasks = await prisma.backgroundTaskRun.findMany({
      where: { kind: "daily_report_generate" },
      orderBy: { createdAt: "asc" },
    });

    expect(result.enqueuedScheduledDailyReport).toBe(true);
    expect(dailyReportTasks).toHaveLength(1);
    expect(dailyReportTasks[0]?.triggerType).toBe("scheduled");
    expect(dailyReportTasks[0]?.entityId).toBe("2026-04-25");
    expect(dailyReportTasks[0]?.label).toContain("2026-04-25");
    expect(dailyReportTasks[0]?.status).toBe("running");
  });

  it("enqueues a scheduled daily report for T-minus configured Shanghai days", async () => {
    await ensureDefaultDailyReportSchedule();
    await prisma.taskSchedule.update({
      where: { key: "daily_report_default" },
      data: {
        enabled: true,
        cronExpression: "30 8 * * *",
        dailyReportOffsetDays: 1,
        nextRunAt: new Date("2026-04-25T00:30:00.000Z"),
      },
    });

    const result = await runWorkerCycle({
      now: new Date("2026-04-25T00:30:00.000Z"),
      executeTaskRun: async () => undefined,
    });
    const dailyReportTasks = await prisma.backgroundTaskRun.findMany({
      where: { kind: "daily_report_generate" },
      orderBy: { createdAt: "asc" },
    });

    expect(result.enqueuedScheduledDailyReport).toBe(true);
    expect(dailyReportTasks).toHaveLength(1);
    expect(dailyReportTasks[0]?.triggerType).toBe("scheduled");
    expect(dailyReportTasks[0]?.entityId).toBe("2026-04-24");
    expect(dailyReportTasks[0]?.label).toContain("2026-04-24");
    expect(dailyReportTasks[0]?.status).toBe("running");
  });

  it("updates the default ingestion schedule", async () => {
    await ensureDefaultIngestionSchedule();

    const updated = await updateDefaultIngestionSchedule({
      enabled: false,
      cronExpression: "*/15 * * * *",
      sourceConcurrency: 4,
      fullTextFetchThreshold: 120,
      perSourceItemLimit: 20,
      aggregationSplitMaxEvents: 12,
    });

    expect(updated.enabled).toBe(false);
    expect(updated.cronExpression).toBe("*/15 * * * *");
    expect(updated.sourceConcurrency).toBe(4);
    expect(updated.fullTextFetchThreshold).toBe(120);
    expect(updated.aggregationSplitMaxEvents).toBe(12);
  });

  it("builds a monitor snapshot with schedule and task lists", async () => {
    await ensureDefaultIngestionSchedule();
    const taskRun = await enqueueTaskRun({
      kind: "ingestion",
      triggerType: "manual",
      label: "默认抓取任务",
    });
    await updateTaskRun(taskRun.id, {
      status: "running",
      fullTextFetchedCount: 2,
      aiCallCountActual: 3,
      aiCallCountEstimated: 8,
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
          actual: 2,
          estimated: 4,
        },
        {
          key: "cluster_summary",
          label: "聚合摘要",
          actual: 0,
          estimated: 2,
        },
      ],
      stageTimings: [
        {
          key: "source_sync",
          label: "信息源同步",
          startedAt: "2026-04-12T00:00:00.000Z",
          finishedAt: "2026-04-12T00:00:09.000Z",
          durationMs: 9_000,
        },
      ],
      taskTimeline: [
        {
          key: "source_fetch",
          label: "信息抓取",
          status: "succeeded",
          startedAt: "2026-04-12T00:00:00.000Z",
          finishedAt: "2026-04-12T00:00:09.000Z",
          durationMs: 9_000,
          metrics: [
            { label: "抓取源", value: 2 },
            { label: "抓取内容", value: 20 },
            { label: "正文补抓", value: 3 },
          ],
        },
        {
          key: "item_understanding",
          label: "条目理解",
          status: "succeeded",
          startedAt: "2026-04-12T00:00:10.000Z",
          finishedAt: "2026-04-12T00:00:20.000Z",
          durationMs: 5_000,
          metrics: [
            { label: "完成", value: 4 },
            { label: "过滤", value: 0 },
          ],
        },
      ],
    });

    const storedTaskRun = await prisma.backgroundTaskRun.findUniqueOrThrow({
      where: { id: taskRun.id },
    });
    const snapshot = await getBackgroundTaskMonitorSnapshot(new Date("2026-04-12T01:00:00.000Z"));

    expect(storedTaskRun.stageTimingsJson).not.toBeNull();
    expect(storedTaskRun.stageTimingsJson).toContain("\"source_sync\"");
    expect(storedTaskRun.taskTimelineJson).not.toBeNull();
    expect(storedTaskRun.taskTimelineJson).toContain("\"source_fetch\"");
    expect(storedTaskRun.aiCallBreakdownJson).not.toBeNull();
    expect(snapshot.schedule.key).toBe("ingestion_default");
    expect(snapshot.schedule.sourceConcurrency).toBe(2);
    expect(snapshot.schedule.fullTextFetchThreshold).toBe(80);
    expect(Array.isArray(snapshot.runningTasks)).toBe(true);
    expect(Array.isArray(snapshot.recentTasks)).toBe(true);
    expect(snapshot.recentTasks[0]?.label).toBe("默认抓取任务");
    expect(snapshot.recentTasks[0]?.fullTextFetchedCount).toBe(2);
    expect(snapshot.recentTasks[0]?.aiCallCountActual).toBe(3);
    expect(snapshot.recentTasks[0]?.aiCallCountEstimated).toBe(8);
    expect(snapshot.recentTasks[0]?.aiCallBreakdown).toEqual([
      {
        key: "item_understanding",
        label: "条目理解",
        actual: 1,
        estimated: 2,
      },
      {
        key: "cluster_match",
        label: "聚合匹配",
        actual: 2,
        estimated: 4,
      },
      {
        key: "cluster_summary",
        label: "聚合摘要",
        actual: 0,
        estimated: 2,
      },
      {
        key: "cluster_merge",
        label: "聚合合并",
        actual: 0,
        estimated: 0,
      },
      {
        key: "daily_report",
        label: "AI 日报",
        actual: 0,
        estimated: 0,
      },
      {
        key: "daily_report_assess",
        label: "评估",
        actual: 0,
        estimated: 0,
      },
      {
        key: "daily_report_plan",
        label: "规划",
        actual: 0,
        estimated: 0,
      },
      {
        key: "daily_report_write",
        label: "写作",
        actual: 0,
        estimated: 0,
      },
      {
        key: "daily_report_repair",
        label: "修复",
        actual: 0,
        estimated: 0,
      },
      {
        key: "daily_report_review",
        label: "审核",
        actual: 0,
        estimated: 0,
      },
    ]);
    expect(snapshot.recentTasks[0]?.stageTimings).toEqual([
      {
        key: "source_sync",
        label: "信息源同步",
        startedAt: "2026-04-12T00:00:00.000Z",
        finishedAt: "2026-04-12T00:00:09.000Z",
        durationMs: 9_000,
      },
    ]);
    expect(snapshot.recentTasks[0]?.taskTimeline).toEqual([
      {
        key: "source_fetch",
        label: "信息抓取",
        status: "succeeded",
        startedAt: "2026-04-12T00:00:00.000Z",
        finishedAt: "2026-04-12T00:00:09.000Z",
        durationMs: 9_000,
        modelName: null,
        metrics: [
          { label: "抓取源", value: 2 },
          { label: "抓取内容", value: 20 },
          { label: "正文补抓", value: 3 },
        ],
      },
      {
        key: "item_understanding",
        label: "条目理解",
        status: "succeeded",
        startedAt: "2026-04-12T00:00:10.000Z",
        finishedAt: "2026-04-12T00:00:20.000Z",
        durationMs: 5_000,
        modelName: null,
        metrics: [
          { label: "完成", value: 4 },
          { label: "过滤", value: 0 },
        ],
      },
    ]);
  });

  it("cancels a queued task immediately", async () => {
    const taskRun = await enqueueTaskRun({
      kind: "ingestion",
      triggerType: "manual",
      label: "默认抓取任务",
    });

    const cancelledTaskRun = await requestTaskRunCancellation(taskRun.id);

    expect(cancelledTaskRun.status).toBe("cancelled");
    expect(cancelledTaskRun.finishedAt).not.toBeNull();
    expect(cancelledTaskRun.cancelRequestedAt).not.toBeNull();
    expect(cancelledTaskRun.progressLabel).toBe("任务已终止");
  });

  it("marks a running task as cancellation requested", async () => {
    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "ingestion",
        triggerType: "manual",
        status: "running",
        label: "默认抓取任务",
        startedAt: new Date("2026-04-12T00:31:00.000Z"),
      },
    });

    const updatedTaskRun = await requestTaskRunCancellation(taskRun.id);

    expect(updatedTaskRun.status).toBe("running");
    expect(updatedTaskRun.cancelRequestedAt).not.toBeNull();
  });

  it("round-trips a validated daily report pipeline checkpoint", async () => {
    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "daily_report_generate",
        triggerType: "manual",
        status: "running",
        label: "AI 日报生成",
        entityId: "2026-04-12",
      },
    });

    await updateTaskRun(taskRun.id, {
      pipelineCheckpoint: {
        version: 1,
        pipelineVersion: "daily-report-v2",
        stage: "assess",
        completedStages: ["prepare"],
        inputHash: "input-hash",
        templateSignature: "template-signature",
        candidateSnapshotHash: "candidate-hash",
        resumeEligible: true,
        data: { completedBatchIds: ["batch-0"] },
      },
    });

    const snapshot = await getBackgroundTaskMonitorSnapshot(new Date(), {
      kind: "daily_report_generate",
    });
    const taskSnapshot = snapshot.recentTasks.find((entry) => entry.id === taskRun.id);

    expect(taskSnapshot?.pipelineCheckpoint).toEqual({
      version: 1,
      pipelineVersion: "daily-report-v2",
      stage: "assess",
      completedStages: ["prepare"],
      inputHash: "input-hash",
      templateSignature: "template-signature",
      candidateSnapshotHash: "candidate-hash",
      resumeEligible: true,
      data: { completedBatchIds: ["batch-0"] },
    });
  });

  it("requeues the original daily report task for an eligible checkpoint", async () => {
    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "daily_report_generate",
        triggerType: "manual",
        status: "failed",
        label: "AI 日报生成",
        entityId: "2026-04-12",
        errorSummary: "ASSESS 失败",
      },
    });

    await updateTaskRun(taskRun.id, {
      pipelineCheckpoint: {
        version: 1,
        pipelineVersion: "daily-report-selection-writing-v1",
        stage: "assess",
        completedStages: ["prepare"],
        inputHash: "input-hash",
        templateSignature: "template-signature",
        candidateSnapshotHash: "candidate-hash",
        resumeEligible: true,
        failedStage: "assess",
        failureCode: "stage_failed",
        stageAttempts: { "ASSESS.batch.0": 1 },
      },
    });

    const resumed = await resumeTaskRun(taskRun.id);
    expect(resumed.id).toBe(taskRun.id);
    expect(resumed.status).toBe("queued");
    expect(resumed.errorSummary).toBeNull();
    expect(resumed.startedAt).toBeNull();
    expect(JSON.parse(resumed.pipelineCheckpointJson ?? "{}")).toMatchObject({
      resumeAttempt: 1,
      failedStage: null,
      failureCode: null,
      stageAttempts: { "ASSESS.batch.0": 1 },
    });
    await expect(prisma.backgroundTaskRun.count()).resolves.toBe(1);
  });

  it("resets the invalid draft when manually continuing from WRITE", async () => {
    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "daily_report_generate",
        triggerType: "manual",
        status: "failed",
        label: "AI 日报生成",
        entityId: "2026-04-12",
      },
    });

    await updateTaskRun(taskRun.id, {
      pipelineCheckpoint: {
        version: 1,
        pipelineVersion: "daily-report-topic-first-review-v1",
        stage: "validate",
        completedStages: ["prepare", "assess", "merge", "plan", "plan_validate", "write"],
        inputHash: "input-hash",
        templateSignature: "template-signature",
        candidateSnapshotHash: "candidate-hash",
        resumeEligible: false,
        failedStage: "validate",
        failureCode: "stage_failed",
        stageAttempts: { WRITE: 2, VALIDATE: 1 },
        plan: { schemaVersion: 2, sections: [] },
        draft: { headline: "旧草稿", blocks: [] },
        violations: [{ code: "draft_topic_missing", stage: "draft", message: "缺少主题" }],
      },
    });

    const resumed = await resumeTaskRun(taskRun.id, { retryFrom: "write" });
    const checkpoint = JSON.parse(resumed.pipelineCheckpointJson ?? "{}") as Record<string, unknown>;

    expect(resumed.id).not.toBe(taskRun.id);
    expect(resumed.status).toBe("queued");
    expect(checkpoint).toMatchObject({
      stage: "write",
      resumeEligible: true,
      resumeFrom: "write",
      resumeAttempt: 1,
      completedStages: ["prepare", "assess", "merge", "plan", "plan_validate"],
      data: { manualRetryFrom: "write" },
    });
    expect(checkpoint.plan).toEqual({ schemaVersion: 2, sections: [] });
    expect(checkpoint).not.toHaveProperty("draft");
    expect(checkpoint).not.toHaveProperty("violations");
    expect(checkpoint.stageAttempts).toEqual({});
    await expect(prisma.backgroundTaskRun.count()).resolves.toBe(2);
  });

  it("restarts WRITE when a legacy REPAIR checkpoint is manually continued", async () => {
    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "daily_report_generate",
        triggerType: "manual",
        status: "failed",
        label: "AI 日报生成",
        entityId: "2026-04-12",
      },
    });

    await updateTaskRun(taskRun.id, {
      pipelineCheckpoint: {
        version: 1,
        pipelineVersion: "daily-report-topic-first-review-v1",
        stage: "repair",
        completedStages: ["prepare", "assess", "merge", "plan", "plan_validate", "write"],
        inputHash: "input-hash",
        templateSignature: "template-signature",
        candidateSnapshotHash: "candidate-hash",
        resumeEligible: false,
        failedStage: "repair",
        failureCode: "stage_failed",
        stageAttempts: { REPAIR: 1 },
        plan: { schemaVersion: 2, sections: [] },
        draft: { headline: "可修复草稿", blocks: [] },
        violations: [{ code: "draft_required_note_missing", stage: "draft", message: "缺少重点" }],
      },
    });

    const resumed = await resumeTaskRun(taskRun.id, { retryFrom: "write" });
    const checkpoint = JSON.parse(resumed.pipelineCheckpointJson ?? "{}") as Record<string, unknown>;

    expect(checkpoint).toMatchObject({
      stage: "write",
      resumeEligible: true,
      resumeFrom: "write",
      completedStages: ["prepare", "assess", "merge", "plan", "plan_validate"],
      data: { manualRetryFrom: "write" },
    });
    expect(checkpoint).not.toHaveProperty("draft");
    expect(checkpoint).not.toHaveProperty("violations");
    expect(checkpoint.stageAttempts).toEqual({});
    expect(resumed.id).not.toBe(taskRun.id);
    await expect(prisma.backgroundTaskRun.count()).resolves.toBe(2);
  });

  it("creates a separate task when a completed daily report restarts from an intermediate stage", async () => {
    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "daily_report_generate",
        triggerType: "manual",
        status: "succeeded",
        label: "AI 日报生成",
        entityId: "2026-04-12",
      },
    });

    await updateTaskRun(taskRun.id, {
      pipelineCheckpoint: {
        version: 1,
        pipelineVersion: "daily-report-topic-first-review-v1",
        stage: "validate",
        completedStages: ["prepare", "assess", "merge", "plan", "plan_validate", "write", "validate"],
        inputHash: "input-hash",
        templateSignature: "template-signature",
        candidateSnapshotHash: "candidate-hash",
        resumeEligible: true,
        assessmentBatches: [{ index: 0, candidateIds: [1], status: "succeeded" as const, attempt: 1 }],
        ledger: { schemaVersion: 1 },
        planningCandidateBriefs: [{ candidateId: 1 }],
        plan: { schemaVersion: 2, sections: [] },
        draft: { headline: "已完成日报", blocks: [] },
      },
    });

    const regenerated = await resumeTaskRun(taskRun.id, { retryFrom: "write" });
    const checkpoint = JSON.parse(regenerated.pipelineCheckpointJson ?? "{}");

    expect(regenerated.id).not.toBe(taskRun.id);
    expect(regenerated.status).toBe("queued");
    expect(regenerated.label).toContain("从 写作 重新生成");
    expect(checkpoint).toMatchObject({
      stage: "write",
      resumeEligible: true,
      resumeFrom: "write",
      completedStages: ["prepare", "assess", "merge", "plan", "plan_validate"],
      data: { manualRetryFrom: "write" },
    });
    await expect(prisma.backgroundTaskRun.findUniqueOrThrow({ where: { id: taskRun.id } })).resolves.toMatchObject({
      status: "succeeded",
    });
    await expect(prisma.backgroundTaskRun.count()).resolves.toBe(2);
  });

  it("creates a separate task when a daily report restarts from REVIEW", async () => {
    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "daily_report_generate",
        triggerType: "manual",
        status: "partial",
        label: "AI 日报生成",
        entityId: "2026-04-12",
      },
    });

    await updateTaskRun(taskRun.id, {
      pipelineCheckpoint: {
        version: 1,
        pipelineVersion: "daily-report-topic-first-review-v1",
        stage: "review",
        completedStages: ["prepare", "assess", "merge", "plan", "plan_validate", "write", "validate", "review"],
        inputHash: "input-hash",
        templateSignature: "template-signature",
        candidateSnapshotHash: "candidate-hash",
        resumeEligible: false,
        reviewStatus: "unavailable",
        reviewAttempts: 1,
        reviewViolations: [],
        reviewAudit: { attempts: 1, error: "模型服务暂时不可用" },
        plan: { schemaVersion: 2, sections: [] },
        draft: { headline: "保留草稿", blocks: [] },
      },
    });

    const retried = await resumeTaskRun(taskRun.id, { retryFrom: "review" });
    const checkpoint = JSON.parse(retried.pipelineCheckpointJson ?? "{}");

    expect(retried.id).not.toBe(taskRun.id);
    expect(retried.status).toBe("queued");
    expect(retried.label).toContain("从 审核 重新生成");
    expect(checkpoint).toMatchObject({
      stage: "review",
      resumeEligible: true,
      resumeFrom: "review",
      completedStages: ["prepare", "assess", "merge", "plan", "plan_validate", "write", "validate"],
      data: { manualRetryFrom: "review" },
    });
    expect(checkpoint.plan).toEqual({ schemaVersion: 2, sections: [] });
    expect(checkpoint.draft).toEqual({ headline: "保留草稿", blocks: [] });
    expect(checkpoint).not.toHaveProperty("reviewStatus");
    expect(checkpoint).not.toHaveProperty("reviewAudit");
  });

  it("refreshes the scheduler heartbeat while a task is reporting progress", async () => {
    const schedule = await prisma.taskSchedule.create({
      data: {
        key: "ingestion_default",
        enabled: true,
        cronExpression: "0 * * * *",
        sourceConcurrency: 2,
        fullTextFetchThreshold: 80,
        timezone: "Asia/Shanghai",
        nextRunAt: new Date("2026-04-12T01:00:00.000Z"),
        lastHeartbeatAt: new Date("2026-04-12T00:00:00.000Z"),
      },
    });
    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "ingestion",
        triggerType: "manual",
        status: "running",
        label: "默认抓取任务",
        startedAt: new Date("2026-04-12T00:31:00.000Z"),
      },
    });

    await updateTaskRun(taskRun.id, {
      status: "running",
      progressCurrent: 1,
      progressTotal: 10,
      progressLabel: "已处理 1/10 条内容",
    });

    const updatedSchedule = await prisma.taskSchedule.findUniqueOrThrow({
      where: { id: schedule.id },
    });

    expect(updatedSchedule.lastHeartbeatAt).not.toBeNull();
    expect(updatedSchedule.lastHeartbeatAt?.getTime()).toBeGreaterThan(schedule.lastHeartbeatAt?.getTime() ?? 0);
  });

  it("refreshes the daily report scheduler heartbeat for daily report task progress", async () => {
    const ingestionSchedule = await prisma.taskSchedule.create({
      data: {
        key: "ingestion_default",
        enabled: true,
        cronExpression: "0 * * * *",
        sourceConcurrency: 2,
        fullTextFetchThreshold: 80,
        timezone: "Asia/Shanghai",
        nextRunAt: new Date("2026-04-12T01:00:00.000Z"),
        lastHeartbeatAt: new Date("2026-04-12T00:00:00.000Z"),
      },
    });
    const dailyReportSchedule = await prisma.taskSchedule.create({
      data: {
        key: "daily_report_default",
        enabled: true,
        cronExpression: "30 8 * * *",
        sourceConcurrency: 2,
        fullTextFetchThreshold: 80,
        perSourceItemLimit: 20,
        dailyReportCandidateLimit: 120,
        dailyReportOffsetDays: 0,
        dailyReportAutoPublish: false,
        timezone: "Asia/Shanghai",
        nextRunAt: new Date("2026-04-12T00:30:00.000Z"),
        lastHeartbeatAt: new Date("2026-04-12T00:00:00.000Z"),
      },
    });
    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "daily_report_generate",
        triggerType: "scheduled",
        status: "running",
        label: "AI 日报生成",
        entityId: "2026-04-12",
        startedAt: new Date("2026-04-12T00:31:00.000Z"),
      },
    });

    await updateTaskRun(taskRun.id, {
      status: "running",
      progressCurrent: 0,
      progressTotal: 1,
      progressLabel: "正在生成 2026-04-12 AI 日报",
    });

    const [updatedIngestionSchedule, updatedDailyReportSchedule] = await Promise.all([
      prisma.taskSchedule.findUniqueOrThrow({ where: { id: ingestionSchedule.id } }),
      prisma.taskSchedule.findUniqueOrThrow({ where: { id: dailyReportSchedule.id } }),
    ]);

    expect(updatedDailyReportSchedule.lastHeartbeatAt).not.toBeNull();
    expect(updatedDailyReportSchedule.lastHeartbeatAt?.getTime()).toBeGreaterThan(
      dailyReportSchedule.lastHeartbeatAt?.getTime() ?? 0,
    );
    expect(updatedIngestionSchedule.lastHeartbeatAt?.getTime()).toBe(
      ingestionSchedule.lastHeartbeatAt?.getTime(),
    );
  });
});
