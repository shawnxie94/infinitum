import { describe, expect, it } from "vitest";

import { resolveDailyReportTaskDate } from "@/lib/daily-report/date";

describe("resolveDailyReportTaskDate", () => {
  const NOW = new Date("2026-09-24T01:11:00.000Z");

  it("uses the entityId date for historical report retriggers", () => {
    expect(resolveDailyReportTaskDate("2026-09-23", NOW)).toBe("2026-09-23");
    expect(resolveDailyReportTaskDate("2026-01-01", NOW)).toBe("2026-01-01");
  });

  it("falls back to today only when entityId is missing or malformed", () => {
    expect(resolveDailyReportTaskDate(null, NOW)).toBe("2026-09-24");
    expect(resolveDailyReportTaskDate("", NOW)).toBe("2026-09-24");
    expect(resolveDailyReportTaskDate("2026-9-23", NOW)).toBe("2026-09-24");
    expect(resolveDailyReportTaskDate("not-a-date", NOW)).toBe("2026-09-24");
  });
});
