import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
}));

import { DailyReportList } from "@/components/daily/daily-report-list";

describe("DailyReportList", () => {
  it("keeps a mobile week filter when the desktop sidebar is hidden", () => {
    render(
      <DailyReportList
        reports={[]}
        weeks={[
          { key: "2026-07-14", label: "07/14 - 07/20", count: 3 },
          { key: "2026-07-07", label: "07/07 - 07/13", count: 2 },
        ]}
        isAdmin={false}
        selectedWeek="2026-07-14"
        selectedStatus="published"
        total={0}
        page={1}
        pageSize={10}
      />,
    );

    const mobileWeekFilter = screen.getByLabelText("移动端周筛选");
    expect(mobileWeekFilter).toBeInTheDocument();
    expect(mobileWeekFilter).toHaveValue("2026-07-14");
    expect(screen.getByRole("heading", { name: "时间筛选" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /全部周/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "AI 日报" }).closest("section")?.className).toContain("border-b");
  });
});
