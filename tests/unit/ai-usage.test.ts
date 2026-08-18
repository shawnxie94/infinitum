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
      mergeClusters: vi.fn(),
    } as unknown as AiProvider);

    await expect(provider.assessClusterMergePairs?.('{"clusters":[]}')).resolves.toEqual([
      expect.objectContaining({ verdict: "ambiguous" }),
    ]);
    expect(assessClusterMergePairs).toHaveBeenCalledWith('{"clusters":[]}');
    expect(tracker.snapshot().breakdown).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "cluster_merge", actual: 1, estimated: 1 }),
    ]));
  });

  it("keeps the structured method absent for legacy providers", () => {
    const tracker = createTaskAiUsageTracker();
    const provider = tracker.wrapProvider({
      understandItem: vi.fn(),
      summarizeCluster: vi.fn(),
      matchClusterCandidate: vi.fn(),
      mergeClusters: vi.fn(),
    } as unknown as AiProvider);

    expect(provider.assessClusterMergePairs).toBeUndefined();
  });
});
