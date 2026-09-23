import { describe, expect, it, vi } from "vitest";

import type { AiProvider } from "@/lib/ai/provider-types";
import { createTaskAiUsageTracker } from "@/lib/tasks/ai-usage";
import { toTaskRunSnapshot } from "@/lib/tasks/service";

describe("task AI usage provider wrapper", () => {
  it("forwards the structured cluster merge decision method", async () => {
    const assessClusterMergePairs = vi.fn().mockResolvedValue([
      {
        clusterAId: "cluster-a",
        clusterBId: "cluster-b",
        verdict: "ambiguous",
        confidence: 0.5,
        reasonCode: "insufficient_evidence",
        reasonText: "需要人工确认",
      },
    ]);
    const tracker = createTaskAiUsageTracker();
    const provider = tracker.wrapProvider({
      understandItem: vi.fn(),
      summarizeCluster: vi.fn(),
      matchClusterCandidate: vi.fn(),
      assessClusterMergePairs,
    } as unknown as AiProvider);

    await expect(provider.assessClusterMergePairs('{"clusters":[]}')).resolves.toEqual([
      expect.objectContaining({ verdict: "ambiguous" }),
    ]);
    expect(assessClusterMergePairs).toHaveBeenCalledWith('{"clusters":[]}');
    expect(tracker.snapshot().breakdown).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "cluster_merge", actual: 1, estimated: 1 }),
    ]));
  });

  it("always exposes the unified cluster merge decision method", () => {
    const tracker = createTaskAiUsageTracker();
    const assessClusterMergePairs = vi.fn().mockResolvedValue([]);
    const provider = tracker.wrapProvider({
      understandItem: vi.fn(),
      summarizeCluster: vi.fn(),
      matchClusterCandidate: vi.fn(),
      assessClusterMergePairs,
    } as unknown as AiProvider);

    expect(provider.assessClusterMergePairs).toBeDefined();
  });

  it("accumulates context usage per breakdown key", () => {
    const tracker = createTaskAiUsageTracker();

    tracker.addUsage("daily_report", {
      promptTokens: 1200,
      completionTokens: 300,
      totalTokens: 1500,
      cachedTokens: 100,
      model: "model-a",
    });
    tracker.addUsage("daily_report", {
      promptTokens: 800,
      completionTokens: 200,
      totalTokens: 1000,
      cachedTokens: 0,
      model: "model-b",
    });
    tracker.addUsage("cluster_summary", {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      cachedTokens: 0,
    });

    const breakdown = tracker.snapshot().breakdown;
    const daily = breakdown.find((entry) => entry.key === "daily_report");
    const clusterSummary = breakdown.find((entry) => entry.key === "cluster_summary");
    const untouched = breakdown.find((entry) => entry.key === "item_understanding");

    expect(daily).toMatchObject({
      promptTokens: 2000,
      completionTokens: 500,
      totalTokens: 2500,
      cachedTokens: 100,
      modelNames: ["model-a", "model-b"],
    });
    expect(clusterSummary).toMatchObject({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    });
    expect(untouched).not.toHaveProperty("totalTokens");
  });

  it("wraps and tracks the entity alias check method when the provider has it", async () => {
    const assessEntityAliasPairs = vi.fn().mockResolvedValue([
      { aName: "智谱", bName: "Z.ai", isSameEntity: true, confidence: "high", canonicalName: "智谱" },
    ]);
    const tracker = createTaskAiUsageTracker();
    const provider = tracker.wrapProvider({
      understandItem: vi.fn(),
      summarizeCluster: vi.fn(),
      matchClusterCandidate: vi.fn(),
      assessClusterMergePairs: vi.fn(),
      assessEntityAliasPairs,
    } as unknown as AiProvider);

    const input = { pairs: [{ aName: "智谱", bName: "Z.ai", evidence: ["同聚类主体变体"] }] };
    await expect(provider.assessEntityAliasPairs!(input)).resolves.toHaveLength(1);
    expect(assessEntityAliasPairs).toHaveBeenCalledWith(input);
    expect(tracker.snapshot().breakdown).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "entity_alias_check", actual: 1, estimated: 1, label: "实体别名判定" }),
    ]));
  });

  it("keeps assessEntityAliasPairs undefined when the provider lacks it", () => {
    const tracker = createTaskAiUsageTracker();
    const provider = tracker.wrapProvider({
      understandItem: vi.fn(),
      summarizeCluster: vi.fn(),
      matchClusterCandidate: vi.fn(),
      assessClusterMergePairs: vi.fn(),
    } as unknown as AiProvider);

    expect(provider.assessEntityAliasPairs).toBeUndefined();
    expect(tracker.snapshot().breakdown).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "entity_alias_check", actual: 0, estimated: 0 }),
    ]));
  });

  it("distinguishes known zero cached tokens, partial reporting and unavailable cache usage", () => {
    const tracker = createTaskAiUsageTracker();

    tracker.addUsage("item_understanding", {
      promptTokens: 10,
      completionTokens: 2,
      totalTokens: 12,
      cachedTokens: 0,
      cachedTokensReported: true,
      tokenUsageSource: "provider",
    });
    tracker.addUsage("item_understanding", {
      promptTokens: 8,
      completionTokens: 2,
      totalTokens: 10,
      cachedTokens: 0,
      cachedTokensReported: false,
      tokenUsageSource: "provider",
    });
    tracker.addUsage("cluster_summary", {
      promptTokens: 5,
      completionTokens: 1,
      totalTokens: 6,
      cachedTokens: 0,
      cachedTokensReported: false,
      tokenUsageSource: "provider",
    });
    tracker.addUsage("daily_report", {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      cachedTokensReported: true,
      tokenUsageSource: "provider",
    });

    const breakdown = tracker.snapshot().breakdown;
    expect(breakdown.find((entry) => entry.key === "item_understanding")).toMatchObject({
      cachedTokens: 0,
      cachedTokensStatus: "partial",
    });
    expect(breakdown.find((entry) => entry.key === "cluster_summary")).toMatchObject({
      cachedTokens: 0,
      cachedTokensStatus: "unavailable",
    });
    expect(breakdown.find((entry) => entry.key === "daily_report")).toMatchObject({
      cachedTokens: 0,
      cachedTokensStatus: "provider",
    });
  });

  it("preserves optional model names in task snapshots and accepts historical breakdown JSON", () => {
    const baseTask = {
      id: "task-model-snapshot",
      kind: "ingestion" as const,
      triggerType: "manual" as const,
      status: "succeeded" as const,
      label: "抓取任务",
      entityId: null,
      progressCurrent: 0,
      progressTotal: 0,
      progressLabel: null,
      itemsAdded: 0,
      fullTextFetchedCount: 0,
      aiCallCountActual: 1,
      aiCallCountEstimated: 1,
      cancelRequestedAt: null,
      startedAt: null,
      finishedAt: null,
      errorSummary: null,
      stageTimingsJson: null,
      taskTimelineJson: null,
    };
    const current = toTaskRunSnapshot({
      ...baseTask,
      aiCallBreakdownJson: JSON.stringify([{
        key: "item_understanding",
        actual: 1,
        estimated: 1,
        modelNames: ["model-a", "model-b"],
      }]),
    });
    const historical = toTaskRunSnapshot({
      ...baseTask,
      aiCallBreakdownJson: JSON.stringify([{ key: "item_understanding", actual: 1, estimated: 1 }]),
    });

    expect(current.aiCallBreakdown?.find((entry) => entry.key === "item_understanding")?.modelNames)
      .toEqual(["model-a", "model-b"]);
    expect(historical.aiCallBreakdown?.find((entry) => entry.key === "item_understanding"))
      .not.toHaveProperty("modelNames");
  });

  it("accumulates entity alias check tokens via addUsageByKey", () => {
    const tracker = createTaskAiUsageTracker();

    tracker.addUsageByKey("entity_alias_check", {
      promptTokens: 600,
      completionTokens: 100,
      totalTokens: 700,
      cachedTokens: 0,
      tokenUsageSource: "provider",
    });
    // 未知 key 不入账
    tracker.addUsageByKey("unknown_key", {
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
      cachedTokens: 0,
    });

    const breakdown = tracker.snapshot().breakdown;
    const alias = breakdown.find((entry) => entry.key === "entity_alias_check");
    expect(alias).toMatchObject({
      promptTokens: 600,
      completionTokens: 100,
      totalTokens: 700,
      tokenUsageSource: "provider",
    });
    expect(alias!.contractVersion).toBeDefined();
    expect(tracker.snapshot().actual).toBe(0);
  });
});
