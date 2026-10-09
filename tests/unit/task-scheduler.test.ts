import { describe, expect, it } from "vitest";

import {
  computeNextRunAt,
  isSchedulerHeartbeatStale,
  normalizeScheduleInput,
} from "@/lib/tasks/scheduler";

describe("task scheduler", () => {
  it("computes the next run from the latest finished time", () => {
    const nextRunAt = computeNextRunAt({
      cronExpression: "*/30 * * * *",
      now: new Date("2026-04-12T00:00:00.000Z"),
      anchor: new Date("2026-04-12T00:10:00.000Z"),
      timezone: "Asia/Shanghai",
    });

    expect(nextRunAt.toISOString()).toBe("2026-04-12T00:30:00.000Z");
  });

  it("normalizes valid cron updates", () => {
    expect(
      normalizeScheduleInput({
        enabled: true,
        cronExpression: " */15 * * * * ",
        sourceConcurrency: 4,
        fullTextFetchThreshold: 120,
        perSourceItemLimit: 20,
        aggregationSplitMaxEvents: 12,
      }),
    ).toEqual({
      enabled: true,
      cronExpression: "*/15 * * * *",
      sourceConcurrency: 4,
      fullTextFetchThreshold: 120,
      perSourceItemLimit: 20,
      aggregationSplitMaxEvents: 12,
      processingStartAt: null,
      processingWindowDays: 14,
    });
  });

  it("accepts only integer dynamic processing windows from 1 through 3650 days", () => {
    const input = { enabled: true, cronExpression: "0 * * * *", sourceConcurrency: 1, fullTextFetchThreshold: 0, perSourceItemLimit: 1 };
    expect(normalizeScheduleInput({ ...input, processingWindowDays: 1 }).processingWindowDays).toBe(1);
    expect(normalizeScheduleInput({ ...input, processingWindowDays: 3650 }).processingWindowDays).toBe(3650);
    for (const processingWindowDays of [0, 3651, 1.5]) {
      expect(() => normalizeScheduleInput({ ...input, processingWindowDays })).toThrow();
    }
  });

  it("marks stale heartbeats after the timeout window", () => {
    expect(
      isSchedulerHeartbeatStale({
        lastHeartbeatAt: new Date("2026-04-12T00:00:00.000Z"),
        now: new Date("2026-04-12T00:00:31.000Z"),
        maxAgeMs: 30_000,
      }),
    ).toBe(true);
  });
});
