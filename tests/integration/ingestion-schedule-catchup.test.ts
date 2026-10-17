import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db";
import { runWorkerCycle } from "@/lib/tasks/worker";

const NOW = new Date("2026-10-17T08:15:30.000Z");
const MISSED_RUN = new Date("2026-10-16T08:00:00.000Z");
const NEXT_RUN = new Date("2026-10-17T09:00:00.000Z");

async function createIngestionSchedule(overrides: {
  enabled?: boolean;
  cronExpression?: string;
  timezone?: string;
  nextRunAt?: Date;
} = {}) {
  return prisma.taskSchedule.create({
    data: {
      key: "ingestion_default",
      enabled: true,
      cronExpression: "0 * * * *",
      sourceConcurrency: 2,
      fullTextFetchThreshold: 80,
      timezone: "Asia/Shanghai",
      nextRunAt: MISSED_RUN,
      ...overrides,
    },
  });
}

async function completeTaskRun({ id }: { id: string }) {
  await prisma.backgroundTaskRun.update({
    where: { id },
    data: { status: "succeeded", finishedAt: new Date() },
  });
}

function poll(now = NOW) {
  return runWorkerCycle({ now, executeTaskRun: completeTaskRun });
}

async function getIngestionSchedule() {
  return prisma.taskSchedule.findUniqueOrThrow({ where: { key: "ingestion_default" } });
}

describe("ingestion schedule catch-up", () => {
  beforeEach(async () => {
    await prisma.fetchRun.deleteMany();
    await prisma.backgroundTaskRun.deleteMany();
    await prisma.taskSchedule.deleteMany();
  });

  it("coalesces missed hourly runs into one catch-up and resumes at the next future hour", async () => {
    await createIngestionSchedule();

    expect((await poll()).enqueuedScheduledRun).toBe(true);
    expect((await getIngestionSchedule()).nextRunAt).toEqual(NEXT_RUN);

    for (const seconds of [2, 4, 6]) {
      const result = await poll(new Date(NOW.getTime() + seconds * 1000));
      expect(result.enqueuedScheduledRun).toBe(false);
    }
    expect(await prisma.backgroundTaskRun.count({ where: { kind: "ingestion" } })).toBe(1);
    expect(await prisma.backgroundTaskRun.findFirst({ where: { kind: "ingestion" } })).toMatchObject({
      triggerType: "scheduled",
      status: "succeeded",
    });

    expect((await poll(NEXT_RUN)).enqueuedScheduledRun).toBe(true);
    expect((await getIngestionSchedule()).nextRunAt).toEqual(new Date("2026-10-17T10:00:00.000Z"));
    expect(await prisma.backgroundTaskRun.count({ where: { kind: "ingestion" } })).toBe(2);
  });

  it("keeps normal execution at an exact scheduled boundary", async () => {
    await createIngestionSchedule({ nextRunAt: NEXT_RUN });

    expect((await poll(NEXT_RUN)).enqueuedScheduledRun).toBe(true);
    expect((await getIngestionSchedule()).nextRunAt).toEqual(new Date("2026-10-17T10:00:00.000Z"));
  });

  it("does not enqueue before the next run is due", async () => {
    await createIngestionSchedule({ nextRunAt: NEXT_RUN });

    expect((await poll()).enqueuedScheduledRun).toBe(false);
    expect((await getIngestionSchedule()).nextRunAt).toEqual(NEXT_RUN);
    expect(await prisma.backgroundTaskRun.count()).toBe(0);
  });

  it("does not advance or enqueue a disabled overdue schedule", async () => {
    await createIngestionSchedule({ enabled: false });

    expect((await poll()).enqueuedScheduledRun).toBe(false);
    expect((await getIngestionSchedule()).nextRunAt).toEqual(MISSED_RUN);
    expect(await prisma.backgroundTaskRun.count()).toBe(0);
  });

  it("uses the configured cron and timezone instead of replaying missed cron points", async () => {
    await createIngestionSchedule({
      cronExpression: "0 9 * * 1-5",
      timezone: "America/New_York",
      nextRunAt: new Date("2026-10-15T13:00:00.000Z"),
    });

    expect((await poll()).enqueuedScheduledRun).toBe(true);
    expect((await getIngestionSchedule()).nextRunAt).toEqual(new Date("2026-10-19T13:00:00.000Z"));
    expect((await poll()).enqueuedScheduledRun).toBe(false);
  });

  it("preserves the overdue schedule while another ingestion is running", async () => {
    await createIngestionSchedule();
    const activeRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "ingestion",
        triggerType: "manual",
        status: "running",
        label: "Existing ingestion",
        startedAt: NOW,
      },
    });

    expect((await poll()).enqueuedScheduledRun).toBe(false);
    expect((await getIngestionSchedule()).nextRunAt).toEqual(MISSED_RUN);
    expect(await prisma.backgroundTaskRun.findUnique({ where: { id: activeRun.id } })).toMatchObject({
      status: "running",
    });
    expect(await prisma.backgroundTaskRun.count()).toBe(1);

    await completeTaskRun(activeRun);
    expect((await poll()).enqueuedScheduledRun).toBe(true);
    expect((await getIngestionSchedule()).nextRunAt).toEqual(NEXT_RUN);
    expect(await prisma.backgroundTaskRun.count({ where: { kind: "ingestion" } })).toBe(2);
  });

  it("creates only one catch-up task when worker cycles race", async () => {
    await createIngestionSchedule();

    const results = await Promise.all([poll(), poll()]);

    expect(results.filter((result) => result.enqueuedScheduledRun)).toHaveLength(1);
    expect(await prisma.backgroundTaskRun.count({ where: { kind: "ingestion" } })).toBe(1);
    expect((await getIngestionSchedule()).nextRunAt).toEqual(NEXT_RUN);
  });

  it.each([
    {
      key: "daily_report_default",
      kind: "daily_report_generate",
      cronExpression: "0 6 * * *",
      missedRun: "2026-10-15T22:00:00.000Z",
      nextRun: "2026-10-16T22:00:00.000Z",
    },
    {
      key: "item_cleanup_default",
      kind: "item_cleanup",
      cronExpression: "20 3 * * *",
      missedRun: "2026-10-15T19:20:00.000Z",
      nextRun: "2026-10-16T19:20:00.000Z",
    },
  ] as const)("preserves anchored catch-up for $key", async ({ key, kind, cronExpression, missedRun, nextRun }) => {
    await prisma.taskSchedule.create({
      data: {
        key,
        enabled: true,
        cronExpression,
        sourceConcurrency: 2,
        fullTextFetchThreshold: 80,
        timezone: "Asia/Shanghai",
        nextRunAt: new Date(missedRun),
      },
    });

    await poll();

    const schedule = await prisma.taskSchedule.findUniqueOrThrow({ where: { key } });
    expect(schedule.nextRunAt).toEqual(new Date(nextRun));
    expect(await prisma.backgroundTaskRun.count({ where: { kind } })).toBe(1);
  });
});
