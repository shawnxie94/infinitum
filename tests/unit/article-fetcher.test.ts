import { afterEach, describe, expect, it, vi } from "vitest";

import { createConfiguredArticleFetcher } from "@/lib/ingestion/article";
import type { RuntimeConfig } from "@/config/runtime";

function buildConfig(overrides: Partial<RuntimeConfig["contentExtraction"]> = {}): RuntimeConfig["contentExtraction"] {
  return {
    jinaEnabled: true,
    jinaBaseUrl: "https://r.jina.ai/",
    jinaApiKey: null,
    timeoutMs: 15_000,
    concurrency: 1,
    rpmLimit: 500,
    maxPerRun: 20,
    minChars: 20,
    maxChars: 32_000,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createConfiguredArticleFetcher", () => {
  it("uses local extraction first by default", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const localFetcher = vi.fn().mockResolvedValue("Local article content with enough signal.");

    const fetcher = createConfiguredArticleFetcher(buildConfig(), localFetcher);

    await expect(fetcher("https://example.com/post")).resolves.toBe("Local article content with enough signal.");
    expect(localFetcher).toHaveBeenCalledWith("https://example.com/post", expect.objectContaining({
      signal: expect.any(AbortSignal),
    }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to Jina when local extraction is too short", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("## Clean article\n\nJina markdown content with enough signal."));
    vi.stubGlobal("fetch", fetchMock);
    const localFetcher = vi.fn().mockResolvedValue("Too short");

    const fetcher = createConfiguredArticleFetcher(buildConfig(), localFetcher);

    await expect(fetcher("https://example.com/post")).resolves.toContain("Jina markdown content");
    expect(fetchMock).toHaveBeenCalledWith("https://r.jina.ai/https://example.com/post", expect.objectContaining({
      headers: expect.objectContaining({
        "X-Respond-With": "markdown",
      }),
    }));
  });

  it("uses Jina first for RSS HTML context when enabled", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("Jina cleaned markdown body with enough signal."));
    vi.stubGlobal("fetch", fetchMock);
    const localFetcher = vi.fn().mockResolvedValue("Local article content with enough signal.");

    const fetcher = createConfiguredArticleFetcher(buildConfig(), localFetcher);

    await expect(fetcher("https://example.com/post", { reason: "rss_html" })).resolves.toContain("Jina cleaned");
    expect(localFetcher).not.toHaveBeenCalled();
  });

  it("uses local extraction for Weixin RSS HTML instead of Jina", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("Jina should not be used."));
    vi.stubGlobal("fetch", fetchMock);
    const localFetcher = vi.fn().mockResolvedValue("Local Weixin article content with enough signal.");

    const fetcher = createConfiguredArticleFetcher(buildConfig(), localFetcher);

    await expect(fetcher("https://mp.weixin.qq.com/s/example", { reason: "rss_html" })).resolves.toBe(
      "Local Weixin article content with enough signal.",
    );
    expect(localFetcher).toHaveBeenCalledWith("https://mp.weixin.qq.com/s/example", expect.objectContaining({
      reason: "rss_html",
      signal: expect.any(AbortSignal),
    }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fall back to Jina for Weixin pages when local extraction is too short", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("Jina should not be used."));
    vi.stubGlobal("fetch", fetchMock);
    const localFetcher = vi.fn().mockResolvedValue("Too short");

    const fetcher = createConfiguredArticleFetcher(buildConfig(), localFetcher);

    await expect(fetcher("https://mp.weixin.qq.com/s/example")).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to local content when Jina fails for RSS HTML", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("bad gateway", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);
    const localFetcher = vi.fn().mockResolvedValue("Local article content with enough signal.");

    const fetcher = createConfiguredArticleFetcher(buildConfig(), localFetcher);

    await expect(fetcher("https://example.com/post", { reason: "rss_html" })).resolves.toBe(
      "Local article content with enough signal.",
    );
  });

  it("falls back after the local request times out", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("Jina article content with enough signal."));
    vi.stubGlobal("fetch", fetchMock);
    let localSignal: AbortSignal | undefined;
    const localFetcher = vi.fn((_url: string, context?: { signal?: AbortSignal }) => {
      localSignal = context?.signal;
      return new Promise<string>((_resolve, reject) => {
        context?.signal?.addEventListener("abort", () => reject(context.signal?.reason), { once: true });
      });
    });
    const fetcher = createConfiguredArticleFetcher(buildConfig({ timeoutMs: 20 }), localFetcher);

    await expect(fetcher("https://example.com/post")).resolves.toContain("Jina article content");
    expect(localSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("falls back to local extraction after a Jina request times out", async () => {
    const fetchMock = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const localFetcher = vi.fn().mockResolvedValue("Local fallback article content with enough signal.");
    const fetcher = createConfiguredArticleFetcher(buildConfig({ timeoutMs: 20 }), localFetcher);

    await expect(fetcher("https://example.com/post", { reason: "rss_html" })).resolves.toBe(
      "Local fallback article content with enough signal.",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(localFetcher).toHaveBeenCalledOnce();
  });

  it("does not fall back after the caller cancels a local request", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const localFetcher = vi.fn((_url: string, context?: { signal?: AbortSignal }) => {
      markStarted();
      return new Promise<string>((_resolve, reject) => {
        context?.signal?.addEventListener("abort", () => reject(context.signal?.reason), { once: true });
      });
    });
    const fetcher = createConfiguredArticleFetcher(buildConfig(), localFetcher);
    const pending = fetcher("https://example.com/post", { signal: controller.signal });

    await started;
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fall back after the caller cancels an active Jina request", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const fetchMock = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      markStarted();
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const localFetcher = vi.fn().mockResolvedValue("Local fallback should not run.");
    const fetcher = createConfiguredArticleFetcher(buildConfig(), localFetcher);
    const controller = new AbortController();
    const pending = fetcher("https://example.com/post", { reason: "rss_html", signal: controller.signal });

    await started;
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(localFetcher).not.toHaveBeenCalled();
  });

  it("cancels a Jina request while waiting for a rate-limit slot", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("Jina article content with enough signal."));
    vi.stubGlobal("fetch", fetchMock);
    const fetcher = createConfiguredArticleFetcher(buildConfig({ concurrency: 2, rpmLimit: 500, timeoutMs: 2_000 }));

    await expect(fetcher("https://example.com/first", { reason: "rss_html" })).resolves.toContain("Jina article content");
    const controller = new AbortController();
    const second = fetcher("https://example.com/second", { reason: "rss_html", signal: controller.signal });
    controller.abort(new DOMException("cancelled", "AbortError"));

    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("removes a cancelled Jina request from the concurrency queue", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    let markFirstStarted!: () => void;
    let releaseFirst!: (response: Response) => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const firstResponse = new Promise<Response>((resolve) => { releaseFirst = resolve; });
    fetchMock.mockResolvedValue(new Response("Jina article content after queue cleanup."));
    fetchMock.mockImplementationOnce(() => {
      markFirstStarted();
      return firstResponse;
    });
    const fetcher = createConfiguredArticleFetcher(buildConfig({ concurrency: 1, timeoutMs: 2_000 }));
    const first = fetcher("https://example.com/first", { reason: "rss_html" });
    await firstStarted;

    const controller = new AbortController();
    const second = fetcher("https://example.com/second", { reason: "rss_html", signal: controller.signal });
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledOnce();

    releaseFirst(new Response("Jina first article content with enough signal."));
    await expect(first).resolves.toContain("Jina first article content");
    await expect(fetcher("https://example.com/third", { reason: "rss_html" })).resolves.toContain("Jina article content");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
