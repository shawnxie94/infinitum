import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ActionItemsPanel } from "@/components/admin/action-items-panel";
import { ToastProvider } from "@/components/ui/toast";
import type { ActionableMonitorSnapshot } from "@/lib/admin/actionable-monitor";

function renderWithProviders() {
  return render(
    <ToastProvider>
      <ActionItemsPanel />
    </ToastProvider>,
  );
}

function buildActionableSnapshot(): ActionableMonitorSnapshot {
  return {
    generatedAt: "2026-06-30T00:00:00.000Z",
    rangeDays: 1,
    since: "2026-06-29T00:00:00.000Z",
    totalCount: 13,
    criticalCount: 1,
    warningCount: 3,
    items: [
      {
        id: "sources",
        category: "source",
        severity: "critical",
        title: "异常信息源",
        description: "2 个启用信息源需要关注。",
        count: 2,
        href: "/admin?tab=monitoring&section=dashboard&sourceSummary=open",
        actionLabel: "查看",
        details: ["Broken RSS：抓取异常：HTTP 500"],
      },
      {
        id: "filtered-content",
        category: "content",
        severity: "info",
        title: "过滤内容复核",
        description: "4 条内容被过滤，可抽样检查规则或 AI 判定是否误伤。",
        count: 4,
        href: "/admin?tab=monitoring&section=content&view=filtered&rangeDays=1",
        actionLabel: "查看",
        details: ["Broken RSS：被过滤内容（信息密度不足）"],
      },
      {
        id: "tags",
        category: "tag",
        severity: "warning",
        title: "标签治理建议",
        description: "当前有 3 条标签建议，其中 1 条可优先合并。",
        count: 3,
        href: "/admin?tab=monitoring&section=content&view=tags&suggestions=open",
        actionLabel: "查看",
        details: ["AI Agents → AI Agent，影响 4 条，置信 99%"],
      },
      {
        id: "briefing-preferences",
        category: "preference",
        severity: "info",
        title: "偏好建议",
        description: "当前有 2 条事件偏好建议等待复核。",
        count: 2,
        href: "/admin?tab=settings&section=content&view=event-briefing&suggestions=open",
        actionLabel: "查看",
        details: [],
      },
      {
        id: "aggregation-splits",
        category: "split",
        severity: "warning",
        title: "聚合拆分复核",
        description: "1 条聚合拆分记录需要巡检，其中待拆分 0 条、已拆分 0 条、解析失败 1 条。",
        count: 1,
        href: "/admin?tab=monitoring&section=content&view=splits&rangeDays=1",
        actionLabel: "查看",
        details: ["Broken RSS：聚合内容（解析失败，0 个子事件）"],
      },
      {
        id: "clusters",
        category: "cluster",
        severity: "warning",
        title: "聚合待定",
        description: "1 组聚合合并候选仍需确认。",
        count: 1,
        href: "/admin?tab=monitoring&section=content&view=clusters&review=pending&rangeDays=1",
        actionLabel: "查看",
        details: ["Model launch / Model release，置信 91%"],
      },
    ],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ActionItemsPanel", () => {
  it("renders focused action items and refreshes by range", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = String(input);
      const rangeDays = url.includes("rangeDays=3") ? 3 : 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            ...buildActionableSnapshot(),
            rangeDays,
            since: rangeDays === 3 ? "2026-06-27T00:00:00.000Z" : "2026-06-29T00:00:00.000Z",
          }),
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders();

    expect(await screen.findByRole("heading", { name: "待办事项" })).toBeInTheDocument();
    expect(screen.getByText("实时聚合异常和近期待处理事项")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/monitor/action-items?rangeDays=1");
    expect(screen.getByRole("button", { name: "1天" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "3天" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual([
      "过滤内容复核",
      "标签治理建议",
      "异常信息源",
      "偏好建议",
      "聚合拆分复核",
      "聚合待定",
      "近期失败任务",
    ]);

    const sourceCard = screen.getByRole("heading", { name: "异常信息源" }).closest("article");
    expect(sourceCard).not.toBeNull();
    expect(within(sourceCard!).getByText("2 个启用信息源需要关注。")).toBeInTheDocument();
    expect(within(sourceCard!).getByText("2")).toBeInTheDocument();
    expect(within(sourceCard!).queryByText("当前需关注")).not.toBeInTheDocument();
    expect(within(sourceCard!).queryByText("优先处理")).not.toBeInTheDocument();
    expect(within(sourceCard!).queryByText("信息源")).not.toBeInTheDocument();
    expect(within(sourceCard!).getByRole("link", { name: "查看" })).toHaveAttribute(
      "href",
      "/admin?tab=monitoring&section=dashboard&sourceSummary=open",
    );

    expect(screen.getByText("过滤内容复核")).toBeInTheDocument();
    expect(screen.getByText("聚合拆分复核")).toBeInTheDocument();
    expect(screen.queryByText("自动化边界")).not.toBeInTheDocument();
    expect(screen.queryByText("待处理总量")).not.toBeInTheDocument();
    expect(screen.queryByText("代表事项")).not.toBeInTheDocument();
    expect(screen.queryByText("处理方式")).not.toBeInTheDocument();
    expect(screen.queryByText("任务")).not.toBeInTheDocument();
    expect(screen.queryByText("Broken RSS：被过滤内容（信息密度不足）")).not.toBeInTheDocument();
    const tagCard = screen.getByRole("heading", { name: "标签治理建议" }).closest("article");
    expect(tagCard).not.toBeNull();
    expect(within(tagCard!).getByRole("link", { name: "查看" })).toHaveAttribute(
      "href",
      "/admin?tab=monitoring&section=content&view=tags&suggestions=open",
    );
    const preferenceCard = screen.getByRole("heading", { name: "偏好建议" }).closest("article");
    expect(preferenceCard).not.toBeNull();
    expect(within(preferenceCard!).getByRole("link", { name: "查看" })).toHaveAttribute(
      "href",
      "/admin?tab=settings&section=content&view=event-briefing&suggestions=open",
    );

    await user.click(screen.getByRole("button", { name: "3天" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/monitor/action-items?rangeDays=3");
    });
    expect(screen.getByRole("button", { name: "3天" })).toHaveAttribute("aria-pressed", "true");
  });

  it("shows zero-count cards when there are no actionable items", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            generatedAt: "2026-06-30T00:00:00.000Z",
            rangeDays: 1,
            since: "2026-06-29T00:00:00.000Z",
            totalCount: 0,
            criticalCount: 0,
            warningCount: 0,
            items: [],
          } satisfies ActionableMonitorSnapshot),
        ),
      ),
    );

    renderWithProviders();

    expect(await screen.findByRole("heading", { name: "异常信息源" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "标签治理建议" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "偏好建议" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "过滤内容复核" })).toBeInTheDocument();
    expect(screen.getByText("当前没有待处理的标签治理建议。")).toBeInTheDocument();
    expect(screen.getByText("当前没有待处理的事件偏好建议。")).toBeInTheDocument();
    expect(screen.getAllByText("0")).toHaveLength(7);
    expect(screen.queryByText("当前没有待处理事项")).not.toBeInTheDocument();
  });
});
