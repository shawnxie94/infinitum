import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

import type { RuntimeConfig } from "@/config/runtime";
import type { ArticleFetchContext, ArticleFetcher } from "@/lib/ingestion/types";

export async function fetchArticleContent(url: string, context?: ArticleFetchContext): Promise<string | null> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "infinitum-feed-bot/1.0",
    },
    ...(context?.signal ? { signal: context.signal } : {}),
  });

  if (!response.ok) {
    throw new Error(`Article fetch failed with status ${response.status}`);
  }

  const html = await response.text();
  const dom = new JSDOM(html, { url });
  const article = new Readability(dom.window.document).parse();

  return article?.textContent?.trim() || null;
}

function trimExtractedContent(value: string | null, maxChars: number): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.length > maxChars ? trimmed.slice(0, maxChars).trimEnd() : trimmed;
}

function isValidExtractedContent(value: string | null, minChars: number) {
  return Boolean(value && value.trim().length >= minChars);
}

export function shouldSkipJinaForUrl(url: string) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === "weixin.qq.com" || hostname.endsWith(".weixin.qq.com");
  } catch {
    return false;
  }
}

function buildJinaReaderUrl(baseUrl: string, targetUrl: string) {
  return `${baseUrl.replace(/\/+$/, "")}/${targetUrl}`;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
  }
}

function createTimedSignal(signal: AbortSignal | undefined, timeoutMs: number) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function waitWithSignal(waitMs: number, signal?: AbortSignal) {
  throwIfAborted(signal);
  if (waitMs <= 0) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
    };

    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, waitMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function createJinaRateLimiter(rpmLimit: number) {
  let nextAvailableAt = 0;
  const minIntervalMs = Math.ceil(60_000 / Math.max(1, rpmLimit));

  return async function waitForSlot(signal?: AbortSignal) {
    throwIfAborted(signal);
    const now = Date.now();
    const reservationAt = Math.max(now, nextAvailableAt);
    const waitMs = Math.max(0, reservationAt - now);
    nextAvailableAt = reservationAt + minIntervalMs;

    try {
      await waitWithSignal(waitMs, signal);
    } catch (error) {
      if (nextAvailableAt === reservationAt + minIntervalMs) nextAvailableAt = reservationAt;
      throw error;
    }
  };
}

type SemaphoreWaiter = {
  signal?: AbortSignal;
  grant: () => void;
  reject: (reason: unknown) => void;
  removeAbortListener?: () => void;
};

function createSemaphore(limit: number) {
  let active = 0;
  const queue: SemaphoreWaiter[] = [];
  const grantNext = () => {
    while (queue.length > 0) {
      const waiter = queue.shift()!;
      waiter.removeAbortListener?.();
      if (waiter.signal?.aborted) {
        waiter.reject(waiter.signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
        continue;
      }
      waiter.grant();
      return;
    }
  };

  return async function runWithSlot<T>(task: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    let hasSlot = false;
    try {
      throwIfAborted(signal);
      if (active < limit) {
        active += 1;
        hasSlot = true;
      } else {
        await new Promise<void>((resolve, reject) => {
          const waiter: SemaphoreWaiter = {
            signal,
            grant: () => {
              active += 1;
              hasSlot = true;
              resolve();
            },
            reject,
          };
          queue.push(waiter);
          if (signal) {
            const onAbort = () => {
              const queuedIndex = queue.indexOf(waiter);
              if (queuedIndex < 0) return;
              queue.splice(queuedIndex, 1);
              waiter.removeAbortListener?.();
              reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
            };
            waiter.removeAbortListener = () => signal.removeEventListener("abort", onAbort);
            signal.addEventListener("abort", onAbort, { once: true });
            if (signal.aborted) onAbort();
          }
        });
      }
      throwIfAborted(signal);
      return await task(signal);
    } finally {
      if (hasSlot) {
        active -= 1;
        grantNext();
      }
    }
  };
}

async function fetchJinaReaderContent(
  url: string,
  config: RuntimeConfig["contentExtraction"],
  waitForSlot: (signal?: AbortSignal) => Promise<void>,
  signal?: AbortSignal,
): Promise<string | null> {
  await waitForSlot(signal);
  throwIfAborted(signal);

  const headers: Record<string, string> = {
    Accept: "text/plain",
    "X-Respond-With": "markdown",
  };

  if (config.jinaApiKey) {
    headers.Authorization = `Bearer ${config.jinaApiKey}`;
  }

  const response = await fetch(buildJinaReaderUrl(config.jinaBaseUrl, url), {
    headers,
    signal,
  });

  if (!response.ok) {
    throw new Error(`Jina Reader fetch failed with status ${response.status}`);
  }

  return trimExtractedContent(await response.text(), config.maxChars);
}

export function createConfiguredArticleFetcher(
  config: RuntimeConfig["contentExtraction"],
  localFetcher: ArticleFetcher = fetchArticleContent,
): ArticleFetcher {
  const waitForJinaSlot = createJinaRateLimiter(config.rpmLimit);
  const runJinaWithSlot = createSemaphore(config.concurrency);
  let jinaCalls = 0;

  return async (url: string, context?: ArticleFetchContext) => {
    const shouldTryJinaFirst = context?.reason === "rss_html";
    throwIfAborted(context?.signal);
    const canCallJina = () => config.jinaEnabled && !shouldSkipJinaForUrl(url) && config.maxPerRun > 0 && jinaCalls < config.maxPerRun;

    const tryJina = async () => {
      throwIfAborted(context?.signal);
      if (!canCallJina()) {
        return null;
      }

      if (context?.metrics) {
        context.metrics.jinaAttempted = true;
      }
      jinaCalls += 1;
      const requestSignal = createTimedSignal(context?.signal, config.timeoutMs);
      try {
        const content = await runJinaWithSlot(
          (signal) => fetchJinaReaderContent(url, config, waitForJinaSlot, signal),
          requestSignal,
        );
        throwIfAborted(context?.signal);
        if (!isValidExtractedContent(content, config.minChars)) {
          return null;
        }
        if (context?.metrics) {
          context.metrics.used = "jina";
        }
        return content;
      } catch (error) {
        if (context?.signal?.aborted) throw error;
        console.error("[Article Fetcher] Jina Reader fetch failed:", error);
        return null;
      }
    };

    const tryLocal = async () => {
      throwIfAborted(context?.signal);
      if (context?.metrics) {
        context.metrics.localAttempted = true;
      }
      const requestSignal = createTimedSignal(context?.signal, config.timeoutMs);
      try {
        const content = trimExtractedContent(await localFetcher(url, { ...context, signal: requestSignal }), config.maxChars);
        throwIfAborted(context?.signal);
        if (!isValidExtractedContent(content, config.minChars)) {
          return null;
        }
        if (context?.metrics) {
          context.metrics.used = "local";
        }
        return content;
      } catch (error) {
        if (context?.signal?.aborted) throw error;
        console.error("[Article Fetcher] Local article fetch failed:", error);
        return null;
      }
    };

    if (shouldTryJinaFirst) {
      return (await tryJina()) ?? (await tryLocal());
    }

    return (await tryLocal()) ?? (await tryJina());
  };
}
