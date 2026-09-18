import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import { recordClusterPairLabelFromClusters } from "@/lib/clusters/feedback";
import { getPendingClusterReviewDecision, markDecisionApplied } from "@/lib/clusters/decisions";
import { mergeClusters } from "@/lib/clusters/service";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const { id } = await context.params;
    const candidate = await getPendingClusterReviewDecision(id);

    if (!candidate) {
      return adminErrorResponse(new Error("复核候选不存在或已处理"), 404);
    }

    // Phase 3 反馈回写：先拍快照（合并后 source 簇会被删除），失败不阻断合并
    await recordClusterPairLabelFromClusters({
      verdict: "approved",
      source: "manual_review_merge",
      leftClusterId: candidate.sourceClusterId,
      rightClusterId: candidate.targetClusterId,
    });

    const result = await mergeClusters(candidate.targetClusterId, [candidate.sourceClusterId]);
    await markDecisionApplied(id, "manual_review_merge");

    return Response.json({
      success: true,
      result,
    });
  } catch (error) {
    return adminErrorResponse(error, 400, "复核合并失败");
  }
}
