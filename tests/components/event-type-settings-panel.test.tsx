import type { ReactNode } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EventTypeSettingsPanel, type AdminEventType } from "@/components/admin/event-type-settings-panel";
import { ToastProvider } from "@/components/ui/toast";

function renderWithProviders(node: ReactNode) {
  return render(<ToastProvider>{node}</ToastProvider>);
}

const registryRows: AdminEventType[] = [
  { id: "et-other", key: "other", label: "其他", description: null, aliases: [], enabled: true, sortOrder: 0 },
  { id: "et-finance", key: "finance", label: "财经", description: null, aliases: ["经济数据"], enabled: true, sortOrder: 1 },
];

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function createFetchMock() {
  return vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === "/api/admin/event-types" && (!init?.method || init.method === "GET")) {
      return jsonResponse({ eventTypes: registryRows });
    }
    if (url === "/api/admin/event-types" && init?.method === "POST") {
      const payload = JSON.parse(String(init.body)) as { key?: string | null; label: string };
      return jsonResponse({ eventType: { id: "et-new", key: payload.key ?? "", label: payload.label, description: null, aliases: [], enabled: true, sortOrder: 2 } }, 201);
    }
    return jsonResponse({ error: "未支持的请求" }, 400);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("EventTypeSettingsPanel", () => {
  it("creates a type with a Chinese label and an explicit stable machine key", async () => {
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    renderWithProviders(<EventTypeSettingsPanel />);
    await waitFor(() => expect(screen.getByText("finance")).toBeTruthy());

    await user.click(screen.getByRole("button", { name: "新建" }));
    await user.type(screen.getByLabelText(/Key/), "economic_data");
    await user.type(screen.getByLabelText(/^名称/), "经济数据");
    await user.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/event-types",
      expect.objectContaining({ method: "POST" }),
    ));
    const [, init] = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    const payload = JSON.parse(String(init!.body)) as { key: string | null; label: string };
    // 中文 label 无法派生机器 key；显式 key 必须原样随请求发送。
    expect(payload).toMatchObject({ key: "economic_data", label: "经济数据" });
  });

  it("shows the key as read-only in the edit dialog", async () => {
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    renderWithProviders(<EventTypeSettingsPanel />);
    await waitFor(() => expect(screen.getByText("finance")).toBeTruthy());

    const financeRow = screen.getByText("finance").closest("div.rounded-lg") as HTMLElement;
    await user.click(within(financeRow).getByRole("button", { name: "编辑" }));

    const keyInput = await screen.findByLabelText(/Key/);
    expect((keyInput as HTMLInputElement).value).toBe("finance");
    expect(keyInput as HTMLInputElement).toHaveAttribute("readonly");
    expect(keyInput as HTMLInputElement).toBeDisabled();
  });

  it("hides the other fallback row, keeps no sort controls, and delete goes through the confirm modal", async () => {
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    renderWithProviders(<EventTypeSettingsPanel />);
    await waitFor(() => expect(screen.getByText("finance")).toBeTruthy());

    // other 兕底行不渲染，且面板不再提供任何排序控件。
    expect(screen.queryByText("other")).toBeNull();
    expect(screen.queryByRole("button", { name: "上移" })).toBeNull();
    expect(screen.queryByRole("button", { name: "下移" })).toBeNull();

    const financeRow = screen.getByText("finance").closest("div.rounded-lg") as HTMLElement;
    await user.click(within(financeRow).getByRole("button", { name: "删除" }));

    // 删除走既有确认弹层，而非原生 window.confirm。
    const dialog = await screen.findByText("确认删除事件类型");
    expect(dialog).toBeTruthy();
    expect(screen.getByText(/即将删除事件类型「财经」/)).toBeTruthy();
    const deleteCalls = fetchMock.mock.calls.filter(([input, init]) => String(input).includes("/finance") || init?.method === "DELETE");
    expect(deleteCalls).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByText("确认删除事件类型")).toBeNull();
  });
});
