import { act, fireEvent, render as testingRender, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { openMock, pushMock, refreshMock, replaceMock, scrollToMock } = vi.hoisted(() => ({
  openMock: vi.fn(),
  pushMock: vi.fn(),
  refreshMock: vi.fn(),
  replaceMock: vi.fn(),
  scrollToMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushMock,
    refresh: refreshMock,
    replace: replaceMock,
  }),
}));

import { FeedPanel } from "@/components/feed/feed-panel";
import type { FeedEntryDTO, FeedGroupOption, FeedRange, FeedSort, FeedSourceOption, FeedTagOption } from "@/lib/feed/types";

type TestingRenderParameters = Parameters<typeof testingRender>;

function render(ui: TestingRenderParameters[0], options?: TestingRenderParameters[1]) {
  const getTimezoneOffsetSpy = vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(0);

  try {
    return testingRender(ui, options);
  } finally {
    getTimezoneOffsetSpy.mockRestore();
  }
}

function renderWithTimezoneOffset(
  ui: TestingRenderParameters[0],
  timeZoneOffsetMinutes: number,
  options?: TestingRenderParameters[1],
) {
  const getTimezoneOffsetSpy = vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(timeZoneOffsetMinutes);

  try {
    return testingRender(ui, options);
  } finally {
    getTimezoneOffsetSpy.mockRestore();
  }
}

const initialEntries: FeedEntryDTO[] = [
  {
    id: "cluster-1",
    type: "cluster",
    title: "OpenAI Agent 发布",
    summary: "聚合摘要内容",
    group: {
      id: "group-ai",
      name: "AI",
      color: "#3b82f6",
    },
    publishedAt: "2026-04-10T09:00:00.000Z",
    createdAt: "2026-04-10T09:00:00.000Z",
    latestPublishedAt: "2026-04-10T09:00:00.000Z",
    score: 90,
    sourceCount: 2,
    itemCount: 2,
    itemsPreview: [
      {
        id: "item-preview-1",
        title: "预览标题",
        originalUrl: "https://example.com/preview",
        publishedAt: "2026-04-10T09:00:00.000Z",
        sourceName: "Example Feed",
        author: "Alex",
        summary: "预览摘要",
        group: {
          id: "group-ai",
          name: "AI",
          color: "#3b82f6",
        },
        score: 88,
        canRegenerateTranslation: true,
      },
    ],
    hasMoreItems: true,
  },
  {
    id: "item-1",
    type: "single",
    title: "中文标题",
    originalUrl: "https://example.com/posts/1",
    publishedAt: "2026-04-09T09:00:00.000Z",
    createdAt: "2026-04-09T09:00:00.000Z",
    latestPublishedAt: "2026-04-09T09:00:00.000Z",
    sourceName: "Example Feed",
    author: "Alex",
    summary: "摘要内容",
    group: {
      id: "group-research",
      name: "研究",
      color: "#14b8a6",
    },
    score: 72,
    sourceCount: 1,
    itemCount: 1,
    canRegenerateTranslation: true,
  },
];

const availableGroups: FeedGroupOption[] = [
  {
    id: "group-ai",
    name: "AI",
    count: 1,
  },
  {
    id: "group-research",
    name: "研究",
    count: 1,
  },
];

const availableSources: FeedSourceOption[] = [
  {
    id: "source-ai",
    name: "AI Source",
    groupId: "group-ai",
  },
  {
    id: "source-research",
    name: "Research Source",
    groupId: "group-research",
  },
];

function getSelectRoot(name: string) {
  return screen.getByRole("combobox", { name }).closest(".select-modern-antd");
}

function getFetchUrl(input: RequestInfo | URL) {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof Request) {
    return input.url;
  }

  return input.toString();
}

async function selectFilterOption(user: ReturnType<typeof userEvent.setup>, name: string, optionText: string) {
  const combobox = screen.getByRole("combobox", { name });
  if (combobox instanceof HTMLSelectElement) {
    const option = within(combobox).getByRole("option", { name: optionText });
    await user.selectOptions(combobox, option);
    return;
  }

  const control = (combobox.closest(".ant-select")?.querySelector(".ant-select-selector") as HTMLElement | null) ?? combobox;
  fireEvent.mouseDown(control);
  await user.click(await screen.findByRole("option", { name: optionText }));
}

afterEach(() => {
  openMock.mockReset();
  pushMock.mockReset();
  refreshMock.mockReset();
  replaceMock.mockReset();
  scrollToMock.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("FeedPanel", () => {
  beforeEach(() => {
    vi.stubGlobal("open", openMock);
    vi.stubGlobal("scrollTo", scrollToMock);
    Object.defineProperty(window, "scrollTo", {
      configurable: true,
      value: scrollToMock,
    });
  });

  it("formats published timestamps with an explicit timezone to avoid hydration mismatch", () => {
    function MockDateTimeFormat(locale?: string | string[], options?: Intl.DateTimeFormatOptions) {
      return {
        format: () => "2026/04/10 17:00",
        resolvedOptions: () => ({
          locale: Array.isArray(locale) ? locale[0] ?? "zh-CN" : locale ?? "zh-CN",
          calendar: "gregory",
          numberingSystem: "latn",
          timeZone: options?.timeZone ?? "UTC",
        }),
      } as Intl.DateTimeFormat;
    }

    const dateTimeFormatSpy = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(MockDateTimeFormat as typeof Intl.DateTimeFormat);

    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin={false}
      />,
    );

    expect(dateTimeFormatSpy).toHaveBeenCalledWith(
      "zh-CN",
      expect.objectContaining({
        timeZone: "Asia/Shanghai",
      }),
    );
  });

  it("renders the mixed feed and refetches when the range changes", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              {
                ...initialEntries[1],
                id: "item-2",
                title: "一月内标题",
              },
            ],
            nextCursor: null,
            range: "1m" satisfies FeedRange,
            sort: "time_desc" satisfies FeedSort,
            start: null,
            end: null,
          }),
        ),
      );

    vi.stubGlobal("fetch", fetchMock);

    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin={false}
      />,
    );

    expect(screen.getByRole("navigation", { name: "主导航" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "信息流" })).not.toBeInTheDocument();
    const filterRegion = screen.getByRole("region", { name: "信息流筛选" });
    const overviewRegion = screen.getByRole("region", { name: "信息流结果" });

    expect(filterRegion).toBeInTheDocument();
    expect(within(filterRegion).queryByText("筛选与状态")).not.toBeInTheDocument();
    expect(within(filterRegion).queryByText("时间范围、排序、来源和抓取状态都压在同一块工具区里。")).not.toBeInTheDocument();
    expect(getSelectRoot("创建时间")).toHaveTextContent("7天");
    expect(within(filterRegion).getByRole("button", { name: "高级筛选" })).toHaveAttribute("aria-expanded", "false");
    expect(within(filterRegion).queryByLabelText("全文搜索")).not.toBeInTheDocument();
    expect(within(filterRegion).getByRole("combobox", { name: "排序方式" })).toBeInTheDocument();
    expect(within(filterRegion).getByText("创建时间：7天")).toBeInTheDocument();
    expect(within(filterRegion).getByText("排序：按时间倒序")).toBeInTheDocument();
    expect(within(filterRegion).queryByText("最近抓取：尚未执行")).not.toBeInTheDocument();
    expect(within(filterRegion).getByRole("button", { name: "清除筛选" })).toBeInTheDocument();
    expect(within(filterRegion).getByRole("button", { name: "查询" })).toBeInTheDocument();
    expect(screen.getByText("高质量 90")).toBeInTheDocument();
    expect(screen.getAllByText(/Example Feed/).length).toBeGreaterThan(0);
    expect(screen.queryByRole("heading", { name: "信息流控制台" })).not.toBeInTheDocument();
    expect(within(overviewRegion).getByText("OpenAI Agent 发布")).toBeInTheDocument();
    expect(within(overviewRegion).getByText("中文标题")).toBeInTheDocument();
    expect(within(overviewRegion).getByText("聚合摘要内容")).toBeInTheDocument();
    expect(within(overviewRegion).getByText("摘要内容")).toBeInTheDocument();
    expect(within(overviewRegion).getByText("聚合")).toBeInTheDocument();
    expect(within(overviewRegion).getByText("AI")).toBeInTheDocument();
    expect(within(overviewRegion).getByText("研究")).toBeInTheDocument();
    expect(within(overviewRegion).queryByText("单条条目")).not.toBeInTheDocument();
    expect(within(overviewRegion).queryByText("聚合事件")).not.toBeInTheDocument();
    expect(within(overviewRegion).queryByText("预览标题")).not.toBeInTheDocument();
    expect(within(overviewRegion).queryByText("1 条目")).not.toBeInTheDocument();
    expect(within(overviewRegion).queryByText("1 个来源")).not.toBeInTheDocument();

    await selectFilterOption(user, "创建时间", "1月");

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/feed?range=1m&sort=time_desc");
    });

    expect(await screen.findByText("一月内标题")).toBeInTheDocument();
    await waitFor(() => {
      expect(scrollToMock).toHaveBeenCalledWith({ top: 0, behavior: "auto" });
    });
  });

  it("renders the group sidebar expanded by default and keeps the mobile inline entry", () => {
    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin={false}
        availableGroups={availableGroups}
        initialGroupTotalCount={2}
        availableSources={availableSources}
      />,
    );

    const sidebar = screen.getByRole("complementary", { name: "分组筛选侧栏" });
    const sidebarPanel = sidebar.firstElementChild as HTMLElement | null;
    expect(sidebar).toBeInTheDocument();
    expect(sidebarPanel).not.toBeNull();
    expect(sidebarPanel?.className).toContain("lg:top-4");
    expect(sidebarPanel?.className).toContain("lg:max-h-[calc(100vh-2rem)]");
    expect(within(sidebar).getByRole("heading", { name: "分组筛选" })).toBeInTheDocument();
    expect(within(sidebar).getByRole("button", { name: "全部内容 (2)" })).toBeInTheDocument();
    expect(within(sidebar).getByRole("button", { name: "AI (1)" })).toBeInTheDocument();
    expect(within(sidebar).getByRole("button", { name: "研究 (1)" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "移动端分组筛选" })).toBeInTheDocument();
  });

  it("keeps the group sidebar visible with an all option when no groups are available", () => {
    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin={false}
        availableGroups={[]}
        initialGroupTotalCount={2}
        availableSources={[]}
      />,
    );

    const sidebar = screen.getByRole("complementary", { name: "分组筛选侧栏" });
    expect(sidebar).toBeInTheDocument();
    expect(within(sidebar).getByRole("button", { name: "全部内容 (2)" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "移动端分组筛选" })).toBeInTheDocument();
  });

  it("keeps the group sidebar fixed without collapse controls", () => {
    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin={false}
        availableGroups={availableGroups}
        initialGroupTotalCount={2}
        availableSources={availableSources}
      />,
    );

    const sidebar = screen.getByRole("complementary", { name: "分组筛选侧栏" });
    expect(within(sidebar).getByRole("heading", { name: "分组筛选" })).toBeInTheDocument();
    expect(within(sidebar).queryByRole("button", { name: "收起分组筛选" })).not.toBeInTheDocument();
    expect(within(sidebar).queryByRole("button", { name: "展开分组筛选" })).not.toBeInTheDocument();
    expect(within(sidebar).getByRole("button", { name: "全部内容 (2)" })).toBeInTheDocument();
    expect(within(sidebar).getByRole("button", { name: "AI (1)" })).toBeInTheDocument();
  });


  it("requests the selected group immediately through the sidebar entry", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              ...initialEntries[1],
              id: "item-group-ai",
              title: "AI 分组内容",
            },
          ],
          nextCursor: null,
          pagination: {
            page: 1,
            size: 50,
            total: 1,
            totalPages: 1,
          },
          range: "7d" satisfies FeedRange,
          sort: "time_desc" satisfies FeedSort,
          start: null,
          end: null,
          groupId: "group-ai",
          sourceId: null,
          title: null,
        }),
      ),
    );

    vi.stubGlobal("fetch", fetchMock);

    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin={false}
        availableGroups={availableGroups}
        initialGroupTotalCount={2}
        availableSources={availableSources}
      />,
    );

    await user.click(screen.getByRole("button", { name: "AI (1)" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/feed?range=7d&sort=time_desc&groupId=group-ai");
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(replaceMock).not.toHaveBeenCalled();
    expect(window.location.search).toBe("?range=7d&sort=time_desc&groupId=group-ai");
    expect(await screen.findByText("AI 分组内容")).toBeInTheDocument();
    expect(screen.getByText("分组：AI")).toBeInTheDocument();
  });

  it("refreshes the sidebar counts from the latest feed response", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              ...initialEntries[1],
              id: "item-group-refresh",
              title: "刷新后的分组内容",
            },
          ],
          groups: [
            { id: "group-ai", name: "AI", count: 3 },
            { id: "group-research", name: "研究", count: 1 },
          ],
          groupTotalCount: 5,
          nextCursor: null,
          pagination: {
            page: 1,
            size: 50,
            total: 1,
            totalPages: 1,
          },
          range: "7d" satisfies FeedRange,
          sort: "time_desc" satisfies FeedSort,
          start: null,
          end: null,
          groupId: "group-ai",
          sourceId: null,
          title: null,
        }),
      ),
    );

    vi.stubGlobal("fetch", fetchMock);

    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin={false}
        availableGroups={availableGroups}
        initialGroupTotalCount={2}
        availableSources={availableSources}
      />,
    );

    await user.click(screen.getByRole("button", { name: "AI (1)" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/feed?range=7d&sort=time_desc&groupId=group-ai");
    });

    expect(await screen.findByRole("button", { name: "全部内容 (5)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "AI (3)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "研究 (1)" })).toBeInTheDocument();
  });

  it("does not reload the feed after hydration when the browser timezone differs", async () => {
    const fetchMock = vi.fn<typeof fetch>();

    vi.stubGlobal("fetch", fetchMock);

    renderWithTimezoneOffset(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="today"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin={false}
        availableGroups={[]}
        initialGroupTotalCount={0}
        availableSources={availableSources}
      />,
      -480,
    );

    expect(screen.getByText("OpenAI Agent 发布")).toBeInTheDocument();
    await waitFor(() => {
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it("applies advanced filters only after clicking query", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(
        JSON.stringify({
          items: [
            {
              ...initialEntries[1],
              id: "item-score-top",
              title: "评分最高内容",
              score: 99,
            },
          ],
          nextCursor: null,
          range: "7d" satisfies FeedRange,
          sort: "score_desc" satisfies FeedSort,
          start: "2026-04-01",
          end: "2026-04-10",
        }),
      ),
    );

    vi.stubGlobal("fetch", fetchMock);

    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin={false}
        availableGroups={availableGroups}
        availableSources={availableSources}
      />,
    );

    await user.click(screen.getByRole("button", { name: "高级筛选" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "高级筛选" })).toHaveAttribute("aria-expanded", "true");
    });

    expect(screen.getAllByText(/创建时间/).length).toBeGreaterThan(0);
    expect(screen.getAllByPlaceholderText("开始日期")).toHaveLength(2);
    expect(screen.getAllByPlaceholderText("结束日期")).toHaveLength(2);
    expect(screen.queryByRole("combobox", { name: "分组" })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("全文搜索"), "Agent");
    expect(fetchMock).not.toHaveBeenCalled();

    await selectFilterOption(user, "排序方式", "按评分倒序");

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/feed?range=7d&sort=score_desc&title=Agent");
    });

    expect(await screen.findByText("评分最高内容")).toBeInTheDocument();
    expect(screen.getByText("搜索：Agent")).toBeInTheDocument();
    expect(screen.getByText("排序：按评分倒序")).toBeInTheDocument();
  });

  it("keeps the implicit today range when applying advanced filters", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(
        JSON.stringify({
          items: initialEntries,
          nextCursor: null,
          range: "today" satisfies FeedRange,
          sort: "time_desc" satisfies FeedSort,
          start: null,
          end: null,
          sourceId: "source-ai",
        }),
      ),
    );

    vi.stubGlobal("fetch", fetchMock);

    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="today"
        initialCreatedRangeExplicit={false}
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin={false}
        availableSources={availableSources}
      />,
    );

    await user.click(screen.getByRole("button", { name: "高级筛选" }));
    await selectFilterOption(user, "信息源", "AI Source");

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/feed?range=today&sort=time_desc&sourceId=source-ai");
    });
    expect(getSelectRoot("创建时间")).toHaveTextContent("当天");
  });

  it("keeps the current created time range when toggling a popular tag", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(
        JSON.stringify({
          items: initialEntries,
          nextCursor: null,
          range: "today" satisfies FeedRange,
          sort: "time_desc" satisfies FeedSort,
          start: null,
          end: null,
          tag: "ios",
          popularTags: [{ name: "iOS", normalized: "ios", count: 5 }],
        }),
      ),
    );

    vi.stubGlobal("fetch", fetchMock);

    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="today"
        initialCreatedRangeExplicit={false}
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin={false}
        popularTags={[{ name: "iOS", normalized: "ios", count: 5 }]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "筛选标签：iOS，5 条" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/feed?range=today&sort=time_desc&tag=ios");
    });
    expect(getSelectRoot("创建时间")).toHaveTextContent("当天");
  });

  it("resets the feed to the initial home state from the active home nav after filtering by tag", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              {
                ...initialEntries[1],
                id: "item-tagged-ios",
                title: "iOS 标签内容",
              },
            ],
            pagination: { page: 1, size: 50, total: 1, totalPages: 1 },
            nextCursor: null,
            range: "today" satisfies FeedRange,
            sort: "time_desc" satisfies FeedSort,
            start: null,
            end: null,
            publishedStart: null,
            publishedEnd: null,
            groupId: null,
            sourceId: null,
            title: null,
            tag: "ios",
            popularTags: [{ name: "iOS", normalized: "ios", count: 5 }],
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              {
                ...initialEntries[1],
                id: "item-home-default",
                title: "主页初始内容",
              },
            ],
            pagination: { page: 1, size: 50, total: 1, totalPages: 1 },
            nextCursor: null,
            range: "today" satisfies FeedRange,
            sort: "time_desc" satisfies FeedSort,
            start: null,
            end: null,
            publishedStart: null,
            publishedEnd: null,
            groupId: null,
            sourceId: null,
            title: null,
            tag: null,
            popularTags: [{ name: "iOS", normalized: "ios", count: 5 }],
          }),
        ),
      );

    vi.stubGlobal("fetch", fetchMock);

    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="today"
        initialCreatedRangeExplicit={false}
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin={false}
        popularTags={[{ name: "iOS", normalized: "ios", count: 5 }]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "筛选标签：iOS，5 条" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/feed?range=today&sort=time_desc&tag=ios");
    });
    expect(window.location.search).toBe("?range=today&sort=time_desc&tag=ios");
    expect(await screen.findByText("iOS 标签内容")).toBeInTheDocument();
    expect(screen.getByText("标签：iOS")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "筛选标签：iOS，5 条" })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("link", { name: "主页" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/feed?range=today&sort=time_desc");
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toBe("");
    expect(await screen.findByText("主页初始内容")).toBeInTheDocument();
    expect(screen.queryByText("标签：iOS")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "筛选标签：iOS，5 条" })).toHaveAttribute("aria-pressed", "false");
  });

  it("renders enough popular tags for the two-row desktop strip", () => {
    const popularTags: FeedTagOption[] = Array.from({ length: 34 }, (_, index) => {
      const tagNumber = index + 1;

      return {
        name: `Tag ${tagNumber}`,
        normalized: `tag-${tagNumber}`,
        count: 100 - index,
      };
    });

    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="today"
        initialCreatedRangeExplicit={false}
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin={false}
        popularTags={popularTags}
      />,
    );

    const tagButtons = screen.getAllByRole("button", { name: /筛选标签：/ });
    const popularRegion = screen.getByRole("region", { name: "热门标签" });

    expect(tagButtons).toHaveLength(32);
    expect(screen.getByRole("button", { name: "筛选标签：Tag 32，69 条" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "筛选标签：Tag 33，68 条" })).not.toBeInTheDocument();
    expect(tagButtons[0]?.parentElement).not.toHaveClass("lg:justify-between");
    expect(popularRegion.className).toContain("hidden");
    expect(popularRegion.className).toContain("lg:block");
  });

  it("distributes a popular tag row when the next actual tag does not fit", async () => {
    const popularTags: FeedTagOption[] = [
      { name: "开源", normalized: "open-source", count: 29 },
      { name: "Agent", normalized: "agent", count: 21 },
      { name: "Anthropic", normalized: "anthropic", count: 17 },
      { name: "OpenAI", normalized: "openai", count: 14 },
      { name: "大模型", normalized: "large-model", count: 12 },
      { name: "Meta", normalized: "meta", count: 10 },
      { name: "字节跳动", normalized: "bytedance", count: 10 },
      { name: "AI", normalized: "ai", count: 8 },
      { name: "豆包", normalized: "doubao", count: 8 },
      { name: "Google", normalized: "google", count: 7 },
      { name: "AI安全", normalized: "ai-safety", count: 6 },
      { name: "AI编程", normalized: "ai-programming", count: 6 },
      { name: "Microsoft", normalized: "microsoft", count: 6 },
    ];
    const tagWidths = new Map<string, number>([
      ["open-source", 59],
      ["agent", 65],
      ["anthropic", 89],
      ["openai", 71],
      ["large-model", 71],
      ["meta", 59],
      ["bytedance", 83],
      ["ai", 42],
      ["doubao", 54],
      ["google", 66],
      ["ai-safety", 66],
      ["ai-programming", 66],
      ["microsoft", 84],
    ]);
    const tagOrder = new Map(popularTags.map((tag, index) => [tag.normalized, index]));
    const originalGetComputedStyle = window.getComputedStyle.bind(window);

    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
      const computedStyle = originalGetComputedStyle(element);
      if (element instanceof HTMLElement && element.getAttribute("aria-hidden") === "true") {
        Object.defineProperty(computedStyle, "columnGap", { configurable: true, value: "6px" });
        Object.defineProperty(computedStyle, "gap", { configurable: true, value: "6px" });
      }

      return computedStyle;
    });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function clientWidthMock(this: HTMLElement) {
      return this.getAttribute("aria-hidden") === "true" ? 936 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function offsetWidthMock(this: HTMLElement) {
      const tagKey = this.dataset.tagKey;
      return tagKey ? tagWidths.get(tagKey) ?? 0 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function offsetTopMock(this: HTMLElement) {
      const tagKey = this.dataset.tagKey;
      const index = tagKey ? tagOrder.get(tagKey) : undefined;
      return typeof index === "number" && index >= 12 ? 38 : 0;
    });

    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="today"
        initialCreatedRangeExplicit={false}
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin={false}
        popularTags={popularTags}
      />,
    );

    const firstRow = screen.getByRole("button", { name: "筛选标签：AI编程，6 条" }).parentElement;

    await waitFor(() => {
      expect(firstRow).toHaveClass("lg:justify-between");
    });
  });

  it("keeps the created time range when the user changes it before applying advanced filters", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(
        JSON.stringify({
          items: initialEntries,
          nextCursor: null,
          range: "3d" satisfies FeedRange,
          sort: "time_desc" satisfies FeedSort,
          start: null,
          end: null,
          sourceId: "source-ai",
        }),
      ),
    );

    vi.stubGlobal("fetch", fetchMock);

    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="today"
        initialCreatedRangeExplicit={false}
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin={false}
        availableSources={availableSources}
      />,
    );

    await selectFilterOption(user, "创建时间", "3天");

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/feed?range=3d&sort=time_desc");
    });

    fetchMock.mockClear();
    await user.click(screen.getByRole("button", { name: "高级筛选" }));
    await selectFilterOption(user, "信息源", "AI Source");

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/feed?range=3d&sort=time_desc&sourceId=source-ai");
    });
  });

  it("returns to the implicit today range after removing the last advanced filter", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(
        JSON.stringify({
          items: initialEntries,
          nextCursor: null,
          range: "today" satisfies FeedRange,
          sort: "time_desc" satisfies FeedSort,
          start: null,
          end: null,
          title: null,
        }),
      ),
    );

    vi.stubGlobal("fetch", fetchMock);

    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="all"
        initialCreatedRangeExplicit={false}
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin={false}
        initialTitle="Agent"
      />,
    );

    fireEvent.change(screen.getByLabelText("全文搜索"), { target: { value: "" } });
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "查询" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/feed?range=today&sort=time_desc");
    });
    expect(getSelectRoot("创建时间")).toHaveTextContent("当天");
  });

  it("applies sort immediately while keeping title edits local until query is clicked", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(
        JSON.stringify({
          items: [
            {
              ...initialEntries[1],
              id: "item-debounced-title",
              title: "延迟生效标题",
            },
          ],
          nextCursor: null,
          pagination: {
            page: 1,
            size: 50,
            total: 1,
            totalPages: 1,
          },
          range: "7d" satisfies FeedRange,
          sort: "score_desc" satisfies FeedSort,
          start: null,
          end: null,
          groupId: null,
          sourceId: null,
          title: "Agent",
        }),
      ),
    );

    vi.stubGlobal("fetch", fetchMock);

    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "高级筛选" }));
    expect(screen.getByRole("button", { name: "高级筛选" })).toHaveAttribute("aria-expanded", "true");

    fireEvent.change(screen.getByLabelText("全文搜索"), { target: { value: "Agent" } });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText("搜索：Agent")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "排序方式" }), { target: { value: "score_desc" } });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/feed?range=7d&sort=score_desc&title=Agent");
    });
    expect(screen.getByText("搜索：Agent")).toBeInTheDocument();
  });

  it("renders only the latest ingestion time for visitors", () => {
    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={{
          id: "run-summary-1",
          status: "partial",
          triggerType: "manual",
          startedAt: "2026-04-10T10:00:00.000Z",
          finishedAt: "2026-04-10T10:06:00.000Z",
          sourceCount: 3,
          itemCount: 6,
          successCount: 4,
          failureCount: 2,
          itemsAdded: 12,
          errorSummary: "2 个源抓取失败",
        }}
        isAdmin={false}
      />,
    );

    const filterRegion = screen.getByRole("region", { name: "信息流筛选" });

    expect(within(filterRegion).getByText("更新时间：2026/04/10 18:06")).toBeInTheDocument();
    expect(within(filterRegion).queryByText(/最近抓取：部分成功/)).not.toBeInTheDocument();
    expect(within(filterRegion).queryByText("抓取说明：2 个源抓取失败")).not.toBeInTheDocument();
  });

  it("keeps the latest ingestion summary next to the refresh button for admins", () => {
    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={{
          id: "run-summary-inline-1",
          status: "succeeded",
          triggerType: "manual",
          startedAt: "2026-04-18T00:40:00.000Z",
          finishedAt: "2026-04-18T00:58:00.000Z",
          sourceCount: 50,
          itemCount: 50,
          successCount: 50,
          failureCount: 0,
          itemsAdded: 50,
          errorSummary: null,
        }}
        isAdmin
      />,
    );

    const refreshButton = screen.getByRole("button", { name: "立即更新" });
    const inlineControls = refreshButton.parentElement;

    expect(inlineControls).not.toBeNull();
    expect(inlineControls).toHaveTextContent("最近抓取：已成功 · 新增50条 · 2026/04/18 08:58");
  });

  it("keeps Lumina-like typography on the homepage filter controls and cards", () => {
    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin={false}
      />,
    );

    const advancedToggle = screen.getByRole("button", { name: "高级筛选" });
    const refreshButton = screen.queryByRole("button", { name: "立即更新" });
    const rangeSelect = getSelectRoot("创建时间");
    const clearButton = screen.getByRole("button", { name: "清除筛选" });
    const title = screen.getByRole("heading", { name: "OpenAI Agent 发布" });

    expect(advancedToggle.className).toContain("text-sm");
    expect(advancedToggle.className).toContain("px-4");
    expect(advancedToggle.className).toContain("py-1");
    expect(refreshButton).toBeNull();
    expect(rangeSelect?.className).toContain("select-modern-antd");
    expect(rangeSelect?.className).toContain("h-9");
    expect(screen.getByRole("combobox", { name: "排序方式" })).toBeInTheDocument();
    expect(getSelectRoot("排序方式")?.className).toContain("select-modern-antd");
    expect(clearButton.className).toContain("ml-auto");
    expect(clearButton.className).toContain("px-3");
    expect(clearButton.className).toContain("py-1");
    expect(title.className).toContain("text-xl");
  });

  it("matches Lumina button color states for advanced filters and clear filters", async () => {
    const user = userEvent.setup();

    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin={false}
      />,
    );

    const advancedToggle = screen.getByRole("button", { name: "高级筛选" });
    const clearButton = screen.getByRole("button", { name: "清除筛选" });

    expect(advancedToggle.className).toContain("lumina-home-action-button");
    expect(clearButton.className).toContain("lumina-home-action-button");
    expect(advancedToggle.className).toContain("bg-[var(--bg-muted)]");
    expect(advancedToggle.className).toContain("text-[var(--text-2)]");
    expect(advancedToggle.className).toContain("hover:bg-[var(--surface)]");

    expect(clearButton.className).toContain("bg-[var(--surface)]");
    expect(clearButton.className).toContain("text-[var(--text-2)]");
    expect(clearButton.className).toContain("hover:bg-[var(--bg-muted)]");
    expect(clearButton.className).toContain("hover:text-[var(--text-1)]");

    await user.click(advancedToggle);

    expect(advancedToggle.className).toContain("bg-[var(--accent-soft)]");
    expect(advancedToggle.className).toContain("text-[var(--accent-strong)]");
    expect(screen.getByRole("button", { name: "查询" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "排序方式" })).toBeInTheDocument();
    expect(screen.getByLabelText("全文搜索")).toBeInTheDocument();
  });

  it("keeps the clear filters button enabled when the summary shows non-default filter chips", () => {
    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin={false}
      />,
    );

    const clearButton = screen.getByRole("button", { name: "清除筛选" });

    expect(screen.getByText("创建时间：7天")).toBeInTheDocument();
    expect(screen.getByText("排序：按时间倒序")).toBeInTheDocument();
    expect(clearButton).toBeEnabled();
    expect(clearButton.className).toContain("lumina-home-action-button--clear");
  });

  it("uses the same search and refresh icons as Lumina for the filter action buttons", () => {
    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin
      />,
    );

    const advancedToggle = screen.getByRole("button", { name: "高级筛选" });
    const refreshButton = screen.getByRole("button", { name: "立即更新" });
    const advancedIcon = advancedToggle.querySelector("svg");
    const refreshIcon = refreshButton.querySelector("svg");

    expect(advancedIcon?.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(advancedIcon?.innerHTML).toContain('circle cx="11" cy="11" r="7"');
    expect(advancedIcon?.innerHTML).toContain('path d="m21 21-4.3-4.3"');

    expect(refreshIcon?.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(refreshIcon?.innerHTML).toContain('path d="M21 12a9 9 0 0 1-9 9 9 9 0 0 1-7.5-4"');
    expect(refreshIcon?.innerHTML).toContain('path d="M3 12a9 9 0 0 1 9-9 9 9 0 0 1 7.5 4"');
    expect(refreshIcon?.innerHTML).toContain('path d="M3 5v4h4"');
    expect(refreshIcon?.innerHTML).toContain('path d="M21 19v-4h-4"');
  });

  it("keeps the admin refresh button as a white-on-primary Lumina-style action", () => {
    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin
      />,
    );

    const refreshButton = screen.getByRole("button", { name: "立即更新" });

    expect(refreshButton.className).toContain("lumina-home-action-button");
    expect(refreshButton.className).toContain("lumina-home-action-button--primary");
    expect(refreshButton.className).toContain("bg-[var(--accent)]");
    expect(refreshButton.className).toContain("text-white");
    expect(refreshButton.className).toContain("font-medium");
  });

  it("disables the admin refresh button while a refresh task is running", () => {
    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={{
          id: "run-active-1",
          status: "running",
          triggerType: "manual",
          startedAt: "2026-04-10T10:00:00.000Z",
          finishedAt: null,
          sourceCount: 1,
          itemCount: 2,
          successCount: 0,
          failureCount: 0,
          itemsAdded: 0,
          errorSummary: null,
        }}
        isAdmin
      />,
    );

    expect(screen.getByRole("button", { name: "立即更新" })).toBeDisabled();
  });

  it("uses transplanted Lumina filter components on the homepage", () => {
    const { container } = render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin={false}
      />,
    );

    const filterRegion = screen.getByRole("region", { name: "信息流筛选" });
    expect(filterRegion.className).toContain("panel-raised");
    expect(filterRegion.className).toContain("rounded-sm");
    expect(filterRegion.className).toContain("border");
    expect(container.querySelector(".panel-raised")).not.toBeNull();
    expect(container.querySelector(".select-modern-antd")).not.toBeNull();
    expect(container.querySelector(".filter-chip")).not.toBeNull();
  });

  it("loads cluster items on demand when expanded", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(
        JSON.stringify({
          items: [
            {
              id: "item-detail-1",
              title: "详细标题",
              originalUrl: "https://example.com/detail",
              publishedAt: "2026-04-10T09:00:00.000Z",
              sourceName: "Another Feed",
              author: "Jamie",
              summary: "详细摘要",
              score: 84,
              canRegenerateTranslation: true,
            },
          ],
        }),
      ),
    );

    vi.stubGlobal("fetch", fetchMock);

    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin={false}
      />,
    );

    expect(screen.queryByText("预览标题")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "展开相关内容" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/feed/clusters/cluster-1?range=all&sort=time_desc");
    });

    expect(await screen.findByText("详细标题")).toBeInTheDocument();
    expect(screen.getByText("详细摘要")).toBeInTheDocument();
  });

  it("expands cluster items when clicking the cluster card body", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(
        JSON.stringify({
          items: [
            {
              id: "item-detail-1",
              title: "详细标题",
              originalUrl: "https://example.com/detail",
              publishedAt: "2026-04-10T09:00:00.000Z",
              sourceName: "Another Feed",
              author: "Jamie",
              summary: "详细摘要",
              score: 84,
              canRegenerateTranslation: true,
            },
          ],
        }),
      ),
    );

    vi.stubGlobal("fetch", fetchMock);

    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin={false}
      />,
    );

    await user.click(screen.getByRole("heading", { name: "OpenAI Agent 发布" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/feed/clusters/cluster-1?range=all&sort=time_desc");
    });
    expect(await screen.findByText("详细标题")).toBeInTheDocument();
  });

  it("shows a regenerate icon for expanded cluster items and keeps the cluster refresh hint", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = getFetchUrl(input);

      if (url === "/api/feed/clusters/cluster-1?range=all&sort=time_desc") {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: "item-detail-1",
                title: "详细标题",
                originalUrl: "https://example.com/detail",
                publishedAt: "2026-04-10T09:00:00.000Z",
                sourceName: "Another Feed",
                author: "Jamie",
                summary: "详细摘要",
                score: 84,
                canRegenerateTranslation: true,
              },
            ],
          }),
        );
      }

      if (url === "/api/admin/items/item-detail-1/regenerate") {
        expect(init?.method).toBe("POST");

        return new Response(
          JSON.stringify({
            taskRun: {
              id: "task-cluster-child-1",
            },
          }),
          { status: 202 },
        );
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin
      />,
    );

    await user.click(screen.getByRole("button", { name: "展开相关内容" }));
    expect(await screen.findByText("详细标题")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "重新生成内容：详细标题" }));

    const dialog = await screen.findByRole("dialog", { name: "选择重新生成内容" });
    await selectFilterOption(user, "重新生成范围", "仅摘要");
    await user.click(within(dialog).getByRole("button", { name: "确认" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/items/item-detail-1/regenerate", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ target: "summary" }),
      });
    });

    await waitFor(() => {
      expect(openMock).toHaveBeenCalledWith(
        "/admin?tab=monitoring&section=tasks&task=task-cluster-child-1",
        "_blank",
        "noopener,noreferrer",
      );
    });
  });

  it("renders an admin-specific empty state hint", () => {
    render(
      <FeedPanel
        initialItems={[]}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin
      />,
    );

    expect(screen.getByText("当前时间范围内还没有可展示内容，可以先点击“立即更新”拉取数据。")).toBeInTheDocument();
  });

  it("renders a neutral empty state for non-admin visitors", () => {
    render(
      <FeedPanel
        initialItems={[]}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin={false}
      />,
    );

    expect(screen.getByText("当前时间范围内还没有可展示内容，请稍后再回来看看。")).toBeInTheDocument();
    expect(screen.queryByText("当前时间范围内还没有可展示内容，可以先点击“立即更新”拉取数据。")).not.toBeInTheDocument();
  });

  it("polls ingestion status every 30 seconds for admins and reloads the current range when the run completes", async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = getFetchUrl(input);

      if (url === "/api/ingest/status") {
        return new Response(
          JSON.stringify({
            run: {
              id: "run-1",
              status: "succeeded",
              triggerType: "manual",
              startedAt: "2026-04-10T10:00:00.000Z",
              finishedAt: "2026-04-10T10:01:00.000Z",
              sourceCount: 1,
              itemCount: 2,
              successCount: 2,
              failureCount: 0,
              errorSummary: null,
            },
          }),
        );
      }

      if (url === "/api/feed?range=7d&sort=time_desc") {
        return new Response(
          JSON.stringify({
            items: [
              {
                ...initialEntries[1],
                id: "item-2",
                title: "刷新后的标题",
              },
            ],
            nextCursor: null,
          }),
        );
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={{
          id: "run-1",
          status: "running",
          triggerType: "manual",
          startedAt: "2026-04-10T10:00:00.000Z",
          finishedAt: null,
          sourceCount: 1,
          itemCount: 2,
          successCount: 0,
          failureCount: 0,
          itemsAdded: 0,
          errorSummary: null,
        }}
        isAdmin
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_999);
    });

    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/ingest/status");
    expect(fetchMock).toHaveBeenCalledWith("/api/feed?range=7d&sort=time_desc");
    expect(screen.getByText("刷新后的标题")).toBeInTheDocument();
  });

  it("does not poll ingestion status for non-admin viewers", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>();

    vi.stubGlobal("fetch", fetchMock);

    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={{
          id: "run-1",
          status: "running",
          triggerType: "manual",
          startedAt: "2026-04-10T10:00:00.000Z",
          finishedAt: null,
          sourceCount: 1,
          itemCount: 2,
          successCount: 0,
          failureCount: 0,
          itemsAdded: 0,
          errorSummary: null,
        }}
        isAdmin={false}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves the client admin session once for the feed panel and header", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = getFetchUrl(input);

      if (url === "/api/admin/session") {
        return Response.json({ isAdmin: true });
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin={false}
        hydrateAdminClient
      />,
    );

    await waitFor(() => expect(screen.getByRole("link", { name: "管理" })).toBeInTheDocument());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/session", { cache: "no-store" });
  });

  it("queues ingestion from the admin refresh button", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          taskRun: {
            id: "task-1",
            kind: "ingestion",
            status: "queued",
            triggerType: "manual",
            label: "默认抓取任务",
            entityId: null,
            progressCurrent: 0,
            progressTotal: 0,
            progressLabel: null,
            startedAt: null,
            finishedAt: null,
            errorSummary: null,
          },
        }),
      ),
    );

    vi.stubGlobal("fetch", fetchMock);

    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin
      />,
    );

    await user.click(screen.getByRole("button", { name: "立即更新" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/ingest/run", { method: "POST" });
    });

    expect(pushMock).toHaveBeenCalledWith("/admin?tab=monitoring&section=tasks&task=task-1");
    expect(screen.getByText("抓取任务已进入队列，等待后台执行。")).toBeInTheDocument();
    expect(screen.getByText("抓取任务已进入队列，等待后台执行。").closest('[role="status"]')).not.toBeNull();
  });

  it("renders refresh API errors as alerts", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "Unauthorized",
        }),
        { status: 401 },
      ),
    );

    vi.stubGlobal("fetch", fetchMock);

    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin
      />,
    );

    await user.click(screen.getByRole("button", { name: "立即更新" }));

    expect(await screen.findByText("Unauthorized")).toBeInTheDocument();
    expect(screen.getByText("Unauthorized").closest('[role="alert"]')).not.toBeNull();
  });

  it("hides admin-only controls for anonymous visitors", () => {
    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin={false}
      />,
    );

    expect(screen.queryByRole("button", { name: "立即更新" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重新生成内容" })).not.toBeInTheDocument();
  });

  it("shows a single regenerate action and queues a summary task after choosing it in the dialog", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = getFetchUrl(input);

      if (url === "/api/admin/items/item-1/regenerate") {
        expect(init?.method).toBe("POST");

        return new Response(
          JSON.stringify({
            taskRun: {
              id: "task-2",
            },
          }),
          { status: 202 },
        );
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin={true}
      />,
    );

    expect(screen.getByRole("button", { name: "立即更新" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新生成内容" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新生成内容" }).textContent).toBe("");

    await user.click(screen.getByRole("button", { name: "重新生成内容" }));

    const dialog = await screen.findByRole("dialog", { name: "选择重新生成内容" });
    expect(within(dialog).getByText("请选择要重新生成的内容范围。")).toBeInTheDocument();
    await selectFilterOption(user, "重新生成范围", "仅摘要");
    await user.click(within(dialog).getByRole("button", { name: "确认" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/items/item-1/regenerate", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ target: "summary" }),
      });
    });

    await waitFor(() => {
      expect(openMock).toHaveBeenCalledWith(
        "/admin?tab=monitoring&section=tasks&task=task-2",
        "_blank",
        "noopener,noreferrer",
      );
    });
    expect(screen.getByText("摘要内容")).toBeInTheDocument();
  });

  it("can queue item reanalysis from the regenerate dialog", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = getFetchUrl(input);

      if (url === "/api/admin/items/item-1/reanalyze") {
        expect(init?.method).toBe("POST");

        return new Response(
          JSON.stringify({
            taskRun: {
              id: "task-reanalyze-1",
            },
          }),
          { status: 202 },
        );
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin={true}
      />,
    );

    await user.click(screen.getByRole("button", { name: "重新生成内容" }));

    const dialog = await screen.findByRole("dialog", { name: "选择重新生成内容" });
    await selectFilterOption(user, "重新生成范围", "重新 AI 判定");
    await user.click(within(dialog).getByRole("button", { name: "确认" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/items/item-1/reanalyze", {
        method: "POST",
      });
    });

    await waitFor(() => {
      expect(openMock).toHaveBeenCalledWith(
        "/admin?tab=monitoring&section=tasks&task=task-reanalyze-1",
        "_blank",
        "noopener,noreferrer",
      );
    });
  });

  it("lets admins search clusters by title and manually join a singleton cluster from a homepage card", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = getFetchUrl(input);

      if (url.startsWith("/api/admin/clusters?")) {
        return new Response(
          JSON.stringify({
            clusters: [
              {
                id: "cluster-singleton",
                title: "AI 生成的单条聚合标题",
                summary: "只有一条内容的聚合",
                score: 75,
                itemCount: 1,
                latestPublishedAt: "2026-04-08T09:00:00.000Z",
                status: "active",
                items: [
                  {
                    id: "cluster-singleton-item",
                    title: "翻译后的单条标题",
                    originalTitle: "单条原始标题",
                    originalUrl: "https://example.com/singleton",
                    publishedAt: "2026-04-08T09:00:00.000Z",
                    sourceName: "Example Feed",
                    author: "Alex",
                    summary: "单条摘要",
                    score: 75,
                  },
                ],
              },
              {
                id: "cluster-joined",
                title: "已存在的 OpenAI 聚合",
                summary: "已有多条内容",
                score: 88,
                itemCount: 3,
                latestPublishedAt: "2026-04-10T09:00:00.000Z",
                status: "active",
                items: [],
              },
            ],
          }),
        );
      }

      if (url === "/api/admin/items/item-1/join-cluster") {
        expect(init?.method).toBe("POST");

        return new Response(
          JSON.stringify({
            cluster: {
              id: "cluster-singleton",
            },
          }),
        );
      }

      if (url === "/api/feed?range=7d&sort=time_desc") {
        return new Response(
          JSON.stringify({
            items: [
              {
                ...initialEntries[0],
                id: "cluster-singleton",
                title: "单条聚合候选",
                itemCount: 2,
              },
            ],
            pagination: {
              page: 1,
              size: 50,
              total: 1,
              totalPages: 1,
            },
            range: "7d" satisfies FeedRange,
            sort: "time_desc" satisfies FeedSort,
            start: null,
            end: null,
            groupId: null,
            sourceId: null,
            title: null,
          }),
        );
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin
      />,
    );

    await user.click(screen.getByRole("button", { name: "加入聚合组：中文标题" }));

    const dialog = await screen.findByRole("dialog", { name: "手动加入聚合组" });
    expect(await within(dialog).findByText("单条原始标题")).toBeInTheDocument();
    expect(within(dialog).queryByText("AI 生成的单条聚合标题")).not.toBeInTheDocument();
    expect(within(dialog).getByText("1 条内容")).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText("搜索聚合标题"), "单条");
    await user.click(within(dialog).getByRole("button", { name: /选择聚合组：单条原始标题/ }));
    await user.click(within(dialog).getByRole("button", { name: "确认加入" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/items/item-1/join-cluster", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ clusterId: "cluster-singleton" }),
      });
    });

    expect(await screen.findByText("已加入聚合组。")).toBeInTheDocument();
  });

  it("shows a confirmation dialog before manually filtering a homepage card", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = getFetchUrl(input);

      if (url === "/api/admin/items/item-1/filter") {
        expect(init?.method).toBe("POST");

        return new Response(
          JSON.stringify({
            item: {
              id: "item-1",
            },
          }),
        );
      }

      if (url === "/api/feed?range=7d&sort=time_desc") {
        return new Response(
          JSON.stringify({
            items: [initialEntries[0]],
            pagination: {
              page: 1,
              size: 50,
              total: 1,
              totalPages: 1,
            },
            range: "7d" satisfies FeedRange,
            sort: "time_desc" satisfies FeedSort,
            start: null,
            end: null,
            groupId: null,
            sourceId: null,
            title: null,
          }),
        );
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin
      />,
    );

    await user.click(screen.getByRole("button", { name: "手动过滤：中文标题" }));

    const dialog = await screen.findByRole("dialog", { name: "确认手动过滤" });
    expect(within(dialog).getByText("过滤后该内容会立即从主页列表中移除。")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "确认过滤" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/items/item-1/filter", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
      });
    });

    expect(await screen.findByText("已手动过滤该内容。")).toBeInTheDocument();
  });

  it("shows a confirmation dialog before deleting a homepage card", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = getFetchUrl(input);

      if (url === "/api/admin/items/item-1") {
        expect(init?.method).toBe("DELETE");

        return new Response(
          JSON.stringify({
            success: true,
          }),
        );
      }

      if (url === "/api/feed?range=7d&sort=time_desc") {
        return new Response(
          JSON.stringify({
            items: [initialEntries[0]],
            pagination: {
              page: 1,
              size: 50,
              total: 1,
              totalPages: 1,
            },
            range: "7d" satisfies FeedRange,
            sort: "time_desc" satisfies FeedSort,
            start: null,
            end: null,
            groupId: null,
            sourceId: null,
            title: null,
          }),
        );
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin
      />,
    );

    await user.click(screen.getByRole("button", { name: "删除内容：中文标题" }));

    const dialog = await screen.findByRole("dialog", { name: "确认删除内容" });
    expect(within(dialog).getByText("删除后会立即从主页列表移除，并自动重算所属聚合。")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "确认删除" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/items/item-1", {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
        },
      });
    });

    expect(await screen.findByText("已删除该内容。")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "中文标题" })).not.toBeInTheDocument();
    });
  });

  it("can queue both translation and summary from the regenerate dialog", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = getFetchUrl(input);

      if (url === "/api/admin/items/item-1/regenerate") {
        return new Response(JSON.stringify({ taskRun: { id: "task-both" } }), { status: 202 });
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin
      />,
    );

    await user.click(screen.getByRole("button", { name: "重新生成内容" }));
    const dialog = await screen.findByRole("dialog", { name: "选择重新生成内容" });
    await selectFilterOption(user, "重新生成范围", "重新翻译&摘要");
    await user.click(within(dialog).getByRole("button", { name: "确认" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/admin/items/item-1/regenerate", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ target: "translation" }),
      });
      expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/admin/items/item-1/regenerate", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ target: "summary" }),
      });
    });

    await waitFor(() => {
      expect(openMock).toHaveBeenCalledWith(
        "/admin?tab=monitoring&section=tasks&task=task-both",
        "_blank",
        "noopener,noreferrer",
      );
    });
  });

  it("merges selected homepage items through the batch toolbar", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = getFetchUrl(input);

      if (url === "/api/admin/clusters/merge-items") {
        expect(init?.method).toBe("POST");
        expect(init?.body).toBe(JSON.stringify({ itemIds: ["item-preview-1", "item-1"] }));

        return new Response(
          JSON.stringify({
            success: true,
            result: {
              targetClusterId: "cluster-1",
              targetClusterTitle: "OpenAI Agent 发布",
              movedItemIds: ["item-1"],
              affectedClusterIds: ["cluster-1", "item-1"],
              itemsMoved: 1,
            },
          }),
        );
      }

      if (url === "/api/feed?range=7d&sort=time_desc") {
        return new Response(
          JSON.stringify({
            items: initialEntries,
            pagination: {
              page: 1,
              size: 50,
              total: initialEntries.length,
              totalPages: 1,
            },
            range: "7d" satisfies FeedRange,
            sort: "time_desc" satisfies FeedSort,
            start: null,
            end: null,
            groupId: null,
            sourceId: null,
            title: null,
          }),
        );
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin
      />,
    );

    await user.click(screen.getByLabelText(/批量选择/));
    await user.click(screen.getByRole("button", { name: "批量合并" }));

    const dialog = await screen.findByRole("dialog", { name: "确认批量合并" });
    expect(within(dialog).getByText(/当前聚合条目数最多/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "确认合并" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/clusters/merge-items", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ itemIds: ["item-preview-1", "item-1"] }),
      });
    });
    expect(await screen.findByText("已将 1 条内容合并到「OpenAI Agent 发布」。")).toBeInTheDocument();
  });

  it("renders homepage cards with a top-right icon action area and full-width summary copy", () => {
    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin
      />,
    );

    const regenerateButton = screen.getByRole("button", { name: "重新生成内容" });
    const singleSummary = screen.getByText("摘要内容");
    const clusterSummary = screen.getByText("聚合摘要内容");

    expect(regenerateButton.className).toContain("feed-card-icon-button");
    expect(regenerateButton.className).toContain("p-1.5");
    expect(regenerateButton.className).toContain("text-[var(--text-2)]");
    expect(regenerateButton.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(singleSummary.className).not.toContain("max-w-4xl");
    expect(clusterSummary.className).not.toContain("max-w-4xl");
  });

  it("renders supported inline markdown in feed summaries", () => {
    render(
      <FeedPanel
        initialItems={[
          {
            ...initialEntries[1],
            summary: "**OpenAI** 发布 *Agent 工具*，影响开发者工作流。",
          },
        ]}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin={false}
      />,
    );

    const summary = screen.getByText((_content, element) =>
      element?.tagName === "P" && element.textContent === "OpenAI 发布 Agent 工具，影响开发者工作流。",
    );

    expect(summary.querySelector("strong")).toHaveTextContent("OpenAI");
    expect(summary.querySelector("em")).toHaveTextContent("Agent 工具");
  });

  it("shows the Lumina-style back-to-top button after scrolling", async () => {
    const user = userEvent.setup();

    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin={false}
      />,
    );

    expect(screen.queryByRole("button", { name: "回到顶部" })).not.toBeInTheDocument();

    const hiddenBackToTop = screen.getByTitle("回到顶部");
    expect(hiddenBackToTop).toHaveAttribute("aria-hidden", "true");
    expect(hiddenBackToTop).toHaveAttribute("tabindex", "-1");

    Object.defineProperty(window, "scrollY", {
      configurable: true,
      value: 421,
    });
    fireEvent.scroll(window);

    const backToTop = await screen.findByRole("button", { name: "回到顶部" });
    expect(backToTop.className).toContain("fixed bottom-8 right-8");
    expect(backToTop).toHaveAttribute("aria-hidden", "false");
    expect(backToTop).toHaveAttribute("tabindex", "0");

    await user.click(backToTop);

    expect(scrollToMock).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
  });

  it("renders the regenerate range select at full width inside the dialog", async () => {
    const user = userEvent.setup();

    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin
      />,
    );

    await user.click(screen.getByRole("button", { name: "重新生成内容" }));

    const dialog = await screen.findByRole("dialog", { name: "选择重新生成内容" });
    const select = within(dialog).getByRole("combobox", { name: "重新生成范围" });

    expect(select.className).toContain("w-full");
  });

  it("keeps homepage cards visually close to Lumina's text-led article rows", () => {
    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin
      />,
    );

    const title = screen.getByRole("heading", { name: "中文标题" });
    const clusterTitle = screen.getByRole("heading", { name: "OpenAI Agent 发布" });
    const clusterToggle = screen.getByRole("button", { name: "展开相关内容" });
    const qualityBadge = screen.getByText("一般 72");
    const clusterTypeBadge = screen.getByText("聚合");
    const card = title.closest("article");
    const clusterCard = clusterTitle.closest("article");
    const regenerateButton = screen.getByRole("button", { name: "重新生成内容" });
    const actionGroup = regenerateButton.parentElement;
    const clusterToggleRow = clusterToggle.parentElement;
    const clusterDivider = clusterToggleRow?.querySelector(".h-px.flex-1");

    expect(card?.className).toContain("rounded-lg");
    expect(card?.className).toContain("sm:px-6");
    expect(card?.className).toContain("hover:shadow-md");
    expect(title.className).toContain("leading-7");
    expect(clusterTitle.className).toContain("leading-7");
    expect(qualityBadge.className).toContain("text-xs");
    expect(clusterTypeBadge.className).toContain("text-[11px]");
    expect(clusterToggle.className).toContain("bg-transparent");
    expect(clusterToggle.className).toContain("px-0");
    expect(clusterToggle.className).toContain("text-[11px]");
    expect(clusterToggle).toHaveTextContent("2 条");
    expect(clusterToggle).not.toHaveTextContent("展开相关内容");
    expect(clusterToggle).not.toHaveTextContent("保留原始来源与作者信息");
    expect(clusterDivider).not.toBeNull();
    expect(within(card as HTMLElement).getByText("来源：Example Feed")).toBeInTheDocument();
    expect(within(card as HTMLElement).getByText("作者：Alex")).toBeInTheDocument();
    expect(within(card as HTMLElement).getByText(/发表：2026\/04\/09 17:00/)).toBeInTheDocument();
    expect(within(clusterCard as HTMLElement).getByText("来源：2 个来源")).toBeInTheDocument();
    expect(actionGroup).toHaveClass("flex");
    expect(actionGroup).toHaveClass("shrink-0");
    expect(actionGroup).toHaveClass("gap-0.5");
  });

  it("omits aggregation parent metadata from feed cards", async () => {
    const user = userEvent.setup();
    const clusterEntry = initialEntries.find((entry) => entry.type === "cluster");
    const singleEntry = initialEntries.find((entry) => entry.type === "single");
    if (!clusterEntry || !singleEntry) {
      throw new Error("missing entry fixture");
    }
    const clusterItems = clusterEntry.itemsPreview.map((item) => ({
      ...item,
      aggregationParent: {
        id: "parent-1",
        title: "AI 简报父条目",
        originalUrl: "https://example.com/roundup",
      },
    }));
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(
        JSON.stringify({
          items: clusterItems,
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <FeedPanel
        initialItems={[
          {
            ...clusterEntry,
            itemsPreview: clusterItems,
          },
          {
            ...singleEntry,
            aggregationParent: {
              id: "parent-1",
              title: "AI 简报父条目",
              originalUrl: "https://example.com/roundup",
            },
          },
        ]}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin
      />,
    );

    await user.click(screen.getByRole("button", { name: "展开相关内容" }));
    expect(await screen.findByRole("link", { name: "预览标题" })).toBeInTheDocument();

    expect(screen.queryByText(/拆条来源/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "拆条来源：AI 简报父条目" })).not.toBeInTheDocument();
  });

  it("omits author metadata when the author is unknown", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(
        JSON.stringify({
          items: [
            {
              id: "item-detail-unknown-author",
              title: "详细标题",
              originalUrl: "https://example.com/detail",
              publishedAt: "2026-04-10T09:00:00.000Z",
              sourceName: "Another Feed",
              author: null,
              summary: "详细摘要",
              score: 84,
              canRegenerateTranslation: true,
            },
          ],
        }),
      ),
    );
    const entriesWithoutAuthors: FeedEntryDTO[] = initialEntries.map((entry) => {
      if (entry.type === "cluster") {
        return {
          ...entry,
          itemsPreview: entry.itemsPreview.map((item) => ({ ...item, author: null })),
        };
      }

      return {
        ...entry,
        author: null,
      };
    });

    vi.stubGlobal("fetch", fetchMock);

    render(
      <FeedPanel
        initialItems={entriesWithoutAuthors}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin={false}
      />,
    );

    expect(screen.queryByText(/作者：未知作者/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "展开相关内容" }));
    expect(await screen.findByText("详细标题")).toBeInTheDocument();
    expect(screen.queryByText(/作者：未知作者/)).not.toBeInTheDocument();
  });

  it("renders regenerate API errors as alerts", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = getFetchUrl(input);

      if (url === "/api/admin/items/item-1/regenerate") {
        return new Response(
          JSON.stringify({
            error: "An ingestion run is already in progress.",
          }),
          { status: 409 },
        );
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin={true}
      />,
    );

    await user.click(screen.getByRole("button", { name: "重新生成内容" }));
    const dialog = await screen.findByRole("dialog", { name: "选择重新生成内容" });
    await selectFilterOption(user, "重新生成范围", "仅摘要");
    await user.click(within(dialog).getByRole("button", { name: "确认" }));

    expect(await screen.findByText("An ingestion run is already in progress.")).toBeInTheDocument();
    expect(screen.getByText("An ingestion run is already in progress.").closest('[role="alert"]')).not.toBeNull();
  });

  it("requests feed data with group and source filters while preserving the current range inputs", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(
        JSON.stringify({
          items: initialEntries,
          nextCursor: null,
          range: "7d" satisfies FeedRange,
          sort: "score_desc" satisfies FeedSort,
          start: "2026-04-01",
          end: "2026-04-10",
          groupId: "group-1",
          sourceId: "source-2",
        }),
      ),
    );

    vi.stubGlobal("fetch", fetchMock);

    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="7d"
        initialSort="score_desc"
        initialStartDate="2026-04-01"
        initialEndDate="2026-04-10"
        initialNextCursor={null}
        initialStatus={null}
        isAdmin={false}
        initialGroupId=""
        initialSourceId=""
        availableGroups={[
          { id: "group-1", name: "Core", count: 2 },
          { id: "group-2", name: "Research", count: 1 },
        ]}
        availableSources={[
          { id: "source-1", name: "Feed One", groupId: "group-1" },
          { id: "source-2", name: "Feed Two", groupId: "group-1" },
          { id: "source-3", name: "Feed Three", groupId: "group-2" },
        ]}
      />,
    );

    expect(screen.getByRole("button", { name: "高级筛选" })).toHaveAttribute("aria-expanded", "true");
    await user.click(within(screen.getByRole("complementary", { name: "分组筛选侧栏" })).getByRole("button", { name: "Core (2)" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/feed?range=7d&sort=score_desc&start=2026-04-01&end=2026-04-10&groupId=group-1",
      );
    });

    fetchMock.mockClear();
    await selectFilterOption(user, "信息源", "Feed Two");

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/feed?range=7d&sort=score_desc&start=2026-04-01&end=2026-04-10&groupId=group-1&sourceId=source-2",
      );
    });
  });

  it("clears active filters and reloads the default feed", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        new Response(
          JSON.stringify({
            items: initialEntries,
            nextCursor: null,
            range: "today" satisfies FeedRange,
            sort: "time_desc" satisfies FeedSort,
            start: null,
            end: null,
            groupId: null,
            sourceId: null,
            title: null,
          }),
        ),
      );

    vi.stubGlobal("fetch", fetchMock);

    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="7d"
        initialSort="score_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialNextCursor={null}
        initialStatus={null}
        isAdmin={false}
        initialGroupId="group-1"
        initialSourceId="source-2"
        initialTitle="Agent"
        availableGroups={[{ id: "group-1", name: "Core", count: 1 }]}
        availableSources={[{ id: "source-2", name: "Feed Two", groupId: "group-1" }]}
      />,
    );

    expect(screen.getByRole("button", { name: "高级筛选" })).toHaveAttribute("aria-expanded", "true");
    await user.click(screen.getByRole("button", { name: "清除筛选" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/feed?range=today&sort=time_desc");
    });
    expect(screen.getByText("OpenAI Agent 发布")).toBeInTheDocument();
    expect(getSelectRoot("创建时间")).toHaveTextContent("当天");
    expect(screen.getByRole("button", { name: "高级筛选" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("全文搜索")).not.toBeInTheDocument();
    expect(screen.getByText("创建时间：当天")).toBeInTheDocument();
    expect(screen.getByText("排序：按时间倒序")).toBeInTheDocument();
    expect(screen.queryByText("搜索：Agent")).not.toBeInTheDocument();
  });

  it("renders Lumina-like pagination controls when the feed has another page", () => {
    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialPagination={{
          page: 1,
          size: 50,
          total: 21,
          totalPages: 2,
        }}
        initialStatus={null}
        isAdmin={false}
      />,
    );

    expect(screen.queryByRole("button", { name: "加载更多" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上一页" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下一页" })).toBeEnabled();
    expect(screen.getByText("第 1 / 2 页")).toBeInTheDocument();
    expect(screen.getByText("条，共 21 条")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "每页显示" })).toHaveValue("50");
    expect(screen.getByRole("spinbutton", { name: "跳转页码" })).toHaveValue(1);
    expect(screen.getByText("每页显示").parentElement).toHaveClass("text-sm");
    expect(screen.getByRole("button", { name: "上一页" })).toHaveClass("text-sm");
    expect(screen.getByRole("button", { name: "上一页" })).toHaveClass("font-medium");
    expect(screen.getByRole("button", { name: "下一页" })).toHaveClass("text-sm");
    expect(screen.getByRole("button", { name: "下一页" })).toHaveClass("font-medium");
    expect(screen.getByText("第 1 / 2 页")).toHaveClass("text-sm");
    expect(screen.getByRole("spinbutton", { name: "跳转页码" })).toHaveClass("text-sm");
    expect(screen.getByRole("button", { name: "跳转" })).toHaveClass("text-sm");
    expect(screen.getByRole("button", { name: "跳转" })).toHaveClass("font-medium");
  });

  it("switches pages and supports page size plus jump controls", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = getFetchUrl(input);

      if (url === "/api/feed?range=7d&sort=time_desc&page=2&includeTags=false") {
        return new Response(
          JSON.stringify({
            items: [
              {
                ...initialEntries[1],
                id: "item-page-2",
                title: "第二页标题",
                summary: "第二页摘要",
              },
            ],
            pagination: {
              page: 2,
              size: 50,
              total: 21,
              totalPages: 2,
            },
            range: "7d" satisfies FeedRange,
            sort: "time_desc" satisfies FeedSort,
            start: null,
            end: null,
            groupId: null,
            sourceId: null,
            title: null,
          }),
        );
      }

      if (url === "/api/feed?range=7d&sort=time_desc&size=100&includeTags=false") {
        return new Response(
          JSON.stringify({
            items: [
              {
                ...initialEntries[0],
                id: "cluster-page-size",
                title: "分页尺寸第一页",
              },
            ],
            pagination: {
              page: 1,
              size: 100,
              total: 250,
              totalPages: 3,
            },
            range: "7d" satisfies FeedRange,
            sort: "time_desc" satisfies FeedSort,
            start: null,
            end: null,
            groupId: null,
            sourceId: null,
            title: null,
          }),
        );
      }

      if (url === "/api/feed?range=7d&sort=time_desc&page=3&size=100&includeTags=false") {
        return new Response(
          JSON.stringify({
            items: [
              {
                ...initialEntries[1],
                id: "item-page-3",
                title: "第三页标题",
                summary: "第三页摘要",
              },
            ],
            pagination: {
              page: 3,
              size: 100,
              total: 250,
              totalPages: 3,
            },
            range: "7d" satisfies FeedRange,
            sort: "time_desc" satisfies FeedSort,
            start: null,
            end: null,
            groupId: null,
            sourceId: null,
            title: null,
          }),
        );
      }

      if (url === "/api/feed?range=7d&sort=time_desc&page=2&size=100&includeTags=false") {
        return new Response(
          JSON.stringify({
            items: [
              {
                ...initialEntries[1],
                id: "item-page-2-size-100",
                title: "第二页百条模式",
                summary: "第二页百条摘要",
              },
            ],
            pagination: {
              page: 2,
              size: 100,
              total: 250,
              totalPages: 3,
            },
            range: "7d" satisfies FeedRange,
            sort: "time_desc" satisfies FeedSort,
            start: null,
            end: null,
            groupId: null,
            sourceId: null,
            title: null,
          }),
        );
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(
      <FeedPanel
        initialItems={initialEntries}
        initialRange="7d"
        initialSort="time_desc"
        initialStartDate={null}
        initialEndDate={null}
        initialPagination={{
          page: 1,
          size: 50,
          total: 21,
          totalPages: 2,
        }}
        initialStatus={null}
        isAdmin={false}
        popularTags={[{ name: "OpenAI", normalized: "openai", count: 3 }]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "下一页" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/feed?range=7d&sort=time_desc&page=2&includeTags=false");
    });

    expect(await screen.findByText("第二页标题")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "筛选标签：OpenAI，3 条" })).toBeInTheDocument();
    expect(screen.queryByText("OpenAI Agent 发布")).not.toBeInTheDocument();
    expect(screen.getByText("第 2 / 2 页")).toBeInTheDocument();

    await selectFilterOption(user, "每页显示", "100");

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/feed?range=7d&sort=time_desc&size=100&includeTags=false");
    });

    expect(await screen.findByText("分页尺寸第一页")).toBeInTheDocument();
    expect(screen.getByText("第 1 / 3 页")).toBeInTheDocument();
    expect(screen.getByText("条，共 250 条")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByRole("spinbutton", { name: "跳转页码" })).toBeEnabled();
    });
    const jumpInput = screen.getByRole("spinbutton", { name: "跳转页码" });
    await user.clear(jumpInput);
    await user.type(jumpInput, "3");
    await user.click(screen.getByRole("button", { name: "跳转" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/feed?range=7d&sort=time_desc&page=3&size=100&includeTags=false");
    });

    expect(await screen.findByText("第三页标题")).toBeInTheDocument();
    expect(screen.getByText("第 3 / 3 页")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "上一页" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/feed?range=7d&sort=time_desc&page=2&size=100&includeTags=false");
    });

    expect(await screen.findByText("第二页百条模式")).toBeInTheDocument();
    expect(screen.getByText("第 2 / 3 页")).toBeInTheDocument();
  });
});
