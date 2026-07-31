import { beforeEach, describe, expect, it, vi } from "vitest";

import { recomputeCluster } from "@/lib/clusters/service";
import { findRecentActiveClusterCandidates } from "@/lib/clusters/repository";
import { prisma } from "@/lib/db";
import { countDisplayItemsCreatedDuringFetchRun, toFetchRunSnapshot } from "@/lib/feed/repository";
import { runIngestion, runIngestionTask, startIngestionTask } from "@/lib/ingestion/service";
import { buildDedupeKeys } from "@/lib/ingestion/dedupe";
import { buildAiProviderMock, buildEventSignature } from "../helpers/ai-provider";

describe("runIngestion", () => {
  beforeEach(async () => {
    await prisma.itemDedupeHistory.deleteMany();
    await prisma.item.deleteMany();
    await prisma.entity.deleteMany();
    await prisma.fetchRun.deleteMany();
    await prisma.backgroundTaskRun.deleteMany();
    await prisma.promptConfig.deleteMany();
    await prisma.modelApiConfig.deleteMany();
    await prisma.contentCluster.deleteMany();
    await prisma.source.deleteMany();
    await prisma.sourceGroup.deleteMany();
    await prisma.blacklistKeyword.deleteMany();
    await prisma.taskSchedule.deleteMany();
  });

  it("creates a queued ingestion background task", async () => {
    const taskRun = await startIngestionTask({ triggerType: "manual" });

    expect(taskRun.kind).toBe("ingestion");
    expect(taskRun.status).toBe("queued");
    expect(taskRun.triggerType).toBe("manual");
  });

  it("records ingestion task progress using item counts instead of source counts", async () => {
    const parser = {
      parseURL: vi.fn().mockResolvedValue({
        items: [
          {
            title: "OpenAI ships a new agent toolkit",
            link: "https://example.com/posts/openai-toolkit",
            isoDate: "2026-04-10T09:00:00.000Z",
            contentSnippet: "Brief summary",
            creator: "Alex",
          },
          {
            title: "Another update on the toolkit",
            link: "https://example.com/posts/openai-toolkit-2",
            isoDate: "2026-04-10T10:00:00.000Z",
            contentSnippet: "Another summary",
            creator: "Jamie",
          },
        ],
      }),
    };
    const aiProvider = buildAiProviderMock({
      summaryFixture: vi.fn().mockResolvedValue({summary: "这篇文章介绍了 OpenAI 新发布的 agent 工具能力。", isAggregation: false}),
      analysisFixture: vi.fn().mockResolvedValue({
        translatedTitle: "OpenAI 发布新的 Agent 工具包",
        moderationStatus: "allowed",
        moderationReason: null,
        moderationDetail: "新闻价值明确",
        qualityScore: 91,
        qualityRationale: "多事实点且时效性强",
        eventSignature: buildEventSignature({
          eventType: "launch",
          eventSubject: "OpenAI",
          eventAction: "发布",
          eventObject: "agent toolkit",
        }),
      }),
      summarizeCluster: vi.fn().mockResolvedValue(JSON.stringify({
        title: "OpenAI 发布新的 Agent 工具包",
        summary: "两篇报道都聚焦 OpenAI 新发布的 agent 工具能力。",
      })),
      matchClusterCandidate: vi.fn().mockImplementation(async (_input: string, metadata: { candidates: Array<{ id: string }> }) => {
        return metadata.candidates[0]?.id ?? null;
      }),
    });
    const taskRun = await startIngestionTask({ triggerType: "manual" });

    await runIngestionTask(taskRun, {
      parser,
      articleFetcher: vi.fn(),
      aiProvider,
      sourceConfigs: [
        {
          name: "Example Feed",
          rssUrl: "https://example.com/feed.xml",
          siteUrl: "https://example.com",
          enabled: true,
          aiParsingEnabled: true,
        },
      ],
      blacklist: [],
      now: new Date("2026-04-10T10:30:00.000Z"),
    });

    const storedTaskRun = await prisma.backgroundTaskRun.findUniqueOrThrow({
      where: { id: taskRun.id },
    });

    expect(storedTaskRun.progressCurrent).toBe(2);
    expect(storedTaskRun.progressTotal).toBe(2);
    expect(storedTaskRun.progressLabel).toBe("已处理 2/2 条内容，来自 1 个源，失败 0 项，正文补抓 0 篇");
    expect(storedTaskRun.aiCallCountActual).toBe(3);
    expect(storedTaskRun.aiCallCountEstimated).toBe(3);
    expect(storedTaskRun.fullTextFetchedCount).toBe(0);
    expect(storedTaskRun.stageTimingsJson).not.toBeNull();
    expect(storedTaskRun.aiCallBreakdownJson).not.toBeNull();
    expect(storedTaskRun.taskTimelineJson).not.toBeNull();

    const stageTimings = JSON.parse(storedTaskRun.stageTimingsJson ?? "[]") as Array<{ key: string; durationMs: number | null }>;
    const aiCallBreakdown = JSON.parse(
      storedTaskRun.aiCallBreakdownJson ?? "[]",
    ) as Array<{ key: string; label: string; actual: number; estimated: number }>;
    const taskTimeline = JSON.parse(
      storedTaskRun.taskTimelineJson ?? "[]",
    ) as Array<{ key: string; status: string; metrics: Array<{ label: string; value: number }> }>;

    expect(stageTimings.map((stageTiming) => stageTiming.key)).toEqual([
      "source_sync",
      "item_processing",
      "cluster_merge",
      "cluster_finalize",
    ]);
    expect(stageTimings.every((stageTiming) => typeof stageTiming.durationMs === "number" || stageTiming.durationMs === null)).toBe(true);
    expect(aiCallBreakdown).toEqual([
      { key: "item_understanding", label: "条目理解", actual: 2, estimated: 2 },
      { key: "cluster_match", label: "聚合匹配", actual: 0, estimated: 0 },
      { key: "cluster_summary", label: "聚合摘要", actual: 1, estimated: 1 },
      { key: "cluster_merge", label: "聚合合并", actual: 0, estimated: 0 },
      { key: "daily_report", label: "AI 日报", actual: 0, estimated: 0 },
    ]);
    expect(taskTimeline.map((node) => node.key)).toEqual([
      "source_fetch",
      "rule_filter",
      "item_understanding",
      "cluster_assignment",
      "cluster_merge",
      "cluster_finalize",
    ]);
    expect(taskTimeline[0]?.metrics).toEqual(expect.arrayContaining([
      { label: "抓取源", value: 1 },
      { label: "失败源", value: 0 },
      { label: "抓取内容", value: 2 },
      { label: "正文补抓", value: 0 },
    ]));
    expect(taskTimeline[0]?.metrics.find((metric) => metric.label === "补抓累计耗时ms")?.value).toEqual(expect.any(Number));
    expect(taskTimeline[1]?.metrics.find((metric) => metric.label === "条目累计耗时ms")?.value).toEqual(expect.any(Number));
    expect(taskTimeline[2]?.metrics).toEqual(expect.arrayContaining([
      { label: "摘要完成", value: 2 },
      { label: "摘要失败", value: 0 },
      { label: "分析完成", value: 2 },
      { label: "分析失败", value: 0 },
      { label: "拆分成功", value: 0 },
      { label: "拆分失败", value: 0 },
      { label: "子事件", value: 0 },
      { label: "过滤", value: 0 },
      { label: "更新/重处理", value: 0 },
    ]));
    expect(taskTimeline[2]?.metrics.find((metric) => metric.label === "累计耗时ms")?.value).toEqual(expect.any(Number));
    expect(taskTimeline[3]?.metrics).toEqual(expect.arrayContaining([
      { label: "指纹命中", value: 1 },
      { label: "本地直连", value: 0 },
      { label: "AI归组", value: 0 },
      { label: "跳过", value: 0 },
      { label: "新建", value: 1 },
    ]));
    expect(taskTimeline[3]?.metrics.find((metric) => metric.label === "累计耗时ms")?.value).toEqual(expect.any(Number));
    expect(taskTimeline[4]?.metrics).toEqual(expect.arrayContaining([
      { label: "送模Pair", value: expect.any(Number) },
      { label: "输入字符", value: expect.any(Number) },
      { label: "刷新数量ms", value: expect.any(Number) },
      { label: "加载候选ms", value: expect.any(Number) },
      { label: "候选计算ms", value: expect.any(Number) },
      { label: "构造输入ms", value: expect.any(Number) },
      { label: "模型调用ms", value: expect.any(Number) },
      { label: "执行合并ms", value: expect.any(Number) },
      { label: "标记Hashms", value: expect.any(Number) },
    ]));
    expect(taskTimeline[5]?.metrics).toEqual([
      { label: "参与重算", value: 1 },
      { label: "完成更新", value: 1 },
      { label: "摘要完成", value: 1 },
      { label: "摘要失败", value: 0 },
      { label: "已删除", value: 0 },
    ]);
  });

  it("derives entity relations from the structured event signature", async () => {
    const parser = {
      parseURL: vi.fn().mockResolvedValue({
        items: [
          {
            title: "OpenAI ships Codex cloud agent",
            link: "https://example.com/posts/openai-codex",
            isoDate: "2026-04-10T09:00:00.000Z",
            contentSnippet: "OpenAI 发布 Codex 云端智能体。",
          },
        ],
      }),
    };
    const aiProvider = buildAiProviderMock({
      summaryFixture: vi.fn().mockResolvedValue({summary: "OpenAI 发布 Codex 云端智能体，面向开发者自动处理编程任务。", isAggregation: false}),
      analysisFixture: vi.fn().mockResolvedValue({
        translatedTitle: "OpenAI 发布 Codex 云端智能体",
        moderationStatus: "allowed",
        moderationReason: null,
        moderationDetail: "产品发布信息明确",
        qualityScore: 90,
        qualityRationale: "具备明确主体和产品对象",
        eventSignature: buildEventSignature({
          eventType: "launch",
          eventSubject: "OpenAI",
          eventAction: "发布",
          eventObject: "Codex 云端智能体",
        }),
        entities: ["OpenAI", "Codex", "新闻", "openai", "AI 编程", "开发者工具", "额外标签"],
      }),
    });

    await runIngestion({
      parser,
      articleFetcher: vi.fn(),
      aiProvider,
      sourceConfigs: [
        {
          name: "Tagged Feed",
          rssUrl: "https://example.com/tagged-feed.xml",
          siteUrl: "https://example.com",
          enabled: true,
          aiParsingEnabled: true,
        },
      ],
      blacklist: [],
      now: new Date("2026-04-10T10:30:00.000Z"),
    });

    const storedItem = await prisma.item.findFirstOrThrow({
      include: {
        entities: {
          include: {
            entity: true,
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });

    expect(storedItem.status).toBe("processed");
    expect(storedItem.entities.map((entry) => entry.entity.name)).toEqual([
      "OpenAI",
      "Codex 云端智能体",
    ]);
    expect(storedItem.entities.map((entry) => entry.entity.normalized)).toEqual([
      "openai",
      "codex 云端智能体",
    ]);
  });

  it("records source fetch failures in the ingestion task timeline", async () => {
    const taskRun = await startIngestionTask({ triggerType: "manual" });
    const parser = {
      parseURL: vi.fn().mockImplementation(async (url: string) => {
        if (url === "https://failed.example.com/feed.xml") {
          throw new Error("RSS fetch failed with status 502");
        }

        return {
          items: [
            {
              title: "OpenAI ships a new agent toolkit",
              link: "https://example.com/posts/openai-toolkit",
              isoDate: "2026-04-10T09:00:00.000Z",
              contentSnippet: "Brief summary",
              creator: "Alex",
            },
          ],
        };
      }),
    };

    await runIngestionTask(taskRun, {
      parser,
      articleFetcher: vi.fn(),
      aiProvider: buildAiProviderMock(),
      sourceConfigs: [
        {
          name: "Healthy Feed",
          rssUrl: "https://example.com/feed.xml",
          siteUrl: "https://example.com",
          enabled: true,
          aiParsingEnabled: true,
        },
        {
          name: "Broken Feed",
          rssUrl: "https://failed.example.com/feed.xml",
          siteUrl: "https://failed.example.com",
          enabled: true,
          aiParsingEnabled: true,
        },
      ],
      blacklist: [],
      now: new Date("2026-04-10T10:30:00.000Z"),
    });

    const storedTaskRun = await prisma.backgroundTaskRun.findUniqueOrThrow({
      where: { id: taskRun.id },
    });
    const taskTimeline = JSON.parse(
      storedTaskRun.taskTimelineJson ?? "[]",
    ) as Array<{ key: string; status: string; metrics: Array<{ label: string; value: number }> }>;
    const sourceFetchNode = taskTimeline.find((node) => node.key === "source_fetch");

    expect(storedTaskRun.status).toBe("partial");
    expect(storedTaskRun.progressLabel).toBe("已处理 1/1 条内容，来自 2 个源，内容失败 0 项，源失败 1 个，正文补抓 0 篇");
    expect(storedTaskRun.errorSummary).toBe("Broken Feed: RSS fetch failed with status 502");
    expect(sourceFetchNode?.status).toBe("partial");
    expect(sourceFetchNode?.metrics).toEqual(expect.arrayContaining([
      { label: "抓取源", value: 2 },
      { label: "失败源", value: 1 },
      { label: "抓取内容", value: 1 },
    ]));
  });

  it("cleans and caps item summary input before calling the model", async () => {
    const longHtmlContent = `<style>.hidden{display:none}</style><!-- internal note --><p>${"这是一段很长的正文内容。".repeat(4_000)}</p><script>window.secret=true</script>`;
    const parser = {
      parseURL: vi.fn().mockResolvedValue({
        items: [
          {
            title: "Long HTML post",
            link: "https://example.com/posts/long-html",
            isoDate: "2026-04-10T09:00:00.000Z",
            "content:encoded": longHtmlContent,
            contentSnippet: "Short excerpt",
          },
        ],
      }),
    };
    const summaryFixture = vi.fn().mockResolvedValue({summary: "清洗后的摘要", isAggregation: false});
    const aiProvider = buildAiProviderMock({
      summaryFixture,
      analysisFixture: vi.fn().mockResolvedValue({
        translatedTitle: null,
        moderationStatus: "allowed",
        moderationReason: null,
        moderationDetail: null,
        qualityScore: 82,
        qualityRationale: "内容完整",
        eventSignature: buildEventSignature({
          eventType: "research",
          eventSubject: "Long HTML post",
        }),
      }),
    });

    await runIngestion({
      parser,
      articleFetcher: vi.fn(),
      aiProvider,
      sourceConfigs: [
        {
          name: "HTML Feed",
          rssUrl: "https://example.com/html-feed.xml",
          siteUrl: "https://example.com",
          enabled: true,
          aiParsingEnabled: true,
          aggregationEnabled: false,
        },
      ],
      blacklist: [],
      fullTextFetchThreshold: Number.MAX_SAFE_INTEGER,
      now: new Date("2026-04-10T10:30:00.000Z"),
    });

    expect(summaryFixture).toHaveBeenCalledTimes(1);
    const summaryInput = summaryFixture.mock.calls[0]?.[0] as string;
    expect(summaryInput.length).toBe(32_000);
    expect(summaryInput).toContain("这是一段很长的正文内容");
    expect(summaryInput).not.toContain("<p>");
    expect(summaryInput).not.toContain("window.secret");
    expect(summaryInput).not.toContain("internal note");
    expect(summaryInput).toContain("[内容过长，已截断用于摘要。]");
  });

  it("does not fetch Weixin RSS HTML through the article fetcher when Jina is enabled", async () => {
    const weixinHtmlContent = `<p>${"这是一段来自微信公众号 RSS 的正文内容。".repeat(40)}</p>`;
    const parser = {
      parseURL: vi.fn().mockResolvedValue({
        items: [
          {
            title: "Weixin long HTML post",
            link: "https://mp.weixin.qq.com/s/example",
            isoDate: "2026-04-10T09:00:00.000Z",
            "content:encoded": weixinHtmlContent,
            contentSnippet: "Short excerpt",
          },
        ],
      }),
    };
    const articleFetcher = vi.fn().mockResolvedValue("Jina warning page should not be stored.");
    const summaryFixture = vi.fn().mockResolvedValue({summary: "RSS HTML 摘要", isAggregation: false});
    const aiProvider = buildAiProviderMock({
      summaryFixture,
      analysisFixture: vi.fn().mockResolvedValue({
        translatedTitle: null,
        moderationStatus: "allowed",
        moderationReason: null,
        moderationDetail: null,
        qualityScore: 82,
        qualityRationale: "内容完整",
        eventSignature: buildEventSignature(),
      }),
    });

    await runIngestion({
      parser,
      articleFetcher,
      aiProvider,
      sourceConfigs: [
        {
          name: "Weixin Feed",
          rssUrl: "https://example.com/weixin-feed.xml",
          siteUrl: "https://mp.weixin.qq.com",
          enabled: true,
          aiParsingEnabled: true,
          aggregationEnabled: false,
        },
      ],
      blacklist: [],
      contentExtraction: {
        jinaEnabled: true,
        jinaBaseUrl: "https://r.jina.ai/",
        jinaApiKey: null,
        timeoutMs: 15_000,
        concurrency: 1,
        rpmLimit: 500,
        maxPerRun: 20,
        minChars: 20,
        maxChars: 32_000,
      },
      now: new Date("2026-04-10T10:30:00.000Z"),
    });

    expect(articleFetcher).not.toHaveBeenCalled();
    const storedItem = await prisma.item.findFirstOrThrow();
    expect(storedItem.fullText).toBeNull();
    expect(storedItem.rssContent).toBe(weixinHtmlContent);
    expect(summaryFixture).toHaveBeenCalledTimes(1);
    expect(summaryFixture.mock.calls[0]?.[0]).toContain("这是一段来自微信公众号 RSS 的正文内容");
  });

  it("counts only processing-start eligible items in task progress and timeline", async () => {
    const parser = {
      parseURL: vi.fn().mockResolvedValue({
        items: [
          {
            title: "Old article before configured processing start",
            link: "https://example.com/posts/old",
            isoDate: "2026-04-10T08:00:00.000Z",
            contentSnippet: "Old summary",
          },
          {
            title: "Fresh article after configured processing start",
            link: "https://example.com/posts/fresh",
            isoDate: "2026-04-10T10:00:00.000Z",
            contentSnippet: "Fresh summary",
          },
        ],
      }),
    };
    const aiProvider = buildAiProviderMock({
      summaryFixture: vi.fn().mockResolvedValue({summary: "这是一条符合处理时间范围的新内容。", isAggregation: false}),
      analysisFixture: vi.fn().mockResolvedValue({
        translatedTitle: "符合处理时间范围的新内容",
        moderationStatus: "allowed",
        moderationReason: null,
        moderationDetail: "新闻价值明确",
        qualityScore: 86,
        qualityRationale: "内容完整",
        eventSignature: buildEventSignature({
          eventType: "update",
          eventSubject: "OpenAI",
          eventAction: "更新",
          eventObject: "产品能力",
        }),
      }),
    });
    const taskRun = await startIngestionTask({ triggerType: "manual" });

    await runIngestionTask(taskRun, {
      parser,
      articleFetcher: vi.fn(),
      aiProvider,
      sourceConfigs: [
        {
          name: "Example Feed",
          rssUrl: "https://example.com/feed.xml",
          siteUrl: "https://example.com",
          enabled: true,
          aiParsingEnabled: true,
        },
      ],
      blacklist: [],
      processingStartAt: new Date("2026-04-10T09:00:00.000Z"),
      now: new Date("2026-04-10T10:30:00.000Z"),
    });

    const [storedTaskRun, storedFetchRun, storedItems] = await Promise.all([
      prisma.backgroundTaskRun.findUniqueOrThrow({ where: { id: taskRun.id } }),
      prisma.fetchRun.findFirstOrThrow({ where: { taskRunId: taskRun.id } }),
      prisma.item.findMany({ orderBy: { publishedAt: "asc" } }),
    ]);
    const taskTimeline = JSON.parse(
      storedTaskRun.taskTimelineJson ?? "[]",
    ) as Array<{ key: string; metrics: Array<{ label: string; value: number }> }>;

    expect(storedTaskRun.progressCurrent).toBe(1);
    expect(storedTaskRun.progressTotal).toBe(1);
    expect(storedTaskRun.progressLabel).toBe("已处理 1/1 条内容，来自 1 个源，失败 0 项，正文补抓 0 篇");
    expect(storedFetchRun.itemCount).toBe(1);
    expect(taskTimeline[0]?.metrics).toEqual(expect.arrayContaining([
      { label: "抓取源", value: 1 },
      { label: "失败源", value: 0 },
      { label: "抓取内容", value: 1 },
      { label: "正文补抓", value: 0 },
    ]));
    expect(storedItems).toHaveLength(1);
    expect(storedItems[0]?.originalUrl).toBe("https://example.com/posts/fresh");
  });

  it("filters the processing window before applying the per-source item limit", async () => {
    const parser = {
      parseURL: vi.fn().mockResolvedValue({
        items: [
          {
            title: "Old article before configured processing start",
            link: "https://example.com/posts/old-before-limit",
            isoDate: "2026-04-10T08:00:00.000Z",
            contentSnippet: "Old summary",
          },
          {
            title: "Fresh article after configured processing start",
            link: "https://example.com/posts/fresh-after-limit",
            isoDate: "2026-04-10T10:00:00.000Z",
            contentSnippet: "Fresh summary",
          },
        ],
      }),
    };

    await runIngestion({
      parser,
      articleFetcher: vi.fn(),
      aiProvider: buildAiProviderMock(),
      sourceConfigs: [{
        name: "Example Feed",
        rssUrl: "https://example.com/feed.xml",
        siteUrl: "https://example.com",
        enabled: true,
        aiParsingEnabled: false,
      }],
      blacklist: [],
      processingStartAt: new Date("2026-04-10T09:00:00.000Z"),
      perSourceItemLimit: 1,
      now: new Date("2026-04-10T10:30:00.000Z"),
    });

    const storedItems = await prisma.item.findMany({ orderBy: { createdAt: "asc" } });
    expect(storedItems).toHaveLength(1);
    expect(storedItems[0]?.originalUrl).toBe("https://example.com/posts/fresh-after-limit");
  });

  it("applies an independent feed scan cap before the per-source processing limit", async () => {
    const parser = {
      parseURL: vi.fn().mockResolvedValue({
        items: [
          {
            title: "Newest article",
            link: "https://example.com/posts/newest",
            isoDate: "2026-04-10T12:00:00.000Z",
            contentSnippet: "Newest summary",
          },
          {
            title: "Second newest article",
            link: "https://example.com/posts/second-newest",
            isoDate: "2026-04-10T11:00:00.000Z",
            contentSnippet: "Second newest summary",
          },
          {
            title: "Third newest article",
            link: "https://example.com/posts/third-newest",
            isoDate: "2026-04-10T10:00:00.000Z",
            contentSnippet: "Third newest summary",
          },
        ],
      }),
    };

    await runIngestion({
      parser,
      articleFetcher: vi.fn(),
      aiProvider: buildAiProviderMock(),
      sourceConfigs: [{
        name: "Example Feed",
        rssUrl: "https://example.com/feed.xml",
        siteUrl: "https://example.com",
        enabled: true,
        aiParsingEnabled: false,
      }],
      blacklist: [],
      maxFeedItemsToScan: 2,
      perSourceItemLimit: 10,
      now: new Date("2026-04-10T12:30:00.000Z"),
    });

    const storedItems = await prisma.item.findMany({
      orderBy: { publishedAt: "desc" },
    });
    expect(storedItems.map((item) => item.originalUrl)).toEqual([
      "https://example.com/posts/newest",
      "https://example.com/posts/second-newest",
    ]);
  });

  it("marks items without a feed publication timestamp as unknown", async () => {
    await runIngestion({
      parser: {
        parseURL: vi.fn().mockResolvedValue({
          items: [{
            title: "Article without publication date",
            link: "https://example.com/posts/unknown-date",
            contentSnippet: "Unknown date summary",
          }],
        }),
      },
      articleFetcher: vi.fn(),
      aiProvider: buildAiProviderMock(),
      sourceConfigs: [{
        name: "Example Feed",
        rssUrl: "https://example.com/feed.xml",
        siteUrl: "https://example.com",
        enabled: true,
        aiParsingEnabled: false,
      }],
      blacklist: [],
      now: new Date("2026-04-10T10:30:00.000Z"),
    });

    const storedItem = await prisma.item.findFirstOrThrow();
    expect(storedItem.publishedAt.toISOString()).toBe("2026-04-10T10:30:00.000Z");
    expect(storedItem.publishedAtKnown).toBe(false);
  });

  it("preserves a trusted publication timestamp when a later RSS refresh omits it", async () => {
    const sourceConfigs = [{
      name: "Example Feed",
      rssUrl: "https://example.com/feed.xml",
      siteUrl: "https://example.com",
      enabled: true,
      aiParsingEnabled: false,
    }];

    await runIngestion({
      parser: {
        parseURL: vi.fn().mockResolvedValue({
          items: [{
            title: "Stable publication date",
            link: "https://example.com/posts/stable-date",
            isoDate: "2026-04-09T10:00:00.000Z",
            contentSnippet: "Initial RSS entry",
          }],
        }),
      },
      articleFetcher: vi.fn(),
      aiProvider: buildAiProviderMock(),
      sourceConfigs,
      blacklist: [],
      now: new Date("2026-04-10T10:30:00.000Z"),
    });

    await runIngestion({
      parser: {
        parseURL: vi.fn().mockResolvedValue({
          items: [{
            title: "Stable publication date",
            link: "https://example.com/posts/stable-date",
            contentSnippet: "Refreshed RSS entry without a publication date",
          }],
        }),
      },
      articleFetcher: vi.fn(),
      aiProvider: buildAiProviderMock(),
      sourceConfigs,
      blacklist: [],
      now: new Date("2026-04-10T12:30:00.000Z"),
    });

    const storedItem = await prisma.item.findFirstOrThrow();
    expect(storedItem.publishedAt.toISOString()).toBe("2026-04-09T10:00:00.000Z");
    expect(storedItem.publishedAtKnown).toBe(true);
  });

  it("normalizes structured RSS authors before storing items", async () => {
    const parser = {
      parseURL: vi.fn().mockResolvedValue({
        items: [
          {
            title: "3 easy ways to shop for spring with Google",
            link: "https://blog.google/products-and-platforms/products/search/spring-fashion-shopping-tips/",
            isoDate: "2026-04-23T16:00:00.000Z",
            contentSnippet: "Shopping tips",
            author: {
              name: ["Megan Stoner"],
              title: ["Keyword Contributor"],
            },
          },
        ],
      }),
    };
    const articleFetcher = vi.fn().mockResolvedValue("Full article fetched even when AI parsing is disabled.");

    const result = await runIngestion({
      trigger: "manual",
      parser,
      articleFetcher,
      aiProvider: buildAiProviderMock(),
      sourceConfigs: [
        {
          name: "The Keyword",
          rssUrl: "https://blog.google/rss/",
          siteUrl: "https://blog.google",
          enabled: true,
          aiParsingEnabled: false,
        },
      ],
      blacklist: [],
      now: new Date("2026-04-24T10:30:00.000Z"),
    });

    const storedItem = await prisma.item.findFirstOrThrow();

    expect(result.status).toBe("succeeded");
    expect(articleFetcher).toHaveBeenCalledWith(
      "https://blog.google/products-and-platforms/products/search/spring-fashion-shopping-tips/",
      expect.objectContaining({ reason: "short_content" }),
    );
    expect(storedItem.author).toBe("Megan Stoner");
    expect(storedItem.fullText).toBe("Full article fetched even when AI parsing is disabled.");
  });

  it("updates the existing item when duplicate feed entries race on the same url hash", async () => {
    const parser = {
      parseURL: vi.fn().mockResolvedValue({
        items: [
          {
            title: "DeepSeek V4 - almost on the frontier",
            link: "https://simonwillison.net/2026/Apr/24/deepseek-v4/",
            isoDate: "2026-04-24T09:00:00.000Z",
            contentSnippet: "First copy",
          },
          {
            title: "DeepSeek V4 - almost on the frontier",
            link: "https://simonwillison.net/2026/Apr/24/deepseek-v4/",
            isoDate: "2026-04-24T09:00:00.000Z",
            contentSnippet: "Second copy",
          },
        ],
      }),
    };

    const result = await runIngestion({
      trigger: "manual",
      parser,
      articleFetcher: vi.fn(),
      aiProvider: buildAiProviderMock(),
      sourceConfigs: [
        {
          name: "Simon Willison's Weblog",
          rssUrl: "https://simonwillison.net/atom/everything/",
          siteUrl: "https://simonwillison.net",
          enabled: true,
          aiParsingEnabled: false,
        },
      ],
      blacklist: [],
      itemConcurrency: 2,
      now: new Date("2026-04-24T10:30:00.000Z"),
    });

    const storedItems = await prisma.item.findMany();

    expect(result.status).toBe("succeeded");
    expect(result.errorSummary).toBeNull();
    expect(storedItems).toHaveLength(1);
    expect(storedItems[0]?.rssExcerpt).toBe("Second copy");
  });

  it("uses conditional RSS metadata to skip unchanged sources", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Cached Feed",
        rssUrl: "https://cached.example.com/feed.xml",
        siteUrl: "https://cached.example.com",
        enabled: true,
        aiParsingEnabled: true,
        feedEtag: "\"etag-1\"",
        feedLastModified: "Wed, 10 Apr 2026 09:00:00 GMT",
      },
    });
    const parser = {
      parseURL: vi.fn().mockResolvedValue({
        notModified: true,
        etag: "\"etag-1\"",
        lastModified: "Wed, 10 Apr 2026 09:00:00 GMT",
        items: [],
      }),
    };
    const aiProvider = buildAiProviderMock();

    const result = await runIngestion({
      trigger: "manual",
      parser,
      articleFetcher: vi.fn(),
      aiProvider,
      sourceConfigs: [
        {
          name: "Cached Feed",
          rssUrl: "https://cached.example.com/feed.xml",
          siteUrl: "https://cached.example.com",
          enabled: true,
          aiParsingEnabled: true,
        },
      ],
      blacklist: [],
      now: new Date("2026-04-10T10:00:00.000Z"),
    });

    expect(result.itemCount).toBe(0);
    expect(parser.parseURL).toHaveBeenCalledWith("https://cached.example.com/feed.xml", {
      headers: {
        "If-None-Match": "\"etag-1\"",
        "If-Modified-Since": "Wed, 10 Apr 2026 09:00:00 GMT",
      },
    });
    expect(aiProvider.understandItem).not.toHaveBeenCalled();
    expect(aiProvider.understandItem).not.toHaveBeenCalled();

    const storedSource = await prisma.source.findUniqueOrThrow({
      where: { id: source.id },
    });
    expect(storedSource.lastFetchedAt?.toISOString()).toBe("2026-04-10T10:00:00.000Z");
  });

  it("commits feed content hashes and skips identical feed payloads on the next run", async () => {
    const feedItems = [
      {
        title: "OpenAI ships a cached toolkit",
        link: "https://example.com/posts/cached-toolkit",
        isoDate: "2026-04-10T09:00:00.000Z",
        contentSnippet: "Brief cached summary",
      },
    ];
    const parser = {
      parseURL: vi.fn().mockResolvedValue({
        etag: "\"etag-2\"",
        lastModified: "Wed, 10 Apr 2026 10:00:00 GMT",
        items: feedItems,
      }),
    };
    const aiProvider = buildAiProviderMock({
      summaryFixture: vi.fn().mockResolvedValue({summary: "缓存内容摘要。", isAggregation: false}),
      analysisFixture: vi.fn().mockResolvedValue({
        translatedTitle: "OpenAI 发布缓存工具包",
        moderationStatus: "allowed",
        moderationReason: null,
        moderationDetail: null,
        qualityScore: 88,
        qualityRationale: "高质量",
        eventSignature: buildEventSignature({
          eventType: "launch",
          eventSubject: "OpenAI",
          eventAction: "发布",
          eventObject: "cached toolkit",
        }),
      }),
      summarizeCluster: vi.fn().mockResolvedValue("不会被二次调用"),
    });
    const sourceConfigs = [
      {
        name: "Example Feed",
        rssUrl: "https://example.com/feed.xml",
        siteUrl: "https://example.com",
        enabled: true,
        aiParsingEnabled: true,
      },
    ];

    const firstRun = await runIngestion({
      trigger: "manual",
      parser,
      articleFetcher: vi.fn(),
      aiProvider,
      sourceConfigs,
      blacklist: [],
      now: new Date("2026-04-10T10:00:00.000Z"),
    });
    const secondRun = await runIngestion({
      trigger: "manual",
      parser,
      articleFetcher: vi.fn(),
      aiProvider,
      sourceConfigs,
      blacklist: [],
      now: new Date("2026-04-10T11:00:00.000Z"),
    });

    expect(firstRun.itemCount).toBe(1);
    expect(secondRun.itemCount).toBe(0);
    expect(aiProvider.understandItem).toHaveBeenCalledTimes(1);
    expect(aiProvider.understandItem).toHaveBeenCalledTimes(1);

    const storedSource = await prisma.source.findFirstOrThrow({
      where: { rssUrl: "https://example.com/feed.xml" },
    });
    expect(storedSource.feedContentHash).not.toBeNull();
    expect(storedSource.lastFetchedAt?.toISOString()).toBe("2026-04-10T11:00:00.000Z");
  });

  it("stops ingestion after a cancellation request", async () => {
    let enrichCallCount = 0;
    const parser = {
      parseURL: vi.fn().mockResolvedValue({
        items: [
          {
            title: "OpenAI ships a new agent toolkit",
            link: "https://example.com/posts/openai-toolkit",
            isoDate: "2026-04-10T09:00:00.000Z",
            contentSnippet: "Brief summary",
            creator: "Alex",
          },
          {
            title: "Another update on the toolkit",
            link: "https://example.com/posts/openai-toolkit-2",
            isoDate: "2026-04-10T10:00:00.000Z",
            contentSnippet: "Another summary",
            creator: "Jamie",
          },
        ],
      }),
    };
    const taskRun = await startIngestionTask({ triggerType: "manual" });
    const aiProvider = buildAiProviderMock({
      summaryFixture: vi.fn().mockResolvedValue({summary: "这篇文章介绍了 OpenAI 新发布的 agent 工具能力。", isAggregation: false}),
      analysisFixture: vi.fn().mockImplementation(async () => {
        enrichCallCount += 1;

        if (enrichCallCount === 1) {
          await prisma.backgroundTaskRun.update({
            where: { id: taskRun.id },
            data: {
              cancelRequestedAt: new Date("2026-04-10T10:31:00.000Z"),
            },
          });
        }

        return {
          translatedTitle: "OpenAI 发布新的 Agent 工具包",
          moderationStatus: "allowed",
          moderationReason: null,
          moderationDetail: "新闻价值明确",
          qualityScore: 91,
          qualityRationale: "多事实点且时效性强",
          eventSignature: buildEventSignature({
            eventType: "launch",
            eventSubject: "OpenAI",
            eventAction: "发布",
            eventObject: "agent toolkit",
          }),
        };
      }),
      summarizeCluster: vi.fn().mockResolvedValue("不会执行到这里"),
      matchClusterCandidate: vi.fn().mockResolvedValue(null),
    });

    await runIngestionTask(taskRun, {
      parser,
      articleFetcher: vi.fn(),
      aiProvider,
      sourceConfigs: [
        {
          name: "Example Feed",
          rssUrl: "https://example.com/feed.xml",
          siteUrl: "https://example.com",
          enabled: true,
          aiParsingEnabled: true,
        },
      ],
      blacklist: [],
      itemConcurrency: 1,
      now: new Date("2026-04-10T10:30:00.000Z"),
    });

    const storedTaskRun = await prisma.backgroundTaskRun.findUniqueOrThrow({
      where: { id: taskRun.id },
    });
    const storedItems = await prisma.item.findMany({
      orderBy: { publishedAt: "asc" },
    });

    expect(storedTaskRun.status).toBe("cancelled");
    expect(storedTaskRun.progressCurrent).toBe(1);
    expect(storedTaskRun.progressTotal).toBe(2);
    expect(storedTaskRun.progressLabel).toBe("任务已终止");
    expect(storedTaskRun.errorSummary).toBe("管理员手动终止任务。");
    expect(storedItems).toHaveLength(1);
  });

  it("stores processed items, preserves filtered items, and records the run", async () => {
    const parser = {
      parseURL: vi.fn().mockResolvedValue({
        items: [
          {
            title: "OpenAI ships a new agent toolkit",
            link: "https://example.com/posts/openai-toolkit?utm_source=rss",
            isoDate: "2026-04-10T09:00:00.000Z",
            contentSnippet: "Brief summary",
            creator: "Alex",
          },
          {
            title: "Another report on OpenAI's agent toolkit",
            link: "https://another.example.com/posts/openai-toolkit",
            isoDate: "2026-04-10T09:30:00.000Z",
            contentSnippet: "Second brief summary",
            creator: "Jamie",
          },
          {
            title: "Market wrap",
            link: "https://example.com/posts/market-wrap",
            isoDate: "2026-04-10T08:00:00.000Z",
            content: "This article discusses layoffs in detail.",
            creator: "Sam",
          },
        ],
      }),
    };

    const articleFetcher = vi
      .fn()
      .mockResolvedValue("A complete article body describing the toolkit release in enough detail to summarize.");

    const aiProvider = buildAiProviderMock({
      summaryFixture: vi.fn().mockImplementation(async (_input: string, metadata: { title: string }) => {
        if (metadata.title === "Market wrap") {
          return {summary: "这是一篇低质量市场综述。", isAggregation: false};
        }

        if (metadata.title === "Another report on OpenAI's agent toolkit") {
          return {summary: "这篇文章从开发者工具角度报道 OpenAI 的 agent 新能力。", isAggregation: false};
        }

        return {summary: "这篇文章介绍了 OpenAI 新发布的 agent 工具能力。", isAggregation: false};
      }),
      analysisFixture: vi.fn().mockImplementation(async (input: string, metadata: { title: string }) => {
        if (metadata.title === "Market wrap") {
          return {
            translatedTitle: null,
            moderationStatus: "filtered",
            moderationReason: "low_quality",
            moderationDetail: "内容过于宽泛且信息增量很低",
            qualityScore: 20,
            qualityRationale: "信息密度低",
            eventSignature: buildEventSignature(),
          };
        }

        if (metadata.title === "Another report on OpenAI's agent toolkit") {
          return {
            translatedTitle: "另一篇关于 OpenAI Agent 工具包的报道",
            moderationStatus: "allowed",
            moderationReason: null,
            moderationDetail: "与首条报道语义接近，但表述不同",
            qualityScore: 87,
            qualityRationale: "事实清晰且信息密度较高",
            eventSignature: buildEventSignature({
              eventType: "launch",
              eventSubject: "OpenAI",
              eventAction: "发布",
              eventObject: "agent toolkit",
            }),
          };
        }

        return {
          translatedTitle: "OpenAI 发布新的 Agent 工具包",
          moderationStatus: "allowed",
          moderationReason: null,
          moderationDetail: "新闻价值明确",
          qualityScore: 91,
          qualityRationale: "多事实点且时效性强",
          eventSignature: buildEventSignature({
            eventType: "launch",
            eventSubject: "OpenAI",
            eventAction: "发布",
            eventObject: "agent toolkit",
          }),
        };
      }),
      summarizeCluster: vi.fn().mockResolvedValue("两篇报道都聚焦 OpenAI 新发布的 agent 工具能力，一篇强调发布本身，另一篇补充开发者工具视角。"),
      matchClusterCandidate: vi.fn().mockImplementation(async (_input: string, metadata: { candidates: Array<{ id: string }> }) => {
        return metadata.candidates[0]?.id ?? null;
      }),
    });

    const result = await runIngestion({
      trigger: "manual",
      parser,
      articleFetcher,
      aiProvider,
      sourceConfigs: [
        {
          name: "Example Feed",
          rssUrl: "https://example.com/feed.xml",
          siteUrl: "https://example.com",
          enabled: true,
          aiParsingEnabled: true,
        },
      ],
      blacklist: ["layoffs"],
      now: new Date("2026-04-10T10:00:00.000Z"),
    });

    expect(result.status).toBe("succeeded");
    expect(result.successCount).toBe(2);
    expect(result.failureCount).toBe(0);
    expect(parser.parseURL).toHaveBeenCalledWith("https://example.com/feed.xml", { headers: {} });
    expect(articleFetcher).toHaveBeenCalledTimes(2);
    expect(aiProvider.understandItem).toHaveBeenCalledTimes(2);
    expect(aiProvider.matchClusterCandidate).not.toHaveBeenCalled();

    const storedItems = await prisma.item.findMany({
      orderBy: { publishedAt: "desc" },
      include: { source: true },
    });
    const primaryToolkitItem = storedItems.find((storedItem) => storedItem.originalTitle === "OpenAI ships a new agent toolkit");
    const secondaryToolkitItem = storedItems.find(
      (storedItem) => storedItem.originalTitle === "Another report on OpenAI's agent toolkit",
    );
    const filteredItem = storedItems.find((storedItem) => storedItem.originalTitle === "Market wrap");

    expect(storedItems).toHaveLength(3);
    expect(primaryToolkitItem?.translatedTitle).toBe("OpenAI 发布新的 Agent 工具包");
    expect(primaryToolkitItem?.summaryText).toBe("这篇文章介绍了 OpenAI 新发布的 agent 工具能力。");
    expect(primaryToolkitItem?.status).toBe("processed");
    expect(primaryToolkitItem?.moderationStatus).toBe("allowed");
    expect(primaryToolkitItem?.qualityScore).toBe(91);
    expect(primaryToolkitItem?.eventType).toBe("launch");
    expect(primaryToolkitItem?.eventSubject).toBe("OpenAI");
    expect(primaryToolkitItem?.eventAction).toBe("发布");
    expect(primaryToolkitItem?.eventObject).toBe("agent toolkit");
    expect(secondaryToolkitItem?.clusterId).toBe(primaryToolkitItem?.clusterId);
    expect(secondaryToolkitItem?.moderationStatus).toBe("allowed");
    expect(filteredItem?.status).toBe("filtered");
    expect(filteredItem?.moderationStatus).toBe("filtered");
    expect(filteredItem?.moderationReason).toBe("rule_filter");

    const storedCluster = await prisma.contentCluster.findUnique({
      where: {
        id: primaryToolkitItem?.clusterId ?? "",
      },
    });

    expect(storedCluster).not.toBeNull();
    expect(storedCluster?.itemCount).toBe(2);
    expect(storedCluster?.status).toBe("active");
    expect(storedCluster?.eventType).toBe("launch");
    expect(storedCluster?.eventSubject).toBe("OpenAI");
    expect(storedCluster?.eventAction).toBe("发布");
    expect(storedCluster?.eventObject).toBe("agent toolkit");

    const latestRun = await prisma.fetchRun.findFirst({ orderBy: { startedAt: "desc" } });
    expect(latestRun?.triggerType).toBe("manual");
    expect(latestRun?.status).toBe("succeeded");
  });

  it("does not cluster items that only share a broad topic but not the same event", async () => {
    const parser = {
      parseURL: vi.fn().mockResolvedValue({
        items: [
          {
            title: "Anthropic launches managed agents",
            link: "https://example.com/posts/managed-agents",
            isoDate: "2026-04-10T09:00:00.000Z",
            contentSnippet: "Managed agents launch brief",
            creator: "Alex",
          },
          {
            title: "Microsoft releases agent framework",
            link: "https://example.com/posts/agent-framework",
            isoDate: "2026-04-10T09:30:00.000Z",
            contentSnippet: "Agent framework launch brief",
            creator: "Jamie",
          },
        ],
      }),
    };

    const aiProvider = buildAiProviderMock({
      summaryFixture: vi.fn().mockImplementation(async (_input: string, metadata: { title: string }) => {
        if (metadata.title === "Microsoft releases agent framework") {
          return {summary: "这篇文章报道微软发布新的 agent framework。", isAggregation: false};
        }

        return {summary: "这篇文章报道 Anthropic 推出 managed agents。", isAggregation: false};
      }),
      analysisFixture: vi.fn().mockImplementation(async (_input: string, metadata: { title: string }) => {
        if (metadata.title === "Microsoft releases agent framework") {
          return {
            translatedTitle: "微软发布 Agent Framework",
            moderationStatus: "allowed",
            moderationReason: null,
            moderationDetail: "属于 AI 工具新闻，但与另一条不是同一事件",
            qualityScore: 82,
            qualityRationale: "信息完整且有明确发布动作",
            eventSignature: buildEventSignature({
              eventType: "launch",
              eventSubject: "Microsoft",
              eventAction: "发布",
              eventObject: "agent framework",
            }),
          };
        }

        return {
          translatedTitle: "Anthropic 推出 Managed Agents",
          moderationStatus: "allowed",
          moderationReason: null,
          moderationDetail: "属于 AI 工具新闻，但与另一条不是同一事件",
          qualityScore: 84,
          qualityRationale: "信息完整且有明确发布动作",
          eventSignature: buildEventSignature({
            eventType: "launch",
            eventSubject: "Anthropic",
            eventAction: "推出",
            eventObject: "managed agents",
          }),
        };
      }),
      summarizeCluster: vi.fn().mockResolvedValue("不会被使用"),
      matchClusterCandidate: vi.fn().mockResolvedValue(null),
    });
    await runIngestion({
      trigger: "manual",
      parser,
      articleFetcher: vi.fn(),
      aiProvider,
      sourceConfigs: [
        {
          name: "Example Feed",
          rssUrl: "https://example.com/feed.xml",
          siteUrl: "https://example.com",
          enabled: true,
          aiParsingEnabled: true,
        },
      ],
      blacklist: [],
      now: new Date("2026-04-10T10:00:00.000Z"),
    });

    const storedItems = await prisma.item.findMany({
      orderBy: { publishedAt: "asc" },
    });

    expect(storedItems).toHaveLength(2);
    expect(storedItems[0]?.clusterId).not.toBe(storedItems[1]?.clusterId);
    expect(aiProvider.matchClusterCandidate).not.toHaveBeenCalled();

    const clusterCount = await prisma.contentCluster.count();
    expect(clusterCount).toBe(2);
  });

  it("recalls every active cluster within 7 days instead of truncating to five candidates", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Existing Cluster Feed",
        rssUrl: "https://existing.example.com/feed.xml",
        siteUrl: "https://existing.example.com",
        enabled: true,
        aiParsingEnabled: false,
      },
    });

    for (let index = 0; index < 6; index += 1) {
      const clusterId = `existing-cluster-${index + 1}`;
      await prisma.contentCluster.create({
        data: {
          id: clusterId,
          kind: "topic",
          title: `历史聚合 ${index + 1}`,
          summary: `历史聚合摘要 ${index + 1}`,
          score: 70 + index,
          itemCount: 1,
          latestPublishedAt: new Date(`2026-04-0${index + 4}T09:00:00.000Z`),
          status: "active",
          fingerprint: `existing-fingerprint-${index + 1}`,
        },
      });

      await prisma.item.create({
        data: {
          id: `existing-item-${index + 1}`,
          sourceId: source.id,
          clusterId,
          originalUrl: `https://existing.example.com/posts/${index + 1}`,
          canonicalUrl: `https://existing.example.com/posts/${index + 1}`,
          urlHash: `existing-hash-${index + 1}`,
          originalTitle: `历史事件 ${index + 1}`,
          translatedTitle: `历史事件 ${index + 1}`,
          publishedAt: new Date(`2026-04-0${index + 4}T09:00:00.000Z`),
          summaryText: `历史内容 ${index + 1}`,
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 70 + index,
          qualityRationale: "历史聚合候选",
          language: "zh",
        },
      });
    }

    const candidates = await findRecentActiveClusterCandidates({
      since: new Date("2026-04-03T10:00:00.000Z"),
      until: new Date("2026-04-17T10:00:00.000Z"),
    });

    expect(candidates).toHaveLength(6);
    expect(candidates.map((candidate) => candidate.id)).toContain("existing-cluster-6");
  });

  it("skips cluster match ai when the event signature is incomplete", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Existing Cluster Feed",
        rssUrl: "https://existing.example.com/feed.xml",
        siteUrl: "https://existing.example.com",
        enabled: true,
        aiParsingEnabled: false,
      },
    });

    await prisma.contentCluster.create({
      data: {
        id: "existing-cluster-1",
        kind: "topic",
        title: "历史聚合 1",
        summary: "历史聚合摘要 1",
        score: 70,
        itemCount: 1,
        latestPublishedAt: new Date("2026-04-08T09:00:00.000Z"),
        status: "active",
        fingerprint: "existing-fingerprint-1",
      },
    });

    await prisma.item.create({
      data: {
        id: "existing-item-1",
        sourceId: source.id,
        clusterId: "existing-cluster-1",
        originalUrl: "https://existing.example.com/posts/1",
        canonicalUrl: "https://existing.example.com/posts/1",
        urlHash: "existing-hash-1",
        originalTitle: "历史事件 1",
        translatedTitle: "历史事件 1",
        publishedAt: new Date("2026-04-08T09:00:00.000Z"),
        summaryText: "历史内容 1",
        status: "processed",
        moderationStatus: "allowed",
        qualityScore: 70,
        qualityRationale: "历史聚合候选",
        language: "zh",
      },
    });

    const parser = {
      parseURL: vi.fn().mockImplementation(async (url: string) => {
        if (url === "https://example.com/feed.xml") {
          return {
            items: [
              {
                title: "A signature-light story",
                link: "https://example.com/posts/signature-light-story",
                isoDate: "2026-04-10T10:00:00.000Z",
                contentSnippet: "Fresh story summary",
                creator: "Alex",
              },
            ],
          };
        }

        return { items: [] };
      }),
    };

    const aiProvider = buildAiProviderMock({
      summaryFixture: vi.fn().mockResolvedValue({summary: "这是一条事件签名不完整的新内容。", isAggregation: false}),
      analysisFixture: vi.fn().mockResolvedValue({
        translatedTitle: "事件签名不完整的新内容",
        moderationStatus: "allowed",
        moderationReason: null,
        moderationDetail: "缺少稳定关键对象，不应触发归组 AI 猜测。",
        qualityScore: 81,
        qualityRationale: "事实存在但签名不足",
        eventSignature: buildEventSignature({
          eventType: "launch",
          eventSubject: "OpenAI",
          eventAction: "发布",
          eventObject: null,
        }),
      }),
      summarizeCluster: vi.fn().mockResolvedValue("不会被使用"),
      matchClusterCandidate: vi.fn().mockResolvedValue({summary: "existing-cluster-1", isAggregation: false}),
    });

    await runIngestion({
      trigger: "manual",
      parser,
      articleFetcher: vi.fn(),
      aiProvider,
      sourceConfigs: [
        {
          name: "Example Feed",
          rssUrl: "https://example.com/feed.xml",
          siteUrl: "https://example.com",
          enabled: true,
          aiParsingEnabled: true,
        },
      ],
      blacklist: [],
      now: new Date("2026-04-10T10:30:00.000Z"),
    });

    expect(aiProvider.matchClusterCandidate).not.toHaveBeenCalled();

    const storedItem = await prisma.item.findFirstOrThrow({
      where: { originalTitle: "A signature-light story" },
    });

    expect(storedItem.clusterId).not.toBe("existing-cluster-1");
    expect(storedItem.clusterId).toBeTruthy();

    const pendingCluster = await prisma.contentCluster.findUniqueOrThrow({
      where: { id: storedItem.clusterId! },
    });
    expect(pendingCluster.fingerprint).toBe(`pending-${storedItem.id}`);
    expect(pendingCluster.eventFingerprint).toBeNull();
    expect(pendingCluster.eventBucket).toBeNull();

    const clusterCount = await prisma.contentCluster.count();
    expect(clusterCount).toBe(2);

    expect(storedItem.nextProcessingRetryAt).not.toBeNull();
    expect(storedItem.lastProcessingError).toContain("incomplete_signature");
  });

  it("uses cheap ranking to directly match the strongest cluster without ai", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Existing Cluster Feed",
        rssUrl: "https://existing.example.com/feed.xml",
        siteUrl: "https://existing.example.com",
        enabled: true,
        aiParsingEnabled: false,
      },
    });

    await prisma.contentCluster.create({
      data: {
        id: "strong-cluster",
        kind: "topic",
        title: "OpenAI 发布 toolkit",
        summary: "OpenAI 发布了 toolkit，并披露上线节奏。",
        score: 90,
        itemCount: 1,
        latestPublishedAt: new Date("2026-04-10T08:00:00.000Z"),
        status: "active",
        fingerprint: "manual-strong-cluster",
        eventType: "launch",
        eventSubject: "OpenAI",
        eventAction: "发布",
        eventObject: "toolkit",
        eventDate: "2026-04-10",
      },
    });

    await prisma.item.create({
      data: {
        id: "strong-cluster-item",
        sourceId: source.id,
        clusterId: "strong-cluster",
        originalUrl: "https://existing.example.com/posts/strong",
        canonicalUrl: "https://existing.example.com/posts/strong",
        urlHash: "strong-cluster-hash",
        originalTitle: "OpenAI toolkit launch",
        translatedTitle: "OpenAI toolkit launch",
        publishedAt: new Date("2026-04-10T08:00:00.000Z"),
        summaryText: "OpenAI 发布 toolkit。",
        status: "processed",
        moderationStatus: "allowed",
        qualityScore: 90,
        qualityRationale: "强匹配候选",
        language: "zh",
        eventType: "launch",
        eventSubject: "OpenAI",
        eventAction: "发布",
        eventObject: "toolkit",
        eventDate: "2026-04-10",
      },
    });

    await prisma.contentCluster.create({
      data: {
        id: "weak-cluster",
        kind: "topic",
        title: "OpenAI 发布 pricing",
        summary: "OpenAI 披露 pricing 调整。",
        score: 72,
        itemCount: 1,
        latestPublishedAt: new Date("2026-04-10T07:00:00.000Z"),
        status: "active",
        fingerprint: "manual-weak-cluster",
        eventType: "launch",
        eventSubject: "OpenAI",
        eventAction: "披露",
        eventObject: "pricing",
        eventDate: "2026-04-10",
      },
    });

    await prisma.item.create({
      data: {
        id: "weak-cluster-item",
        sourceId: source.id,
        clusterId: "weak-cluster",
        originalUrl: "https://existing.example.com/posts/weak",
        canonicalUrl: "https://existing.example.com/posts/weak",
        urlHash: "weak-cluster-hash",
        originalTitle: "OpenAI pricing update",
        translatedTitle: "OpenAI pricing update",
        publishedAt: new Date("2026-04-10T07:00:00.000Z"),
        summaryText: "OpenAI 披露 pricing 调整。",
        status: "processed",
        moderationStatus: "allowed",
        qualityScore: 72,
        qualityRationale: "弱匹配候选",
        language: "zh",
        eventType: "launch",
        eventSubject: "OpenAI",
        eventAction: "披露",
        eventObject: "pricing",
        eventDate: "2026-04-10",
      },
    });

    const parser = {
      parseURL: vi.fn().mockImplementation(async (url: string) => {
        if (url === "https://example.com/feed.xml") {
          return {
            items: [
              {
                title: "OpenAI ships a toolkit",
                link: "https://example.com/posts/openai-toolkit-launch",
                isoDate: "2026-04-10T09:00:00.000Z",
                contentSnippet: "Toolkit launch summary",
                creator: "Alex",
              },
            ],
          };
        }

        return { items: [] };
      }),
    };

    const aiProvider = buildAiProviderMock({
      summaryFixture: vi.fn().mockResolvedValue({summary: "OpenAI 发布 toolkit，并强调当天上线。", isAggregation: false}),
      analysisFixture: vi.fn().mockResolvedValue({
        translatedTitle: "OpenAI 发布 toolkit",
        moderationStatus: "allowed",
        moderationReason: null,
        moderationDetail: "与已有 toolkit 事件高度一致。",
        qualityScore: 89,
        qualityRationale: "强匹配",
        eventSignature: buildEventSignature({
          eventType: "launch",
          eventSubject: "OpenAI",
          eventAction: "发布",
          eventObject: "toolkit",
          eventDate: "2026-04-10",
        }),
      }),
      summarizeCluster: vi.fn().mockResolvedValue("不会被使用"),
      matchClusterCandidate: vi.fn().mockResolvedValue({summary: "weak-cluster", isAggregation: false}),
    });

    await runIngestion({
      trigger: "manual",
      parser,
      articleFetcher: vi.fn(),
      aiProvider,
      sourceConfigs: [
        {
          name: "Example Feed",
          rssUrl: "https://example.com/feed.xml",
          siteUrl: "https://example.com",
          enabled: true,
          aiParsingEnabled: true,
        },
      ],
      blacklist: [],
      now: new Date("2026-04-10T10:30:00.000Z"),
    });

    expect(aiProvider.matchClusterCandidate).not.toHaveBeenCalled();

    const storedItem = await prisma.item.findFirstOrThrow({
      where: { originalTitle: "OpenAI ships a toolkit" },
    });

    expect(storedItem.clusterId).toBe("strong-cluster");
  });

  it("sends only the top 10 cheap-ranked candidates to cluster match ai", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Existing Cluster Feed",
        rssUrl: "https://existing.example.com/feed.xml",
        siteUrl: "https://existing.example.com",
        enabled: true,
        aiParsingEnabled: false,
      },
    });

    for (let index = 0; index < 12; index += 1) {
      const clusterId = `ranked-cluster-${index + 1}`;
      const candidatePublishedAt = new Date(Date.UTC(2026, 3, 12, index, 0, 0));
      await prisma.contentCluster.create({
        data: {
          id: clusterId,
          kind: "topic",
          title: `OpenAI 发布 toolkit variant ${index + 1}`,
          summary: `OpenAI 发布 toolkit variant ${index + 1}，聚焦同类产品线。`,
          score: 70 + index,
          itemCount: 1,
          latestPublishedAt: candidatePublishedAt,
          status: "active",
          fingerprint: `manual-ranked-${index + 1}`,
          eventType: "launch",
          eventSubject: "OpenAI",
          eventAction: "发布",
          eventObject: `toolkit variant ${index + 1}`,
        },
      });

      await prisma.item.create({
        data: {
          id: `ranked-item-${index + 1}`,
          sourceId: source.id,
          clusterId,
          originalUrl: `https://existing.example.com/posts/ranked-${index + 1}`,
          canonicalUrl: `https://existing.example.com/posts/ranked-${index + 1}`,
          urlHash: `ranked-hash-${index + 1}`,
          originalTitle: `历史事件 ranked ${index + 1}`,
          translatedTitle: `历史事件 ranked ${index + 1}`,
          publishedAt: candidatePublishedAt,
          summaryText: `历史内容 ranked ${index + 1}`,
          status: "processed",
          moderationStatus: "allowed",
          qualityScore: 70 + index,
          qualityRationale: "cheap ranking 候选",
          language: "zh",
          eventType: "launch",
          eventSubject: "OpenAI",
          eventAction: "发布",
          eventObject: `toolkit variant ${index + 1}`,
        },
      });
    }

    const parser = {
      parseURL: vi.fn().mockImplementation(async (url: string) => {
        if (url === "https://example.com/feed.xml") {
          return {
            items: [
              {
                title: "OpenAI updates toolkit line",
                link: "https://example.com/posts/openai-toolkit-line",
                isoDate: "2026-04-12T10:00:00.000Z",
                contentSnippet: "Toolkit line summary",
                creator: "Alex",
              },
            ],
          };
        }

        return { items: [] };
      }),
    };

    const aiProvider = buildAiProviderMock({
      summaryFixture: vi.fn().mockResolvedValue({summary: "OpenAI 发布 toolkit 产品线的新成员。", isAggregation: false}),
      analysisFixture: vi.fn().mockResolvedValue({
        translatedTitle: "OpenAI 发布 toolkit 产品线新成员",
        moderationStatus: "allowed",
        moderationReason: null,
        moderationDetail: "需要在多个相近候选之间复核。",
        qualityScore: 84,
        qualityRationale: "信息明确",
        eventSignature: buildEventSignature({
          eventType: "launch",
          eventSubject: "OpenAI",
          eventAction: "发布",
          eventObject: "toolkit",
        }),
      }),
      summarizeCluster: vi.fn().mockResolvedValue("不会被使用"),
      matchClusterCandidate: vi.fn().mockImplementation(async (_input: string, metadata: { candidates: Array<{ id: string }> }) => {
        expect(metadata.candidates).toHaveLength(10);
        expect(metadata.candidates[0]?.id).toBe("ranked-cluster-12");
        return metadata.candidates[0]?.id ?? null;
      }),
    });

    await runIngestion({
      trigger: "manual",
      parser,
      articleFetcher: vi.fn(),
      aiProvider,
      sourceConfigs: [
        {
          name: "Example Feed",
          rssUrl: "https://example.com/feed.xml",
          siteUrl: "https://example.com",
          enabled: true,
          aiParsingEnabled: true,
        },
      ],
      blacklist: [],
      now: new Date("2026-04-12T10:30:00.000Z"),
    });

    expect(aiProvider.matchClusterCandidate).toHaveBeenCalledTimes(1);

    const storedItem = await prisma.item.findFirstOrThrow({
      where: { originalTitle: "OpenAI updates toolkit line" },
    });

    expect(storedItem.clusterId).toBe("ranked-cluster-12");
  });

  it("falls back to processed items when article fetch and ai enrichment fail", async () => {
    const parser = {
      parseURL: vi.fn().mockResolvedValue({
        items: [
          {
            title: "OpenAI acquires Example Corp",
            link: "https://example.com/posts/acquisition",
            isoDate: "2026-04-10T09:00:00.000Z",
            contentSnippet: "RSS fallback summary",
            creator: "Alex",
          },
        ],
      }),
    };

    const articleFetcher = vi.fn().mockRejectedValue(new Error("Article fetch failed with status 404"));
    const aiProvider = buildAiProviderMock({
      summaryFixture: vi.fn().mockRejectedValue(new Error("Upstream ai timeout")),
      analysisFixture: vi.fn().mockRejectedValue(new Error("Upstream ai timeout")),
      summarizeCluster: vi.fn().mockResolvedValue("不会被使用"),
      matchClusterCandidate: vi.fn().mockResolvedValue(null),
    });

    const result = await runIngestion({
      trigger: "manual",
      parser,
      articleFetcher,
      aiProvider,
      sourceConfigs: [
        {
          name: "Example Feed",
          rssUrl: "https://example.com/feed.xml",
          siteUrl: "https://example.com",
          enabled: true,
          aiParsingEnabled: true,
        },
      ],
      blacklist: [],
      now: new Date("2026-04-10T10:00:00.000Z"),
    });

    expect(result.status).toBe("failed");
    expect(result.successCount).toBe(0);
    expect(result.failureCount).toBe(1);
    expect(result.errorSummary).toContain("Upstream ai timeout");

    const storedItem = await prisma.item.findFirstOrThrow();
    expect(storedItem.status).toBe("processed");
    expect(storedItem.translatedTitle).toBeNull();
    expect(storedItem.summaryText).toBe("RSS fallback summary");
    expect(storedItem.moderationStatus).toBe("allowed");
    expect(storedItem.qualityScore).toBe(50);
    expect(storedItem.qualityRationale).toBe("AI analysis unavailable");
    expect(storedItem.errorMessage).toContain("Article fetch failed with status 404");
    expect(storedItem.errorMessage).toContain("Upstream ai timeout");
  });

  it("does not store fetched full text as summary when item summarization fails", async () => {
    const parser = {
      parseURL: vi.fn().mockResolvedValue({
        items: [
          {
            title: "OpenAI publishes a research update",
            link: "https://example.com/posts/research-update",
            isoDate: "2026-04-10T09:00:00.000Z",
            content: "",
          },
        ],
      }),
    };
    const fullText = "Fetched article body that should not be displayed as the item summary. ".repeat(40).trim();
    const articleFetcher = vi.fn().mockResolvedValue(fullText);
    const aiProvider = buildAiProviderMock({
      summaryFixture: vi.fn().mockRejectedValue(new Error("Invalid item summary response: expected JSON")),
      analysisFixture: vi.fn().mockRejectedValue(new Error("Upstream ai timeout")),
      summarizeCluster: vi.fn().mockResolvedValue("不会被使用"),
      matchClusterCandidate: vi.fn().mockResolvedValue(null),
    });

    const result = await runIngestion({
      trigger: "manual",
      parser,
      articleFetcher,
      aiProvider,
      sourceConfigs: [
        {
          name: "Example Feed",
          rssUrl: "https://example.com/feed.xml",
          siteUrl: "https://example.com",
          enabled: true,
          aiParsingEnabled: true,
        },
      ],
      blacklist: [],
      now: new Date("2026-04-10T10:00:00.000Z"),
    });

    expect(result.status).toBe("failed");
    expect(result.successCount).toBe(0);
    expect(result.failureCount).toBe(1);
    expect(result.errorSummary).toContain("Invalid item summary response");
    const storedItem = await prisma.item.findFirstOrThrow();
    expect(storedItem.summaryStatus).toBe("failed");
    expect(storedItem.summaryText).toBeNull();
    expect(storedItem.fullText).toBe(fullText);
    expect(storedItem.errorMessage).toContain("Invalid item summary response");
  });

  it("uses source body for enrichment when item summarization fails", async () => {
    const parser = {
      parseURL: vi.fn().mockResolvedValue({
        items: [
          {
            title: "OpenAI publishes another research update",
            link: "https://example.com/posts/research-update-body",
            isoDate: "2026-04-10T09:00:00.000Z",
            content: "",
          },
        ],
      }),
    };
    const fullText = "Detailed fetched article body for downstream enrichment and clustering signals.";
    const analysisFixture = vi.fn().mockResolvedValue({
      translatedTitle: "OpenAI 发布研究更新",
      moderationStatus: "allowed",
      moderationReason: null,
      moderationDetail: null,
      qualityScore: 82,
      qualityRationale: "正文可用于分析",
      eventSignature: buildEventSignature({
        eventType: "research",
        eventSubject: "OpenAI",
        eventAction: "publishes",
        eventObject: "research update",
      }),
      entities: [],
    });
    const aiProvider = buildAiProviderMock({
      summaryFixture: vi.fn().mockRejectedValue(new Error("Invalid item summary response: expected JSON")),
      analysisFixture,
      summarizeCluster: vi.fn().mockResolvedValue("不会被使用"),
      matchClusterCandidate: vi.fn().mockResolvedValue(null),
    });

    await runIngestion({
      trigger: "manual",
      parser,
      articleFetcher: vi.fn().mockResolvedValue(fullText),
      aiProvider,
      sourceConfigs: [
        {
          name: "Example Feed",
          rssUrl: "https://example.com/feed.xml",
          siteUrl: "https://example.com",
          enabled: true,
          aiParsingEnabled: true,
        },
      ],
      blacklist: [],
      now: new Date("2026-04-10T10:00:00.000Z"),
    });

    expect(analysisFixture).toHaveBeenCalledTimes(1);
    expect(analysisFixture.mock.calls[0]?.[0]).toContain(fullText);
    expect(analysisFixture.mock.calls[0]?.[0]).not.toBe("OpenAI publishes another research update");
  });

  it("marks unified understanding partial when one output field is invalid", async () => {
    const parser = {
      parseURL: vi.fn().mockResolvedValue({
        etag: "etag-ai-failure",
        lastModified: "Tue, 21 Apr 2026 10:00:00 GMT",
        items: [
          {
            title: "OpenAI publishes an unreliable model update",
            link: "https://example.com/posts/unreliable-model-update",
            isoDate: "2026-04-21T09:00:00.000Z",
            content: "Model output quality is being evaluated.",
          },
        ],
      }),
    };
    const taskRun = await startIngestionTask({ triggerType: "manual" });

    await runIngestionTask(taskRun, {
      parser,
      articleFetcher: vi.fn(),
      aiProvider: buildAiProviderMock({
        understandItem: vi.fn().mockResolvedValue({
          summary: "",
          translatedTitle: "OpenAI 发布模型更新",
          moderationStatus: "allowed",
          moderationReason: null,
          moderationDetail: null,
          qualityScore: 82,
          qualityRationale: "分析字段有效",
          eventSignature: buildEventSignature({
            eventType: "update",
            eventSubject: "OpenAI",
            eventAction: "发布",
            eventObject: "模型更新",
          }),
          entities: ["OpenAI"],
          aggregation: { isAggregation: false, mainEvent: null, events: [] },
          diagnostics: { summaryValid: false, analysisValid: true, aggregationValid: true },
        }),
      }),
      sourceConfigs: [
        {
          name: "Example Feed",
          rssUrl: "https://example.com/feed.xml",
          siteUrl: "https://example.com",
          enabled: true,
          aiParsingEnabled: true,
        },
      ],
      blacklist: [],
      now: new Date("2026-04-21T10:00:00.000Z"),
    });

    const [storedSource, storedTaskRun] = await Promise.all([
      prisma.source.findFirstOrThrow(),
      prisma.backgroundTaskRun.findUniqueOrThrow({ where: { id: taskRun.id } }),
    ]);
    const taskTimeline = JSON.parse(
      storedTaskRun.taskTimelineJson ?? "[]",
    ) as Array<{ key: string; status: string; metrics: Array<{ label: string; value: number }> }>;

    expect(storedSource.feedEtag).toBe("etag-ai-failure");
    expect(storedSource.feedLastModified).toBe("Tue, 21 Apr 2026 10:00:00 GMT");
    expect(storedSource.feedContentHash).toEqual(expect.any(String));
    expect(storedTaskRun.status).toBe("failed");
    expect(storedTaskRun.progressCurrent).toBe(1);
    expect(storedTaskRun.progressTotal).toBe(1);
    expect(storedTaskRun.progressLabel).toBe("已处理 1/1 条内容，来自 1 个源，失败 1 项，正文补抓 0 篇");
    const understandingNode = taskTimeline.find((node) => node.key === "item_understanding");
    expect(understandingNode?.status).toBe("partial");
    expect(understandingNode?.metrics).toEqual(expect.arrayContaining([
      { label: "摘要失败", value: 1 },
      { label: "分析完成", value: 1 },
    ]));
  });

  it("limits concurrent item processing to the configured concurrency", async () => {
    let activeCalls = 0;
    let maxConcurrentCalls = 0;

    const parser = {
      parseURL: vi.fn().mockResolvedValue({
        items: Array.from({ length: 4 }, (_, index) => ({
          title: `English Headline ${index + 1}`,
          link: `https://example.com/posts/${index + 1}`,
          isoDate: `2026-04-10T0${index}:00:00.000Z`,
          content: "A".repeat(120),
        })),
      }),
    };

    const aiProvider = buildAiProviderMock({
      summaryFixture: vi.fn().mockResolvedValue({summary: "中文摘要", isAggregation: false}),
      analysisFixture: vi.fn().mockImplementation(async () => {
        activeCalls += 1;
        maxConcurrentCalls = Math.max(maxConcurrentCalls, activeCalls);
        await new Promise((resolve) => setTimeout(resolve, 20));
        activeCalls -= 1;

        return {
          translatedTitle: "中文标题",
          moderationStatus: "allowed",
          moderationReason: null,
          moderationDetail: null,
          qualityScore: 80,
          qualityRationale: "高质量",
          eventSignature: buildEventSignature({
            eventType: "other",
            eventSubject: "English Headline",
            eventAction: "报道",
            eventObject: "cluster",
          }),
        };
      }),
      summarizeCluster: vi.fn().mockResolvedValue("聚合摘要"),
      matchClusterCandidate: vi.fn().mockResolvedValue(null),
    });

    await runIngestion({
      trigger: "manual",
      parser,
      articleFetcher: vi.fn(),
      aiProvider,
      sourceConfigs: [
        {
          name: "Example Feed",
          rssUrl: "https://example.com/feed.xml",
          siteUrl: "https://example.com",
          enabled: true,
          aiParsingEnabled: true,
        },
      ],
      blacklist: [],
      now: new Date("2026-04-10T10:00:00.000Z"),
      itemConcurrency: 2,
    });

    expect(maxConcurrentCalls).toBeLessThanOrEqual(2);
    expect(aiProvider.understandItem).toHaveBeenCalledTimes(4);
  });

  it("stores sanitized plain-text summaries when rss content contains html", async () => {
    const parser = {
      parseURL: vi.fn().mockResolvedValue({
        items: [
          {
            title: "Token economics guide",
            link: "https://example.com/posts/token-economics",
            isoDate: "2026-04-10T09:00:00.000Z",
            content: "<p>Token economy summary</p>",
            contentSnippet: "Token economy summary",
          },
        ],
      }),
    };

    const aiProvider = buildAiProviderMock({
      summaryFixture: vi.fn().mockResolvedValue({summary: "<p>Token economy summary</p>", isAggregation: false}),
      analysisFixture: vi.fn().mockResolvedValue({
        translatedTitle: "Token 经济学指南",
        moderationStatus: "allowed",
        moderationReason: null,
        moderationDetail: null,
        qualityScore: 82,
        qualityRationale: "高质量",
        eventSignature: buildEventSignature({
          eventType: "research",
          eventSubject: "Token economy",
          eventAction: "解读",
          eventObject: "explainer",
        }),
      }),
      summarizeCluster: vi.fn().mockResolvedValue("聚合摘要"),
      matchClusterCandidate: vi.fn().mockResolvedValue(null),
    });

    await runIngestion({
      trigger: "manual",
      parser,
      articleFetcher: vi.fn(),
      aiProvider,
      sourceConfigs: [
        {
          name: "Example Feed",
          rssUrl: "https://example.com/feed.xml",
          siteUrl: "https://example.com",
          enabled: true,
          aiParsingEnabled: true,
        },
      ],
      blacklist: [],
      now: new Date("2026-04-10T10:00:00.000Z"),
    });

    const storedItem = await prisma.item.findFirstOrThrow();
    expect(storedItem.summaryText).toBe("Token economy summary");
  });

  it("regenerates an item summary once when the first AI summary is English", async () => {
    const parser = {
      parseURL: vi.fn().mockResolvedValue({
        items: [
          {
            title: "OpenAI ships a new agent toolkit",
            link: "https://example.com/posts/openai-toolkit",
            isoDate: "2026-04-10T09:00:00.000Z",
            contentSnippet: "Brief summary",
          },
        ],
      }),
    };
    const summaryFixture = vi
      .fn()
      .mockResolvedValueOnce({summary: "这篇文章介绍了 OpenAI 面向开发者的新 agent 工具包。", isAggregation: false});
    const aiProvider = buildAiProviderMock({
      summaryFixture,
      analysisFixture: vi.fn().mockResolvedValue({
        translatedTitle: "OpenAI 发布新的 agent 工具包",
        moderationStatus: "allowed",
        moderationReason: null,
        moderationDetail: null,
        qualityScore: 90,
        qualityRationale: "高质量",
        eventSignature: buildEventSignature({
          eventType: "launch",
          eventSubject: "OpenAI",
          eventAction: "发布",
          eventObject: "agent toolkit",
        }),
      }),
      summarizeCluster: vi.fn().mockResolvedValue("聚合摘要"),
      matchClusterCandidate: vi.fn().mockResolvedValue(null),
    });

    await runIngestion({
      trigger: "manual",
      parser,
      articleFetcher: vi.fn(),
      aiProvider,
      sourceConfigs: [
        {
          name: "Example Feed",
          rssUrl: "https://example.com/feed.xml",
          siteUrl: "https://example.com",
          enabled: true,
          aiParsingEnabled: true,
        },
      ],
      blacklist: [],
      now: new Date("2026-04-10T10:00:00.000Z"),
    });

    const storedItem = await prisma.item.findFirstOrThrow();
    // The Chinese retry lives inside the provider; this mock replaces the
    // provider-level summaryFixture, so the mock only needs to run once.
    expect(summaryFixture).toHaveBeenCalledTimes(1);
    expect(storedItem.summaryText).toBe("这篇文章介绍了 OpenAI 面向开发者的新 agent 工具包。");
  });

  it("does not call cluster summary ai for single-item clusters", async () => {
    const parser = {
      parseURL: vi.fn().mockResolvedValue({
        items: [
          {
            title: "Solo launch coverage",
            link: "https://example.com/posts/solo-launch",
            isoDate: "2026-04-10T09:00:00.000Z",
            contentSnippet: "Single item summary",
          },
        ],
      }),
    };

    const summarizeCluster = vi.fn().mockResolvedValue("不应该被调用");
    const aiProvider = buildAiProviderMock({
      summaryFixture: vi.fn().mockResolvedValue({summary: "这是单条内容的摘要。", isAggregation: false}),
      analysisFixture: vi.fn().mockResolvedValue({
        translatedTitle: "单条发布报道",
        moderationStatus: "allowed",
        moderationReason: null,
        moderationDetail: null,
        qualityScore: 82,
        qualityRationale: "高质量",
        eventSignature: buildEventSignature({
          eventType: "launch",
          eventSubject: "OpenAI",
          eventAction: "发布",
          eventObject: "solo launch",
        }),
      }),
      summarizeCluster,
      matchClusterCandidate: vi.fn().mockResolvedValue(null),
    });

    await runIngestion({
      trigger: "manual",
      parser,
      articleFetcher: vi.fn(),
      aiProvider,
      sourceConfigs: [
        {
          name: "Example Feed",
          rssUrl: "https://example.com/feed.xml",
          siteUrl: "https://example.com",
          enabled: true,
          aiParsingEnabled: true,
        },
      ],
      blacklist: [],
      now: new Date("2026-04-10T10:00:00.000Z"),
    });

    expect(summarizeCluster).not.toHaveBeenCalled();

    const storedCluster = await prisma.contentCluster.findFirstOrThrow();
    expect(storedCluster.itemCount).toBe(1);
    expect(storedCluster.summary).toBe("这是单条内容的摘要。");
    expect(storedCluster.title).toBe("OpenAI 发布 solo launch");
  });

  it("regenerates a cluster summary once when the first AI summary is English", async () => {
    const parser = {
      parseURL: vi.fn().mockResolvedValue({
        items: [
          {
            title: "OpenAI ships a new agent toolkit",
            link: "https://example.com/posts/openai-toolkit",
            isoDate: "2026-04-10T09:00:00.000Z",
            contentSnippet: "Brief summary",
          },
          {
            title: "Another report on OpenAI agent toolkit",
            link: "https://example.com/posts/openai-toolkit-2",
            isoDate: "2026-04-10T09:30:00.000Z",
            contentSnippet: "Another brief summary",
          },
        ],
      }),
    };
    const summarizeCluster = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify({
        title: "OpenAI launches agent toolkit",
        summary: "Both reports focus on OpenAI's new agent toolkit for developers.",
      }))
      .mockResolvedValueOnce(JSON.stringify({
        title: "OpenAI 发布 agent toolkit",
        summary: "两篇报道都聚焦 OpenAI 面向开发者发布的新 agent 工具包。",
      }));
    const aiProvider = buildAiProviderMock({
      summaryFixture: vi.fn().mockResolvedValue({summary: "OpenAI 发布 agent toolkit。", isAggregation: false}),
      analysisFixture: vi.fn().mockResolvedValue({
        translatedTitle: "OpenAI 发布 agent toolkit",
        moderationStatus: "allowed",
        moderationReason: null,
        moderationDetail: null,
        qualityScore: 90,
        qualityRationale: "高质量",
        eventSignature: buildEventSignature({
          eventType: "launch",
          eventSubject: "OpenAI",
          eventAction: "发布",
          eventObject: "agent toolkit",
        }),
      }),
      summarizeCluster,
      matchClusterCandidate: vi.fn().mockResolvedValue(null),
    });

    await runIngestion({
      trigger: "manual",
      parser,
      articleFetcher: vi.fn(),
      aiProvider,
      sourceConfigs: [
        {
          name: "Example Feed",
          rssUrl: "https://example.com/feed.xml",
          siteUrl: "https://example.com",
          enabled: true,
          aiParsingEnabled: true,
        },
      ],
      blacklist: [],
      now: new Date("2026-04-10T10:00:00.000Z"),
    });

    const storedCluster = await prisma.contentCluster.findFirstOrThrow();
    expect(summarizeCluster).toHaveBeenCalledTimes(2);
    expect(storedCluster.summary).toBe("两篇报道都聚焦 OpenAI 面向开发者发布的新 agent 工具包。");
  });

  it("skips cluster summary ai when the cluster summary input hash is unchanged", async () => {
    const parser = {
      parseURL: vi.fn().mockResolvedValue({
        items: [
          {
            title: "OpenAI ships a new agent toolkit",
            link: "https://example.com/posts/openai-toolkit",
            isoDate: "2026-04-10T09:00:00.000Z",
            contentSnippet: "Brief summary",
          },
          {
            title: "Another report on OpenAI agent toolkit",
            link: "https://example.com/posts/openai-toolkit-2",
            isoDate: "2026-04-10T09:30:00.000Z",
            contentSnippet: "Another brief summary",
          },
        ],
      }),
    };
    const summarizeCluster = vi.fn().mockResolvedValue(
      JSON.stringify({
        title: "OpenAI 与微软推进 agent toolkit",
        summary: "两篇报道都聚焦 OpenAI agent toolkit。",
      }),
    );
    const aiProvider = buildAiProviderMock({
      summaryFixture: vi.fn().mockResolvedValue({summary: "OpenAI 发布 agent toolkit。", isAggregation: false}),
      analysisFixture: vi.fn().mockResolvedValue({
        translatedTitle: "OpenAI 发布 agent toolkit",
        moderationStatus: "allowed",
        moderationReason: null,
        moderationDetail: null,
        qualityScore: 90,
        qualityRationale: "高质量",
        eventSignature: buildEventSignature({
          eventType: "launch",
          eventSubject: "OpenAI",
          eventAction: "发布",
          eventObject: "agent toolkit",
        }),
      }),
      summarizeCluster,
      matchClusterCandidate: vi.fn().mockResolvedValue(null),
    });

    await runIngestion({
      trigger: "manual",
      parser,
      articleFetcher: vi.fn(),
      aiProvider,
      sourceConfigs: [
        {
          name: "Example Feed",
          rssUrl: "https://example.com/feed.xml",
          siteUrl: "https://example.com",
          enabled: true,
          aiParsingEnabled: true,
        },
      ],
      blacklist: [],
      now: new Date("2026-04-10T10:00:00.000Z"),
    });

    const storedCluster = await prisma.contentCluster.findFirstOrThrow();
    expect(storedCluster.summaryInputHash).not.toBeNull();
    expect(storedCluster.title).toBe("OpenAI 与微软推进 agent toolkit");
    expect(storedCluster.summary).toBe("两篇报道都聚焦 OpenAI agent toolkit。");
    expect(summarizeCluster).toHaveBeenCalledOnce();

    await recomputeCluster(storedCluster.id, aiProvider);

    expect(summarizeCluster).toHaveBeenCalledOnce();
  });

  it("normalizes noisy event signatures before exact cluster matching", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Existing Cluster Feed",
        rssUrl: "https://existing.example.com/feed.xml",
        siteUrl: "https://existing.example.com",
        enabled: true,
        aiParsingEnabled: false,
      },
    });

    await prisma.contentCluster.create({
      data: {
        id: "normalized-cluster",
        kind: "topic",
        title: "OpenAI 发布 Agents SDK",
        summary: "OpenAI 发布了 Agents SDK。",
        score: 88,
        itemCount: 1,
        latestPublishedAt: new Date("2026-04-10T08:00:00.000Z"),
        status: "active",
        fingerprint: "launch-openai-发布-agents-sdk-2026-04-10",
        eventType: "launch",
        eventSubject: "OpenAI",
        eventAction: "发布",
        eventObject: "Agents SDK",
        eventDate: "2026-04-10",
      },
    });

    await prisma.item.create({
      data: {
        id: "normalized-cluster-item",
        sourceId: source.id,
        clusterId: "normalized-cluster",
        originalUrl: "https://existing.example.com/posts/agents-sdk",
        canonicalUrl: "https://existing.example.com/posts/agents-sdk",
        urlHash: "normalized-cluster-hash",
        originalTitle: "OpenAI launches Agents SDK",
        translatedTitle: "OpenAI launches Agents SDK",
        publishedAt: new Date("2026-04-10T08:00:00.000Z"),
        summaryText: "OpenAI 发布 Agents SDK。",
        status: "processed",
        moderationStatus: "allowed",
        qualityScore: 88,
        qualityRationale: "历史强匹配候选",
        language: "en",
        eventType: "launch",
        eventSubject: "OpenAI",
        eventAction: "发布",
        eventObject: "Agents SDK",
        eventDate: "2026-04-10",
      },
    });

    const parser = {
      parseURL: vi.fn().mockImplementation(async (url: string) => {
        if (url === "https://example.com/feed.xml") {
          return {
            items: [
              {
                title: "OpenAI formally launches a new SDK",
                link: "https://example.com/posts/openai-formal-sdk-launch",
                isoDate: "2026-04-10T09:00:00.000Z",
                contentSnippet: "SDK launch summary",
                creator: "Alex",
              },
            ],
          };
        }

        return { items: [] };
      }),
    };

    const aiProvider = buildAiProviderMock({
      summaryFixture: vi.fn().mockResolvedValue({summary: "OpenAI 正式发布新版 Agents SDK 服务。", isAggregation: false}),
      analysisFixture: vi.fn().mockResolvedValue({
        translatedTitle: "OpenAI 正式发布新版 Agents SDK 服务",
        moderationStatus: "allowed",
        moderationReason: null,
        moderationDetail: "与已有 SDK 发布事件一致。",
        qualityScore: 89,
        qualityRationale: "高质量",
        eventSignature: buildEventSignature({
          eventType: "launch",
          eventSubject: "OpenAI 公司",
          eventAction: "正式发布",
          eventObject: "新版 Agents SDK 服务",
          eventDate: "2026-04-10",
        }),
      }),
      summarizeCluster: vi.fn().mockResolvedValue("不会被使用"),
      matchClusterCandidate: vi.fn().mockResolvedValue(null),
    });
    await runIngestion({
      trigger: "manual",
      parser,
      articleFetcher: vi.fn(),
      aiProvider,
      sourceConfigs: [
        {
          name: "Example Feed",
          rssUrl: "https://example.com/feed.xml",
          siteUrl: "https://example.com",
          enabled: true,
          aiParsingEnabled: true,
        },
      ],
      blacklist: [],
      now: new Date("2026-04-10T10:00:00.000Z"),
    });

    expect(aiProvider.matchClusterCandidate).not.toHaveBeenCalled();

    const storedItem = await prisma.item.findFirstOrThrow({
      where: { originalTitle: "OpenAI formally launches a new SDK" },
    });
    const storedCluster = await prisma.contentCluster.findUniqueOrThrow({
      where: { id: "normalized-cluster" },
    });

    expect(storedItem.clusterId).toBe("normalized-cluster");
    expect(storedCluster.eventSubject).toBe("OpenAI");
    expect(storedCluster.eventAction).toBe("发布");
    expect(storedCluster.eventObject).toBe("Agents SDK");
  });

  it("reuses a completed existing item by URL even when RSS metadata changes", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Example Feed",
        rssUrl: "https://example.com/feed.xml",
        siteUrl: "https://example.com",
        enabled: true,
        aiParsingEnabled: false,
      },
    });
    const publishedAt = new Date("2026-04-10T09:00:00.000Z");
    const originalUrl = "https://example.com/posts/openai-toolkit";
    const originalTitle = "OpenAI ships a new agent toolkit";
    const rssContent = "Brief summary";
    const rssExcerpt = "Brief summary";
    const dedupeKeys = buildDedupeKeys({
      canonicalUrl: originalUrl,
    });
    const existingItem = await prisma.item.create({
      data: {
        sourceId: source.id,
        originalUrl,
        canonicalUrl: dedupeKeys.canonicalUrl,
        urlHash: dedupeKeys.urlHash,
        originalTitle,
        translatedTitle: "OpenAI 发布新的 Agent 工具包",
        author: "Alex",
        publishedAt,
        rssExcerpt,
        rssContent,
        summaryText: "保留已有摘要",
        status: "processed",
        summaryStatus: "succeeded",
        analysisStatus: "succeeded",
        moderationStatus: "allowed",
        qualityScore: 91,
        qualityRationale: "多事实点且时效性强",
        aiProcessedAt: new Date("2026-04-10T09:05:00.000Z"),
      },
    });

    const parser = {
      parseURL: vi.fn().mockResolvedValue({
        items: [
          {
            title: "OpenAI formally launches an updated agent toolkit",
            link: originalUrl,
            isoDate: "2026-04-10T09:30:00.000Z",
            contentSnippet: "Updated RSS summary with new facts",
            creator: "Alex",
          },
        ],
      }),
    };
    const aiProvider = buildAiProviderMock({
      summaryFixture: vi.fn().mockResolvedValue({summary: "不应该被调用", isAggregation: false}),
      analysisFixture: vi.fn().mockResolvedValue({
        translatedTitle: "不应该被调用",
        moderationStatus: "allowed",
        moderationReason: null,
        moderationDetail: null,
        qualityScore: 99,
        qualityRationale: "不应该被调用",
        eventSignature: buildEventSignature(),
      }),
      summarizeCluster: vi.fn().mockResolvedValue("不会被使用"),
      matchClusterCandidate: vi.fn().mockResolvedValue(null),
    });
    await runIngestion({
      trigger: "manual",
      parser,
      articleFetcher: vi.fn(),
      aiProvider,
      sourceConfigs: [
        {
          name: "Example Feed",
          rssUrl: "https://example.com/feed.xml",
          siteUrl: "https://example.com",
          enabled: true,
          aiParsingEnabled: true,
        },
      ],
      blacklist: [],
      now: new Date("2026-04-10T10:00:00.000Z"),
    });

    expect(aiProvider.understandItem).not.toHaveBeenCalled();

    const storedItem = await prisma.item.findFirstOrThrow({
      where: { sourceId: source.id },
    });
    expect(storedItem.summaryText).toBe("保留已有摘要");
    expect(storedItem.qualityScore).toBe(91);
    expect(storedItem.updatedAt.getTime()).toBe(existingItem.updatedAt.getTime());
  });

  it("skips feed items whose dedupe keys were archived by item cleanup", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Example Feed",
        rssUrl: "https://example.com/feed.xml",
        siteUrl: "https://example.com",
        enabled: true,
        aiParsingEnabled: true,
      },
    });
    const publishedAt = new Date("2026-04-10T09:00:00.000Z");
    const originalUrl = "https://example.com/posts/old-but-still-in-rss";
    const originalTitle = "Old story still present in RSS";
    const dedupeKeys = buildDedupeKeys({
      canonicalUrl: originalUrl,
    });

    await prisma.itemDedupeHistory.create({
      data: {
        sourceId: source.id,
        sourceName: source.name,
        originalUrl,
        canonicalUrl: dedupeKeys.canonicalUrl,
        urlHash: dedupeKeys.urlHash,
        originalTitle,
        publishedAt,
        firstSeenAt: new Date("2026-04-10T09:01:00.000Z"),
        lastSeenAt: new Date("2026-04-10T09:02:00.000Z"),
        archivedAt: new Date("2026-06-01T00:00:00.000Z"),
      },
    });

    const parser = {
      parseURL: vi.fn().mockResolvedValue({
        items: [
          {
            title: originalTitle,
            link: originalUrl,
            isoDate: "2026-04-10T09:00:00.000Z",
            contentSnippet: "This old item is still inside the fixed RSS window.",
            creator: "Alex",
          },
        ],
      }),
    };
    const aiProvider = buildAiProviderMock({
      summaryFixture: vi.fn().mockResolvedValue({summary: "不应该被调用", isAggregation: false}),
      analysisFixture: vi.fn().mockResolvedValue({
        translatedTitle: "不应该被调用",
        moderationStatus: "allowed",
        moderationReason: null,
        moderationDetail: null,
        qualityScore: 99,
        qualityRationale: "不应该被调用",
        eventSignature: buildEventSignature(),
      }),
    });

    const run = await runIngestion({
      trigger: "manual",
      parser,
      articleFetcher: vi.fn(),
      aiProvider,
      sourceConfigs: [
        {
          name: "Example Feed",
          rssUrl: "https://example.com/feed.xml",
          siteUrl: "https://example.com",
          enabled: true,
          aiParsingEnabled: true,
        },
      ],
      blacklist: [],
      now: new Date("2026-06-30T10:00:00.000Z"),
    });

    expect(run.itemCount).toBe(0);
    expect(run.itemsAdded).toBe(0);
    expect(await prisma.item.count()).toBe(0);
    expect(aiProvider.understandItem).not.toHaveBeenCalled();
    expect(aiProvider.understandItem).not.toHaveBeenCalled();
  });

  it("reruns unified understanding when any field group previously failed", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Example Feed",
        rssUrl: "https://example.com/feed.xml",
        siteUrl: "https://example.com",
        enabled: true,
        aiParsingEnabled: false,
      },
    });
    const publishedAt = new Date("2026-04-10T09:00:00.000Z");
    const originalUrl = "https://example.com/posts/openai-toolkit";
    const originalTitle = "OpenAI ships a new agent toolkit";
    const rssContent = "Brief summary";
    const dedupeKeys = buildDedupeKeys({
      canonicalUrl: originalUrl,
    });

    await prisma.item.create({
      data: {
        sourceId: source.id,
        originalUrl,
        canonicalUrl: dedupeKeys.canonicalUrl,
        urlHash: dedupeKeys.urlHash,
        originalTitle,
        translatedTitle: null,
        author: "Alex",
        publishedAt,
        rssExcerpt: rssContent,
        rssContent,
        summaryText: "保留已有摘要",
        status: "processed",
        summaryStatus: "succeeded",
        analysisStatus: "failed",
        moderationStatus: "allowed",
        qualityScore: 50,
        qualityRationale: "AI analysis unavailable",
        aiProcessedAt: null,
        errorMessage: "Invalid AI enrichment response after retry.",
      },
    });

    const parser = {
      parseURL: vi.fn().mockResolvedValue({
        items: [
          {
            title: originalTitle,
            link: originalUrl,
            isoDate: "2026-04-10T09:00:00.000Z",
            contentSnippet: rssContent,
            creator: "Alex",
          },
        ],
      }),
    };
    const aiProvider = buildAiProviderMock({
      summaryFixture: vi.fn().mockResolvedValue({summary: "新的统一摘要", isAggregation: false}),
      analysisFixture: vi.fn().mockResolvedValue({
        translatedTitle: "OpenAI 发布新的 Agent 工具包",
        moderationStatus: "allowed",
        moderationReason: null,
        moderationDetail: "信息充足",
        qualityScore: 92,
        qualityRationale: "分析补齐成功",
        eventSignature: buildEventSignature({
          eventType: "launch",
          eventSubject: "OpenAI",
          eventAction: "发布",
          eventObject: "agent toolkit",
        }),
      }),
      summarizeCluster: vi.fn().mockResolvedValue("不会被使用"),
      matchClusterCandidate: vi.fn().mockResolvedValue(null),
    });
    const taskRun = await startIngestionTask({ triggerType: "manual" });

    await runIngestionTask(taskRun, {
      parser,
      articleFetcher: vi.fn(),
      aiProvider,
      sourceConfigs: [
        {
          name: "Example Feed",
          rssUrl: "https://example.com/feed.xml",
          siteUrl: "https://example.com",
          enabled: true,
          aiParsingEnabled: true,
        },
      ],
      blacklist: [],
      now: new Date("2026-04-10T10:00:00.000Z"),
    });

    expect(aiProvider.understandItem).toHaveBeenCalledOnce();
    const storedTaskRun = await prisma.backgroundTaskRun.findUniqueOrThrow({
      where: { id: taskRun.id },
    });
    const latestAiBreakdown = JSON.parse(storedTaskRun.aiCallBreakdownJson ?? "[]") as Array<{
      key: string;
      actual: number;
      estimated: number;
    }>;
    expect(latestAiBreakdown.find((entry) => entry.key === "item_understanding")).toMatchObject({
      actual: 1,
      estimated: 1,
    });

    const storedItem = await prisma.item.findFirstOrThrow({
      where: { sourceId: source.id },
    });
    expect(storedItem.summaryText).toBe("新的统一摘要");
    expect(storedItem.summaryStatus).toBe("succeeded");
    expect(storedItem.analysisStatus).toBe("succeeded");
    expect(storedItem.qualityScore).toBe(92);
    expect(storedItem.errorMessage).toBeNull();
  });

  it("preserves a manual cluster assignment when the source disables automatic aggregation", async () => {
    const source = await prisma.source.create({
      data: {
        name: "Manual Feed",
        rssUrl: "https://manual.example.com/feed.xml",
        siteUrl: "https://manual.example.com",
        enabled: true,
        aiParsingEnabled: false,
        aggregationEnabled: false,
      },
    });
    const manualCluster = await prisma.contentCluster.create({
      data: {
        id: "manual-target-cluster",
        kind: "topic",
        title: "管理员指定聚合",
        summary: "管理员指定聚合摘要",
        score: 75,
        itemCount: 1,
        latestPublishedAt: new Date("2026-04-10T09:00:00.000Z"),
        status: "active",
        fingerprint: "manual-target-cluster",
      },
    });
    const publishedAt = new Date("2026-04-10T09:00:00.000Z");
    const originalUrl = "https://manual.example.com/posts/manual";
    const originalTitle = "Manually grouped story";
    const dedupeKeys = buildDedupeKeys({
      canonicalUrl: originalUrl,
    });

    await prisma.item.create({
      data: {
        sourceId: source.id,
        clusterId: manualCluster.id,
        manualClusterAssignedAt: new Date("2026-04-10T09:10:00.000Z"),
        originalUrl,
        canonicalUrl: dedupeKeys.canonicalUrl,
        urlHash: dedupeKeys.urlHash,
        originalTitle,
        translatedTitle: null,
        author: "Alex",
        publishedAt,
        rssExcerpt: "Old manual summary",
        rssContent: "Old manual summary",
        summaryText: "Old manual summary",
        status: "processed",
        summaryStatus: "pending",
        analysisStatus: "pending",
        moderationStatus: "allowed",
        qualityScore: 50,
        qualityRationale: "AI parsing disabled for this source",
      },
    });

    const parser = {
      parseURL: vi.fn().mockResolvedValue({
        items: [
          {
            title: originalTitle,
            link: originalUrl,
            isoDate: "2026-04-10T09:00:00.000Z",
            contentSnippet: "Updated manual summary",
            creator: "Alex",
          },
        ],
      }),
    };
    const aiProvider = buildAiProviderMock({
      summaryFixture: vi.fn().mockResolvedValue({summary: "不应该被调用", isAggregation: false}),
      analysisFixture: vi.fn().mockResolvedValue({
        translatedTitle: "不应该被调用",
        moderationStatus: "allowed",
        moderationReason: null,
        moderationDetail: null,
        qualityScore: 99,
        qualityRationale: "不应该被调用",
        eventSignature: buildEventSignature(),
      }),
      summarizeCluster: vi.fn().mockResolvedValue("不会被使用"),
      matchClusterCandidate: vi.fn().mockResolvedValue(null),
    });

    await runIngestion({
      trigger: "manual",
      parser,
      articleFetcher: vi.fn(),
      aiProvider,
      sourceConfigs: [
        {
          name: source.name,
          rssUrl: source.rssUrl,
          siteUrl: source.siteUrl,
          enabled: true,
          aiParsingEnabled: false,
          aggregationEnabled: false,
        },
      ],
      blacklist: [],
      now: new Date("2026-04-10T10:00:00.000Z"),
    });

    expect(aiProvider.matchClusterCandidate).not.toHaveBeenCalled();

    const storedItem = await prisma.item.findFirstOrThrow({
      where: { sourceId: source.id },
    });
    const clusterCount = await prisma.contentCluster.count();

    expect(storedItem.clusterId).toBe(manualCluster.id);
    expect(storedItem.manualClusterAssignedAt).toBeInstanceOf(Date);
    expect(storedItem.rssExcerpt).toBe("Updated manual summary");
    expect(clusterCount).toBe(1);
  });

  it("uses database-backed runtime settings when explicit ingestion options are omitted", async () => {
    const modelConfig = await prisma.modelApiConfig.create({
      data: {
        name: "数据库默认模型",
        baseUrl: "https://db.example.com/v1",
        apiKey: "sk-db",
        modelName: "gpt-db",
        ingestionItemConcurrency: 5,
        isEnabled: true,
        isDefault: true,
      },
    });

    await prisma.promptConfig.createMany({
      data: [
        {
          name: "数据库默认条目摘要提示词",
          type: "item_understanding",
          prompt: "标题：{{title}}\n来源：{{sourceName}}\n正文：{{inputText}}",
          systemPrompt: "数据库条目摘要提示词",
          isEnabled: true,
          isDefault: true,
        },
        {
          name: "数据库默认内容分析提示词",
          type: "item_understanding",
          prompt: "标题：{{title}}\n正文：{{inputText}}",
          systemPrompt: "数据库内容分析提示词",
          modelApiConfigId: modelConfig.id,
          isEnabled: true,
          isDefault: true,
        },
        {
          name: "数据库默认聚合摘要提示词",
          type: "cluster_summary",
          prompt: "主题：{{title}}\n候选内容：{{inputText}}",
          systemPrompt: "数据库聚合摘要提示词",
          isEnabled: true,
          isDefault: true,
        },
        {
          name: "数据库默认归组判定提示词",
          type: "cluster_match",
          prompt: "当前内容标题：{{title}}\n候选聚合组：{{candidatesJson}}",
          systemPrompt: "数据库归组判定提示词",
          isEnabled: true,
          isDefault: true,
        },
      ],
    });

    await prisma.blacklistKeyword.create({
      data: {
        keyword: "blocked",
      },
    });

    await prisma.source.create({
      data: {
        name: "Database Feed",
        rssUrl: "https://db.example.com/feed.xml",
        siteUrl: "https://db.example.com",
        enabled: true,
        aiParsingEnabled: true,
      },
    });

    const parser = {
      parseURL: vi.fn().mockResolvedValue({
        items: [
          {
            title: "Database-configured story",
            link: "https://db.example.com/posts/1",
            isoDate: "2026-04-10T09:00:00.000Z",
            content: "Body from database-driven ingestion settings",
          },
        ],
      }),
    };

    const aiProvider = buildAiProviderMock({
      summaryFixture: vi.fn().mockResolvedValue({summary: "数据库中的运行时配置已生效。", isAggregation: false}),
      analysisFixture: vi.fn().mockResolvedValue({
        translatedTitle: "数据库驱动的标题",
        moderationStatus: "allowed",
        moderationReason: null,
        moderationDetail: null,
        qualityScore: 80,
        qualityRationale: "高质量",
        eventSignature: buildEventSignature({
          eventType: "other",
          eventSubject: "Database configured story",
          eventAction: "报道",
          eventObject: "story",
        }),
      }),
      summarizeCluster: vi.fn().mockResolvedValue("聚合摘要"),
      matchClusterCandidate: vi.fn().mockResolvedValue(null),
    });

    const result = await runIngestion({
      trigger: "manual",
      parser,
      articleFetcher: vi.fn(),
      aiProvider,
      now: new Date("2026-04-10T10:00:00.000Z"),
    });

    expect(result.status).toBe("succeeded");
    expect(parser.parseURL).toHaveBeenCalledWith("https://db.example.com/feed.xml", { headers: {} });
    expect(aiProvider.understandItem).toHaveBeenCalledOnce();
  });

  it("persists parsed aggregation events without moving duplicate fingerprints across items", async () => {
    const parser = {
      parseURL: vi.fn().mockImplementation(async (url: string) => ({
        items: [
          {
            title: url.includes("source-b") ? "AI funding and product roundup" : "AI weekly launch roundup",
            link: url.includes("source-b") ? "https://source-b.example.com/roundup" : "https://source-a.example.com/roundup",
            isoDate: url.includes("source-b") ? "2026-04-10T09:05:00.000Z" : "2026-04-10T09:00:00.000Z",
            content: url.includes("source-b")
              ? "A market roundup covers the same OpenAI Toolkit launch and Anthropic Console update from another source."
              : `A developer roundup covers
                <a href="https://tracking.tldrnewsletter.com/CL0/https:%2F%2Fopenai.com%2Ftoolkit%3Futm_source=tldrdev/1/test">OpenAI Toolkit launch</a>
                and Anthropic Console update.`,
          },
        ],
      })),
    };
    const aggregationFixture = vi.fn().mockResolvedValue({
      mainEvent: {
        eventType: "launch",
        eventSubject: "OpenAI",
        eventAction: "发布",
        eventObject: "Toolkit",
        eventDate: "2026-04-10",
      },
      events: [
        {
          eventType: "launch",
          eventSubject: "OpenAI",
          eventAction: "发布",
          eventObject: "Toolkit",
          eventDate: "2026-04-10",
          title: "OpenAI 推出 Toolkit",
          oneLiner: "OpenAI 发布 Toolkit",
          qualityScore: 92,
          sourceUrl: null,
        },
        {
          eventType: "update",
          eventSubject: "Anthropic",
          eventAction: "更新",
          eventObject: "Console",
          eventDate: "2026-04-10",
          title: "Anthropic 更新 Console",
          oneLiner: "Anthropic 更新 Console",
          qualityScore: 84,
          sourceUrl: "https://source.example.com/",
        },
      ],
    });
    const aiProvider = buildAiProviderMock({
      summaryFixture: vi.fn().mockResolvedValue({ summary: "这是一篇聚合简报。", isAggregation: true }),
      aggregationFixture,
      analysisFixture: vi.fn().mockResolvedValue({
        translatedTitle: "不应调用",
        moderationStatus: "allowed",
        moderationReason: null,
        moderationDetail: null,
        qualityScore: 50,
        qualityRationale: "不应调用",
        eventSignature: buildEventSignature(),
      }),
      summarizeCluster: vi.fn().mockResolvedValue("聚合事件摘要"),
      matchClusterCandidate: vi.fn().mockResolvedValue(null),
    });
    const createItemSpy = vi.spyOn(prisma.item, "create");

    const taskRun = await startIngestionTask({ triggerType: "manual" });
    await runIngestionTask(taskRun, {
      trigger: "manual",
      parser,
      articleFetcher: vi.fn(),
      aiProvider,
      sourceConfigs: [
        {
          name: "Aggregation Feed A",
          rssUrl: "https://source-a.example.com/feed.xml",
          siteUrl: "https://source-a.example.com",
          enabled: true,
          aiParsingEnabled: true,
          aggregationEnabled: false,
          aggregationDetectionEnabled: true,
        },
        {
          name: "Aggregation Feed B",
          rssUrl: "https://source-b.example.com/feed.xml",
          siteUrl: "https://source-b.example.com",
          enabled: true,
          aiParsingEnabled: true,
          aggregationEnabled: false,
          aggregationDetectionEnabled: true,
        },
      ],
      blacklist: [],
      now: new Date("2026-04-10T10:00:00.000Z"),
    });

    // Parents (isAggregation=true) + 2 child items per parent = 2 + 4 = 6 rows.
    const items = await prisma.item.findMany({
      orderBy: [{ isAggregation: "desc" }, { originalUrl: "asc" }],
    });
    const parents = items.filter((item) => item.isAggregation);
    const children = items.filter((item) => !item.isAggregation);
    const storedTaskRun = await prisma.backgroundTaskRun.findUniqueOrThrow({
      where: { id: taskRun.id },
    });
    const storedFetchRun = await prisma.fetchRun.findFirstOrThrow({
      where: { taskRunId: taskRun.id },
    });
    const displayItemsAdded = await countDisplayItemsCreatedDuringFetchRun(storedFetchRun);
    const runSnapshot = toFetchRunSnapshot(storedFetchRun, { itemsAdded: displayItemsAdded });
    const taskTimeline = JSON.parse(
      storedTaskRun.taskTimelineJson ?? "[]",
    ) as Array<{ key: string; metrics: Array<{ label: string; value: number }> }>;

    expect(parents).toHaveLength(2);
    expect(parents.every((item) => item.aggregationParseStatus === "parsed")).toBe(true);
    expect(parents.every((item) => item.clusterId === null)).toBe(true);
    expect(children).toHaveLength(4);
    expect(children.every((child) => child.parentItemId !== null)).toBe(true);
    expect(new Set(children.map((child) => child.parentItemId)).size).toBe(2);
    expect(children.some((child) => child.originalTitle === "OpenAI 推出 Toolkit")).toBe(true);
    expect(children.some((child) => child.originalUrl === "https://source-a.example.com/roundup")).toBe(true);
    // Each parent produced 2 children sharing the same fingerprint namespace.
    expect(children.every((child) => Boolean(child.summaryText && child.summaryText.length > 0))).toBe(true);
    expect(children.every((child) => child.status === "processed")).toBe(true);
    expect(new Set(children.map((child) => child.clusterId)).size).toBe(2);
    const toolkitClusterIds = new Set(
      children.filter((child) => child.originalTitle === "OpenAI 推出 Toolkit").map((child) => child.clusterId),
    );
    const consoleClusterIds = new Set(
      children.filter((child) => child.originalTitle === "Anthropic 更新 Console").map((child) => child.clusterId),
    );
    expect(toolkitClusterIds.size).toBe(1);
    expect(consoleClusterIds.size).toBe(1);
    expect(displayItemsAdded).toBe(4);
    expect(runSnapshot.itemsAdded).toBe(4);
    expect(taskTimeline.find((node) => node.key === "item_understanding")?.metrics).toEqual(expect.arrayContaining([
      { label: "拆分成功", value: 2 },
      { label: "拆分失败", value: 0 },
      { label: "子事件", value: 4 },
    ]));
    expect(taskTimeline.find((node) => node.key === "cluster_assignment")?.metrics).toEqual(expect.arrayContaining([
      { label: "指纹命中", value: 2 },
      { label: "AI归组", value: 0 },
      { label: "新建", value: 2 },
    ]));
    expect(aggregationFixture.mock.calls.map((call) => call[0]).join("\n")).toContain(
      "OpenAI Toolkit launch (link: https://openai.com/toolkit?utm_source=tldrdev)",
    );
    expect(createItemSpy).toHaveBeenCalledTimes(2);
    expect(aiProvider.understandItem).toHaveBeenCalledTimes(2);
    expect(aiProvider.summarizeCluster).toHaveBeenCalledTimes(2);
    expect(aiProvider.matchClusterCandidate).not.toHaveBeenCalled();
  });

  it("falls back to normal enrichment when aggregation parsing returns no events", async () => {
    const parser = {
      parseURL: vi.fn().mockResolvedValue({
        items: [
          {
            title: "Empty aggregation parse",
            link: "https://agg.example.com/empty",
            isoDate: "2026-04-10T09:00:00.000Z",
            content: "The model may fail to split this roundup.",
          },
        ],
      }),
    };
    const analysisFixture = vi.fn().mockResolvedValue({
      translatedTitle: "空拆条兜底",
      moderationStatus: "allowed",
      moderationReason: null,
      moderationDetail: null,
      qualityScore: 77,
      qualityRationale: "兜底分析成功",
      eventSignature: buildEventSignature({
        eventType: "other",
        eventSubject: "Roundup",
        eventAction: "分析",
        eventObject: "fallback",
      }),
    });

    await runIngestion({
      trigger: "manual",
      parser,
      articleFetcher: vi.fn(),
      aiProvider: buildAiProviderMock({
        summaryFixture: vi.fn().mockResolvedValue({ summary: "这是一篇聚合简报。", isAggregation: true }),
        aggregationFixture: vi.fn().mockResolvedValue({ mainEvent: null, events: [] }),
        analysisFixture,
      }),
      sourceConfigs: [
        {
          name: "Aggregation Feed",
          rssUrl: "https://agg.example.com/feed.xml",
          siteUrl: "https://agg.example.com",
          enabled: true,
          aiParsingEnabled: true,
          aggregationDetectionEnabled: true,
        },
      ],
      blacklist: [],
      now: new Date("2026-04-10T10:00:00.000Z"),
    });

    const item = await prisma.item.findFirstOrThrow();

    expect(analysisFixture).toHaveBeenCalledOnce();
    // Empty parse failure degrades the parent to a regular item.
    expect(item.isAggregation).toBe(false);
    expect(item.aggregationParseStatus).toBe("failed");
    expect(item.analysisStatus).toBe("succeeded");
    expect(await prisma.item.count({ where: { parentItemId: item.id } })).toBe(0);
  });

  it("retries aggregation parsing on a later ingestion when a previous run failed", async () => {
    // First parser run returns the roundup, aggregationFixture fails.
    // Second parser run returns the same roundup, aggregationFixture now succeeds.
    // The follow-up ingestion must NOT be dedupe-filtered by urlHash; it must
    // re-enter the aggregation branch and persist child items.
    const buildRoundupItem = (contentBody: string) => ({
      title: "Weekly AI roundup",
      link: "https://agg.example.com/roundup-retry",
      isoDate: "2026-04-10T09:00:00.000Z",
      content: contentBody,
    });
    // First run sees a shorter excerpt; the second run fetches the same URL with
    // updated content so the feedContentHash differs (avoiding the
    // unchanged-source short-circuit) and the item is routed to the processor.
    const parser = {
      parseURL: vi
        .fn()
        .mockResolvedValueOnce({ items: [buildRoundupItem("Roundup body.")] })
        .mockResolvedValueOnce({ items: [buildRoundupItem("Roundup body with multiple events to split.")] }),
    };
    const aggregationFixtureSuccess = vi.fn().mockResolvedValue({
      mainEvent: {
        eventType: "release",
        eventSubject: "OpenAI",
        eventAction: "汇总发布",
        eventObject: "Toolkit",
        eventDate: "2026-04-10",
      },
      events: [
        {
          eventType: "release",
          eventSubject: "OpenAI",
          eventAction: "发布",
          eventObject: "Toolkit",
          eventDate: "2026-04-10",
          oneLiner: "OpenAI 推出 Toolkit",
          qualityScore: 80,
          fingerprint: "toolkit-2026-04-10",
        },
        {
          eventType: "update",
          eventSubject: "Anthropic",
          eventAction: "更新",
          eventObject: "Claude",
          eventDate: "2026-04-10",
          oneLiner: "Anthropic 更新 Claude",
          qualityScore: 75,
          fingerprint: "claude-2026-04-10",
        },
      ],
    });
    const aggregationFixtureFailure = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient model error"));

    const sourceConfigs = [
      {
        name: "Aggregation Retry Feed",
        rssUrl: "https://agg.example.com/feed.xml",
        siteUrl: "https://agg.example.com",
        enabled: true,
        aiParsingEnabled: true,
        aggregationDetectionEnabled: true,
      },
    ];

    // First run: aggregationFixture fails, item should be left in failed state.
    await runIngestion({
      trigger: "manual",
      parser,
      articleFetcher: vi.fn(),
      aiProvider: buildAiProviderMock({
        summaryFixture: vi.fn().mockResolvedValue({ summary: "这是一篇聚合简报。", isAggregation: true }),
        aggregationFixture: aggregationFixtureFailure,
      }),
      sourceConfigs,
      blacklist: [],
      now: new Date("2026-04-10T10:00:00.000Z"),
    });

    const firstRunParent = await prisma.item.findFirstOrThrow({
      where: { originalUrl: "https://agg.example.com/roundup-retry" },
    });
    expect(firstRunParent.isAggregation).toBe(false);
    expect(firstRunParent.aggregationParseStatus).toBe("failed");
    expect(await prisma.item.count({ where: { parentItemId: firstRunParent.id } })).toBe(0);

    // Second run on the same feed: aggregationFixture now succeeds, and the item
    // must not be silently dropped by the urlHash dedupe gate.
    await runIngestion({
      trigger: "manual",
      parser,
      articleFetcher: vi.fn(),
      aiProvider: buildAiProviderMock({
        summaryFixture: vi.fn().mockResolvedValue({ summary: "这是一篇聚合简报。", isAggregation: true }),
        aggregationFixture: aggregationFixtureSuccess,
      }),
      sourceConfigs,
      blacklist: [],
      now: new Date("2026-04-10T10:00:01.000Z"),
    });

    const secondRunParent = await prisma.item.findFirstOrThrow({
      where: { originalUrl: "https://agg.example.com/roundup-retry" },
    });
    expect(secondRunParent.aggregationParseStatus).toBe("parsed");
    expect(secondRunParent.isAggregation).toBe(true);
    expect(aggregationFixtureSuccess).toHaveBeenCalledTimes(1);
    const children = await prisma.item.findMany({
      where: { parentItemId: secondRunParent.id },
    });
    expect(children).toHaveLength(2);
    expect(children.map((child) => child.originalTitle).sort()).toEqual([
      "Anthropic 更新 Claude",
      "OpenAI 推出 Toolkit",
    ]);
  });
});
