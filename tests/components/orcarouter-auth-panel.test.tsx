import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OrcaRouterAuthPanel } from "@/components/admin/orcarouter-auth-panel";

const FAKE_ISSUED_KEY = "sk-orca-componenttest0000000000000000000";

function sessionPayload(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    session: {
      attemptId: "attempt-1",
      generation: 1,
      status: "pending",
      authorizeUrl: "https://www.orcarouter.ai/auth?callback_url=oob&state=fake",
      requestedScope: "api",
      callbackMode: "out-of-band",
      accountId: null,
      grantedScope: null,
      error: null,
      ...overrides,
    },
  };
}

function renderPanel(overrides: Partial<Parameters<typeof OrcaRouterAuthPanel>[0]> = {}) {
  const onApiKeyChange = vi.fn();
  const onConnected = vi.fn();

  const view = render(
    <OrcaRouterAuthPanel
      configId="cfg-1"
      authMethod="api-key"
      needsReauth={false}
      hasApiKey={false}
      oauthAccountId=""
      oauthScope=""
      apiKeyValue=""
      onApiKeyChange={onApiKeyChange}
      onConnected={onConnected}
      {...overrides}
    />,
  );

  return { ...view, onApiKeyChange, onConnected };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify(sessionPayload()), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OrcaRouter auth methods are both present and independent", () => {
  it("shows the API-key entry and the Connect with OrcaRouter entry together", () => {
    renderPanel();

    const apiKeyInput = screen.getByLabelText("OrcaRouter API Key");
    // The key control must be masked.
    expect(apiKeyInput).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: /Connect with OrcaRouter/ })).toBeEnabled();
  });

  it("keeps the API-key path usable without starting any PKCE login", () => {
    const { onApiKeyChange } = renderPanel();

    fireEvent.change(screen.getByLabelText("OrcaRouter API Key"), {
      target: { value: FAKE_ISSUED_KEY },
    });

    expect(onApiKeyChange).toHaveBeenCalledWith(FAKE_ISSUED_KEY);
    // No authorize request was made: the two choices are independent.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a needs-reauth account with an explicit re-login prompt", () => {
    renderPanel({ authMethod: "pkce", needsReauth: true, hasApiKey: true });

    expect(screen.getByText(/密钥已被撤销/)).toBeInTheDocument();
    expect(screen.getByText("需要重新登录")).toBeInTheDocument();
  });

  it("requires a saved config before starting a connect flow", () => {
    renderPanel({ configId: null });

    expect(screen.getByText("请先保存配置后再登录。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Connect with OrcaRouter/ })).toBeDisabled();
  });
});

describe("connect flow lifecycle", () => {
  it("starts a login and shows the authorize URL with a code field", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /Connect with OrcaRouter/ }));

    await waitFor(() => {
      expect(screen.getByLabelText("OrcaRouter 授权页地址")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("OrcaRouter 授权码")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "完成连接" })).toBeInTheDocument();
  });

  it("cancels explicitly and releases the server-side lock", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /Connect with OrcaRouter/ }));
    await waitFor(() => expect(screen.getByLabelText("OrcaRouter 授权码")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    await waitFor(() => {
      expect(screen.queryByLabelText("OrcaRouter 授权码")).not.toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/settings/orcarouter/connect",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("clears busy state on pagehide and allows a second login without remounting", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /Connect with OrcaRouter/ }));
    await waitFor(() => expect(screen.getByLabelText("OrcaRouter 授权码")).toBeInTheDocument());

    // The browser may put the page into the back-forward cache instead of
    // unmounting it, so an invalidated request's guarded `finally` cannot be
    // relied on to clear state.
    fireEvent(window, new Event("pagehide"));

    await waitFor(() => {
      expect(screen.queryByLabelText("OrcaRouter 授权码")).not.toBeInTheDocument();
    });
    // Busy/hint state is synchronously cleared above; the button is usable again.
    const retry = screen.getByRole("button", { name: /Connect with OrcaRouter/ });
    expect(retry).toBeEnabled();
    expect(screen.queryByText(/请在浏览器打开授权页/)).not.toBeInTheDocument();

    // A second login starts without remounting the component.
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(sessionPayload({ attemptId: "attempt-2" })), { status: 200 }),
    );
    fireEvent.click(retry);

    await waitFor(() => {
      expect(screen.getByLabelText("OrcaRouter 授权码")).toBeInTheDocument();
    });
  });

  it("cancels server-side work with keepalive on pagehide", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /Connect with OrcaRouter/ }));
    await waitFor(() => expect(screen.getByLabelText("OrcaRouter 授权码")).toBeInTheDocument());

    fireEvent(window, new Event("pagehide"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/settings/orcarouter/connect",
        expect.objectContaining({ method: "DELETE", keepalive: true }),
      );
    });
  });

  it("reports a failed exchange instead of hanging on the pending state", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /Connect with OrcaRouter/ }));
    await waitFor(() => expect(screen.getByLabelText("OrcaRouter 授权码")).toBeInTheDocument());

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: false,
          session: sessionPayload({
            status: "exchange-error",
            error: "授权码无效、已过期或已被使用。",
          }).session,
        }),
        { status: 200 },
      ),
    );

    fireEvent.change(screen.getByLabelText("OrcaRouter 授权码"), {
      target: { value: "expired-code" },
    });
    fireEvent.click(screen.getByRole("button", { name: "完成连接" }));

    await waitFor(() => {
      expect(screen.getByText(/授权码无效/)).toBeInTheDocument();
    });
    // The attempt is terminal: the user is offered the start action again.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Connect with OrcaRouter/ })).toBeInTheDocument();
    });
  });

  it("reports a successful connect to the parent so credentials refresh", async () => {
    const { onConnected } = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /Connect with OrcaRouter/ }));
    await waitFor(() => expect(screen.getByLabelText("OrcaRouter 授权码")).toBeInTheDocument());

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          session: sessionPayload({
            status: "success",
            accountId: "12345",
            grantedScope: "api",
          }).session,
          error: null,
        }),
        { status: 200 },
      ),
    );

    fireEvent.change(screen.getByLabelText("OrcaRouter 授权码"), {
      target: { value: "good-code" },
    });
    fireEvent.click(screen.getByRole("button", { name: "完成连接" }));

    await waitFor(() => {
      expect(onConnected).toHaveBeenCalledWith("12345", "api");
    });
    expect(screen.getByText(/密钥已保存/)).toBeInTheDocument();
  });

  it("never renders a key or verifier into the DOM", async () => {
    const { container } = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /Connect with OrcaRouter/ }));
    await waitFor(() => expect(screen.getByLabelText("OrcaRouter 授权码")).toBeInTheDocument());

    const html = container.innerHTML;
    expect(html).not.toContain(FAKE_ISSUED_KEY);
    expect(html).not.toContain("code_verifier");
  });
});
