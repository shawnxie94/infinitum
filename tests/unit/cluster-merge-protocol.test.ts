import { describe, expect, it } from "vitest";

import {
  buildClusterMergeGroupsFromDecisions,
  compactClusterMergeInputForModel,
  makeClusterMergePairId,
  parseClusterMergeDecisions,
  resolveClusterMergeGroupsFromDecisions,
  parseClusterMergeInputMetadata,
  splitClusterMergeInputBatches,
} from "@/lib/ai/protocols/cluster";
import { CLUSTER_MERGE_AI_PAIR_BATCH_SIZE } from "@/config/constants";

function makeInput(pairCount: number) {
  return JSON.stringify({
    pairs: Array.from({ length: pairCount }, (_, index) => ({
      left: { id: `cluster-left-${index}`, title: `左聚合 ${index}` },
      right: { id: `cluster-right-${index}`, title: `右聚合 ${index}` },
      score: 100 - index,
    })),
  });
}

function makeDecision(pairId: string, verdict: "approved" | "declined" | "ambiguous" = "declined") {
  return {
    pair_id: pairId,
    verdict,
    confidence: 91,
    reasonCode: verdict === "approved" ? "same_event" : "different_event",
    reasonText: verdict === "approved" ? "主体、对象与事件动作一致。" : "主体和具体对象不同，不是同一事件。",
  };
}

describe("cluster merge pair-id protocol", () => {
  it("adds stable pair IDs to compact model input", () => {
    const input = makeInput(2);
    const first = compactClusterMergeInputForModel(input) as {
      pairs: Array<{ pair_id: string; left: Record<string, unknown> }>;
    };
    const second = compactClusterMergeInputForModel(input) as typeof first;

    expect(first.pairs.map((pair) => pair.pair_id)).toEqual(second.pairs.map((pair) => pair.pair_id));
    expect(first.pairs[0]?.pair_id).toBe(makeClusterMergePairId("cluster-left-0", "cluster-right-0"));
    expect(first.pairs[0]?.left).not.toHaveProperty("id");
  });

  it("maps shuffled decisions to their original cluster pairs by ID", () => {
    const input = makeInput(2);
    const metadata = parseClusterMergeInputMetadata(input);
    const pairIds = metadata.pairs.map((pair) => pair.pairId);
    const decisions = parseClusterMergeDecisions(JSON.stringify({
      decisions: [makeDecision(pairIds[1]!, "approved"), makeDecision(pairIds[0]!, "declined")],
    }), metadata);

    expect(decisions).toEqual([
      expect.objectContaining({
        leftClusterId: "cluster-left-0",
        rightClusterId: "cluster-right-0",
        verdict: "declined",
        confidence: 91,
        reasonCode: "different_event",
        reasonText: "主体和具体对象不同，不是同一事件。",
      }),
      expect.objectContaining({
        leftClusterId: "cluster-left-1",
        rightClusterId: "cluster-right-1",
        verdict: "approved",
      }),
    ]);
  });

  it.each([
    ["missing", (ids: string[]) => [makeDecision(ids[0]!)]],
    ["duplicate", (ids: string[]) => [makeDecision(ids[0]!), makeDecision(ids[0]!) ]],
    ["unknown", (ids: string[]) => [makeDecision("merge_pair_unknown"), makeDecision(ids[1]!) ]],
  ])("salvages the usable pair when %s pair IDs are returned", (_caseName, buildDecisions) => {
    // 协议容错基线（对齐 rc8）：非法 decision 只丢弃自身，不连坐同批其他 pair。
    // 被丢弃的 pair 不做账本记录，下一轮重新评估。
    const input = makeInput(2);
    const metadata = parseClusterMergeInputMetadata(input);
    const pairIds = metadata.pairs.map((pair) => pair.pairId);

    const decisions = parseClusterMergeDecisions(
      JSON.stringify({ decisions: buildDecisions(pairIds) }),
      metadata,
    );

    expect(decisions.length).toBeLessThanOrEqual(1);
    for (const decision of decisions) {
      expect(metadata.pairs.length).toBeGreaterThan(0);
      expect(decision.reasonText ?? "").not.toBe("");
    }
  });

  it("drops a decision without a usable reason but keeps the others", () => {
    const input = makeInput(2);
    const metadata = parseClusterMergeInputMetadata(input);
    const pairIds = metadata.pairs.map((pair) => pair.pairId);

    const decisions = parseClusterMergeDecisions(JSON.stringify({
      decisions: [
        { ...makeDecision(pairIds[0]!), reasonText: "  " },
        makeDecision(pairIds[1]!),
      ],
    }), metadata);

    expect(decisions).toEqual([expect.objectContaining({
      leftClusterId: "cluster-left-1",
      rightClusterId: "cluster-right-1",
    })]);
  });

  it("returns an empty list when every decision is invalid instead of throwing", () => {
    const metadata = parseClusterMergeInputMetadata(makeInput(2));
    const pairIds = metadata.pairs.map((pair) => pair.pairId);

    const decisions = parseClusterMergeDecisions(JSON.stringify({
      decisions: [
        { ...makeDecision(pairIds[0]!), confidence: 900 },
        { ...makeDecision(pairIds[1]!), verdict: "maybe" },
      ],
    }), metadata);

    expect(decisions).toEqual([]);
  });

  it("still throws on document-level failures that per-pair salvage cannot recover", () => {
    const metadata = parseClusterMergeInputMetadata(makeInput(1));

    // 文档不是对象：无逐 pair 语义可抢救。
    expect(() => parseClusterMergeDecisions(JSON.stringify({}), metadata)).toThrow(/decisions/i);
    // JSON 本身非法（含裸控制字符以外的破损）：归一化后仍无法解析。
    expect(() => parseClusterMergeDecisions("{not json", metadata)).toThrow();
  });

  it("recovers a response whose reasonText carries a raw NUL byte", () => {
    // 回归 2026-10-03：模型回抄 "The\0 New Stack" 时把空格吐成 NUL，
    // 未转义控制字符使整篇文档被 JSON.parse 拒绝，5 对判定全部作废。
    const metadata = parseClusterMergeInputMetadata(makeInput(1));
    const pairId = metadata.pairs[0]!.pairId;
    const raw = `{"decisions":[{"pair_id":"${pairId}","verdict":"declined","confidence":97,` +
      `"reasonCode":"different_event","reasonText":"左侧是 The\u0000 New Stack 评论 CVE 漏洞管理，右侧无关。"}]}`;

    expect(() => JSON.parse(raw)).toThrow();
    expect(parseClusterMergeDecisions(raw, metadata)).toEqual([expect.objectContaining({
      leftClusterId: "cluster-left-0",
      rightClusterId: "cluster-right-0",
      verdict: "declined",
      reasonText: "左侧是 The New Stack 评论 CVE 漏洞管理，右侧无关。",
    })]);
  });

  it("shards the merge input so no single AI call sees every pair", () => {
    const batches = splitClusterMergeInputBatches(makeInput(7), CLUSTER_MERGE_AI_PAIR_BATCH_SIZE);

    expect(batches.length).toBeGreaterThan(1);
    expect(batches).toHaveLength(Math.ceil(7 / CLUSTER_MERGE_AI_PAIR_BATCH_SIZE));
    // 分片不丢对也不重复，且每批都不超过单批上限。
    const seen = batches.flatMap((batch) => (JSON.parse(batch) as { pairs: unknown[] }).pairs);
    expect(seen).toHaveLength(7);
    for (const batch of batches) {
      expect((JSON.parse(batch) as { pairs: unknown[] }).pairs.length)
        .toBeLessThanOrEqual(CLUSTER_MERGE_AI_PAIR_BATCH_SIZE);
    }
  });

  it("isolates a failing shard so sibling shards still produce decisions", () => {
    // 分片隔离语义：逐批 catch，首批抛错不影响其余批次被评估。
    const batches = splitClusterMergeInputBatches(makeInput(6), CLUSTER_MERGE_AI_PAIR_BATCH_SIZE);
    const kept: string[] = [];
    let firstBatchError: unknown = null;

    batches.forEach((batch, index) => {
      try {
        if (index === 0) throw new Error("bad control character in response");
        kept.push(batch);
      } catch (error) {
        firstBatchError ??= error;
      }
    });

    expect(batches.length).toBeGreaterThan(1);
    expect(kept).toHaveLength(batches.length - 1);
    expect((firstBatchError as Error).message).toBe("bad control character in response");
  });

  it("declines the Amazfit smartwatch and Razer speaker pair without creating an approved decision", () => {
    const input = JSON.stringify({
      pairs: [{
        left: { id: "amazfit-cluster", title: "Amazfit 推出 T-Rex Dual Solar 智能手表", summary: "Amazfit 发布新款智能手表。", eventSubject: "Amazfit", eventObject: "T-Rex Dual Solar 智能手表" },
        right: { id: "razer-cluster", title: "雷蛇推出灰鲭鲨 X 游戏音箱", summary: "雷蛇发布桌面游戏音箱。", eventSubject: "雷蛇", eventObject: "灰鲭鲨 X 游戏音箱" },
        score: 74,
      }],
    });
    const metadata = parseClusterMergeInputMetadata(input);
    const decisions = parseClusterMergeDecisions(JSON.stringify({
      decisions: [makeDecision(metadata.pairs[0]!.pairId, "declined")],
    }), metadata);

    expect(decisions).toEqual([expect.objectContaining({
      leftClusterId: "amazfit-cluster",
      rightClusterId: "razer-cluster",
      verdict: "declined",
      reasonCode: "different_event",
      reasonText: "主体和具体对象不同，不是同一事件。",
    })]);
    expect(buildClusterMergeGroupsFromDecisions(decisions, new Map([
      ["amazfit-cluster", 1],
      ["razer-cluster", 1],
    ]))).toEqual([]);
  });

  it("blocks the full approved component when it contains a declined pair and preserves other components", () => {
    const decisions = [
      { leftClusterId: "A", rightClusterId: "B", verdict: "approved" as const },
      { leftClusterId: "B", rightClusterId: "C", verdict: "approved" as const },
      { leftClusterId: "A", rightClusterId: "C", verdict: "declined" as const },
      { leftClusterId: "D", rightClusterId: "E", verdict: "approved" as const },
    ];

    expect(resolveClusterMergeGroupsFromDecisions(decisions, new Map([
      ["A", 1], ["B", 1], ["C", 1], ["D", 1], ["E", 1],
    ]))).toEqual({
      groups: [["D", "E"]],
      conflicts: [{
        reason: "declined_pair_within_approved_component",
        clusterIds: ["A", "B", "C"],
        declinedPairs: [{ leftClusterId: "A", rightClusterId: "C" }],
      }],
    });
    expect(decisions.map((decision) => decision.verdict)).toEqual(["approved", "approved", "declined", "approved"]);
  });

  it("keeps existing groups when declined pairs do not contradict an approved component", () => {
    const result = resolveClusterMergeGroupsFromDecisions([
      { leftClusterId: "A", rightClusterId: "B", verdict: "approved" },
      { leftClusterId: "X", rightClusterId: "Y", verdict: "declined" },
    ], new Map([["A", 1], ["B", 1]]));

    expect(result).toEqual({ groups: [["A", "B"]], conflicts: [] });
  });

  it("splits model inputs into batches no larger than five pairs", () => {
    const batches = splitClusterMergeInputBatches(makeInput(12), 5);

    expect(batches.map((batch) => JSON.parse(batch).pairs.length)).toEqual([5, 5, 2]);
    expect(batches.every((batch) => JSON.parse(batch).pairs.length <= 5)).toBe(true);
  });
});
