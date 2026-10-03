import { adminErrorResponse } from "@/lib/admin/http";
import { requireAdmin } from "@/lib/admin/session";
import { applyClusterReviewMerge } from "@/lib/clusters/review-actions";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const { id } = await context.params;

    return Response.json({
      success: true,
      result: await applyClusterReviewMerge(id),
    });
  } catch (error) {
    return adminErrorResponse(error, 400, "复核合并失败");
  }
}
