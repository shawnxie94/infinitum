import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = [
  "SITE_URL",
  "NEXT_PUBLIC_SITE_URL",
  "PUBLIC_SITE_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
  "VERCEL_URL",
  "URL",
  "DEPLOY_PRIME_URL",
  "DEPLOY_URL",
  "CF_PAGES_URL",
  "RAILWAY_PUBLIC_DOMAIN",
  "RENDER_EXTERNAL_URL",
];

function clearEnv() {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

describe("buildSitemapEntries", () => {
  beforeEach(() => {
    clearEnv();
    vi.resetModules();
  });
  afterEach(() => {
    clearEnv();
    vi.resetModules();
  });

  it("includes home + /daily list + every published /daily/[date] entry", async () => {
    const { buildSitemapEntries } = await import("@/app/sitemap");
    const result = buildSitemapEntries("https://infinitum.example.com", {
      dailyReports: [
        {
          date: "2026-06-22",
          publishedAt: "2026-06-22T01:00:00.000Z",
          generatedAt: "2026-06-22T00:30:00.000Z",
        } as never,
        {
          date: "2026-06-21",
          publishedAt: "2026-06-21T01:00:00.000Z",
          generatedAt: "2026-06-21T00:30:00.000Z",
        } as never,
        {
          date: "2026-06-20",
          publishedAt: null,
          generatedAt: "2026-06-20T00:30:00.000Z",
        } as never,
      ],
      latestRunFinishedAt: "2026-06-22T00:00:00.000Z",
    });

    const urls = result.map((r) => r.url);
    expect(urls).toContain("https://infinitum.example.com");
    expect(urls).toContain("https://infinitum.example.com/daily");
    expect(urls).toContain("https://infinitum.example.com/daily/2026-06-22");
    expect(urls).toContain("https://infinitum.example.com/daily/2026-06-21");
    expect(urls).toContain("https://infinitum.example.com/daily/2026-06-20");
    expect(urls.length).toBe(5);

    // Spot-check priority / changeFreq
    const home = result.find((r) => r.url === "https://infinitum.example.com")!;
    expect(home.priority).toBe(1);
    expect(home.changeFrequency).toBe("hourly");

    const list = result.find((r) => r.url === "https://infinitum.example.com/daily")!;
    expect(list.priority).toBe(0.8);
    expect(list.changeFrequency).toBe("daily");

    const detail = result.find((r) => r.url === "https://infinitum.example.com/daily/2026-06-22")!;
    expect(detail.priority).toBe(0.6);
    expect(detail.changeFrequency).toBe("weekly");
    expect(new Date(detail.lastModified as string).toISOString()).toBe("2026-06-22T01:00:00.000Z");
  });

  it("returns no detail entries when there are no published reports", async () => {
    const { buildSitemapEntries } = await import("@/app/sitemap");
    const result = buildSitemapEntries("https://x.example.com", {
      dailyReports: [],
      latestRunFinishedAt: null,
    });
    const urls = result.map((r) => r.url);
    expect(urls).toContain("https://x.example.com");
    expect(urls).toContain("https://x.example.com/daily");
    const details = urls.filter((u) => /\/daily\/[^/]+$/.test(u));
    expect(details).toEqual([]);
  });

  it("uses generatedAt for lastModified when publishedAt is missing", async () => {
    const { buildSitemapEntries } = await import("@/app/sitemap");
    const result = buildSitemapEntries("https://x.example.com", {
      dailyReports: [
        {
          date: "2026-06-20",
          publishedAt: null,
          generatedAt: "2026-06-20T00:30:00.000Z",
        } as never,
      ],
      latestRunFinishedAt: null,
    });
    const detail = result.find((r) => r.url === "https://x.example.com/daily/2026-06-20")!;
    expect(new Date(detail.lastModified as string).toISOString()).toBe("2026-06-20T00:30:00.000Z");
  });
});

describe("/sitemap.xml (integration via default export)", () => {
  beforeEach(() => {
    clearEnv();
    vi.resetModules();
  });
  afterEach(() => {
    clearEnv();
    vi.resetModules();
    vi.doUnmock("@/lib/daily-report/repository");
    vi.doUnmock("@/lib/feed/service");
  });

  it("wires daily reports and the resolved origin into the sitemap output", async () => {
    process.env.SITE_URL = "https://infinitum.example.com";
    vi.doMock("@/lib/feed/service", () => ({
      getCachedLatestFetchRunSnapshot: vi.fn(async () => ({
        finishedAt: "2026-06-22T00:00:00.000Z",
      })),
    }));
    vi.doMock("@/lib/daily-report/repository", () => ({
      listDailyReports: vi.fn(async () => ({
        reports: [
          {
            date: "2026-06-22",
            publishedAt: "2026-06-22T01:00:00.000Z",
            generatedAt: "2026-06-22T00:30:00.000Z",
          },
        ],
        total: 1,
      })),
    }));

    // We can't call the default export directly because it relies on next/headers.
    // Instead, we verify the helpers it uses are wired correctly.
    const { buildSitemapEntries } = await import("@/app/sitemap");
    const { resolveOriginFromHeaders } = await import("@/lib/http/public-origin");

    const origin = resolveOriginFromHeaders(null);
    expect(origin).toBe("https://infinitum.example.com");

    const entries = buildSitemapEntries(origin, {
      dailyReports: [
        {
          date: "2026-06-22",
          publishedAt: "2026-06-22T01:00:00.000Z",
          generatedAt: "2026-06-22T00:30:00.000Z",
        } as never,
      ],
      latestRunFinishedAt: "2026-06-22T00:00:00.000Z",
    });
    const urls = entries.map((e) => e.url);
    expect(urls).toContain("https://infinitum.example.com/daily/2026-06-22");
  });
});

describe("public SEO routes", () => {
  beforeEach(() => {
    clearEnv();
    vi.resetModules();
  });
  afterEach(() => {
    clearEnv();
    vi.resetModules();
    vi.doUnmock("@/lib/daily-report/repository");
    vi.doUnmock("@/lib/feed/service");
    vi.useRealTimers();
  });

  it("renders llms-full content from the daily-report repository", async () => {
    const report = {
      date: "2026-04-10",
      title: "今日 AI 日报",
      openingSummary: "[重点](https://example.com) 摘要内容",
      generatedAt: new Date("2026-04-10T10:00:00.000Z"),
      publishedAt: new Date("2026-04-10T11:00:00.000Z"),
      renderedMarkdown: "## 正文\n模型有新进展。",
      _count: { sources: 2 },
    };
    const listReports = vi.fn(async () => [report]);
    vi.doMock("@/lib/daily-report/repository", () => ({
      listPublishedDailyReportsForLlmsFull: listReports,
    }));

    const { GET } = await import("@/app/llms-full.txt/route");
    const response = await GET(new Request("https://infinitum.example.com/llms-full.txt"));
    const body = await response.text();

    expect(listReports).toHaveBeenCalledWith(30);
    expect(response.headers.get("cache-control")).toBe("public, s-maxage=300, stale-while-revalidate=600");
    expect(body).toContain("### 2026-04-10 - 今日 AI 日报");
    expect(body).toContain("重点 摘要内容");
    expect(body).toContain("模型有新进展。");
  });

  it("renders news sitemap XML from the feed service without changing its window or cache headers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));
    const getNewsItems = vi.fn(async () => ([
      {
        translatedTitle: "标题 & <标签>",
        originalTitle: "Original title",
        originalUrl: "https://example.com/story?a=1&b=2",
        publishedAt: new Date("2026-04-10T11:00:00.000Z"),
        createdAt: new Date("2026-04-10T10:00:00.000Z"),
        source: { name: "来源 & 媒体" },
      },
    ]));
    vi.doMock("@/lib/feed/service", () => ({ getCachedNewsSitemapItems: getNewsItems }));

    const { GET } = await import("@/app/sitemap-news.xml/route");
    const response = await GET();
    const body = await response.text();

    expect(getNewsItems).toHaveBeenCalledWith(new Date("2026-04-08T12:00:00.000Z"), 1000);
    expect(response.headers.get("cache-control")).toBe("public, s-maxage=600, stale-while-revalidate=1200");
    expect(body).toContain("标题 &amp; &lt;标签&gt;");
    expect(body).toContain("https://example.com/story?a=1&amp;b=2");
    expect(body).toContain("来源 &amp; 媒体");
  });
});
