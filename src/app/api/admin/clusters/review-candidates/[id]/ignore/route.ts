import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import { createCannotLinkForClusters } from "@/lib/clusters/constraints";
import { recordClusterPairLabelFromClusters } from "@/lib/clusters/feedback";
import { getPendingClusterReviewDecision, markDecisionApplied } from "@/lib/clusters/decisions";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const { id } = await context.params;
    const candidate = await getPendingClusterReviewDecision(id);

    if (!candidate) {
      return adminErrorResponse(new Error("复核候选不存在或已处理"), 404);
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
    await markDecisionApplied(id, "manual_review_ignore");

    return Response.json({
      success: true,
    });
  } catch (error) {
    return adminErrorResponse(error, 400, "复核忽略失败");
  }
}
