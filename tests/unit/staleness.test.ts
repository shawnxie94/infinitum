import { describe, expect, it } from "vitest";

import {
  evaluateStaleContent,
  STALE_CONTENT_FILTER_REASON,
  STALE_EVENT_MAX_AGE_DAYS,
} from "@/lib/ingestion/staleness";

describe("evaluateStaleContent", () => {
  const now = new Date("2026-10-04T00:00:00.000Z");

  it("事件时间早于基准超过阈值时判为过时内容", () => {
    const result = evaluateStaleContent({
      eventDate: "2026-09-01",
      publishedAt: now,
      publishedAtKnown: true,
      restoredByAdminAt: null,
      referenceAt: now,
    });

    expect(result.stale).toBe(true);
    expect(result.reason).toBe(STALE_CONTENT_FILTER_REASON);
    expect(result.detail).toContain("2026-09-01");
    expect(result.ageDays).toBe(33);
  });

  it("事件时间在阈值内不过滤", () => {
    const result = evaluateStaleContent({
      eventDate: "2026-10-01",
      publishedAt: now,
      publishedAtKnown: true,
      restoredByAdminAt: null,
      referenceAt: now,
    });

    expect(result.stale).toBe(false);
    expect(result.reason).toBeNull();
  });

  it("事件时间恰好等于阈值天数时不过滤", () => {
    const publishedAt = new Date("2026-10-04T00:00:00.000Z");
    const result = evaluateStaleContent({
      eventDate: "2026-09-27",
      publishedAt,
      publishedAtKnown: true,
      restoredByAdminAt: null,
      referenceAt: publishedAt,
    });

    expect(result.ageDays).toBe(STALE_EVENT_MAX_AGE_DAYS);
    expect(result.stale).toBe(false);
  });

  it("事件时间为空时不过滤", () => {
    const result = evaluateStaleContent({
      eventDate: null,
      publishedAt: now,
      publishedAtKnown: true,
      restoredByAdminAt: null,
      referenceAt: now,
    });

    expect(result.stale).toBe(false);
    expect(result.ageDays).toBeNull();
  });

  it("事件时间为空串或非法格式时不过滤", () => {
    for (const eventDate of ["", "   ", "2026/09/01", "2026-9-1", "not-a-date", undefined]) {
      const result = evaluateStaleContent({
        eventDate,
        publishedAt: now,
        publishedAtKnown: true,
        restoredByAdminAt: null,
        referenceAt: now,
      });

      expect(result.stale).toBe(false);
    }
  });

  it("管理员已恢复的条目不再被判定为过时", () => {
    const result = evaluateStaleContent({
      eventDate: "2026-01-01",
      publishedAt: now,
      publishedAtKnown: true,
      restoredByAdminAt: now,
      referenceAt: now,
    });

    expect(result.stale).toBe(false);
  });

  it("publishedAt 未知时用入库时间兜底", () => {
    const result = evaluateStaleContent({
      eventDate: "2026-09-01",
      publishedAt: new Date("2026-01-01T00:00:00.000Z"),
      publishedAtKnown: false,
      restoredByAdminAt: null,
      referenceAt: now,
    });

    expect(result.stale).toBe(true);
    expect(result.baseline).toBe("入库时间");
  });

  it("publishedAt 已知时以发布时间为基准，历史补抓不会误判", () => {
    const publishedAt = new Date("2026-09-02T00:00:00.000Z");
    const result = evaluateStaleContent({
      eventDate: "2026-09-01",
      publishedAt,
      publishedAtKnown: true,
      restoredByAdminAt: null,
      referenceAt: now,
    });

    expect(result.stale).toBe(false);
    expect(result.baseline).toBe("发布时间");
  });

  it("事件时间晚于基准时不过滤", () => {
    const result = evaluateStaleContent({
      eventDate: "2026-12-01",
      publishedAt: now,
      publishedAtKnown: true,
      restoredByAdminAt: null,
      referenceAt: now,
    });

    expect(result.stale).toBe(false);
  });

  it("基准时间缺失时不过滤", () => {
    const result = evaluateStaleContent({
      eventDate: "2020-01-01",
      publishedAt: null,
      publishedAtKnown: true,
      restoredByAdminAt: null,
      referenceAt: null,
    });

    expect(result.stale).toBe(false);
    expect(result.baseline).toBeNull();
  });
});
