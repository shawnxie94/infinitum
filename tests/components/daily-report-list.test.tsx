import { render, screen, waitFor } from "@testing-library/react";
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
  it("keeps a mobile week filter when the desktop sidebar is hidden", async () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
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

    await waitFor(() => {
      expect(screen.getByLabelText("移动端周筛选")).toBeInTheDocument();
    });
    const mobileWeekFilter = screen.getByLabelText("移动端周筛选");
    expect(mobileWeekFilter).toHaveValue("2026-07-14");
    expect(screen.getByRole("heading", { name: "时间筛选" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /全部周/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "AI 日报" }).closest("section")?.className).toContain("border-b");

    const reportListLayout = screen.getByRole("heading", { name: "AI 日报" }).closest("section")?.parentElement?.parentElement;
    expect(reportListLayout?.className).toContain("min-w-0");
    expect(reportListLayout?.className).toContain("w-full");
  });

  it("keeps authenticated report cards inside the grid track", () => {
    render(
      <DailyReportList
        reports={[
          {
            id: "report-1",
            date: "2026-08-27",
            timezone: "Asia/Shanghai",
            status: "published",
            title: "OpenAI 自研推理芯片首测数据公布与多模态新模型发布",
            openingSummary: "https://example.com/a-very-long-unbroken-report-reference-that-must-not-expand-the-card-track",
            sourceCount: 1,
            generatedAt: "2026-08-27T00:00:00.000Z",
            publishedAt: "2026-08-27T00:00:00.000Z",
            errorMessage: null,
          },
        ]}
        weeks={[]}
        isAdmin
        selectedWeek={null}
        selectedStatus="all"
        total={1}
        page={1}
        pageSize={20}
      />,
    );

    const card = screen.getByRole("article");
    expect(card.className).toContain("min-w-0");
    expect(card.parentElement?.className).toContain("min-w-0");
  });
});
