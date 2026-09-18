import type { EmbedTextsFn } from "@/lib/ai/embeddings";
import { buildEmbeddingText, cosineSimilarity } from "@/lib/ai/embeddings";
import type { ClusterAssignmentCandidate } from "@/lib/clusters/repository";

/** scoreClusterCandidate 返回项的结构化子集（rule 排序单元） */
export type ScoredClusterCandidate = {
  candidate: ClusterAssignmentCandidate;
  score: number;
  dateCompatible: boolean;
  preciseDateDrift: boolean;
  hardConflict: boolean;
  strongMatch: boolean;
};

/**
 * Reciprocal Rank Fusion：对两条候选 id 排序做 RRF 融合。
 * 分数 = Σ 1/(k + position)，position 从 1 计；并列时保持 rule 顺序优先。
 */
export function fuseOrdersByRrf(ruleOrder: string[], vecOrder: string[], k: number): string[] {
  const entries = new Map<string, { score: number; rulePos: number; vecPos: number }>();
  ruleOrder.forEach((id, index) => {
    entries.set(id, { score: 1 / (k + index + 1), rulePos: index, vecPos: Number.MAX_SAFE_INTEGER });
  });
  vecOrder.forEach((id, index) => {
    const entry = entries.get(id) ?? {
      score: 0,
      rulePos: Number.MAX_SAFE_INTEGER,
      vecPos: Number.MAX_SAFE_INTEGER,
    };
    entry.score += 1 / (k + index + 1);
    entry.vecPos = index;
    entries.set(id, entry);
  });

  return [...entries.entries()]
    .sort(
      (left, right) =>
        right[1].score - left[1].score ||
        left[1].rulePos - right[1].rulePos ||
        left[1].vecPos - right[1].vecPos ||
        left[0].localeCompare(right[0]),
    )
    .map(([id]) => id);
}

/**
 * 合并预筛准入判定：规则灰区（score ≥ grayScore 且非 rejected）或向量相似
 * （sim ≥ vectorGraySim）任一命中即提名。object_conflict（实体冲突）否决向量
 * 路径，但 sim ≥ conflictOverrideSim 时视为 AI 抽取噪声、降级为可提名（仍由
 * LLM 终审）；no_event_anchor（词汇锚点不足）不否决向量路径。
 * 向量独占提名的对以 sim*100 作为优先级分（与规则分同数量级，供灰区排序）。
 */
export function resolveMergePairAdmission(
  rule: { rejected: boolean; rejectedReason: string | null; score: number },
  vectorSim: number | null,
  grayScore: number,
  vectorGraySim: number,
  conflictOverrideSim: number,
): { admitted: boolean; priorityScore: number; source: "rule" | "vector" } {
  if (!rule.rejected && rule.score >= grayScore) {
    return { admitted: true, priorityScore: rule.score, source: "rule" };
  }

  const conflictVeto =
    rule.rejectedReason === "object_conflict" &&
    (vectorSim === null || vectorSim < conflictOverrideSim);
  if (vectorSim !== null && vectorSim >= vectorGraySim && !conflictVeto) {
    return { admitted: true, priorityScore: Math.round(vectorSim * 100), source: "vector" };
  }

  return { admitted: false, priorityScore: rule.score, source: "rule" };
}

/**
 * 语义召回 + RRF 融合选取送入 LLM 的候选切片。
 * - 语义排序范围：通过硬性否决（日期冲突/硬冲突）的全部候选，不受规则最低分限制；
 * - 规则切片首位（direct-match 同源的 ruleQualified[0]）始终钉在切片首位；
 * - embedding 未启用、调用失败或返回不齐时返回规则切片（降级）。
 */
export async function selectAiCandidatesWithEmbeddingRecall(input: {
  embedTexts: EmbedTextsFn;
  itemTitle: string;
  itemSummary: string;
  ruleRanked: ScoredClusterCandidate[];
  ruleQualified: ScoredClusterCandidate[];
  rrfK: number;
  limit: number;
}): Promise<ScoredClusterCandidate[]> {
  const { embedTexts, itemTitle, itemSummary, ruleRanked, ruleQualified, rrfK, limit } = input;
  const vetoPassed = ruleRanked.filter((entry) => entry.dateCompatible && !entry.hardConflict);

  if (vetoPassed.length === 0) {
    return ruleQualified;
  }

  const texts = [
    buildEmbeddingText(itemTitle, itemSummary),
    ...vetoPassed.map((entry) => buildEmbeddingText(entry.candidate.title, entry.candidate.summary)),
  ];
  const vectors = await embedTexts(texts);

  if (!vectors || vectors.length !== texts.length) {
    return ruleQualified;
  }

  const itemVector = vectors[0]!;
  const vecOrder = vetoPassed
    .map((entry, index) => ({
      id: entry.candidate.id,
      sim: cosineSimilarity(itemVector, vectors[index + 1]!),
      latestPublishedAt: entry.candidate.latestPublishedAt.getTime(),
    }))
    .sort(
      (left, right) =>
        right.sim - left.sim ||
        right.latestPublishedAt - left.latestPublishedAt ||
        left.id.localeCompare(right.id),
    )
    .map((entry) => entry.id);

  const entryById = new Map(vetoPassed.map((entry) => [entry.candidate.id, entry]));
  const fusedIds = fuseOrdersByRrf(
    ruleQualified.map((entry) => entry.candidate.id),
    vecOrder,
    rrfK,
  );
  const fusedEntries = fusedIds
    .map((id) => entryById.get(id))
    .filter((entry): entry is ScoredClusterCandidate => Boolean(entry));
  const pinned = ruleQualified[0] ?? null;
  const ordered = pinned
    ? [pinned, ...fusedEntries.filter((entry) => entry.candidate.id !== pinned.candidate.id)]
    : fusedEntries;

  return ordered.slice(0, limit);
}
