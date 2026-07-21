import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EventBriefingList } from "@/components/events/event-briefing-list";
import { ToastProvider } from "@/components/ui/toast";
import type { EventBriefingDTO } from "@/lib/events/types";

const routerPushMock = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: routerPushMock,
  }),
}));

function buildBriefing(overrides: Partial<EventBriefingDTO> = {}): EventBriefingDTO {
  return {
    date: "2026-06-30",
    channel: {
      id: "important",
      name: "重点事件",
      sourceGroupIds: [],
      enabled: true,
      sortOrder: 0,
      count: 96,
    },
    channels: [
      {
        id: "important",
        name: "重点事件",
        sourceGroupIds: [],
        enabled: true,
        sortOrder: 0,
        count: 96,
      },
      {
        id: "insight",
        name: "观点实践",
        sourceGroupIds: ["group-blog"],
        enabled: true,
        sortOrder: 1,
        count: 24,
      },
    ],
    timezone: "Asia/Shanghai",
    generatedAt: "2026-06-30T10:00:00.000Z",
    summary: {
      eventCount: 96,
    },
    pagination: {
      page: 1,
      pageSize: 30,
      total: 96,
      totalPages: 4,
    },
    entries: [
      {
        id: "cluster-openai",
        type: "cluster",
        title: "OpenAI 发布新的 Agent 工具链能力",
        summary: "OpenAI 更新了面向开发者的 Agent 工具链。",
        qualityScore: 91,
        rankScore: 91,
        baseRankScore: 82,
        curatorBoost: 9,
        curatorPenalty: 0,
        isFollowUp: true,
        sourceCount: 5,
        itemCount: 12,
        newItemCountOnDate: 3,
        newSourceCountOnDate: 2,
        latestCreatedAt: "2026-06-30T13:50:00.000Z",
        latestPublishedAt: "2026-06-30T13:10:00.000Z",
        eventType: "launch",
        eventSubject: "OpenAI",
        eventAction: "发布",
        eventObject: "Agent 工具链",
        eventDate: "2026-06-30",
        detailHref: "/?entryKeys=cluster%3Acluster-openai",
        items: [
          {
            id: "item-openai-1",
            title: "OpenAI Agent 工具链正式发布",
            summary: "OpenAI 发布了面向开发者的 **Agent SDK**，包含工具调用和工作流能力。",
            sourceName: "OpenAI Blog",
            originalUrl: "https://openai.com/agent",
            publishedAt: "2026-06-30T13:10:00.000Z",
            createdAt: "2026-06-30T13:50:00.000Z",
            qualityScore: 91,
          },
          {
            id: "item-openai-2",
            title: "开发者工具链新增自动化能力",
            summary: "第二条完整摘要。",
            sourceName: "Tech Media",
            originalUrl: "https://example.com/agent-2",
            publishedAt: "2026-06-30T12:10:00.000Z",
            createdAt: "2026-06-30T12:50:00.000Z",
            qualityScore: 88,
          },
          {
            id: "item-openai-3",
            title: "Agent 工具链生态观察",
            summary: "第三条完整摘要。",
            sourceName: "AI Weekly",
            originalUrl: "https://example.com/agent-3",
            publishedAt: "2026-06-30T11:10:00.000Z",
            createdAt: "2026-06-30T11:50:00.000Z",
            qualityScore: 86,
          },
          {
            id: "item-openai-4",
            title: "更多 Agent 工具链细节",
            summary: "第四条完整摘要。",
            sourceName: "Dev News",
            originalUrl: "https://example.com/agent-4",
            publishedAt: "2026-06-30T10:10:00.000Z",
            createdAt: "2026-06-30T10:50:00.000Z",
            qualityScore: 82,
          },
        ],
      },
    ],
    ...overrides,
  };
}

function renderEventBriefingList(
  briefing: EventBriefingDTO,
  props: Omit<ComponentProps<typeof EventBriefingList>, "briefing"> = {},
) {
  return render(
    <ToastProvider>
      <EventBriefingList briefing={briefing} {...props} />
    </ToastProvider>,
  );
}

describe("EventBriefingList", () => {
  beforeEach(() => {
    routerPushMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders a compact date toolbar and dense ranked event list", () => {
    renderEventBriefingList(buildBriefing());

    expect(screen.getByRole("heading", { name: "事件速览" })).toBeInTheDocument();
    expect(screen.queryByText(/当日采集 300 条资讯/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "上一天" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "下一天" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "今天" })).not.toBeInTheDocument();
    expect(screen.queryByText("共 96 个重点事件，85 个新增，11 个有新动态。")).not.toBeInTheDocument();
    expect(screen.getByLabelText("选择日期")).toHaveAttribute("type", "date");
    expect(screen.getByText("日期：")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "重点事件 96" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "观点实践 24" })).toHaveAttribute(
      "href",
      "/events?date=2026-06-30&channel=insight",
    );
    expect(screen.queryByRole("link", { name: /全部/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /最新进展/ })).not.toBeInTheDocument();

    const card = screen.getByRole("article");
    expect(within(card).getByText("#01")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "OpenAI 发布新的 Agent 工具链能力" })).toBeInTheDocument();
    expect(within(card).getByText("5 来源")).toBeInTheDocument();
    expect(within(card).getByText("12 条")).toBeInTheDocument();
    expect(within(card).getByText("新进展")).toBeInTheDocument();
    expect(within(card).queryByText("OpenAI 更新了面向开发者的 Agent 工具链。")).not.toBeInTheDocument();
    expect(within(card).queryByText("有新动态")).not.toBeInTheDocument();
    expect(within(card).queryByText(/排序/)).not.toBeInTheDocument();
    expect(within(card).queryByText(/入选/)).not.toBeInTheDocument();
    expect(within(card).queryByText(/OpenAI Blog/)).not.toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /提升事件偏好/ })).not.toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /降低事件偏好/ })).not.toBeInTheDocument();
  });

  it("shows manual preference buttons only for admins and records manual feedback", () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetchMock);

    renderEventBriefingList(buildBriefing(), { initialIsAdmin: true });

    const card = screen.getByRole("article");
    const boostButton = within(card).getByRole("button", {
      name: "提升事件偏好：OpenAI 发布新的 Agent 工具链能力",
    });
    const penaltyButton = within(card).getByRole("button", {
      name: "降低事件偏好：OpenAI 发布新的 Agent 工具链能力",
    });

    fireEvent.click(boostButton);
    expect(boostButton).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("已记录为更关注的事件。")).toBeInTheDocument();
    fireEvent.click(penaltyButton);
    expect(penaltyButton).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("已记录为降低关注的事件。")).toBeInTheDocument();

    expect(fetchMock).toHaveBeenCalledWith("/api/admin/curator-behavior", expect.objectContaining({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventType: "manual_boost",
        targetType: "event",
        targetId: "cluster-openai",
        entryType: "cluster",
        entryId: "cluster-openai",
        clusterId: "cluster-openai",
        itemId: null,
      }),
    }));
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/curator-behavior", expect.objectContaining({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventType: "manual_penalty",
        targetType: "event",
        targetId: "cluster-openai",
        entryType: "cluster",
        entryId: "cluster-openai",
        clusterId: "cluster-openai",
        itemId: null,
      }),
    }));
  });

  it("marks non-follow-up entries as new content", () => {
    renderEventBriefingList(buildBriefing({
      entries: [
        {
          ...buildBriefing().entries[0]!,
          isFollowUp: false,
        },
      ],
    }));

    const card = screen.getByRole("article");

    expect(within(card).getByText("新内容")).toBeInTheDocument();
    expect(within(card).queryByText("新进展")).not.toBeInTheDocument();
  });

  it("opens a detail modal with full summaries and expandable cluster items", () => {
    renderEventBriefingList(buildBriefing({
      entries: [
        {
          ...buildBriefing().entries[0]!,
          summary: "**Agent SDK** 发布，参考 [文档](/docs) 和 `npm` 包。",
        },
      ],
    }));

    const card = screen.getByRole("article");

    expect(within(card).queryByText("发生了什么：")).not.toBeInTheDocument();
    expect(within(card).queryByText("为什么重要：")).not.toBeInTheDocument();
    expect(within(card).queryByText("Agent SDK")).not.toBeInTheDocument();

    fireEvent.click(within(card).getByRole("button", { name: "OpenAI 发布新的 Agent 工具链能力" }));

    const dialog = screen.getByRole("dialog", { name: "事件详情" });
    expect(within(dialog).getAllByText("Agent SDK")[0]).toHaveClass("font-semibold");
    expect(within(dialog).getByText("来源: 5 个")).toBeInTheDocument();
    expect(within(dialog).getByText("条目: 12 条")).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "文档" })).toHaveAttribute("href", "/docs");
    expect(within(dialog).getByText("npm").tagName.toLowerCase()).toBe("code");
    expect(within(dialog).getByRole("button", { name: "4 条" })).toHaveAttribute("aria-expanded", "false");
    expect(within(dialog).getByRole("button", { name: "展开聚合条目" })).toHaveAttribute("aria-expanded", "false");
    expect(within(dialog).queryByRole("link", { name: "OpenAI Agent 工具链正式发布" })).not.toBeInTheDocument();
    expect(within(dialog).queryByText("更多 Agent 工具链细节")).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "展开聚合条目" }));
    expect(within(dialog).getByRole("button", { name: "4 条" })).toHaveAttribute("aria-expanded", "true");
    expect(within(dialog).getByRole("link", { name: "OpenAI Agent 工具链正式发布" })).toHaveAttribute(
      "href",
      "https://openai.com/agent",
    );
    expect(within(dialog).getByText("更多 Agent 工具链细节")).toBeInTheDocument();

    fireEvent.keyDown(within(dialog).getByRole("button", { name: "收起聚合条目" }), { key: "Enter" });
    expect(within(dialog).getByRole("button", { name: "4 条" })).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(within(dialog).getByRole("button", { name: "4 条" }));
    expect(within(dialog).getByRole("button", { name: "4 条" })).toHaveAttribute("aria-expanded", "true");
  });

  it("does not render original item list for single event details", () => {
    renderEventBriefingList(buildBriefing({
      entries: [
        {
          ...buildBriefing().entries[0]!,
          id: "item-single",
          type: "single",
          title: "单篇重点事件",
          sourceCount: 1,
          itemCount: 1,
          items: [
            {
              id: "item-single",
              title: "单篇原文标题",
              summary: "单篇原文摘要。",
              sourceName: "Tech Media",
              originalUrl: "https://example.com/single",
              publishedAt: "2026-06-30T12:10:00.000Z",
              createdAt: "2026-06-30T12:50:00.000Z",
              qualityScore: 88,
            },
          ],
        },
      ],
    }));

    fireEvent.click(screen.getByRole("button", { name: "单篇重点事件" }));

    const dialog = screen.getByRole("dialog", { name: "事件详情" });
    expect(within(dialog).getByText("单篇")).toBeInTheDocument();
    expect(within(dialog).getByText("来源: Tech Media")).toBeInTheDocument();
    expect(within(dialog).queryByText("来源: 1 个")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("条目: 1 条")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "单篇重点事件" })).toHaveAttribute(
      "href",
      "https://example.com/single",
    );
    expect(within(dialog).queryByRole("button", { name: /条/ })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("link", { name: "单篇原文标题" })).not.toBeInTheDocument();
    expect(within(dialog).queryByText("单篇原文摘要。")).not.toBeInTheDocument();
  });

  it("shows the source name for a single-source cluster", () => {
    const entry = buildBriefing().entries[0]!;

    renderEventBriefingList(buildBriefing({
      entries: [
        {
          ...entry,
          sourceCount: 1,
          itemCount: 2,
          items: entry.items.slice(0, 2).map((item) => ({
            ...item,
            sourceName: "OpenAI Blog",
          })),
        },
      ],
    }));

    fireEvent.click(screen.getByRole("button", { name: "OpenAI 发布新的 Agent 工具链能力" }));

    const dialog = screen.getByRole("dialog", { name: "事件详情" });
    expect(within(dialog).getByText("来源: OpenAI Blog")).toBeInTheDocument();
    expect(within(dialog).queryByText("来源: 1 个")).not.toBeInTheDocument();
    expect(within(dialog).getByText("条目: 2 条")).toBeInTheDocument();
  });

  it("renders an empty state when no events are available", () => {
    renderEventBriefingList(buildBriefing({
      entries: [],
      summary: {
        eventCount: 0,
      },
      pagination: {
        page: 1,
        pageSize: 30,
        total: 0,
        totalPages: 1,
      },
    }));

    expect(screen.getByText("当天暂无可展示的速览内容。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看主页" })).toHaveAttribute("href", "/");
  });

  it("uses the shared pagination style and preserves non-default page size", () => {
    const { container } = renderEventBriefingList(buildBriefing({
      pagination: {
        page: 2,
        pageSize: 50,
        total: 96,
        totalPages: 2,
      },
    }));

    expect(screen.getByRole("combobox", { name: "每页显示" })).toHaveValue("50");
    expect(screen.getByRole("spinbutton", { name: "跳转页码" })).toHaveValue(2);
    fireEvent.click(screen.getByRole("button", { name: "上一页" }));
    expect(routerPushMock).toHaveBeenCalledWith("/events?date=2026-06-30&channel=important&size=50");
    fireEvent.change(screen.getByRole("spinbutton", { name: "跳转页码" }), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "跳转" }));
    expect(routerPushMock).toHaveBeenCalledWith("/events?date=2026-06-30&channel=important&size=50");
  });


  it("changes date immediately via the labeled date control", () => {
    renderEventBriefingList(buildBriefing());

    fireEvent.change(screen.getByLabelText("选择日期"), { target: { value: "2026-07-01" } });

    expect(routerPushMock).toHaveBeenCalledWith("/events?date=2026-07-01&channel=important");
  });
  it("preserves active channel in date search and pagination", () => {
    const { container } = renderEventBriefingList(buildBriefing({
      pagination: {
        page: 1,
        pageSize: 50,
        total: 96,
        totalPages: 2,
      },
    }));

    expect(screen.getByRole("link", { name: "重点事件 96" })).toHaveAttribute(
      "href",
      "/events?date=2026-06-30&channel=important&size=50",
    );
    expect(screen.getByLabelText("选择日期")).toHaveValue("2026-06-30");
    expect(container.querySelector('input[name="view"]')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(routerPushMock).toHaveBeenCalledWith("/events?date=2026-06-30&channel=important&page=2&size=50");
  });
});
