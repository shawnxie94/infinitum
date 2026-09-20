import { describe, expect, it, vi } from "vitest";

import type { AiProvider } from "@/lib/ai/provider";
import { createTaskAiUsageTracker } from "@/lib/tasks/ai-usage";

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
    });
    tracker.addUsage("daily_report", {
      promptTokens: 800,
      completionTokens: 200,
      totalTokens: 1000,
      cachedTokens: 0,
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
