import { render as testingRender, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { pushMock, refreshMock, replaceMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  refreshMock: vi.fn(),
  replaceMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushMock,
    refresh: refreshMock,
    replace: replaceMock,
  }),
}));

import { FeedPanel } from "@/components/feed/feed-panel";
import type { FeedEntryDTO } from "@/lib/feed/types";

type TestingRenderParameters = Parameters<typeof testingRender>;

function render(ui: TestingRenderParameters[0]) {
  const timezoneSpy = vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(0);

  try {
    return testingRender(ui);
  } finally {
    timezoneSpy.mockRestore();
  }
}

function buildClusterEntry(overrides: Partial<Extract<FeedEntryDTO, { type: "cluster" }>> = {}) {
  return {
    id: "cluster-empty",
    type: "cluster",
    title: "空预览聚合",
    summary: "缓存计数为 2，但没有任何真实可见成员",
    group: { id: "group-ai", name: "AI", color: "#3b82f6" },
    publishedAt: "2026-04-10T09:00:00.000Z",
    createdAt: "2026-04-10T09:00:00.000Z",
    latestPublishedAt: "2026-04-10T09:00:00.000Z",
    score: 90,
    sourceCount: 2,
    itemCount: 2,
    itemsPreview: [],
    hasMoreItems: true,
    ...overrides,
  } as Extract<FeedEntryDTO, { type: "cluster" }>;
}

function buildMember(id: string, title: string) {
  return {
    id,
    title,
    originalUrl: `https://example.com/${id}`,
    publishedAt: "2026-04-10T09:00:00.000Z",
    sourceName: "Example Feed",
    author: "Alex",
    summary: `${title} 摘要`,
    group: { id: "group-ai", name: "AI", color: "#3b82f6" },
    score: 88,
    canRegenerateTranslation: true,
  };
}

/** 只 mock 管理会话接口，其余请求一律失败，暴露真实展开链路。 */
function stubFetch(routes: (url: string) => Response | null) {
  const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
    const matched = routes(url);

    if (!matched) {
      throw new Error(`Unexpected fetch in test: ${url}`);
    }

    return matched;
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function adminSessionResponse() {
  return new Response(JSON.stringify({ isAdmin: true, expiresAt: null }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function getClusterCheckbox(clusterId: string) {
  const article = document.querySelector(`[data-feed-entry-id="${clusterId}"]`);
  expect(article).not.toBeNull();
  const checkboxes = within(article as HTMLElement).getAllByRole("checkbox");
  return checkboxes[0]!;
}

beforeEach(() => {
  vi.stubGlobal("scrollTo", vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("FeedPanel empty cluster selection", () => {
  it("never marks an empty-member cluster as selected without any selection action", async () => {
    // 复现：公开 Cursor 列表返回 count=2、preview=0，成员接口返回 0 条。
    stubFetch((url) => (url.startsWith("/api/admin/session") ? adminSessionResponse() : null));

    render(
      <FeedPanel
        initialItems={[buildClusterEntry()]}
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

    // 等到会话解析完成，管理员控件才渲染。
    await waitFor(() => {
      expect(getClusterCheckbox("cluster-empty")).toBeInTheDocument();
    });

    const checkbox = getClusterCheckbox("cluster-empty");
    await waitFor(() => {
      expect(checkbox).not.toBeChecked();
    });

    // 全选控件也不得因为空集合而变成已选中。
    const selectAll = screen.getByRole("checkbox", { name: /批量选择/ });
    expect(selectAll).not.toBeChecked();
    expect(selectAll).toHaveAccessibleName("批量选择 (0/0)");
  });

  it("keeps the cluster unchecked after the member API resolves empty, and expands to zero links", async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch((url) => {
      if (url.startsWith("/api/admin/session")) return adminSessionResponse();
      if (url.startsWith("/api/feed/clusters/cluster-empty")) {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return null;
    });

    render(
      <FeedPanel
        initialItems={[buildClusterEntry()]}
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

    await waitFor(() => {
      expect(getClusterCheckbox("cluster-empty")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "展开相关内容" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "收起相关内容" })).toBeInTheDocument();
    });

    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/api/feed/clusters/cluster-empty"))).toBe(true);

    const article = document.querySelector('[data-feed-entry-id="cluster-empty"]') as HTMLElement;
    expect(within(article).queryAllByRole("link")).toHaveLength(0);
    await waitFor(() => {
      expect(getClusterCheckbox("cluster-empty")).not.toBeChecked();
    });
  });

  it("preserves normal 4-member / 3-preview lazy expansion and explicit selection", async () => {
    const user = userEvent.setup();
    const members = [
      buildMember("m-1", "成员一"),
      buildMember("m-2", "成员二"),
      buildMember("m-3", "成员三"),
      buildMember("m-4", "成员四"),
    ];
    const fetchMock = stubFetch((url) => {
      if (url.startsWith("/api/admin/session")) return adminSessionResponse();
      if (url.startsWith("/api/feed/clusters/cluster-lazy")) {
        return new Response(JSON.stringify({ items: members }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return null;
    });

    render(
      <FeedPanel
        initialItems={[
          buildClusterEntry({
            id: "cluster-lazy",
            itemCount: 4,
            itemsPreview: [members[0], members[1], members[2]],
          }),
        ]}
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

    await waitFor(() => {
      expect(getClusterCheckbox("cluster-lazy")).toBeInTheDocument();
    });

    const checkbox = getClusterCheckbox("cluster-lazy");
    await waitFor(() => {
      expect(checkbox).not.toBeChecked();
    });

    await user.click(screen.getByRole("button", { name: "展开相关内容" }));

    await waitFor(() => {
      const article = document.querySelector('[data-feed-entry-id="cluster-lazy"]') as HTMLElement;
      expect(within(article).queryAllByRole("link")).toHaveLength(4);
    });

    // 真实成员加载后仍是部分选中状态，不是全选也不是全不选。
    await waitFor(() => {
      expect(getClusterCheckbox("cluster-lazy")).not.toBeChecked();
    });

    await user.click(getClusterCheckbox("cluster-lazy"));
    await waitFor(() => {
      expect(getClusterCheckbox("cluster-lazy")).toBeChecked();
    });

    await user.click(getClusterCheckbox("cluster-lazy"));
    await waitFor(() => {
      expect(getClusterCheckbox("cluster-lazy")).not.toBeChecked();
    });

    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/api/feed/clusters/cluster-lazy"))).toBe(true);
  });
});
