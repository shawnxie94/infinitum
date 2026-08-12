import type { ReactNode } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "@/components/ui/toast";
const { pushMock, refreshMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  refreshMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushMock,
    refresh: refreshMock,
  }),
}));

import { ContentReviewPanel } from "@/components/admin/content-review-panel";

function renderWithProviders(node: ReactNode) {
  return render(<ToastProvider>{node}</ToastProvider>);
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

const CLUSTER_REVIEW_COUNT_URL = "/api/admin/clusters/review-candidates?page=1&pageSize=1";
const CLUSTER_REVIEW_LIST_URL = "/api/admin/clusters/review-candidates?page=1&pageSize=10";

async function waitForLoaded() {
  await waitFor(() => {
    expect(screen.queryByText("加载中...")).not.toBeInTheDocument();
  });
}

async function confirmAction(user: ReturnType<typeof userEvent.setup>, buttonLabel: string) {
  await user.click(screen.getByRole("button", { name: buttonLabel }));
}

function createFilteredItem(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "item-1",
    title: "营销内容",
    originalUrl: "https://example.com/1",
    publishedAt: "2026-04-10T09:00:00.000Z",
    sourceName: "Example Feed",
    author: "Alex",
    summary: "摘要",
    moderationStatus: "filtered",
    moderationReason: "marketing",
    moderationDetail: "营销措辞明显",
    filterReason: null,
    qualityScore: 18,
    qualityRationale: "低质量",
    canRegenerateTranslation: true,
    ...overrides,
  };
}

function createClusterItem(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "item-1",
    title: "条目 A",
    originalUrl: "https://example.com/a",
    publishedAt: "2026-04-10T09:00:00.000Z",
    sourceName: "Example Feed",
    author: "Alex",
    summary: "条目摘要",
    moderationStatus: "published",
    moderationReason: null,
    moderationDetail: null,
    qualityScore: 80,
    qualityRationale: "高质量",
    canRegenerateTranslation: false,
    ...overrides,
  };
}

function createCluster(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "cluster-1",
    title: "AI 融资动态",
    summary: "聚合摘要",
    status: "active",
    score: 92,
    itemCount: 1,
    latestPublishedAt: "2026-04-10T09:00:00.000Z",
    latestItemUpdatedAt: "2026-04-10T11:00:00.000Z",
    items: [createClusterItem()],
    ...overrides,
  };
}

function createClusterReviewCandidate(overrides: Partial<Record<string, unknown>> = {}) {
  const leftCluster = createCluster({
    id: "cluster-1",
    title: "AI 融资动态",
    itemCount: 2,
  });
  const rightCluster = createCluster({
    id: "cluster-2",
    title: "AI 融资补充",
    summary: "另一组摘要",
    itemCount: 1,
  });

  return {
    id: "decision-1",
    verdict: "ambiguous",
    source: "llm",
    reasonCode: "llm_ambiguous",
    reasonText: "主体一致但对象证据不足",
    localScore: 86,
    confidence: 62,
    attemptCount: 0,
    expiresAt: null,
    createdAt: "2026-04-10T12:00:00.000Z",
    leftCluster,
    rightCluster,
    targetClusterId: "cluster-1",
    sourceClusterId: "cluster-2",
    ...overrides,
  };
}

function createAggregationSplit(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "split-parent-1",
    title: "SpaceX buys Cursor",
    originalUrl: "https://example.com/split-parent",
    publishedAt: "2026-06-17T09:00:00.000Z",
    createdAt: "2026-06-17T09:05:00.000Z",
    aggregationCheckedAt: "2026-06-17T10:34:00.000Z",
    sourceName: "TLTD",
    summary: "聚合父项摘要",
    status: "processed",
    moderationStatus: "filtered",
    aggregationParseStatus: "parsed",
    errorMessage: null,
    childCount: 12,
    eventUrlCount: 12,
    parentUrlCount: 0,
    qualityScore: 80,
    ...overrides,
  };
}

afterEach(() => {
  pushMock.mockReset();
  refreshMock.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ContentReviewPanel", () => {
  it("loads filtered items and restores one item", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = getFetchUrl(input);

      if (url === "/api/admin/items?moderationStatus=filtered&page=1&pageSize=10") {
        return new Response(
          JSON.stringify({
            items: [createFilteredItem()],
          }),
        );
      }

      if (url === "/api/admin/clusters?page=1&pageSize=10&minItemCount=2") {
        return new Response(
          JSON.stringify({
            clusters: [],
          }),
        );
      }

      if (url === "/api/admin/items/item-1/restore") {
        expect(init?.method).toBe("POST");

        return new Response(
          JSON.stringify({
            item: {
              id: "item-1",
              moderationStatus: "restored",
            },
          }),
        );
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<ContentReviewPanel />);
    await waitForLoaded();

    expect(screen.getByRole("heading", { name: "过滤内容" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "主导航" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "内容审核" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("审核关键词")).toBeInTheDocument();
    expect(screen.getByLabelText("审核来源")).toBeInTheDocument();
    expect(screen.getByLabelText("过滤原因")).toBeInTheDocument();
    const filteredTable = screen.getByRole("table");
    expect(within(filteredTable).getByRole("button", { name: /营销内容/ })).toBeInTheDocument();
    expect(within(filteredTable).queryByText("摘要")).not.toBeInTheDocument();
    expect(within(filteredTable).getByText("Example Feed")).toBeInTheDocument();

    await user.click(screen.getByTitle("恢复内容"));
    expect(await screen.findByRole("dialog", { name: "确认恢复内容" })).toBeInTheDocument();
    await confirmAction(user, "恢复");

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/items/item-1/restore", {
        method: "POST",
      });
    });

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("内容已恢复。");
    });
  });

  it("labels reparsed parent children as 重拆下线 instead of 待复核", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = getFetchUrl(input);

      if (url === "/api/admin/items?moderationStatus=filtered&page=1&pageSize=10") {
        return new Response(
          JSON.stringify({
            items: [
              createFilteredItem({
                title: "被重拆下线的子事件",
                moderationReason: null,
                moderationDetail: null,
                filterReason: "reparsed_parent",
              }),
            ],
            total: 1,
          }),
        );
      }

      if (url === "/api/admin/clusters?page=1&pageSize=10&minItemCount=2") {
        return new Response(
          JSON.stringify({
            clusters: [],
          }),
        );
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<ContentReviewPanel />);
    await waitForLoaded();

    const filteredTable = screen.getByRole("table");
    expect(within(filteredTable).getByRole("button", { name: /被重拆下线的子事件/ })).toBeInTheDocument();
    expect(within(filteredTable).getByText("重拆下线")).toBeInTheDocument();
    expect(within(filteredTable).queryByText("待复核")).not.toBeInTheDocument();
  });

  it("filters the current review list by keyword", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = getFetchUrl(input);

      if (url === "/api/admin/items?moderationStatus=filtered&page=1&pageSize=10") {
        return new Response(JSON.stringify({ items: [createFilteredItem()], total: 1 }));
      }

      if (url === "/api/admin/items?moderationStatus=filtered&page=1&pageSize=10&search=%E4%B8%8D%E5%AD%98%E5%9C%A8%E7%9A%84%E5%85%B3%E9%94%AE%E8%AF%8D") {
        return new Response(JSON.stringify({ items: [], total: 0 }));
      }

      if (url === "/api/admin/clusters?page=1&pageSize=10&minItemCount=2") {
        return new Response(JSON.stringify({ clusters: [], total: 0 }));
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<ContentReviewPanel />);
    await waitForLoaded();

    expect(
      within(screen.getByRole("table")).getByRole("button", { name: /营销内容/ }),
    ).toBeInTheDocument();

    await user.type(screen.getByLabelText("审核关键词"), "不存在的关键词");

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/items?moderationStatus=filtered&page=1&pageSize=10&search=%E4%B8%8D%E5%AD%98%E5%9C%A8%E7%9A%84%E5%85%B3%E9%94%AE%E8%AF%8D",
      );
      expect(screen.getByText("暂无匹配内容")).toBeInTheDocument();
    });
  });

  it("renders markdown emphasis in the filtered item detail summary", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = getFetchUrl(input);

      if (url === "/api/admin/items?moderationStatus=filtered&page=1&pageSize=10") {
        return new Response(
          JSON.stringify({
            items: [createFilteredItem({ summary: "这是 **重点** 和 *补充*" })],
            total: 1,
          }),
        );
      }

      if (url === "/api/admin/clusters?page=1&pageSize=10&minItemCount=2") {
        return new Response(JSON.stringify({ clusters: [], total: 0 }));
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<ContentReviewPanel />);
    await waitForLoaded();

    await user.click(within(screen.getByRole("table")).getByRole("button", { name: /营销内容/ }));
    const detailDialog = await screen.findByRole("dialog", { name: "过滤内容详情" });

    expect(within(detailDialog).getByText("重点").tagName).toBe("STRONG");
    expect(within(detailDialog).getByText("补充").tagName).toBe("EM");
  });

  it("renders markdown emphasis in the cluster detail summary", async () => {
    const user = userEvent.setup();
    const cluster = createCluster({ summary: "聚合 **重点** 与 *背景*" });
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = getFetchUrl(input);

      if (url === "/api/admin/items?moderationStatus=filtered&page=1&pageSize=10") {
        return new Response(JSON.stringify({ items: [], total: 0 }));
      }

      if (url === "/api/admin/clusters?page=1&pageSize=10&minItemCount=2") {
        return new Response(JSON.stringify({ clusters: [cluster], total: 1 }));
      }

      if (url === CLUSTER_REVIEW_COUNT_URL) {
        return new Response(JSON.stringify({ candidates: [], total: 0 }));
      }

      if (url === "/api/admin/clusters/cluster-1") {
        return new Response(JSON.stringify({ cluster }));
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<ContentReviewPanel activeTab="clusters" />);
    await waitForLoaded();

    await user.click(screen.getByText("AI 融资动态"));
    const detailDialog = await screen.findByRole("dialog", { name: "聚合详情" });

    expect(within(detailDialog).getByText("重点").tagName).toBe("STRONG");
    expect(within(detailDialog).getByText("背景").tagName).toBe("EM");
  });

  it("renders aggregation split management without the link column", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = getFetchUrl(input);

      if (url === "/api/admin/items/aggregation?page=1&pageSize=10") {
        return new Response(JSON.stringify({ aggregationSplits: [createAggregationSplit()], total: 1 }));
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<ContentReviewPanel activeTab="splits" />);
    await waitForLoaded();

    expect(screen.getByText("管理聚合拆分结果")).toBeInTheDocument();
    expect(screen.queryByText("查看聚合 item 的拆分结果并支持手动取消拆分")).not.toBeInTheDocument();

    const table = screen.getByRole("table");
    expect(within(table).getByText("拆分时间")).toBeInTheDocument();
    expect(within(table).queryByText("链接")).not.toBeInTheDocument();
    expect(within(table).getByText("已拆分")).toHaveClass("whitespace-nowrap");
    expect(within(table).getByText("12 条")).toBeInTheDocument();
    expect(within(table).getByText("06/17 18:34")).toBeInTheDocument();
  });

  it("keeps cluster list keyword searches restricted to multi-item clusters", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = getFetchUrl(input);

      if (url === "/api/admin/clusters?page=1&pageSize=10&minItemCount=2") {
        return new Response(JSON.stringify({ clusters: [createCluster({ itemCount: 2 })], total: 1 }));
      }

      if (url === "/api/admin/clusters?page=1&pageSize=10&search=OpenAI&minItemCount=2") {
        return new Response(JSON.stringify({ clusters: [], total: 0 }));
      }

      if (url === CLUSTER_REVIEW_COUNT_URL) {
        return new Response(JSON.stringify({ candidates: [], total: 0 }));
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<ContentReviewPanel activeTab="clusters" />);
    await waitForLoaded();

    await user.type(screen.getByLabelText("审核关键词"), "OpenAI");

    await waitFor(
      () => {
        expect(fetchMock).toHaveBeenCalledWith("/api/admin/clusters?page=1&pageSize=10&search=OpenAI&minItemCount=2");
      },
      { timeout: 2_000 },
    );
  });

  it("loads cluster review candidates and merges one from the review queue", async () => {
    const user = userEvent.setup();
    let reviewCandidateMerged = false;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = getFetchUrl(input);

      if (url === "/api/admin/clusters?page=1&pageSize=10&minItemCount=2") {
        return new Response(JSON.stringify({ clusters: [createCluster({ itemCount: 2 })], total: 1 }));
      }

      if (url === CLUSTER_REVIEW_COUNT_URL) {
        return new Response(
          JSON.stringify({
            total: reviewCandidateMerged ? 0 : 1,
          }),
        );
      }

      if (url === CLUSTER_REVIEW_LIST_URL) {
        return new Response(
          JSON.stringify({
            candidates: reviewCandidateMerged ? [] : [createClusterReviewCandidate()],
            total: reviewCandidateMerged ? 0 : 1,
          }),
        );
      }

      if (url === "/api/admin/clusters/cluster-2") {
        return new Response(
          JSON.stringify({
            cluster: createCluster({
              id: "cluster-2",
              title: "AI 融资补充",
              summary: "另一组摘要",
              itemCount: 1,
              items: [createClusterItem({ id: "item-2", title: "融资补充条目" })],
            }),
          }),
        );
      }

      if (url === "/api/admin/clusters/review-candidates/decision-1/merge") {
        expect(init?.method).toBe("POST");
        reviewCandidateMerged = true;
        return new Response(
          JSON.stringify({
            result: {
              targetClusterId: "cluster-1",
              mergedClusterIds: ["cluster-2"],
              itemsMoved: 1,
              taskId: "task-review-merge",
            },
          }),
        );
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<ContentReviewPanel activeTab="clusters" />);
    await waitForLoaded();

    await user.click(screen.getByRole("button", { name: "聚合待定（1）" }));
    const reviewDialog = await screen.findByRole("dialog", { name: "聚合待定" });
    expect(within(reviewDialog).getByText("AI 融资补充")).toBeInTheDocument();
    expect(within(reviewDialog).getByText("置信分")).toBeInTheDocument();
    expect(within(reviewDialog).getByText("62")).toBeInTheDocument();
    expect(within(reviewDialog).queryByText("另一组摘要")).not.toBeInTheDocument();
    expect(within(reviewDialog).queryByText("本地 86")).not.toBeInTheDocument();
    expect(within(reviewDialog).queryByText("置信 62")).not.toBeInTheDocument();

    await user.click(within(reviewDialog).getByRole("button", { name: "AI 融资补充" }));
    const detailDialog = await screen.findByRole("dialog", { name: "聚合详情" });
    expect(within(detailDialog).getByText("另一组摘要")).toBeInTheDocument();
    expect(within(detailDialog).getByText("包含内容 (1)")).toBeInTheDocument();
    expect(within(detailDialog).getByText("融资补充条目")).toBeInTheDocument();
    await user.click(within(detailDialog).getAllByRole("button", { name: "关闭" }).at(-1)!);

    await user.click(within(reviewDialog).getByRole("button", { name: /合并待定/ }));
    expect(await screen.findByRole("dialog", { name: "确认合并待定" })).toBeInTheDocument();
    await confirmAction(user, "合并");

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/clusters/review-candidates/decision-1/merge", {
        method: "POST",
      });
    });
    await waitFor(() => {
      expect(screen.queryByText("AI 融资补充")).not.toBeInTheDocument();
    });
    expect(screen.getByRole("status")).toHaveTextContent("待定合并完成，移动 1 个条目。");
  });

  it("ignores a cluster review candidate from the review queue", async () => {
    const user = userEvent.setup();
    let reviewCandidateIgnored = false;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = getFetchUrl(input);

      if (url === "/api/admin/clusters?page=1&pageSize=10&minItemCount=2") {
        return new Response(JSON.stringify({ clusters: [createCluster({ itemCount: 2 })], total: 1 }));
      }

      if (url === CLUSTER_REVIEW_COUNT_URL) {
        return new Response(
          JSON.stringify({
            total: reviewCandidateIgnored ? 0 : 1,
          }),
        );
      }

      if (url === CLUSTER_REVIEW_LIST_URL) {
        return new Response(
          JSON.stringify({
            candidates: reviewCandidateIgnored ? [] : [createClusterReviewCandidate()],
            total: reviewCandidateIgnored ? 0 : 1,
          }),
        );
      }

      if (url === "/api/admin/clusters/review-candidates/decision-1/ignore") {
        expect(init?.method).toBe("POST");
        reviewCandidateIgnored = true;
        return new Response(JSON.stringify({ success: true }));
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<ContentReviewPanel activeTab="clusters" />);
    await waitForLoaded();

    await user.click(screen.getByRole("button", { name: "聚合待定（1）" }));
    const reviewDialog = await screen.findByRole("dialog", { name: "聚合待定" });
    expect(within(reviewDialog).getByText("主体一致但对象证据不足")).toBeInTheDocument();
    await user.click(within(reviewDialog).getByRole("button", { name: /忽略待定/ }));
    expect(await screen.findByRole("dialog", { name: "确认忽略待定" })).toBeInTheDocument();
    await confirmAction(user, "忽略");

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/clusters/review-candidates/decision-1/ignore", {
        method: "POST",
      });
    });
    await waitFor(() => {
      expect(screen.queryByText("主体一致但对象证据不足")).not.toBeInTheDocument();
    });
    expect(screen.getByRole("status")).toHaveTextContent("已忽略并写入不可合并约束。");
  });

  it("queues reanalyze as a background task", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = getFetchUrl(input);

      if (url === "/api/admin/items?moderationStatus=filtered&page=1&pageSize=10") {
        return new Response(
          JSON.stringify({
            items: [createFilteredItem()],
          }),
        );
      }

      if (url === "/api/admin/clusters?page=1&pageSize=10&minItemCount=2") {
        return new Response(JSON.stringify({ clusters: [], total: 0 }));
      }

      if (url === "/api/admin/items/item-1/reanalyze") {
        expect(init?.method).toBe("POST");

        return new Response(
          JSON.stringify({
            taskRun: {
              id: "task-1",
              kind: "item_reanalyze",
            },
          }),
          { status: 202 },
        );
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<ContentReviewPanel />);
    await waitForLoaded();

    expect(
      within(screen.getByRole("table")).getByRole("button", { name: /营销内容/ }),
    ).toBeInTheDocument();

    await user.click(screen.getByTitle("重新 AI 判定"));
    expect(await screen.findByRole("dialog", { name: "确认重新 AI 判定" })).toBeInTheDocument();
    await confirmAction(user, "重新判定");

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/items/item-1/reanalyze", {
        method: "POST",
      });
    });

    expect(screen.getByRole("status")).toHaveTextContent("已创建后台任务，正在处理中。");
    expect(
      within(screen.getByRole("table")).getByRole("button", { name: /营销内容/ }),
    ).toBeInTheDocument();
  });

  it("shows an error when reanalyze returns 202 without taskRun", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = getFetchUrl(input);

      if (url === "/api/admin/items?moderationStatus=filtered&page=1&pageSize=10") {
        return new Response(JSON.stringify({ items: [createFilteredItem()], total: 1 }));
      }

      if (url === "/api/admin/clusters?page=1&pageSize=10&minItemCount=2") {
        return new Response(JSON.stringify({ clusters: [], total: 0 }));
      }

      if (url === "/api/admin/items/item-1/reanalyze") {
        expect(init?.method).toBe("POST");

        return new Response(JSON.stringify({}), { status: 202 });
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<ContentReviewPanel />);
    await waitForLoaded();

    expect(
      within(screen.getByRole("table")).getByRole("button", { name: /营销内容/ }),
    ).toBeInTheDocument();

    await user.click(screen.getByTitle("重新 AI 判定"));
    expect(await screen.findByRole("dialog", { name: "确认重新 AI 判定" })).toBeInTheDocument();
    await confirmAction(user, "重新判定");

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("操作失败");
    });

    expect(screen.queryByText("已创建后台任务，正在处理中。")).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("table")).getByRole("button", { name: /营销内容/ }),
    ).toBeInTheDocument();
  });

  it("updates cluster preview after detaching an item", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = getFetchUrl(input);

      if (url === "/api/admin/items?moderationStatus=filtered&page=1&pageSize=10") {
        return new Response(JSON.stringify({ items: [], total: 0 }));
      }

      if (url === "/api/admin/clusters?page=1&pageSize=10&minItemCount=2") {
        return new Response(
          JSON.stringify({
            clusters: [
              createCluster({
                itemCount: 2,
                items: [createClusterItem(), createClusterItem({ id: "item-2", title: "条目 B" })],
              }),
            ],
          }),
        );
      }

      if (url === CLUSTER_REVIEW_COUNT_URL) {
        return new Response(JSON.stringify({ candidates: [], total: 0 }));
      }

      if (url === "/api/admin/clusters/cluster-1/items/item-1/detach") {
        expect(init?.method).toBe("POST");

        return new Response(
          JSON.stringify({
            cluster: createCluster({ itemCount: 0, items: [] }),
          }),
        );
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<ContentReviewPanel activeTab="clusters" />);
    await waitForLoaded();

    expect(screen.getByRole("heading", { name: "聚合管理" })).toBeInTheDocument();
    await user.click(screen.getByText("AI 融资动态"));
    const detailDialog = await screen.findByRole("dialog", { name: "聚合详情" });
    expect(within(detailDialog).getByText("条目 A")).toBeInTheDocument();

    await user.click(within(detailDialog).getAllByTitle("移出聚合")[0]);
    expect(await screen.findByRole("dialog", { name: "确认移出条目" })).toBeInTheDocument();
    await confirmAction(user, "移出");

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/clusters/cluster-1/items/item-1/detach", {
        method: "POST",
      });
    });

    await waitFor(() => {
      expect(screen.queryByText("条目 A")).not.toBeInTheDocument();
    });

    expect(screen.getByText("包含内容 (0)")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("已移出聚合组。");
  });

  it("splits a whole cluster into singleton clusters from the cluster list", async () => {
    const user = userEvent.setup();
    let splitCalled = false;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = getFetchUrl(input);

      if (url === "/api/admin/items?moderationStatus=filtered&page=1&pageSize=10") {
        return new Response(JSON.stringify({ items: [], total: 0 }));
      }

      if (url === "/api/admin/clusters?page=1&pageSize=10&minItemCount=2") {
        return new Response(
          JSON.stringify({
            clusters: splitCalled
              ? []
              : [
                  createCluster({
                    itemCount: 2,
                    items: [createClusterItem(), createClusterItem({ id: "item-2", title: "条目 B" })],
                  }),
                ],
            total: splitCalled ? 0 : 1,
          }),
        );
      }

      if (url === CLUSTER_REVIEW_COUNT_URL) {
        return new Response(JSON.stringify({ candidates: [], total: 0 }));
      }

      if (url === "/api/admin/clusters/cluster-1/split") {
        expect(init?.method).toBe("POST");
        splitCalled = true;
        return new Response(
          JSON.stringify({
            success: true,
            cluster: null,
            result: {
              clusterId: "cluster-1",
              itemCount: 2,
              singletonClusterIds: ["single-item-1", "single-item-2"],
            },
          }),
        );
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<ContentReviewPanel activeTab="clusters" />);
    await waitForLoaded();

    expect(screen.getAllByText("最新更新").length).toBeGreaterThan(0);
    expect(within(screen.getByRole("table")).getByText("AI 融资动态")).toBeInTheDocument();

    await user.click(screen.getByTitle("全部拆分"));
    const confirmDialog = await screen.findByRole("dialog", { name: "确认全部拆分" });
    await user.click(within(confirmDialog).getByRole("button", { name: "全部拆分" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/clusters/cluster-1/split", {
        method: "POST",
      });
    });
    await waitFor(() => {
      expect(screen.queryByText("AI 融资动态")).not.toBeInTheDocument();
    });

    expect(screen.getByRole("status")).toHaveTextContent("已拆分为单条目聚合。");
  });

  it("shows an error when detaching an item returns 200 without cluster", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = getFetchUrl(input);

      if (url === "/api/admin/items?moderationStatus=filtered&page=1&pageSize=10") {
        return new Response(JSON.stringify({ items: [], total: 0 }));
      }

      if (url === "/api/admin/clusters?page=1&pageSize=10&minItemCount=2") {
        return new Response(
          JSON.stringify({
            clusters: [
              createCluster({
                itemCount: 2,
                items: [createClusterItem(), createClusterItem({ id: "item-2", title: "条目 B" })],
              }),
            ],
          }),
        );
      }

      if (url === CLUSTER_REVIEW_COUNT_URL) {
        return new Response(JSON.stringify({ candidates: [], total: 0 }));
      }

      if (url === "/api/admin/clusters/cluster-1/items/item-1/detach") {
        expect(init?.method).toBe("POST");
        return new Response(JSON.stringify({}), { status: 200 });
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<ContentReviewPanel activeTab="clusters" />);
    await waitForLoaded();

    await user.click(screen.getByText("AI 融资动态"));
    const detailDialog = await screen.findByRole("dialog", { name: "聚合详情" });
    expect(within(detailDialog).getByText("条目 A")).toBeInTheDocument();

    await user.click(within(detailDialog).getAllByTitle("移出聚合")[0]);
    expect(await screen.findByRole("dialog", { name: "确认移出条目" })).toBeInTheDocument();
    await confirmAction(user, "移出");

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("操作失败");
    });

    expect(screen.queryByText("已移出聚合组。")).not.toBeInTheDocument();
    expect(screen.getByText("条目 A")).toBeInTheDocument();
  });

  it("shows an error when regenerating a summary returns 202 without taskRun", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = getFetchUrl(input);

      if (url === "/api/admin/items?moderationStatus=filtered&page=1&pageSize=10") {
        return new Response(JSON.stringify({ items: [], total: 0 }));
      }

      if (url === "/api/admin/clusters?page=1&pageSize=10&minItemCount=2") {
        return new Response(
          JSON.stringify({
            clusters: [
              createCluster({
                itemCount: 2,
                items: [createClusterItem(), createClusterItem({ id: "item-2", title: "条目 B" })],
              }),
            ],
          }),
        );
      }

      if (url === CLUSTER_REVIEW_COUNT_URL) {
        return new Response(JSON.stringify({ candidates: [], total: 0 }));
      }

      if (url === "/api/admin/clusters/cluster-1/regenerate-summary") {
        expect(init?.method).toBe("POST");
        return new Response(JSON.stringify({}), { status: 202 });
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<ContentReviewPanel activeTab="clusters" />);
    await waitForLoaded();

    expect(within(screen.getByRole("table")).getByText("AI 融资动态")).toBeInTheDocument();

    await user.click(screen.getByTitle("重新生成摘要"));
    expect(await screen.findByRole("dialog", { name: "确认重新生成摘要" })).toBeInTheDocument();
    await confirmAction(user, "重新生成");

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("操作失败");
    });

    expect(screen.queryByText("已创建后台任务，正在处理中。")).not.toBeInTheDocument();
    expect(within(screen.getByRole("table")).getByText("AI 融资动态")).toBeInTheDocument();
  });

  it.each([
    {
      buttonLabel: "隐藏聚合组",
      cluster: createCluster({
        itemCount: 2,
        items: [createClusterItem(), createClusterItem({ id: "item-2", title: "条目 B" })],
      }),
      requestUrl: "/api/admin/clusters/cluster-1/hide",
    },
    {
      buttonLabel: "恢复聚合组",
      cluster: createCluster({
        status: "hidden",
        itemCount: 2,
        items: [createClusterItem(), createClusterItem({ id: "item-2", title: "条目 B" })],
      }),
      requestUrl: "/api/admin/clusters/cluster-1/restore",
    },
  ])("shows an error when $buttonLabel returns 200 without cluster", async ({ buttonLabel, cluster, requestUrl }) => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = getFetchUrl(input);

      if (url === "/api/admin/items?moderationStatus=filtered&page=1&pageSize=10") {
        return new Response(JSON.stringify({ items: [], total: 0 }));
      }

      if (url === "/api/admin/clusters?page=1&pageSize=10&minItemCount=2") {
        return new Response(JSON.stringify({ clusters: [cluster], total: 1 }));
      }

      if (url === CLUSTER_REVIEW_COUNT_URL) {
        return new Response(JSON.stringify({ candidates: [], total: 0 }));
      }

      if (url === requestUrl) {
        expect(init?.method).toBe("POST");
        return new Response(JSON.stringify({}), { status: 200 });
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<ContentReviewPanel activeTab="clusters" />);
    await waitForLoaded();

    expect(within(screen.getByRole("table")).getByText("AI 融资动态")).toBeInTheDocument();

    await user.click(screen.getByTitle(buttonLabel === "隐藏聚合组" ? "隐藏聚合" : "恢复显示"));
    expect(
      await screen.findByRole("dialog", {
        name: buttonLabel === "隐藏聚合组" ? "确认隐藏聚合" : "确认恢复聚合",
      }),
    ).toBeInTheDocument();
    await confirmAction(user, buttonLabel === "隐藏聚合组" ? "隐藏" : "恢复");

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("操作失败");
    });

    expect(screen.queryByText(buttonLabel === "隐藏聚合组" ? "聚合组已隐藏。" : "聚合组已恢复。")).not.toBeInTheDocument();
    expect(within(screen.getByRole("table")).getByText("AI 融资动态")).toBeInTheDocument();
  });

  it.each([
    {
      name: "filtered request returns a non-2xx response",
      failingUrl: "/api/admin/items?moderationStatus=filtered&page=1&pageSize=10",
      okUrl: "/api/admin/clusters?page=1&pageSize=10&minItemCount=2",
      okBody: { clusters: [], total: 0 },
      activeTab: "filtered" as const,
    },
    {
      name: "cluster request returns a non-2xx response",
      failingUrl: "/api/admin/clusters?page=1&pageSize=10&minItemCount=2",
      okUrl: "/api/admin/items?moderationStatus=filtered&page=1&pageSize=10",
      okBody: { items: [], total: 0 },
      activeTab: "clusters" as const,
    },
  ])("shows a load failure when $name", async ({ failingUrl, okUrl, okBody, activeTab }) => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = getFetchUrl(input);

      if (url === failingUrl) {
        return new Response(JSON.stringify({}), { status: 500 });
      }

      if (url === okUrl) {
        return new Response(JSON.stringify(okBody));
      }

      if (url === CLUSTER_REVIEW_COUNT_URL) {
        return new Response(JSON.stringify({ candidates: [], total: 0 }));
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<ContentReviewPanel activeTab={activeTab} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("审核数据加载失败。");
  });
});
