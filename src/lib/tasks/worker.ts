import type { BackgroundTaskRun } from "@prisma/client";

import { DEFAULT_POLL_INTERVAL_MS, DEFAULT_TASK_STALE_MS, MINUTE_MS } from "@/config/constants";
import { prisma } from "@/lib/db";
import { restartActiveAiWorkflowRuns } from "@/lib/ai-orchestration/runtime";
import { enqueueItemProcessingRecoveryTask } from "@/lib/items/processing-recovery";
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
  enqueueScheduledTaskRunIfDue,
  requestTaskRunCancellation,
  TASK_RUN_CANCELLED_LABEL,
  TASK_RUN_CANCELLED_MESSAGE,
} from "@/lib/tasks/service";

// worker 循环护栏常量放在本模块：src/config/constants.ts 是 relation 生产桥接的
// 冻结参考文件，往里加常量会让受控快照哈希漂移（cluster-relation 桥接守卫会拒收）。
/** 任务执行期间并行看护循环的周期：覆盖 stale 回收、调度心跳与到期入队。 */
export const WORKER_WATCHDOG_INTERVAL_MS = 15 * 1000;

/** 单个任务执行的轮级软超时：到点请求取消（复用 workflow 取消检查点），不让 worker 永久卡死。 */
export const DEFAULT_TASK_DEADLINE_MS = 30 * MINUTE_MS;

/** 启动恢复（Mastra active workflow resume）的最长等待；超时后放行主循环，恢复在后台自行收尾。 */
export const WORKER_STARTUP_RECOVERY_GRACE_MS = 120 * 1000;

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 仅用于一次性护栏等待：unref 让短命进程（crash-recovery fixture 等）在 race 胜出后能自然退出。 */
function sleepUnrefed(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
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

  return enqueueScheduledTaskRunIfDue({
    scheduleId: schedule.id,
    expectedNextRunAt: schedule.nextRunAt,
    // RSS 读取当前源状态，漏调度只补抓一次，不逐个重放历史时点。
    nextRunAt: computeNextRunAt({
      cronExpression: schedule.cronExpression,
      now,
      timezone: schedule.timezone,
    }),
    kind: "ingestion",
    label: DEFAULT_INGESTION_TASK_LABEL,
  });
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

  const date = getScheduledReportDate(now, schedule.dailyReportOffsetDays);
  return enqueueScheduledTaskRunIfDue({
    scheduleId: schedule.id,
    expectedNextRunAt: schedule.nextRunAt,
    nextRunAt: computeNextRunAt({
      cronExpression: schedule.cronExpression,
      now,
      anchor: schedule.nextRunAt,
      timezone: schedule.timezone,
    }),
    kind: "daily_report_generate",
    label: `${DEFAULT_DAILY_REPORT_TASK_LABEL} ${date}`,
    entityId: date,
  });
}

async function enqueueScheduledItemCleanupIfDue(now: Date) {
  const schedule = await ensureDefaultItemCleanupSchedule();

  if (!schedule.enabled || schedule.nextRunAt.getTime() > now.getTime()) {
    return false;
  }

  return enqueueScheduledTaskRunIfDue({
    scheduleId: schedule.id,
    expectedNextRunAt: schedule.nextRunAt,
    nextRunAt: computeNextRunAt({
      cronExpression: schedule.cronExpression,
      now,
      anchor: schedule.nextRunAt,
      timezone: schedule.timezone,
    }),
    kind: "item_cleanup",
    label: DEFAULT_ITEM_CLEANUP_TASK_LABEL,
  });
}

export async function recoverStaleTaskRuns(
  now = new Date(),
  options?: {
    recoverInterruptedRuns?: boolean;
    cancellationRequestsOnly?: boolean;
    /** 本进程正在执行的任务：由轮级 deadline 与 workflow 取消检查点负责收口，stale 扫描不误杀。 */
    excludeIds?: string[];
  },
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
      ...(options?.excludeIds?.length ? { id: { notIn: options.excludeIds } } : {}),
    },
    select: {
      id: true,
    },
  });
  const staleRuns = options?.cancellationRequestsOnly
    ? []
    : await prisma.backgroundTaskRun.findMany({
        where: {
          status: "running",
          cancelRequestedAt: null,
          ...(options?.excludeIds?.length ? { id: { notIn: options.excludeIds } } : {}),
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

/** 本进程正在执行的任务：stale 扫描不误杀，由轮级 deadline 与 workflow 取消检查点负责收口。 */
const activeTaskRunIds = new Set<string>();

async function markTaskRunDeadlineExceeded(id: string, deadlineMs: number) {
  const minutes = Math.round(deadlineMs / MINUTE_MS);
  await prisma.backgroundTaskRun.updateMany({
    where: { id, status: "running", finishedAt: null },
    data: {
      errorSummary: `任务达到轮级时限（${minutes} 分钟），已请求取消；断点已保留，可重试续跑。`,
    },
  });
  await requestTaskRunCancellation(id);
}

/**
 * 轮级 deadline 护栏：workflow 卡死（如上游超时风暴）时，到点写入 cancelRequestedAt，
 * 由 workflow 取消检查点（cancelPollMs=1s）中止执行；继续等待 dispatch 结束，
 * 避免两个 workflow 并发写共享存储。
 */
export async function dispatchWithDeadline(
  taskRun: BackgroundTaskRun,
  execute: (taskRun: BackgroundTaskRun) => Promise<void>,
  deadlineMs: number = DEFAULT_TASK_DEADLINE_MS,
): Promise<void> {
  const dispatchPromise = execute(taskRun);
  const outcome = await Promise.race([
    dispatchPromise.then(
      () => "done" as const,
      () => "done" as const,
    ),
    sleep(deadlineMs).then(() => "deadline" as const),
  ]);

  if (outcome !== "deadline") {
    // 非 deadline 分支：重现真实结果/异常，交由调用方原有错误处理。
    await dispatchPromise;
    return;
  }

  console.error(
    `[Worker] Task ${taskRun.id} (${taskRun.kind}) exceeded deadline of ${deadlineMs}ms; requesting cancellation.`,
  );
  await markTaskRunDeadlineExceeded(taskRun.id, deadlineMs).catch(() => undefined);
  await dispatchPromise.catch(() => undefined);
}

/**
 * 看护循环：与任务执行并行推进 stale 回收、调度心跳与到期入队。
 * 任务执行期间主 cycle 不运行，没有看护循环时一个长任务会阻塞回收与全部调度。
 */
export async function runWorkerWatchdogTick(now = new Date()) {
  const recovered = await recoverStaleTaskRuns(now, {
    excludeIds: [...activeTaskRunIds],
  });
  await ensureDefaultIngestionSchedule();
  await ensureDefaultDailyReportSchedule();
  await ensureDefaultItemCleanupSchedule();
  await touchScheduleHeartbeat(now);
  await enqueueScheduledIngestionIfDue(now);
  await enqueueScheduledDailyReportIfDue(now);
  await enqueueScheduledItemCleanupIfDue(now);
  await enqueueItemProcessingRecoveryTask({ now, triggerType: "scheduled" }).catch(() => null);

  return recovered;
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
    activeTaskRunIds.add(claimedTaskRun.id);
    try {
      await dispatchWithDeadline(claimedTaskRun, options?.executeTaskRun ?? dispatchTaskRun);
    } catch (error) {
      console.error(`[Worker] Task ${claimedTaskRun.id} (${claimedTaskRun.kind}) crashed the workflow:`, error);
    } finally {
      activeTaskRunIds.delete(claimedTaskRun.id);
    }
  }

  return {
    enqueuedScheduledRun,
    enqueuedScheduledDailyReport,
    enqueuedScheduledCleanup,
    claimedTaskRunId: claimedTaskRun?.id ?? null,
  };
}

export async function recoverWorkerStartupTasks(
  now = new Date(),
  restartActiveRuns: () => Promise<void> = restartActiveAiWorkflowRuns,
) {
  // Honor cross-process cancellation before resuming any persisted workflow.
  await recoverStaleTaskRuns(now, { cancellationRequestsOnly: true });
  // Mastra restart awaits each active workflow. Keep its BackgroundTaskRun in
  // running while it resumes; otherwise the lifecycle sink correctly preserves
  // the prematurely projected failed state and business work can disagree with
  // the monitor row.
  // 启动恢复限时：resume 卡在慢 workflow（如上游超时风暴）时不能拖死主循环启动；
  // 超时后 resume 在后台自行收尾（lifecycle sink 投影终态），主循环立即接管调度。
  const resumePromise = restartActiveRuns();
  // grace 计时器必须 unref：race 胜出后（resume 快速完成），残留 timer 会阻塞
  // 短命进程（如 crash-recovery fixture 子进程）的事件循环直至超时。
  await Promise.race([resumePromise, sleepUnrefed(WORKER_STARTUP_RECOVERY_GRACE_MS)]);
  resumePromise.catch((error) => {
    console.error("[Worker] startup workflow resume failed:", error);
  });
  // Only stale rows still running after Mastra has resumed are orphans. Keep the
  // same grace window as regular reconciliation so another live worker's recent
  // claim is not failed merely because this process started.
  return recoverStaleTaskRuns(new Date());
}

export async function startWorkerLoop(options?: {
  pollIntervalMs?: number;
  executeTaskRun?: (taskRun: BackgroundTaskRun) => Promise<void>;
}) {
  // Compose currently runs one worker process; it owns startup recovery for the
  // shared Mastra/SQLite store before normal queue polling begins.
  await recoverWorkerStartupTasks();

  // 看护循环与任务执行并行：任务执行期间主 cycle 不运行，
  // 没有 watchdog 时一个长任务会阻塞 stale 回收与全部整点调度。
  const watchdog = setInterval(() => {
    void runWorkerWatchdogTick().catch((error) => {
      console.error("[Worker] watchdog tick failed:", error);
    });
  }, WORKER_WATCHDOG_INTERVAL_MS);

  try {
    while (true) {
      await runWorkerCycle({
        executeTaskRun: options?.executeTaskRun,
      });
      await sleep(options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    }
  } finally {
    clearInterval(watchdog);
  }
}
