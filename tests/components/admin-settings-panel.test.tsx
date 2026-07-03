import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor, waitForElementToBeRemoved, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

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

import { AdminSettingsPanel } from "@/components/admin/admin-settings-panel";
import { ToastProvider } from "@/components/ui/toast";
import type { AdminSettingsSnapshot } from "@/lib/settings/types";

const originalClipboard = navigator.clipboard;
const originalExecCommand = document.execCommand;

function buildInitialSettings(): AdminSettingsSnapshot {
  return {
    modelApiConfigs: [
      {
        id: "model-1",
        name: "默认模型配置",
        baseUrl: "https://example.com/v1",
        modelName: "gpt-4.1-mini",
        ingestionItemConcurrency: 3,
        customHeaders: {
          "User-Agent": "KimiCLI/1.44",
        },
        apiKeyMasked: "••••••••••••",
        hasApiKey: true,
        isEnabled: true,
        isDefault: true,
        createdAt: "2026-04-20T10:00:00.000Z",
        updatedAt: "2026-04-20T10:00:00.000Z",
      },
    ],
    promptConfigs: [
      {
        id: "prompt-0",
        name: "默认条目摘要提示词",
        type: "item_summary" as const,
        prompt: "标题：{{title}}\n来源：{{sourceName}}\n正文：{{inputText}}",
        systemPrompt: "请总结单条内容。",
        templateJson: null,
        temperature: 0.2,
        maxTokens: 300,
        topP: 1,
        modelApiConfigId: "",
        modelApiConfigName: "默认模型配置",
        isUsingDefaultModel: true,
        isEnabled: true,
        isDefault: true,
        createdAt: "2026-04-20T10:00:00.000Z",
        updatedAt: "2026-04-20T10:00:00.000Z",
      },
      {
        id: "prompt-1",
        name: "默认内容分析提示词",
        type: "item_analysis" as const,
        prompt: "标题：{{title}}\n正文：{{inputText}}",
        systemPrompt: "请分析内容并输出 JSON。",
        templateJson: null,
        temperature: 0.2,
        maxTokens: 900,
        topP: 1,
        modelApiConfigId: "model-1",
        modelApiConfigName: "默认模型配置",
        isUsingDefaultModel: false,
        isEnabled: true,
        isDefault: true,
        createdAt: "2026-04-20T10:00:00.000Z",
        updatedAt: "2026-04-20T10:00:00.000Z",
      },
      {
        id: "prompt-2",
        name: "默认聚合拆分提示词",
        type: "item_aggregation" as const,
        prompt: "标题：{{title}}\n来源：{{sourceName}}\n正文：{{inputText}}",
        systemPrompt: "请拆分聚合信息并输出 JSON。",
        templateJson: null,
        temperature: 0,
        maxTokens: 8000,
        topP: null,
        modelApiConfigId: null,
        modelApiConfigName: null,
        isUsingDefaultModel: true,
        isEnabled: true,
        isDefault: true,
        createdAt: "2026-04-20T10:00:00.000Z",
        updatedAt: "2026-04-20T10:00:00.000Z",
      },
    ],
    eventBriefing: {
      config: {
        id: "event-briefing-config",
        minRankScore: 0,
        createdAt: "2026-04-20T10:00:00.000Z",
        updatedAt: "2026-04-20T10:00:00.000Z",
      },
      preference: {
        id: "briefing-preference-config",
        weightedRules: [],
        maxCuratorBoost: 15,
        maxCuratorPenalty: 20,
        createdAt: "2026-04-20T10:00:00.000Z",
        updatedAt: "2026-04-20T10:00:00.000Z",
      },
    },
    contentExtraction: {
      id: "content-extraction-1",
      jinaEnabled: false,
      jinaBaseUrl: "https://r.jina.ai/",
      jinaApiKeyMasked: "",
      hasJinaApiKey: false,
      timeoutMs: 15000,
      concurrency: 1,
      rpmLimit: 10,
      maxPerRun: 20,
      minChars: 500,
      maxChars: 32000,
      createdAt: "2026-04-20T10:00:00.000Z",
      updatedAt: "2026-04-20T10:00:00.000Z",
    },
    blacklistKeywords: ["layoffs"],
    taskSchedule: {
      key: "ingestion_default",
      enabled: true,
      cronExpression: "0 * * * *",
      sourceConcurrency: 2,
      fullTextFetchThreshold: 80,
      perSourceItemLimit: 20,
      aggregationSplitMaxEvents: 20,
      dailyReportCandidateLimit: 120,
      dailyReportOffsetDays: 0,
      dailyReportAutoPublish: false,
      dailyReportMaxRetries: 0,
      dailyReportGroupIds: [],
      timezone: "Asia/Shanghai",
      lastHeartbeatAt: "2026-04-20T10:00:00.000Z",
      lastRunStartedAt: "2026-04-20T10:00:00.000Z",
      lastRunFinishedAt: "2026-04-20T10:05:00.000Z",
      lastRunStatus: "succeeded" as const,
      nextRunAt: "2026-04-20T11:00:00.000Z",
      cleanupRetentionDays: 365,
      isHeartbeatStale: false,
    },
    dailyReportSchedule: {
      key: "daily_report_default",
      enabled: false,
      cronExpression: "30 8 * * *",
      sourceConcurrency: 2,
      fullTextFetchThreshold: 80,
      perSourceItemLimit: 20,
      aggregationSplitMaxEvents: 20,
      dailyReportCandidateLimit: 120,
      dailyReportOffsetDays: 0,
      dailyReportAutoPublish: false,
      dailyReportMaxRetries: 0,
      dailyReportGroupIds: [],
      timezone: "Asia/Shanghai",
      lastHeartbeatAt: "2026-04-20T10:00:00.000Z",
      lastRunStartedAt: null,
      lastRunFinishedAt: null,
      lastRunStatus: null,
      nextRunAt: "2026-04-21T00:30:00.000Z",
      cleanupRetentionDays: 365,
      isHeartbeatStale: false,
    },
    itemCleanupSchedule: {
      key: "item_cleanup_default",
      enabled: false,
      cronExpression: "0 3 * * *",
      cleanupRetentionDays: 365,
      timezone: "Asia/Shanghai",
      lastHeartbeatAt: null,
      lastRunStartedAt: null,
      lastRunFinishedAt: null,
      lastRunStatus: null,
      nextRunAt: "2026-04-22T03:00:00.000Z",
      isHeartbeatStale: false,
    },
    groups: [{ id: "group-1", name: "Core", color: "#3b82f6", sortOrder: 0 }],
    sources: [
      {
        id: "source-1",
        name: "Existing Source",
        rssUrl: "https://example.com/feed.xml",
        siteUrl: "https://example.com",
        enabled: true,
        aiParsingEnabled: true,
        aggregationEnabled: true, aggregationDetectionEnabled: false,
        groupId: "group-1",
        groupName: "Core",
        lastItemCreatedAt: "2026-04-20T10:00:00.000Z",
      },
    ],
  };
}

afterEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: originalClipboard,
  });
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: originalExecCommand,
  });
  window.history.replaceState(null, "", "/");
  pushMock.mockReset();
  refreshMock.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderWithProviders(node: ReactNode) {
  return render(<ToastProvider>{node}</ToastProvider>);
}

type AdminSourceFixture = AdminSettingsSnapshot["sources"][number];

function getFetchUrl(input: RequestInfo | URL) {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof Request) {
    return input.url;
  }

  return input.toString();
}

function filterSourceFixtures(sources: AdminSourceFixture[], searchParams: URLSearchParams) {
  const search = searchParams.get("search")?.trim().toLowerCase() ?? "";
  const groupId = searchParams.get("groupId") ?? "";
  const enabled = searchParams.get("enabled") ?? "";
  const normalizedEnabled =
    enabled === "enabled" ? "true" : enabled === "disabled" ? "false" : enabled;

  return sources.filter((source) => {
    if (
      search &&
      ![
        source.name,
        source.rssUrl,
        source.siteUrl,
        source.groupName ?? "未分组",
      ].some((value) => value.toLowerCase().includes(search))
    ) {
      return false;
    }

    if (groupId === "__ungrouped__" && source.groupId !== null) {
      return false;
    }
    if (groupId && groupId !== "__ungrouped__" && source.groupId !== groupId) {
      return false;
    }
    if (normalizedEnabled === "true" && !source.enabled) {
      return false;
    }
    if (normalizedEnabled === "false" && source.enabled) {
      return false;
    }

    return true;
  });
}

function createSourceSettingsFetchMock(
  sources: AdminSourceFixture[],
  handler?: (url: string, init?: RequestInit) => Response | undefined | Promise<Response | undefined>,
) {
  return vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = getFetchUrl(input);
    const method = init?.method ?? "GET";
    const parsedUrl = new URL(url, "http://localhost");

    if (method === "GET" && parsedUrl.pathname === "/api/admin/settings/sources") {
      const page = Math.max(1, Number(parsedUrl.searchParams.get("page")) || 1);
      const pageSize = Math.min(1000, Math.max(1, Number(parsedUrl.searchParams.get("pageSize")) || 10));
      const filteredSources = filterSourceFixtures(sources, parsedUrl.searchParams);
      const totalPages = Math.max(1, Math.ceil(filteredSources.length / pageSize));
      const safePage = Math.min(page, totalPages);
      const start = (safePage - 1) * pageSize;

      return new Response(
        JSON.stringify({
          sources: filteredSources.slice(start, start + pageSize),
          total: filteredSources.length,
          totalPages,
          page: safePage,
          pageSize,
        }),
      );
    }

    const handled = await handler?.(url, init);
    return handled ?? new Response(JSON.stringify({ ok: true }));
  });
}

describe("AdminSettingsPanel", () => {
  it("renders new AI tabs and defaults to model api without the basic tab", () => {
    renderWithProviders(<AdminSettingsPanel initialSettings={buildInitialSettings()} />);

    const settingsNav = screen.getByRole("complementary", { name: "设置导航" });

    expect(within(settingsNav).queryByRole("tab", { name: "基础配置" })).not.toBeInTheDocument();
    expect(within(settingsNav).getByRole("tab", { name: "模型API" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(within(settingsNav).getByRole("tab", { name: "提示词" })).toBeInTheDocument();
    expect(within(settingsNav).getByRole("tab", { name: "采集任务" })).toBeInTheDocument();
    expect(screen.getByText("模型API配置")).toBeInTheDocument();
    expect(screen.getAllByText("默认模型配置").length).toBeGreaterThan(0);
    expect(screen.getByText("抓取并发：")).toBeInTheDocument();
  });

  it("creates a configured header link from the navigation settings section", async () => {
    const user = userEvent.setup();
    const fetchMock = createSourceSettingsFetchMock(buildInitialSettings().sources, (url, init) => {
      const parsedUrl = new URL(url, "http://localhost");

      if (init?.method === "POST" && parsedUrl.pathname === "/api/admin/settings/header-links") {
        return new Response(
          JSON.stringify({
            link: {
              id: "header-link-aff",
              label: "AFF",
              url: "https://shawnxie.top/aff/",
              enabled: true,
              sortOrder: 0,
              openInNewTab: true,
              rel: "sponsored noopener noreferrer",
              createdAt: "2026-06-28T00:00:00.000Z",
              updatedAt: "2026-06-28T00:00:00.000Z",
            },
          }),
          { status: 201 },
        );
      }

      return undefined;
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(
      <AdminSettingsPanel
        initialSettings={{ ...buildInitialSettings(), headerLinks: [] }}
        activeSection="header-links"
        embedMode
      />,
    );

    await user.click(screen.getAllByRole("button", { name: /新增链接/ })[0]);
    await user.type(screen.getByLabelText("名称"), "AFF");
    await user.type(screen.getByLabelText("URL"), "https://shawnxie.top/aff/");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(screen.getByText("AFF")).toBeInTheDocument();
    });
    expect(screen.getByRole("link", { name: "https://shawnxie.top/aff/" })).toHaveAttribute(
      "href",
      "https://shawnxie.top/aff/",
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/settings/header-links", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        label: "AFF",
        url: "https://shawnxie.top/aff/",
        enabled: true,
        sortOrder: 0,
        openInNewTab: true,
        rel: "sponsored noopener noreferrer",
      }),
    });
  });

  it("renders header link cards with drag handles instead of move buttons", () => {
    renderWithProviders(
      <AdminSettingsPanel
        initialSettings={{
          ...buildInitialSettings(),
          headerLinks: [
            {
              id: "header-link-aff",
              label: "AFF",
              url: "https://shawnxie.top/aff/",
              enabled: true,
              sortOrder: 0,
              openInNewTab: true,
              rel: "sponsored noopener noreferrer",
              createdAt: "2026-06-28T00:00:00.000Z",
              updatedAt: "2026-06-28T00:00:00.000Z",
            },
          ],
        }}
        activeSection="header-links"
        embedMode
      />,
    );

    expect(screen.getByText("导航栏配置")).toBeInTheDocument();
    expect(screen.getByText("新窗口")).toBeInTheDocument();
    expect(screen.getByText("AFF/赞助")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "拖动排序" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "上移" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "下移" })).not.toBeInTheDocument();
    expect(screen.queryByText(/rel="/)).not.toBeInTheDocument();
  });

  it("switches to prompt settings from the sidebar tabs", async () => {
    const user = userEvent.setup();

    renderWithProviders(<AdminSettingsPanel initialSettings={buildInitialSettings()} />);

    await user.click(screen.getByRole("tab", { name: "提示词" }));

    expect(screen.getByText("提示词配置")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "条目摘要" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "聚合拆分" })).toBeInTheDocument();
    // 切换到"内容分析"标签页以查看内容分析类提示词
    await user.click(screen.getByRole("button", { name: "内容分析" }));
    expect(screen.getByText("默认内容分析提示词")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "预览" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "复制" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "聚合拆分" }));
    expect(screen.getByText("默认聚合拆分提示词")).toBeInTheDocument();
  });

  it("disables deleting default model and prompt configs", async () => {
    const user = userEvent.setup();

    renderWithProviders(<AdminSettingsPanel initialSettings={buildInitialSettings()} />);

    const modelDeleteButton = screen.getByRole("button", { name: "默认配置不可删除" });
    expect(modelDeleteButton).toBeDisabled();

    await user.click(screen.getByRole("tab", { name: "提示词" }));

    const promptDeleteButton = screen.getByRole("button", { name: "默认配置不可删除" });
    expect(promptDeleteButton).toBeDisabled();
  });

  it("creates a model config with ingestion concurrency from the model api page", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          config: {
            id: "model-2",
            name: "新的模型配置",
            baseUrl: "https://example.com/v1",
            modelName: "gpt-4.1",
            ingestionItemConcurrency: 4,
            apiKeyMasked: "••••••••••••",
            hasApiKey: true,
            isEnabled: true,
            isDefault: false,
            createdAt: "2026-04-20T11:00:00.000Z",
            updatedAt: "2026-04-20T11:00:00.000Z",
          },
        }),
      ),
    );

    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<AdminSettingsPanel initialSettings={buildInitialSettings()} />);

    await user.click(screen.getByRole("button", { name: /\+ 创建配置/i }));
    await user.clear(screen.getByLabelText(/配置名称/));
    await user.type(screen.getByLabelText(/配置名称/), "新的模型配置");
    await user.clear(screen.getByLabelText(/API密钥/));
    await user.type(screen.getByLabelText(/API密钥/), "sk-test-9876");
    await user.clear(screen.getByLabelText(/抓取并发数/));
    await user.type(screen.getByLabelText(/抓取并发数/), "4");
    await user.click(screen.getByRole("button", { name: "添加请求头" }));
    await user.type(screen.getByLabelText("请求头名称 1"), "User-Agent");
    await user.type(screen.getByLabelText("请求头值 1"), "KimiCLI/1.44");
    await user.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/settings/model-api-configs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "新的模型配置",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-test-9876",
          apiKeyMode: "replace",
          modelName: "gpt-4.1-mini",
          ingestionItemConcurrency: 4,
          customHeaders: {
            "User-Agent": "KimiCLI/1.44",
          },
          isEnabled: true,
          isDefault: false,
        }),
      });
    });
  });

  it("fetches model options with unsaved custom headers", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          models: ["moonshot-v1"],
        }),
      ),
    );

    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<AdminSettingsPanel initialSettings={buildInitialSettings()} />);

    await user.click(screen.getByRole("button", { name: /\+ 创建配置/i }));
    await user.clear(screen.getByLabelText(/API密钥/));
    await user.type(screen.getByLabelText(/API密钥/), "sk-test-9876");
    await user.click(screen.getByRole("button", { name: "添加请求头" }));
    await user.type(screen.getByLabelText("请求头名称 1"), "User-Agent");
    await user.type(screen.getByLabelText("请求头值 1"), "KimiCLI/1.44");
    await user.click(screen.getByTitle("拉取模型"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/settings/model-api-configs/models", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-test-9876",
          apiKeyMode: "replace",
          customHeaders: {
            "User-Agent": "KimiCLI/1.44",
          },
        }),
      });
    });
  });

  it("edits model config concurrency from the model api modal", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ...buildInitialSettings().modelApiConfigs[0],
            apiKeyRaw: "sk-test-1234",
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            config: {
              ...buildInitialSettings().modelApiConfigs[0],
              ingestionItemConcurrency: 5,
            },
          }),
        ),
      );

    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<AdminSettingsPanel initialSettings={buildInitialSettings()} />);

    await user.click(screen.getByTitle("编辑"));
    await user.clear(screen.getByLabelText(/抓取并发数/));
    await user.type(screen.getByLabelText(/抓取并发数/), "5");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/admin/settings/model-api-configs/model-1", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "默认模型配置",
          baseUrl: "https://example.com/v1",
          apiKey: "",
          apiKeyMode: "keep",
          modelName: "gpt-4.1-mini",
          ingestionItemConcurrency: 5,
          customHeaders: {
            "User-Agent": "KimiCLI/1.44",
          },
          isEnabled: true,
          isDefault: true,
        }),
      });
    });
  });

  it("masks custom header values in the model config list", () => {
    renderWithProviders(<AdminSettingsPanel initialSettings={buildInitialSettings()} />);

    expect(screen.getByText("User-Agent: ••••••••")).toBeInTheDocument();
    expect(screen.queryByText("KimiCLI/1.44")).not.toBeInTheDocument();
  });

  it("copies the raw model api key from the edit modal", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn<Clipboard["writeText"]>().mockResolvedValue(undefined);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ...buildInitialSettings().modelApiConfigs[0],
          apiKeyRaw: "sk-test-1234",
        }),
      ),
    );

    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<AdminSettingsPanel initialSettings={buildInitialSettings()} />);

    await user.click(screen.getByTitle("编辑"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/settings/model-api-configs/model-1", {
        method: "GET",
      });
    });

    await waitFor(() => {
      expect(screen.getByTitle("复制")).not.toBeDisabled();
    });

    await user.click(screen.getByTitle("复制"));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("sk-test-1234");
    });
  });

  it("falls back when the clipboard api cannot copy the model api key", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn<Clipboard["writeText"]>().mockRejectedValue(new Error("denied"));
    const execCommand = vi.fn<(commandId: string) => boolean>(() => {
      expect(document.querySelector("textarea")).toHaveValue("sk-test-1234");
      return true;
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ...buildInitialSettings().modelApiConfigs[0],
          apiKeyRaw: "sk-test-1234",
        }),
      ),
    );

    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<AdminSettingsPanel initialSettings={buildInitialSettings()} />);

    await user.click(screen.getByTitle("编辑"));

    await waitFor(() => {
      expect(screen.getByTitle("复制")).not.toBeDisabled();
    });

    await user.click(screen.getByTitle("复制"));

    await waitFor(() => {
      expect(execCommand).toHaveBeenCalledWith("copy");
    });
  });

  it("creates a prompt config from the prompt section", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          config: {
            id: "prompt-2",
            name: "新的聚合摘要提示词",
            type: "cluster_summary",
            prompt: "主题：{{title}}",
            systemPrompt: "总结多条内容",
            templateJson: null,
            temperature: null,
            maxTokens: null,
            topP: null,
            modelApiConfigId: null,
            modelApiConfigName: null,
            isEnabled: true,
            isDefault: false,
            createdAt: "2026-04-20T11:00:00.000Z",
            updatedAt: "2026-04-20T11:00:00.000Z",
          },
        }),
      ),
    );

    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<AdminSettingsPanel initialSettings={buildInitialSettings()} />);

    await user.click(screen.getByRole("tab", { name: "提示词" }));
    await user.click(screen.getByRole("button", { name: "条目摘要" }));
    await user.click(screen.getAllByRole("button", { name: /创建配置/i })[0]);
    await user.clear(screen.getByLabelText(/配置名称/));
    await user.type(screen.getByLabelText(/配置名称/), "新的条目摘要提示词");
    await user.clear(screen.getByLabelText(/系统提示词/));
    await user.type(screen.getByLabelText(/系统提示词/), "总结单条内容");
    fireEvent.change(screen.getByLabelText(/提示词模板/), {
      target: { value: "标题：{{title}}\n来源：{{sourceName}}\n正文：{{inputText}}" },
    });
    await user.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/settings/prompt-configs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "新的条目摘要提示词",
          type: "item_summary",
          prompt: "标题：{{title}}\n来源：{{sourceName}}\n正文：{{inputText}}",
          systemPrompt: "总结单条内容",
          templateJson: null,
          temperature: null,
          maxTokens: null,
          topP: null,
          modelApiConfigId: null,
          isEnabled: true,
          isDefault: false,
        }),
      });
    });
  });

  it("shows the real placeholders for prompt types with custom input variables", async () => {
    const user = userEvent.setup();

    renderWithProviders(
      <AdminSettingsPanel
        initialSettings={buildInitialSettings()}
        activeSection="ai-prompt"
        initialPromptType="cluster_merge"
      />,
    );

    await user.click(screen.getAllByRole("button", { name: /创建配置/i })[0]);
    let dialog = screen.getByRole("dialog", { name: "创建新提示词配置" });
    expect(within(dialog).getByText(/可使用占位符：\s+\{\{clustersJson\}\}/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "取消" }));

    await user.click(screen.getByRole("button", { name: "聚合拆分" }));
    await user.click(screen.getAllByRole("button", { name: /创建配置/i })[0]);
    dialog = screen.getByRole("dialog", { name: "创建新提示词配置" });
    expect(within(dialog).getByText(/可使用占位符：\s+\{\{title\}\} \/ \{\{sourceName\}\} \/ \{\{inputText\}\}/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "取消" }));

    await user.click(screen.getByRole("button", { name: "AI 日报" }));
    await user.click(screen.getAllByRole("button", { name: /创建配置/i })[0]);
    dialog = screen.getByRole("dialog", { name: "创建新提示词配置" });
    expect(within(dialog).getByText(/可使用占位符：\s+\{\{date\}\} \/ \{\{timezone\}\} \/ \{\{articlesJson\}\} \/ \{\{recentTopicsJson\}\}/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText("标题规则")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("历史主题去重规则")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
  });

  it("keeps prompt advanced settings collapsed and reorders daily report blocks by drag", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          config: {
            id: "prompt-daily",
            name: "日报拖拽测试",
            type: "daily_report",
            prompt: "日期：{{date}}\n候选内容 JSON：{{articlesJson}}",
            systemPrompt: "compiled",
            templateJson: "{}",
            temperature: null,
            maxTokens: null,
            topP: null,
            modelApiConfigId: null,
            modelApiConfigName: null,
            isUsingDefaultModel: true,
            isEnabled: true,
            isDefault: false,
            createdAt: "2026-04-20T11:00:00.000Z",
            updatedAt: "2026-04-20T11:00:00.000Z",
          },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(
      <AdminSettingsPanel
        initialSettings={buildInitialSettings()}
        activeSection="ai-prompt"
        initialPromptType="daily_report"
      />,
    );

    await user.click(screen.getAllByRole("button", { name: /创建配置/i })[0]);
    const dialog = screen.getByRole("dialog", { name: "创建新提示词配置" });

    expect(within(dialog).queryByLabelText("温度")).not.toBeInTheDocument();

    const dragHandles = within(dialog).getAllByTitle("拖动调整顺序");
    const dataTransfer = {
      effectAllowed: "",
      setData: vi.fn(),
    };
    fireEvent.dragStart(dragHandles[dragHandles.length - 1], { dataTransfer });
    fireEvent.dragOver(dragHandles[0], { dataTransfer });
    fireEvent.drop(dragHandles[0], { dataTransfer });

    await user.clear(within(dialog).getByLabelText(/配置名称/));
    await user.type(within(dialog).getByLabelText(/配置名称/), "日报拖拽测试");
    fireEvent.change(within(dialog).getByLabelText(/提示词模板/), {
      target: { value: "日期：{{date}}\n候选内容 JSON：{{articlesJson}}" },
    });
    await user.click(within(dialog).getByRole("button", { name: "创建" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/settings/prompt-configs", expect.any(Object));
    });
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const payload = JSON.parse(String(request.body)) as { templateJson: string };
    const template = JSON.parse(payload.templateJson) as {
      headlineInstruction: string;
      recentTopicRules: string[];
      blocks: Array<{ title: string }>;
    };
    expect(template.headlineInstruction).toContain("热点事件");
    expect(template.recentTopicRules[0]).toContain("最近 7 天已写主题");
    expect(template.blocks[0].title).toBe("趋势观察");
  });

  it("confirms before deleting a daily report content block", async () => {
    const user = userEvent.setup();

    renderWithProviders(
      <AdminSettingsPanel
        initialSettings={buildInitialSettings()}
        activeSection="ai-prompt"
        initialPromptType="daily_report"
      />,
    );

    await user.click(screen.getAllByRole("button", { name: /创建配置/i })[0]);
    const dialog = screen.getByRole("dialog", { name: "创建新提示词配置" });

    expect(within(dialog).getByRole("button", { name: "摘要单段内容收起" })).toBeInTheDocument();

    await user.click(within(dialog).getAllByTitle("删除内容块")[0]);
    const confirmDialog = screen.getByRole("dialog", { name: "删除内容块" });
    expect(within(confirmDialog).getByText("确定要删除「摘要」吗？删除后需要重新添加并配置。")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "摘要单段内容收起" })).toBeInTheDocument();

    await user.click(within(confirmDialog).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog", { name: "删除内容块" })).not.toBeInTheDocument();

    await user.click(within(dialog).getAllByTitle("删除内容块")[0]);
    await user.click(within(screen.getByRole("dialog", { name: "删除内容块" })).getByRole("button", { name: "删除" }));

    expect(within(dialog).queryByRole("button", { name: "摘要单段内容收起" })).not.toBeInTheDocument();
  });

  it("keeps prompt advanced settings collapsed when editing existing configs", async () => {
    const user = userEvent.setup();

    renderWithProviders(
      <AdminSettingsPanel
        initialSettings={buildInitialSettings()}
        activeSection="ai-prompt"
        initialPromptType="item_summary"
      />,
    );

    await user.click(screen.getByTitle("编辑"));
    const dialog = screen.getByRole("dialog", { name: "编辑提示词配置" });

    expect(within(dialog).queryByLabelText("温度")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /高级设置（可选）/ })).toBeInTheDocument();
  });

  it("uses the normalized RSS URL returned by resolve when creating a source", async () => {
    const user = userEvent.setup();
    const refreshSpy = vi.fn();
    const fetchMock = createSourceSettingsFetchMock([], (url) => {
      if (url === "/api/admin/settings/sources/resolve") {
        return new Response(
          JSON.stringify({
            source: {
              name: "Resolved Feed",
              rssUrl: "https://feeds.example.com/normalized.xml",
              siteUrl: "https://feeds.example.com",
              suggestedAiParsingEnabled: false,
            },
          }),
        );
      }

      return undefined;
    });

    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(
      <AdminSettingsPanel
        onRefresh={refreshSpy}
        initialSettings={{ ...buildInitialSettings(), blacklistKeywords: [], sources: [] }}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "信息源" }));
    await user.click(screen.getByRole("button", { name: "新建信息源" }));
    await user.type(screen.getByLabelText("RSS URL"), "https://feeds.example.com/feed.xml?raw=1");
    await user.click(screen.getByRole("button", { name: "自动填充" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/settings/sources/resolve", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          rssUrl: "https://feeds.example.com/feed.xml?raw=1",
        }),
      });
    });

    await user.selectOptions(screen.getByLabelText("所属分组"), "group-1");
    await user.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/settings/sources", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "Resolved Feed",
          rssUrl: "https://feeds.example.com/normalized.xml",
          siteUrl: "https://feeds.example.com",
          enabled: true,
          aiParsingEnabled: false,
          aggregationEnabled: true, aggregationDetectionEnabled: false,
          groupId: "group-1",
        }),
      });
    });

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "新建信息源" })).not.toBeInTheDocument();
    });
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("filters the source list by name, group and enabled status", async () => {
    const user = userEvent.setup();
    const sources = [
      buildInitialSettings().sources[0],
      {
        id: "source-2",
        name: "Infra Feed",
        rssUrl: "https://infra.example.com/rss.xml",
        siteUrl: "https://infra.example.com",
        enabled: false,
        aiParsingEnabled: false,
        aggregationEnabled: false, aggregationDetectionEnabled: false,
        groupId: null,
        groupName: null,
        lastItemCreatedAt: null,
      },
    ];
    const fetchMock = createSourceSettingsFetchMock(sources);
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(
      <AdminSettingsPanel
        initialSettings={{
          ...buildInitialSettings(),
          sources,
        }}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "信息源" }));
    const sourcesPanel = screen.getByRole("tabpanel");

    expect(await screen.findByText("Existing Source")).toBeInTheDocument();
    expect(screen.getByText("Infra Feed")).toBeInTheDocument();
    expect(screen.queryByText("https://example.com/feed.xml")).not.toBeInTheDocument();
    expect(screen.queryByText("ID：source-1")).not.toBeInTheDocument();
    expect(within(sourcesPanel).getByText("站点信息")).toBeInTheDocument();

    await user.type(within(sourcesPanel).getByLabelText("RSS源名称"), "Infra");
    await waitFor(() => {
      expect(screen.queryByText("Existing Source")).not.toBeInTheDocument();
      expect(screen.getByText("Infra Feed")).toBeInTheDocument();
    });

    await user.clear(within(sourcesPanel).getByLabelText("RSS源名称"));
    await user.selectOptions(within(sourcesPanel).getByLabelText("是否启用"), "true");
    await waitFor(() => {
      expect(screen.getByText("Existing Source")).toBeInTheDocument();
      expect(screen.queryByText("Infra Feed")).not.toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/settings/sources?page=1&pageSize=10&enabled=true",
    );

    await user.selectOptions(within(sourcesPanel).getByLabelText("分组"), "__ungrouped__");
    await waitFor(() => {
      expect(screen.queryByText("Existing Source")).not.toBeInTheDocument();
    });
  });

  it("refreshes the current source query after editing a source", async () => {
    const user = userEvent.setup();
    const refreshSpy = vi.fn();
    const sources = [
      buildInitialSettings().sources[0],
      {
        id: "source-2",
        name: "Infra Feed",
        rssUrl: "https://infra.example.com/rss.xml",
        siteUrl: "https://infra.example.com",
        enabled: false,
        aiParsingEnabled: false,
        aggregationEnabled: false, aggregationDetectionEnabled: false,
        groupId: null,
        groupName: null,
        lastItemCreatedAt: null,
      },
    ];
    const fetchMock = createSourceSettingsFetchMock(sources);
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(
      <AdminSettingsPanel
        onRefresh={refreshSpy}
        initialSettings={{
          ...buildInitialSettings(),
          sources,
        }}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "信息源" }));
    const sourcesPanel = screen.getByRole("tabpanel");
    await user.type(within(sourcesPanel).getByLabelText("RSS源名称"), "Infra");
    await user.selectOptions(within(sourcesPanel).getByLabelText("是否启用"), "false");

    await waitFor(() => {
      expect(screen.getByText("Infra Feed")).toBeInTheDocument();
      expect(screen.queryByText("Existing Source")).not.toBeInTheDocument();
    });

    await user.click(within(sourcesPanel).getByTitle("编辑"));
    const dialog = screen.getByRole("dialog", { name: "编辑信息源" });
    await user.clear(within(dialog).getByLabelText("名称"));
    await user.type(within(dialog).getByLabelText("名称"), "Infra Feed Updated");
    await user.click(within(dialog).getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/settings/sources/source-2", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "Infra Feed Updated",
          rssUrl: "https://infra.example.com/rss.xml",
          siteUrl: "https://infra.example.com",
          enabled: false,
          aiParsingEnabled: false,
          aggregationEnabled: false, aggregationDetectionEnabled: false,
          groupId: null,
        }),
      });
    });

    await waitFor(() => {
      const sourceListFetchUrls = fetchMock.mock.calls
        .filter(([input, init]) => {
          const parsedUrl = new URL(getFetchUrl(input), "http://localhost");
          return (init?.method ?? "GET") === "GET" && parsedUrl.pathname === "/api/admin/settings/sources";
        })
        .map(([input]) => getFetchUrl(input));
      expect(sourceListFetchUrls[sourceListFetchUrls.length - 1]).toBe(
        "/api/admin/settings/sources?page=1&pageSize=10&search=Infra&enabled=false",
      );
    });
    expect(screen.queryByRole("dialog", { name: "编辑信息源" })).not.toBeInTheDocument();
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("exports OPML with source status and AI parsing metadata", async () => {
    const user = userEvent.setup();
    const createObjectUrl = vi.fn<(object: Blob | MediaSource) => string>(() => "blob:opml");
    const revokeObjectUrl = vi.fn();
    const click = vi.fn();
    const appendChild = vi.spyOn(document.body, "appendChild");

    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectUrl,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectUrl,
    });

    vi.stubGlobal("fetch", createSourceSettingsFetchMock(buildInitialSettings().sources));

    renderWithProviders(<AdminSettingsPanel initialSettings={buildInitialSettings()} />);

    const createElement = vi.spyOn(document, "createElement");
    createElement.mockImplementation((tagName: string, options?: ElementCreationOptions) => {
      const element = document.createElementNS("http://www.w3.org/1999/xhtml", tagName) as HTMLElement;
      if (tagName === "a") {
        Object.defineProperty(element, "click", { value: click });
      }
      return options ? (document.createElementNS("http://www.w3.org/1999/xhtml", tagName, options) as HTMLElement) : element;
    });

    await user.click(screen.getByRole("tab", { name: "信息源" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "导出 OPML" })).not.toBeDisabled();
    });
    await user.click(screen.getByRole("button", { name: "导出 OPML" }));

    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    const blob = createObjectUrl.mock.calls[0][0] as Blob;
    const text = await blob.text();

    expect(text).toContain('xmlns:infinitum="https://infinitum.app/opml"');
    expect(text).toContain('infinitum:enabled="true"');
    expect(text).toContain('infinitum:aiParsingEnabled="true"');
    expect(text).toContain('infinitum:aggregationEnabled="true"');
    expect(appendChild).toHaveBeenCalled();
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:opml");
  });

  it("requires confirmation before deleting a source", async () => {
    const user = userEvent.setup();
    const refreshSpy = vi.fn();
    const fetchMock = createSourceSettingsFetchMock(buildInitialSettings().sources);

    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(
      <AdminSettingsPanel onRefresh={refreshSpy} initialSettings={buildInitialSettings()} />,
    );

    await user.click(screen.getByRole("tab", { name: "信息源" }));

    const sourcesPanel = screen.getByRole("tabpanel");
    await user.click(within(sourcesPanel).getByTitle("删除"));

    const deleteDialog = screen.getByRole("dialog", { name: "确认删除信息源" });
    expect(within(deleteDialog).getByText(/Existing Source/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/admin/settings/sources/source-1",
      expect.objectContaining({ method: "DELETE" }),
    );

    await user.click(within(deleteDialog).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog", { name: "确认删除信息源" })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/admin/settings/sources/source-1",
      expect.objectContaining({ method: "DELETE" }),
    );

    await user.click(within(sourcesPanel).getByTitle("删除"));
    await user.click(
      within(screen.getByRole("dialog", { name: "确认删除信息源" })).getByRole("button", {
        name: "确认删除",
      }),
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/settings/sources/source-1", {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
    });

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "确认删除信息源" })).not.toBeInTheDocument();
    });
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("renders the Lumina-like group management list and creates a group from the header action", async () => {
    const user = userEvent.setup();
    const refreshSpy = vi.fn();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(
      <AdminSettingsPanel onRefresh={refreshSpy} initialSettings={buildInitialSettings()} />,
    );

    await user.click(screen.getByRole("tab", { name: "分组" }));

    const groupsPanel = screen.getByRole("tabpanel");

    expect(within(groupsPanel).getByText("分组列表")).toBeInTheDocument();
    expect(within(groupsPanel).getByRole("button", { name: "+ 新增分组" })).toBeInTheDocument();
    expect(within(groupsPanel).getByText("Core")).toBeInTheDocument();
    expect(
      within(groupsPanel).queryByText("用于组织信息源与 OPML 导入结果"),
    ).not.toBeInTheDocument();

    await user.click(within(groupsPanel).getByRole("button", { name: "+ 新增分组" }));
    await user.type(screen.getByPlaceholderText("新分组名称"), "Infra");
    await user.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/settings/groups", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "Infra",
        }),
      });
    });

    await waitFor(() => {
      expect(refreshSpy).toHaveBeenCalledTimes(1);
    });
  });

  it("links a source to a group from the group management row", async () => {
    const user = userEvent.setup();
    const refreshSpy = vi.fn();
    const initialSettings = buildInitialSettings();
    const targetSource = {
      id: "source-2",
      name: "Other Source",
      rssUrl: "https://other.example.com/feed.xml",
      siteUrl: "https://other.example.com",
      enabled: true,
      aiParsingEnabled: true,
      aggregationEnabled: false, aggregationDetectionEnabled: false,
      groupId: null,
      groupName: null,
      lastItemCreatedAt: null,
    };
    const fetchMock = createSourceSettingsFetchMock([...initialSettings.sources, targetSource]);

    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(
      <AdminSettingsPanel
        onRefresh={refreshSpy}
        initialSettings={{
          ...initialSettings,
          sources: [...initialSettings.sources, targetSource],
        }}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "分组" }));
    await user.click(screen.getByRole("button", { name: "关联信息源：Core" }));

    const dialog = await screen.findByRole("dialog", { name: "关联信息源：Core" });
    await user.type(within(dialog).getByLabelText("搜索信息源"), "Other");

    await waitFor(() => {
      expect(within(dialog).getByText("Other Source")).toBeInTheDocument();
      expect(within(dialog).getByText("当前分组：未分组")).toBeInTheDocument();
    });

    await user.click(within(dialog).getByRole("button", { name: "关联到 Core" }));

    const confirmDialog = await screen.findByRole("dialog", { name: "确认关联信息源" });
    expect(
      within(confirmDialog).getByText("确认将「Other Source」关联到「Core」？"),
    ).toBeInTheDocument();
    await user.click(within(confirmDialog).getByRole("button", { name: "确认" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/settings/sources/source-2", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "Other Source",
          rssUrl: "https://other.example.com/feed.xml",
          siteUrl: "https://other.example.com",
          enabled: true,
          aiParsingEnabled: true,
          aggregationEnabled: false, aggregationDetectionEnabled: false,
          groupId: "group-1",
        }),
      });
    });

    await waitFor(() => {
      expect(within(dialog).getByText("当前分组：Core")).toBeInTheDocument();
    });
    expect(within(dialog).getByRole("button", { name: "取消关联" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "确认关联信息源" })).not.toBeInTheDocument();
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("unlinks an already associated source from the group management dialog", async () => {
    const user = userEvent.setup();
    const refreshSpy = vi.fn();
    const initialSettings = buildInitialSettings();
    const fetchMock = createSourceSettingsFetchMock(initialSettings.sources);

    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(
      <AdminSettingsPanel onRefresh={refreshSpy} initialSettings={initialSettings} />,
    );

    await user.click(screen.getByRole("tab", { name: "分组" }));
    await user.click(screen.getByRole("button", { name: "关联信息源：Core" }));

    const dialog = await screen.findByRole("dialog", { name: "关联信息源：Core" });
    expect(within(dialog).getByText("Existing Source")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "取消关联" }));

    const confirmDialog = await screen.findByRole("dialog", { name: "确认取消关联" });
    expect(
      within(confirmDialog).getByText("确认取消「Existing Source」与「Core」的分组关联？"),
    ).toBeInTheDocument();
    await user.click(within(confirmDialog).getByRole("button", { name: "确认" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/settings/sources/source-1", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "Existing Source",
          rssUrl: "https://example.com/feed.xml",
          siteUrl: "https://example.com",
          enabled: true,
          aiParsingEnabled: true,
          aggregationEnabled: true, aggregationDetectionEnabled: false,
          groupId: null,
        }),
      });
    });

    await waitFor(() => {
      expect(within(dialog).getByText("当前分组：未分组")).toBeInTheDocument();
    });
    expect(within(dialog).getByRole("button", { name: "关联到 Core" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "确认取消关联" })).not.toBeInTheDocument();
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it("renders the Lumina-like blacklist layout and keeps the original save payload", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<AdminSettingsPanel initialSettings={buildInitialSettings()} />);

    await user.click(screen.getByRole("tab", { name: "黑名单" }));

    const blacklistPanel = screen.getByRole("tabpanel");

    expect(within(blacklistPanel).getAllByText("黑名单").length).toBeGreaterThan(0);
    expect(within(blacklistPanel).getByText("配置关键词黑名单过滤规则")).toBeInTheDocument();
    expect(within(blacklistPanel).queryByText("规则黑名单")).not.toBeInTheDocument();
    expect(within(blacklistPanel).queryByText("已生效")).not.toBeInTheDocument();

    const editorRegion = screen.getByRole("region", { name: "黑名单关键词编辑区" });
    const textarea = within(editorRegion).getByLabelText("关键词列表");

    expect(textarea).toHaveValue("layoffs");
    expect(textarea).toHaveAttribute("placeholder", "每行一个黑名单关键词");
    expect(within(editorRegion).getByText("?")).toBeInTheDocument();

    await user.clear(textarea);
    await user.type(textarea, " layoffs \n\n funding ");
    await user.click(screen.getByRole("button", { name: "保存配置" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/settings/blacklist", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          keywords: ["layoffs", "funding"],
        }),
      });
    });
  });

  it("renders task settings after sources and submits the existing schedule API payload", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          schedule: {
            ...buildInitialSettings().taskSchedule,
            enabled: false,
            cronExpression: "*/15 * * * *",
            sourceConcurrency: 4,
            fullTextFetchThreshold: 120,
            aggregationSplitMaxEvents: 12,
          },
        }),
      ),
    );

    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<AdminSettingsPanel initialSettings={buildInitialSettings()} />);

    expect(screen.getByRole("tab", { name: "正文解析" })).toBeInTheDocument();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.at(-3)).toHaveAccessibleName("采集任务");
    expect(tabs.at(-2)).toHaveAccessibleName("日报任务");
    expect(tabs.at(-1)).toHaveAccessibleName("清理任务");

    await user.click(screen.getByRole("tab", { name: "采集任务" }));

    const taskPanel = screen.getByRole("tabpanel");

    expect(within(taskPanel).getByText("采集任务")).toBeInTheDocument();
    expect(within(taskPanel).queryByText("默认抓取任务")).not.toBeInTheDocument();
    expect(within(taskPanel).queryByText("调度状态")).not.toBeInTheDocument();
    expect(within(taskPanel).queryByDisplayValue("调度器在线")).not.toBeInTheDocument();
    expect(within(taskPanel).queryByDisplayValue("已成功")).not.toBeInTheDocument();
    expect(within(taskPanel).getByLabelText("采集 Cron 表达式")).toHaveValue("0 * * * *");
    expect(within(taskPanel).getByLabelText("源抓取并发")).toHaveValue(2);
    expect(within(taskPanel).getByLabelText("正文补抓阈值")).toHaveValue(80);
    expect(within(taskPanel).getByLabelText("单条聚合拆分上限")).toHaveValue(20);

    await user.clear(within(taskPanel).getByLabelText("采集 Cron 表达式"));
    await user.type(within(taskPanel).getByLabelText("采集 Cron 表达式"), "*/15 * * * *");
    await user.clear(within(taskPanel).getByLabelText("源抓取并发"));
    await user.type(within(taskPanel).getByLabelText("源抓取并发"), "4");
    await user.clear(within(taskPanel).getByLabelText("正文补抓阈值"));
    await user.type(within(taskPanel).getByLabelText("正文补抓阈值"), "120");
    await user.clear(within(taskPanel).getByLabelText("单条聚合拆分上限"));
    await user.type(within(taskPanel).getByLabelText("单条聚合拆分上限"), "12");
    await user.click(within(taskPanel).getByLabelText("启用默认抓取任务"));
    await user.click(within(taskPanel).getAllByRole("button", { name: "保存配置" })[0]!);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/monitor/schedule/ingestion-default", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          enabled: false,
          cronExpression: "*/15 * * * *",
          sourceConcurrency: 4,
          fullTextFetchThreshold: 120,
          perSourceItemLimit: 20,
          aggregationSplitMaxEvents: 12,
          processingStartAt: null,
        }),
      });
    });
  });

  it("submits content extraction settings from the dedicated section", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          config: {
            ...buildInitialSettings().contentExtraction,
            jinaEnabled: true,
            timeoutMs: 20000,
          },
        }),
      ),
    );

    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<AdminSettingsPanel initialSettings={buildInitialSettings()} />);

    await user.click(screen.getByRole("tab", { name: "正文解析" }));

    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByText("正文解析")).toBeInTheDocument();

    await user.selectOptions(within(panel).getByLabelText("解析策略"), "jina");
    await user.type(within(panel).getByLabelText("API Key"), "jina_test_key");
    await user.clear(within(panel).getByLabelText("请求超时"));
    await user.type(within(panel).getByLabelText("请求超时"), "20000");
    await user.click(within(panel).getByRole("button", { name: "保存配置" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/settings/content-extraction", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jinaEnabled: true,
          jinaBaseUrl: "https://r.jina.ai/",
          jinaApiKey: "jina_test_key",
          jinaApiKeyMode: "replace",
          timeoutMs: 20000,
          concurrency: 1,
          rpmLimit: 10,
          maxPerRun: 20,
          minChars: 500,
          maxChars: 32000,
        }),
      });
    });
    await screen.findByText("正文解析设置已保存。");
    await waitForElementToBeRemoved(() => screen.queryByText("正文解析设置已保存。"), { timeout: 4000 });
  });

  it("submits event briefing display and curator preference settings", async () => {
    const user = userEvent.setup();
    const savedEventBriefing = {
      config: {
        ...buildInitialSettings().eventBriefing.config,
        minRankScore: 20,
      },
      preference: {
        ...buildInitialSettings().eventBriefing.preference,
        weightedRules: [
          { type: "tag", value: "AI Coding", weight: 6 },
          { type: "keyword", value: "OpenAI", weight: -4 },
        ],
      },
    };
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);

      if (url.startsWith("/api/admin/settings/tags")) {
        return new Response(JSON.stringify({
          tags: [
            {
              id: "tag-ai-coding",
              name: "AI Coding",
              normalized: "ai-coding",
              itemCount: 12,
              aliasCount: 0,
              aliases: [],
              createdAt: "2026-04-20T10:00:00.000Z",
              updatedAt: "2026-04-20T10:00:00.000Z",
            },
            {
              id: "tag-marketing",
              name: "Marketing",
              normalized: "marketing",
              itemCount: 3,
              aliasCount: 0,
              aliases: [],
              createdAt: "2026-04-20T10:00:00.000Z",
              updatedAt: "2026-04-20T10:00:00.000Z",
            },
          ],
          totalCount: 2,
          page: 1,
          pageSize: 100,
        }));
      }

      if (url === "/api/admin/settings/event-briefing" && init?.method === "PATCH") {
        return new Response(JSON.stringify({ eventBriefing: savedEventBriefing }));
      }

      return new Response(JSON.stringify({ error: "unexpected request" }), { status: 500 });
    });

    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<AdminSettingsPanel initialSettings={buildInitialSettings()} />);

    await user.click(screen.getByRole("tab", { name: "速览配置" }));

    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByText("事件偏好")).toBeInTheDocument();
    expect(within(panel).queryByLabelText("默认重点事件数量")).not.toBeInTheDocument();
    expect(within(panel).queryByLabelText("单页最大事件数量")).not.toBeInTheDocument();
    expect(within(panel).queryByLabelText("来源预览数量")).not.toBeInTheDocument();
    expect(within(panel).queryByLabelText("入选原因数量")).not.toBeInTheDocument();
    expect(within(panel).queryByText("每行一条。偏好只影响公开排序，不采集访客行为，也不会硬过滤内容。")).not.toBeInTheDocument();
    expect(within(panel).getByLabelText("加权上限")).toHaveValue(15);
    expect(within(panel).getByLabelText("降权上限")).toHaveValue(20);

    await user.clear(within(panel).getByLabelText("最低入选分"));
    await user.type(within(panel).getByLabelText("最低入选分"), "20");
    await user.click(within(panel).getByRole("button", { name: "新增规则" }));
    let dialog = screen.getByRole("dialog", { name: "新增加权规则" });
    await waitFor(() => {
      expect(within(dialog).getByRole("option", { name: "AI Coding (12)" })).toBeInTheDocument();
    });
    await user.selectOptions(within(dialog).getByLabelText("内容"), ["AI Coding"]);
    await user.clear(within(dialog).getByLabelText("权重"));
    await user.type(within(dialog).getByLabelText("权重"), "6");
    await user.click(within(dialog).getByRole("button", { name: "添加" }));

    await user.click(within(panel).getByRole("button", { name: "新增规则" }));
    dialog = screen.getByRole("dialog", { name: "新增加权规则" });
    await user.selectOptions(within(dialog).getByLabelText("类型"), ["keyword"]);
    await user.type(within(dialog).getByLabelText("内容"), "OpenAI");
    await user.clear(within(dialog).getByLabelText("权重"));
    await user.type(within(dialog).getByLabelText("权重"), "-4");
    await user.click(within(dialog).getByRole("button", { name: "添加" }));

    expect(within(panel).getByText("AI Coding (12)")).toBeInTheDocument();
    expect(within(panel).getByText("OpenAI")).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "保存配置" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/settings/event-briefing", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          config: {
            minRankScore: 20,
          },
          preference: {
            weightedRules: [
              { type: "tag", value: "AI Coding", weight: 6 },
              { type: "keyword", value: "OpenAI", weight: -4 },
            ],
            maxCuratorBoost: 15,
            maxCuratorPenalty: 20,
          },
        }),
      });
    });
    await screen.findByText("速览配置已保存。");
  });

  it("submits the daily report schedule candidate limit", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          schedule: {
            ...buildInitialSettings().dailyReportSchedule,
            enabled: true,
            cronExpression: "0 9 * * *",
            dailyReportCandidateLimit: 80,
            dailyReportOffsetDays: 1,
            dailyReportAutoPublish: true,
            dailyReportGroupIds: ["group-1"],
          },
        }),
      ),
    );

    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<AdminSettingsPanel initialSettings={buildInitialSettings()} />);

    await user.click(screen.getByRole("tab", { name: "日报任务" }));

    const taskPanel = screen.getByRole("tabpanel");

    expect(within(taskPanel).queryByText("下次运行")).not.toBeInTheDocument();
    expect(within(taskPanel).getByLabelText("T-")).toHaveValue(0);
    expect(within(taskPanel).getByLabelText("候选内容上限")).toHaveValue(120);
    expect(within(taskPanel).getByLabelText("日报分组范围")).toHaveValue(["__all_daily_report_groups__"]);

    await user.click(within(taskPanel).getByLabelText("启用 AI 日报任务"));
    await user.clear(within(taskPanel).getByLabelText("日报 Cron 表达式"));
    await user.type(within(taskPanel).getByLabelText("日报 Cron 表达式"), "0 9 * * *");
    await user.clear(within(taskPanel).getByLabelText("T-"));
    await user.type(within(taskPanel).getByLabelText("T-"), "1");
    await user.clear(within(taskPanel).getByLabelText("候选内容上限"));
    await user.type(within(taskPanel).getByLabelText("候选内容上限"), "80");
    await user.click(within(taskPanel).getByLabelText("生成后自动发布 AI 日报"));
    await user.selectOptions(within(taskPanel).getByLabelText("日报分组范围"), ["group-1"]);
    await user.click(within(taskPanel).getAllByRole("button", { name: "保存配置" })[1]!);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/monitor/schedule/daily-report-default", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          enabled: true,
          cronExpression: "0 9 * * *",
          dailyReportCandidateLimit: 80,
          dailyReportOffsetDays: 1,
          dailyReportAutoPublish: true,
          dailyReportMaxRetries: 0,
          dailyReportGroupIds: ["group-1"],
        }),
      });
    });
  });
});
