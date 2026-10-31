import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dailyDetailMock = vi.hoisted(() => ({
  DailyReportDetail: vi.fn(({ report }: { report: unknown }) => (
    <div data-testid="daily-detail">{report ? "report" : "empty-detail"}</div>
  )),
}));

vi.mock("@/components/daily/daily-report-detail", () => ({
  DailyReportDetail: dailyDetailMock.DailyReportDetail,
}));

import { OutsideApp } from "@/components/outside/outside-app";

function jsonResponse(payload: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => payload,
  } as Response;
}
const providers = [
  { id: "xueqiu", name: "雪球", capabilities: { search: true, resolve: true, inputKinds: ["nickname", "id", "url"] } },
  { id: "eastmoney", name: "东方财富", capabilities: { search: false, resolve: true, inputKinds: ["id", "url"] } },
  { id: "wechat", name: "公众号", capabilities: { search: true, resolve: false, inputKinds: ["name"] } },
];

const followsPayload = {
  sources: [{
    id: "source-1",
    name: "示例源",
    siteUrl: "https://example.com",
    enabled: true,
    channel: "雪球",
    originKind: "preset",
    groupName: null,
    healthStatus: "unknown",
    followed: false,
    followedAt: null,
  }],
  channels: ["雪球"],
  followedSourceIds: [],
};

function fetchCallUrls() {
  return (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]));
}

describe("OutsideApp", () => {
  it("预置目录隐藏账号源，我的关注包含两类", async () => {
    const preset = { ...followsPayload.sources[0], followed: true };
    const account = { ...preset, id: "account-1", name: "自定义账号", originKind: "account" };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ sources: [preset, account], channels: ["雪球"], followedSourceIds: [preset.id, account.id] })));
    render(<OutsideApp />);
    expect(await screen.findByText("普通订阅源")).toBeTruthy();
    expect(await screen.findByText("示例源")).toBeTruthy();
    expect(screen.queryByText("自定义账号")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /我的关注/ }));
    expect(await screen.findByText("自定义账号")).toBeTruthy();
    expect(screen.getByText("示例源")).toBeTruthy();
  });

  it("我的关注展示类型并可筛选，保留渠道与总关注数", async () => {
    const preset = { ...followsPayload.sources[0], name: "预置源", followed: true };
    const account = { ...preset, id: "account-1", name: "账号源", originKind: "account", enabled: false, channel: "雪球" };
    const fetchMock = vi.fn(async () => jsonResponse({ sources: [preset, account], channels: ["雪球"], followedSourceIds: [preset.id, account.id] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<OutsideApp />);
    fireEvent.click(screen.getByRole("button", { name: /我的关注/ }));
    const accountRow = (await screen.findByText("账号源")).closest("tr")!;
    const presetRow = screen.getByText("预置源").closest("tr")!;
    expect(within(accountRow).getByText("账号订阅 · 雪球")).toBeTruthy();
    expect(within(accountRow).getByText("停用（不可用）")).toBeTruthy();
    expect(within(presetRow).getByText("预置 RSS")).toBeTruthy();
    expect(within(presetRow).queryByText("雪球")).toBeNull();
    fireEvent.change(screen.getByLabelText("按订阅类型筛选"), { target: { value: "account" } });
    expect(screen.getByText("账号源")).toBeTruthy();
    expect(screen.queryByText("预置源")).toBeNull();
    expect(screen.getByRole("button", { name: /我的关注/ }).textContent).toContain("2");
    fireEvent.change(screen.getByLabelText("按订阅类型筛选"), { target: { value: "preset" } });
    expect(screen.getByText("预置源")).toBeTruthy();
    expect(screen.queryByText("账号源")).toBeNull();
    fireEvent.change(screen.getByLabelText("按订阅类型筛选"), { target: { value: "" } });
    expect(screen.getByText("账号源")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "取消关注" })).toHaveLength(2);
  });

  it("九个普通源直接可见，关注及停用状态在切换后保留", async () => {
    const sources = Array.from({ length: 9 }, (_, index) => ({ ...followsPayload.sources[0], id: `preset-${index}`, name: `旧源${index}`, channel: "其他", followed: index === 0, enabled: index !== 1 }));
    const payload = { sources, channels: ["其他"], followedSourceIds: ["preset-0"] };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.startsWith("/api/outside/daily") ? jsonResponse({ report: null, history: [] }) : jsonResponse(payload)));
    render(<OutsideApp />);
    for (const source of sources) expect(await screen.findByText(source.name)).toBeTruthy();
    expect(within(screen.getByText("旧源0").closest("article")!).getByText("已关注")).toBeTruthy();
    expect(within(screen.getByText("旧源1").closest("article")!).getByText("停用（不可用）")).toBeTruthy();
    expect(screen.getByRole("button", { name: "取消关注 旧源0" })).toBeTruthy();
    expect(screen.queryByLabelText("按渠道筛选")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /我的关注/ }));
    expect(await screen.findByText("旧源0")).toBeTruthy();
    expect(screen.queryByText("旧源1")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "信息源" }));
    expect(within((await screen.findByText("旧源0")).closest("article")!).getByText("已关注")).toBeTruthy();
  });

  it("普通源按名称搜索，切换账号入口保留条件", async () => {
    const sources = ["甲源", "乙源"].map((name, index) => ({ ...followsPayload.sources[0], id: `s${index}`, name, channel: "其他" }));
    const fetchMock = vi.fn(async (url: string) => url === "/api/outside/adapter" ? jsonResponse({ providers }) : jsonResponse({ sources, channels: ["其他"], followedSourceIds: [] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<OutsideApp />);
    expect(await screen.findByText("甲源")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("搜索普通订阅源"), { target: { value: "甲" } });
    expect(screen.queryByText("乙源")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "雪球账号渠道" }));
    expect(screen.getByLabelText("账号名称、ID 或主页链接")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "← 返回信息源" }));
    expect(screen.getByLabelText("搜索普通订阅源")).toHaveValue("甲");
    expect(screen.queryByText("乙源")).toBeNull();
  });

  it("没有普通源时显示空状态并保留账号入口", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/outside/adapter" ? jsonResponse({ providers }) : jsonResponse({ sources: [], channels: [], followedSourceIds: [] })));
    render(<OutsideApp />);
    expect(await screen.findByText("暂无已配置信息源。")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "雪球账号渠道" })).toBeTruthy();
  });

  it("关注的 Adapter 源区分等待采集和上游错误", async () => {
    const source = { ...followsPayload.sources[0], id: "adapter-state", name: "公众号状态", originKind: "account", transport: "adapter", healthStatus: "failed", healthMessage: "无法确认上游授权状态。", followed: true };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/outside/adapter" ? jsonResponse({ providers }) : jsonResponse({ sources: [source], channels: ["公众号"], followedSourceIds: [source.id] })));
    render(<OutsideApp />);
    fireEvent.click(screen.getByRole("button", { name: /我的关注/ }));
    expect(await screen.findByText("无法确认上游授权状态。")).toBeTruthy();
  });

  it("展示雪球候选并仅关注用户选择的 UID", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/outside/adapter" && !init?.body) return jsonResponse({ providers });
      if (url === "/api/outside/adapter") {
        const body = JSON.parse(String(init?.body));
        return body.action === "search"
          ? jsonResponse({ candidates: [{ accountId: "123", name: "用户甲", siteUrl: "https://xueqiu.com/u/123", description: "用户简介", avatarUrl: "https://xavatar.imedao.com/community/avatar.png", followed: true }, { accountId: "456", name: "用户乙", siteUrl: "https://xueqiu.com/u/456" }] })
          : jsonResponse({ source: { id: "new" } });
      }
      return jsonResponse(followsPayload);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<OutsideApp />);
    fireEvent.click(await screen.findByRole("button", { name: "雪球账号渠道" }));
    fireEvent.change(screen.getByLabelText("账号名称、ID 或主页链接"), { target: { value: "用户" } });
    fireEvent.click(screen.getByRole("button", { name: "查找账号" }));
    expect(await screen.findByText("用户甲")).toBeTruthy();
    expect(screen.getByText("用户乙")).toBeTruthy();
    expect(screen.getByText("用户简介")).toBeTruthy();
    expect(screen.getByRole("button", { name: "已关注" })).toBeDisabled();
    expect(screen.getByAltText("").getAttribute("src")).toBe("https://xavatar.imedao.com/community/avatar.png");
    fireEvent.click(screen.getAllByRole("button", { name: "关注" })[0]);
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/outside/adapter" && init?.body && JSON.parse(String(init.body)).account?.accountId === "456")).toBe(true));
  });

  it("东方财富先预览 UID，选择后才关注", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/outside/adapter" && !init?.body) return jsonResponse({ providers });
      if (url === "/api/outside/adapter") {
        const body = JSON.parse(String(init?.body));
        return body.action === "resolve" ? jsonResponse({ candidates: [{ accountId: "2922094262312522", name: "东方财富证券", siteUrl: "https://i.eastmoney.com/2922094262312522", followed: false }] }) : jsonResponse({ source: { id: "new" } });
      }
      return jsonResponse(followsPayload);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<OutsideApp />);
    fireEvent.click(await screen.findByRole("button", { name: "东方财富账号渠道" }));
    fireEvent.change(screen.getByLabelText("账号名称、ID 或主页链接"), { target: { value: "2922094262312522" } });
    fireEvent.click(screen.getByRole("button", { name: "查找账号" }));
    expect(await screen.findByText("东方财富证券")).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([url, init]) => url === "/api/outside/adapter" && init?.body && JSON.parse(String(init.body)).action === "follow")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "关注" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/outside/adapter" && init?.body && JSON.parse(String(init.body)).action === "follow")).toBe(true));
  });

  it("公众号多候选仅提交明确选择，空结果展示授权不确定性", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/outside/adapter" && !init?.body) return jsonResponse({ providers });
      if (url === "/api/outside/adapter") {
        const body = JSON.parse(String(init?.body));
        if (body.action === "follow") return jsonResponse({ source: { id: "new" } });
        return body.query === "空" ? jsonResponse({ error: "无法确认微信授权状态。" }, false) : jsonResponse({ candidates: [{ accountId: "YWJjMTIz", name: "公众号甲" }, { accountId: "ZGVmNDU2", name: "公众号乙" }] });
      }
      return jsonResponse(followsPayload);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<OutsideApp />);
    fireEvent.click(await screen.findByRole("button", { name: "公众号账号渠道" }));
    fireEvent.change(screen.getByLabelText("账号名称、ID 或主页链接"), { target: { value: "财经" } });
    fireEvent.click(screen.getByRole("button", { name: "查找账号" }));
    expect(await screen.findByText("公众号甲")).toBeTruthy();
    expect(screen.getByText("公众号乙")).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/outside/adapter" && init?.body && JSON.parse(String(init.body)).action === "follow")).toBe(false);
    fireEvent.click(screen.getAllByRole("button", { name: "关注" })[1]);
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/outside/adapter" && init?.body && JSON.parse(String(init.body)).account?.accountId === "ZGVmNDU2")).toBe(true));
    await waitFor(() => expect(screen.queryByText("公众号乙")).toBeNull());
    fireEvent.change(screen.getByLabelText("账号名称、ID 或主页链接"), { target: { value: "空" } });
    fireEvent.click(screen.getByRole("button", { name: "查找账号" }));
    expect(await screen.findByText("无法确认微信授权状态。")).toBeTruthy();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/outside/adapter") return jsonResponse({ providers });
      if (url.startsWith("/api/outside/follows")) {
        return jsonResponse(followsPayload);
      }
      return jsonResponse({ report: null, history: [] });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("空日报只请求一次并展示空状态", async () => {
    render(<OutsideApp />);

    fireEvent.click(screen.getByRole("button", { name: "资讯日报" }));
    await waitFor(() => {
      expect(screen.getByText("该日期没有日报")).toBeTruthy();
    });

    await waitFor(() => {
      const dailyCalls = fetchCallUrls().filter((url) => url.startsWith("/api/outside/daily?") );
      expect(dailyCalls).toHaveLength(1);
    });

    // 空历史不应触发额外请求。
    expect(fetchCallUrls().filter((url) => url.startsWith("/api/outside/daily?"))).toHaveLength(1);
  });

  it("切换标签不重复请求日报", async () => {
    render(<OutsideApp />);

    fireEvent.click(screen.getByRole("button", { name: "资讯日报" }));
    await waitFor(() => {
      expect(screen.getByText("该日期没有日报")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "信息源" }));
    fireEvent.click(screen.getByRole("button", { name: "资讯日报" }));

    await waitFor(() => {
      expect(screen.getByText("该日期没有日报")).toBeTruthy();
    });
    expect(fetchCallUrls().filter((url) => url.startsWith("/api/outside/daily?"))).toHaveLength(1);
  });

  it("加载失败可重试", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/outside/follows")) {
        return jsonResponse(followsPayload);
      }
      return jsonResponse({ error: "加载日报失败。" }, false);
    }) as unknown as typeof fetch;

    render(<OutsideApp />);
    fireEvent.click(screen.getByRole("button", { name: "资讯日报" }));
    await waitFor(() => {
      expect(screen.getByText("加载日报失败。")).toBeTruthy();
    });

    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/outside/follows")) {
        return jsonResponse(followsPayload);
      }
      return jsonResponse({ report: null, history: [] });
    });

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => {
      expect(screen.getByText("该日期没有日报")).toBeTruthy();
    });
  });

  it("渲染信息源目录并提供关注操作", async () => {
    render(<OutsideApp />);

    await waitFor(() => {
      expect(screen.getByText("示例源")).toBeTruthy();
    });
    expect(await screen.findByRole("button", { name: "雪球账号渠道" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "关注 示例源" }));
    await waitFor(() => {
      const postCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
        .filter((call) => String(call[0]) === "/api/outside/follows" && call[1]?.method === "POST");
      expect(postCalls).toHaveLength(1);
    });
  });
it("pins light theme variables so the daily detail stays light under dark themes", async () => {
    const report = {
      date: "2026-04-24",
      title: "测试日报",
      status: "published",
      openingSummary: "摘要",
      generatedAt: "2026-04-24T08:00:00.000Z",
      sources: [],
    };
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/outside/follows")) {
        return jsonResponse(followsPayload);
      }
      return jsonResponse({ report, history: [] });
    }) as unknown as typeof fetch;

    render(<OutsideApp />);
    fireEvent.click(screen.getByRole("button", { name: "资讯日报" }));
    await waitFor(() => {
      expect(screen.getByTestId("daily-detail")).toBeTruthy();
    });

    const scope = document.querySelector("[data-light-scope]") as HTMLElement | null;
    expect(scope).not.toBeNull();
    expect(scope?.style.getPropertyValue("--surface")).toBe("#ffffff");
    expect(scope?.style.getPropertyValue("--foreground")).toBe("#111111");
    expect(scope?.style.getPropertyValue("--bg-muted")).toBe("#f1f1f3");
    expect(scope?.style.getPropertyValue("--line")).toBe("#e6e6e8");
    expect(scope?.style.colorScheme).toBe("light");
  });

  it("普通源使用响应式卡片且链接与操作互不嵌套", async () => {
    render(<OutsideApp />);
    const card = (await screen.findByText("示例源")).closest("article")!;
    expect(card.parentElement?.className).toContain("sm:grid-cols-2");
    expect(card.parentElement?.className).toContain("xl:grid-cols-3");
    expect(within(card).getByRole("link", { name: "示例源" }).contains(within(card).getByRole("button", { name: "关注 示例源" }))).toBe(false);
  });
});

it("手动生成选择日期并在运行时隐藏按钮，刷新后恢复状态", async () => {
  let generation: { id: string; date: string; phase: string; status: string; progressLabel: string; error: null } | null = null;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/outside/daily/generate") {
      if (init?.method === "POST") generation = { id: "fetch-1", date: "2026-04-24", phase: "fetch", status: "queued", progressLabel: "准备抓取", error: null };
      return jsonResponse({ generation });
    }
    if (url.startsWith("/api/outside/daily?")) return jsonResponse({ report: null, history: [] });
    if (url === "/api/outside/adapter") return jsonResponse({ providers });
    return jsonResponse(followsPayload);
  });
  vi.stubGlobal("fetch", fetchMock);
  const view = render(<OutsideApp />);
  fireEvent.click(screen.getByRole("button", { name: "资讯日报" }));
  fireEvent.click(await screen.findByRole("button", { name: "生成日报" }));
  fireEvent.change(screen.getByLabelText("日期"), { target: { value: "2026-04-24" } });
  fireEvent.click(screen.getByRole("button", { name: "开始生成" }));
  expect(await screen.findByRole("status")).toHaveTextContent("正在抓取资讯");
  expect(screen.queryByRole("button", { name: "生成日报" })).toBeNull();
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  view.unmount();
  render(<OutsideApp />);
  fireEvent.click(screen.getByRole("button", { name: "资讯日报" }));
  expect(await screen.findByRole("status")).toHaveTextContent("正在抓取资讯");
  expect(screen.queryByRole("button", { name: "生成日报" })).toBeNull();
});

it.each(["running", "succeeded"])("部分抓取失败时在日报%s状态保留告警", async (status) => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/outside/daily/generate") return jsonResponse({ generation: { id: "partial-fetch", date: "2026-04-24", phase: "report", status, progressLabel: null, error: null, fetchWarning: "源 A 获取失败" } });
    if (url.startsWith("/api/outside/daily?")) return jsonResponse({ report: null, history: [] });
    if (url === "/api/outside/adapter") return jsonResponse({ providers });
    return jsonResponse(followsPayload);
  }));
  render(<OutsideApp />);
  fireEvent.click(screen.getByRole("button", { name: "资讯日报" }));
  expect(await screen.findByText(/抓取部分失败，已继续生成日报。/)).toHaveTextContent("源 A 获取失败");
  if (status === "running") expect(screen.getByRole("status")).toHaveTextContent("正在生成日报");
});

it("运行中通知嵌入日报隐藏重新生成入口", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/outside/daily/generate") return jsonResponse({ generation: { id: "active", date: "2026-04-24", phase: "report", status: "running", progressLabel: null, error: null } });
    if (url.startsWith("/api/outside/daily?")) return jsonResponse({ report: { date: "2026-04-24" }, history: [] });
    if (url === "/api/outside/adapter") return jsonResponse({ providers });
    return jsonResponse(followsPayload);
  }));
  render(<OutsideApp />);
  fireEvent.click(screen.getByRole("button", { name: "资讯日报" }));
  await waitFor(() => expect(dailyDetailMock.DailyReportDetail).toHaveBeenLastCalledWith(expect.objectContaining({ hideRegenerate: true }), undefined));
});
