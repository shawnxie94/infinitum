import { DAILY_REPORT_TIMEZONE } from "@/lib/daily-report/types";

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAILY_REPORT_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: DAILY_REPORT_TIMEZONE,
});

export function normalizeDailyReportDate(value: string) {
  const normalized = value.trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new Error("日报日期必须是 YYYY-MM-DD 格式。");
  }

  const [year, month, day] = normalized.split("-").map((part) => Number.parseInt(part, 10));
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    throw new Error("日报日期不存在。");
  }

  return normalized;
}

export function assertDailyReportDateIsNotFuture(value: string, now = new Date()) {
  const normalized = normalizeDailyReportDate(value);
  if (normalized > getTodayDailyReportDate(now)) {
    throw new Error("不能生成未来日期的 AI 日报。");
  }
  return normalized;
}

export function getDailyReportDateRange(date: string, timezone = DAILY_REPORT_TIMEZONE) {
  if (timezone !== DAILY_REPORT_TIMEZONE) {
    throw new Error("当前仅支持 Asia/Shanghai 日报时区。");
  }

  const normalized = normalizeDailyReportDate(date);
  const [year, month, day] = normalized.split("-").map((part) => Number.parseInt(part, 10));
  const start = new Date(Date.UTC(year, month - 1, day) - SHANGHAI_OFFSET_MS);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  return { start, end, date: normalized, timezone };
}

export function getTodayDailyReportDate(now = new Date()) {
  return new Date(now.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * 日报任务的生成日期：entityId 携带合法日期（重触发历史日报）时用 entityId，
 * 否则回退今天。校验必须是"数字位数"而非字面反斜杠——此前误写为 \\d 导致
 * 重触发历史日期静默变成当天，简报窗口错位、候选锐减。
 */
export function resolveDailyReportTaskDate(entityId: string | null | undefined, now = new Date()) {
  return entityId && /^\d{4}-\d{2}-\d{2}$/.test(entityId) ? entityId : getTodayDailyReportDate(now);
}

export function formatDailyReportDateTime(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  return DAILY_REPORT_DATE_TIME_FORMATTER.format(date);
}
