import crypto from "node:crypto";
import { z } from "zod";
import { normalizeModelResponseText } from "@/lib/ai/response-format";
import {
  CLUSTER_MERGE_REASON_CODES,
  getJsonParseErrorMessage,
  InvalidJsonModelResponseError,
} from "@/lib/ai/provider-types";
import type { ClusterMergeDecision, ClusterMergeDecisionVerdict, ClusterMergeReasonCode } from "@/lib/ai/provider-types";

export const CLUSTER_MATCH_SCHEMA = z.object({
  clusterId: z.string().nullable(),
});

export const CLUSTER_MERGE_DECISIONS_SCHEMA = z.object({
  decisions: z.array(z.object({
    pair_id: z.string().min(1),
    verdict: z.enum(["approved", "declined", "ambiguous"]),
    confidence: z.number().min(0).max(100),
    reasonCode: z.enum(CLUSTER_MERGE_REASON_CODES),
    reasonText: z.string().trim().min(1),
  }).strict()),
}).strict();

export function makeClusterMergePairId(leftClusterId: string, rightClusterId: string) {
  const [left, right] = [leftClusterId, rightClusterId].sort();
  const digest = crypto.createHash("sha256").update(`${left}\0${right}`).digest("hex");
  return `merge_pair_${digest}`;
}

export function splitClusterMergeInputBatches(clustersJson: string, batchSize: number) {
  const parsed = JSON.parse(clustersJson) as Record<string, unknown>;
  if (!Array.isArray(parsed.pairs)) {
    throw new InvalidJsonModelResponseError("聚合合并输入 pairs 必须是数组。");
  }
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error("聚合合并 AI batchSize 必须是正整数。");
  }

  const batches: string[] = [];
  for (let index = 0; index < parsed.pairs.length; index += batchSize) {
    batches.push(JSON.stringify({ ...parsed, pairs: parsed.pairs.slice(index, index + batchSize) }));
  }
  return batches;
}

export function compactClusterMergeInputForModel(clustersJson: string) {
  const parsed = JSON.parse(clustersJson) as Record<string, unknown>;
  const pairs = Array.isArray(parsed.pairs)
    ? parsed.pairs.map((pair) => {
        if (!pair || typeof pair !== "object" || Array.isArray(pair)) return pair;
        const inputPair = pair as Record<string, unknown>;
        const left = inputPair.left as Record<string, unknown> | null;
        const right = inputPair.right as Record<string, unknown> | null;
        if (!left || typeof left.id !== "string" || !right || typeof right.id !== "string") {
          throw new InvalidJsonModelResponseError("聚合合并 Pair 缺少有效的 left/right cluster ID。");
        }
        const stripClusterId = (cluster: unknown) => {
          if (!cluster || typeof cluster !== "object" || Array.isArray(cluster)) return cluster;
          const withoutId = { ...(cluster as Record<string, unknown>) };
          delete withoutId.id;
          return withoutId;
        };
        return {
          ...inputPair,
          pair_id: makeClusterMergePairId(left.id, right.id),
          left: stripClusterId(left),
          right: stripClusterId(right),
        };
      })
    : parsed.pairs;

  return { ...parsed, pairs };
}

export function parseClusterSummaryOutput(rawContent: string): string {
  const normalized = normalizeModelResponseText(rawContent);
  let parsed: { title?: unknown; summary?: unknown };

  try {
    parsed = JSON.parse(normalized) as { title?: unknown; summary?: unknown };
  } catch (error) {
    throw new InvalidJsonModelResponseError(
      `聚合摘要模型返回了无法解析的 JSON：${getJsonParseErrorMessage(error)}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidJsonModelResponseError("聚合摘要 JSON 顶层必须是对象。");
  }

  // 未知字段（如模型附带的 keyPoints）直接忽略，只取合同内的 title/summary；
  // 字段为空才触发上层 JSON 重试。
  const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";

  if (!title || !summary) {
    throw new InvalidJsonModelResponseError("聚合摘要 JSON 必须包含非空的 title 和 summary。");
  }

  return JSON.stringify({ title, summary });
}

export type ClusterMergeInputMetadata = {
  pairs: Array<{ pairId: string; leftClusterId: string; rightClusterId: string }>;
};

function buildClusterMergeGroupsFromApprovedEdges(
  approvedEdges: Array<[string, string]>,
  metadata: { itemCounts: Map<string, number>; preservePairOrder?: boolean },
) {
  const adjacency = new Map<string, Set<string>>();

  for (const [leftId, rightId] of approvedEdges) {
    if (!adjacency.has(leftId)) {
      adjacency.set(leftId, new Set());
    }
    if (!adjacency.has(rightId)) {
      adjacency.set(rightId, new Set());
    }
    adjacency.get(leftId)!.add(rightId);
    adjacency.get(rightId)!.add(leftId);
  }

  const visited = new Set<string>();
  const groups: string[][] = [];

  for (const clusterId of adjacency.keys()) {
    if (visited.has(clusterId)) {
      continue;
    }

    const component: string[] = [];
    const stack = [clusterId];
    visited.add(clusterId);

    while (stack.length > 0) {
      const currentId = stack.pop()!;
      component.push(currentId);

      for (const nextId of adjacency.get(currentId) ?? []) {
        if (!visited.has(nextId)) {
          visited.add(nextId);
          stack.push(nextId);
        }
      }
    }

    if (component.length < 2) {
      continue;
    }

    const targetId = [...component].sort((leftId, rightId) => {
      const itemCountDiff = (metadata.itemCounts.get(rightId) ?? 0) - (metadata.itemCounts.get(leftId) ?? 0);
      return itemCountDiff || (metadata.preservePairOrder ? 0 : leftId.localeCompare(rightId));
    })[0]!;
    const directSources = [...(adjacency.get(targetId) ?? [])].sort((leftId, rightId) => {
      const itemCountDiff = (metadata.itemCounts.get(rightId) ?? 0) - (metadata.itemCounts.get(leftId) ?? 0);
      return itemCountDiff || (metadata.preservePairOrder ? 0 : leftId.localeCompare(rightId));
    });

    if (directSources.length > 0) {
      groups.push([targetId, ...directSources]);
    }
  }

  return groups;
}

export function buildClusterMergeGroupsFromDecisions(
  decisions: Array<Pick<ClusterMergeDecision, "leftClusterId" | "rightClusterId" | "verdict">>,
  itemCounts: Map<string, number>,
) {
  return buildClusterMergeGroupsFromApprovedEdges(
    decisions
      .filter((decision) => decision.verdict === "approved")
      .map((decision) => [decision.leftClusterId, decision.rightClusterId]),
    { itemCounts, preservePairOrder: true },
  );
}

export function parseClusterMergeInputMetadata(clustersJson: string): ClusterMergeInputMetadata {
  const parsed = JSON.parse(clustersJson) as unknown;
  if (!parsed || typeof parsed !== "object" || !("pairs" in parsed) || !Array.isArray(parsed.pairs)) {
    throw new InvalidJsonModelResponseError("聚合合并输入 pairs 必须是数组。");
  }

  const pairs: ClusterMergeInputMetadata["pairs"] = [];
  const seenPairIds = new Set<string>();
  for (const pair of parsed.pairs) {
    const left = pair && typeof pair === "object" && "left" in pair ? pair.left : null;
    const right = pair && typeof pair === "object" && "right" in pair ? pair.right : null;
    const leftId = left && typeof left === "object" && "id" in left && typeof left.id === "string" ? left.id : null;
    const rightId = right && typeof right === "object" && "id" in right && typeof right.id === "string" ? right.id : null;
    if (!leftId || !rightId || leftId === rightId) {
      throw new InvalidJsonModelResponseError("聚合合并输入 Pair 缺少有效的 left/right cluster ID。");
    }

    const pairId = makeClusterMergePairId(leftId, rightId);
    if (seenPairIds.has(pairId)) {
      throw new InvalidJsonModelResponseError(`聚合合并输入存在重复 pair_id：${pairId}`);
    }
    seenPairIds.add(pairId);
    pairs.push({ pairId, leftClusterId: leftId, rightClusterId: rightId });
  }

  return { pairs };
}

export function parseClusterMergeDecisions(rawContent: string, metadata: ClusterMergeInputMetadata): ClusterMergeDecision[] {
  const normalized = normalizeModelResponseText(rawContent);
  let parsed: unknown;

  try {
    parsed = JSON.parse(normalized) as unknown;
  } catch (error) {
    throw new InvalidJsonModelResponseError(
      `Invalid cluster merge decision JSON: ${getJsonParseErrorMessage(error)}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidJsonModelResponseError("聚合合并 decisions 必须是对象。");
  }
  const schemaResult = CLUSTER_MERGE_DECISIONS_SCHEMA.safeParse(parsed);
  if (!schemaResult.success) {
    throw new InvalidJsonModelResponseError(`聚合合并 decisions 格式无效：${schemaResult.error.message}`);
  }
  const outputDecisions = schemaResult.data.decisions;
  if (metadata.pairs.length === 0) {
    if (outputDecisions.length !== 0) {
      throw new InvalidJsonModelResponseError("空聚合合并输入不得返回 decisions。");
    }
    return [];
  }
  if (outputDecisions.length !== metadata.pairs.length) {
    throw new InvalidJsonModelResponseError("聚合合并 decisions 数量必须与输入 pair 数量完全一致。");
  }

  const expectedById = new Map(metadata.pairs.map((pair) => [pair.pairId, pair]));
  const decisionsById = new Map<string, ClusterMergeDecision>();
  for (const rawDecision of outputDecisions) {
    if (!rawDecision || typeof rawDecision !== "object" || Array.isArray(rawDecision)) {
      throw new InvalidJsonModelResponseError("聚合合并 decision 必须是对象。");
    }
    const decision = rawDecision as Record<string, unknown>;
    if (typeof decision.pair_id !== "string" || !expectedById.has(decision.pair_id)) {
      throw new InvalidJsonModelResponseError("聚合合并 decision 包含未知或缺失的 pair_id。");
    }
    if (decisionsById.has(decision.pair_id)) {
      throw new InvalidJsonModelResponseError(`聚合合并 decision 出现重复 pair_id：${decision.pair_id}`);
    }
    if (decision.verdict !== "approved" && decision.verdict !== "declined" && decision.verdict !== "ambiguous") {
      throw new InvalidJsonModelResponseError(`聚合合并 pair_id ${decision.pair_id} 的 verdict 无效。`);
    }
    if (typeof decision.confidence !== "number" || decision.confidence < 0 || decision.confidence > 100) {
      throw new InvalidJsonModelResponseError(`聚合合并 pair_id ${decision.pair_id} 的 confidence 必须在 0 到 100 之间。`);
    }
    if (typeof decision.reasonCode !== "string" || !CLUSTER_MERGE_REASON_CODES.includes(decision.reasonCode as ClusterMergeReasonCode)) {
      throw new InvalidJsonModelResponseError(`聚合合并 pair_id ${decision.pair_id} 的 reasonCode 无效。`);
    }
    const reasonText = typeof decision.reasonText === "string" ? decision.reasonText.trim() : "";
    if (!reasonText) {
      throw new InvalidJsonModelResponseError(`聚合合并 pair_id ${decision.pair_id} 缺少 reasonText。`);
    }
    if (
      (decision.verdict === "approved" && decision.reasonCode !== "same_event") ||
      (decision.verdict === "ambiguous" && decision.reasonCode !== "insufficient_evidence") ||
      (decision.verdict === "declined" && (decision.reasonCode === "same_event" || decision.reasonCode === "insufficient_evidence"))
    ) {
      throw new InvalidJsonModelResponseError(`聚合合并 pair_id ${decision.pair_id} 的 verdict 与 reasonCode 不匹配。`);
    }

    const pair = expectedById.get(decision.pair_id)!;
    decisionsById.set(decision.pair_id, {
      leftClusterId: pair.leftClusterId,
      rightClusterId: pair.rightClusterId,
      verdict: decision.verdict as ClusterMergeDecisionVerdict,
      confidence: decision.confidence,
      reasonCode: decision.reasonCode as ClusterMergeReasonCode,
      reasonText,
    });
  }

  if (decisionsById.size !== expectedById.size) {
    throw new InvalidJsonModelResponseError("聚合合并 decisions 缺少输入 pair_id。");
  }
  return metadata.pairs.map((pair) => decisionsById.get(pair.pairId)!);
}

export function parseClusterMatchCandidateId(rawContent: string, candidateIds: string[]): string | null {
  const normalized = normalizeModelResponseText(rawContent);
  let parseError: unknown = null;

  try {
    const parsed = JSON.parse(normalized) as { clusterId?: unknown };
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("clusterId" in parsed)) {
      throw new InvalidJsonModelResponseError('归组判定 JSON 必须包含 "clusterId" 字段。');
    }
    if (parsed.clusterId !== null && typeof parsed.clusterId !== "string") {
      throw new InvalidJsonModelResponseError('归组判定 "clusterId" 必须是字符串或 null。');
    }
    const clusterId = typeof parsed.clusterId === "string" ? parsed.clusterId.trim() : "";

    if (clusterId && candidateIds.includes(clusterId)) {
      return clusterId;
    }
  } catch (error) {
    parseError = error;
    // Fall through to tolerant parsing below.
  }

  const clusterIdMatch = normalized.match(/"?clusterId"?\s*:\s*(?:"([^"]*)"|'([^']*)'|([^,\n}]+))/i);
  const clusterId = (clusterIdMatch?.[1] ?? clusterIdMatch?.[2] ?? clusterIdMatch?.[3] ?? "").trim();

  if (clusterId && candidateIds.includes(clusterId)) {
    return clusterId;
  }

  if (parseError) {
    throw new InvalidJsonModelResponseError(
      `Invalid cluster match JSON: ${getJsonParseErrorMessage(parseError)}`,
    );
  }

  return null;
}
