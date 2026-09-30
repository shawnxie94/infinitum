import type { EmbedTextsFn } from "@/lib/ai/embeddings";
import { buildEmbeddingText, cosineSimilarity } from "@/lib/ai/embeddings";
import type { ClusterAssignmentCandidate } from "@/lib/clusters/repository";

/** item-assignment 候选：BM25 稀疏排序分与独立安全判定。 */
export type ScoredClusterCandidate = {
  candidate: ClusterAssignmentCandidate;
  score: number;
  dateCompatible: boolean;
  preciseDateDrift: boolean;
  hardConflict: boolean;
};

/** Reciprocal Rank Fusion：稀疏 BM25 顺序与向量顺序按倒数排名融合。 */
export function fuseOrdersByRrf(sparseOrder: string[], vecOrder: string[], k: number): string[] {
  const entries = new Map<string, { score: number; sparsePos: number; vecPos: number }>();
  sparseOrder.forEach((id, index) => {
    entries.set(id, { score: 1 / (k + index + 1), sparsePos: index, vecPos: Number.MAX_SAFE_INTEGER });
  });
  vecOrder.forEach((id, index) => {
    const entry = entries.get(id) ?? {
      score: 0,
      sparsePos: Number.MAX_SAFE_INTEGER,
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
        left[1].sparsePos - right[1].sparsePos ||
        left[1].vecPos - right[1].vecPos ||
        left[0].localeCompare(right[0]),
    )
    .map(([id]) => id);
}

/**
 * 合并候选召回：稀疏规则路径必须通过 safety 并达到 grayScore；稠密路径只看
 * 向量相似度是否达到 vectorGraySim，不受主体/对象规则拒绝影响。两路提名都只送 AI 终审。
 * 向量独占提名的对以 sim*100 作为优先级分（与规则分同数量级，供灰区排序）。
 */
export function resolveMergePairAdmission(
  rule: { rejected: boolean; rejectedReason: string | null; score: number },
  vectorSim: number | null,
  grayScore: number,
  vectorGraySim: number,
  /** @deprecated Accepted for compatibility; dense admission no longer depends on sparse conflict overrides. */
  _conflictOverrideSim?: number,
): { admitted: boolean; priorityScore: number; source: "rule" | "vector" } {
  if (!rule.rejected && rule.score >= grayScore) {
    return { admitted: true, priorityScore: rule.score, source: "rule" };
  }

  if (vectorSim !== null && vectorSim >= vectorGraySim) {
    return { admitted: true, priorityScore: Math.round(vectorSim * 100), source: "vector" };
  }

  return { admitted: false, priorityScore: rule.score, source: "rule" };
}

/**
 * 独立向量召回与 BM25 稀疏列表做 RRF 融合，再返回 AI 判断的 Top-N。
 * 日期不兼容与硬冲突候选不能进入任一通道；无向量时降级为正分 BM25 列表。
 */
export async function selectAiCandidatesWithEmbeddingRecall(input: {
  embedTexts: EmbedTextsFn;
  itemTitle: string;
  itemSummary: string;
  itemEvent?: {
    eventType?: string | null;
    eventSubject?: string | null;
    eventAction?: string | null;
    eventObject?: string | null;
    eventDate?: string | null;
  };
  eligibleCandidates: ScoredClusterCandidate[];
  sparseCandidates: ScoredClusterCandidate[];
  rrfK: number;
  limit: number;
}): Promise<ScoredClusterCandidate[]> {
  const { embedTexts, itemTitle, itemSummary, itemEvent, eligibleCandidates, sparseCandidates, rrfK, limit } = input;
  const vetoPassed = eligibleCandidates.filter((entry) => entry.dateCompatible && !entry.hardConflict);
  const sparseFallback = sparseCandidates
    .filter((entry) => entry.score > 0 && entry.dateCompatible && !entry.hardConflict)
    .slice(0, limit);
  const sparseOrder = sparseFallback.map((entry) => entry.candidate.id);

  if (vetoPassed.length === 0) {
    return sparseFallback;
  }

  const texts = [
    buildEmbeddingText(itemTitle, itemSummary, itemEvent),
    ...vetoPassed.map((entry) => buildEmbeddingText(entry.candidate.title, entry.candidate.summary, {
      eventType: entry.candidate.eventType,
      eventSubject: entry.candidate.eventSubject,
      eventAction: entry.candidate.eventAction,
      eventObject: entry.candidate.eventObject,
      eventDate: entry.candidate.eventDate,
    })),
  ];
  const vectors = await embedTexts(texts);

  if (!vectors || vectors.length !== texts.length || !vectors[0]) {
    return sparseFallback;
  }

  const itemVector = vectors[0];
  const vecOrder = vetoPassed
    .map((entry, index) => {
      const vector = vectors[index + 1];
      if (!vector) {
        return null;
      }
      return {
        id: entry.candidate.id,
        sim: cosineSimilarity(itemVector, vector),
        latestPublishedAt: entry.candidate.latestPublishedAt.getTime(),
      };
    })
    .filter((entry): entry is { id: string; sim: number; latestPublishedAt: number } => entry !== null)
    .sort(
      (left, right) =>
        right.sim - left.sim ||
        right.latestPublishedAt - left.latestPublishedAt ||
        left.id.localeCompare(right.id),
    )
    .map((entry) => entry.id);

  const entryById = new Map(vetoPassed.map((entry) => [entry.candidate.id, entry]));
  return fuseOrdersByRrf(sparseOrder, vecOrder, rrfK)
    .map((id) => entryById.get(id))
    .filter((entry): entry is ScoredClusterCandidate => Boolean(entry))
    .slice(0, limit);
}
