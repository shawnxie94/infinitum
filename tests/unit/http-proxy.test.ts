import { beforeEach, describe, expect, it, vi } from "vitest";

const undiciMock = vi.hoisted(() => {
  const dispatcher = { kind: "proxy-dispatcher" };
  const defaultDispatcher = { kind: "default-dispatcher" };

  return {
    dispatcher,
    defaultDispatcher,
    EnvHttpProxyAgent: vi.fn(function EnvHttpProxyAgent() {
      return dispatcher;
    }),
    getGlobalDispatcher: vi.fn(() => defaultDispatcher),
    setGlobalDispatcher: vi.fn(),
  };
});

vi.mock("undici", () => ({
  EnvHttpProxyAgent: undiciMock.EnvHttpProxyAgent,
  getGlobalDispatcher: undiciMock.getGlobalDispatcher,
  setGlobalDispatcher: undiciMock.setGlobalDispatcher,
}));

async function importProxyModule() {
  vi.resetModules();
  return import("@/lib/http/proxy");
}

beforeEach(() => {
  undiciMock.EnvHttpProxyAgent.mockClear();
  undiciMock.getGlobalDispatcher.mockClear();
  undiciMock.setGlobalDispatcher.mockClear();
});

describe("fetch proxy configuration", () => {
  it("leaves the global dispatcher unchanged when no proxy env is set", async () => {
    const { configureFetchProxyFromEnv, hasProxyEnvironment } = await importProxyModule();

    expect(hasProxyEnvironment({})).toBe(false);
    const result = configureFetchProxyFromEnv({});

    expect(result.enabled).toBe(false);
    expect(result.dispatcher).toBe(undiciMock.defaultDispatcher);
    expect(undiciMock.getGlobalDispatcher).toHaveBeenCalledTimes(1);
    expect(undiciMock.EnvHttpProxyAgent).not.toHaveBeenCalled();
    expect(undiciMock.setGlobalDispatcher).not.toHaveBeenCalled();
  });

  it("installs an EnvHttpProxyAgent from HTTP proxy environment variables", async () => {
    const { configureFetchProxyFromEnv, hasProxyEnvironment } = await importProxyModule();
    const env = {
      HTTP_PROXY: "http://proxy.example.com:8080",
      HTTPS_PROXY: "http://secure-proxy.example.com:8080",
      NO_PROXY: "localhost,127.0.0.1",
    };

    expect(hasProxyEnvironment(env)).toBe(true);
    const result = configureFetchProxyFromEnv(env);

    expect(result.enabled).toBe(true);
    expect(result.dispatcher).toBe(undiciMock.dispatcher);
    expect(undiciMock.EnvHttpProxyAgent).toHaveBeenCalledWith({
      httpProxy: "http://proxy.example.com:8080",
      httpsProxy: "http://secure-proxy.example.com:8080",
      noProxy: "localhost,127.0.0.1,app",
    });
    expect(undiciMock.setGlobalDispatcher).toHaveBeenCalledWith(undiciMock.dispatcher);
  });

  it("uses lowercase proxy env values before uppercase values", async () => {
    const { configureFetchProxyFromEnv } = await importProxyModule();

    configureFetchProxyFromEnv({
      HTTP_PROXY: "http://uppercase.example.com:8080",
      http_proxy: "http://lowercase.example.com:8080",
      NO_PROXY: "uppercase.local",
      no_proxy: "lowercase.local",
    });

    expect(undiciMock.EnvHttpProxyAgent).toHaveBeenCalledWith({
      httpProxy: "http://lowercase.example.com:8080",
      httpsProxy: undefined,
      noProxy: "lowercase.local,app",
    });
  });

  it("bypasses Docker-internal app even when no NO_PROXY value is configured", async () => {
    const { configureFetchProxyFromEnv } = await importProxyModule();

    configureFetchProxyFromEnv({ HTTP_PROXY: "http://proxy.example.com:8080" });

    expect(undiciMock.EnvHttpProxyAgent).toHaveBeenCalledWith({
      httpProxy: "http://proxy.example.com:8080",
      httpsProxy: undefined,
      noProxy: "app",
    });
  });

  it("does not reinstall the proxy dispatcher more than once per process", async () => {
    const { configureFetchProxyFromEnv } = await importProxyModule();

    configureFetchProxyFromEnv({ HTTP_PROXY: "http://proxy.example.com:8080" });
    const result = configureFetchProxyFromEnv({ HTTP_PROXY: "http://other.example.com:8080" });

    expect(result.enabled).toBe(true);
    expect(result.dispatcher).toBe(undiciMock.dispatcher);
    expect(undiciMock.EnvHttpProxyAgent).toHaveBeenCalledTimes(1);
    expect(undiciMock.setGlobalDispatcher).toHaveBeenCalledTimes(1);
  });
});
