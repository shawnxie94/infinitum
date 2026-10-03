import { createCannotLinkForClusters } from "@/lib/clusters/constraints";
import {
  getPendingClusterReviewDecision,
  markDecisionApplied,
} from "@/lib/clusters/decisions";
import { recordClusterPairLabelFromClusters } from "@/lib/clusters/feedback";
import { mergeClusters } from "@/lib/clusters/service";

/**
 * 聚合待定候选的人工处置。单条路由与批量路由共用，保证反馈回写和
 * cannot-link 约束两条路径行为一致。
 */

export async function applyClusterReviewMerge(decisionId: string) {
  const candidate = await getPendingClusterReviewDecision(decisionId);

  if (!candidate) {
    throw new Error("复核候选不存在或已处理");
  }

  // Phase 3 反馈回写：先拍快照（合并后 source 簇会被删除），失败不阻断合并
  await recordClusterPairLabelFromClusters({
    verdict: "approved",
    source: "manual_review_merge",
    leftClusterId: candidate.sourceClusterId,
    rightClusterId: candidate.targetClusterId,
  });

  const result = await mergeClusters(candidate.targetClusterId, [candidate.sourceClusterId]);
  await markDecisionApplied(decisionId, "manual_review_merge");

  return result;
}

export async function applyClusterReviewIgnore(decisionId: string) {
  const candidate = await getPendingClusterReviewDecision(decisionId);

  if (!candidate) {
    throw new Error("复核候选不存在或已处理");
  }

  // Phase 3 反馈回写：人工判定这两个簇不是同一事件
  await recordClusterPairLabelFromClusters({
    verdict: "declined",
    source: "manual_review_ignore",
    leftClusterId: candidate.sourceClusterId,
    rightClusterId: candidate.targetClusterId,
  });

  await createCannotLinkForClusters(
    candidate.targetClusterId,
    candidate.sourceClusterId,
    "manual review ignored",
  );
  await markDecisionApplied(decisionId, "manual_review_ignore");
}
