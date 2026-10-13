import crypto from "node:crypto";
import { z } from "zod";
import { normalizeModelResponseText } from "@/lib/ai/response-format";
import {
  CLUSTER_MERGE_REASON_CODES,
  CLUSTER_MERGE_RELATION_REASON_CODES,
  CLUSTER_MERGE_RELATIONS,
  getClusterMergeRelationAction,
  getJsonParseErrorMessage,
  InvalidJsonModelResponseError,
  LEGACY_VERDICT_TO_RELATION,
} from "@/lib/ai/provider-types";
import type {
  ClusterMergeDecision,
  ClusterMergeReasonCode,
  ClusterMergeRelation,
} from "@/lib/ai/provider-types";

export const CLUSTER_MATCH_SCHEMA = z.object({
  clusterId: z.string().nullable(),
});

export const CLUSTER_MERGE_DECISIONS_SCHEMA = z.object({
  decisions: z.array(z.object({
    pair_id: z.string().min(1),
    relation: z.enum(CLUSTER_MERGE_RELATIONS),
    confidence: z.number().min(0).max(100),
    reasonCode: z.enum(CLUSTER_MERGE_REASON_CODES),
    reasonText: z.string().trim().min(1),
  }).strict()),
}).strict();

/**
 * 内部稳定标识：用于审计/诊断记录，不参与模型交互，也不出系统。
 */
export function makeClusterMergePairId(leftClusterId: string, rightClusterId: string) {
  const [left, right] = [leftClusterId, rightClusterId].sort();
  const digest = crypto.createHash("sha256").update(`${left}\0${right}`).digest("hex");
  return `merge_pair_${digest}`;
}

/**
 * 批次内序号 ref：唯一需要模型回抄的标识，作用域仅限单次 AI 调用的那一批。
 * 刻意用最短形式（p1/p2/p3）——64 位十六进制摘要会让模型逐字复抄 64 个字符，
 * 既多花 token 又平白增加抄错概率，而显式路由的收益只需要一个批内唯一短串。
 */
export function makeClusterMergePairRef(indexInBatch: number) {
  return `p${indexInBatch + 1}`;
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
    ? parsed.pairs.map((pair, index) => {
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
          pair_id: makeClusterMergePairRef(index),
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

export type ClusterMergeGroupConflict = {
  reason: "declined_pair_within_approved_component" | "synthesis_source_guard";
  clusterIds: string[];
  declinedPairs: Array<{ leftClusterId: string; rightClusterId: string }>;
};

type ApprovedClusterMergeGraph = {
  adjacency: Map<string, Set<string>>;
  components: string[][];
};

function buildApprovedClusterMergeGraph(approvedEdges: Array<[string, string]>): ApprovedClusterMergeGraph {
  const adjacency = new Map<string, Set<string>>();
  for (const [leftId, rightId] of approvedEdges) {
    if (!adjacency.has(leftId)) adjacency.set(leftId, new Set());
    if (!adjacency.has(rightId)) adjacency.set(rightId, new Set());
    adjacency.get(leftId)!.add(rightId);
    adjacency.get(rightId)!.add(leftId);
  }

  const visited = new Set<string>();
  const components: string[][] = [];
  for (const clusterId of adjacency.keys()) {
    if (visited.has(clusterId)) continue;

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
    components.push(component);
  }

  return { adjacency, components };
}

function buildClusterMergeGroupsFromApprovedEdges(
  approvedEdges: Array<[string, string]>,
  metadata: { itemCounts: Map<string, number>; preservePairOrder?: boolean },
) {
  const { adjacency, components } = buildApprovedClusterMergeGraph(approvedEdges);
  const groups: string[][] = [];

  for (const component of components) {
    if (component.length < 2) continue;

    const targetId = [...component].sort((leftId, rightId) => {
      const itemCountDiff = (metadata.itemCounts.get(rightId) ?? 0) - (metadata.itemCounts.get(leftId) ?? 0);
      return itemCountDiff || (metadata.preservePairOrder ? 0 : leftId.localeCompare(rightId));
    })[0]!;
    const directSources = [...(adjacency.get(targetId) ?? [])].sort((leftId, rightId) => {
      const itemCountDiff = (metadata.itemCounts.get(rightId) ?? 0) - (metadata.itemCounts.get(leftId) ?? 0);
      return itemCountDiff || (metadata.preservePairOrder ? 0 : leftId.localeCompare(rightId));
    });
    if (directSources.length > 0) groups.push([targetId, ...directSources]);
  }

  return groups;
}

export function resolveClusterMergeGroupsFromDecisions(
  decisions: Array<Pick<ClusterMergeDecision, "leftClusterId" | "rightClusterId" | "relation">>,
  itemCounts: Map<string, number>,
  blockedClusterIds?: ReadonlySet<string>,
) {
  // 综合稿桥接守卫：含未拆分聚合源的簇不参与传递性合并——聚合稿整体同时提及
  // 多个独立事件，一旦桥接会把真事件无声并簇。blocked 边降级人工复核
  // （决策保持 same_event 落库不 applied，自然进入复核队列）。
  const guarded = blockedClusterIds && blockedClusterIds.size > 0;
  const approvedEdges = decisions
    .filter((decision) => {
      if (decision.relation !== "same_event") return false;
      if (!guarded) return true;
      return !blockedClusterIds.has(decision.leftClusterId) && !blockedClusterIds.has(decision.rightClusterId);
    })
    .map((decision) => [decision.leftClusterId, decision.rightClusterId] as [string, string]);
  const approvedComponents = buildApprovedClusterMergeGraph(approvedEdges).components;
  const conflicts: ClusterMergeGroupConflict[] = [];

  if (guarded) {
    const guardedPairs = decisions
      .filter((decision) =>
        decision.relation === "same_event" &&
        (blockedClusterIds.has(decision.leftClusterId) || blockedClusterIds.has(decision.rightClusterId)))
      .map(({ leftClusterId, rightClusterId }) => ({ leftClusterId, rightClusterId }))
      .sort((left, right) =>
        left.leftClusterId.localeCompare(right.leftClusterId) || left.rightClusterId.localeCompare(right.rightClusterId));
    if (guardedPairs.length > 0) {
      conflicts.push({
        reason: "synthesis_source_guard",
        clusterIds: [...new Set(guardedPairs.flatMap((p) => [p.leftClusterId, p.rightClusterId]))].sort(),
        declinedPairs: guardedPairs,
      });
    }
  }

  for (const component of approvedComponents) {
    const members = new Set(component);
    const declinedPairs = decisions
      .filter((decision) =>
        getClusterMergeRelationAction(decision.relation) === "reject" &&
        members.has(decision.leftClusterId) &&
        members.has(decision.rightClusterId)
      )
      .map(({ leftClusterId, rightClusterId }) => ({ leftClusterId, rightClusterId }))
      .sort((left, right) =>
        left.leftClusterId.localeCompare(right.leftClusterId) || left.rightClusterId.localeCompare(right.rightClusterId)
      );
    if (declinedPairs.length === 0) continue;

    conflicts.push({
      reason: "declined_pair_within_approved_component",
      clusterIds: [...component].sort(),
      declinedPairs,
    });
  }

  const conflictedClusterIds = new Set(conflicts.flatMap((conflict) => conflict.clusterIds));
  const safeApprovedEdges = approvedEdges.filter(([leftId]) => !conflictedClusterIds.has(leftId));
  const groups = buildClusterMergeGroupsFromApprovedEdges(
    safeApprovedEdges,
    { itemCounts, preservePairOrder: true },
  );
  return { groups, conflicts };
}

export function buildClusterMergeGroupsFromDecisions(
  decisions: Array<Pick<ClusterMergeDecision, "leftClusterId" | "rightClusterId" | "relation">>,
  itemCounts: Map<string, number>,
) {
  return resolveClusterMergeGroupsFromDecisions(decisions, itemCounts).groups;
}

export function parseClusterMergeInputMetadata(clustersJson: string): ClusterMergeInputMetadata {
  const parsed = JSON.parse(clustersJson) as unknown;
  if (!parsed || typeof parsed !== "object" || !("pairs" in parsed) || !Array.isArray(parsed.pairs)) {
    throw new InvalidJsonModelResponseError("聚合合并输入 pairs 必须是数组。");
  }

  const pairs: ClusterMergeInputMetadata["pairs"] = [];
  // pair_id 是批内序号，天然不会重复；真正需要防的是同一对 cluster 在一批里出现两次。
  const seenPairKeys = new Set<string>();
  for (const [index, pair] of parsed.pairs.entries()) {
    const left = pair && typeof pair === "object" && "left" in pair ? pair.left : null;
    const right = pair && typeof pair === "object" && "right" in pair ? pair.right : null;
    const leftId = left && typeof left === "object" && "id" in left && typeof left.id === "string" ? left.id : null;
    const rightId = right && typeof right === "object" && "id" in right && typeof right.id === "string" ? right.id : null;
    if (!leftId || !rightId || leftId === rightId) {
      throw new InvalidJsonModelResponseError("聚合合并输入 Pair 缺少有效的 left/right cluster ID。");
    }

    const pairId = makeClusterMergePairRef(index);
    const pairKey = `${leftId}\0${rightId}`;
    if (seenPairKeys.has(pairKey)) {
      throw new InvalidJsonModelResponseError(`聚合合并输入存在重复 pair：${leftId} / ${rightId}`);
    }
    seenPairKeys.add(pairKey);
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
  const outputDecisions = (parsed as { decisions?: unknown }).decisions;
  if (!Array.isArray(outputDecisions)) {
    throw new InvalidJsonModelResponseError("聚合合并 decisions 必须是数组。");
  }
  if (metadata.pairs.length === 0) {
    return [];
  }

  // 逐 pair 校验并抢救：单个 decision 非法只丢弃它自己，不连坐同批其他 pair。
  // 丢弃的 pair 不做账本记录，交由下一轮重新评估（与 rc8 的容错基线一致）。
  // 消费侧按 leftClusterId/rightClusterId 路由，不依赖返回顺序，故跳过不会造成错位。
  const expectedById = new Map(metadata.pairs.map((pair) => [pair.pairId, pair]));
  const decisionsById = new Map<string, ClusterMergeDecision>();
  const dropped: string[] = [];
  for (const rawDecision of outputDecisions) {
    const drop = (reason: string) => {
      dropped.push(reason);
      return null;
    };
    if (!rawDecision || typeof rawDecision !== "object" || Array.isArray(rawDecision)) {
      drop("decision 不是对象");
      continue;
    }
    const decision = rawDecision as Record<string, unknown>;
    if (typeof decision.pair_id !== "string" || !expectedById.has(decision.pair_id)) {
      drop("pair_id 未知或缺失");
      continue;
    }
    if (decisionsById.has(decision.pair_id)) {
      drop("pair_id 重复");
      continue;
    }
    // relation 优先；verdict 是 DB 存量 prompt（旧协议）响应的兼容回退，
    // 运行时会把输出规则常量追加到自定义 prompt，过渡期两种字段都可能出现。
    let relation: ClusterMergeRelation;
    if (typeof decision.relation === "string" && CLUSTER_MERGE_RELATIONS.includes(decision.relation as ClusterMergeRelation)) {
      relation = decision.relation as ClusterMergeRelation;
    } else if (typeof decision.verdict === "string" && decision.verdict in LEGACY_VERDICT_TO_RELATION) {
      relation = LEGACY_VERDICT_TO_RELATION[decision.verdict as keyof typeof LEGACY_VERDICT_TO_RELATION];
    } else {
      drop("relation 无效");
      continue;
    }
    if (typeof decision.confidence !== "number" || !Number.isFinite(decision.confidence) ||
      decision.confidence < 0 || decision.confidence > 100) {
      drop("confidence 越界");
      continue;
    }
    if (typeof decision.reasonCode !== "string" || !CLUSTER_MERGE_REASON_CODES.includes(decision.reasonCode as ClusterMergeReasonCode)) {
      drop("reasonCode 无效");
      continue;
    }
    const reasonText = typeof decision.reasonText === "string" ? decision.reasonText.trim() : "";
    if (!reasonText) {
      drop("缺少 reasonText");
      continue;
    }
    if (!CLUSTER_MERGE_RELATION_REASON_CODES[relation].includes(decision.reasonCode as ClusterMergeReasonCode)) {
      drop("relation 与 reasonCode 不匹配");
      continue;
    }

    const pair = expectedById.get(decision.pair_id)!;
    decisionsById.set(decision.pair_id, {
      leftClusterId: pair.leftClusterId,
      rightClusterId: pair.rightClusterId,
      relation,
      confidence: decision.confidence,
      reasonCode: decision.reasonCode as ClusterMergeReasonCode,
      reasonText,
    });
  }

  const missing = metadata.pairs.length - decisionsById.size;
  if (dropped.length > 0 || missing > 0) {
    // 错位/协议缺陷的观测点：仅记录不阻断，历史上曾用于按数组下标配对导致的错位诊断。
    const byReason = new Map<string, number>();
    for (const reason of dropped) byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
    console.warn(
      `[Cluster Merge] 协议抢救: 保留 ${decisionsById.size}/${metadata.pairs.length} 对, 丢弃 ${dropped.length} 条非法 decision, 缺失 ${missing} 对` +
      ` (${[...byReason.entries()].map(([reason, count]) => `${reason}=${count}`).join(", ") || "无非法条目"})`,
    );
  }

  return metadata.pairs
    .map((pair) => decisionsById.get(pair.pairId))
    .filter((decision): decision is ClusterMergeDecision => decision !== undefined);
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
