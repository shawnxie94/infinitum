import type { BackgroundTaskRun } from "@prisma/client";

import { DEFAULT_POLL_INTERVAL_MS, DEFAULT_TASK_STALE_MS } from "@/config/constants";
import { prisma } from "@/lib/db";
import { restartActiveAiWorkflowRuns } from "@/lib/ai-orchestration/runtime";
import { dispatchTaskRun } from "@/lib/tasks/routing";
import { computeNextRunAt } from "@/lib/tasks/scheduler";
import {
  DEFAULT_DAILY_REPORT_TASK_LABEL,
  DEFAULT_INGESTION_TASK_LABEL,
  DEFAULT_ITEM_CLEANUP_TASK_LABEL,
} from "@/lib/tasks/types";
import {
  claimNextQueuedTaskRun,
  ensureDefaultDailyReportSchedule,
  ensureDefaultIngestionSchedule,
  ensureDefaultItemCleanupSchedule,
  enqueueTaskRun,
  TASK_RUN_CANCELLED_LABEL,
  TASK_RUN_CANCELLED_MESSAGE,
} from "@/lib/tasks/service";

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function touchScheduleHeartbeat(now: Date) {
  await ensureDefaultIngestionSchedule();
  await ensureDefaultDailyReportSchedule();
  await ensureDefaultItemCleanupSchedule();

  return prisma.taskSchedule.updateMany({
    where: {
      key: {
        in: ["ingestion_default", "daily_report_default", "item_cleanup_default"],
      },
    },
    data: {
      lastHeartbeatAt: now,
    },
  });
}

async function enqueueScheduledIngestionIfDue(now: Date) {
  const schedule = await ensureDefaultIngestionSchedule();

  if (!schedule.enabled || schedule.nextRunAt.getTime() > now.getTime()) {
    return false;
  }

  const activeIngestionCount = await prisma.backgroundTaskRun.count({
    where: {
      kind: "ingestion",
      status: {
        in: ["queued", "running"],
      },
    },
  });

  if (activeIngestionCount > 0) {
    return false;
  }

  await enqueueTaskRun({
    kind: "ingestion",
    triggerType: "scheduled",
    label: DEFAULT_INGESTION_TASK_LABEL,
  });

  await prisma.taskSchedule.update({
    where: { id: schedule.id },
    data: {
      nextRunAt: computeNextRunAt({
        cronExpression: schedule.cronExpression,
        now,
        anchor: schedule.nextRunAt,
        timezone: schedule.timezone,
      }),
    },
  });

  return true;
}

function getScheduledReportDate(now: Date, offsetDays: number) {
  const shanghaiTime = new Date(now.getTime() + 8 * 60 * 60 * 1000 - offsetDays * 24 * 60 * 60 * 1000);
  return shanghaiTime.toISOString().slice(0, 10);
}

async function enqueueScheduledDailyReportIfDue(now: Date) {
  const schedule = await ensureDefaultDailyReportSchedule();

  if (!schedule.enabled || schedule.nextRunAt.getTime() > now.getTime()) {
    return false;
  }

  const activeDailyReportCount = await prisma.backgroundTaskRun.count({
    where: {
      kind: "daily_report_generate",
      status: {
        in: ["queued", "running"],
      },
    },
  });

  if (activeDailyReportCount > 0) {
    return false;
  }

  const date = getScheduledReportDate(now, schedule.dailyReportOffsetDays);
  await enqueueTaskRun({
    kind: "daily_report_generate",
    triggerType: "scheduled",
    label: `${DEFAULT_DAILY_REPORT_TASK_LABEL} ${date}`,
    entityId: date,
  });

  await prisma.taskSchedule.update({
    where: { id: schedule.id },
    data: {
      nextRunAt: computeNextRunAt({
        cronExpression: schedule.cronExpression,
        now,
        anchor: schedule.nextRunAt,
        timezone: schedule.timezone,
      }),
    },
  });

  return true;
}

async function enqueueScheduledItemCleanupIfDue(now: Date) {
  const schedule = await ensureDefaultItemCleanupSchedule();

  if (!schedule.enabled || schedule.nextRunAt.getTime() > now.getTime()) {
    return false;
  }

  const activeCleanupCount = await prisma.backgroundTaskRun.count({
    where: {
      kind: "item_cleanup",
      status: {
        in: ["queued", "running"],
      },
    },
  });

  if (activeCleanupCount > 0) {
    return false;
  }

  await enqueueTaskRun({
    kind: "item_cleanup",
    triggerType: "scheduled",
    label: DEFAULT_ITEM_CLEANUP_TASK_LABEL,
  });

  await prisma.taskSchedule.update({
    where: { id: schedule.id },
    data: {
      nextRunAt: computeNextRunAt({
        cronExpression: schedule.cronExpression,
        now,
        anchor: schedule.nextRunAt,
        timezone: schedule.timezone,
      }),
    },
  });

  return true;
}

export async function recoverStaleTaskRuns(
  now = new Date(),
  options?: { recoverInterruptedRuns?: boolean },
) {
  const staleBefore = new Date(now.getTime() - DEFAULT_TASK_STALE_MS);
  const staleReason = "Worker exited before completing the task.";
  const recoverInterruptedRuns = options?.recoverInterruptedRuns ?? false;
  const cancellationRequestedRuns = await prisma.backgroundTaskRun.findMany({
    where: {
      status: "running",
      cancelRequestedAt: {
        not: null,
      },
      finishedAt: null,
    },
    select: {
      id: true,
    },
  });
  const staleRuns = await prisma.backgroundTaskRun.findMany({
    where: {
      status: "running",
      cancelRequestedAt: null,
      ...(recoverInterruptedRuns
        ? {}
        : {
            startedAt: {
              lt: staleBefore,
            },
          }),
      finishedAt: null,
    },
    select: {
      id: true,
    },
  });

  const cancellationRequestedTaskRunIds = cancellationRequestedRuns.map((run) => run.id);
  const staleTaskRunIds = staleRuns.map((run) => run.id);
  let recoveredCount = 0;

  if (cancellationRequestedTaskRunIds.length > 0) {
    const result = await prisma.backgroundTaskRun.updateMany({
      where: {
        id: {
          in: cancellationRequestedTaskRunIds,
        },
      },
      data: {
        status: "cancelled",
        finishedAt: now,
        progressLabel: TASK_RUN_CANCELLED_LABEL,
        errorSummary: TASK_RUN_CANCELLED_MESSAGE,
      },
    });

    await prisma.fetchRun.updateMany({
      where: {
        taskRunId: {
          in: cancellationRequestedTaskRunIds,
        },
        status: "running",
      },
      data: {
        status: "failed",
        finishedAt: now,
        errorSummary: TASK_RUN_CANCELLED_MESSAGE,
      },
    });

    recoveredCount += result.count;
  }

  if (staleTaskRunIds.length > 0) {
    const result = await prisma.backgroundTaskRun.updateMany({
      where: {
        id: {
          in: staleTaskRunIds,
        },
      },
      data: {
        status: "failed",
        finishedAt: now,
        errorSummary: staleReason,
      },
    });

    await prisma.fetchRun.updateMany({
      where: {
        taskRunId: {
          in: staleTaskRunIds,
        },
        status: "running",
      },
      data: {
        status: "failed",
        finishedAt: now,
        errorSummary: staleReason,
      },
    });

    recoveredCount += result.count;
  }

  await prisma.fetchRun.updateMany({
    where: {
      status: "running",
      taskRun: {
        is: {
          status: {
            in: ["failed", "cancelled", "partial", "succeeded"],
          },
        },
      },
    },
    data: {
      status: "failed",
      finishedAt: now,
      errorSummary: staleReason,
    },
  });

  return recoveredCount;
}

export async function runWorkerCycle(options?: {
  now?: Date;
  executeTaskRun?: (taskRun: BackgroundTaskRun) => Promise<void>;
}) {
  const now = options?.now ?? new Date();

  await recoverStaleTaskRuns(now);
  await ensureDefaultIngestionSchedule();
  await ensureDefaultDailyReportSchedule();
  await ensureDefaultItemCleanupSchedule();
  await touchScheduleHeartbeat(now);
  const enqueuedScheduledRun = await enqueueScheduledIngestionIfDue(now);
  const enqueuedScheduledDailyReport = await enqueueScheduledDailyReportIfDue(now);
  const enqueuedScheduledCleanup = await enqueueScheduledItemCleanupIfDue(now);
  const claimedTaskRun = await claimNextQueuedTaskRun();

  if (claimedTaskRun) {
    // D10 路由：所有 task kind → Mastra workflow。
    // 单任务异常只落该任务失败，不允许打死 worker 循环；workflow lifecycle
    // 会负责终态投影，recoverStaleTaskRuns 不会重复处理已落终态的任务。
    try {
      await (options?.executeTaskRun ?? dispatchTaskRun)(claimedTaskRun);
    } catch (error) {
      console.error(`[Worker] Task ${claimedTaskRun.id} (${claimedTaskRun.kind}) crashed the workflow:`, error);
    }
  }

  return {
    enqueuedScheduledRun,
    enqueuedScheduledDailyReport,
    enqueuedScheduledCleanup,
    claimedTaskRunId: claimedTaskRun?.id ?? null,
  };
}

export async function startWorkerLoop(options?: {
  pollIntervalMs?: number;
  executeTaskRun?: (taskRun: BackgroundTaskRun) => Promise<void>;
}) {
  // Worker 进程 = 内嵌 Mastra 实例薄壳（D11）。顺序敏感：先做队列侧 stale
  // 回收（把崩溃进程遗留的 running 行置 failed），再 restartAllActiveWorkflowRuns
  // 重新拉起 workflow（业务体把行翻回 running 并按检查点续跑），避免回收误伤刚续跑的行。
  // On worker startup, any persisted running task belongs to a process that no longer exists.
  await recoverStaleTaskRuns(new Date(), { recoverInterruptedRuns: true });
  await restartActiveAiWorkflowRuns();

  while (true) {
    await runWorkerCycle({
      executeTaskRun: options?.executeTaskRun,
    });
    await sleep(options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  }
}
