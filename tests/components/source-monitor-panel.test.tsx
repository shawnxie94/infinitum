import type { ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SourceMonitorPanel } from "@/components/admin/source-monitor-panel";
import { ToastProvider } from "@/components/ui/toast";
import type {
  SourceMonitorEntry,
  SourceMonitorSnapshot,
} from "@/lib/source-monitor/types";

function renderWithProviders(node: ReactNode) {
  return render(<ToastProvider>{node}</ToastProvider>);
}

function buildSource(overrides: Partial<SourceMonitorEntry> = {}): SourceMonitorEntry {
  return {
    id: "source-1",
    name: "Source One",
    rssUrl: "https://example.com/feed.xml",
    siteUrl: "https://example.com",
    groupName: "科技",
    healthStatus: "healthy",
    healthMessage: null,
    healthCheckedAt: "2026-04-21T00:00:00.000Z",
    lastFetchedAt: "2026-04-21T00:00:00.000Z",
    lastItemCreatedAt: "2026-04-21T00:00:00.000Z",
    inactiveDays: 0,
    itemCount: 3,
    ...overrides,
  };
}

function buildSnapshot(overrides: Partial<SourceMonitorSnapshot> = {}): SourceMonitorSnapshot {
  const sources = overrides.sources ?? [buildSource()];

  return {
    generatedAt: "2026-04-21T00:00:00.000Z",
    totalEnabledSourceCount: 12,
    filteredSourceCount: sources.length,
    pagination: {
      page: 1,
      pageSize: 10,
      totalItems: sources.length,
      totalPages: 1,
    },
    sources,
    health: {
      healthyCount: 10,
      failedCount: 1,
      unknownCount: 1,
      attentionSources: [],
    },
    inactivityBuckets: [
      {
        key: "day",
        label: "1天",
        days: 1,
        cutoff: "2026-04-20T00:00:00.000Z",
        count: 2,
      },
      {
        key: "year",
        label: "1年",
        days: 365,
        cutoff: "2025-04-21T00:00:00.000Z",
        count: 1,
      },
    ],
    groups: [
      { value: "all", label: "全部", count: 12 },
      { value: "科技", label: "科技", count: 8 },
      { value: "未分组", label: "未分组", count: 4 },
    ],
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SourceMonitorPanel", () => {
  it("uses the initial server snapshot without an immediate duplicate request", () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(
      <SourceMonitorPanel initialSnapshot={buildSnapshot()} />,
    );

    expect(screen.getByText("Source One")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requests the backend when switching pages in both directions", async () => {
    const user = userEvent.setup();
    const pageOneSnapshot = buildSnapshot({
      sources: [buildSource({ id: "source-1", name: "Source One" })],
      filteredSourceCount: 11,
      pagination: {
        page: 1,
        pageSize: 10,
        totalItems: 11,
        totalPages: 2,
      },
    });
    const pageTwoSnapshot = buildSnapshot({
      sources: [buildSource({ id: "source-2", name: "Source Two" })],
      filteredSourceCount: 11,
      pagination: {
        page: 2,
        pageSize: 10,
        totalItems: 11,
        totalPages: 2,
      },
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(pageTwoSnapshot)))
      .mockResolvedValueOnce(new Response(JSON.stringify(pageOneSnapshot)));
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(
      <SourceMonitorPanel
        initialSnapshot={pageOneSnapshot}
      />,
    );

    await user.click(screen.getByRole("button", { name: "下一页" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/admin/monitor/sources?page=2&pageSize=10");
    });
    expect(await screen.findByText("Source Two")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "上一页" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/admin/monitor/sources?page=1&pageSize=10");
    });
    expect(await screen.findByText("Source One")).toBeInTheDocument();
  });

  it("requests the backend with filters and resets pagination", async () => {
    const user = userEvent.setup();
    const filteredSnapshot = buildSnapshot({
      sources: [buildSource({ id: "failed-source", name: "Failed Source", healthStatus: "failed" })],
      filteredSourceCount: 1,
      pagination: {
        page: 1,
        pageSize: 10,
        totalItems: 1,
        totalPages: 1,
      },
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify(filteredSnapshot)),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(
      <SourceMonitorPanel
        initialSnapshot={buildSnapshot({
          pagination: {
            page: 2,
            pageSize: 10,
            totalItems: 20,
            totalPages: 2,
          },
          filteredSourceCount: 20,
        })}
      />,
    );

    await user.selectOptions(screen.getByLabelText("健康状态"), "failed");

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/monitor/sources?page=1&pageSize=10&healthStatus=failed");
    });
    expect(await screen.findByText("Failed Source")).toBeInTheDocument();
  });

  it("requests the backend when changing page size", async () => {
    const user = userEvent.setup();
    const resizedSnapshot = buildSnapshot({
      filteredSourceCount: 20,
      pagination: {
        page: 1,
        pageSize: 20,
        totalItems: 20,
        totalPages: 1,
      },
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify(resizedSnapshot)),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(
      <SourceMonitorPanel
        initialSnapshot={buildSnapshot({
          filteredSourceCount: 20,
          pagination: {
            page: 2,
            pageSize: 10,
            totalItems: 20,
            totalPages: 2,
          },
        })}
      />,
    );

    await user.selectOptions(screen.getByLabelText("每页显示"), "20");

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/monitor/sources?page=1&pageSize=20");
    });
  });

  it("does not render relative or unsafe RSS URLs as clickable elements", () => {
    renderWithProviders(
      <SourceMonitorPanel
        initialSnapshot={buildSnapshot({
          sources: [
            buildSource({ id: "valid", name: "Valid RSS", rssUrl: "https://example.com/feed.xml" }),
            buildSource({ id: "relative", name: "Relative RSS", rssUrl: "rss.xml" }),
            buildSource({ id: "unsafe", name: "Unsafe RSS", rssUrl: "javascript:alert(1)" }),
          ],
          pagination: {
            page: 1,
            pageSize: 10,
            totalItems: 3,
            totalPages: 1,
          },
          filteredSourceCount: 3,
        })}
      />,
    );

    const rssButtons = screen.getAllByRole("button", { name: /RSS/ });
    expect(rssButtons).toHaveLength(1);

    const rssLinks = screen.queryByRole("link", { name: /RSS/ });
    expect(rssLinks).toBeNull();

    expect(screen.getByText("Relative RSS")).toBeInTheDocument();
    expect(screen.getByText("Unsafe RSS")).toBeInTheDocument();
  });

  it("renders attention sources with actionable reasons in the summary modal", async () => {
    const user = userEvent.setup();

    renderWithProviders(
      <SourceMonitorPanel
        initialSnapshot={buildSnapshot({
          health: {
            healthyCount: 9,
            failedCount: 2,
            unknownCount: 1,
            attentionSources: [
              buildSource({
                id: "failed-source",
                name: "Failed Source",
                healthStatus: "failed",
                healthMessage: "RSS fetch failed with status 500",
                attentionReasons: ["抓取异常：RSS fetch failed with status 500"],
              }),
            ],
          },
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "异常摘要" }));

    expect(screen.getByRole("dialog", { name: "异常摘要" })).toBeInTheDocument();
    expect(screen.getByText("Failed Source")).toBeInTheDocument();
    expect(screen.getAllByText("抓取异常：RSS fetch failed with status 500").length).toBeGreaterThan(0);
  });

  it("opens the attention summary modal from the initial route intent", () => {
    renderWithProviders(
      <SourceMonitorPanel
        initialOpenAttentionSummary
        initialSnapshot={buildSnapshot({
          health: {
            healthyCount: 9,
            failedCount: 2,
            unknownCount: 1,
            attentionSources: [
              buildSource({
                id: "failed-source",
                name: "Failed Source",
                healthStatus: "failed",
                healthMessage: "RSS fetch failed with status 500",
                attentionReasons: ["抓取异常：RSS fetch failed with status 500"],
              }),
            ],
          },
        })}
      />,
    );

    expect(screen.getByRole("dialog", { name: "异常摘要" })).toBeInTheDocument();
    expect(screen.getByText("Failed Source")).toBeInTheDocument();
  });
});
