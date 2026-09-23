import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({ runtimeConfig: null as unknown, rssItems: [] as unknown[] }));

vi.mock("@/lib/ai/provider-next", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createAiProvider: (_config: unknown, _prompts: unknown, _client: unknown, options?: {
    onUsage?: (usage: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      cachedTokens: number;
      cachedTokensReported: boolean;
      tokenUsageSource: "provider";
    }, usageKey?: string) => void;
  }) => new Proxy({}, {
    get: (_target, property) => {
      if (property === "assessEntityAliasPairs") {
        return async (input: { pairs: Array<{ aName: string; bName: string }> }) => {
          options?.onUsage?.({
            promptTokens: 640,
            completionTokens: 90,
            totalTokens: 730,
            cachedTokens: 0,
            cachedTokensReported: false,
            tokenUsageSource: "provider",
          }, "entity_alias_check");
          return input.pairs.map(() => ({ isSameEntity: false, confidence: "high", canonicalName: null }));
        };
      }
      return vi.fn(async () => null);
    },
  }),
}));

vi.mock("@/lib/items/service", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveAiProvider: vi.fn(async (_provider: unknown, options?: {
    onUsage?: (usage: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      cachedTokens: number;
      cachedTokensReported: boolean;
      tokenUsageSource: "provider";
    }, usageKey?: string) => void;
  }) => ({
    understandItem: vi.fn(async () => {
      options?.onUsage?.({
        promptTokens: 310,
        completionTokens: 70,
        totalTokens: 380,
        cachedTokens: 12,
        cachedTokensReported: true,
        tokenUsageSource: "provider",
      }, "item_understanding");
      return {
        summary: "测试摘要",
        translatedTitle: "测试中文标题",
        moderationStatus: "allowed",
        moderationReason: null,
        moderationDetail: null,
        qualityScore: 80,
        qualityRationale: "测试",
        eventSignature: { eventType: null, eventSubject: null, eventAction: null, eventObject: null, eventDate: null },
        aggregation: { isAggregation: false, mainEvent: null, events: [] },
        diagnostics: { summaryValid: true, analysisValid: true, aggregationValid: true },
      };
    }),
  })),
  generateItemReanalysisUnderstanding: vi.fn(async (_itemId: string, options: { aiProvider: { understandItem: () => Promise<unknown> } }) =>
    options.aiProvider.understandItem()),
  generateItemRegenerationUnderstanding: vi.fn(async (_item: unknown, options: { aiProvider: { understandItem: () => Promise<unknown> } }) =>
    options.aiProvider.understandItem()),
}));

vi.mock("@/lib/ingestion/parser", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createRssParser: () => ({ parseURL: vi.fn(async () => ({ items: mockState.rssItems })) }),
}));

vi.mock("@/lib/settings/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/settings/service")>();
  return {
    ...actual,
    getIngestionRuntimeConfig: vi.fn(async () => mockState.runtimeConfig
      ?? actual.getIngestionRuntimeConfig()),
  };
});

vi.mock("@/lib/entities/service", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  autoNormalizeEntityAliases: vi.fn(async (_now: Date, aiProvider?: {
    assessEntityAliasPairs?: (input: { pairs: Array<{ aName: string; bName: string; evidence: string[] }> }) => Promise<unknown>;
  }) => {
    await aiProvider?.assessEntityAliasPairs?.({ pairs: [{ aName: "A", bName: "B", evidence: [] }] });
    return {
      result: { candidatePairs: 1, adjudicatedPairs: 1, autoMergedAliases: 0, mediumSuggestions: 0 },
      mediumRecords: [],
    };
  }),
}));

// vitest 环境下 Mastra step 内读取 settings 会悬挂（真实 worker 无此问题），
// cluster 摘要用例改为注入 stub provider，只验证 tracker + 用量投影接线。
vi.mock("@/lib/clusters/service", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveClusterSummaryProvider: vi.fn(async (options?: {
    onUsage?: (usage: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      cachedTokens: number;
      cachedTokensReported: boolean;
      tokenUsageSource: "provider";
    }, usageKey?: string) => void;
  }) => ({
    summarizeCluster: vi.fn(async () => {
      options?.onUsage?.({
        promptTokens: 420,
        completionTokens: 80,
        totalTokens: 500,
        cachedTokens: 0,
        cachedTokensReported: false,
        tokenUsageSource: "provider",
      }, "cluster_summary");
      return null;
    }),
  })),
}));

import { prisma } from "@/lib/db";
import { triggerTaskWorkflow } from "@/lib/ai-orchestration/runtime";
import {
  createItemReanalyzeWorkflowDefinition,
  createItemRegenerationWorkflowDefinition,
} from "@/lib/workflows/items";

describe("Mastra staged task workflows", () => {
  beforeEach(async () => {
    mockState.runtimeConfig = null;
    mockState.rssItems = [];
    await prisma.item.deleteMany();
    await prisma.fetchRun.deleteMany();
    await prisma.backgroundTaskRun.deleteMany();
    await prisma.source.deleteMany();
    await prisma.sourceGroup.deleteMany();
    await prisma.taskSchedule.deleteMany();
    await prisma.clusterMergeCleanPairCandidate.deleteMany();
    await prisma.entitySuggestionCandidate.deleteMany();
  });

  it("executes every item-cleanup stage and persists the framework checkpoint", async () => {
    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "item_cleanup",
        triggerType: "manual",
        status: "queued",
        label: "清理过期条目",
      },
    });

    const result = await triggerTaskWorkflow("item_cleanup", taskRun.id);
    const stored = await prisma.backgroundTaskRun.findUniqueOrThrow({ where: { id: taskRun.id } });
    const checkpoint = JSON.parse(stored.pipelineCheckpointJson ?? "{}");

    expect(result.status).toBe("succeeded");
    expect(stored.status).toBe("succeeded");
    expect(checkpoint.__mastra.step.stepId).toBe("item_cleanup-cluster_finalize");
    expect(checkpoint.__mastra.lifecycle.event).toBe("finish");
    expect(stored.progressLabel).toBe("编排运行中");
    const stageTimings = JSON.parse(stored.stageTimingsJson ?? "[]") as Array<{ key: string; status?: string }>;
    expect(stageTimings).toHaveLength(3);
    expect(stageTimings.every((timing) => timing.status === "succeeded")).toBe(true);
  });

  it("does not resume a terminal task row through a Mastra workflow", async () => {
    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "item_cleanup",
        triggerType: "manual",
        status: "failed",
        label: "已失败任务",
        progressLabel: "已结束",
        errorSummary: "prior failure",
        finishedAt: new Date(),
      },
    });

    const result = await triggerTaskWorkflow("item_cleanup", taskRun.id);
    const stored = await prisma.backgroundTaskRun.findUniqueOrThrow({ where: { id: taskRun.id } });

    expect(result.status).toBe("failed");
    expect(stored.status).toBe("failed");
    expect(stored.progressLabel).toBe("已结束");
    expect(stored.errorSummary).toBe("prior failure");
    expect(stored.pipelineCheckpointJson).toBeNull();
  });

  it("does not resume a terminal staged daily report task", async () => {
    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "daily_report_generate",
        triggerType: "manual",
        status: "cancelled",
        label: "已取消日报",
        finishedAt: new Date(),
      },
    });

    const result = await triggerTaskWorkflow("daily_report_generate", taskRun.id);
    const stored = await prisma.backgroundTaskRun.findUniqueOrThrow({ where: { id: taskRun.id } });

    expect(result.status).toBe("cancelled");
    expect(stored.status).toBe("cancelled");
    expect(stored.pipelineCheckpointJson).toBeNull();
  });

  it("persists cancellation for a queued staged task before business side effects", async () => {
    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "item_cleanup",
        triggerType: "manual",
        status: "queued",
        label: "清理过期条目",
        cancelRequestedAt: new Date(),
      },
    });

    const result = await triggerTaskWorkflow("item_cleanup", taskRun.id);
    const stored = await prisma.backgroundTaskRun.findUniqueOrThrow({ where: { id: taskRun.id } });
    const checkpoint = JSON.parse(stored.pipelineCheckpointJson ?? "{}");

    expect(result.status).toBe("cancelled");
    expect(stored.status).toBe("cancelled");
    expect(checkpoint.__mastra.lifecycle.event).toBe("cancel");
  });

  it("runs recovery through batch and persist stages when no candidates are due", async () => {
    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "item_processing_recovery",
        triggerType: "manual",
        status: "queued",
        label: "抓取失败补偿",
      },
    });

    const result = await triggerTaskWorkflow("item_processing_recovery", taskRun.id);
    const stored = await prisma.backgroundTaskRun.findUniqueOrThrow({ where: { id: taskRun.id } });
    const checkpoint = JSON.parse(stored.pipelineCheckpointJson ?? "{}");

    expect(result.status).toBe("succeeded");
    expect(stored.status).toBe("succeeded");
    expect(checkpoint.__mastra.step.stepId).toBe("item_processing_recovery-recovery_persist");
  });

  it("runs ingestion through the four declared stages with an empty source set", async () => {
    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "ingestion",
        triggerType: "manual",
        status: "queued",
        label: "默认抓取任务",
      },
    });

    const result = await triggerTaskWorkflow("ingestion", taskRun.id);
    const stored = await prisma.backgroundTaskRun.findUniqueOrThrow({ where: { id: taskRun.id } });
    const fetchRun = await prisma.fetchRun.findFirst({ where: { taskRunId: taskRun.id } });

    expect(result.status).toBe("succeeded");
    expect(stored.status).toBe("succeeded");
    expect(fetchRun?.status).toBe("succeeded");
    expect(JSON.parse(stored.pipelineCheckpointJson ?? "{}").__mastra.step.stepId).toBe("ingestion-cluster_finalize");
    const timeline = JSON.parse(stored.taskTimelineJson ?? "[]") as Array<{
      key: string;
      metrics: Array<{ label: string; value: number }>;
    }>;
    expect(timeline.map((node) => node.key)).toEqual([
      "source_fetch",
      "rule_filter",
      "item_understanding",
      "cluster_assignment",
      "cluster_merge",
      "cluster_finalize",
    ]);
    expect(timeline.every((node) => node.metrics.length > 0)).toBe(true);
    expect(stored.progressLabel).not.toContain("步骤 ingestion-");
  });

  it("projects per-node ingestion counters through the Mastra workflow", async () => {
    mockState.runtimeConfig = {
      modelApi: { apiKey: "", baseURL: "https://example.invalid/v1", model: "test-model", customHeaders: {} },
      selectedPromptConfigs: {},
      embedding: null,
      rssSources: [{
        name: "Mastra test source",
        rssUrl: "https://mastra-test.example/rss",
        siteUrl: "https://mastra-test.example",
        enabled: true,
        aiParsingEnabled: false,
        aggregationEnabled: false,
        aggregationDetectionEnabled: false,
      }],
      ingestion: {
        sourceConcurrency: 1,
        itemConcurrency: 1,
        fullTextFetchThreshold: 80,
        perSourceItemLimit: 10,
        maxFeedItemsToScan: 10,
        aggregationSplitMaxEvents: 20,
      },
      contentExtraction: { jinaEnabled: false, jinaBaseUrl: "https://r.jina.ai/", jinaApiKey: null, timeoutMs: 1000, concurrency: 1, rpmLimit: 10, maxPerRun: 10, minChars: 500, maxChars: 2000 },
    };
    mockState.rssItems = [{
      title: "Mastra ingestion timeline fixture",
      link: "https://mastra-test.example/story/1",
      pubDate: "2026-09-22T12:00:00.000Z",
      contentSnippet: "This is a sufficiently long fixture body for the ingestion timeline test. ".repeat(3),
    }];
    const taskRun = await prisma.backgroundTaskRun.create({
      data: { kind: "ingestion", triggerType: "manual", status: "queued", label: "抓取任务" },
    });

    const result = await triggerTaskWorkflow("ingestion", taskRun.id);
    const stored = await prisma.backgroundTaskRun.findUniqueOrThrow({ where: { id: taskRun.id } });
    const timeline = JSON.parse(stored.taskTimelineJson ?? "[]") as Array<{
      key: string;
      metrics: Array<{ label: string; value: number }>;
    }>;
    const sourceFetch = timeline.find((node) => node.key === "source_fetch");

    expect(result.status).toBe("succeeded");
    expect(sourceFetch?.metrics).toContainEqual({ label: "抓取源", value: 1 });
    expect(sourceFetch?.metrics).toContainEqual({ label: "抓取内容", value: 1 });
    expect(timeline).toHaveLength(6);
    expect(timeline.every((node) => node.metrics.length > 0)).toBe(true);
  });

  it("tracks item reanalysis and regeneration usage with fake providers", async () => {
    const definitions = [
      { definition: createItemReanalyzeWorkflowDefinition(), input: { itemId: "item-1" } },
      {
        definition: createItemRegenerationWorkflowDefinition("item_regenerate_translation", "translation"),
        input: { item: {} },
      },
      {
        definition: createItemRegenerationWorkflowDefinition("item_regenerate_summary", "summary"),
        input: { item: {} },
      },
    ];

    for (const { definition, input } of definitions) {
      const projection = vi.fn(async () => undefined);
      const aiStage = definition.stages.find((stage) => stage.id === "ai_call");
      expect(aiStage).toBeDefined();
      await aiStage!.execute(input, { projectAiUsage: projection } as never);
      expect(projection).toHaveBeenCalledWith(expect.objectContaining({
        actual: 1,
        breakdown: expect.arrayContaining([expect.objectContaining({
          key: "item_understanding",
          actual: 1,
          promptTokens: 310,
          completionTokens: 70,
          totalTokens: 380,
          cachedTokens: 12,
          cachedTokensStatus: "provider",
        })]),
      }));
    }
  });

  it("projects precompute entity-alias AI usage onto its Mastra stage", async () => {
    mockState.runtimeConfig = {
      modelApi: { apiKey: "test-key", baseURL: "https://example.test/v1", model: "test-model" },
      ingestion: { aggregationSplitMaxEvents: 20 },
      embedding: null,
    };
    const taskRun = await prisma.backgroundTaskRun.create({
      data: { kind: "precompute", triggerType: "manual", status: "queued", label: "预计算" },
    });

    const result = await triggerTaskWorkflow("precompute", taskRun.id);
    const stored = await prisma.backgroundTaskRun.findUniqueOrThrow({ where: { id: taskRun.id } });
    const breakdown = JSON.parse(stored.aiCallBreakdownJson ?? "[]") as Array<{
      key: string;
      actual: number;
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
      cachedTokensStatus?: string;
    }>;
    const timings = JSON.parse(stored.stageTimingsJson ?? "[]") as Array<{ key: string; status?: string; detail?: string }>;

    expect(result.status).toBe("succeeded");
    expect(breakdown.find((entry) => entry.key === "entity_alias_check")).toMatchObject({
      actual: 1,
      promptTokens: 640,
      completionTokens: 90,
      totalTokens: 730,
      cachedTokensStatus: "unavailable",
    });
    expect(timings.find((timing) => timing.key === "entity_alias_check")).toMatchObject({
      status: "succeeded",
      detail: expect.stringContaining("AI 调用 1 次"),
    });
    expect(timings.find((timing) => timing.key === "entity_alias_check")?.detail).toContain("别名候选 1");
  });

  it("projects cluster summary AI usage onto the task run", async () => {
    const clusterId = "staged-cluster-summary-usage";
    const publishedAt = new Date("2026-06-30T00:00:00.000Z");
    await prisma.contentCluster.deleteMany({ where: { id: clusterId } });
    const source = await prisma.source.create({
      data: {
        id: `${clusterId}-source`,
        name: clusterId,
        rssUrl: `https://staged.example.com/${clusterId}/rss`,
        siteUrl: `https://staged.example.com/${clusterId}`,
        enabled: true,
        aiParsingEnabled: true,
        aggregationEnabled: true,
      },
    });
    await prisma.contentCluster.create({
      data: {
        id: clusterId,
        kind: "topic",
        title: "staged 聚类摘要",
        summary: "staged 聚类摘要备选",
        score: 60,
        itemCount: 2,
        latestPublishedAt: publishedAt,
        createdAt: publishedAt,
        updatedAt: publishedAt,
        status: "active",
        fingerprint: `fp-${clusterId}`,
      },
    });
    await prisma.item.createMany({
      data: [0, 1].map((index) => ({
        id: `${clusterId}-item-${index}`,
        sourceId: source.id,
        clusterId,
        originalUrl: `https://staged.example.com/${clusterId}/item-${index}`,
        canonicalUrl: `https://staged.example.com/${clusterId}/item-${index}`,
        urlHash: `${clusterId}-item-${index}-hash`,
        originalTitle: `staged 聚类条目 ${index + 1}`,
        status: "processed",
        moderationStatus: "allowed",
        publishedAt,
        createdAt: publishedAt,
      })),
    });

    const taskRun = await prisma.backgroundTaskRun.create({
      data: {
        kind: "cluster_regenerate_summary",
        triggerType: "manual",
        status: "queued",
        label: "重新生成聚类摘要",
        entityId: clusterId,
      },
    });

    const result = await triggerTaskWorkflow("cluster_regenerate_summary", taskRun.id);
    const stored = await prisma.backgroundTaskRun.findUniqueOrThrow({ where: { id: taskRun.id } });

    expect(result.status).toBe("succeeded");
    expect(stored.status).toBe("succeeded");
    // mock provider 返回 null 也完成了 summarizeCluster 委派——计数必须在委派前记录
    expect(stored.aiCallCountActual).toBe(1);
    expect(stored.aiCallCountEstimated).toBe(1);
    const breakdown = JSON.parse(stored.aiCallBreakdownJson ?? "[]") as Array<{
      key: string;
      actual: number;
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
      cachedTokens?: number;
      cachedTokensStatus?: string;
    }>;
    expect(breakdown.find((entry) => entry.key === "cluster_summary")).toMatchObject({
      actual: 1,
      promptTokens: 420,
      completionTokens: 80,
      totalTokens: 500,
      cachedTokens: 0,
      cachedTokensStatus: "unavailable",
    });
    const stageTimings = JSON.parse(stored.stageTimingsJson ?? "[]") as Array<{ key: string; status?: string; detail?: string }>;
    expect(stageTimings.find((timing) => timing.key === "ai_call")).toMatchObject({
      status: "succeeded",
      detail: expect.stringContaining("AI 调用 1 次"),
    });
    expect(stageTimings.find((timing) => timing.key === "read")?.detail).toBeUndefined();
    expect(stageTimings.find((timing) => timing.key === "writeback")?.detail).toBe("聚类摘要已写回");

    await prisma.contentCluster.deleteMany({ where: { id: clusterId } });
  });
});
