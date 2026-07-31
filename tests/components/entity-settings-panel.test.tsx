import type { ReactNode } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EntitySettingsPanel } from "@/components/admin/entity-settings-panel";
import { ToastProvider } from "@/components/ui/toast";

function renderWithProviders(node: ReactNode) {
  return render(<ToastProvider>{node}</ToastProvider>);
}

const entityListPayload = {
  entities: [
    {
      id: "entity-agent",
      name: "AI Agent",
      normalized: "ai agent",
      itemCount: 12,
      aliasCount: 1,
      aliases: [
        {
          id: "alias-agent-cn",
          aliasName: "智能体",
          aliasNormalized: "智能体",
          createdBy: "admin",
          createdAt: "2026-04-20T10:00:00.000Z",
        },
      ],
      createdAt: "2026-04-20T10:00:00.000Z",
      updatedAt: "2026-04-21T10:00:00.000Z",
    },
    {
      id: "entity-agents",
      name: "AI Agents",
      normalized: "ai agents",
      itemCount: 3,
      aliasCount: 0,
      aliases: [],
      createdAt: "2026-04-20T10:00:00.000Z",
      updatedAt: "2026-04-21T11:00:00.000Z",
    },
  ],
  totalCount: 2,
  page: 1,
  pageSize: 10,
};

const entitySuggestionPayload = {
  suggestions: [
    {
      id: "entity-agents:entity-agent",
      sourceEntity: {
        id: "entity-agents",
        name: "AI Agents",
        normalized: "ai agents",
        itemCount: 3,
        aliasCount: 0,
      },
      targetEntity: {
        id: "entity-agent",
        name: "AI Agent",
        normalized: "ai agent",
        itemCount: 12,
        aliasCount: 1,
      },
      confidence: 0.96,
      reasons: ["英文单复数或词序差异"],
      affectedItemCount: 3,
    },
  ],
  totalCount: 1,
  page: 1,
  pageSize: 10,
};

function createFetchMock() {
  return vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);

    if (url === "/api/admin/settings/entities/suggestions" && init?.method === "POST") {
      const body = init.body ? JSON.parse(String(init.body)) : {};
      if (body.action === "auto_merge_high_confidence") {
        return new Response(JSON.stringify({
          scannedCount: 1,
          mergedCount: 1,
          affectedClusterCount: 0,
          skippedCount: 0,
          failedCount: 0,
        }));
      }

      return new Response(JSON.stringify({ ok: true }));
    }

    if (url.startsWith("/api/admin/settings/entities/suggestions")) {
      return new Response(JSON.stringify(entitySuggestionPayload));
    }

    if (url === "/api/admin/settings/entities/merge" && init?.method === "POST") {
      return new Response(JSON.stringify({ mergedCount: 1, affectedClusterCount: 0 }));
    }

    return new Response(JSON.stringify(entityListPayload));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("EntitySettingsPanel", () => {
  it("loads entities with database pagination and shows management actions", async () => {
    const user = userEvent.setup();
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<EntitySettingsPanel />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/settings/entities?sort=usage_desc&page=1&pageSize=10", {
        method: "GET",
        headers: {
          "content-type": "application/json",
        },
        body: undefined,
      });
    });

    expect(screen.getByRole("heading", { name: "实体管理" })).toBeInTheDocument();
    expect(screen.getByLabelText("实体排序")).toHaveValue("usage_desc");
    expect(screen.queryByRole("dialog", { name: "治理建议" })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith("/api/admin/settings/entities/suggestions?page=1&pageSize=10", expect.anything());
    expect(screen.getByRole("button", { name: "治理建议" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "清空筛选" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "AI Agent" })).toBeInTheDocument();
    expect(screen.queryByText("ai agent")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "应用筛选" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "AI Agent" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新增别名：AI Agent" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "合并实体：AI Agent" })).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("实体排序"), "updated_desc");
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/settings/entities?sort=updated_desc&page=1&pageSize=10", {
        method: "GET",
        headers: {
          "content-type": "application/json",
        },
        body: undefined,
      });
    });

    await user.click(screen.getByRole("button", { name: "治理建议" }));
    const suggestionDialog = await screen.findByRole("dialog", { name: "治理建议" });
    expect(within(suggestionDialog).getByText("目标实体")).toBeInTheDocument();
    expect(within(suggestionDialog).getByText("AI Agents")).toBeInTheDocument();
    expect(within(suggestionDialog).getByText("AI Agent")).toBeInTheDocument();
    expect(
      within(suggestionDialog).queryByText(
        "系统按名称相似度、别名和内容共现识别可合并实体。合并前需要选择方向；不合并和临时忽略会隐藏当前建议对。",
      ),
    ).not.toBeInTheDocument();
    expect(within(suggestionDialog).getByLabelText("治理建议排序")).toHaveValue("affected_desc");
    expect(within(suggestionDialog).getByRole("button", { name: "选择合并方向：AI Agents" })).toBeInTheDocument();
    expect(within(suggestionDialog).getByRole("button", { name: "处理治理建议：AI Agents" })).toBeInTheDocument();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/settings/entities/suggestions?sort=affected_desc&page=1&pageSize=10", {
        method: "GET",
        headers: {
          "content-type": "application/json",
        },
        body: undefined,
      });
    });

    await user.type(within(suggestionDialog).getByLabelText("治理建议实体筛选"), "Agent");
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/settings/entities/suggestions?search=Agent&sort=affected_desc&page=1&pageSize=10", {
        method: "GET",
        headers: {
          "content-type": "application/json",
        },
        body: undefined,
      });
    });

    await user.selectOptions(within(suggestionDialog).getByLabelText("治理建议排序"), "confidence_desc");
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/settings/entities/suggestions?search=Agent&sort=confidence_desc&page=1&pageSize=10", {
        method: "GET",
        headers: {
          "content-type": "application/json",
        },
        body: undefined,
      });
    });
  });

  it("opens governance suggestions from the initial state", async () => {
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<EntitySettingsPanel initialOpenSuggestions />);

    const suggestionDialog = await screen.findByRole("dialog", { name: "治理建议" });
    expect(within(suggestionDialog).getByLabelText("治理建议实体筛选")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/settings/entities/suggestions?sort=affected_desc&page=1&pageSize=10", {
      body: undefined,
      headers: { "content-type": "application/json" },
      method: "GET",
    });
  });

  it("opens entity detail from the entity name and action modals from operation icons", async () => {
    const user = userEvent.setup();
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<EntitySettingsPanel />);

    await screen.findByRole("button", { name: "AI Agent" });

    await user.click(screen.getByRole("button", { name: "AI Agent" }));
    const manageDialog = screen.getByRole("dialog", { name: "实体详情" });
    expect(within(manageDialog).getByText("基本信息")).toBeInTheDocument();
    expect(within(manageDialog).getByText("已有关联别名")).toBeInTheDocument();
    expect(within(manageDialog).getByText("智能体")).toBeInTheDocument();
    const footerButtons = within(manageDialog).getAllByRole("button").slice(-3).map((button) => button.textContent);
    expect(footerButtons).toEqual(["新增别名", "合并实体", "关闭"]);

    await user.click(within(manageDialog).getByRole("button", { name: "合并实体" }));
    const mergeDialog = screen.getByRole("dialog", { name: "合并实体" });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/settings/entities?page=1&pageSize=100", {
        method: "GET",
        headers: {
          "content-type": "application/json",
        },
        body: undefined,
      });
    });
    expect(within(mergeDialog).getByText("操作说明")).toBeInTheDocument();
    expect(within(mergeDialog).getByRole("button", { name: "确认合并 (0 个)" })).toBeDisabled();
    await user.click(within(mergeDialog).getByText("取消"));

    await user.click(within(manageDialog).getByRole("button", { name: "新增别名" }));
    const aliasAddDialog = screen.getByRole("dialog", { name: "新增别名" });
    expect(within(aliasAddDialog).getByRole("button", { name: "添加别名" })).toBeDisabled();
    await user.click(within(aliasAddDialog).getByText("取消"));
    await user.click(within(manageDialog).getByText("关闭"));

    await user.click(screen.getByRole("button", { name: "新增别名：AI Agent" }));
    expect(screen.getByRole("dialog", { name: "新增别名" })).toBeInTheDocument();
    await user.click(screen.getByText("取消"));

    await user.click(screen.getByRole("button", { name: "合并实体：AI Agent" }));
    expect(screen.getByRole("dialog", { name: "合并实体" })).toBeInTheDocument();
  });

  it("confirms and dismisses entity governance suggestions", async () => {
    const user = userEvent.setup();
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<EntitySettingsPanel />);

    await screen.findByRole("button", { name: "治理建议" });
    await user.click(screen.getByRole("button", { name: "治理建议" }));
    const suggestionDialog = await screen.findByRole("dialog", { name: "治理建议" });

    await user.click(within(suggestionDialog).getByRole("button", { name: "选择合并方向：AI Agents" }));
    const mergeChoiceDialog = screen.getByRole("dialog", { name: "选择合并方向" });
    await user.click(within(mergeChoiceDialog).getByRole("button", { name: "合并到目标" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/settings/entities/merge", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          targetEntityId: "entity-agent",
          sourceEntityIds: ["entity-agents"],
        }),
      });
    });

    await user.click(within(suggestionDialog).getByRole("button", { name: "选择合并方向：AI Agents" }));
    const reverseMergeChoiceDialog = screen.getByRole("dialog", { name: "选择合并方向" });
    await user.click(within(reverseMergeChoiceDialog).getByRole("button", { name: "合并到来源" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/settings/entities/merge", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          targetEntityId: "entity-agents",
          sourceEntityIds: ["entity-agent"],
        }),
      });
    });

    await user.click(within(suggestionDialog).getByRole("button", { name: "处理治理建议：AI Agents" }));
    const dismissChoiceDialog = screen.getByRole("dialog", { name: "处理治理建议" });
    await user.click(within(dismissChoiceDialog).getByRole("button", { name: "临时忽略" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/settings/entities/suggestions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sourceEntityId: "entity-agents",
          targetEntityId: "entity-agent",
          decision: "ignored",
        }),
      });
    });
  });

  it("auto-merges high-confidence governance suggestions", async () => {
    const user = userEvent.setup();
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<EntitySettingsPanel />);

    await screen.findByRole("button", { name: "治理建议" });
    await user.click(screen.getByRole("button", { name: "治理建议" }));
    const suggestionDialog = await screen.findByRole("dialog", { name: "治理建议" });
    await user.click(within(suggestionDialog).getByRole("button", { name: "自动合并高置信" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/settings/entities/suggestions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          action: "auto_merge_high_confidence",
        }),
      });
    });
  });
});
