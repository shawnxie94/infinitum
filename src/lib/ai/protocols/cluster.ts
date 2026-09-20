import { normalizeModelResponseText } from "@/lib/ai/response-format";
import { getJsonParseErrorMessage } from "@/lib/ai/provider-client";
import { InvalidJsonModelResponseError } from "@/lib/ai/provider-types";
import type { ClusterMergeDecision } from "@/lib/ai/provider-types";

export function compactClusterMergeInputForModel(clustersJson: string) {
  const parsed = JSON.parse(clustersJson) as Record<string, unknown>;
  const pairs = Array.isArray(parsed.pairs)
    ? parsed.pairs.map((pair) => {
        if (!pair || typeof pair !== "object" || Array.isArray(pair)) return pair;
        const inputPair = pair as Record<string, unknown>;
        const stripClusterId = (cluster: unknown) => {
          if (!cluster || typeof cluster !== "object" || Array.isArray(cluster)) return cluster;
          const withoutId = { ...(cluster as Record<string, unknown>) };
          delete withoutId.id;
          return withoutId;
        };
        return {
          ...inputPair,
          ...(Object.hasOwn(inputPair, "left") ? { left: stripClusterId(inputPair.left) } : {}),
          ...(Object.hasOwn(inputPair, "right") ? { right: stripClusterId(inputPair.right) } : {}),
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

type ClusterMergeInputMetadata = {
  pairs: Array<{ leftClusterId: string; rightClusterId: string }>;
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
  const pairs: Array<{ leftClusterId: string; rightClusterId: string }> = [];

  if (!parsed || typeof parsed !== "object" || !("pairs" in parsed) || !Array.isArray(parsed.pairs)) {
    return { pairs };
  }

  for (const pair of parsed.pairs) {
    if (!pair || typeof pair !== "object") {
      continue;
    }

    const left = "left" in pair ? pair.left : null;
    const right = "right" in pair ? pair.right : null;
    const leftId = left && typeof left === "object" && "id" in left && typeof left.id === "string" ? left.id : null;
    const rightId = right && typeof right === "object" && "id" in right && typeof right.id === "string" ? right.id : null;

    if (leftId && rightId && leftId !== rightId) {
      pairs.push({ leftClusterId: leftId, rightClusterId: rightId });
    }
  }

  return { pairs };
}

export function parseClusterMergeDecisions(rawContent: string, metadata: ClusterMergeInputMetadata) {
  const normalized = normalizeModelResponseText(rawContent);
  let parsed: { verdicts?: unknown };

  try {
    parsed = JSON.parse(normalized) as { verdicts?: unknown };
  } catch (error) {
    throw new InvalidJsonModelResponseError(
      `Invalid cluster merge verdict JSON: ${getJsonParseErrorMessage(error)}`,
    );
  }

  // verdicts 缺失或不是数组属于整体协议失败，交由上层 JSON 重试。
  const verdicts = parsed.verdicts;
  if (!Array.isArray(verdicts)) {
    throw new InvalidJsonModelResponseError("聚合合并 verdicts 必须是数组。");
  }

  if (metadata.pairs.length === 0) {
    return [];
  }

  // 数量不齐或个别判定非法时逐 pair 抢救：只保留合法判定，缺失/非法对不做账本
  // 记录、交由下一轮重新评估，不阻断其余 pair 的合并。
  const decisions = [];
  for (let index = 0; index < Math.min(metadata.pairs.length, verdicts.length); index += 1) {
    const pair = metadata.pairs[index]!;
    const verdict = verdicts[index];
    if (verdict !== "approved" && verdict !== "declined" && verdict !== "ambiguous") {
      continue;
    }

    decisions.push({
      leftClusterId: pair.leftClusterId,
      rightClusterId: pair.rightClusterId,
      verdict,
      confidence: null,
      reasonCode: null,
      reasonText: null,
    });
  }

  if (decisions.length === 0 && metadata.pairs.length > 0) {
    throw new InvalidJsonModelResponseError("聚合合并 verdicts 不含任何合法判定。");
  }

  return decisions;
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
