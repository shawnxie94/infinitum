import { getDailyReportDateRange, getTodayDailyReportDate, normalizeDailyReportDate } from "@/lib/daily-report/date";
import type { EventBriefingDateRange } from "@/lib/events/types";

export function normalizeEventBriefingDate(value: string | null | undefined, now = new Date()) {
  if (!value?.trim()) {
    return getTodayDailyReportDate(now);
  }

  return normalizeDailyReportDate(value);
}

export function getEventBriefingDateRange(value: string | null | undefined, now = new Date()): EventBriefingDateRange {
  const range = getDailyReportDateRange(normalizeEventBriefingDate(value, now));

  return {
    date: range.date,
    start: range.start,
    end: range.end,
    timezone: "Asia/Shanghai",
  };
}

export function addEventBriefingDays(date: string, days: number) {
  const normalized = normalizeDailyReportDate(date);
  const [year, month, day] = normalized.split("-").map((part) => Number.parseInt(part, 10));
  const value = new Date(Date.UTC(year, month - 1, day));
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
